#!/usr/bin/env node
// Chat upgrade: read receipts (sent / delivered / seen) + last connection.
// Adds chat_presence (per-user last_seen_at heartbeat) and lets channel mates
// read each other's read cursors in chat_channel_members.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat-receipts.mjs
// or paste the SQL below in the Supabase SQL Editor.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `-- Last connection: each signed-in user heartbeats their own row.
create table if not exists public.chat_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table public.chat_presence enable row level security;
drop policy if exists "chat_presence_select" on public.chat_presence;
create policy "chat_presence_select" on public.chat_presence
  for select to authenticated using (true);
drop policy if exists "chat_presence_insert" on public.chat_presence;
create policy "chat_presence_insert" on public.chat_presence
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "chat_presence_update" on public.chat_presence;
create policy "chat_presence_update" on public.chat_presence
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

-- Read receipts: members of a conversation can see each other's read cursor.
drop policy if exists "chat_members_select_mates" on public.chat_channel_members;
create policy "chat_members_select_mates" on public.chat_channel_members
  for select to authenticated using (
    exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );

alter publication supabase_realtime add table public.chat_channel_members;
alter publication supabase_realtime add table public.chat_presence;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat-receipts.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Recibos de lectura y última conexión listos. Recargá la app.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
