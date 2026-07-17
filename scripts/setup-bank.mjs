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
  `insert into public.bank_categories (name, direction, pnl_group, is_transfer, icon, sort)
  select ${sq(c.name)}, ${sq(c.direction)}, ${sq(c.pnl_group)}, ${c.is_transfer ? "true" : "false"}, ${sq(c.icon)}, ${c.sort}
  where not exists (select 1 from public.bank_categories where lower(name) = lower(${sq(c.name)}));`
).join("\n");

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
alter table public.bank_categories enable row level security;
drop policy if exists "bank_categories_all" on public.bank_categories;
create policy "bank_categories_all" on public.bank_categories for all to anon, authenticated using (true) with check (true);
${CATEGORY_SEED_SQL}

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

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank.mjs");
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
