#!/usr/bin/env node
// One-time migration: creates public.agent_memory, el historial largo del
// agente de IA.
//
// Por qué una tabla nueva y no wa_conversations.history: ese campo es un único
// blob jsonb por canal, que handleIncoming recorta a los últimos 10 turnos
// (.slice(-HISTORY_MAX * 2)) — todo lo anterior se perdía para siempre. Un blob
// no se puede buscar, crece sin techo en una sola fila y no cruza canales.
//
// La misma persona escribe por varios canales ("app:<email>", "tg:<id>",
// "voice:<identity>"), así que se guarda también su email: la búsqueda se acota
// por persona cuando está identificada, no por canal.
//
// Solo la toca el service role (RLS on, sin policies), y está en
// AGENT_DENY_TABLES para que la herramienta sql no pueda leer la memoria de otro.
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-memory.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.agent_memory (
  id bigint generated always as identity primary key,
  convo_key text not null,
  user_email text,
  role text not null check (role in ('user','assistant')),
  text text not null,
  created_at timestamptz default now()
);
create index if not exists agent_memory_user_idx on public.agent_memory (user_email, created_at desc);
create index if not exists agent_memory_convo_idx on public.agent_memory (convo_key, created_at desc);
alter table public.agent_memory enable row level security;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-memory.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ agent_memory lista. El agente ya recuerda más allá de los últimos turnos.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
