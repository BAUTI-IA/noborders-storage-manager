#!/usr/bin/env node
// One-time migration for the WhatsApp (WATI Coexistence) channel:
//   · wa_messages          — every WhatsApp message WATI reports, both directions
//   · wa_phone_key()       — the phone comparison key (last 10 digits)
//   · wa_match_phone()     — phone → broker / driver / job, service role only
//
// The SQL lives in scripts/setup-wati.sql (paste it in the Supabase SQL Editor
// if you prefer); this script just sends that same file.
//
// DDL cannot run through the publishable/anon key, so this uses the Supabase
// Management API.
//
// Usage (Node 18+):
//   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-wati.mjs
//
// Get a token at: https://supabase.com/dashboard/account/tokens
// Re-running is safe (idempotent).
import { readFileSync } from "node:fs";

const PROJECT_REF = "szkmktxziojzgfjkomua";
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN;

if (!TOKEN) {
  console.error("Missing SUPABASE_ACCESS_TOKEN. Run:\n  SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-wati.mjs");
  process.exit(1);
}

const SQL = readFileSync(new URL("./setup-wati.sql", import.meta.url), "utf8");

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`, {
  method: "POST",
  headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ query: SQL }),
});

const text = await res.text();
if (res.ok) {
  console.log("✓ wa_messages lista. El webhook de WATI ya puede guardar mensajes.");
} else {
  console.error(`✗ Error ${res.status}: ${text}`);
  process.exit(1);
}
