#!/usr/bin/env node
// One-time migration for the Carriers module (dispatching jobs to outside
// carriers, their inbox and the balance with each one — docs/carrier-dispatch.md).
//
// The SQL lives in lib/carriersSql.mjs, which the in-app setup banner also
// reads, so the two never drift apart. Re-runnable.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-carriers.mjs
//   node scripts/setup-carriers.mjs --sql   # print it to paste in the SQL Editor
//
// Get a token at: https://supabase.com/dashboard/account/tokens
import { CARRIERS_SQL as SQL } from "../lib/carriersSql.mjs";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (process.argv.includes("--sql")) {
  console.log(SQL);
  process.exit(0);
}

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-carriers.mjs\nOr print the SQL to paste into Supabase:\n  node scripts/setup-carriers.mjs --sql");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ carriers, carrier_dispatches, carrier_messages, carrier_payments, carrier_adjustments + bucket carrier-docs (privado). La sección Carriers ya funciona.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
