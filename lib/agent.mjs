// The CRM messaging agent's brain, shared by every channel (WhatsApp, Telegram).
// A team member texts in natural language ("tenemos un job del cliente García,
// entrega el viernes...") and it creates/updates/queries storage_jobs rows.
// Claude extracts the intent + fields (structured output); every DB write is
// proposed back to the sender first and only committed after an explicit
// "sí/ok" — the pending draft lives in wa_conversations, keyed by a
// channel-scoped id ("+549..." for WhatsApp, "tg:12345" for Telegram).
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

// AGENT_ANTHROPIC_API_KEY (optional) gives the agent its own key so its spend
// shows separately in the Anthropic console's per-key usage breakdown; falls
// back to the shared ANTHROPIC_API_KEY.
export const client = new Anthropic({ apiKey: process.env.AGENT_ANTHROPIC_API_KEY || process.env.ANTHROPIC_API_KEY });
const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
export const admin = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

const HISTORY_MAX = 10;       // conversation turns kept for context
export const REPLY_MAX = 1500; // WhatsApp caps messages at 1600 chars

const STATUSES = ["scheduled", "picked_up", "in_storage", "out_for_delivery", "delivered", "on_hold"];
// NOTE: JS \b is ASCII-only and breaks after accented letters ("sí" wouldn't
// match) — use a Unicode-aware lookahead instead.
const YES_RE = /^\s*(ok(ay)?|s[ií]|dale|confirmo|confirmar|listo|va|yes|yep|sure|confirm(ed)?|go( ahead)?|correct)(?![\p{L}\p{N}_])/iu;
const NO_RE = /^\s*(no(pe)?|cancel(a|ar|o)?|nada|olvidalo|olv[ií]dalo|forget it|nevermind|never mind|stop)(?![\p{L}\p{N}_])/iu;

// The agent mirrors the user's language. Canned strings live here; free-form
// text comes from Claude, which is told to reply in `language`.
const T = {
  es: {
    confirm: "¿Confirmás? (sí / no)",
    cancelled: "Cancelado 👍 No cargué nada.",
    created: "✅ Job creado:",
    updated: (n) => `✅ Job ${n} actualizado:`,
    willCreate: "Voy a crear este job:",
    willUpdate: (n, c) => `Job ${n}${c ? ` (${c})` : ""} — voy a cambiar:`,
    needCustomer: "Para crear el job necesito al menos el cliente o el número de job. ¿Me los pasás?",
    whichJob: "¿De qué número de job hablás? Decime el job # y qué querés cambiar.",
    whatChange: (n) => `¿Qué querés cambiar del job ${n}? (fecha de entrega, FADD, status...)`,
    notFound: (n) => `No encuentro ningún job con el número ${n}. ¿Está bien el número?`,
    ambiguous: (n, cs) => `El número ${n} aparece con más de un cliente (${cs}). Aclarame de cuál se trata.`,
    brokerNotFound: (n, list) => `No encuentro el broker "${n}" en el CRM.${list ? ` Los que hay: ${list}.` : ""} ¿Cuál es, o lo dejo sin broker?`,
    brokerAmbiguous: (n, list) => `Hay varios brokers que coinciden con "${n}": ${list}. ¿Cuál de ellos?`,
    moreDetail: "¿Me das un poco más de detalle?",
    fallbackHelp: "Puedo crear jobs, actualizarlos o consultar cualquier dato del CRM. Contame qué necesitás.",
    error: "⚠️ Hubo un error procesando el mensaje. Intentá de nuevo en un momento.",
  },
  en: {
    confirm: "Confirm? (yes / no)",
    cancelled: "Cancelled 👍 Nothing was saved.",
    created: "✅ Job created:",
    updated: (n) => `✅ Job ${n} updated:`,
    willCreate: "I'm about to create this job:",
    willUpdate: (n, c) => `Job ${n}${c ? ` (${c})` : ""} — I'll change:`,
    needCustomer: "To create the job I need at least the customer name or the job number. Can you share them?",
    whichJob: "Which job number are you referring to? Tell me the job # and what to change.",
    whatChange: (n) => `What do you want to change on job ${n}? (delivery date, FADD, status...)`,
    notFound: (n) => `I can't find any job with number ${n}. Is the number right?`,
    ambiguous: (n, cs) => `Number ${n} appears under more than one customer (${cs}). Which one do you mean?`,
    brokerNotFound: (n, list) => `I can't find broker "${n}" in the CRM.${list ? ` Existing brokers: ${list}.` : ""} Which one is it, or should I leave it without a broker?`,
    brokerAmbiguous: (n, list) => `Several brokers match "${n}": ${list}. Which one?`,
    moreDetail: "Can you give me a bit more detail?",
    fallbackHelp: "I can create jobs, update them, or answer questions about any CRM data. What do you need?",
    error: "⚠️ Something went wrong processing your message. Please try again in a moment.",
  },
};
const tr = (lang) => T[lang === "en" ? "en" : "es"];

