// Vercel serverless: agent hub — two agent features share one function to stay
// under the Hobby plan's 12-function limit.
//
//   GET  → daily ops brief (Vercel Cron / manual). Auth: Bearer CRON_SECRET or
//          ?secret=; ?dry=1 returns JSON without sending. Posts to the team's
//          Telegram group (TELEGRAM_BRIEF_CHAT_ID).
//   POST → in-app chat for the CRM widget (src/agentChat.jsx) and the real-time
//          voice agent (src/voiceAgent.jsx), which uses the `voice_token` and
//          `voice_tool` actions. Auth: the caller's Supabase JWT, verified
//          server-side (admin-users pattern) — or, for the ElevenLabs agent,
//          the `x-agent-secret` shared secret (see serverToServerAuth).
import { createHash, timingSafeEqual } from "node:crypto";
import { admin, handleIncoming, warmCaches } from "../lib/agent.mjs";
import { writesEnabled } from "../lib/agentWrite.mjs";
import { collectBriefData, composeBrief, snapshotAndDeltas, saveSnapshot } from "../lib/brief.mjs";
import { mintVoiceSession, runVoiceTool, vt, VOICE_TOOL_NAMES } from "../lib/voice.mjs";

export const maxDuration = 300;

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram send failed ${res.status}: ${await res.text()}`);
}

async function dailyBrief(req, res) {
  const secret = process.env.CRON_SECRET;
  // Vercel Cron sends the Bearer header; humans testing from a browser pass ?secret=.
  const provided = req.headers.authorization === `Bearer ${secret}` || req.query?.secret === secret;
  if (secret && !provided) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!process.env.TELEGRAM_BOT_TOKEN) { res.status(500).json({ error: "server not configured" }); return; }

  try {
    const data = await collectBriefData();
    const { deltas } = await snapshotAndDeltas(data);
    const brief = await composeBrief(data, deltas);
    if (req.query?.dry) { res.status(200).json({ ok: true, dry: true, data, deltas, brief }); return; }

    const chatId = process.env.TELEGRAM_BRIEF_CHAT_ID;
    if (!chatId) { res.status(500).json({ error: "falta TELEGRAM_BRIEF_CHAT_ID (usá /chatid en el grupo)" }); return; }
    // Telegram caps messages at 4096 chars — split if the brief ran long.
    for (let i = 0; i < brief.length; i += 3900) await sendTelegram(chatId, brief.slice(i, i + 3900));
    await saveSnapshot(data); // after a real send only, so ?dry runs don't overwrite the day
    res.status(200).json({ ok: true, sent: true, chars: brief.length, deltas });
  } catch (e) {
    console.error("daily-brief:", e);
    res.status(500).json({ error: e?.message || "brief error" });
  }
}

// ── Server-to-server auth (the ElevenLabs agent) ─────────────────────────────
// The ElevenLabs agent runs its tools from ElevenLabs' own servers: there is no
// browser in the loop, so there is no Supabase JWT to send. Those calls
// authenticate with a shared secret in `x-agent-secret` instead.
//
// The secret authenticates the CALLER; it does not hand out authority. The
// request still runs AS a real CRM user (VOICE_AGENT_ACTOR_EMAIL), so
// lib/acl.mjs gates every read and every write exactly as it would for that
// person inside the app, and action_log records a real name that a human can
// undo from Trash/History. Skipping the user lookup instead would be far worse
// than it looks: checkSqlAccess() only enforces per-table read permission when
// it HAS a profile (lib/agentWrite.mjs), so a profile-less caller can read the
// whole CRM — every job, balance, payment and bank transaction.
//
// There is deliberately no default secret: a secret with a fallback baked into
// the repo is not a secret. Missing or half-set config fails closed.
const S2S_HEADER = "x-agent-secret";

// Compare digests, not the raw strings: timingSafeEqual throws when the lengths
// differ, which would leak the secret's length through the exception.
const sha256 = (v) => createHash("sha256").update(String(v), "utf8").digest();
const secretMatches = (given, expected) => timingSafeEqual(sha256(given), sha256(expected));

// -> null when this isn't a server-to-server call at all (fall through to the
//    JWT path) | { ok: false, status, error } | { ok: true, actor }
// `db` is injectable so scripts/test-agent-auth.mjs can exercise the decision
// table without a Supabase project behind it.
export async function serverToServerAuth(req, db = admin) {
  const given = req.headers?.[S2S_HEADER];
  if (!given) return null;

  const expected = process.env.VOICE_AGENT_SECRET;
  const email = String(process.env.VOICE_AGENT_ACTOR_EMAIL || "").trim().toLowerCase();
  if (!expected || !email) {
    return { ok: false, status: 503, error: "el agente server-to-server no está configurado (faltan VOICE_AGENT_SECRET y/o VOICE_AGENT_ACTOR_EMAIL)" };
  }
  if (!secretMatches(given, expected)) return { ok: false, status: 401, error: "No autorizado." };

  const { data: profile } = await db.from("profiles").select("*").eq("email", email).maybeSingle();
  if (!profile) return { ok: false, status: 503, error: `VOICE_AGENT_ACTOR_EMAIL (${email}) no existe en profiles` };
  if (profile.active === false) return { ok: false, status: 403, error: "el usuario del agente está desactivado" };

  return { ok: true, actor: { profile, userEmail: profile.email || email } };
}

// ── Un turno de voz no puede colgarse ────────────────────────────────────────
// Si una tool no vuelve, la persona se queda escuchando silencio hasta que la
// plataforma corta la llamada por su cuenta — y el modelo nunca se entera de
// que algo falló, así que no puede ni disculparse ni reintentar distinto.
// Mejor una respuesta hablable que un socket muerto.
//
// El tope se aplica SOLO a las tools de lectura. crm_plan, crm_confirm y
// crm_cancel llevan estado: cortar un crm_plan por tiempo puede dejar un plan
// staged que la persona nunca escuchó, y un "sí" posterior lo ejecutaría —
// exactamente lo que la regla de confirmar-antes-de-escribir existe para
// impedir. Esos corren hasta terminar.
const CAPPED_TOOLS = new Set(["crm_lookup", "crm_ask"]);
const TOOL_TIMEOUT_MS = Number(process.env.VOICE_TOOL_TIMEOUT_MS || 15000);

export async function runToolWithBudget(name, run, lang, ms = TOOL_TIMEOUT_MS) {
  if (!CAPPED_TOOLS.has(name)) return run();
  const started = Date.now();
  let timer;
  const budget = new Promise((resolve) => {
    timer = setTimeout(() => resolve({
      // El texto del output se lo lee el MODELO, no la persona: le dice qué
      // hacer distinto en vez de dejarlo repetir la misma llamada lenta.
      output: `ERROR: the call took more than ${Math.round(ms / 1000)}s and was dropped. Do NOT repeat it. Ask for something narrower — a count, one job, one date — or tell the user you couldn't get it.`,
      ui: { kind: "error", text: vt(lang).slow },
      ms: Date.now() - started,
      timed_out: true,
    }), ms);
  });
  try {
    return await Promise.race([run(), budget]);
  } finally {
    clearTimeout(timer); // si ganó la tool, el lambda no queda vivo por el timer
  }
}

