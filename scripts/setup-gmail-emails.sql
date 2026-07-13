-- Gmail sync — mails de las empresas de storage (Public Storage, Extra Space…).
-- Paste into the Supabase SQL editor and run (idempotent). Requires has_perm()
-- from setup-profiles. The sync endpoint (api/gmail-sync.mjs) writes with the
-- service role key; the UI only reads and updates status (approve/dismiss).

create table if not exists public.storage_emails (
  id               uuid primary key default gen_random_uuid(),
  gmail_message_id text not null unique,           -- idempotency key
  gmail_thread_id  text,
  from_address     text,
  subject          text,
  snippet          text,
  received_at      timestamptz,                    -- Gmail internalDate
  body_text        text,                           -- plain-text body, truncated
  brand            text,                           -- normalized from sender domain
  email_type       text,   -- rental_confirmation|payment_reminder|payment_receipt|rate_increase|lien_notice|other
  extracted        jsonb,                          -- validated JSON from Claude
  confidence       numeric,
  storage_id       bigint references public.storages(id) on delete set null,
  match_method     text,                           -- exact|fuzzy|none
  suggested_action text,                           -- set_due_date|create_unit|update_monthly_cost|flag_lien|none
  action_payload   jsonb,
  status           text not null default 'pending', -- pending|auto_applied|approved|dismissed|ignored|error
  applied_at       timestamptz,
  error            text,
  created_at       timestamptz default now()
);

create index if not exists storage_emails_status_idx   on public.storage_emails (status);
create index if not exists storage_emails_type_idx     on public.storage_emails (email_type);
create index if not exists storage_emails_received_idx on public.storage_emails (received_at desc);

-- Singleton row tracking the last successful sync.
create table if not exists public.gmail_sync_state (
  id                 int primary key default 1 check (id = 1),
  last_internal_date bigint,                       -- epoch ms of newest processed mail
  last_run_at        timestamptz,
  last_status        text,
  last_error         text
);
insert into public.gmail_sync_state (id) values (1) on conflict do nothing;

-- RLS: reads follow the storage section; status updates (approve/dismiss) need
-- edit on storage. Inserts only happen server-side via service role (bypasses RLS).
alter table public.storage_emails enable row level security;
drop policy if exists storage_emails_sel on public.storage_emails;
create policy storage_emails_sel on public.storage_emails for select to authenticated
  using ( public.has_perm('storage','view') );
drop policy if exists storage_emails_upd on public.storage_emails;
create policy storage_emails_upd on public.storage_emails for update to authenticated
  using ( public.has_perm('storage','edit') ) with check ( public.has_perm('storage','edit') );
drop policy if exists storage_emails_del on public.storage_emails;
create policy storage_emails_del on public.storage_emails for delete to authenticated
  using ( public.has_perm('storage','edit') );

alter table public.gmail_sync_state enable row level security;
drop policy if exists gmail_sync_state_sel on public.gmail_sync_state;
create policy gmail_sync_state_sel on public.gmail_sync_state for select to authenticated
  using ( public.has_perm('storage','view') );

-- Realtime for the Mails tab (safe to re-run; errors if already added are fine).
do $$ begin
  alter publication supabase_realtime add table public.storage_emails;
exception when duplicate_object then null;
end $$;
