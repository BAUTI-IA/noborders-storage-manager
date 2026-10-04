#!/usr/bin/env node
// One-time migration for the Customer Line (docs/customer-line.md):
//   · customer_line_sessions — per-call verification state (service role only)
//   · customer_line_events   — audit trail + failed-verification counter
//   · customer_requests      — change requests and callbacks for dispatch
//
// The SQL lives in scripts/setup-customer-line.sql (paste it in the Supabase
// SQL Editor if you prefer); this script just sends that same file.
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-customer-line.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// Re-running is safe (idempotent).
import { readFileSync } from "node:fs";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-customer-line.mjs");
  process.exit(1);
}

const SQL = readFileSync(new URL("./setup-customer-line.sql", import.meta.url), "utf8");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Customer Line lista: customer_line_sessions, customer_line_events y customer_requests.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
