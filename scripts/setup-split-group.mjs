#!/usr/bin/env node
// One-time migration: adds public.storage_jobs.split_group, the marker that lets
// a single job be split into portions that ride different trucks/trips (same
// job_number, each portion with its own CF and trip). Without this column the
// "✂️ Split" button stays hidden in the app.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-split-group.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Nothing else required.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `alter table public.storage_jobs add column if not exists split_group text;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-split-group.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ split_group lista. Recargá la app: el botón ✂️ Split ya aparece en los trips y en el detalle del job.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
