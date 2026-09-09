#!/usr/bin/env node
// One-time fix: send back to the review queue the bank transactions that were
// verified AUTOMATICALLY by the old master-CSV import.
//
// That import (src/bank.jsx → confirmMasterImport) used to insert rows straight
// as status='verified', stamping categorized_by and verified_by with the SAME
// user and the SAME timestamp — so the categorize→verify double-check never
// happened for them. The import no longer does that (rows now enter as
// 'unreviewed'), but the rows already loaded keep the bogus stamps.
//
// The auto-stamp signature is what we key on, so a row somebody genuinely
// re-reviewed by hand afterwards (two different people, two different times) is
// LEFT ALONE:
//     source = 'csv_reload'
//     and status = 'verified'
//     and verified_by is not distinct from categorized_by
//     and verified_at = categorized_at
//
// The category coming from the bookkeeper's file is KEPT as a pre-fill; only
// the status and the stamps are cleared.
//
// ⚠ These rows drop out of the P&L until someone verifies them again: bank_pnl
// runs with p_only_verified = true by default. Check the count with the dry run
// before applying.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/reset-auto-verified.mjs           # dry run, only counts
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/reset-auto-verified.mjs --apply   # applies it
// or paste the SQL in the Supabase SQL Editor. Re-runnable.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const APPLY = process.argv.includes("--apply");

const WHERE = `source = 'csv_reload'
    and status = 'verified'
    and verified_by is not distinct from categorized_by
    and verified_at = categorized_at`;

const DRY_SQL = `select count(*) as rows_to_reset,
       min(txn_date) as first_date,
       max(txn_date) as last_date,
       count(*) filter (where category is null or category = '') as without_category
from public.bank_transactions
where ${WHERE};`;

const APPLY_SQL = `update public.bank_transactions
set status = 'unreviewed',
    categorized_by = null, categorized_at = null,
    verified_by = null, verified_at = null
where ${WHERE};`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/reset-auto-verified.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: APPLY ? APPLY_SQL : DRY_SQL }),
});

const text = await res.text();
if (!res.ok) {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}

if (APPLY) {
  console.log("✓ Movimientos auto-verificados devueltos a la bandeja como 'unreviewed'. Hay que categorizarlos y verificarlos a mano (dos personas distintas).");
  console.log("  Ojo: salen del P&L hasta que se verifiquen de nuevo.");
} else {
  console.log("Dry run (no se modificó nada):");
  console.log(text);
  console.log("\nSi el número te cierra, corré de nuevo con --apply.");
}
