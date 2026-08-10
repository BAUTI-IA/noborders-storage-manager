// Single source of truth for "which CRM section governs which table", shared by
// the RLS policy generator (scripts/setup-rls.mjs) and the AI agent's write
// layer (lib/agentWrite.mjs). The service-role client bypasses RLS, so the
// agent must enforce these permissions itself, in code.
//
// Model (intentionally coarser than the UI gating, because most tables feed
// several CRM sections):
//   * SELECT -> allowed if the user has `view` on ANY section that surfaces the table.
//   * INSERT -> `create` on the owning section (or `insertLevel` when set).
//   * UPDATE -> `edit` on the owning section.
//   * DELETE -> `delete` on the owning section (soft delete only).
//   * Admins always pass.

// table -> { view: [sections that read it], owner: section that governs writes }
export const TABLE_ACL = {
  storages:             { view: ["storage", "jobs", "dispatching", "calendario", "calendario_entregas", "billing"], owner: "storage" },
  storage_jobs:         { view: ["jobs", "dispatching", "calendario", "calendario_entregas", "storage", "billing", "brokers", "settlements", "clientes"], owner: "jobs" },
  job_events:           { view: ["dispatching", "jobs"], owner: "dispatching" },
  brokers:              { view: ["brokers"], owner: "brokers" },
  storage_billing:      { view: ["billing"], owner: "billing" },
  closing_sheets:       { view: ["settlements"], owner: "settlements" },
  job_extras:           { view: ["extras", "payments", "analytics"], owner: "extras" },
  employees:            { view: ["extras", "settings", "drivers"], owner: "settings" },
  drivers:              { view: ["drivers", "dispatching", "jobs"], owner: "drivers" },
  trucks:               { view: ["trucks", "trips"], owner: "trucks" },
  trip_events:          { view: ["trips", "trucks"], owner: "trips" },
  trips:                { view: ["trips"], owner: "trips" },
  trip_stops:           { view: ["trips"], owner: "trips" },
  payments:             { view: ["payments", "analytics"], owner: "payments" },
  payment_accounts:     { view: ["payments"], owner: "payments" },
  companies:            { view: ["compliance"], owner: "compliance" },
  compliance_documents: { view: ["compliance"], owner: "compliance" },
  claims:               { view: ["claims", "trips", "jobs"], owner: "claims" },
  // Adding a follow-up note to an existing claim is an edit-level action, not a create-level one.
  claim_notes:          { view: ["claims"], owner: "claims", insertLevel: "edit" },
  equipment_items:      { view: ["equipment", "trips"], owner: "equipment" },
  // Expenses module.
  expenses:             { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  driver_work_days:     { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  driver_adjustments:   { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  material_items:       { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  // Logging a movement against the ledger is an edit-level action, not a create-level one.
  material_movements:   { view: ["expenses", "drivers", "analytics"], owner: "expenses", insertLevel: "edit" },
  // Bancos module.
  bank_accounts:        { view: ["bancos", "payments"], owner: "bancos" },
  bank_categories:      { view: ["bancos"], owner: "bancos" },
  bank_import_batches:  { view: ["bancos"], owner: "bancos" },
  bank_transactions:    { view: ["bancos", "analytics"], owner: "bancos" },
};

// Tables the agent may never write, whatever the caller's role: identity and
// permissions (privilege escalation), its own audit trail and state, the team's
// private chat, and derived/lookup caches.
export const AGENT_DENY_TABLES = new Set([
  "profiles", "action_log", "wa_conversations", "brief_snapshots",
  "chat_channels", "chat_channel_members", "chat_messages", "chat_presence",
  "zip_distances", "zip_geo", "job_calc_settings", "suggestion_votes",
]);

// Soft-delete capable tables (scripts/setup-undo.mjs). Deleting anything else
// would be irreversible, so the agent refuses.
export const SOFT_DELETE_TABLES = new Set([
  "storages", "storage_jobs", "payments", "job_extras", "expenses", "claims",
  "claim_notes", "brokers", "drivers", "trucks", "companies", "compliance_documents",
  "closing_sheets", "equipment_items", "employees", "material_items",
  "material_movements", "driver_work_days", "driver_adjustments", "trips",
  "trip_stops", "job_events", "payment_accounts",
]);

export const isAdmin = (profile) => profile?.role === "admin";

// Level needed for each operation on a table.
export function requiredLevel(table, op) {
  const acl = TABLE_ACL[table];
  if (!acl) return null;
  if (op === "insert") return acl.insertLevel || "create";
  if (op === "update") return "edit";
  if (op === "soft_delete") return "delete";
  return "view";
}

// -> { ok: true } | { ok: false, reason, section, level }
export function checkPermission(profile, table, op) {
  if (AGENT_DENY_TABLES.has(table)) {
    return { ok: false, reason: `la tabla "${table}" está fuera del alcance del agente` };
  }
  const acl = TABLE_ACL[table];
  if (!acl) return { ok: false, reason: `tabla desconocida: "${table}"` };
  if (op === "soft_delete" && !SOFT_DELETE_TABLES.has(table)) {
    return { ok: false, reason: `"${table}" no admite borrado recuperable; hay que hacerlo manualmente en el CRM` };
  }
  if (!profile) return { ok: false, reason: "no puedo identificar al usuario que pide la operación" };
  if (isAdmin(profile)) return { ok: true };
  const level = requiredLevel(table, op);
  const section = acl.owner;
  const granted = !!profile?.permissions?.[section]?.[level];
  if (!granted) return { ok: false, reason: `no tenés permiso de "${level}" en la sección "${section}"`, section, level };
  return { ok: true };
}

// Can this profile read the table at all? (any section that surfaces it)
export function canRead(profile, table) {
  if (AGENT_DENY_TABLES.has(table)) return false;
  const acl = TABLE_ACL[table];
  if (!acl) return false;
  if (isAdmin(profile)) return true;
  return acl.view.some((s) => !!profile?.permissions?.[s]?.view);
}
