-- BOL field config (global) + fill-time text annotations.
-- Paste into the Supabase SQL editor and run (idempotent). Requires has_perm()
-- from setup-profiles and bol_documents from setup-bol-docs.

-- Single global row: which built-in mapping fields are hidden from the
-- template editor's dropdown, and user-defined custom fields.
create table if not exists public.bol_field_config (
  id            int primary key default 1 check (id = 1),  -- single row
  hidden_keys   jsonb not null default '[]'::jsonb,        -- ["rep","lot_number",...]
  custom_fields jsonb not null default '[]'::jsonb,        -- [{"k":"custom_po_number","l":"PO Number","fmt":""|"money"|"date"}]
  updated_at    timestamptz default now(),
  updated_by    text
);
alter table public.bol_field_config enable row level security;

drop policy if exists bol_field_config_sel on public.bol_field_config;
create policy bol_field_config_sel on public.bol_field_config for select to authenticated
  using ( public.has_perm('bol','view') );
drop policy if exists bol_field_config_ins on public.bol_field_config;
create policy bol_field_config_ins on public.bol_field_config for insert to authenticated
  with check ( public.has_perm('bol','edit') );
drop policy if exists bol_field_config_upd on public.bol_field_config;
create policy bol_field_config_upd on public.bol_field_config for update to authenticated
  using ( public.has_perm('bol','edit') ) with check ( public.has_perm('bol','edit') );

-- Free-text boxes the user places on a generated BOL (DocuSign-style).
alter table public.bol_documents
  add column if not exists annotations jsonb not null default '[]'::jsonb;
