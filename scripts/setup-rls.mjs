#!/usr/bin/env node
// Replaces the permissive (using(true)) RLS policies on every CRM table with
// per-section policies driven by public.has_perm(section, level). Run AFTER
// scripts/setup-profiles.mjs (which creates the has_perm/is_admin helpers).
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-rls.mjs
//
// Model (intentionally coarser than the UI gating, because most tables feed
// several CRM sections):
//   * SELECT  -> allowed if the user has `view` on ANY section that surfaces the table.
//   * INSERT  -> allowed if the user has `create` on the table's owning section.
//   * UPDATE  -> allowed if the user has `edit`   on the table's owning section.
//   * DELETE  -> allowed if the user has `edit`   on the table's owning section.
//   * Admins always pass (is_admin() short-circuits inside has_perm()).
// The `anon` role is removed everywhere: nothing is readable without a session.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-rls.mjs");
  process.exit(1);
}

// table -> { view: [sections that read it], owner: section that governs writes }
const MAP = {
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
  payments:             { view: ["payments", "analytics"], owner: "payments" },
  payment_accounts:     { view: ["payments"], owner: "payments" },
  companies:            { view: ["compliance"], owner: "compliance" },
  compliance_documents: { view: ["compliance"], owner: "compliance" },
  claims:               { view: ["claims", "trips", "jobs"], owner: "claims" },
  // Adding a follow-up note to an existing claim is an edit-level action, not a create-level one.
  claim_notes:          { view: ["claims"], owner: "claims", insertLevel: "edit" },
  // Expenses module (run scripts/setup-expenses.mjs first, then re-run this script).
  expenses:             { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  driver_work_days:     { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  driver_adjustments:   { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  material_items:       { view: ["expenses", "drivers", "analytics"], owner: "expenses" },
  // Logging a movement against the ledger is an edit-level action, not a create-level one.
  material_movements:   { view: ["expenses", "drivers", "analytics"], owner: "expenses", insertLevel: "edit" },
};

function policiesFor(table, { view, owner, insertLevel = "create" }) {
  const viewExpr = view.map((s) => `public.has_perm('${s}','view')`).join(" or ");
  return `
-- ${table}
alter table public.${table} enable row level security;
drop policy if exists "${table}_all" on public.${table};
drop policy if exists "${table}_auth_all" on public.${table};
drop policy if exists ${table}_sel on public.${table};
drop policy if exists ${table}_ins on public.${table};
drop policy if exists ${table}_upd on public.${table};
drop policy if exists ${table}_del on public.${table};
create policy ${table}_sel on public.${table} for select to authenticated
  using ( ${viewExpr} );
create policy ${table}_ins on public.${table} for insert to authenticated
  with check ( public.has_perm('${owner}','${insertLevel}') );
create policy ${table}_upd on public.${table} for update to authenticated
  using ( public.has_perm('${owner}','edit') ) with check ( public.has_perm('${owner}','edit') );
create policy ${table}_del on public.${table} for delete to authenticated
  using ( public.has_perm('${owner}','edit') );`;
}

const SQL = Object.entries(MAP).map(([t, cfg]) => policiesFor(t, cfg)).join("\n");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log(`✓ RLS por sección aplicada a ${Object.keys(MAP).length} tablas. El acceso anónimo quedó deshabilitado.`);
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
