// The CRM agent's brain, shared by every channel (in-app widget, Telegram,
// WhatsApp). It works like an executive assistant: the user describes what
// happened in plain language and the agent figures out where it belongs in the
// CRM.
//
// One agentic loop with two tools:
//   sql        — read-only investigation (agent_query RPC), also used to
//                resolve "the broker Full Value" → an id before writing.
//   stage_plan — propose a plan of write operations. Nothing is written here:
//                the plan is validated (permissions, columns, FKs, enums,
//                limits), stored as pending_action, and shown to the user.
//                Only an explicit "sí/yes" executes it (lib/agentWrite.mjs),
//                which audits every row into action_log so a human can undo it
//                from the CRM's Trash/History.
//
// Writes are gated by the caller's own CRM role (lib/acl.mjs) — the agent can
// never do more than the person asking could do in the app.
import { admin, client } from "./clients.mjs";
import { RECIPES } from "./recipes.mjs";
import { checkSqlAccess, describePlan, executePlan, validatePlan, writesEnabled, MAX_OPS } from "./agentWrite.mjs";

const MODEL = process.env.AGENT_MODEL || "claude-opus-4-8";

export { admin, client };

const HISTORY_MAX = 10;         // conversation turns kept for context
export const REPLY_MAX = 1500;  // WhatsApp caps messages at 1600 chars
const MAX_TURNS = 10;           // tool-loop iterations per message
const PLAN_TTL_MS = 20 * 60 * 1000;

// JS \b is ASCII-only and breaks after accented letters ("sí" wouldn't match).
const YES_RE = /^\s*(ok(ay)?|s[ií]|dale|confirm[\p{L}]*|listo|va|yes|yep|sure|go( ahead)?|correct)(?![\p{L}\p{N}_])/iu;
const NO_RE = /^\s*(no(pe)?|cancel[\p{L}]*|nada|olvid[\p{L}]*|forget it|nevermind|never mind|stop)(?![\p{L}\p{N}_])/iu;
// Words that turn an apparent yes/no into an instruction to change the plan
// ("sí, pero cambiá la fecha" / "no, primero creá el job").
const MODIFIER_RE = /\b(pero|but|cambi|change|modific|primero|first|antes|before|despu[eé]s|then|sin|salvo|excepto|except|mejor|instead|solo|s[oó]lo|only|agreg|add|quit|remove)/i;
const words = (t) => String(t || "").trim().split(/\s+/).filter(Boolean).length;
// A confirmation is a SHORT bare yes. Anything longer is a correction and must
// go back to the model, or we'd execute a plan the user was amending.
const isConfirm = (t) => YES_RE.test(t) && words(t) <= 4 && !MODIFIER_RE.test(t);
const isCancel = (t) => NO_RE.test(t) && words(t) <= 3 && !MODIFIER_RE.test(t);

const T = {
  es: {
    confirm: "¿Confirmás? (sí / no)",
    cancelled: "Cancelado 👍 No toqué nada.",
    expired: "La propuesta ya venció. Pedímelo de nuevo, por favor.",
    readOnly: "Ahora mismo estoy en modo solo lectura: puedo consultar, pero no escribir en el CRM.",
    notLinked: "Para cargar o modificar datos necesito saber quién sos en el CRM. Abrí el chat del agente dentro del CRM y tocá \"Vincular Telegram\" para obtener tu código, después mandame: /link 123456",
    error: "⚠️ Hubo un error procesando el mensaje. Intentá de nuevo en un momento.",
    done: "✅ Listo:",
    partial: "⚠️ Se ejecutó parte del plan y algo falló:",
    plan: "Voy a hacer esto:",
  },
  en: {
    confirm: "Confirm? (yes / no)",
    cancelled: "Cancelled 👍 Nothing was changed.",
    expired: "That proposal expired. Please ask me again.",
    readOnly: "I'm in read-only mode right now: I can look things up, but not write to the CRM.",
    notLinked: "To create or change data I need to know who you are in the CRM. Open the agent chat inside the CRM, tap \"Vincular Telegram\" to get your code, then send me: /link 123456",
    error: "⚠️ Something went wrong processing your message. Please try again in a moment.",
    done: "✅ Done:",
    partial: "⚠️ Part of the plan ran and something failed:",
    plan: "Here's what I'll do:",
  },
};
const tr = (lang) => T[lang === "en" ? "en" : "es"];

