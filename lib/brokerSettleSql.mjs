// One-time migration for closing balances with brokers (docs/broker-settlements.md).
//
//   broker_payments            — what each broker paid us (or we paid them), and
//                                how it was spread over closing sheets
//                                (allocations: [{ sheet_id, amount }]).
//   brokers.default_*          — the usual rate per CF and pad charge, to pre-fill
//                                a new broker job.
//   closing_sheets.document_path — the broker's paper in the private bucket.
//   storage settlement-docs    — PRIVATE bucket for closing sheets brokers send.
//
// RLS follows lib/acl.mjs (scripts/setup-rls.mjs writes the same policies).
// Shared by scripts/setup-broker-settle.mjs and the in-app banner. Idempotent.
import { TABLE_ACL } from "./acl.mjs";

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

export const BROKER_SETTLE_SQL = `
create table if not exists public.broker_payments (
  id bigint generated always as identity primary key,
  broker_id bigint not null references public.brokers(id),
  direction text not null default 'in' check (direction in ('in','out')),   -- in: the broker paid us
  amount numeric not null check (amount > 0),
  method text,
  paid_date date not null default current_date,
  reference text,
  notes text,
  allocations jsonb not null default '[]'::jsonb,                           -- [{ sheet_id, amount }]
  created_at timestamptz not null default now(),
  created_by text,
  updated_at timestamptz,
  updated_by text,
  deleted_at timestamptz
);
create index if not exists broker_payments_broker_idx on public.broker_payments (broker_id, paid_date);
${policies("broker_payments")}

alter table public.brokers add column if not exists default_rate_per_cf numeric;
alter table public.brokers add column if not exists default_charge_per_pad numeric;
alter table public.closing_sheets add column if not exists document_path text;

insert into storage.buckets (id, name, public) values ('settlement-docs','settlement-docs', false)
  on conflict (id) do update set public = false;
drop policy if exists settlement_docs_sel on storage.objects;
create policy settlement_docs_sel on storage.objects for select to authenticated
  using ( bucket_id = 'settlement-docs' and public.has_perm('settlements','view') );
drop policy if exists settlement_docs_ins on storage.objects;
create policy settlement_docs_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'settlement-docs' and public.has_perm('settlements','create') );
drop policy if exists settlement_docs_upd on storage.objects;
create policy settlement_docs_upd on storage.objects for update to authenticated
  using ( bucket_id = 'settlement-docs' and public.has_perm('settlements','edit') );
drop policy if exists settlement_docs_del on storage.objects;
create policy settlement_docs_del on storage.objects for delete to authenticated
  using ( bucket_id = 'settlement-docs' and public.has_perm('settlements','edit') );
`;
