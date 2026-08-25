// Real-time voice agent — server side.
//
// The voice agent is the CRM agent with ears and a mouth. A speech-to-speech
// model (OpenAI Realtime) holds the conversation over a low-latency socket
// opened straight from the browser; every question about CRM data and every
// change to it still goes through the same brain, the same permissions and the
// same confirm-before-write flow as the text agent (lib/agent.mjs).
//
//   browser ──(WebRTC or WebSocket, audio both ways)──► realtime voice model
//      │                                                       │
//      │  function call ("crm_lookup", "crm_plan", …)  ◄────────┘
//      ▼
//   POST /api/agent-hub {action:"voice_tool"} ──► runVoiceTool() ──► lib/agent.mjs
//
// Why the tools run on OUR server and not in the browser: the caller's CRM role
// decides what they may read and write (lib/acl.mjs). The browser only relays
// the call; the Supabase JWT it sends is what the permission check runs on, so
// a tampered client can never widen its own access.
//
// The browser never sees our OpenAI key: it gets a short-lived client secret
// (`ek_…`) minted here, scoped to a session config we control — instructions,
// tools, voice and turn detection are all fixed at mint time.
import { admin } from "./clients.mjs";
import { actorLine, getDbSchema, getReferenceData, handleIncoming } from "./agent.mjs";
import { checkSqlAccess, writesEnabled } from "./agentWrite.mjs";

// ── Configuration ────────────────────────────────────────────────────────────
export const VOICE_MODEL = process.env.VOICE_MODEL || "gpt-realtime";
// marin/cedar are the natural-sounding pair; the rest (alloy, ash, ballad,
// coral, echo, sage, shimmer, verse) also work.
export const VOICE_VOICE = process.env.VOICE_VOICE || "marin";
// Input transcription is what fills the on-screen transcript. It runs
// asynchronously and never gates the spoken answer.
export const VOICE_TRANSCRIBE_MODEL = process.env.VOICE_TRANSCRIBE_MODEL || "gpt-4o-mini-transcribe";
// Empty = auto-detect, which is what a bilingual team wants. An ISO code
// ("es"/"en") pins it.
export const VOICE_TRANSCRIBE_LANGUAGE = process.env.VOICE_TRANSCRIBE_LANGUAGE || "";
export const VOICE_SPEED = Number(process.env.VOICE_SPEED || 1.05);

// Copy the panel puts in front of a human. Everything the *model* reads stays
// in English — those strings are prompt directives, and the model says them
// back in whatever language the person is speaking.
const VOICE_T = {
  es: {
    noKey: "Falta OPENAI_API_KEY (necesaria para el agente de voz).",
    rejected: (p) => `La sesión de voz sigue rechazada después de quitar ${p}.`,
    openFailed: "No pude abrir la sesión de voz.",
    unknownTool: (n) => `Herramienta desconocida: ${n}.`,
    readOnly: "Estás en modo solo lectura: puedo consultar, pero no escribir.",
    emptyQuery: "Consulta vacía.",
    toolError: "Falló la herramienta.",
    name: "Argentine Spanish",
  },
  en: {
    noKey: "OPENAI_API_KEY is missing (the voice agent needs it).",
    rejected: (p) => `The voice session is still rejected after dropping ${p}.`,
    openFailed: "I couldn't open the voice session.",
    unknownTool: (n) => `Unknown tool: ${n}.`,
    readOnly: "You're in read-only mode: I can look things up, but not write.",
    emptyQuery: "Empty query.",
    toolError: "The tool failed.",
    name: "English",
  },
};
// The CRM's own default is English (src/i18n.js), so an unset language lands there.
export const voiceLang = (l) => (String(l || "").toLowerCase().startsWith("es") ? "es" : "en");
// "auto" (or anything unset) = follow whoever is speaking. "es"/"en" pin it.
export const langLocked = (l) => l === "es" || l === "en";
export const vt = (l) => VOICE_T[voiceLang(l)];

