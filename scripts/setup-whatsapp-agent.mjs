#!/usr/bin/env node
// One-time migration: creates public.wa_conversations, the per-phone
// conversation state used by the WhatsApp AI agent (api/whatsapp-webhook.mjs).
// Only the service role touches this table (RLS on, no policies).
//
// DDL cannot run through the publishable/anon key (PostgREST exposes no DDL),
// so this uses the Supabase Management API, which DOES accept arbitrary SQL.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-whatsapp-agent.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// (account-level token, not the project dashboard). Nothing else required.

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `create table if not exists public.wa_conversations (
  id bigint generated always as identity primary key,
  phone text not null unique,
  state text not null default 'idle',
  pending_action jsonb,
  history jsonb default '[]'::jsonb,
  updated_at timestamptz default now(),
  created_at timestamptz default now()
);
alter table public.wa_conversations enable row level security;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-whatsapp-agent.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ wa_conversations lista. El agente de WhatsApp ya puede guardar estado de conversación.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
