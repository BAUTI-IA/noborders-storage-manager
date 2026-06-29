#!/usr/bin/env node
// One-time migration: creates public.profiles (roles + per-section permissions),
// the is_admin()/has_perm() helper functions, an auth.users -> profiles trigger,
// and bootstraps the first admin account.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx ADMIN_EMAIL=you@example.com node scripts/setup-profiles.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard).
// ADMIN_EMAIL must already exist as a user in Supabase Auth; it becomes the
// first admin. Re-running is safe (idempotent).

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;
const ADMIN_EMAIL = process.env.ADMIN_EMAIL;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx ADMIN_EMAIL=you@example.com node scripts/setup-profiles.mjs");
  process.exit(1);
}
if (!ADMIN_EMAIL) {
  console.error("Missing ADMIN_EMAIL (the email of the existing account that should become admin).");
  process.exit(1);
}

// The admin email is interpolated as a SQL literal; escape single quotes.
const adminLiteral = `'${ADMIN_EMAIL.replace(/'/g, "''")}'`;

const SQL = `
create table if not exists public.profiles (
  id          uuid primary key references auth.users(id) on delete cascade,
  email       text,
  full_name   text,
  role        text not null default 'member' check (role in ('admin','member')),
  permissions jsonb not null default '{}'::jsonb,
  active      boolean not null default true,
  created_at  timestamptz default now()
);
alter table public.profiles enable row level security;

-- SECURITY DEFINER helpers: run with the function owner's rights so they can
-- read profiles without tripping the table's own RLS (avoids infinite recursion).
create or replace function public.is_admin() returns boolean
language sql security definer set search_path = public as $$
  select exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.role = 'admin' and p.active
  );
$$;

-- Does the current user hold (view|edit|create) on a given CRM section?
create or replace function public.has_perm(section text, level text) returns boolean
language sql security definer set search_path = public as $$
  select public.is_admin() or exists (
    select 1 from public.profiles p
    where p.id = auth.uid() and p.active
      and coalesce((p.permissions -> section ->> level)::boolean, false)
  );
$$;

-- profiles RLS: a member reads only their own row; admins read/write all.
drop policy if exists profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using ( id = auth.uid() or public.is_admin() );
drop policy if exists profiles_write on public.profiles;
create policy profiles_write on public.profiles for all to authenticated
  using ( public.is_admin() ) with check ( public.is_admin() );

-- Auto-create a profile row whenever an auth user is created (so the invite
-- flow always has a row to attach role + permissions to).
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into public.profiles (id, email) values (new.id, new.email)
  on conflict (id) do nothing;
  return new;
end; $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.handle_new_user();

-- Backfill profiles for any pre-existing auth users.
insert into public.profiles (id, email)
select u.id, u.email from auth.users u
on conflict (id) do nothing;

-- Bootstrap the first admin.
insert into public.profiles (id, email, role, permissions, active)
select u.id, u.email, 'admin', '{}'::jsonb, true
from auth.users u
where u.email = ${adminLiteral}
on conflict (id) do update set role = 'admin', active = true;
`;

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log(`✓ profiles + helpers + trigger listos. Admin inicial: ${ADMIN_EMAIL}`);
  console.log("  Siguiente paso: node scripts/setup-rls.mjs para enforzar permisos por tabla.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
