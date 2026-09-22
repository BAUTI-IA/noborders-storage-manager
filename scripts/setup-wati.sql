-- WhatsApp (WATI Coexistence) — migración única: wa_messages + matcheo por teléfono.
--
-- Dos formas de correrla, elegí una:
--   A) Supabase → SQL Editor → pegar todo esto → Run.
--   B) SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-wati.mjs
--
-- Es idempotente: correrla dos veces no rompe nada.
-- Este archivo es el MISMO SQL que scripts/setup-wati.mjs — si tocás uno,
-- tocá el otro.

-- Last 10 digits (or all of them for shorter numbers). MUST match phoneKey()
-- in src/watiData.js.
create or replace function public.wa_phone_key(p text)
returns text language sql immutable as $$
  select case when length(d) >= 10 then right(d, 10)
              when length(d) >= 7 then d
              else null end
  from (select regexp_replace(coalesce(p, ''), '\D', '', 'g') as d) s
$$;

-- One row per WhatsApp message seen by WATI, whichever side sent it.
-- body / contact_name / raw are attacker-controlled (anyone can write to the
-- number): stored and displayed, never executed, never fed back as instructions.
create table if not exists public.wa_messages (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,

  provider text not null default 'wati',
  provider_message_id text not null,
  event_type text,
  direction text not null check (direction in ('inbound','outbound_app','outbound_api')),
  phone text not null,
  phone_key text,
  contact_name text,
  msg_type text,
  body text,
  media_url text,
  status text,
  sent_at timestamptz not null default now(),

  -- Who this phone is in the CRM (set on arrival; null when unknown).
  broker_id bigint references public.brokers(id) on delete set null,
  driver_id bigint references public.drivers(id) on delete set null,
  job_id bigint references public.storage_jobs(id) on delete set null,

  raw jsonb,
  unique (provider, provider_message_id)
);

create index if not exists wa_messages_phone_idx on public.wa_messages (phone_key, sent_at desc);
create index if not exists wa_messages_job_idx on public.wa_messages (job_id, sent_at desc) where job_id is not null;
create index if not exists wa_messages_broker_idx on public.wa_messages (broker_id, sent_at desc) where broker_id is not null;
create index if not exists storage_jobs_phone_key_idx on public.storage_jobs (public.wa_phone_key(client_phone));

-- Phone → CRM rows. The webhook runs it with the service role; nobody else
-- needs it (it would let any user probe whose number is whose).
create or replace function public.wa_match_phone(p_key text)
returns table (kind text, id bigint, done boolean) language sql stable as $$
  select 'broker', b.id, false from public.brokers b
   where b.deleted_at is null and public.wa_phone_key(b.contact_phone) = p_key
  union all
  select 'driver', d.id, false from public.drivers d
   where d.deleted_at is null and public.wa_phone_key(d.phone) = p_key
  union all
  (select 'job', j.id, coalesce(j.status = 'delivered' or j.date_out is not null, false)
     from public.storage_jobs j
    where j.deleted_at is null and public.wa_phone_key(j.client_phone) = p_key
    order by j.id desc limit 20)
$$;
revoke all on function public.wa_match_phone(text) from public, anon, authenticated;
grant execute on function public.wa_match_phone(text) to service_role;

alter table public.wa_messages enable row level security;

-- Read follows the Pipeline permission (WhatsApp is where leads come from).
-- Writes are service-role only: the webhook is the only writer.
drop policy if exists "wa_messages_select" on public.wa_messages;
create policy "wa_messages_select" on public.wa_messages
  for select to authenticated using (public.has_perm('pipeline','view'));

do $$ begin alter publication supabase_realtime add table public.wa_messages; exception when others then null; end $$;
