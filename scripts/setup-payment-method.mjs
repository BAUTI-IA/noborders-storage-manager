#!/usr/bin/env node
// Migration: payment_method derived from raw_description on bank_transactions.
//
//   1. Ensures the payment_method column + an index for the Bandeja filter.
//   2. Backfills EVERY existing row with the rule table below (first match
//      wins). Validated against the real ledger (~5.670 movements, 99.7% land
//      on a non-Other bucket).
//
// The same rule table lives in JS as derivePaymentMethod() (src/bankData.js),
// which stamps payment_method on every future import — keep BOTH in sync.
// After running this, also re-run scripts/setup-bank-rpc.mjs so
// bank_txn_totals accepts the p_method filter the Bandeja sends.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-payment-method.mjs
// or paste the SQL in the Supabase SQL Editor. Re-runnable (it recomputes all
// rows, so tweaking a rule and re-running re-classifies the whole table).

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `alter table public.bank_transactions add column if not exists payment_method text;
create index if not exists bank_txn_payment_method on public.bank_transactions (payment_method);

UPDATE bank_transactions SET payment_method = CASE
  WHEN raw_description ILIKE '%zelle%' THEN 'Zelle'
  WHEN raw_description ILIKE '%venmo%' THEN 'Venmo'
  WHEN raw_description ILIKE '%cash app%' THEN 'Cash App'
  WHEN raw_description ILIKE '%apple cash%' THEN 'Apple Cash'
  WHEN raw_description ILIKE '%payment to chase card ending%' THEN 'Credit Card Payment'
  WHEN raw_description ~* '^\\s*check #?\\s*\\d' THEN 'Check'
  WHEN raw_description ILIKE '%remote online deposit%' OR raw_description ILIKE '%deposit id number%' OR raw_description ILIKE '%sbb mdeposit%' THEN 'Check'
  WHEN raw_description ILIKE '%fedwire%' OR raw_description ILIKE '%chips credit%' OR raw_description ILIKE '%wire transfer%' OR raw_description ILIKE '%domestic wire%' OR raw_description ILIKE '%book transfer%' OR raw_description ILIKE '%wire out%' THEN 'Wire Transfer'
  WHEN raw_description ILIKE '%real time transfer%' OR raw_description ILIKE '%rtp rcvd%' THEN 'RTP'
  WHEN raw_description ILIKE '%visa dda%' OR raw_description ILIKE '%pos debit%' OR raw_description ILIKE '%dda purchase%' OR raw_description ILIKE '%merch bnkcd%' OR raw_description ILIKE '%debit card%' OR raw_description ~ '\\(\\.\\.\\.\\d{4}\\)' THEN 'Card'
  WHEN raw_description ILIKE '%atm cash%' OR raw_description ILIKE '%cash deposit%' THEN 'Cash'
  WHEN raw_description ILIKE '%dda withdraw%' THEN 'ATM'
  WHEN raw_description ILIKE '%online transfer%' OR raw_description ILIKE '%xfer transfer%' OR raw_description ILIKE '%realtime transfer%' OR raw_description ILIKE '%transfer from chk%' OR raw_description ILIKE '%transfer to chk%' OR raw_description ILIKE '%transfer to chase%' THEN 'Online Transfer'
  WHEN raw_description ILIKE '%orig co name%' OR raw_description ILIKE '%ind name:%' OR raw_description ILIKE '%web pmts%' OR raw_description ILIKE '%sigonfile%' OR raw_description ILIKE '%ramp%' THEN 'ACH'
  WHEN raw_description ILIKE '%service charge%' OR raw_description ILIKE '%overdraft%' OR raw_description ILIKE '%monthly service%' OR raw_description ILIKE '%return fee%' OR raw_description ~* '\\yfee\\y' THEN 'Bank Fee'
  WHEN raw_description ILIKE '%adjustment%' THEN 'Adjustment'
  WHEN raw_description ~ '[A-Z]{2}\\s+\\d{2}/\\d{2}' OR raw_description ~ '\\d{2}/\\d{2}\\s*$' THEN 'Card'
  WHEN raw_description ILIKE 'deposit%' THEN 'Deposit'
  ELSE 'Other'
END;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-payment-method.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ payment_method backfilled en bank_transactions. Corré también scripts/setup-bank-rpc.mjs para que los tiles de la Bandeja filtren por método.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
