#!/usr/bin/env node
// One-time migration: creates the Expenses module — per-driver cost tracking
// (public.expenses: fuel, hotels, materials, tolls… linked to driver/truck/trip/job,
// with bank-vs-driver-cash source), the per-day driver pay log
// (public.driver_work_days + drivers.daily_rate), the materials catalog/ledger
// (public.material_items + public.material_movements) and the expense-receipts
// storage bucket.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-expenses.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// If scripts/setup-rls.mjs was already applied, re-run it afterwards so the
// expenses tables get per-section has_perm policies too.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.expenses (
  id bigint generated always as identity primary key,
  expense_date date,
  category text,
  amount numeric,
  vendor text,
  driver_id bigint references public.drivers(id),
  truck_id bigint references public.trucks(id),
  trip_id bigint references public.trips(id),
  job_id bigint references public.storage_jobs(id) on delete set null,
  job_number text,
  paid_from text default 'bank',
  bank_account text,
  status text default 'pending',
  receipt_url text,
  gallons numeric,
  odometer numeric,
  fuel_state text,
  settled boolean default false,
  settled_date date,
  notes text,
  created_by text,
  created_at timestamptz default now(),
  updated_by text,
  updated_at timestamptz
);
alter table public.expenses enable row level security;
drop policy if exists "expenses_all" on public.expenses;
create policy "expenses_all" on public.expenses for all to anon, authenticated using (true) with check (true);

alter table public.drivers add column if not exists daily_rate numeric;

create table if not exists public.driver_work_days (
  id bigint generated always as identity primary key,
  driver_id bigint references public.drivers(id) on delete cascade,
  work_date date,
  rate numeric,
  trip_id bigint references public.trips(id),
  notes text,
  created_by text,
  created_at timestamptz default now(),
  unique (driver_id, work_date)
);
alter table public.driver_work_days enable row level security;
drop policy if exists "driver_work_days_all" on public.driver_work_days;
create policy "driver_work_days_all" on public.driver_work_days for all to anon, authenticated using (true) with check (true);

create table if not exists public.material_items (
  id bigint generated always as identity primary key,
  name text,
  category text,
  unit text default 'unit',
  unit_cost numeric,
  active boolean default true,
  notes text,
  created_at timestamptz default now()
);
alter table public.material_items enable row level security;
drop policy if exists "material_items_all" on public.material_items;
create policy "material_items_all" on public.material_items for all to anon, authenticated using (true) with check (true);

create table if not exists public.material_movements (
  id bigint generated always as identity primary key,
  item_id bigint references public.material_items(id) on delete cascade,
  movement_type text,
  quantity numeric,
  unit_cost numeric,
  driver_id bigint references public.drivers(id),
  trip_id bigint references public.trips(id),
  job_id bigint references public.storage_jobs(id) on delete set null,
  job_number text,
  expense_id bigint references public.expenses(id) on delete set null,
  movement_date date,
  notes text,
  created_by text,
  created_at timestamptz default now()
);
alter table public.material_movements enable row level security;
drop policy if exists "material_movements_all" on public.material_movements;
create policy "material_movements_all" on public.material_movements for all to anon, authenticated using (true) with check (true);

insert into storage.buckets (id, name, public)
  values ('expense-receipts', 'expense-receipts', true)
  on conflict (id) do update set public = true;
drop policy if exists "expensereceipts_read" on storage.objects;
create policy "expensereceipts_read" on storage.objects for select to anon, authenticated using (bucket_id = 'expense-receipts');
drop policy if exists "expensereceipts_write" on storage.objects;
create policy "expensereceipts_write" on storage.objects for insert to anon, authenticated with check (bucket_id = 'expense-receipts');
drop policy if exists "expensereceipts_update" on storage.objects;
create policy "expensereceipts_update" on storage.objects for update to anon, authenticated using (bucket_id = 'expense-receipts');

do $$ begin alter publication supabase_realtime add table public.expenses; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.driver_work_days; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.material_items; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.material_movements; exception when others then null; end $$;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-expenses.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Expenses listo (expenses + driver_work_days + material_items/movements + bucket expense-receipts). Recargá la app y dales permisos de 'expenses' a los usuarios de oficina.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
