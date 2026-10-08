#!/usr/bin/env node
// One-time migration for the bank feed (Chase → Teller → Bancos) and the daily
// bank email (docs/bank-feed.md):
//
//   public.bank_feed_connections — one row per connected bank login, holding
//                                  Teller's access token. No RLS policy: only
//                                  the service role (api/bank-analyze.mjs)
//                                  reads it, never the browser or the agent.
//   public.bank_digest_settings  — who gets the email, its language, and the
//                                  last transaction already sent.
//   bank_accounts.feed_*         — which Teller account fills each CRM account,
//                                  from which date, and the bank's balance.
//
// The SQL lives in src/bankFeedData.js (BANK_FEED_SQL), which the Bancos
// setup banner also shows, so the two never drift apart. Re-runnable.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank-feed.mjs
//   node scripts/setup-bank-feed.mjs --sql   # print it to paste in the SQL Editor
import { BANK_FEED_SQL as SQL } from "../src/bankFeedData.js";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (process.argv.includes("--sql")) {
  console.log(SQL);
  process.exit(0);
}

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank-feed.mjs\nOr print the SQL to paste into Supabase:\n  node scripts/setup-bank-feed.mjs --sql");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Conexión bancaria lista (bank_feed_connections + bank_digest_settings + columnas feed_* en bank_accounts). Recargá Bancos → Cuentas.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
