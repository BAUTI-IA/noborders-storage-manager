#!/usr/bin/env node
// One-time migration: extends public.job_evaluations so it can also hold jobs
// that arrived by email (broker "Moving Estimate" mails), already priced, with
// decision='pending' until a human accepts or rejects them.
//
// It extends the existing table on purpose: job_evaluations already has the
// decision ('pending'|'accepted'|'rejected') concept and every column the Job
// Calculator writes, so an emailed job and a hand-priced one stay comparable
// and both feed calibrate().
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-inbound-jobs.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `
alter table public.job_evaluations
  -- provenance
  add column if not exists source text default 'manual',
  add column if not exists gmail_message_id text,
  add column if not exists gmail_thread_id text,
  add column if not exists received_at timestamptz,
  add column if not exists parsed jsonb,
  add column if not exists raw_body text,
  -- who and what the mail is about
  add column if not exists job_number text,
  add column if not exists broker_job_number text,
  add column if not exists broker_id_guess bigint,
  add column if not exists customer text,
  add column if not exists client_email text,
  add column if not exists client_phone text,
  add column if not exists pickup_address text,
  add column if not exists pickup_city text,
  add column if not exists pickup_state text,
  add column if not exists delivery_address text,
  add column if not exists delivery_city text,
  add column if not exists delivery_state text,
  add column if not exists pickup_date_from date,
  add column if not exists pickup_date_to date,
  -- money as the broker stated it
  add column if not exists estimate numeric,
  add column if not exists deposit numeric,
  add column if not exists carrier_rate_per_cf numeric,
  -- the profit range shown on the card (profitRange low/mid/high)
  add column if not exists profit_low numeric,
  add column if not exists profit_mid numeric,
  add column if not exists profit_high numeric,
  -- set once the operator accepts and the job row is created
  add column if not exists created_job_id bigint;

-- Re-syncing the same mailbox must never duplicate a card. Partial, so the
-- thousands of hand-made evaluations (all null here) are unaffected.
create unique index if not exists job_eval_gmail_msg
  on public.job_evaluations (gmail_message_id) where gmail_message_id is not null;

-- The queue's own query: pending, newest first.
create index if not exists job_eval_inbox
  on public.job_evaluations (decision, received_at desc) where source = 'gmail';

-- Both ZIPs are NOT NULL today because the calculator always had them. An
-- estimate whose delivery address is still "PENDING" would fail to insert and
-- the job would be lost instead of queued for a human to complete.
alter table public.job_evaluations alter column origin_zip drop not null;
alter table public.job_evaluations alter column dest_zip drop not null;

-- Rows synced from the mailbox are inserted by the service role, so created_by
-- is null. Without this, the existing "created_by = auth.uid() or is_admin()"
-- rule would let a non-admin SEE the queue but silently fail to accept or
-- reject anything in it. Mail-sourced rows belong to the company, not a person:
-- anyone with jobcalc edit rights may act on them.
drop policy if exists "job_evaluations_update" on public.job_evaluations;
create policy "job_evaluations_update" on public.job_evaluations
  for update to authenticated
  using ((created_by = auth.uid() or public.is_admin() or source = 'gmail') and public.has_perm('jobcalc','edit'))
  with check ((created_by = auth.uid() or public.is_admin() or source = 'gmail') and public.has_perm('jobcalc','edit'));

drop policy if exists "job_evaluations_delete" on public.job_evaluations;
create policy "job_evaluations_delete" on public.job_evaluations
  for delete to authenticated
  using ((created_by = auth.uid() or public.is_admin() or source = 'gmail') and public.has_perm('jobcalc','edit'));
`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-inbound-jobs.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ job_evaluations extendida para jobs entrantes por mail. Recargá la app: la sección Incoming Jobs ya funciona.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