// ── Claude extraction ────────────────────────────────────────────────────────
// Structured-outputs schema: every object closed, every field required;
// "" = the user didn't mention that field.
const FIELD_KEYS = ["job_number", "customer", "driver", "broker", "job_type", "status", "pickup_date", "pickup_date_from", "pickup_date_to", "pickup_address", "pickup_city", "pickup_state", "pickup_zip", "delivery_date", "delivery_address", "delivery_city", "delivery_state", "delivery_zip", "fadd", "volume", "rep", "estimate", "deposit", "pickup_balance", "delivery_balance", "client_phone", "client_email", "notes"];
const NUMERIC_FIELDS = new Set(["estimate", "deposit", "pickup_balance", "delivery_balance"]);
const DATE_FIELDS = new Set(["pickup_date", "pickup_date_from", "pickup_date_to", "delivery_date", "fadd"]);

const INTENT_SCHEMA = {
  type: "object",
  properties: {
    intent: { type: "string", enum: ["create_job", "update_job", "query_crm", "chitchat", "unknown"] },
    language: { type: "string", enum: ["es", "en"], description: "Language the user wrote in" },
    target_job_number: { type: "string", description: "For update_job: the job number the user refers to, or \"\"" },
    fields: {
      type: "object",
      properties: Object.fromEntries(FIELD_KEYS.map((k) => [k, { type: "string" }])),
      required: FIELD_KEYS,
      additionalProperties: false,
    },
    reply: { type: "string", description: "Spanish reply for chitchat/unknown, or the clarifying question when needs_clarification" },
    needs_clarification: { type: "boolean" },
  },
  required: ["intent", "language", "target_job_number", "fields", "reply", "needs_clarification"],
  additionalProperties: false,
};

function buildPrompt({ today, text, history, draft }) {
  return [
    "You are the messaging assistant of \"No Borders Moving\", a US moving & storage company. A team member texts you in Spanish or English to load jobs into the CRM. Classify the message and extract fields. Set `language` to the language of the message and write `reply` in that same language.",
    "",
    "Intents:",
    "- create_job: they describe a new job/move to load (\"tenemos este job...\", \"cargá un trabajo de...\").",
    "- update_job: they change an existing job, usually referenced by its number (\"el job 1234 se entrega el viernes\"). Put the number in target_job_number.",
    "- query_crm: ANY question about CRM data — jobs, deliveries, storage, trips, trucks, drivers, brokers, billing, payments, expenses, bank, claims, BOLs, employees, users... (\"¿qué entregas hay esta semana?\", \"¿cuánto facturamos este mes?\", \"¿qué camiones están en ruta?\"). A separate step answers it; you only classify.",
    "- chitchat: greetings/thanks. unknown: anything else. For both, write a short helpful Spanish `reply` explaining what you can do.",
    "",
    "Field rules:",
    "- Leave any field the user did NOT mention as \"\". Never invent data.",
    "- Dates → ISO YYYY-MM-DD, resolved against TODAY below (timezone America/New_York). \"el viernes\" = the next Friday.",
    "- \"se entrega / entrega el X\" → delivery_date. fadd (First Available Delivery Date) ONLY if they say FADD or \"primera fecha disponible (de entrega)\".",
    "- Pickup window \"entre el 5 y el 8\" → pickup_date_from / pickup_date_to.",
    "- broker: the broker/company that sent the job (\"Safe Ship\", \"Full Value Van Lines\"...) → broker field (name as text; it gets matched against the CRM's broker list afterwards).",
    `- status must be one of: ${STATUSES.join(", ")} (map Spanish: agendado→scheduled, levantado/recogido→picked_up, en depósito→in_storage, en camino/salió→out_for_delivery, entregado→delivered, en pausa→on_hold).`,
    "- estimate/deposit/pickup_balance/delivery_balance → plain numbers as strings, no $ or commas.",
    "- Set needs_clarification=true (with a Spanish question in `reply`) if a create_job lacks both customer and job number, or an update is ambiguous.",
    draft ? `The user has this PENDING DRAFT awaiting confirmation; their message is a correction/addition to it. Re-emit the SAME intent with the full corrected field set (draft merged with changes):\n${JSON.stringify(draft)}` : null,
    "",
    `TODAY: ${today}`,
    history.length ? `RECENT CONVERSATION: ${JSON.stringify(history)}` : "",
    `MESSAGE: ${text}`,
  ].filter((l) => l !== null && l !== "").join("\n");
}

