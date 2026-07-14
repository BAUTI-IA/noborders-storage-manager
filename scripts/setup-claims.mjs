#!/usr/bin/env node
// One-time migration: creates the Claims & Incidents module — the public.claims
// table (customer claims per job: damage, theft, missing items…), the
// public.claim_notes follow-up timeline, and the claim-docs storage bucket for
// evidence photos/documents.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-claims.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// If scripts/setup-rls.mjs was already applied, re-run it afterwards so the
// claims tables get per-section has_perm policies too.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.claims (
  id bigint generated always as identity primary key,
  job_number text,
  trip_id bigint,
  client_name text,
  incident_type text,
  description text,
  incident_date date,
  status text default 'open',
  assigned_to text,
  claimed_amount numeric,
  paid_amount numeric,
  resolution_type text,
  closed_date date,
  attachments jsonb default '[]'::jsonb,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);
alter table public.claims enable row level security;
drop policy if exists "claims_all" on public.claims;
create policy "claims_all" on public.claims for all to anon, authenticated using (true) with check (true);

create table if not exists public.claim_notes (
  id bigint generated always as identity primary key,
  claim_id bigint references public.claims(id) on delete cascade,
  note text,
  created_by text,
  created_at timestamptz default now()
);
alter table public.claim_notes enable row level security;
drop policy if exists "claim_notes_all" on public.claim_notes;
create policy "claim_notes_all" on public.claim_notes for all to anon, authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
  values ('claim-docs', 'claim-docs', true)
  on conflict (id) do update set public = true;
drop policy if exists "claimdocs_read" on storage.objects;
create policy "claimdocs_read" on storage.objects for select to anon, authenticated using (bucket_id = 'claim-docs');
drop policy if exists "claimdocs_write" on storage.objects;
create policy "claimdocs_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'claim-docs');
drop policy if exists "claimdocs_update" on storage.objects;
create policy "claimdocs_update" on storage.objects for update to anon, authenticated using (bucket_id = 'claim-docs');

do $$ begin alter publication supabase_realtime add table public.claims; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.claim_notes; exception when others then null; end $$;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-claims.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Claims & Incidents listo (claims + claim_notes + bucket claim-docs). Recargá la app.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
