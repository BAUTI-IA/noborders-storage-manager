#!/usr/bin/env node
// One-time migration: creates the internal team chat (Slack-style) tables —
// chat_channels, chat_channel_members and chat_messages — plus RLS and realtime.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Nothing else required.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `-- Channels: public team channels (is_dm=false, visible to everyone) and
-- direct messages (is_dm=true, visible only to dm_a/dm_b). dm_key dedupes DMs.
create table if not exists public.chat_channels (
  id bigint generated always as identity primary key,
  name text,
  is_dm boolean not null default false,
  dm_a uuid references public.profiles(id) on delete cascade,
  dm_b uuid references public.profiles(id) on delete cascade,
  dm_key text unique,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);

-- Per-user read cursor per channel (drives unread counts).
create table if not exists public.chat_channel_members (
  channel_id bigint references public.chat_channels(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);

create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  channel_id bigint not null references public.chat_channels(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  sender_name text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_channel_idx on public.chat_messages (channel_id, created_at);

alter table public.chat_channels enable row level security;
alter table public.chat_channel_members enable row level security;
alter table public.chat_messages enable row level security;

-- A channel is visible if it's a public channel, or the user is one of the two DM parties.
create or replace function public.chat_can_see(ch public.chat_channels)
returns boolean language sql stable as
$$ select (not ch.is_dm) or auth.uid() in (ch.dm_a, ch.dm_b) $$;

drop policy if exists "chat_channels_select" on public.chat_channels;
create policy "chat_channels_select" on public.chat_channels
  for select to authenticated using (public.chat_can_see(chat_channels));
drop policy if exists "chat_channels_insert" on public.chat_channels;
create policy "chat_channels_insert" on public.chat_channels
  for insert to authenticated
  with check (created_by = auth.uid() and (not is_dm or auth.uid() in (dm_a, dm_b)));
drop policy if exists "chat_channels_delete" on public.chat_channels;
create policy "chat_channels_delete" on public.chat_channels
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());

drop policy if exists "chat_members_own" on public.chat_channel_members;
create policy "chat_members_own" on public.chat_channel_members
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select to authenticated using (
    exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );
drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );
drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete to authenticated using (sender_id = auth.uid() or public.is_admin());

-- Members can currently only read their own profiles row; chat needs names of
-- teammates to list channels/DMs. Allow every signed-in user to read profiles.
drop policy if exists "profiles_select_chat" on public.profiles;
create policy "profiles_select_chat" on public.profiles
  for select to authenticated using (true);

-- Default channel so the section isn't empty on first load.
insert into public.chat_channels (name, is_dm)
select 'general', false
where not exists (select 1 from public.chat_channels where name = 'general' and not is_dm);

alter publication supabase_realtime add table public.chat_channels;
alter publication supabase_realtime add table public.chat_messages;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Chat listo. Recargá la app: la sección Messages ya está activa.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