// attachments: [{ media_type, data }] (base64) — images or PDFs the user sent
// (photos of estimates, BOLs, screenshots). They're placed before the text so
// Claude extracts job fields straight from them.
function attachmentBlocks(attachments) {
  return (attachments || []).map((a) =>
    a.media_type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } }
      : { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } }
  );
}

async function extractIntent({ text, history, draft, attachments }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" }); // YYYY-MM-DD
  const prompt = buildPrompt({ today, text: text || "(no text — see the attached file/s)", history, draft }) +
    (attachments?.length ? "\nATTACHMENTS: the user attached file(s) (estimate, BOL, screenshot, etc.). Extract job data from them; the text message (if any) adds or overrides details. If the attachment clearly describes a new job, intent is create_job." : "");
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 8000,
    thinking: { type: "adaptive" },
    // effort "medium": replies should land in seconds, and every write is
    // confirmed by the user anyway.
    output_config: { effort: "medium", format: { type: "json_schema", schema: INTENT_SCHEMA } },
    messages: [{ role: "user", content: [...attachmentBlocks(attachments), { type: "text", text: prompt }] }],
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

const FIELD_LABELS = {
  es: { job_number: "Job #", customer: "Cliente", driver: "Driver", broker: "Broker", broker_id: "Broker", job_type: "Tipo", status: "Status", pickup_date: "Pickup", pickup_date_from: "Pickup desde", pickup_date_to: "Pickup hasta", pickup_address: "Dirección pickup", pickup_city: "Ciudad pickup", pickup_state: "Estado pickup", pickup_zip: "ZIP pickup", delivery_date: "Entrega", delivery_address: "Dirección entrega", delivery_city: "Ciudad entrega", delivery_state: "Estado entrega", delivery_zip: "ZIP entrega", fadd: "FADD", volume: "Volumen (cf)", rep: "Rep", estimate: "Estimate", deposit: "Depósito", pickup_balance: "Balance pickup", delivery_balance: "Balance entrega", client_phone: "Tel. cliente", client_email: "Email cliente", notes: "Notas" },
  en: { job_number: "Job #", customer: "Customer", driver: "Driver", broker: "Broker", broker_id: "Broker", job_type: "Type", status: "Status", pickup_date: "Pickup", pickup_date_from: "Pickup from", pickup_date_to: "Pickup to", pickup_address: "Pickup address", pickup_city: "Pickup city", pickup_state: "Pickup state", pickup_zip: "Pickup ZIP", delivery_date: "Delivery", delivery_address: "Delivery address", delivery_city: "Delivery city", delivery_state: "Delivery state", delivery_zip: "Delivery ZIP", fadd: "FADD", volume: "Volume (cf)", rep: "Rep", estimate: "Estimate", deposit: "Deposit", pickup_balance: "Pickup balance", delivery_balance: "Delivery balance", client_phone: "Client phone", client_email: "Client email", notes: "Notes" },
};

const summarize = (data, lang = "es") => Object.entries(data).map(([k, v]) => `• ${(FIELD_LABELS[lang === "en" ? "en" : "es"])[k] || k}: ${v}`).join("\n");

// ── Intent handlers (deterministic — the model never writes to the DB) ───────
// Each returns { reply, state?, pending? } and handleIncoming persists.

// "broker" arrives as a name; the CRM stores broker_id (FK to brokers). Match
// case-insensitively; on 0 or >1 matches return a clarification instead.
async function resolveBroker(name, t) {
  const { data: all, error } = await admin.from("brokers").select("id, name").limit(500);
  if (error) throw error;
  const q = name.toLowerCase();
  let matches = (all || []).filter((b) => (b.name || "").toLowerCase() === q);
  if (!matches.length) matches = (all || []).filter((b) => (b.name || "").toLowerCase().includes(q) || q.includes((b.name || "").toLowerCase()));
  if (matches.length === 1) return { id: matches[0].id, name: matches[0].name };
  const list = (all || []).slice(0, 15).map((b) => b.name).join(", ");
  if (!matches.length) return { clarify: t.brokerNotFound(name, list) };
  return { clarify: t.brokerAmbiguous(name, matches.map((b) => b.name).join(", ")) };
}

// Swap broker text for broker_id in a jobs patch. Returns { clarify } to ask
// the user, or { brokerName } (possibly null) when resolved.
async function applyBroker(data, t) {
  if (!data.broker) return { brokerName: null };
  const name = data.broker;
  delete data.broker;
  const r = await resolveBroker(name, t);
  if (r.clarify) return { clarify: r.clarify };
  data.broker_id = r.id;
  return { brokerName: r.name };
}

// For confirmation summaries: show the broker's name instead of its numeric id.
const withBrokerName = (data, brokerName) => (brokerName ? { ...data, broker_id: brokerName } : data);

async function commitPending(pending) {
  const t = tr(pending.lang);
  if (pending.type === "create_job") {
    const row = { status: "scheduled", ...pending.data };
    const { error } = await admin.from("storage_jobs").insert([row]);
    if (error) throw error;
    return `${t.created}\n${summarize(withBrokerName(pending.data, pending.broker_name), pending.lang)}`;
  }
  if (pending.type === "update_job") {
    const { error } = await admin.from("storage_jobs").update(pending.data).in("id", pending.job_ids);
    if (error) throw error;
    return `${t.updated(pending.job_number)}\n${summarize(withBrokerName(pending.data, pending.broker_name), pending.lang)}`;
  }
  throw new Error("pending_action desconocida");
}

async function handleCreate(intent) {
  const lang = intent.language;
  const t = tr(lang);
  const data = cleanFields(intent.fields);
  if (!data.customer && !data.job_number) {
    return { reply: t.needCustomer };
  }
  const b = await applyBroker(data, t);
  if (b.clarify) return { reply: b.clarify };
  return {
    state: "pending_confirmation",
    pending: { type: "create_job", data, lang, broker_name: b.brokerName },
    reply: `${t.willCreate}\n${summarize(withBrokerName(data, b.brokerName), lang)}\n\n${t.confirm}`,
  };
}

async function handleUpdate(intent) {
  const lang = intent.language;
  const t = tr(lang);
  const jobNumber = String(intent.target_job_number || intent.fields?.job_number || "").trim();
  if (!jobNumber) return { reply: t.whichJob };
  const patch = cleanFields(intent.fields);
  delete patch.job_number; // the reference, not a change
  if (!Object.keys(patch).length) return { reply: t.whatChange(jobNumber) };

  // A job can span multiple rows sharing job_number (one per storage location) —
  // update them all so the job stays consistent, like the app's edit form does.
  const { data: rows, error } = await admin.from("storage_jobs")
    .select("id, job_number, customer, status, fadd, delivery_date")
    .eq("job_number", jobNumber);
  if (error) throw error;
  if (!rows.length) return { reply: t.notFound(jobNumber) };

  const customers = [...new Set(rows.map((r) => r.customer).filter(Boolean))];
  if (customers.length > 1) {
    return { reply: t.ambiguous(jobNumber, customers.join(", ")) };
  }
  const b = await applyBroker(patch, t);
  if (b.clarify) return { reply: b.clarify };
  return {
    state: "pending_confirmation",
    pending: { type: "update_job", job_ids: rows.map((r) => r.id), job_number: jobNumber, data: patch, lang, broker_name: b.brokerName },
    reply: `${t.willUpdate(jobNumber, customers[0])}\n${summarize(withBrokerName(patch, b.brokerName), lang)}\n\n${t.confirm}`,
  };
}

// ── CRM-wide read-only Q&A ───────────────────────────────────────────────────
// For query_crm, Claude investigates the database itself through the sql tool,
// which calls the agent_query() Postgres function — hard-limited to a single
// SELECT, read-only transaction, 200 rows (see scripts/setup-agent-query.mjs).

const SQL_TOOL = {
  name: "sql",
  description: "Run a single read-only PostgreSQL SELECT against the CRM database. Returns up to 200 rows as JSON. No semicolons, one statement. Use LIMIT, aggregates (sum/count/avg), JOINs and filters freely.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "One SELECT (or WITH...SELECT) statement" } },
    required: ["query"],
  },
};

