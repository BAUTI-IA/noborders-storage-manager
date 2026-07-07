#!/usr/bin/env node
// Chat upgrade: private group chats with hand-picked members (instead of every
// group being visible to the whole team). Adds chat_channels.is_private, a
// membership helper, updates the visibility rule, and lets a group's creator
// add other people as members.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat-groups.mjs
// or paste the SQL below in the Supabase SQL Editor.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `alter table public.chat_channels add column if not exists is_private boolean not null default false;

-- Membership test, SECURITY DEFINER so it reads chat_channel_members without
-- re-triggering that table's RLS (which would recurse through chat_can_see).
create or replace function public.chat_is_member(cid bigint)
returns boolean language sql security definer stable as
$$ select exists(select 1 from public.chat_channel_members where channel_id = cid and user_id = auth.uid()) $$;

-- Visibility: DMs → the two parties; private groups → creator or a member;
-- everything else (public channels) → the whole team.
create or replace function public.chat_can_see(ch public.chat_channels)
returns boolean language sql stable as
$$ select case
     when ch.is_dm then auth.uid() in (ch.dm_a, ch.dm_b)
     when coalesce(ch.is_private, false) then (ch.created_by = auth.uid() or public.chat_is_member(ch.id))
     else true
   end $$;

-- Let a group's creator add other people to it (each person can already
-- insert/update their own row via chat_members_own).
drop policy if exists "chat_members_add_by_creator" on public.chat_channel_members;
create policy "chat_members_add_by_creator" on public.chat_channel_members
  for insert to authenticated with check (
    exists (select 1 from public.chat_channels c where c.id = channel_id and c.created_by = auth.uid())
  );`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-chat-groups.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Grupos privados con miembros seleccionables listos. Recargá la app.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
