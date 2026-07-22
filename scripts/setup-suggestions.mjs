#!/usr/bin/env node
// One-time migration for the Suggestions module (employee suggestion box):
// creates public.suggestions + public.suggestion_votes with RLS (any employee
// posts/votes, author or admin edits/deletes, admin triages status + replies)
// and adds both tables to the realtime publication.
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API. Keep the SQL in sync with SUGGESTIONS_SQL in src/suggestions.jsx.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-suggestions.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// Re-running is safe (idempotent).

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-suggestions.mjs");
  process.exit(1);
}

const SQL = `
create table if not exists public.suggestions (
  id bigint generated always as identity primary key,
  created_by uuid references public.profiles(id) on delete set null,
  author_name text,
  category text default 'Other',
  body text not null,
  is_anonymous boolean not null default false,
  status text not null default 'new' check (status in ('new','reviewing','implemented','rejected')),
  admin_note text,
  created_at timestamptz not null default now()
);
create table if not exists public.suggestion_votes (
  suggestion_id bigint not null references public.suggestions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);
alter table public.suggestions enable row level security;
alter table public.suggestion_votes enable row level security;
drop policy if exists "suggestions_select" on public.suggestions;
create policy "suggestions_select" on public.suggestions
  for select to authenticated using (true);
drop policy if exists "suggestions_insert" on public.suggestions;
create policy "suggestions_insert" on public.suggestions
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "suggestions_update" on public.suggestions;
create policy "suggestions_update" on public.suggestions
  for update to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "suggestions_delete" on public.suggestions;
create policy "suggestions_delete" on public.suggestions
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "suggestion_votes_select" on public.suggestion_votes;
create policy "suggestion_votes_select" on public.suggestion_votes
  for select to authenticated using (true);
drop policy if exists "suggestion_votes_own" on public.suggestion_votes;
create policy "suggestion_votes_own" on public.suggestion_votes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ begin alter publication supabase_realtime add table public.suggestions; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.suggestion_votes; exception when others then null; end $$;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ suggestions + suggestion_votes listas (RLS + realtime). La solapa Suggestions ya funciona.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
