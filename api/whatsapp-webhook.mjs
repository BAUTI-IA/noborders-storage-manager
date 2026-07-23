// Vercel serverless: WhatsApp AI agent (Twilio inbound webhook). The team texts
// the agent in natural language ("tenemos un job del cliente García, entrega el
// viernes...") and it creates/updates/queries storage_jobs rows. Claude extracts
// the intent + fields (structured output); every DB write is proposed back to
// the sender first and only committed after an explicit "sí/ok" — the pending
// draft lives in wa_conversations keyed by phone number.
//
// Configure Twilio → Messaging → WhatsApp → inbound webhook (POST) to
// https://APP_URL/api/whatsapp-webhook. Trust comes from the Twilio signature
// (TWILIO_AUTH_TOKEN) plus the WHATSAPP_ALLOWED_NUMBERS whitelist.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { waitUntil } from "@vercel/functions";
import { verifyTwilioSignature, twimlReply, normalizePhone, sendWhatsApp } from "../lib/twilio.mjs";

export const config = { api: { bodyParser: false } }; // raw body: the signature covers the exact form params
export const maxDuration = 300;

const client = new Anthropic(); // ANTHROPIC_API_KEY from env
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

const HISTORY_MAX = 10;       // conversation turns kept for context
const QUERY_LIMIT = 15;       // jobs listed per query reply
const REPLY_MAX = 1500;       // WhatsApp caps messages at 1600 chars

const STATUSES = ["scheduled", "picked_up", "in_storage", "out_for_delivery", "delivered", "on_hold"];
const YES_RE = /^\s*(ok(ay)?|s[ií]|dale|confirmo|confirmar|listo|va|yes)\b/i;
const NO_RE = /^\s*(no|cancel(a|ar|o)?|nada|olvidalo|olv[ií]dalo)\b/i;

// ── Claude extraction ────────────────────────────────────────────────────────
// Structured-outputs schema: every object closed, every field required;
// "" = the user didn't mention that field.
const FIELD_KEYS = ["job_number", "customer", "driver", "job_type", "status", "pickup_date", "pickup_date_from", "pickup_date_to", "pickup_address", "pickup_city", "pickup_state", "pickup_zip", "delivery_date", "delivery_address", "delivery_city", "delivery_state", "delivery_zip", "fadd", "volume", "rep", "estimate", "deposit", "pickup_balance", "delivery_balance", "client_phone", "client_email", "notes"];
const NUMERIC_FIELDS = new Set(["estimate", "deposit", "pickup_balance", "delivery_balance"]);
const DATE_FIELDS = new Set(["pickup_date", "pickup_date_from", "pickup_date_to", "delivery_date", "fadd"]);

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create_job", "update_job", "query_jobs", "chitchat", "unknown"] },
    target_job_number: { type: "string", description: "For update_job: the job number the user refers to, or \"\"" },
    fields: {
      type: "object",
      properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: "string" }])),
      required: FIELD_KEYS,
      additionalProperties: false,
    },
    query: {
      type: "object",
      properties: {
        date_field: { type: "string", enum: ["", "fadd", "delivery_date", "pickup_date"] },
        date_from: { type: "string" },
        date_to: { type: "string" },
        status: { type: "string", enum: ["", ...STATUSES] },
        text: { type: "string", description: "Free-text match on customer or job number, or \"\"" },
      },
      required: ["date_field", "date_from", "date_to", "status", "text"],
      additionalProperties: false,
    },
    reply: { type: "string", description: "Spanish reply for chitchat/unknown, or the clarifying question when needs_clarification" },
    needs_clarification: { type: "boolean" },
  },
  required: ["intent", "target_job_number", "fields", "query", "reply", "needs_clarification"],
  additionalProperties: false,
};