// Table/column map for the prompt, built from information_schema through the
// same RPC. Cached per warm lambda; chat + agent-state tables stay private.
let schemaCache = { text: null, at: 0 };
async function getDbSchema() {
  if (schemaCache.text && Date.now() - schemaCache.at < 10 * 60 * 1000) return schemaCache.text;
  const { data, error } = await admin.rpc("agent_query", {
    q: "select table_name, string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as cols from information_schema.columns where table_schema = 'public' and table_name not like 'chat_%' and table_name not in ('wa_conversations') group by table_name order by table_name",
  });
  if (error) throw new Error(`agent_query no disponible: ${error.message} (¿corriste scripts/setup-agent-query.mjs?)`);
  schemaCache = { text: data.map((r) => `${r.table_name}: ${r.cols}`).join("\n"), at: Date.now() };
  return schemaCache.text;
}

async function handleCrmQuery(text, history) {
  const schema = await getDbSchema();
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const messages = [{
    role: "user",
    content: [
      "You are the messaging assistant of \"No Borders Moving\" (US moving & storage company). A team member asked a question about CRM data. Investigate with the `sql` tool and answer.",
      "",
      "DATABASE SCHEMA (PostgreSQL, table: columns):",
      schema,
      "",
      "Domain notes:",
      "- storage_jobs = the jobs/moves (a job may span several rows sharing job_number — dedupe or aggregate by job_number when counting). fadd = First Available Delivery Date. status: scheduled|picked_up|in_storage|out_for_delivery|delivered|on_hold. Money in plain numeric columns.",
      "- trips + trip_stops + trucks = dispatching/fleet; drivers + driver_work_days + driver_adjustments = drivers; brokers = brokers; storage_billing = monthly storage invoices; payments/expenses/bank_transactions = money in/out; claims = incidents; bol_documents = bills of lading; profiles = app users; employees = staff.",
      "- Business definitions (use these when asked): \"deuda real / por cobrar\" of a job = greatest(0, pickup_balance + delivery_balance + bol_balance − greatest(bol_collected, sum of received payments with concept != 'extra' for its rows)) + pending active extras (job_extras.active minus received 'extra' payments) — always net out payments, never quote raw balances as debt; \"en depósito\" = date_out is null and status not in (out_for_delivery, delivered, cancelled); \"fuga de storage billing\" = job en depósito with billing_active false/null; \"FADD vencido\" = fadd < today, date_out null, status not in (delivered, cancelled); storage_billing overdue = status='pending' and billing_period_end < today; claim activo = status in (open, investigating). payments.job_id references a storage_jobs row id (join through it; jobs may span rows sharing job_number).",
      "",
      "Rules:",
      "- Iterate: run a query, look at the result, refine if needed. Prefer aggregates over dumping rows. Results cap at 200 rows.",
      "- If a query errors, read the message and fix it.",
      "- Never invent data: answer only from query results. If empty, say you found nothing.",
      `- TODAY: ${today} (timezone America/New_York). Resolve \"esta semana\", \"este mes\" etc. against it.`,
      "- FINAL ANSWER: in the SAME LANGUAGE the question was asked in (Spanish or English), WhatsApp/Telegram style — short lines, no Markdown tables, use • or emoji sparingly, amounts like $1,234.56. Under 1400 characters: summarize + top items rather than exhaustive lists.",
      history.length ? `RECENT CONVERSATION: ${JSON.stringify(history.slice(-4))}` : "",
      `QUESTION: ${text}`,
    ].filter(Boolean).join("\n"),
  }];

  for (let i = 0; i < 8; i++) {
    const msg = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 6000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      tools: [SQL_TOOL],
      messages,
    });
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length || msg.stop_reason !== "tool_use") {
      const answer = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return { reply: answer || "No pude armar una respuesta. Probá reformular la pregunta." };
    }
    messages.push({ role: "assistant", content: msg.content });
    const results = [];
    for (const tu of toolUses) {
      let content, isError = false;
      try {
        const { data, error } = await admin.rpc("agent_query", { q: String(tu.input?.query || "") });
        if (error) throw new Error(error.message);
        content = JSON.stringify(data);
        if (content.length > 14000) content = content.slice(0, 14000) + "…(truncado: refiná la consulta o usá agregados)";
      } catch (e) {
        content = `ERROR: ${e.message}`;
        isError = true;
      }
      results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "La consulta se puso muy compleja y no llegué a una respuesta. Probá una pregunta más acotada." };
}

