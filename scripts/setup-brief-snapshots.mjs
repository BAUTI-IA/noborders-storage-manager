#!/usr/bin/env node
// One-time migration: creates public.brief_snapshots, the daily photo of the
// ops-brief metrics used to show day-over-day deltas ("deuda ↓ $12k vs ayer").
// Only the service role touches it (RLS on, no policies).
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-brief-snapshots.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.brief_snapshots (
  id bigint generated always as identity primary key,
  snapshot_date date not null unique,
  deuda_real numeric,
  balances_sin_depurar numeric,
  fadd_overdue int,
  storage_leaks int,
  storage_leak_monthly numeric,
  claims_activos int,
  data jsonb,
  created_at timestamptz default now()
);
alter table public.brief_snapshots enable row level security;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-brief-snapshots.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ brief_snapshots lista. El brief ya puede comparar contra el día anterior.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
