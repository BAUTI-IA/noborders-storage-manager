#!/usr/bin/env node
// One-time migration: creates the public.storage_jobs table used for tracking
// the history of jobs within each physical storage unit.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-storage-jobs.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Nothing else required.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.storage_jobs (
  id bigint generated always as identity primary key,
  storage_id bigint references public.storages(id) on delete cascade,
  job_number text,
  customer text,
  driver text,
  date_in date,
  date_out date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_jobs enable row level security;
drop policy if exists "storage_jobs_auth_all" on public.storage_jobs;
create policy "storage_jobs_auth_all" on public.storage_jobs
  for all to authenticated using (true) with check (true);
do $$ begin alter publication supabase_realtime add table public.storage_jobs; exception when others then null; end $$;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-storage-jobs.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ storage_jobs lista. Recargá la app: el historial de jobs ya está activo.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
