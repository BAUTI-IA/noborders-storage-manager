#!/usr/bin/env node
// One-time migration: creates the Bancos module — the real bank ledger the owner
// uses to reconcile "lo que realmente se bancariza" against operational data.
//
//   public.bank_accounts       — the company's own bank accounts (USD)
//   public.bank_categories     — editable chart of accounts, seeded with the
//                                EXACT taxonomy of the bookkeeper's Bank Flows
//                                Excel (concepts + the Type/P&L grouping)
//   public.bank_import_batches — audit of each upload (screenshot set or CSV)
//   public.bank_transactions   — one row per real statement line, with a
//                                categorize→verify double-check state machine and
//                                links to the payment/expense it reconciles to
//   storage bucket bank-screenshots — homebanking screenshots read by the vision
//                                endpoint (api/bank-analyze.mjs)
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank.mjs
//   node scripts/setup-bank.mjs --sql --gaap   # print the gaap_category
//                                              # migration to paste by hand
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// If scripts/setup-rls.mjs was already applied, re-run it afterwards so the
// bank tables get per-section has_perm policies too. The script is re-runnable.

import { SEED_BANK_CATEGORIES } from "../src/bankData.js";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const sq = (v) => v == null ? "null" : `'${String(v).replace(/'/g, "''")}'`;
// One insert per seed category, idempotent by name.
const CATEGORY_SEED_SQL = SEED_BANK_CATEGORIES.map(c =>
  `insert into public.bank_categories (name, direction, pnl_group, gaap_category, is_transfer, icon, sort)
  select ${sq(c.name)}, ${sq(c.direction)}, ${sq(c.pnl_group)}, ${sq(c.gaap_category)}, ${c.is_transfer ? "true" : "false"}, ${sq(c.icon)}, ${c.sort}
  where not exists (select 1 from public.bank_categories where lower(name) = lower(${sq(c.name)}));`
).join("\n");

// Existing installs: the inserts above are no-ops (the categories already
// exist), so backfill gaap_category on whatever is already there. Only rows
// with NO classification yet are touched — anything a person already picked is
// left alone, so this stays re-runnable and never overwrites a human decision.
//
// One statement, evaluated top-down: the named exceptions first (where the
// accountant's lens genuinely differs from the bookkeeper's Type column), then
// a generic rule derived from the taxonomy the row already has, which also
// covers categories the owner added himself and any future one.
const GAAP_EXCEPTIONS = [
  ["Refund", "Other Income"],                             // money coming back, not a sale
  ["Returned Deposit", "Other Income"],
  ["Commissions", "Selling & Marketing Expense"],         // cost of booking the job, not of doing it
  ["Loren Expenses", "Owner's Equity (Draw / Contribution)"],  // equity, not an operating expense
  ["Bauti Expenses", "Owner's Equity (Draw / Contribution)"],
  ["Taxes", "Income Tax Expense"],
  ["Fines", "Other Expense"],
  // Financing moves the balance sheet, not the P&L. Without these the generic
  // rule below would read an incoming loan as Revenue, which is plainly wrong:
  // borrowed money is a liability, not a sale.
  ["Financing", "Loan Principal (not P&L)"],
  ["Financing - Loan", "Loan Principal (not P&L)"],
  ["Financing - Capital", "Owner's Equity (Draw / Contribution)"],
  ["Credit Card Payment", "Transfer / Not in P&L"],       // paying the card, not the expense itself
];
const GAAP_BACKFILL_SQL = `update public.bank_categories set gaap_category = case
${GAAP_EXCEPTIONS.map(([name, gaap]) => `    when lower(name) = lower(${sq(name)}) then ${sq(gaap)}`).join("\n")}
    when is_transfer then 'Transfer / Not in P&L'
    when direction = 'in' then 'Revenue'
    when pnl_group in ('Cost of Revenues', 'Production Expenses', 'Broker') then 'Cost of Goods Sold'
    when pnl_group = 'Sales & Marketing Expenses' then 'Selling & Marketing Expense'
    when pnl_group = 'Structure Expenses' then 'General & Administrative Expense'
    when pnl_group = 'CapEx' then 'Fixed Asset (CapEx)'
    else null
  end
where gaap_category is null or gaap_category = '';`;