// ── Tools ────────────────────────────────────────────────────────────────────
const SQL_TOOL = {
  name: "sql",
  description: "Run a single read-only PostgreSQL SELECT against the CRM. Returns up to 200 rows as JSON. One statement, no semicolons. Use it to investigate, to answer questions, and to resolve names to ids (brokers, drivers, trucks, jobs) before proposing any write. Remember to filter `deleted_at is null`.",
  input_schema: {
    type: "object",
    properties: { query: { type: "string", description: "One SELECT (or WITH…SELECT) statement" } },
    required: ["query"],
  },
};

const PLAN_TOOL = {
  name: "stage_plan",
  description: "Propose the write operations needed to fulfil the user's request. Nothing is executed: the plan is validated and shown to the user for confirmation. If validation fails you get the errors back and can call this again with a corrected plan.",
  input_schema: {
    type: "object",
    properties: {
      summary: { type: "string", description: "One short sentence, in the user's language, describing what the plan does." },
      language: { type: "string", enum: ["es", "en"], description: "Language the user is writing in." },
      operations: {
        type: "array",
        description: `Ordered steps (max ${MAX_OPS}).`,
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: ["recipe", "table"] },
            name: { type: "string", description: "recipe name (kind=recipe)" },
            args: { type: "object", description: "recipe arguments (kind=recipe)" },
            op: { type: "string", enum: ["insert", "update", "soft_delete"], description: "kind=table" },
            table: { type: "string", description: "kind=table" },
            values: { type: "object", description: "column → value (insert/update)" },
            ids: { type: "array", items: { type: "integer" }, description: "row ids to update/delete — find them with sql first" },
          },
          required: ["kind"],
        },
      },
    },
    required: ["summary", "language", "operations"],
  },
};

// ── Prompt ───────────────────────────────────────────────────────────────────
// Schema map from information_schema (chat + agent-internal tables excluded).
let schemaCache = { text: null, at: 0 };
async function getDbSchema() {
  if (schemaCache.text && Date.now() - schemaCache.at < 10 * 60 * 1000) return schemaCache.text;
  const { data, error } = await admin.rpc("agent_query", {
    q: "select table_name, string_agg(column_name || ' ' || data_type, ', ' order by ordinal_position) as cols from information_schema.columns where table_schema = 'public' and table_name not like 'chat_%' and table_name not in ('wa_conversations','action_log','brief_snapshots') group by table_name order by table_name",
  });
  if (error) throw new Error(`agent_query no disponible: ${error.message} (¿corriste scripts/setup-agent-query.mjs?)`);
  schemaCache = { text: data.map((r) => `${r.table_name}: ${r.cols}`).join("\n"), at: Date.now() };
  return schemaCache.text;
}

const recipeCatalog = () => Object.entries(RECIPES).map(([n, r]) => `- ${n} ${r.doc || ""}`).join("\n");

function actorLine(actor) {
  if (!actor?.profile) return "The caller is NOT identified as a CRM user: you may READ and answer questions, but you must NOT propose any write.";
  const p = actor.profile;
  if (p.role === "admin") return `Caller: ${p.full_name || p.email} (admin — full access).`;
  const granted = Object.entries(p.permissions || {})
    .map(([sec, lv]) => `${sec}:${Object.keys(lv || {}).filter((k) => lv[k]).join("/")}`)
    .filter((s) => !s.endsWith(":")).join(", ");
  return `Caller: ${p.full_name || p.email} (member). Permissions — ${granted || "none"}. Proposing something outside these is rejected, so check first and say so instead.`;
}