const REALTIME_HTTP = "https://api.openai.com/v1/realtime";
const SECRET_TTL_S = 600;             // client secret lifetime (10 min)
const MAX_OUTPUT_TOKENS = 1500;       // spoken answers are short by design
const RESULT_MAX = 3500;              // chars of tool output handed to the model
const SCHEMA_BUDGET = Number(process.env.VOICE_SCHEMA_BUDGET || 7000);
const AUDIO_RATE = 24000;             // the only PCM rate the API accepts

// ── Prompt ───────────────────────────────────────────────────────────────────
// The full information_schema dump the text agent gets is far more than a voice
// turn needs, and every extra token is latency on the first response. Keep the
// tables the agent actually talks about and name the rest so it knows they
// exist and can reach them through crm_ask.
const SCHEMA_PRIORITY = [
  "storage_jobs", "storages", "trips", "trip_stops", "trucks", "drivers", "brokers",
  "payments", "job_extras", "expenses", "claims", "storage_billing", "closing_sheets",
  "job_events", "trip_events", "driver_work_days", "driver_adjustments",
  "bank_transactions", "bank_accounts", "equipment_items", "employees",
];

export function voiceSchema(full, budget = SCHEMA_BUDGET) {
  const lines = String(full || "").split("\n").filter(Boolean);
  if (!lines.length) return "(schema unavailable — use crm_ask for anything you can't answer from the directory)";
  const nameOf = (l) => l.slice(0, l.indexOf(":")).trim();
  const rank = (l) => {
    const i = SCHEMA_PRIORITY.indexOf(nameOf(l));
    return i < 0 ? SCHEMA_PRIORITY.length : i;
  };
  const sorted = [...lines].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  const kept = [];
  const dropped = [];
  let used = 0;
  for (const l of sorted) {
    if (used + l.length + 1 <= budget) { kept.push(l); used += l.length + 1; }
    else dropped.push(nameOf(l));
  }
  kept.sort((a, b) => a.localeCompare(b));
  if (dropped.length) {
    kept.push(`OTHER TABLES (columns not listed here — ask crm_ask about them): ${dropped.sort().join(", ")}`);
  }
  return kept.join("\n");
}

