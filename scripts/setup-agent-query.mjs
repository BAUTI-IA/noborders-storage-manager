#!/usr/bin/env node
// One-time migration: creates public.agent_query(q), the read-only SQL gateway
// the messaging agent uses to answer questions about any CRM data. Guardrails:
// SELECT/WITH only, single statement (no semicolons), read-only transaction,
// results capped at 200 rows. Only the service role may call it.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-query.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create or replace function public.agent_query(q text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $fn$
declare
  result jsonb;
begin
  if q !~* '^\\s*(select|with)\\M' then
    raise exception 'solo se permiten consultas SELECT';
  end if;
  if position(';' in q) > 0 then
    raise exception 'una sola sentencia, sin punto y coma';
  end if;
  perform set_config('transaction_read_only', 'on', true);
  execute format(
    'select coalesce(jsonb_agg(t), ''[]''::jsonb) from (select * from (%s) sub limit 200) t',
    q
  ) into result;
  return result;
end
$fn$;

revoke all on function public.agent_query(text) from public;
revoke all on function public.agent_query(text) from anon;
revoke all on function public.agent_query(text) from authenticated;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-query.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ agent_query lista. El agente ya puede consultar todo el CRM (solo lectura).");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
