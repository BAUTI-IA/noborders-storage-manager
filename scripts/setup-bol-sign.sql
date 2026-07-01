-- BOL Fase 4 — firma con DocuSign (pickup + delivery) sobre el mismo BOL.
-- Idempotente. Pegar en el SQL editor de Supabase y correr.

-- 1) Columnas de firma en bol_documents (un registro guarda ambas firmas)
alter table public.bol_documents
  add column if not exists sign_status text default 'unsigned',
  add column if not exists pickup_envelope_id   text,
  add column if not exists pickup_signed_path   text,
  add column if not exists pickup_signed_at     timestamptz,
  add column if not exists delivery_envelope_id text,
  add column if not exists delivery_signed_path text,
  add column if not exists delivery_signed_at   timestamptz;

create index if not exists bol_documents_pickup_env_idx   on public.bol_documents (pickup_envelope_id);
create index if not exists bol_documents_delivery_env_idx on public.bol_documents (delivery_envelope_id);

-- 2) Bucket privado para las copias firmadas (documento legal → no público)
insert into storage.buckets (id, name, public) values ('bol-signed','bol-signed', false)
  on conflict (id) do nothing;

-- Usuarios con acceso BOL pueden leer/escribir; el webhook usa service role (bypass RLS)
drop policy if exists bol_signed_sel on storage.objects;
create policy bol_signed_sel on storage.objects for select to authenticated
  using ( bucket_id = 'bol-signed' and public.has_perm('bol','view') );
drop policy if exists bol_signed_ins on storage.objects;
create policy bol_signed_ins on storage.objects for insert to authenticated
  with check ( bucket_id = 'bol-signed' and public.has_perm('bol','create') );
drop policy if exists bol_signed_upd on storage.objects;
create policy bol_signed_upd on storage.objects for update to authenticated
  using ( bucket_id = 'bol-signed' and public.has_perm('bol','edit') );
drop policy if exists bol_signed_del on storage.objects;
create policy bol_signed_del on storage.objects for delete to authenticated
  using ( bucket_id = 'bol-signed' and public.has_perm('bol','edit') );
