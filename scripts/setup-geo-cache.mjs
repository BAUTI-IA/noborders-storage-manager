#!/usr/bin/env node
// One-time migration: adds public.geo_cache, the address -> lat/lng cache the
// live-load map uses to plot scheduled jobs.
//
// Why it exists: storage_jobs stores addresses as text and nothing else, so
// every pin needs a geocode. Nominatim's usage policy caps us at one request
// per second, which makes an uncached map unusable (a hundred jobs would take
// minutes to draw, every single time). With this table an address is resolved
// once and then read back in bulk.
//
// The primary key is a customer's street address, so the read policy is gated on
// the sections that already see job addresses, and there is no write policy at
// all — RLS default-denies and only the service role writes. Deliberately absent
// from TABLE_ACL in lib/acl.mjs: scripts/setup-rls.mjs would generate ins/upd/del
// policies for it and hand write access to anyone with 'trips' edit rights.
//
// Rows with a null lat are confirmed misses — Nominatim looked and found
// nothing. They are cached too, so a bad address stops costing a request.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-geo-cache.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Nothing else required.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.geo_cache (
  q text primary key,
  lat numeric,
  lng numeric,
  label text,
  fetched_at timestamptz default now()
);
create index if not exists geo_cache_fetched_at_idx on public.geo_cache (fetched_at);
alter table public.geo_cache enable row level security;
drop policy if exists "geo_cache_read" on public.geo_cache;
create policy "geo_cache_read" on public.geo_cache
  for select to authenticated using (
    public.has_perm('trips','view') or public.has_perm('jobs','view')
    or public.has_perm('dispatching','view') or public.has_perm('calendario','view')
    or public.has_perm('calendario_entregas','view') or public.has_perm('jobcalc','view')
  );`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-geo-cache.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ geo_cache lista. Recargá la app y prendé 'Show scheduled jobs' en el mapa de Trips / Live Load.");
  console.log("  Para precargar las direcciones de una: node scripts/backfill-geo-cache.mjs --apply");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