async function buildSystemPrompt({ actor, canWrite }) {
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return [
    'You are the operations assistant of "No Borders Moving", a US moving & storage company. You work like an executive secretary: the team tells you what happened, in plain language, and you put it in the right place in the CRM.',
    "",
    `TODAY: ${today} (timezone America/New_York). ${actorLine(actor)}`,
    canWrite ? "You may propose writes with stage_plan." : "READ-ONLY: answer questions, but never call stage_plan.",
    "",
    "DATABASE (PostgreSQL, table: columns):",
    await getDbSchema(),
    "",
    "RECIPES for stage_plan (kind:\"recipe\") — use these whenever they fit; they carry the CRM's business rules:",
    recipeCatalog(),
    "For anything else use kind:\"table\" with op insert/update/soft_delete (update/delete need explicit `ids` you looked up with sql first).",
    "",
    "DOMAIN RULES (respect them, they are how the app behaves):",
    "- A logical job = several storage_jobs rows sharing job_number. Recipes handle this; if you write storage_jobs directly, include every row id.",
    "- `storage_jobs` IS the jobs table — creating a job there is the normal path, and `storage_id` is optional: a job can be created with no storage unit at all (the app allows exactly that). `storages` are the physical units/warehouses, a separate thing. Never create a storage in order to create a job, and never make the job depend on one unless the user asks. If they want both, create the job first and link the storage afterwards.",
    "- Jobs are attached to a trip via storage_jobs.trip_id + trip_stop_order (1..N), NEVER via trip_stops (those are non-job stops: fuel, scale, maintenance).",
    "- Trips start as 'loading' and creating one does not change job statuses; adding a job to an 'in_transit' trip does (→ out_for_delivery, or picked_up when relocating).",
    "- job status: scheduled|picked_up|in_storage|out_for_delivery|delivered|on_hold. trip status: loading|in_transit|completed|cancelled.",
    "- Payments: a digital method (anything except cash/check/money_order) is automatically received AND banked. Use the record_payment recipe so allocation and bol_collected stay consistent.",
    "- \"Real debt\" of a job = pickup_balance + delivery_balance + bol_balance − received payments, plus pending active extras. Never quote raw balances as debt.",
    "- Money is in plain numeric columns; dates are ISO YYYY-MM-DD; resolve \"el viernes\"/\"next Friday\" against TODAY.",
    "- Deletes are always recoverable (soft delete). Never propose one unless the user clearly asked for it.",
    "",
    "HOW TO WORK:",
    "1. Investigate first with sql: resolve names to ids, check the job/trip exists, look at current values. Never invent an id or a fact.",
    "2. If the request is a question, just answer it — no plan.",
    "3. If it changes data, call stage_plan ONCE with every step needed. The user confirms before anything is written, so propose the complete operation rather than asking permission mid-way.",
    "4. If something essential is missing or ambiguous (which of two clients, which broker), ask a short question instead of guessing.",
    "5. The user's latest instruction always wins over your own earlier plan. If they tell you to do it in a different order, from a different table, or with different values, do exactly that — don't restate or defend the previous approach.",
    "6. Reply in the SAME LANGUAGE the user wrote in. Chat style: short lines, no Markdown tables, amounts like $1,234, dates DD/MM. Under 1400 characters.",
  ].join("\n");
}

// Attachments (photos of estimates, BOLs, PDFs) are read by the model directly.
const attachmentBlocks = (attachments) =>
  (attachments || []).map((a) =>
    a.media_type === "application/pdf"
      ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: a.data } }
      : { type: "image", source: { type: "base64", media_type: a.media_type, data: a.data } });

// ── The loop ─────────────────────────────────────────────────────────────────
async function runAgent({ text, history, attachments, draft, actor, canWrite }) {
  const system = await buildSystemPrompt({ actor, canWrite });
  const intro = [
    history.length ? `RECENT CONVERSATION: ${JSON.stringify(history.slice(-6))}` : "",
    // Show the previous proposal as prose, not JSON: pasting the old plan
    // structure back makes the model re-emit it almost verbatim instead of
    // rethinking, which reads to the user as "it ignores my correction".
    draft ? `YOU PREVIOUSLY PROPOSED (nothing was executed):\n${await describePlan(draft.plan)}\n\nThe message below is NOT a confirmation — the user is telling you to do it differently. Start over from their instruction: drop what they rejected, keep only what they still want, and follow the order and the destination they asked for, even if you would have done it another way. Never re-send the same plan; if what they ask is genuinely impossible, say why in one sentence instead of proposing the same thing again.` : "",
    attachments?.length ? "The user attached file(s) (estimate, BOL, screenshot…). Extract the data from them." : "",
    `MESSAGE: ${text || "(no text — see the attached file/s)"}`,
  ].filter(Boolean).join("\n");

  const messages = [{ role: "user", content: [...attachmentBlocks(attachments), { type: "text", text: intro }] }];
  const tools = canWrite ? [SQL_TOOL, PLAN_TOOL] : [SQL_TOOL];

  for (let turn = 0; turn < MAX_TURNS; turn++) {
    const msg = await client.messages.create({
      model: MODEL,
      max_tokens: 8000,
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      // The system block is stable per user; caching it keeps the schema dump
      // from being re-billed on every turn of the loop.
      system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
      tools,
      messages,
    });
    const toolUses = msg.content.filter((b) => b.type === "tool_use");
    if (!toolUses.length || msg.stop_reason !== "tool_use") {
      const answer = msg.content.filter((b) => b.type === "text").map((b) => b.text).join("").trim();
      return { reply: answer || "…" };
    }
    messages.push({ role: "assistant", content: msg.content });

    const results = [];
    for (const tu of toolUses) {
      if (tu.name === "sql") {
        let content, isError = false;
        try {
          const q = String(tu.input?.query || "");
          const denied = checkSqlAccess(q, actor.profile);
          if (denied) throw new Error(denied);
          const { data, error } = await admin.rpc("agent_query", { q });
          if (error) throw new Error(error.message);
          content = JSON.stringify(data);
          if (content.length > 14000) content = content.slice(0, 14000) + "…(truncado: refiná la consulta o usá agregados)";
        } catch (e) { content = `ERROR: ${e.message}`; isError = true; }
        results.push({ type: "tool_result", tool_use_id: tu.id, content, is_error: isError });
        continue;
      }
      // stage_plan
      const plan = { summary: tu.input?.summary || "", language: tu.input?.language || "es", operations: tu.input?.operations || [] };
      const errs = await validatePlan(plan, actor);
      if (errs.length) {
        results.push({ type: "tool_result", tool_use_id: tu.id, is_error: true, content: `El plan no pasó la validación:\n• ${errs.join("\n• ")}\nCorregilo y volvé a llamar stage_plan.` });
        continue;
      }
      const t = tr(plan.language);
      const body = `${plan.summary}\n\n${t.plan}\n${await describePlan(plan)}\n\n${t.confirm}`;
      return { reply: body, state: "pending_confirmation", pending: { plan, lang: plan.language, at: Date.now() } };
    }
    messages.push({ role: "user", content: results });
  }
  return { reply: "No llegué a cerrar la operación. Probá pedírmelo de forma más acotada." };
}