const SQL = `create table if not exists public.bank_accounts (
  id bigint generated always as identity primary key,
  name text,
  bank_name text,
  account_last4 text,
  type text default 'checking',
  currency text default 'USD',
  active boolean default true,
  opening_balance numeric default 0,
  opening_date date,
  notes text,
  created_at timestamptz default now()
);
alter table public.bank_accounts enable row level security;
drop policy if exists "bank_accounts_all" on public.bank_accounts;
create policy "bank_accounts_all" on public.bank_accounts for all to anon, authenticated using (true) with check (true);

-- Seed the company's real accounts (the ones in the bookkeeper's Excel).
insert into public.bank_accounts (name, bank_name, type)
  select v.name, v.bank_name, v.type from (values
    ('Chase Bank', 'Chase', 'checking'),
    ('American Express 41004 (Platinum)', 'American Express', 'credit_card'),
    ('American Express 51002 (Delta)', 'American Express', 'credit_card')
  ) as v(name, bank_name, type)
  where not exists (select 1 from public.bank_accounts b where lower(b.name) = lower(v.name));
-- Plus any free-text bank_account labels already used across payments/expenses
-- so the ledger bridges to existing data by matching on name.
insert into public.bank_accounts (name)
  select distinct trim(v) from (
    select bank_account as v from public.payments where coalesce(trim(bank_account), '') <> ''
    union
    select bank_account as v from public.expenses where coalesce(trim(bank_account), '') <> ''
  ) t
  where not exists (select 1 from public.bank_accounts b where lower(b.name) = lower(trim(t.v)));

-- Editable chart of accounts (seeded below with the Excel taxonomy; the owner
-- can add/rename/deactivate categories from the UI — renames cascade-update
-- bank_transactions.category, which stores the NAME).
create table if not exists public.bank_categories (
  id bigint generated always as identity primary key,
  name text,
  direction text,
  pnl_group text,
  is_transfer boolean default false,
  icon text,
  active boolean default true,
  sort int,
  created_at timestamptz default now()
);
-- Second lens on the same category: where the accountant posts it on a standard
-- income statement. Purely descriptive — no P&L math reads it.
alter table public.bank_categories add column if not exists gaap_category text;
alter table public.bank_categories enable row level security;
drop policy if exists "bank_categories_all" on public.bank_categories;
create policy "bank_categories_all" on public.bank_categories for all to anon, authenticated using (true) with check (true);
${CATEGORY_SEED_SQL}
${GAAP_BACKFILL_SQL}

create table if not exists public.bank_import_batches (
  id bigint generated always as identity primary key,
  bank_account_id bigint references public.bank_accounts(id) on delete set null,
  source text,
  file_ref text,
  rows_extracted int,
  rows_imported int,
  created_by text,
  created_at timestamptz default now()
);
alter table public.bank_import_batches enable row level security;
drop policy if exists "bank_import_batches_all" on public.bank_import_batches;
create policy "bank_import_batches_all" on public.bank_import_batches for all to anon, authenticated using (true) with check (true);

create table if not exists public.bank_transactions (
  id bigint generated always as identity primary key,
  bank_account_id bigint references public.bank_accounts(id) on delete set null,
  import_batch_id bigint references public.bank_import_batches(id) on delete set null,
  txn_date date,
  operation_date date,
  accrual_date date,
  amount numeric,
  direction text,
  currency text default 'USD',
  raw_description text,
  counterparty text,
  supplier text,
  employee_name text,
  payment_method text,
  payment_method_id text,
  category text,
  subcategory text,
  status text default 'unreviewed',
  ai_suggested_category text,
  ai_confidence numeric,
  matched_payment_id bigint references public.payments(id) on delete set null,
  matched_expense_id bigint references public.expenses(id) on delete set null,
  match_status text default 'unmatched',
  source text,
  source_ref text,
  dedup_hash text,
  categorized_by text,
  categorized_at timestamptz,
  verified_by text,
  verified_at timestamptz,
  notes text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);
alter table public.bank_transactions enable row level security;
drop policy if exists "bank_transactions_all" on public.bank_transactions;
create policy "bank_transactions_all" on public.bank_transactions for all to anon, authenticated using (true) with check (true);
-- Re-uploading the same statement is idempotent: the dedup hash (account|date|amount|desc)
-- is unique, so duplicate lines are rejected on insert.
create unique index if not exists bank_txn_dedup on public.bank_transactions(dedup_hash);
-- Columns added in v2 (aligned with the bookkeeper's Excel) — for re-runs on a v1 install.
alter table public.bank_transactions add column if not exists operation_date date;
alter table public.bank_transactions add column if not exists accrual_date date;
alter table public.bank_transactions add column if not exists supplier text;
alter table public.bank_transactions add column if not exists employee_name text;
alter table public.bank_transactions add column if not exists payment_method text;
alter table public.bank_transactions add column if not exists payment_method_id text;

insert into storage.buckets (id, name, public)
  values ('bank-screenshots', 'bank-screenshots', true)
  on conflict (id) do update set public = true;
drop policy if exists "bankscreenshots_read" on storage.objects;
create policy "bankscreenshots_read" on storage.objects for select to anon, authenticated using (bucket_id = 'bank-screenshots');
drop policy if exists "bankscreenshots_write" on storage.objects;
create policy "bankscreenshots_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'bank-screenshots');
drop policy if exists "bankscreenshots_update" on storage.objects;
create policy "bankscreenshots_update" on storage.objects for update to anon, authenticated using (bucket_id = 'bank-screenshots');

do $$ begin alter publication supabase_realtime add table public.bank_accounts; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bank_categories; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bank_import_batches; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.bank_transactions; exception when others then null; end $$;`;

// `--sql` prints the migration instead of running it, so it can be pasted into
// the Supabase SQL Editor by someone who doesn't have a management token.
// `--gaap` narrows that to the gaap_category part alone, for a database where
// the rest of the Bancos module is already installed.
if (process.argv.includes("--sql")) {
  console.log(process.argv.includes("--gaap")
    ? `alter table public.bank_categories add column if not exists gaap_category text;\n\n${GAAP_BACKFILL_SQL}`
    : SQL);
  process.exit(0);
}

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank.mjs\nOr print the SQL to paste into Supabase:\n  node scripts/setup-bank.mjs --sql --gaap");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Bancos listo (bank_accounts + bank_categories con la taxonomía del Excel + bank_import_batches + bank_transactions + bucket bank-screenshots). Recargá la app y dales permisos de 'bancos' a los usuarios de oficina (re-corré setup-rls.mjs).");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