const ATTACH_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif", "application/pdf"]);
const MAX_ATTACH_B64 = 4_200_000; // ~3MB binary; Vercel caps request bodies at 4.5MB

async function appChat(req, res) {
  // ElevenLabs first: a request carrying x-agent-secret is never also a browser
  // session, so a bad secret must 401 rather than fall through to the JWT path.
  const s2s = await serverToServerAuth(req);
  if (s2s && !s2s.ok) { res.status(s2s.status).json({ error: s2s.error }); return; }

  let user = null;
  let profile;
  if (s2s) {
    profile = s2s.actor.profile;
  } else {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (!token) { res.status(401).json({ error: "No autorizado." }); return; }
    const { data: { user: u } = {}, error: uErr } = await admin.auth.getUser(token);
    if (uErr || !u) { res.status(401).json({ error: "No autorizado.", detail: uErr?.message || "token inválido" }); return; }
    user = u;
    // The caller's CRM profile drives what the agent is allowed to write.
    ({ data: profile } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle());
  }

  // Issue a one-time code so this user can link their Telegram account.
  if (req.body?.action === "link_code") {
    // Browser-only: the code belongs to the signed-in person, not to a shared
    // machine credential.
    if (s2s) { res.status(403).json({ error: "acción no disponible para el agente server-to-server" }); return; }
    const code = String(Math.floor(100000 + Math.random() * 900000));
    const { error } = await admin.from("profiles")
      .update({ link_code: code, link_code_expires_at: new Date(Date.now() + 15 * 60 * 1000).toISOString() })
      .eq("id", user.id);
    if (error) { res.status(500).json({ error: "no pude generar el código: " + error.message }); return; }
    res.status(200).json({ code, expires_in_minutes: 15 });
    return;
  }

  // The voice agent talks to the same brain through its own conversation key:
  // a plan staged in the chat widget must never be executable by a spoken
  // "yes", and vice versa.
  const actor = { profile, userEmail: user?.email || profile?.email || null };
  // Conversation key. For a browser it's the person; for ElevenLabs it's the
  // individual CONVERSATION, so a plan staged in one call can never be executed
  // by a "yes" spoken in another one running at the same time.
  const convoId = String(req.body?.conversation_id || "").replace(/[^\w.-]/g, "").slice(0, 64);
  const identity = s2s
    ? `el:${convoId || actor.userEmail || "anon"}`.toLowerCase()
    : (user.email || user.id).toLowerCase();

  // Mint a short-lived client secret so the browser can open the realtime
  // socket itself. Our OpenAI key stays here; the session config (instructions,
  // tools, voice, turn detection) is fixed at mint time and the caller's CRM
  // role decides whether the write tools are even offered.
  // The CRM's display language rides along: it is the only clue available for
  // the greeting, before anyone has spoken a word, and it decides which
  // language the panel's own errors come back in.
  const lang = req.body?.lang;

  if (req.body?.action === "voice_token") {
    // Browser-only: this mints an OpenAI realtime client secret for our own
    // widget. ElevenLabs runs its own speech stack and has no use for it.
    if (s2s) { res.status(403).json({ error: "acción no disponible para el agente server-to-server" }); return; }
    warmCaches(); // the schema/directory round trips overlap with minting
    try {
      const out = await mintVoiceSession({
        actor,
        canWrite: !!profile && writesEnabled(),
        transport: req.body?.transport,
        lang,
        langLock: req.body?.lang_lock,
      });
      res.status(200).json(out);
    } catch (e) {
      console.error("voice-token:", e);
      res.status(500).json({ error: e?.message || vt(lang).openFailed });
    }
    return;
  }

  // One function call from the voice model, relayed by the browser. The browser
  // is only a pipe: permissions are checked here against this JWT's profile.
  if (req.body?.action === "voice_tool") {
    // `tool` is what our own widget sends; ElevenLabs names the field `name`.
    // Both mean the same thing and neither is worth a failed call over.
    const tool = String(req.body?.tool || req.body?.name || "");
    if (!VOICE_TOOL_NAMES.has(tool)) {
      // Name the valid tools: the caller is a model, and a bare "unknown tool"
      // gives it nothing to correct towards.
      res.status(400).json({
        error: vt(lang).unknownTool(tool || "?"),
        valid_tools: [...VOICE_TOOL_NAMES],
        hint: 'the tool name goes in "tool" (or "name"), e.g. {"action":"voice_tool","tool":"crm_lookup","input":{...}}',
      });
      return;
    }
    const input = req.body?.input && typeof req.body.input === "object" && !Array.isArray(req.body.input) ? req.body.input : {};
    const out = await runToolWithBudget(
      tool,
      () => runVoiceTool({ name: tool, input, convoKey: `voice:${identity}`, actor, lang }),
      lang,
    );
    // Una línea por llamada en los logs de Vercel: sin esto, un turno que se
    // cuelga no deja rastro de cuál tool fue ni cuánto tardó.
    console.log(`voice_tool ${tool} ${out?.ms}ms${out?.timed_out ? " TIMEOUT" : ""}`);
    res.status(200).json(out);
    return;
  }

  const message = String(req.body?.message || "").trim();
  const rawAttach = Array.isArray(req.body?.attachments) ? req.body.attachments : [];
  if (!message && !rawAttach.length) { res.status(400).json({ error: "mensaje vacío" }); return; }
  if (message.length > 4000) { res.status(400).json({ error: "mensaje demasiado largo" }); return; }
  if (rawAttach.length > 3) { res.status(400).json({ error: "máximo 3 archivos por mensaje" }); return; }
  const attachments = [];
  for (const a of rawAttach) {
    const media_type = String(a?.media_type || "");
    const data = String(a?.data || "");
    if (!ATTACH_TYPES.has(media_type)) { res.status(400).json({ error: `tipo de archivo no soportado: ${media_type || "?"} (imágenes o PDF)` }); return; }
    if (!data || data.length > MAX_ATTACH_B64) { res.status(400).json({ error: "archivo demasiado grande (máx ~3MB)" }); return; }
    attachments.push({ media_type, data });
  }

  const convoKey = `app:${identity}`;

  // Streaming (the CRM widget): the answer is pushed as it's written, so the
  // user reads the first line in a second or two instead of waiting for the
  // whole turn. Everything that could fail with an HTTP status was validated
  // above — once the stream is open, errors travel as events.
  if (req.body?.stream) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no", // don't let a proxy buffer the stream
    });
    const send = (ev) => { try { res.write(`data: ${JSON.stringify(ev)}\n\n`); } catch { /* client gone */ } };
    send({ type: "open" });
    try {
      const reply = await handleIncoming(convoKey, message, attachments, actor, send);
      send({ type: "done", reply });
    } catch (e) {
      console.error("agent-chat:", e);
      send({ type: "error", error: e?.message || "agent error" });
    }
    res.end();
    return;
  }

  try {
    const reply = await handleIncoming(convoKey, message, attachments, actor);
    res.status(200).json({ reply });
  } catch (e) {
    console.error("agent-chat:", e);
    res.status(500).json({ error: e?.message || "agent error" });
  }
}

export default async function handler(req, res) {
  if (!admin || !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "server not configured" }); return; }
  if (req.method === "GET") return dailyBrief(req, res);
  if (req.method === "POST") return appChat(req, res);
  res.status(405).end();
}
