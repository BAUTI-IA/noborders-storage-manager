// The Carriers module's one-time migration (docs/carrier-dispatch.md).
//
//   carriers             — the outside carriers we hand jobs to.
//   carrier_dispatches   — one job given to one carrier at an agreed rate.
//   carrier_messages     — every mail/WhatsApp to and from a carrier: the
//                          outbox the Apps Script sends, and the inbox it feeds
//                          (with what the AI read from the attachments).
//   carrier_payments     — settlements, both ways.
//   carrier_adjustments  — signed corrections (claims, damages, pads…).
//   storage carrier-docs — PRIVATE bucket: rate confirmations and the documents
//                          carriers send back. Never public, never anon.
//
// RLS uses the same per-section model as every other table (lib/acl.mjs →
// scripts/setup-rls.mjs), so re-running setup-rls later rewrites these same
// policies identically. Shared by scripts/setup-carriers.mjs and the in-app
// setup banner. Idempotent.
import { TABLE_ACL } from "./acl.mjs";

export const CARRIER_TABLES = ["carriers", "carrier_dispatches", "carrier_messages", "carrier_payments", "carrier_adjustments"];

const audit = `
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz,
  updated_by text,
  deleted_at timestamptz`;

function policies(table) {
  const { view, owner, insertLevel = "create" } = TABLE_ACL[table];
  const viewExpr = view.map((s) => `public.has_perm('${s}','view')`).join(" or ");
  return `
alter table public.${table} enable row level security;
drop policy if exists ${table}_sel on public.${table};
drop policy if exists ${table}_ins on public.${table};
drop policy if exists ${table}_upd on public.${table};
drop policy if exists ${table}_del on public.${table};
create policy ${table}_sel on public.${table} for select to authenticated using ( ${viewExpr} );
create policy ${table}_ins on public.${table} for insert to authenticated with check ( public.has_perm('${owner}','${insertLevel}') );
create policy ${table}_upd on public.${table} for update to authenticated
  using ( public.has_perm('${owner}','edit') ) with check ( public.has_perm('${owner}','edit') );
create policy ${table}_del on public.${table} for delete to authenticated using ( public.has_perm('${owner}','edit') );
do $$ begin alter publication supabase_realtime add table public.${table}; exception when others then null; end $$;`;
}

export const CARRIERS_SQL = `
create table if not exists public.carriers (
  id bigint generated always as identity primary key,
  name text not null,
  legal_name text,
  mc_number text,
  dot_number text,
  contact_name text,
  email text,                      -- one or more, comma separated: how replies are recognized
  whatsapp text,
  phone text,
  insurance_expires date,          -- expired blocks new dispatches
  default_rate_per_cf numeric,
  payment_terms text,
  language text not null default 'en',
  notes text,
  active boolean not null default true,${audit}
);

create table if not exists public.carrier_dispatches (
  id bigint generated always as identity primary key,
  job_number text not null,
  job_id bigint references public.storage_jobs(id) on delete set null,
  carrier_id bigint not null references public.carriers(id),
  status text not null default 'sent'
    check (status in ('sent','accepted','in_progress','docs_received','verified','disputed','cancelled')),
  channel text not null default 'email' check (channel in ('email','whatsapp','both')),
  rate_type text not null default 'per_cf' check (rate_type in ('per_cf','flat')),
  rate_per_cf numeric,
  flat_rate numeric,
  est_cf numeric,
  final_cf numeric,
  carrier_extras numeric not null default 0,
  expected_collect numeric not null default 0,   -- what the carrier must collect from the customer
  collected numeric,                             -- what it did collect (from the documents)
  collected_method text,
  due_date date,                                 -- FADD / delivery date, for the docs-overdue alert
  sent_at timestamptz,
  accepted_at timestamptz,
  delivered_on date,
  verified_at timestamptz,
  verified_by text,
  ratecon_path text,                             -- carrier-docs/ratecons/…
  notes text,                                    -- printed on the rate confirmation
  internal_notes text,${audit}
);
create index if not exists carrier_dispatches_carrier_idx on public.carrier_dispatches (carrier_id, status);
-- One live dispatch per job: re-dispatching means cancelling the old one first.
create unique index if not exists carrier_dispatches_one_live
  on public.carrier_dispatches (lower(job_number)) where deleted_at is null and status <> 'cancelled';

create table if not exists public.carrier_messages (
  id bigint generated always as identity primary key,
  dispatch_id bigint references public.carrier_dispatches(id) on delete set null,
  carrier_id bigint references public.carriers(id) on delete set null,
  direction text not null check (direction in ('in','out')),
  channel text not null default 'email' check (channel in ('email','whatsapp')),
  status text not null check (status in
    ('queued','sent','failed','logged','receiving','review','unmatched','ignored','applied','rejected')),
  from_addr text,
  to_addr text,
  subject text,
  body_text text,                  -- inbound text is untrusted: shown, never executed
  body_html text,
  gmail_message_id text,
  gmail_thread_id text,
  attachments jsonb not null default '[]'::jsonb,
  extraction jsonb,                -- what the AI read; a proposal until someone approves it
  match_method text,
  error text,
  sent_at timestamptz,
  received_at timestamptz,
  reviewed_by text,
  reviewed_at timestamptz,${audit}
);
create unique index if not exists carrier_messages_gmail_uidx
  on public.carrier_messages (gmail_message_id) where gmail_message_id is not null;
create index if not exists carrier_messages_queue_idx
  on public.carrier_messages (created_at) where direction = 'out' and status = 'queued';
create index if not exists carrier_messages_dispatch_idx on public.carrier_messages (dispatch_id);

create table if not exists public.carrier_payments (
  id bigint generated always as identity primary key,
  carrier_id bigint not null references public.carriers(id),
  direction text not null check (direction in ('in','out')),   -- in: the carrier paid us
  amount numeric not null check (amount > 0),
  method text,
  paid_date date not null default current_date,
  reference text,
  notes text,${audit}
);

create table if not exists public.carrier_adjustments (
  id bigint generated always as identity primary key,
  carrier_id bigint not null references public.carriers(id),
  dispatch_id bigint references public.carrier_dispatches(id) on delete set null,
  amount numeric not null,         -- > 0 the carrier owes us more (a claim on them)
  reason text,
  adj_date date not null default current_date,
  notes text,${audit}
);
${CARRIER_TABLES.map(policies).join("\n")}

insert into storage.buckets (id, name, public) values ('carrier-docs','carrier-docs', false)
  on conflict (id) do update set public = false;
drop policy if exists carrier_docs_sel on storage.objects;
create policy carrier_docs_sel on storage.objects for select to authenticated
  using ( bucket_id = 'carrier-docs' and public.has_perm('carriers','view') );
drop policy if exists carrier_docs_ins on storage.objects;
create policy carrier_docs_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'carrier-docs' and public.has_perm('carriers','create') );
drop policy if exists carrier_docs_upd on storage.objects;
create policy carrier_docs_upd on storage.objects for update to authenticated
  using ( bucket_id = 'carrier-docs' and public.has_perm('carriers','edit') );
drop policy if exists carrier_docs_del on storage.objects;
create policy carrier_docs_del on storage.objects for delete to authenticated
  using ( bucket_id = 'carrier-docs' and public.has_perm('carriers','edit') );
`;