function buildPrompt({ today, text, history, draft }) {
  return [
    "You are the WhatsApp assistant of \"No Borders Moving\", a US moving & storage company. A team member texts you in Spanish (sometimes English) to load jobs into the CRM. Classify the message and extract fields.",
    "",
    "Intents:",
    "- create_job: they describe a new job/move to load (\"tenemos este job...\", \"cargá un trabajo de...\").",
    "- update_job: they change an existing job, usually referenced by its number (\"el job 1234 se entrega el viernes\"). Put the number in target_job_number.",
    "- query_jobs: they ask about jobs (\"¿qué entregas hay esta semana?\"). Fill `query`.",
    "- chitchat: greetings/thanks. unknown: anything else. For both, write a short helpful Spanish `reply` explaining what you can do.",
    "",
    "Field rules:",
    "- Leave any field the user did NOT mention as \"\". Never invent data.",
    "- Dates → ISO YYYY-MM-DD, resolved against TODAY below (timezone America/New_York). \"el viernes\" = the next Friday.",
    "- \"se entrega / entrega el X\" → delivery_date. fadd (First Available Delivery Date) ONLY if they say FADD or \"primera fecha disponible (de entrega)\".",
    "- Pickup window \"entre el 5 y el 8\" → pickup_date_from / pickup_date_to.",
    `- status must be one of: ${STATUSES.join(", ")} (map Spanish: agendado→scheduled, levantado/recogido→picked_up, en depósito→in_storage, en camino/salió→out_for_delivery, entregado→delivered, en pausa→on_hold).`,
    "- estimate/deposit/pickup_balance/delivery_balance → plain numbers as strings, no $ or commas.",
    "- For query_jobs: \"entregas\" → date_field delivery_date (or fadd if they say FADD); \"esta semana\" → date_from = Monday, date_to = Sunday of the current week.",
    "- Set needs_clarification=true (with a Spanish question in `reply`) if a create_job lacks both customer and job number, or an update is ambiguous.",
    draft ? "" : null,
    draft ? `The user has this PENDING DRAFT awaiting confirmation; their message is a correction/addition to it. Re-emit the SAME intent with the full corrected field set (draft merged with changes):\n${JSON.stringify(draft)}` : null,
    "",
    `TODAY: ${today}`,
    history.length ? `RECENT CONVERSATION: ${JSON.stringify(history)}` : "",
    `MESSAGE: ${text}`,
  ].filter((l) => l !== null && l !== "").join("\n");
}

async function extractIntent({ text, history, draft }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    // effort "medium": Twilio waits ~15s for the webhook reply, so latency matters
    // more than planning depth — and every write is confirmed by the user anyway.
    output_config: { effort: "medium", format: { type: "json_schema", schema: INTENT_SCHEMA } },
    messages: [{ role: "user", content: buildPrompt({ today, text, history, draft }) }],
  });
  return JSON.parse(message.content.filter((b) => b.type === "text").map((b) => b.text).join(""));
}

// ── Sanitizing & formatting ──────────────────────────────────────────────────
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Model fields ("" = untouched) → a clean storage_jobs patch. Numbers become
// Number, dates are validated, unknown statuses dropped.
function cleanFields(fields) {
  const out = {};
  for (const k of FIELD_KEYS) {
    const v = String(fields?.[k] ?? "").trim();
    if (!v) continue;
    if (DATE_FIELDS.has(k)) { if (ISO_DATE_RE.test(v)) out[k] = v; continue; }
    if (NUMERIC_FIELDS.has(k)) { const n = Number(v.replace(/[$,]/g, "")); if (Number.isFinite(n)) out[k] = n; continue; }
    if (k === "status") { if (STATUSES.includes(v)) out[k] = v; continue; }
    out[k] = v;
  }
  // Keep the legacy single pickup_date in sync with the range's start (same rule as the app form).
  if (out.pickup_date_from && !out.pickup_date) out.pickup_date = out.pickup_date_from;
  return out;
}

const FIELD_LABELS = { job_number: "Job #", customer: "Cliente", driver: "Driver", job_type: "Tipo", status: "Status", pickup_date: "Pickup", pickup_date_from: "Pickup desde", pickup_date_to: "Pickup hasta", pickup_address: "Dirección pickup", pickup_city: "Ciudad pickup", pickup_state: "Estado pickup", pickup_zip: "ZIP pickup", delivery_date: "Entrega", delivery_address: "Dirección entrega", delivery_city: "Ciudad entrega", delivery_state: "Estado entrega", delivery_zip: "ZIP entrega", fadd: "FADD", volume: "Volumen (cf)", rep: "Rep", estimate: "Estimate", deposit: "Depósito", pickup_balance: "Balance pickup", delivery_balance: "Balance entrega", client_phone: "Tel. cliente", client_email: "Email cliente", notes: "Notas" };

