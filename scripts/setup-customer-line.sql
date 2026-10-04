-- Customer Line — migración única (docs/customer-line.md).
--
-- Dos formas de correrla, elegí una:
--   A) Supabase → SQL Editor → pegar todo esto → Run.
--   B) SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-customer-line.mjs
--
-- Es idempotente: correrla dos veces no rompe nada. Requiere public.has_perm()
-- (scripts/setup-profiles.mjs), igual que las políticas de setup-rls.

-- One row per call. Verification and the pending read-back live here, keyed by
-- the platform's conversation id — never in the model's hands.
create table if not exists public.customer_line_sessions (
  conversation_id text primary key,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  job_key text,
  job_number text,           -- the job this call verified (null until then)
  verified_at timestamptz,
  verified_by text,          -- which factor matched: zip | phone_last4
  failed_attempts integer not null default 0,
  locked_at timestamptz,     -- too many failures: no more attempts on this call
  staged jsonb,              -- change request read back, waiting for a "yes"
  staged_at timestamptz,
  last_request_id bigint,
  last_request_at timestamptz
);
-- RLS on, no policies: only the service role (the endpoint) can touch it.
alter table public.customer_line_sessions enable row level security;

-- Audit trail: one row per tool call outcome. Also what the per-job lockout
-- counts (failed verifications for a job number across calls).
create table if not exists public.customer_line_events (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  conversation_id text,
  tool text not null,
  outcome text not null,     -- verified | verify_failed | job_locked | staged | submitted | callback
  job_ref text,              -- normalized job number (what the caller said, or the verified job)
  detail jsonb
);
create index if not exists customer_line_events_job_idx on public.customer_line_events (job_ref, outcome, created_at desc);
create index if not exists customer_line_events_conv_idx on public.customer_line_events (conversation_id, created_at);
alter table public.customer_line_events enable row level security;

-- What callers asked for. The line only inserts; dispatch works them.
create table if not exists public.customer_requests (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  source text not null default 'customer_line',
  conversation_id text,
  kind text not null check (kind in ('change','callback')),
  topic text,
  urgency text not null default 'normal' check (urgency in ('normal','urgent')),
  job_number text,           -- set only when the caller VERIFIED it
  verified boolean not null default false,
  claimed_job_number text,   -- what an unverified caller said: not proof of anything
  caller_name text,
  callback_phone text,
  best_time text,
  details text,
  preferred_date date,
  status text not null default 'open' check (status in ('open','in_progress','done','dismissed')),
  handled_by text,
  handled_at timestamptz,
  notes text
);
create index if not exists customer_requests_status_idx on public.customer_requests (status, created_at desc);
create index if not exists customer_requests_conv_idx on public.customer_requests (conversation_id, kind, topic);

-- Same shape setup-rls.mjs generates from lib/acl.mjs (TABLE_ACL.customer_requests).
alter table public.customer_requests enable row level security;
drop policy if exists customer_requests_sel on public.customer_requests;
drop policy if exists customer_requests_ins on public.customer_requests;
drop policy if exists customer_requests_upd on public.customer_requests;
drop policy if exists customer_requests_del on public.customer_requests;
create policy customer_requests_sel on public.customer_requests for select to authenticated
  using ( public.has_perm('dispatching','view') or public.has_perm('jobs','view') );
create policy customer_requests_ins on public.customer_requests for insert to authenticated
  with check ( public.has_perm('dispatching','create') );
create policy customer_requests_upd on public.customer_requests for update to authenticated
  using ( public.has_perm('dispatching','edit') ) with check ( public.has_perm('dispatching','edit') );
create policy customer_requests_del on public.customer_requests for delete to authenticated
  using ( public.has_perm('dispatching','edit') );

do $$ begin alter publication supabase_realtime add table public.customer_requests; exception when others then null; end $$;
