#!/usr/bin/env node
// One-time migration for the Undo/Redo + soft-delete feature:
//   1. Adds a nullable `deleted_at timestamptz` column to every table the UI
//      can delete from (soft delete — rows stay in the DB, hidden from views).
//   2. Creates the `public.action_log` audit table (one row per mutation:
//      entity, id, before/after JSON, user, timestamp, undo batch id).
//
// The migration is purely ADDITIVE and reversible: it never drops, rewrites or
// deletes anything. To roll back: drop table action_log; alter table X drop
// column deleted_at; (data is untouched either way).
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API like the other setup scripts.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-undo.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const TABLES = [
  "storages", "storage_jobs", "payments", "job_extras", "expenses",
  "claims", "claim_notes", "brokers", "drivers", "trucks", "companies",
  "compliance_documents", "closing_sheets", "equipment_items", "employees",
  "material_items", "material_movements", "driver_work_days",
  "driver_adjustments", "trips", "trip_stops", "job_events", "payment_accounts",
];

const SQL = `
${TABLES.map((t) => `alter table if exists public.${t} add column if not exists deleted_at timestamptz;`).join("\n")}

create table if not exists public.action_log (
  id bigint generated always as identity primary key,
  batch_id text,
  entity text not null,
  entity_id text,
  action text not null,          -- create | update | delete | restore | undo | redo
  label text,
  before jsonb,
  after jsonb,
  user_email text,
  created_at timestamptz default now()
);
create index if not exists action_log_batch_idx on public.action_log (batch_id);
create index if not exists action_log_created_idx on public.action_log (created_at desc);
alter table public.action_log enable row level security;
do $$ begin
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'action_log' and policyname = 'action_log_all') then
    create policy action_log_all on public.action_log for all to authenticated using (true) with check (true);
  end if;
end $$;
`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Get one at https://supabase.com/dashboard/account/tokens");
  console.error("\nOr run this SQL by hand in the Supabase SQL Editor:\n");
  console.log(SQL);
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});
const body = await res.text();
if (!res.ok) {
  console.error(`Migration failed (${res.status}):`, body);
  process.exit(1);
}
console.log("✓ Undo/soft-delete migration applied:", TABLES.length, "tables + action_log");
