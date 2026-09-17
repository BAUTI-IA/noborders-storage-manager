#!/usr/bin/env node
// One-time migration for the Pipeline (job reception → decision → dispatch):
//   · job_leads        — one row per incoming OPPORTUNITY, before it is a job.
//                        A lead is the thing being decided; job_evaluations is
//                        one pricing run for it, which is why they are separate
//                        tables joined by evaluation_id.
//   · pipeline_settings — singleton config row (jsonb, so adding a parameter
//                        later never needs another migration).
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API. Keep the SQL in sync with PIPELINE_SQL in src/pipeline.jsx.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// Re-running is safe (idempotent).

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs");
  process.exit(1);
}

const SQL = `
create table if not exists public.job_leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,

  -- Where it came from. raw_text is attacker-controlled when source='email':
  -- it is stored and displayed, never executed and never fed back as instructions.
  source text not null default 'manual' check (source in ('manual','email','whatsapp','telegram')),
  source_ref text,
  raw_text text,
  parsed jsonb,

  -- The job itself, as understood.
  broker_id bigint references public.brokers(id),
  broker_job_number text,
  customer text,
  origin_zip text, origin_city text, origin_state text,
  dest_zip text, dest_city text, dest_state text,
  cu_ft numeric,
  broker_price numeric,
  fadd date,
  pickup_date_from date,
  pickup_date_to date,
  delivery_date date,
  job_type text check (job_type in ('full','direct','broker_delivery')),

  -- The decision.
  status text not null default 'new' check (status in
    ('new','evaluating','proposed','accepted','held','offered','rejected','expired','converted')),
  hold_started_on date,
  remind_at date,          -- day 2: the reminder fires
  hold_until date,         -- day 7: a decision is due
  hold_reason text,
  reminder_sent_at timestamptz,
  escalated_at timestamptz,
  offered_to text,
  offered_rate numeric,
  offered_at timestamptz,
  reject_reason text,

  -- Links out. Nothing existing points back in, so dropping the Pipeline
  -- leaves every other table exactly as it is today.
  evaluation_id bigint references public.job_evaluations(id) on delete set null,
  job_id bigint references public.storage_jobs(id) on delete set null,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz,
  notes text
);

create index if not exists job_leads_status_idx on public.job_leads (status, created_at desc);
create index if not exists job_leads_clock_idx on public.job_leads (remind_at, hold_until) where status = 'held';
create index if not exists job_leads_job_idx on public.job_leads (job_id) where job_id is not null;

create table if not exists public.pipeline_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.pipeline_settings (id, settings) values (1, '{}'::jsonb) on conflict (id) do nothing;

-- Calibración automática. Un trip lleva varios jobs pero la evaluación coteja
-- cada uno como si fuera solo en el camión, así que una fila de viaje compartido
-- se registra igual (el operador la quiere ver) pero marcada: calibrate() la
-- saltea, porque promediarla enseñaría que todo sale más barato de lo que sale.
alter table public.job_evaluations add column if not exists actuals_shared boolean not null default false;
alter table public.job_evaluations add column if not exists actuals_source text;

alter table public.job_leads enable row level security;
alter table public.pipeline_settings enable row level security;

-- RLS follows the same per-section permission model as the rest of the CRM
-- (public.has_perm, from scripts/setup-profiles.mjs).
drop policy if exists "job_leads_select" on public.job_leads;
create policy "job_leads_select" on public.job_leads
  for select to authenticated using (public.has_perm('pipeline','view'));
drop policy if exists "job_leads_insert" on public.job_leads;
create policy "job_leads_insert" on public.job_leads
  for insert to authenticated with check (public.has_perm('pipeline','create'));
drop policy if exists "job_leads_update" on public.job_leads;
create policy "job_leads_update" on public.job_leads
  for update to authenticated
  using (public.has_perm('pipeline','edit')) with check (public.has_perm('pipeline','edit'));
drop policy if exists "job_leads_delete" on public.job_leads;
create policy "job_leads_delete" on public.job_leads
  for delete to authenticated using (public.is_admin());

drop policy if exists "pipeline_settings_select" on public.pipeline_settings;
create policy "pipeline_settings_select" on public.pipeline_settings
  for select to authenticated using (public.has_perm('pipeline','view'));
drop policy if exists "pipeline_settings_write" on public.pipeline_settings;
create policy "pipeline_settings_write" on public.pipeline_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());

do $$ begin alter publication supabase_realtime add table public.job_leads; exception when others then null; end $$;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ job_leads + pipeline_settings listas (RLS). La sección Pipeline ya funciona.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