export async function buildVoiceInstructions({ actor, canWrite, lang, langLock }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  // A cold cache must not sink the whole session: the agent still works with
  // the directory or the schema missing, it just has to look more things up.
  const [schema, directory] = await Promise.all([
    getDbSchema().catch(() => ""),
    getReferenceData().catch(() => ""),
  ]);
  return [
    'You are the voice of the operations assistant of "No Borders Moving", a US moving & storage company. The team talks to you while driving, loading a truck or walking through a warehouse — you are on a phone speaker, hands are busy, and nobody can read a screen.',
    "",
    `TODAY: ${today} (timezone America/New_York). ${actorLine(actor)}`,
    canWrite ? "You may propose changes with crm_plan." : "READ-ONLY: you can look things up and answer, but never call crm_plan.",
    "",
    "HOW TO SPEAK:",
    "- Argentine Spanish and English are BOTH first class here, and the team mixes them. Speak the same language the person is speaking and switch the moment they switch, even mid-conversation. Never ask which language they want — just follow them.",
    // The model was drifting into Spanish mid-conversation after a tool call:
    // it reads these instructions, the directory and the query results again on
    // every turn, and all of them are salted with Spanish. Say plainly that
    // none of it is a language cue.
    "- ONLY the person's own words decide which language you speak. These instructions, the CRM directory, the table names and every tool result are a mix of English and Spanish — that is stored data, not a hint. Never drift into a language the person is not speaking, not even for one word, and never mix the two in a single sentence.",
    // It kept flipping to Spanish for a single turn in an English conversation.
    // This team speaks English with a Spanish accent — the accent is what it was
    // hearing, and it was reading it as a request to switch.
    "- Judge the language by the WORDS, never by the ACCENT. This team speaks English with a Spanish accent and Spanish with an English one. Somebody asking \"how many trucks are on the road\" is speaking English, no matter how it sounds. An accent is never a reason to switch.",
    "- Switching is deliberate, never a drift: switch only when a WHOLE sentence comes in the other language. Never switch in the middle of an exchange — if your filler was in one language, the answer that follows it goes in that same language.",
    // The CRM's own convention (see CLAUDE.md): the UI is English, but Spanish
    // keeps the business vocabulary in English because that is how the team
    // actually talks. Translating "job" to "trabajo" out loud sounds wrong.
    "- Keep the CRM's vocabulary in English even when you speak Spanish: job, broker, trip, driver, storage, warehouse, live load, BOL, CF, closing sheet, settlement, pads. Everything around them goes in Spanish.",
    "- One or two short sentences per turn. This is a conversation, not a report: no lists, no markdown, no emoji, no spelling out ids unless asked.",
    "- Say numbers the way a person would — \"twelve hundred dollars\" / \"mil doscientos dólares\", \"March twelfth\" / \"el doce de marzo\". Never read raw JSON, column names, ids character by character or SQL out loud.",
    "- If an answer would take more than about four sentences, say the headline and offer the detail: \"There are seven deliveries. Want me to go through them?\" / \"Hay siete entregas. ¿Te las paso una por una?\".",
    "- Someone can interrupt you at any time. When they do, stop and listen — do not finish the sentence you were on.",
    "",
    "LATENCY — this matters as much as being right:",
    "- Before ANY tool call, say a two-to-four word filler out loud first, in the language they are speaking: \"Let me check…\" / \"Dejame ver…\", \"One second…\" / \"Un segundo…\". The tool runs while you speak, so the silence disappears.",
    "- Prefer crm_lookup over crm_ask: one query is much faster than handing the question to the text agent.",
    "- The directory below is already loaded. NEVER run a query to turn a broker, driver, truck, trip or storage name into an id — read it off the list.",
    "- Ask for few rows. You have to say the result out loud, so aggregate (count, sum) or LIMIT instead of pulling a table.",
    "",
    "CRM DIRECTORY (ids ready to use — do NOT look these up):",
    directory || "(directory unavailable — resolve names with crm_lookup)",
    "",
    "DATABASE (PostgreSQL, table: columns):",
    voiceSchema(schema),
    "",
    "DOMAIN RULES:",
    "- A logical job = several storage_jobs rows sharing job_number. storage_jobs IS the jobs table, and storage_id is optional — a job can exist with no storage unit.",
    "- Jobs ride a trip through storage_jobs.trip_id + trip_stop_order. trip_stops are non-job stops (fuel, scale, maintenance).",
    "- job status: scheduled|picked_up|in_storage|out_for_delivery|delivered|on_hold. trip status: loading|in_transit|completed|cancelled.",
    "- \"Real debt\" of a job = pickup_balance + delivery_balance + bol_balance − received payments, plus pending active extras. Never quote a raw balance as debt — if you need it, ask crm_ask.",
    "- Always filter `deleted_at is null`. Deletes are soft and recoverable, but never propose one unless clearly asked.",
    "- Money is plain numeric columns; dates are ISO. Resolve \"next Friday\" / \"el viernes\" against TODAY.",
    "",
    "CHANGING DATA — the rule you must never bend:",
    "- To change anything, call crm_plan with the request in the person's own words, including every detail they gave. Nothing is written: you get back a plan.",
    "- Read the plan back in ONE short spoken sentence, then ask if you should go ahead.",
    "- Call crm_confirm ONLY after they have heard the plan and said yes out loud. Never confirm on your own, never to save a step, never because the request seemed obvious. If they say no or change something, call crm_cancel or crm_plan again.",
    "- If they change a detail after hearing the plan, call crm_plan again with the corrected request — do not confirm the old one.",
    "",
    "GENERAL:",
    "- Never invent an id, a name, a number or a date. If you don't have it, look it up or say you don't have it.",
    "- If something essential is missing or ambiguous (which of two clients, which broker), ask one short question instead of guessing.",
    "- Never say you can't do something in the CRM. Either do it, or say exactly what is missing: a piece of data, or a permission you don't have.",
    // Nobody has spoken yet, so there is no language to mirror: the CRM's own
    // setting is the only signal available for the very first sentence.
    langLocked(langLock)
      ? `- LANGUAGE LOCK: this person chose to hear you in ${vt(langLock).name}. Speak ${vt(langLock).name} and ONLY ${vt(langLock).name} for the whole conversation — whatever accent you hear, whatever language the data is in, even if they speak to you in the other one. The single exception is if they ask you in words to switch. Greet them in ${vt(langLock).name} and wait.`
      : `- Open the conversation with ONE short greeting in ${vt(lang).name} (the language this person has the CRM set to), then wait. After that, mirror whatever they actually speak.`,
  ].join("\n");
}

