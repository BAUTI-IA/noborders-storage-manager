#!/usr/bin/env node
// Migration for the executive agent: links a Telegram (or WhatsApp) identity to
// a CRM user so the agent can enforce that user's role permissions on writes.
// Without a link the agent stays read-only on those channels.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-writes.mjs

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

const SQL = `alter table public.profiles
  add column if not exists telegram_user_id text,
  add column if not exists whatsapp_phone text,
  add column if not exists link_code text,
  add column if not exists link_code_expires_at timestamptz;

create unique index if not exists profiles_telegram_user_id_key
  on public.profiles (telegram_user_id) where telegram_user_id is not null;
create unique index if not exists profiles_whatsapp_phone_key
  on public.profiles (whatsapp_phone) where whatsapp_phone is not null;`;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-agent-writes.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ profiles listo para vincular Telegram/WhatsApp con usuarios del CRM.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
