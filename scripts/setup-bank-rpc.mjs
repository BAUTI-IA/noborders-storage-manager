#!/usr/bin/env node
// Migration: server-side aggregation for the Bancos module. The front used to
// fetch bank_transactions with a fixed limit (2000) and compute the P&L and
// totals in JS — with ~5.600 movements that silently truncated January–May.
// These RPCs move every aggregate to Postgres so no row limit applies:
//
//   bank_pnl(p_from, p_to, p_account_id, p_only_verified)
//     → month × category totals (excludes transfers + 'Financing'), the P&L input.
//   bank_txn_totals(p_from, p_to, p_account_id, p_status, p_category, p_search)
//     → inflows/outflows/count for the Bandeja tiles under the active filters.
//   bank_account_balances()
//     → per-account signed sum + count for the Cuentas tab.
//
// Plus an index on (txn_date desc, id desc) for the paginated Bandeja.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank-rpc.mjs
// or paste the SQL in the Supabase SQL Editor. Re-runnable.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `-- Fast keyset/offset pagination for the Bandeja.
create index if not exists bank_txn_date_id on public.bank_transactions (txn_date desc, id desc);
create index if not exists bank_txn_account on public.bank_transactions (bank_account_id);

-- P&L aggregate: month × category within the range/account, excluding ignored
-- rows, transfer categories (bank_categories.is_transfer) and the hardcoded
-- non-P&L concepts (transfers, financing, credit-card payments).
-- security invoker → the caller's RLS still applies.
create or replace function public.bank_pnl(
  p_from date default null,
  p_to date default null,
  p_account_id bigint default null,
  p_only_verified boolean default true
)
returns table (
  month text,
  category text,
  direction text,
  pnl_group text,
  total numeric,
  txn_count bigint
)
language sql stable security invoker as
$$
  select
    to_char(t.txn_date, 'YYYY-MM') as month,
    coalesce(nullif(trim(t.category), ''), '(sin categoría)') as category,
    c.direction,
    c.pnl_group,
    sum(t.amount) as total,
    count(*) as txn_count
  from public.bank_transactions t
  left join public.bank_categories c on lower(c.name) = lower(t.category)
  where t.status <> 'ignored'
    and (not p_only_verified or t.status = 'verified')
    and t.txn_date is not null
    and (p_from is null or t.txn_date >= p_from)
    and (p_to is null or t.txn_date <= p_to)
    and (p_account_id is null or t.bank_account_id = p_account_id)
    and coalesce(c.is_transfer, false) = false
    and coalesce(t.category, '') not in ('Transfer Between Accounts', 'Financing', 'Financing - Loan', 'Financing - Capital', 'Credit Card Payment')
  group by 1, 2, 3, 4
$$;

-- Bandeja tiles: exact inflow/outflow totals + count under the active filters.
-- v2 adds p_method (filter by payment_method) — drop the old signature so the
-- new one doesn't become an ambiguous overload.
drop function if exists public.bank_txn_totals(date, date, bigint, text, text, text);
create or replace function public.bank_txn_totals(
  p_from date default null,
  p_to date default null,
  p_account_id bigint default null,
  p_status text default null,
  p_category text default null,
  p_search text default null,
  p_method text default null
)
returns table (inflows numeric, outflows numeric, txn_count bigint)
language sql stable security invoker as
$$
  select
    coalesce(sum(t.amount) filter (where t.amount > 0), 0) as inflows,
    coalesce(sum(t.amount) filter (where t.amount < 0), 0) as outflows,
    count(*) as txn_count
  from public.bank_transactions t
  where (p_from is null or t.txn_date >= p_from)
    and (p_to is null or t.txn_date <= p_to)
    and (p_account_id is null or t.bank_account_id = p_account_id)
    and (p_status is null or t.status = p_status)
    and (p_category is null or t.category = p_category)
    and (p_search is null or t.raw_description ilike '%' || p_search || '%')
    and (p_method is null or t.payment_method = p_method)
$$;

-- Cuentas: signed sum + count per account (excludes ignored rows), so the
-- calculated balance never depends on how many rows the client fetched.
create or replace function public.bank_account_balances()
returns table (bank_account_id bigint, balance numeric, txn_count bigint)
language sql stable security invoker as
$$
  select t.bank_account_id, coalesce(sum(t.amount), 0), count(*)
  from public.bank_transactions t
  where t.status <> 'ignored' and t.bank_account_id is not null
  group by t.bank_account_id
$$;

grant execute on function public.bank_pnl(date, date, bigint, boolean) to anon, authenticated;
grant execute on function public.bank_txn_totals(date, date, bigint, text, text, text, text) to anon, authenticated;
grant execute on function public.bank_account_balances() to anon, authenticated;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank-rpc.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ RPCs de Bancos listas (bank_pnl + bank_txn_totals + bank_account_balances + índices). El P&L y la Bandeja ahora agregan en el servidor.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