// ── Tools ────────────────────────────────────────────────────────────────────
// Realtime function tools are flat ({type,name,description,parameters}), unlike
// the Anthropic tools in lib/agent.mjs.
const LOOKUP_TOOL = {
  type: "function",
  name: "crm_lookup",
  description:
    "Read-only PostgreSQL SELECT against the CRM — your fast path for a concrete fact (a job, a balance, today's deliveries, how many units are free). One statement, no semicolon, always filter `deleted_at is null`, and always aggregate or LIMIT because you have to say the answer out loud. Say a short filler before calling this.",
  parameters: {
    type: "object",
    properties: { query: { type: "string", description: "One SELECT (or WITH…SELECT) statement." } },
    required: ["query"],
    additionalProperties: false,
  },
};

const ASK_TOOL = {
  type: "function",
  name: "crm_ask",
  description:
    "Hand a question to the CRM's text agent when a single SELECT won't do it: multi-step analysis, business math like a job's real debt, settlements, or anything about how the company works. It is noticeably slower than crm_lookup, so only use it when crm_lookup can't answer.",
  parameters: {
    type: "object",
    properties: { question: { type: "string", description: "The question, in the language the user is speaking." } },
    required: ["question"],
    additionalProperties: false,
  },
};

const PLAN_TOOL = {
  type: "function",
  name: "crm_plan",
  description:
    "Propose a change to the CRM — anything: jobs, payments, trips, expenses, claims, truck locations. NOTHING is written. You get back a plan to read out loud and, if it can't be done, the reason. Pass the request in the user's own words with every detail they gave.",
  parameters: {
    type: "object",
    properties: { request: { type: "string", description: "What the user asked for, in their own words and language." } },
    required: ["request"],
    additionalProperties: false,
  },
};

