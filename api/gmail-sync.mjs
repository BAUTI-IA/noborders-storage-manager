// Vercel serverless function: pull new emails from the storage-companies Gmail
// inbox, classify + extract each one with Claude, store everything in
// storage_emails (audit trail + review queue) and auto-apply only the safe
// action: advancing a unit's payment_due_date from a payment receipt.
// Everything else (new units, rate increases, lien notices) stays pending for
// human approval in the Storage → Mails tab.
//
// Called by .github/workflows/gmail-sync.yml every 30 min (x-sync-secret
// header) or from the UI "Sync now" button (Bearer token of a logged-in user).
//
// Required env (Vercel): GMAIL_CLIENT_ID, GMAIL_CLIENT_SECRET,
// GMAIL_REFRESH_TOKEN, GMAIL_SYNC_SECRET, ANTHROPIC_API_KEY,
// SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL (or VITE_SUPABASE_URL).
import crypto from "crypto";
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { BRAND_SENDERS, brandFromAddress, extractBodyText, gmailAccessToken, gmailConfigured, gmailGet, gmailList, headerValue } from "../lib/gmail.mjs";

export const config = { maxDuration: 60 };

const cleanEnv = (v) => (v || "").trim().replace(/^["']+|["']+$/g, "");
const SUPABASE_URL = cleanEnv(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL).replace(/\/+$/, "");
const SERVICE_KEY = cleanEnv(process.env.SUPABASE_SERVICE_ROLE_KEY);
const SYNC_SECRET = cleanEnv(process.env.GMAIL_SYNC_SECRET);
const admin = SERVICE_KEY && SUPABASE_URL
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;
const anthropic = new Anthropic(); // ANTHROPIC_API_KEY from env

const MAX_PER_RUN = 8;        // each mail costs one Claude call; backlog drains next run
const TIME_BUDGET_MS = 50_000; // Vercel maxDuration is 60s
const BODY_MAX_CHARS = 12_000;
const AUTO_APPLY_MIN_CONFIDENCE = 0.8;

const EMAIL_TYPES = ["rental_confirmation", "payment_reminder", "payment_receipt", "rate_increase", "lien_notice", "other"];
// Whitelisted extraction fields: name → type (anything else Claude returns is dropped).
const EXTRACT_KEYS = {
  unit: "text", facility_address: "text", city: "text", state: "text", zip: "text",
  account: "text", unit_size: "text", gate_code: "text", notes: "text",
  amount: "number", new_monthly_cost: "number", monthly_cost: "number",
  due_date: "date", paid_through_date: "date", effective_date: "date", move_in_date: "date",
};

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const norm = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
const addDays = (iso, days) => {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};

function secretOk(header) {
  if (!SYNC_SECRET || !header) return false;
  try { return crypto.timingSafeEqual(Buffer.from(SYNC_SECRET), Buffer.from(String(header))); } catch { return false; }
}

async function callerOk(req) {
  if (secretOk(req.headers["x-sync-secret"])) return true;
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !admin) return false;
  const { data: { user } = {}, error } = await admin.auth.getUser(token);
  return !error && !!user;
}

function buildPrompt({ from, subject, date, body }) {
  return `You are parsing an email sent by a self-storage company (Public Storage, Extra Space Storage, CubeSmart, U-Haul, etc.) to a moving company that rents storage units from them. Classify the email and extract fields.

"email_type" must be exactly one of: rental_confirmation | payment_reminder | payment_receipt | rate_increase | lien_notice | other.
Rules:
- lien, pre-lien, auction, default or cut-lock notices => lien_notice.
- late fee warnings, "payment due", "autopay failed" => payment_reminder.
- "thank you for your payment", receipts, autopay confirmations => payment_receipt.
- welcome / move-in / reservation or rental confirmations that mention a unit => rental_confirmation.
- rent/rate change announcements => rate_increase.
- marketing, surveys, everything else => other.

Respond with ONLY compact JSON, no prose:
{"email_type":"","confidence":0.0,"unit":"","facility_address":"","city":"","state":"","zip":"","account":"","amount":null,"due_date":null,"paid_through_date":null,"new_monthly_cost":null,"effective_date":null,"move_in_date":null,"unit_size":"","monthly_cost":null,"gate_code":"","notes":""}

Use null or "" when a value is absent. NEVER invent values. Dates in YYYY-MM-DD (the email was received ${date}; resolve relative or partial dates against that). Amounts as plain numbers without $. "unit" is the unit/space number only (e.g. "B123"). "state" is the 2-letter US state. "confidence" (0-1) is your confidence in email_type plus the extracted fields. "notes" is one short sentence summarizing the email.

--- EMAIL ---
From: ${from}
Subject: ${subject}
Date: ${date}

${body}`;
}

async function classifyEmail(mail) {
  const message = await anthropic.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 1024,
    messages: [{ role: "user", content: buildPrompt(mail) }],
  });
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("Claude no devolvió JSON");
  const raw = JSON.parse(m[0]);

  const out = {
    email_type: EMAIL_TYPES.includes(raw.email_type) ? raw.email_type : "other",
    confidence: Number.isFinite(Number(raw.confidence)) ? Math.max(0, Math.min(1, Number(raw.confidence))) : 0,
  };
  for (const [key, type] of Object.entries(EXTRACT_KEYS)) {
    const v = raw[key];
    if (v === null || v === undefined || v === "") continue;
    if (type === "number") { const n = Number(v); if (Number.isFinite(n)) out[key] = n; }
    else if (type === "date") { if (ISO_DATE.test(String(v))) out[key] = String(v); }
    else { out[key] = String(v).slice(0, 300); }
  }
  return out;
}

