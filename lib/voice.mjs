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
export const VOICE_SPEED = Number(process.env.VOICE_SPEED || 1.05);

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

export async function buildVoiceInstructions({ actor, canWrite }) {
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
    "- Speak the SAME LANGUAGE the person is speaking, and switch the moment they switch. The team speaks Argentine Spanish and English.",
    "- One or two short sentences per turn. This is a conversation, not a report: no lists, no markdown, no emoji, no spelling out ids unless asked.",
    "- Say numbers the way a person would: \"mil doscientos dólares\", \"el doce de marzo\", \"tres jobs\". Never read raw JSON, column names or SQL out loud.",
    "- If an answer would take more than about four sentences, say the headline and offer the detail: \"Hay siete entregas. ¿Te las paso una por una?\".",
    "- Someone can interrupt you at any time. When they do, stop and listen — do not finish the sentence you were on.",
    "",
    "LATENCY — this matters as much as being right:",
    "- Before ANY tool call, say a two-to-four word filler out loud first (\"Dejame ver…\", \"Un segundo…\", \"Let me check…\"). The tool runs while you speak, so the silence disappears.",
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
    "- Money is plain numeric columns; dates are ISO. Resolve \"el viernes\"/\"next Friday\" against TODAY.",
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
    "- Open the conversation with one short greeting and then wait.",
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
function audioConfig(transport) {
  const pcm = { type: "audio/pcm", rate: AUDIO_RATE };
  return {
    input: {
      ...(transport === "websocket" ? { format: pcm } : {}),
      noise_reduction: { type: "near_field" }, // phone/laptop mic held close
      // Both languages are listed rather than one forced: the team switches
      // mid-sentence and a forced language mangles the other one.
      transcription: { model: VOICE_TRANSCRIBE_MODEL, languages: ["es", "en"] },
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

export async function buildVoiceSession({ actor, canWrite, transport }) {
  return {
    type: "realtime",
    model: VOICE_MODEL,
    instructions: await buildVoiceInstructions({ actor, canWrite }),
    output_modalities: ["audio"],
    audio: audioConfig(transport),
    tools: voiceTools(canWrite),
    tool_choice: "auto",
    max_output_tokens: MAX_OUTPUT_TOKENS,
  };
}

// -> everything the browser needs to open the socket itself. The OpenAI key
// never leaves the server; `client_secret` is an `ek_…` scoped to this session.
export async function mintVoiceSession({ actor, canWrite, transport = "webrtc" }) {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error("Falta OPENAI_API_KEY (necesaria para el agente de voz)");
  const t = transport === "websocket" ? "websocket" : "webrtc";
  const session = await buildVoiceSession({ actor, canWrite, transport: t });

  const res = await fetch(`${REALTIME_HTTP}/client_secrets`, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ expires_after: { anchor: "created_at", seconds: SECRET_TTL_S }, session }),
  });
  if (!res.ok) throw new Error(`OpenAI realtime ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();

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
    tools: session.tools.map((t2) => t2.name),
  };
}

// ── Tool dispatch ────────────────────────────────────────────────────────────
// Returns { output, ui, ms }:
//   output — the string handed back to the voice model as function_call_output.
//   ui     — what the CRM panel shows next to the transcript (the model
//            summarises out loud; the screen keeps the exact text).
//   ms     — server-side duration, so the panel can show real tool latency.
export async function runVoiceTool({ name, input, convoKey, actor }) {
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
        if (!q) return done("ERROR: empty query");
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
        if (!question) return done("ERROR: empty question");
        const { reply } = await handleIncoming(convoKey, question, [], actor, null, { readOnly: true, detail: true });
        return done(reply, { kind: "answer", text: reply });
      }

      case "crm_plan": {
        const request = String(input?.request || "").trim();
        if (!request) return done("ERROR: empty request");
        if (!canWrite) {
          const msg = "DENIED: this caller is read-only — say so instead of proposing the change.";
          return done(msg, { kind: "error", text: msg });
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
        if (!canWrite) return done("DENIED: this caller is read-only.", { kind: "error", text: "read-only" });
        const { reply } = await handleIncoming(convoKey, "yes", [], actor, null, { decision: "confirm", detail: true });
        return done(reply, { kind: "result", text: reply });
      }

      case "crm_cancel": {
        const { reply } = await handleIncoming(convoKey, "no", [], actor, null, { decision: "cancel", detail: true });
        return done(reply, { kind: "result", text: reply });
      }

      default:
        return done(`ERROR: unknown tool "${name}"`);
    }
  } catch (e) {
    console.error("voice-tool:", name, e);
    const msg = e?.message || "tool error";
    return done(`ERROR: ${msg}`, { kind: "error", text: msg });
  }
}