const CONFIRM_TOOL = {
  type: "function",
  name: "crm_confirm",
  description:
    "Execute the plan you just read out loud. Call this ONLY after the user heard the plan and said yes. Never call it on your own initiative and never to save a step — it writes to the company's real database.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

const CANCEL_TOOL = {
  type: "function",
  name: "crm_cancel",
  description: "Drop the pending plan without writing anything. Call this when the user says no, cancels, or walks away from the change.",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

export const voiceTools = (canWrite) =>
  canWrite ? [LOOKUP_TOOL, ASK_TOOL, PLAN_TOOL, CONFIRM_TOOL, CANCEL_TOOL] : [LOOKUP_TOOL, ASK_TOOL];

// Everything the relay endpoint will accept. Write tools stay in the set even
// for a read-only caller: runVoiceTool answers those with a spoken DENIED the
// model can relay, which is friendlier than an HTTP error the session can't see.
export const VOICE_TOOL_NAMES = new Set(voiceTools(true).map((t) => t.name));

// ── Session minting ──────────────────────────────────────────────────────────
// Over WebRTC the media itself is Opus negotiated in the SDP, so the PCM format
// fields only belong on a WebSocket session.
function audioConfig(transport, langLock) {
  const pcm = { type: "audio/pcm", rate: AUDIO_RATE };
  // A locked conversation can tell the transcriber what to expect too; on auto
  // it stays unset, which is what a team that code-switches needs.
  const pinned = langLocked(langLock) ? langLock : (VOICE_TRANSCRIBE_LANGUAGE || null);
  return {
    input: {
      ...(transport === "websocket" ? { format: pcm } : {}),
      noise_reduction: { type: "near_field" }, // phone/laptop mic held close
      // Language is left to auto-detect: the team switches between Spanish and
      // English mid-sentence, and pinning one mangles the other. Set
      // VOICE_TRANSCRIBE_LANGUAGE only if auto-detect misfires on your accent.
      transcription: {
        model: VOICE_TRANSCRIBE_MODEL,
        ...(pinned ? { language: pinned } : {}),
      },
      // Semantic VAD decides the turn ended from meaning, not just silence, so
      // it doesn't cut someone off mid-thought; "high" eagerness keeps it snappy.
      // interrupt_response is what makes barge-in work.
      turn_detection: { type: "semantic_vad", eagerness: "high", create_response: true, interrupt_response: true },
    },
    output: {
      ...(transport === "websocket" ? { format: pcm } : {}),
      voice: VOICE_VOICE,
      speed: VOICE_SPEED,
    },
  };
}

export async function buildVoiceSession({ actor, canWrite, transport, lang, langLock }) {
  return {
    type: "realtime",
    model: VOICE_MODEL,
    instructions: await buildVoiceInstructions({ actor, canWrite, lang, langLock }),
    output_modalities: ["audio"],
    audio: audioConfig(transport, langLock),
    tools: voiceTools(canWrite),
    tool_choice: "auto",
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };
}

// -> everything the browser needs to open the socket itself. The OpenAI key
// never leaves the server; `client_secret` is an `ek_…` scoped to this session.
// Which knobs a realtime model accepts varies by model, and the API answers an
// unsupported one with a 400 naming the exact path
// ("session.audio.input.transcription.languages"). Those are all quality
// tuning: dropping one costs a little polish, refusing to open the session
// costs the whole feature. So an unsupported parameter is removed and the mint
// retried. Never these, though — without them there is no agent, only a
// chatbot with our instructions missing.
const REQUIRED_SESSION_KEYS = new Set(["type", "model", "instructions", "tools", "tool_choice"]);

// -> the path that was dropped, or null when it can't or must not be.
export function dropSessionParam(session, param) {
  const parts = String(param || "").split(".");
  if (parts.shift() !== "session" || !parts.length) return null;
  if (REQUIRED_SESSION_KEYS.has(parts[0])) return null;
  let node = session;
  for (const key of parts.slice(0, -1)) {
    node = node?.[key];
    if (!node || typeof node !== "object") return null;
  }
  const last = parts[parts.length - 1];
  if (!node || typeof node !== "object" || !(last in node)) return null;
  delete node[last];
  return param;
}

const MINT_ATTEMPTS = 4;

export async function mintVoiceSession({ actor, canWrite, transport = "webrtc", lang, langLock }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error(vt(lang).noKey);
  const t = transport === "websocket" ? "websocket" : "webrtc";
  const session = await buildVoiceSession({ actor, canWrite, transport: t, lang, langLock });

  let j = null;
  const dropped = [];
  for (let attempt = 0; attempt < MINT_ATTEMPTS; attempt++) {
    const res = await fetch(`${REALTIME_HTTP}/client_secrets`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: SECRET_TTL_S }, session }),
    });
    if (res.ok) { j = await res.json(); break; }

    const body = await res.text();
    let err = null;
    try { err = JSON.parse(body)?.error; } catch { /* not JSON — nothing to salvage */ }
    const gone = res.status === 400 ? dropSessionParam(session, err?.param) : null;
    if (!gone) throw new Error(`OpenAI realtime ${res.status}: ${body.slice(0, 300)}`);
    dropped.push(gone);
    console.warn(`voice: ${VOICE_MODEL} rejected ${gone} (${err?.message || "unsupported"}) — retrying without it`);
  }
  if (!j) throw new Error(vt(lang).rejected(dropped.join(", ")));

  const model = encodeURIComponent(VOICE_MODEL);
  return {
    client_secret: j.value,
    expires_at: j.expires_at,
    model: VOICE_MODEL,
    transport: t,
    // Endpoints travel with the token so a change on OpenAI's side is a server
    // deploy, not a stale bundle in someone's browser.
    sdp_url: `${REALTIME_HTTP}/calls?model=${model}`,
    ws_url: `wss://api.openai.com/v1/realtime?model=${model}`,
    audio_rate: AUDIO_RATE,
    can_write: canWrite,
    voice: VOICE_VOICE,
    lang: voiceLang(lang),
    lang_lock: langLocked(langLock) ? langLock : "auto",
    tools: session.tools.map((t2) => t2.name),
    dropped, // visible in the network tab when a knob didn't survive the model
  };
}