// Server-side mirror of findStorageDup (src/App.jsx): brand + unit (+ state) is
// an exact match; brand + zip is fuzzy; anything else is left for the UI.
function matchStorage(storages, brand, extracted) {
  const b = norm(brand), u = norm(extracted.unit), st = norm(extracted.state), z = norm(extracted.zip);
  if (b && u) {
    const hit = storages.find((r) => norm(r.brand) === b && norm(r.unit) === u && (!st || !norm(r.state) || norm(r.state) === st));
    if (hit) return { storage: hit, method: "exact" };
  }
  if (b && z) {
    const hits = storages.filter((r) => norm(r.brand) === b && norm(r.zip) === z && r.situation !== "Close");
    if (hits.length === 1) return { storage: hits[0], method: "fuzzy" };
  }
  return { storage: null, method: "none" };
}

// Mixed mode policy: only payment receipts on an exact match auto-apply (and
// only ever moving payment_due_date forward). Everything else waits for review.
function decideAction(extracted, match) {
  const type = extracted.email_type;
  if (type === "lien_notice") return { action: "flag_lien", payload: null, auto: false };
  if (type === "rental_confirmation") {
    return {
      action: "create_unit",
      payload: {
        unit: extracted.unit || "", address: extracted.facility_address || "", state: extracted.state || "",
        zip: extracted.zip || "", size: extracted.unit_size || "", gate_code: extracted.gate_code || "",
        account: extracted.account || "", monthly_cost: extracted.monthly_cost ?? extracted.amount ?? null,
        date_opened: extracted.move_in_date || null,
      },
      auto: false,
    };
  }
  if (type === "rate_increase") {
    if (extracted.new_monthly_cost == null) return { action: "none", payload: null, auto: false };
    return { action: "update_monthly_cost", payload: { monthly_cost: extracted.new_monthly_cost, effective_date: extracted.effective_date || null }, auto: false };
  }
  if (type === "payment_receipt" || type === "payment_reminder") {
    const current = match.storage?.payment_due_date || null;
    // A receipt without an explicit date still means the cycle renewed (+30d),
    // same as the manual "Renew" button.
    let newDue = extracted.paid_through_date || extracted.due_date || null;
    if (!newDue && type === "payment_receipt" && current) newDue = addDays(current, 30);
    if (!newDue) return { action: "none", payload: null, auto: false };
    if (current && newDue <= current) return { action: "none", payload: null, auto: false }; // never move backwards
    // Unmatched mails keep the suggestion pending; the UI lets the user pick the unit.
    const auto = type === "payment_receipt" && match.method === "exact" && extracted.confidence >= AUTO_APPLY_MIN_CONFIDENCE;
    return { action: "set_due_date", payload: { payment_due_date: newDue }, auto };
  }
  return { action: "none", payload: null, auto: false };
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!admin) { res.status(500).json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." }); return; }
  if (!(await callerOk(req))) { res.status(401).json({ error: "No autorizado." }); return; }
  if (!gmailConfigured()) { res.status(500).json({ error: "Faltan GMAIL_CLIENT_ID / GMAIL_CLIENT_SECRET / GMAIL_REFRESH_TOKEN en Vercel." }); return; }
  if (!cleanEnv(process.env.ANTHROPIC_API_KEY)) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }

  const t0 = Date.now();
  const counts = { processed: 0, applied: 0, pending: 0, ignored: 0, errors: 0 };
  // Retry of a single failed mail: process just that message id, regardless of
  // the sync watermark (the mail may be older than the search window).
  const retryId = typeof req.body?.message_id === "string" ? req.body.message_id : null;

  try {
    const token = await gmailAccessToken();

    const { data: state } = await admin.from("gmail_sync_state").select("*").eq("id", 1).maybeSingle();
    let ids;
    if (retryId) {
      ids = [retryId];
      await admin.from("storage_emails").delete().eq("gmail_message_id", retryId);
    } else {
      // 1h overlap covers cron jitter; the unique index on gmail_message_id dedups.
      const sinceMs = Number(state?.last_internal_date) || Date.now() - 30 * 24 * 3600 * 1000; // first run: last 30 days
      const afterSecs = Math.max(0, Math.floor(sinceMs / 1000) - 3600);
      const q = `from:(${Object.keys(BRAND_SENDERS).join(" OR ")}) after:${afterSecs}`;

      const list = await gmailList(token, { q, maxResults: 25 });
      ids = (list.messages || []).map((m) => m.id);

      if (ids.length) {
        const { data: existing } = await admin.from("storage_emails").select("gmail_message_id").in("gmail_message_id", ids);
        const seen = new Set((existing || []).map((r) => r.gmail_message_id));
        ids = ids.filter((id) => !seen.has(id));
      }
      // Gmail lists newest-first; process oldest-first so last_internal_date advances safely.
      ids = ids.reverse().slice(0, MAX_PER_RUN);
    }

    // payment_due_date is an optional column (CRM v3 migration) — fall back without it.
    let { data: storages, error: stErr } = await admin.from("storages").select("id, brand, unit, state, zip, situation, payment_due_date");
    if (stErr) ({ data: storages } = await admin.from("storages").select("id, brand, unit, state, zip, situation"));

    let maxInternal = Number(state?.last_internal_date) || 0;

    for (const id of ids) {
      if (Date.now() - t0 > TIME_BUDGET_MS) break;
      const row = { gmail_message_id: id, status: "error" };
      try {
        const msg = await gmailGet(token, id);
        const from = headerValue(msg, "From");
        const brand = brandFromAddress(from);
        Object.assign(row, {
          gmail_thread_id: msg.threadId || null,
          from_address: from,
          subject: headerValue(msg, "Subject"),
          snippet: msg.snippet || "",
          received_at: msg.internalDate ? new Date(Number(msg.internalDate)).toISOString() : null,
          brand,
        });
        const body = extractBodyText(msg.payload).slice(0, BODY_MAX_CHARS);
        row.body_text = body;

        const extracted = await classifyEmail({ from, subject: row.subject, date: row.received_at || "", body });
        const match = matchStorage(storages || [], brand, extracted);
        const decision = decideAction(extracted, match);

        Object.assign(row, {
          email_type: extracted.email_type,
          extracted,
          confidence: extracted.confidence,
          storage_id: match.storage?.id || null,
          match_method: match.method,
          suggested_action: decision.action,
          action_payload: decision.payload,
          // "other" mail and mail with nothing actionable stays out of the review
          // queue (visible under "Todos" for audit).
          status: extracted.email_type === "other" || decision.action === "none" ? "ignored" : "pending",
          error: null,
        });

        if (decision.auto && decision.action === "set_due_date") {
          const { error: upErr } = await admin.from("storages").update({ payment_due_date: decision.payload.payment_due_date, updated_by: "gmail-sync", updated_at: new Date().toISOString() }).eq("id", match.storage.id);
          if (!upErr) { row.status = "auto_applied"; row.applied_at = new Date().toISOString(); counts.applied++; }
        }
        if (row.status === "pending") counts.pending++;
        if (row.status === "ignored") counts.ignored++;
        if (msg.internalDate) maxInternal = Math.max(maxInternal, Number(msg.internalDate));
      } catch (e) {
        row.error = e?.message || String(e);
        counts.errors++;
      }
      const { error: insErr } = await admin.from("storage_emails").upsert(row, { onConflict: "gmail_message_id", ignoreDuplicates: true });
      if (insErr) counts.errors++;
      else counts.processed++;
    }

    if (!retryId) {
      await admin.from("gmail_sync_state").upsert({
        id: 1,
        last_internal_date: maxInternal || Number(state?.last_internal_date) || null,
        last_run_at: new Date().toISOString(),
        last_status: `ok: ${counts.processed} procesados, ${counts.applied} auto, ${counts.errors} errores`,
        last_error: null,
      });
    }
    res.status(200).json(counts);
  } catch (e) {
    const message = e?.message || "Error de sincronización.";
    await admin.from("gmail_sync_state").upsert({ id: 1, last_run_at: new Date().toISOString(), last_status: "error", last_error: message }).then(() => {}, () => {});
    res.status(500).json({ error: message, ...counts });
  }
}
