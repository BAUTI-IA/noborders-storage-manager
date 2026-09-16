#!/usr/bin/env node
// One-time migration: splits "last login" in the Users section into two — the
// last sign-in to the CRM (browser) and the last sign-in to the NBM Driver App
// (phone) — so it is clear who used which, and when.
//
// Why it can't just read auth.users: last_sign_in_at is a single timestamp for
// every device, so a driver who lives in the app and an admin who lives in the
// CRM are indistinguishable. Two things fix that:
//
//   profiles.last_login_crm / last_login_app  the durable record, one per device
//   public.touch_login(platform)              the CRM stamps its own sign-in
//   public.login_activity()                   reads auth.sessions.user_agent,
//                                             classifies each live session as
//                                             CRM or app, and folds it into the
//                                             two columns above
//
// login_activity() exists because auth.sessions (where the user agent lives) is
// not exposed through PostgREST and needs the service role — so it runs
// SECURITY DEFINER, gated on is_admin(). Folding the result into profiles is
// what makes the history durable: GoTrue deletes the session row on sign-out.
//
// The mobile app needs no change to be counted — its user agent gives it away.
// If you want the app's own exact stamp, have it call the same RPC after
// signing in:  await supabase.rpc("touch_login", { platform: "app" })
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-login-tracking.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Re-running is safe.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `alter table public.profiles add column if not exists last_login_crm timestamptz;
alter table public.profiles add column if not exists last_login_app timestamptz;

-- Which device a sign-in came from, read off the user agent GoTrue stored with
-- the session. The NBM Driver App is React Native: okhttp on Android,
-- CFNetwork/Darwin on iOS. Neither ever sends a browser user agent.
create or replace function public.login_platform(ua text) returns text
language sql immutable as $$
  select case
    when ua is null or btrim(ua) = '' then null
    when ua ~* '(okhttp|cfnetwork|darwin|expo|react[ _-]?native|dart/|flutter|nbm)' then 'app'
    when ua ~* 'mozilla' then 'crm'
    else null
  end;
$$;

-- A member cannot write their own profiles row (profiles_write is admin-only),
-- so the CRM stamps its sign-in through this: the caller's own row, and only
-- the two last_login columns. The mobile app can call it with 'app' too.
create or replace function public.touch_login(platform text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return; end if;
  if platform is null or platform not in ('crm','app') then
    raise exception 'Unknown platform: %', platform using errcode = '22023';
  end if;
  update public.profiles
     set last_login_crm = case when platform = 'crm' then now() else last_login_crm end,
         last_login_app = case when platform = 'app' then now() else last_login_app end
   where id = auth.uid();
end; $$;

-- Per-user last sign-in split by device. auth.sessions is not exposed through
-- PostgREST and is only readable with the service role, hence SECURITY DEFINER
-- gated on is_admin(). It also folds what it finds into profiles, so the
-- history survives the session row (GoTrue deletes it on sign-out).
create or replace function public.login_activity()
returns table (id uuid, crm_login timestamptz, app_login timestamptz)
language plpgsql security definer set search_path = public, auth as $$
begin
  if not (public.is_admin()
          or coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role', '') = 'service_role') then
    raise exception 'Only administrators.' using errcode = '42501';
  end if;

  with live as (
    select s.user_id,
           max(s.created_at) filter (where public.login_platform(s.user_agent) = 'crm') as seen_crm,
           max(s.created_at) filter (where public.login_platform(s.user_agent) = 'app') as seen_app
      from auth.sessions s
     group by s.user_id
  )
  update public.profiles p
     set last_login_crm = greatest(p.last_login_crm, l.seen_crm),
         last_login_app = greatest(p.last_login_app, l.seen_app)
    from live l
   where l.user_id = p.id
     and (p.last_login_crm is distinct from greatest(p.last_login_crm, l.seen_crm)
       or p.last_login_app is distinct from greatest(p.last_login_app, l.seen_app));

  return query select p.id, p.last_login_crm, p.last_login_app from public.profiles p;
end; $$;

revoke all on function public.login_activity() from public;
revoke all on function public.touch_login(text) from public;
grant execute on function public.login_activity() to authenticated, service_role;
grant execute on function public.touch_login(text) to authenticated, service_role;
notify pgrst, 'reload schema';`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-login-tracking.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ Último acceso separado por dispositivo. Entrá a Users: ahora hay dos columnas, CRM y App.");
  console.log("  Las sesiones abiertas se clasifican solas por user agent; los ingresos nuevos del CRM se sellan al entrar.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