// ── Entry point ──────────────────────────────────────────────────────────────
// convoKey identifies the sender across channels ("+549..." / "tg:12345").
// Returns the Spanish reply; conversation state is persisted as a side effect.
export async function handleIncoming(convoKey, text, attachments = []) {
  try {
    const { data: convo } = await admin.from("wa_conversations").select("*").eq("phone", convoKey).maybeSingle();
    const history = Array.isArray(convo?.history) ? convo.history : [];
    const pending = convo?.state === "pending_confirmation" ? convo?.pending_action : null;

    let out; // { reply, state?, pending? }
    if (pending && !attachments.length && YES_RE.test(text)) {
      out = { reply: await commitPending(pending) };
    } else if (pending && !attachments.length && NO_RE.test(text)) {
      out = { reply: tr(pending.lang).cancelled };
    } else {
      // idle, or a correction while a draft is pending (re-extract with the draft as context)
      const intent = await extractIntent({ text, history, draft: pending, attachments });
      const t = tr(intent.language);
      if (intent.needs_clarification) out = { reply: intent.reply || t.moreDetail, state: convo?.state, pending };
      else if (intent.intent === "create_job") out = await handleCreate(intent);
      else if (intent.intent === "update_job") out = await handleUpdate(intent);
      else if (intent.intent === "query_crm") out = await handleCrmQuery(text, history);
      else out = { reply: intent.reply || t.fallbackHelp };
    }

    const userLine = (attachments.length ? `[${attachments.length} archivo(s) adjunto(s)] ` : "") + (text || "");
    const newHistory = [...history, { role: "user", text: userLine.trim() }, { role: "assistant", text: out.reply }].slice(-HISTORY_MAX * 2);
    await admin.from("wa_conversations").upsert({
      phone: convoKey,
      state: out.state || "idle",
      pending_action: out.pending || null,
      history: newHistory,
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });

    return String(out.reply).slice(0, REPLY_MAX + 100);
  } catch (e) {
    console.error("agent:", e);
    return "⚠️ Hubo un error procesando el mensaje / Something went wrong. Try again in a moment.";
  }
}
