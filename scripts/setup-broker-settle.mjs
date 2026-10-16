#!/usr/bin/env node
// One-time migration for closing balances with brokers: broker_payments, the
// brokers' default rate and pad charge, and the private settlement-docs bucket
// (docs/broker-settlements.md). The SQL lives in lib/brokerSettleSql.mjs, which
// the in-app banner also shows. Re-runnable.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-broker-settle.mjs
//   node scripts/setup-broker-settle.mjs --sql   # print it to paste in the SQL Editor
import { BROKER_SETTLE_SQL as SQL } from "../lib/brokerSettleSql.mjs";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (process.argv.includes("--sql")) {
  console.log(SQL);
  process.exit(0);
}

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-broker-settle.mjs\nOr print the SQL to paste into Supabase:\n  node scripts/setup-broker-settle.mjs --sql");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ broker_payments, valores por defecto de brokers y bucket settlement-docs (privado) listos.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
