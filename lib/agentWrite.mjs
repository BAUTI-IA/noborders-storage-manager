// The agent's write layer: validate → execute → audit.
//
// Everything the agent changes in the CRM goes through here, so that a single
// place enforces role permissions (the service-role client bypasses RLS),
// column/FK/enum sanity, soft-delete-only removals, and — critically — writes
// the same `action_log` rows the app's own undo system writes (src/undo.js), so
// agent actions show up in Trash/History and can be undone by a human.
//
// Operations come from the model as a plan of small, explicit steps:
//   { kind:"table",  op:"insert",      table, values }
//   { kind:"table",  op:"update",      table, ids:[...], values }
//   { kind:"table",  op:"soft_delete", table, ids:[...] }
//   { kind:"recipe", name, args }            // see lib/recipes.mjs
// Updates/deletes address rows by explicit id (the model must SELECT them
// first), which makes a runaway mass-update impossible by construction.
import { admin } from "./clients.mjs";
import { canRead, checkPermission, AGENT_DENY_TABLES, SOFT_DELETE_TABLES, TABLE_ACL } from "./acl.mjs";

// ── Read gating for the sql tool ─────────────────────────────────────────────
// agent_query is read-only but reads ANY table, including profiles (roles and
// permissions) and the team's private chat. Parse the statement's table
// references and gate them before running it.
export function referencedTables(sql) {
  const s = String(sql || "").toLowerCase();
  const ctes = new Set([...s.matchAll(/(?:\bwith|,)\s+(?:recursive\s+)?([a-z_]\w*)\s+as\s*\(/g)].map((m) => m[1]));
  return [...s.matchAll(/\b(?:from|join)\s+(?:only\s+)?(?:([a-z_]\w*)\.)?([a-z_]\w*)/g)]
    .map((m) => ({ schema: m[1] || "public", table: m[2] }))
    .filter((t) => !(t.schema === "public" && ctes.has(t.table)));
}

// Models routinely end a statement with a semicolon out of habit, and
// agent_query rejects any `;` at all (it is how it guarantees one statement).
// Dropping a single trailing one costs nothing — anything else still contains a
// `;` afterwards and is still refused — and saves a wasted round trip.
export const normalizeSql = (q) => String(q || "").trim().replace(/;\s*$/, "").trim();

// A model that asks for a table we don't have is usually one rename away from
// the right one ("jobs" -> "storage_jobs"). Saying so turns a dead end into a
// correction it can make on the next turn.
function nearestTables(table) {
  const known = Object.keys(TABLE_ACL);
  const hit = known.filter((k) => k.endsWith(`_${table}`) || k.startsWith(`${table}_`) || k.includes(table));
  return hit.slice(0, 3);
}

// -> null when the query may run, or a message explaining what it may not read.
export function checkSqlAccess(sql, profile) {
  for (const { schema, table } of referencedTables(sql)) {
    if (schema === "information_schema" || schema === "pg_catalog") continue;
    if (schema !== "public") return `no puedo leer el esquema "${schema}"`;
    if (AGENT_DENY_TABLES.has(table)) return `la tabla "${table}" es privada y no puedo consultarla`;
    // Unidentified callers (no linked CRM user) keep read access to the rest;
    // the channel whitelist is their outer gate. Identified ones get exactly
    // what their role allows in the app.
    if (profile && !canRead(profile, table)) {
      // Same refusal either way, but "you lack permission" is a lie when the
      // table simply isn't there, and it sends the model looking for an admin
      // instead of for the right table name.
      if (!TABLE_ACL[table]) {
        const near = nearestTables(table);
        return `la tabla "${table}" no existe en el CRM` + (near.length ? ` — ¿quisiste decir ${near.join(", ")}?` : "");
      }
      return `no tenés permiso para ver "${table}"`;
    }
  }
  return null;
}

export const writesEnabled = () => process.env.AGENT_WRITES_ENABLED !== "false";

export const MAX_OPS = 10;      // operations per plan
export const MAX_ROWS = 50;     // rows touched per operation

// Same shape as src/undo.js uid(): a client-generated batch id.
export const newBatchId = () => "b" + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ── Schema knowledge ─────────────────────────────────────────────────────────
// Column lists come from information_schema, aggregated one row per table to
// stay under agent_query's 200-row cap. Cached per warm lambda.
let colCache = { at: 0, map: null };
export async function tableColumns(table) {
  if (!colCache.map || Date.now() - colCache.at > 10 * 60 * 1000) {
    const { data, error } = await admin.rpc("agent_query", {
      q: "select table_name, string_agg(column_name, ',' order by ordinal_position) as cols from information_schema.columns where table_schema = 'public' group by table_name",
    });
    if (error) throw new Error(`no pude leer el esquema: ${error.message}`);
    colCache = { at: Date.now(), map: new Map(data.map((r) => [r.table_name, new Set(r.cols.split(","))])) };
  }
  return colCache.map.get(table) || null;
}

// FK conventions: column -> referenced table. Used to reject dangling references
// before they hit Postgres (naive inserts fail on FKs, not on NOT NULLs).
const FK_TARGETS = {
  job_id: "storage_jobs", broker_id: "brokers", driver_id: "drivers", truck_id: "trucks",
  trip_id: "trips", storage_id: "storages", closing_sheet_id: "closing_sheets",
  job_extra_id: "job_extras", item_id: "material_items", bank_account_id: "bank_accounts",
  import_batch_id: "bank_import_batches", employee_id: "employees", claim_id: "claims",
};

// Column value vocabularies enforced by the app in JS (no DB constraints).
const ENUMS = {
  "storage_jobs.status": ["scheduled", "picked_up", "in_storage", "out_for_delivery", "delivered", "on_hold"],
  "trips.status": ["loading", "in_transit", "completed", "cancelled"],
  "trip_stops.category": ["maintenance", "repair", "inspection", "scale", "fuel", "rest", "overnight", "equipment", "office", "other"],
  "payments.concept": ["job", "extra", "cc_fee", "storage", "on_account", "other"],
  "payments.method": ["cash", "credit_card", "zelle", "venmo", "check", "money_order", "paypal", "cashapp", "wire_transfer", "apple_pay"],
  "payments.check_type": ["cashiers_check", "personal_check", "official_check"],
  "payments.mo_type": ["usps", "western_union", "moneygram", "other"],
  "payments.payment_stage": ["", "pickup", "delivery", "other"],
  "expenses.category": ["fuel", "hotel", "materials", "tolls", "maintenance", "meals", "other"],
  "expenses.paid_from": ["bank", "driver_cash", "company_card", "other"],
  "expenses.status": ["pending", "approved", "rejected"],
  "storage_billing.status": ["pending", "overdue", "paid"],
  "closing_sheets.status": ["open", "settled", "disputed"],
  "claims.status": ["open", "investigating", "resolved", "denied"],
  "claims.incident_type": ["damage", "theft", "missing_items", "incomplete_delivery", "complaint", "other"],
  "driver_adjustments.kind": ["deduction", "bonus"],
  "material_movements.movement_type": ["purchase", "issue", "return", "consume", "adjust"],
  "job_extras.extra_type": ["extra_cf", "shuttle", "long_carry", "stairs", "packing", "flight_charge", "other"],
};

export const enumFor = (table, col) => ENUMS[`${table}.${col}`] || null;

// ── Validation ───────────────────────────────────────────────────────────────
// Returns [] when the operation is safe, or a list of human-readable problems
// (fed back to the model so it can fix the plan without bothering the user).
export async function validateOp(op, ctx) {
  const errs = [];
  if (op?.kind === "recipe") {
    const { RECIPES } = await import("./recipes.mjs");
    const recipe = RECIPES[op.name];
    if (!recipe) return [`receta desconocida: "${op.name}" (disponibles: ${Object.keys(RECIPES).join(", ")})`];
    for (const [table, kind] of recipe.perms || []) {
      const perm = checkPermission(ctx.profile, table, kind);
      if (!perm.ok) errs.push(`"${op.name}": ${perm.reason}`);
    }
    if (recipe.validate) errs.push(...(await recipe.validate(op.args || {}, ctx) || []));
    return errs;
  }
  if (op?.kind !== "table") return ["operación con `kind` inválido (usá \"table\" o \"recipe\")"];

  const { op: kind, table, values, ids } = op;
  if (!["insert", "update", "soft_delete"].includes(kind)) return [`op inválida: "${kind}"`];
  const perm = checkPermission(ctx.profile, table, kind);
  if (!perm.ok) return [perm.reason];

  const cols = await tableColumns(table);
  if (!cols) return [`la tabla "${table}" no existe`];

  if (kind === "insert" || kind === "update") {
    if (!values || typeof values !== "object" || !Object.keys(values).length) errs.push(`faltan valores para ${kind} en ${table}`);
    for (const [k, v] of Object.entries(values || {})) {
      if (k === "id") { errs.push(`no se puede escribir la columna id de ${table}`); continue; }
      if (k === "deleted_at") { errs.push(`no se puede tocar deleted_at directamente (usá soft_delete)`); continue; }
      if (!cols.has(k)) { errs.push(`${table} no tiene la columna "${k}"`); continue; }
      const allowed = enumFor(table, k);
      if (allowed && v != null && v !== "" && !allowed.includes(String(v))) {
        errs.push(`${table}.${k}="${v}" no es válido (opciones: ${allowed.join(", ")})`);
      }
      const fkTable = FK_TARGETS[k];
      if (fkTable && v != null && v !== "") {
        const { data } = await admin.from(fkTable).select("id").eq("id", v).is("deleted_at", null).maybeSingle();
        if (!data) errs.push(`${table}.${k}=${v} no apunta a ningún ${fkTable} activo`);
      }
    }
  }
  if (kind === "update" || kind === "soft_delete") {
    const list = Array.isArray(ids) ? ids : [];
    if (!list.length) errs.push(`${kind} en ${table} sin ids: primero buscá las filas con la tool sql`);
    if (list.length > MAX_ROWS) errs.push(`${kind} en ${table} afecta ${list.length} filas (máximo ${MAX_ROWS})`);
    if (kind === "soft_delete" && !SOFT_DELETE_TABLES.has(table)) errs.push(`"${table}" no admite borrado recuperable`);
  }
  return errs;
}

export async function validatePlan(plan, ctx) {
  const ops = Array.isArray(plan?.operations) ? plan.operations : [];
  if (!ops.length) return ["el plan no tiene operaciones"];
  if (ops.length > MAX_OPS) return [`el plan tiene ${ops.length} operaciones (máximo ${MAX_OPS}); dividilo en partes`];
  const errs = [];
  for (const [i, op] of ops.entries()) {
    for (const e of await validateOp(op, ctx)) errs.push(`Paso ${i + 1}: ${e}`);
  }
  return errs;
}

// ── Human-readable rendering ─────────────────────────────────────────────────
const fmtValues = (v) => Object.entries(v || {}).map(([k, x]) => `${k}=${x === null ? "—" : x}`).join(", ");

export async function describeOp(op) {
  if (op.kind === "recipe") {
    const { RECIPES } = await import("./recipes.mjs");
    const r = RECIPES[op.name];
    return r?.describe ? r.describe(op.args || {}) : `${op.name}(${fmtValues(op.args)})`;
  }
  const n = (op.ids || []).length;
  if (op.op === "insert") return `Crear en ${op.table}: ${fmtValues(op.values)}`;
  if (op.op === "update") return `Actualizar ${n} fila(s) de ${op.table} (#${(op.ids || []).join(", #")}): ${fmtValues(op.values)}`;
  return `Borrar (recuperable) ${n} fila(s) de ${op.table} (#${(op.ids || []).join(", #")})`;
}

export async function describePlan(plan) {
  const lines = [];
  for (const [i, op] of (plan.operations || []).entries()) lines.push(`${i + 1}. ${await describeOp(op)}`);
  return lines.join("\n");
}

// ── Execution primitives ─────────────────────────────────────────────────────
// Each returns audit entries in the same shape src/undo.js uses:
//   { table, id, action, before, after }
const nowISO = () => new Date().toISOString();

export async function execInsert(table, values, ctx) {
  const cols = await tableColumns(table);
  const row = { ...values };
  if (cols?.has("created_by") && !row.created_by) row.created_by = ctx.userEmail;
  const { data, error } = await admin.from(table).insert([row]).select("*").single();
  if (error) throw new Error(`insert en ${table}: ${error.message}`);
  return [{ table, id: data.id, action: "create", before: null, after: data }];
}

export async function execUpdate(table, ids, values, ctx) {
  const list = [...new Set(ids)].slice(0, MAX_ROWS);
  if (!list.length) return [];
  const cols = await tableColumns(table);
  const patch = { ...values };
  if (cols?.has("updated_by")) patch.updated_by = ctx.userEmail;
  if (cols?.has("updated_at")) patch.updated_at = nowISO();
  // before-image, narrowed to the columns being changed (src/undo.js updateEntry)
  const { data: prev } = await admin.from(table).select("*").in("id", list);
  const { error } = await admin.from(table).update(patch).in("id", list);
  if (error) throw new Error(`update en ${table}: ${error.message}`);
  return (prev || []).map((p) => ({
    table, id: p.id, action: "update",
    before: Object.fromEntries(Object.keys(patch).map((k) => [k, p[k] ?? null])),
    after: patch,
  }));
}

export async function execSoftDelete(table, ids, ctx) {
  if (!SOFT_DELETE_TABLES.has(table)) throw new Error(`"${table}" no admite borrado recuperable`);
  const list = [...new Set(ids)].slice(0, MAX_ROWS);
  const { data: prev } = await admin.from(table).select("*").in("id", list).is("deleted_at", null);
  const rowIds = (prev || []).map((r) => r.id);
  if (!rowIds.length) return [];
  const { error } = await admin.from(table).update({ deleted_at: nowISO() }).in("id", rowIds);
  if (error) throw new Error(`borrado en ${table}: ${error.message}`);
  return (prev || []).map((p) => ({ table, id: p.id, action: "delete", before: p, after: null }));
}

// ── Audit ────────────────────────────────────────────────────────────────────
export async function writeAuditLog(entries, { label, userEmail, batchId }) {
  if (!entries.length) return;
  const rows = entries.map((e) => ({
    batch_id: batchId, entity: e.table, entity_id: String(e.id), action: e.action,
    label, before: e.before ?? null, after: e.after ?? null,
    user_email: userEmail ? `${userEmail} (agente)` : "agente",
  }));
  const { error } = await admin.from("action_log").insert(rows);
  if (error) console.error("action_log:", error.message); // never block the operation on audit failure
}

// ── Plan execution ───────────────────────────────────────────────────────────
// No transactions over PostgREST: run steps in order, stop at the first
// failure, and audit whatever landed so a human can undo it from the CRM.
export async function executePlan(plan, ctx) {
  if (!writesEnabled()) throw new Error("las escrituras del agente están desactivadas (AGENT_WRITES_ENABLED=false)");
  const errs = await validatePlan(plan, ctx); // re-validate: state may have changed since the proposal
  if (errs.length) throw new Error(`el plan ya no es válido:\n• ${errs.join("\n• ")}`);

  const batchId = newBatchId();
  const label = (plan.summary || "Acción del agente").slice(0, 200);
  const entries = [];
  const done = [];
  try {
    for (const op of plan.operations) {
      if (op.kind === "recipe") {
        const { RECIPES } = await import("./recipes.mjs");
        const res = await RECIPES[op.name].run(op.args || {}, ctx);
        entries.push(...(res.entries || []));
        done.push(res.summary || (await describeOp(op)));
      } else if (op.op === "insert") {
        entries.push(...(await execInsert(op.table, op.values, ctx)));
        done.push(await describeOp(op));
      } else if (op.op === "update") {
        entries.push(...(await execUpdate(op.table, op.ids, op.values, ctx)));
        done.push(await describeOp(op));
      } else if (op.op === "soft_delete") {
        entries.push(...(await execSoftDelete(op.table, op.ids, ctx)));
        done.push(await describeOp(op));
      }
    }
    await writeAuditLog(entries, { label, userEmail: ctx.userEmail, batchId });
    return { ok: true, done, count: entries.length };
  } catch (e) {
    await writeAuditLog(entries, { label: `${label} (incompleto)`, userEmail: ctx.userEmail, batchId });
    return { ok: false, done, error: e.message, count: entries.length };
  }
}
