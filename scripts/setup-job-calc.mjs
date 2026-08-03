#!/usr/bin/env node
// One-time migration for the Job Decision Calculator:
//   · job_calc_settings — singleton config row (jsonb, so adding a parameter
//     later never needs another migration)
//   · job_evaluations   — one row per evaluated job: inputs, derived values,
//     the verdict, the settings snapshot used, and the actuals recorded after
//     the job runs (that is what feeds calibration)
//   · zip_distances / zip_geo — routed-miles cache, written by /api/distance
//     with the service role. Routes do not change, so entries never expire.
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API. Keep the SQL in sync with JOB_CALC_SQL in src/jobcalc.jsx.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-job-calc.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// Re-running is safe (idempotent).

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-job-calc.mjs");
  process.exit(1);
}

const SQL = `
create table if not exists public.job_calc_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.job_calc_settings (id, settings) values (1, '{}'::jsonb) on conflict (id) do nothing;

create table if not exists public.job_evaluations (
  id bigint generated always as identity primary key,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  label text,
  broker text,
  origin_zip text not null,
  dest_zip text not null,
  cu_ft numeric not null default 0,
  broker_price numeric not null default 0,
  origin_access text not null default 'direct' check (origin_access in ('direct','elevator','stairs')),
  dest_access text not null default 'direct' check (dest_access in ('direct','elevator','stairs')),
  long_carry boolean not null default false,
  shuttle boolean not null default false,
  loaded_miles numeric,
  deadhead_miles numeric,
  total_miles numeric,
  miles_manual boolean not null default false,
  handling_hours numeric,
  driving_hours numeric,
  truck_days numeric,
  truck_days_estimated numeric,
  truck_days_overridden boolean not null default false,
  hotel_nights numeric,
  variable_cost numeric,
  absorbed_fixed numeric,
  contribution_margin numeric,
  contribution_per_truck_day numeric,
  operating_margin numeric,
  breakeven_price numeric,
  hurdle_per_truck_day numeric,
  ask_price numeric,
  verdict text check (verdict in ('red','yellow','green')),
  reason text,
  decision text not null default 'pending' check (decision in ('pending','accepted','rejected')),
  settings_snapshot jsonb,
  actual_truck_days numeric,
  actual_hotel_nights numeric,
  actual_fuel numeric,
  actual_tolls numeric,
  actual_materials numeric,
  actual_extra_labor numeric,
  actual_miles numeric,
  actuals_at timestamptz,
  notes text
);
create index if not exists job_evaluations_created_idx on public.job_evaluations (created_at desc);
create index if not exists job_evaluations_actuals_idx on public.job_evaluations (actuals_at) where actuals_at is not null;

-- Crew sizing, added after the first release. Rows created before it default to
-- the baseline 1 driver + 1 helper, which is exactly how they were priced.
alter table public.job_evaluations add column if not exists drivers smallint not null default 1;
alter table public.job_evaluations add column if not exists helpers smallint not null default 1;
alter table public.job_evaluations add column if not exists hotel_rooms smallint;

create table if not exists public.zip_distances (
  origin_zip text not null,
  dest_zip text not null,
  miles numeric not null,
  provider text,
  fetched_at timestamptz not null default now(),
  primary key (origin_zip, dest_zip)
);
create table if not exists public.zip_geo (
  zip text primary key,
  lat numeric not null,
  lng numeric not null,
  fetched_at timestamptz not null default now()
);

alter table public.job_calc_settings enable row level security;
alter table public.job_evaluations enable row level security;
alter table public.zip_distances enable row level security;
alter table public.zip_geo enable row level security;

-- RLS follows the same per-section permission model as the rest of the CRM
-- (public.has_perm, from scripts/setup-profiles.mjs), so the sidebar gating over
-- the company's whole cost model is actually enforced and not just cosmetic.
drop policy if exists "job_calc_settings_select" on public.job_calc_settings;
create policy "job_calc_settings_select" on public.job_calc_settings
  for select to authenticated using (public.has_perm('jobcalc','view'));
drop policy if exists "job_calc_settings_write" on public.job_calc_settings;
create policy "job_calc_settings_write" on public.job_calc_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

drop policy if exists "job_evaluations_select" on public.job_evaluations;
create policy "job_evaluations_select" on public.job_evaluations
  for select to authenticated using (public.has_perm('jobcalc','view'));
drop policy if exists "job_evaluations_insert" on public.job_evaluations;
create policy "job_evaluations_insert" on public.job_evaluations
  for insert to authenticated with check (created_by = auth.uid() and public.has_perm('jobcalc','create'));
drop policy if exists "job_evaluations_update" on public.job_evaluations;
create policy "job_evaluations_update" on public.job_evaluations
  for update to authenticated
  using ((created_by = auth.uid() or public.is_admin()) and public.has_perm('jobcalc','edit'))
  with check ((created_by = auth.uid() or public.is_admin()) and public.has_perm('jobcalc','edit'));
drop policy if exists "job_evaluations_delete" on public.job_evaluations;
create policy "job_evaluations_delete" on public.job_evaluations
  for delete to authenticated using ((created_by = auth.uid() or public.is_admin()) and public.has_perm('jobcalc','edit'));

-- The miles cache is read by anyone who can see the calculator, and written only
-- by /api/distance, which uses the service role and bypasses RLS.
drop policy if exists "zip_distances_select" on public.zip_distances;
create policy "zip_distances_select" on public.zip_distances
  for select to authenticated using (public.has_perm('jobcalc','view'));
drop policy if exists "zip_geo_select" on public.zip_geo;
create policy "zip_geo_select" on public.zip_geo
  for select to authenticated using (public.has_perm('jobcalc','view'));

do $$ begin alter publication supabase_realtime add table public.job_evaluations; exception when others then null; end $$;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ job_calc_settings + job_evaluations + zip_distances + zip_geo listas (RLS). La solapa Job Calculator ya funciona.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