const summarize = (data) => Object.entries(data).map(([k, v]) => `• ${FIELD_LABELS[k] || k}: ${v}`).join("\n");
const fmtDate = (d) => (d && ISO_DATE_RE.test(d) ? `${d.slice(8, 10)}/${d.slice(5, 7)}` : d || "—");

function formatJobLine(j) {
  const bits = [`📦 ${j.job_number || "s/n"} — ${j.customer || "sin cliente"}`];
  if (j.status) bits.push(j.status);
  if (j.delivery_date) bits.push(`entrega ${fmtDate(j.delivery_date)}`);
  else if (j.fadd) bits.push(`FADD ${fmtDate(j.fadd)}`);
  else if (j.pickup_date) bits.push(`pickup ${fmtDate(j.pickup_date)}`);
  if (j.delivery_city) bits.push(j.delivery_city);
  return bits.join(" — ");
}

// ── Intent handlers (deterministic — the model never writes to the DB) ───────
// Each returns { reply, state?, pending? } and the caller persists.

async function commitPending(pending) {
  if (pending.type === "create_job") {
    const row = { status: "scheduled", ...pending.data };
    const { error } = await admin.from("storage_jobs").insert([row]);
    if (error) throw error;
    return `✅ Job creado:\n${summarize(pending.data)}`;
  }
  if (pending.type === "update_job") {
    const { error } = await admin.from("storage_jobs").update(pending.data).in("id", pending.job_ids);
    if (error) throw error;
    return `✅ Job ${pending.job_number} actualizado:\n${summarize(pending.data)}`;
  }
  throw new Error("pending_action desconocida");
}

async function handleCreate(intent) {
  const data = cleanFields(intent.fields);
  if (!data.customer && !data.job_number) {
    return { reply: "Para crear el job necesito al menos el cliente o el número de job. ¿Me los pasás?" };
  }
  return {
    state: "pending_confirmation",
    pending: { type: "create_job", data },
    reply: `Voy a crear este job:\n${summarize(data)}\n\n¿Confirmás? (sí / no)`,
  };
}

async function handleUpdate(intent) {
  const jobNumber = String(intent.target_job_number || intent.fields?.job_number || "").trim();
  if (!jobNumber) return { reply: "¿De qué número de job hablás? Decime el job # y qué querés cambiar." };
  const patch = cleanFields(intent.fields);
  delete patch.job_number; // the reference, not a change
  if (!Object.keys(patch).length) return { reply: `¿Qué querés cambiar del job ${jobNumber}? (fecha de entrega, FADD, status...)` };

  // A job can span multiple rows sharing job_number (one per storage location) —
  // update them all so the job stays consistent, like the app's edit form does.
  const { data: rows, error } = await admin.from("storage_jobs")
    .select("id, job_number, customer, status, fadd, delivery_date")
    .eq("job_number", jobNumber);
  if (error) throw error;
  if (!rows.length) return { reply: `No encuentro ningún job con el número ${jobNumber}. ¿Está bien el número?` };

  const customers = [...new Set(rows.map((r) => r.customer).filter(Boolean))];
  if (customers.length > 1) {
    return { reply: `El número ${jobNumber} aparece con más de un cliente (${customers.join(", ")}). Aclarame de cuál se trata.` };
  }
  return {
    state: "pending_confirmation",
    pending: { type: "update_job", job_ids: rows.map((r) => r.id), job_number: jobNumber, data: patch },
    reply: `Job ${jobNumber}${customers[0] ? ` (${customers[0]})` : ""} — voy a cambiar:\n${summarize(patch)}\n\n¿Confirmás? (sí / no)`,
  };
}

async function handleQuery(intent) {
  const q = intent.query || {};
  let query = admin.from("storage_jobs")
    .select("job_number, customer, status, pickup_date, delivery_date, fadd, delivery_city")
    .order("created_at", { ascending: false })
    .limit(QUERY_LIMIT + 1);
  const dateField = ["fadd", "delivery_date", "pickup_date"].includes(q.date_field) ? q.date_field : null;
  if (dateField && ISO_DATE_RE.test(q.date_from || "")) query = query.gte(dateField, q.date_from);
  if (dateField && ISO_DATE_RE.test(q.date_to || "")) query = query.lte(dateField, q.date_to);
  if (STATUSES.includes(q.status)) query = query.eq("status", q.status);
  if (q.text) query = query.or(`customer.ilike.%${q.text}%,job_number.ilike.%${q.text}%`);
  const { data: rows, error } = await query;
  if (error) throw error;
  if (!rows.length) return { reply: "No encontré jobs con esos criterios." };
  const lines = rows.slice(0, QUERY_LIMIT).map(formatJobLine);
  const extra = rows.length > QUERY_LIMIT ? `\n…y hay más. Afiná la búsqueda para ver el resto.` : "";
  return { reply: (lines.join("\n") + extra).slice(0, REPLY_MAX) };
}

