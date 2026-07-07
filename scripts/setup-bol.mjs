#!/usr/bin/env node
// One-time migration for the BOL (Bill of Lading) generator:
//  - public.bol_templates: one row per company, holds the uploaded template PDF
//    path + the field map (where each datum is stamped).
//  - storage buckets bol-templates (original PDFs) and bol-generated (filled PDFs).
//  - RLS driven by the existing has_perm('bol', level) helper (run setup-profiles
//    first). Admins always pass.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bol.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bol.mjs");
  process.exit(1);
}

const SQL = `
create table if not exists public.bol_templates (
  id          bigint generated always as identity primary key,
  company_name text not null,
  pdf_path    text,                          -- path inside the bol-templates bucket
  page_count  int default 1,
  field_map   jsonb not null default '[]'::jsonb,  -- [{id,page,x,y,w,h,source,label,fontSize,align}]
  status      text not null default 'draft', -- draft | active
  created_at  timestamptz default now(),
  created_by  text
);
alter table public.bol_templates enable row level security;

drop policy if exists bol_templates_sel on public.bol_templates;
create policy bol_templates_sel on public.bol_templates for select to authenticated
  using ( public.has_perm('bol','view') );
drop policy if exists bol_templates_ins on public.bol_templates;
create policy bol_templates_ins on public.bol_templates for insert to authenticated
  with check ( public.has_perm('bol','create') );
drop policy if exists bol_templates_upd on public.bol_templates;
create policy bol_templates_upd on public.bol_templates for update to authenticated
  using ( public.has_perm('bol','edit') ) with check ( public.has_perm('bol','edit') );
drop policy if exists bol_templates_del on public.bol_templates;
create policy bol_templates_del on public.bol_templates for delete to authenticated
  using ( public.has_perm('bol','edit') );

-- Storage buckets for the original templates and the generated BOLs.
-- PRIVATE: generated BOLs carry the client's full PII; the app opens them via
-- short-lived signed URLs, never public links.
insert into storage.buckets (id, name, public) values ('bol-templates','bol-templates', false) on conflict (id) do nothing;
insert into storage.buckets (id, name, public) values ('bol-generated','bol-generated', false) on conflict (id) do nothing;
update storage.buckets set public = false where id in ('bol-templates','bol-generated');

-- Authenticated users with BOL access can read/write objects in those buckets.
drop policy if exists bol_objs_sel on storage.objects;
create policy bol_objs_sel on storage.objects for select to authenticated
  using ( bucket_id in ('bol-templates','bol-generated') and public.has_perm('bol','view') );
drop policy if exists bol_objs_ins on storage.objects;
create policy bol_objs_ins on storage.objects for insert to authenticated
  with check ( bucket_id in ('bol-templates','bol-generated') and public.has_perm('bol','create') );
drop policy if exists bol_objs_upd on storage.objects;
create policy bol_objs_upd on storage.objects for update to authenticated
  using ( bucket_id in ('bol-templates','bol-generated') and public.has_perm('bol','edit') );
drop policy if exists bol_objs_del on storage.objects;
create policy bol_objs_del on storage.objects for delete to authenticated
  using ( bucket_id in ('bol-templates','bol-generated') and public.has_perm('bol','edit') );
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});
const text = await res.text();
if (res.ok) {
  console.log("✓ bol_templates + buckets (bol-templates, bol-generated) + RLS listos.");
  console.log("  Dale permiso 'bol' a tu usuario admin (ya lo tenés por ser admin).");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