// ── Tool dispatch ────────────────────────────────────────────────────────────
// Returns { output, ui, ms }:
//   output — the string handed back to the voice model as function_call_output.
//   ui     — what the CRM panel shows next to the transcript (the model
//            summarises out loud; the screen keeps the exact text).
//   ms     — server-side duration, so the panel can show real tool latency.
export async function runVoiceTool({ name, input, convoKey, actor, lang }) {
  const T = vt(lang);
  const started = Date.now();
  const done = (output, ui) => ({
    output: typeof output === "string" ? output : JSON.stringify(output),
    ui: ui || null,
    ms: Date.now() - started,
  });
  const canWrite = !!actor?.profile && writesEnabled();

  try {
    switch (name) {
      case "crm_lookup": {
        const q = String(input?.query || "").trim();
        if (!q) return done("ERROR: empty query", { kind: "error", text: T.emptyQuery });
        const denied = checkSqlAccess(q, actor.profile);
        if (denied) return done(`DENIED: ${denied}`, { kind: "error", text: denied });
        const { data, error } = await admin.rpc("agent_query", { q });
        if (error) return done(`ERROR: ${error.message}`, { kind: "error", text: error.message });
        let rows = JSON.stringify(data);
        if (rows.length > RESULT_MAX) rows = rows.slice(0, RESULT_MAX) + "…(truncated: aggregate or LIMIT and ask again)";
        return done(rows, { kind: "lookup", text: q, rows: Array.isArray(data) ? data.length : 0 });
      }

      case "crm_ask": {
        const question = String(input?.question || "").trim();
        if (!question) return done("ERROR: empty question", { kind: "error", text: T.emptyQuery });
        const { reply } = await handleIncoming(convoKey, question, [], actor, null, { readOnly: true, detail: true });
        return done(reply, { kind: "answer", text: reply });
      }

      case "crm_plan": {
        const request = String(input?.request || "").trim();
        if (!request) return done("ERROR: empty request", { kind: "error", text: T.emptyQuery });
        if (!canWrite) {
          return done("DENIED: this caller is read-only — say so instead of proposing the change.",
            { kind: "error", text: T.readOnly });
        }
        const { reply, state } = await handleIncoming(convoKey, request, [], actor, null, { detail: true });
        const pending = state === "pending_confirmation";
        return done(
          JSON.stringify({
            plan: reply,
            awaiting_confirmation: pending,
            next: pending
              ? "Read this back in ONE short sentence and ask if you should go ahead. Call crm_confirm only after they say yes."
              : "Nothing is staged — this is the answer, say it as is. Do not call crm_confirm.",
          }),
          { kind: "plan", text: reply, pending },
        );
      }

      case "crm_confirm": {
        if (!canWrite) return done("DENIED: this caller is read-only.", { kind: "error", text: T.readOnly });
        const { reply } = await handleIncoming(convoKey, "yes", [], actor, null, { decision: "confirm", detail: true });
        return done(reply, { kind: "result", text: reply });
      }

      case "crm_cancel": {
        const { reply } = await handleIncoming(convoKey, "no", [], actor, null, { decision: "cancel", detail: true });
        return done(reply, { kind: "result", text: reply });
      }

      default:
        return done(`ERROR: unknown tool "${name}"`, { kind: "error", text: T.unknownTool(name || "?") });
    }
  } catch (e) {
    console.error("voice-tool:", name, e);
    const msg = e?.message || "tool error";
    return done(`ERROR: ${msg}`, { kind: "error", text: msg || T.toolError });
  }
}