// ── Handler ──────────────────────────────────────────────────────────────────
// Twilio cuts webhooks off at ~15s and the Claude extraction can exceed that,
// so the handler ACKs immediately with empty TwiML and does the real work in
// the background (waitUntil keeps the function alive after the response); the
// answer is delivered via the Twilio REST API instead of a TwiML reply.
function sendTwiml(res, text) {
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twimlReply(text ? String(text).slice(0, REPLY_MAX + 100) : ""));
}

async function processMessage(phone, text) {
  let reply;
  try {
    const { data: convo } = await admin.from("wa_conversations").select("*").eq("phone", phone).maybeSingle();
    const history = Array.isArray(convo?.history) ? convo.history : [];
    const pending = convo?.state === "pending_confirmation" ? convo?.pending_action : null;

    let out; // { reply, state?, pending? }
    if (pending && YES_RE.test(text)) {
      out = { reply: await commitPending(pending) };
    } else if (pending && NO_RE.test(text)) {
      out = { reply: "Cancelado 👍 No cargué nada." };
    } else {
      // idle, or a correction while a draft is pending (re-extract with the draft as context)
      const intent = await extractIntent({ text, history, draft: pending });
      if (intent.needs_clarification) out = { reply: intent.reply || "¿Me das un poco más de detalle?", state: convo?.state, pending };
      else if (intent.intent === "create_job") out = await handleCreate(intent);
      else if (intent.intent === "update_job") out = await handleUpdate(intent);
      else if (intent.intent === "query_jobs") out = await handleQuery(intent);
      else out = { reply: intent.reply || "Puedo crear jobs, actualizarlos o consultarlos. Contame qué necesitás." };
    }

    const newHistory = [...history, { role: "user", text }, { role: "assistant", text: out.reply }].slice(-HISTORY_MAX * 2);
    await admin.from("wa_conversations").upsert({
      phone,
      state: out.state || "idle",
      pending_action: out.pending || null,
      history: newHistory,
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });

    reply = out.reply;
  } catch (e) {
    console.error("whatsapp-webhook:", e);
    reply = "⚠️ Hubo un error procesando el mensaje. Intentá de nuevo en un momento.";
  }
  await sendWhatsApp(phone, String(reply).slice(0, REPLY_MAX + 100));
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!admin || !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "server not configured" }); return; }

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const params = new URLSearchParams(raw.toString("utf8"));

  // Signature over the exact public URL Twilio was configured with (APP_URL,
  // never req.headers — those are attacker-controlled).
  const url = `${(process.env.APP_URL || "").replace(/\/+$/, "")}/api/whatsapp-webhook`;
  if (!verifyTwilioSignature(process.env.TWILIO_AUTH_TOKEN, req.headers["x-twilio-signature"], url, params)) {
    res.status(401).json({ error: "bad signature" }); return;
  }

  const phone = normalizePhone(params.get("From"));
  const text = (params.get("Body") || "").trim();
  // WHATSAPP_ALLOWED_NUMBERS: comma-separated E.164 whitelist, or "*" to allow
  // any sender (the Twilio signature still gates who can call the webhook).
  const rawAllowed = (process.env.WHATSAPP_ALLOWED_NUMBERS || "").trim();
  const allowed = rawAllowed.split(",").map((s) => s.trim()).filter(Boolean);
  const isAllowed = rawAllowed === "*" || allowed.includes(phone);
  if (!phone || !isAllowed || !text) { sendTwiml(res, ""); return; } // unknown sender / empty → silent

  waitUntil(processMessage(phone, text).catch((e) => console.error("whatsapp-webhook bg:", e)));
  sendTwiml(res, ""); // ACK now; the real answer arrives via the REST API
}
