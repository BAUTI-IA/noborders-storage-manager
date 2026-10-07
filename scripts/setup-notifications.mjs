#!/usr/bin/env node
// Notifications bell: one row per alert addressed to a teammate (today, the
// @mentions on dispatch notes). Each user reads and marks only their own rows;
// the author of the note inserts them. Realtime makes the bell update live.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-notifications.mjs
// or paste the SQL (also copyable from the bell's setup banner) in the
// Supabase SQL Editor.
// Keep in sync with NOTIFICATIONS_SQL in src/notifications.jsx.
const SQL = `create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  from_id uuid references public.profiles(id) on delete set null,
  from_name text,
  kind text not null default 'mention',
  job_id bigint,
  job_number text,
  customer text,
  event_id bigint,
  body text,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "notifications_insert_as_sender" on public.notifications;
create policy "notifications_insert_as_sender" on public.notifications
  for insert to authenticated with check (from_id = auth.uid());
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "notifications_delete_own" on public.notifications;
create policy "notifications_delete_own" on public.notifications
  for delete to authenticated using (user_id = auth.uid());
do $$ begin alter publication supabase_realtime add table public.notifications; exception when others then null; end $$;`;

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-notifications.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Notifications listas. Recargá la app.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