// ── Entry point ──────────────────────────────────────────────────────────────
// convoKey identifies the sender per channel ("app:email", "tg:123", "+549…").
// actor = { profile, userEmail } — the CRM user whose permissions apply.
export async function handleIncoming(convoKey, text, attachments = [], actor = {}) {
  const ctx = { profile: actor.profile || null, userEmail: actor.userEmail || actor.profile?.email || null };
  const canWrite = !!ctx.profile && writesEnabled();
  try {
    const { data: convo } = await admin.from("wa_conversations").select("*").eq("phone", convoKey).maybeSingle();
    const history = Array.isArray(convo?.history) ? convo.history : [];
    const pending = convo?.state === "pending_confirmation" ? convo?.pending_action : null;
    const stale = pending && Date.now() - (pending.at || 0) > PLAN_TTL_MS;

    let out; // { reply, state?, pending? }
    if (pending && !attachments.length && isConfirm(text)) {
      const t = tr(pending.lang);
      if (stale) out = { reply: t.expired };
      else {
        const res = await executePlan(pending.plan, ctx);
        out = { reply: res.ok
          ? `${t.done}\n${res.done.map((d) => `• ${d}`).join("\n")}`
          : `${t.partial}\n${res.done.map((d) => `• ${d}`).join("\n")}\n\n${res.error}` };
      }
    } else if (pending && !attachments.length && isCancel(text)) {
      out = { reply: tr(pending.lang).cancelled };
    } else if (!ctx.profile && /\b(carg|cre|actualiz|imput|borr|elimin|asign|arm[áa]|add|create|update|record|delete|assign)/i.test(text || "")) {
      // Unidentified caller asking for a write: explain how to link instead of failing later.
      out = { reply: writesEnabled() ? tr("es").notLinked : tr("es").readOnly };
    } else {
      out = await runAgent({ text, history, attachments, draft: stale ? null : pending, actor: ctx, canWrite });
    }

    const userLine = ((attachments.length ? `[${attachments.length} archivo(s)] ` : "") + (text || "")).trim();
    const newHistory = [...history, { role: "user", text: userLine }, { role: "assistant", text: out.reply }].slice(-HISTORY_MAX * 2);
    await admin.from("wa_conversations").upsert({
      phone: convoKey,
      state: out.state || "idle",
      pending_action: out.pending || null,
      history: newHistory,
      updated_at: new Date().toISOString(),
    }, { onConflict: "phone" });

    return String(out.reply).slice(0, REPLY_MAX + 600);
  } catch (e) {
    console.error("agent:", e);
    return "⚠️ Hubo un error procesando el mensaje / Something went wrong. Try again in a moment.";
  }
}
