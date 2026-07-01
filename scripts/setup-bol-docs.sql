-- BOL Phase 2 — saved BOL history (legal backup).
-- Paste into the Supabase SQL editor and run (idempotent). Requires has_perm()
-- from setup-profiles and the bol-generated bucket from setup-bol.
create table if not exists public.bol_documents (
  id           bigint generated always as identity primary key,
  customer     text,
  job_id       bigint,
  job_number   text,
  template_id  bigint,
  company_name text,
  values       jsonb not null default '{}'::jsonb,
  line_items   jsonb not null default '[]'::jsonb,
  pdf_path     text,
  status       text not null default 'final',
  created_by   text,
  created_at   timestamptz default now()
);
alter table public.bol_documents enable row level security;

create index if not exists bol_documents_customer_idx on public.bol_documents (lower(customer));
create index if not exists bol_documents_created_idx  on public.bol_documents (created_at desc);

drop policy if exists bol_documents_sel on public.bol_documents;
create policy bol_documents_sel on public.bol_documents for select to authenticated
  using ( public.has_perm('bol','view') );
drop policy if exists bol_documents_ins on public.bol_documents;
create policy bol_documents_ins on public.bol_documents for insert to authenticated
  with check ( public.has_perm('bol','create') );
drop policy if exists bol_documents_upd on public.bol_documents;
create policy bol_documents_upd on public.bol_documents for update to authenticated
  using ( public.has_perm('bol','edit') ) with check ( public.has_perm('bol','edit') );
drop policy if exists bol_documents_del on public.bol_documents;
create policy bol_documents_del on public.bol_documents for delete to authenticated
  using ( public.has_perm('bol','edit') );
