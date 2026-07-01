#!/usr/bin/env node
// Migration for BOL Phase 2 — saved BOL history (legal backup):
//  - public.bol_documents: one row per generated/saved BOL. Keeps a snapshot of
//    every value used (values jsonb) + the editable line items (line_items jsonb)
//    + the path to the filled PDF in the existing bol-generated bucket, so a
//    final BOL can always be re-opened, re-printed and searched by customer.
//  - RLS driven by the existing has_perm('bol', level) helper (run setup-profiles
//    and setup-bol first). Admins always pass.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bol-docs.mjs
//
// (If the Management API is unavailable, paste the SQL below into the Supabase
//  SQL editor — it is idempotent.)

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bol-docs.mjs");
  process.exit(1);
}

const SQL = `
create table if not exists public.bol_documents (
  id           bigint generated always as identity primary key,
  customer     text,
  job_id       bigint,
  job_number   text,
  template_id  bigint,
  company_name text,
  values       jsonb not null default '{}'::jsonb,  -- snapshot of every field used
  line_items   jsonb not null default '[]'::jsonb,  -- [{type:'cf'|'charge'|'discount',label,qty,rate,amount}]
  pdf_path     text,                                 -- path inside the bol-generated bucket
  status       text not null default 'final',        -- draft | final
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
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});
const text = await res.text();
if (res.ok) {
  console.log("✓ bol_documents + índices + RLS listos (bucket bol-generated se reutiliza).");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
