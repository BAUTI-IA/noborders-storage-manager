// Vercel serverless function: ask Claude to read a homebanking screenshot (or a
// statement photo) and extract every USD transaction line, suggesting a category
// from the Bancos chart of accounts. The employee then reviews/verifies each
// line in the app — this is extraction + suggestion, never final categorization.
// Mirrors api/bol-analyze.mjs (vision + auth + JSON-only response).
//
// It also hosts the bank feed (Chase → Plaid → Bancos) and the daily bank
// email, because api/ sits at the Hobby plan's 12-function cap
// (docs/bank-feed.md, logic in lib/bankFeed.mjs):
//   POST { action: "feed_*" | "digest_settings" | "digest_preview" }
//        → the Bancos → Accounts panel. Supabase JWT + the caller's "bancos"
//          permission, checked here (the service role bypasses RLS).
//   GET  /api/bank-digest  (rewrite → ?action=digest) → syncs the bank and
//        returns the email for scripts/bank-digest-email.gs to send.
//   POST /api/bank-digest  { ack } → that script confirms it was sent.
//        Both authenticate with the x-digest-secret header (BANK_DIGEST_SECRET).
// A request with no `action` behaves exactly as before.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import { createHash, timingSafeEqual } from "node:crypto";
import { isAdmin } from "../lib/acl.mjs";
import {
  plaidConfig, plaidFetch, syncAll, createLinkToken, saveEnrollment, repairConnection, saveLinks, disconnect, feedStatus,
  getDigestSettings, saveDigestSettings, composeDigest, ackDigest, problemsFromStatus,
} from "../lib/bankFeed.mjs";
import { parseRecipients, MAX_RECIPIENTS } from "../src/bankFeedData.js";

export const maxDuration = 300; // a long statement read, or a sync plus its category guesses

const client = new Anthropic(); // ANTHROPIC_API_KEY from env
const admin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Fallback list = the seed taxonomy (SEED_BANK_CATEGORIES in src/bankData.js).
// The client normally sends its live catalog (body.categories) since the owner
// can add categories from the UI — whatever arrives wins.
const DEFAULT_CATEGORY_NAMES = [
  "Job", "Refund",
  "Hotels", "Fuel", "Salaries - Employees", "Salaries - Helpers", "Toll", "Truck Repair", "Packaging", "Commissions", "Claims",
  "Storage", "Truck Licensing Fees", "Truck Rental", "Truck Maintenance", "Truck Insurance", "Truck Utilities",
  "Fees", "Software Licenses", "Ground Transportation", "Airfare", "Car Rental", "Office Supplies",
  "Loren Expenses", "Bauti Expenses", "Taxes", "Fines", "Other",
  "Broker", "Marketing", "Transfer Between Accounts",
];

// Text mode prompt: batch-suggest categories for already-parsed lines.
function suggestionPrompt(descriptions, catNames) {
  const list = descriptions.slice(0, 300).map((d, i) => `${i}. [${d.direction === "out" ? "OUT" : "IN"}] $${d.amount} — ${String(d.description || "").slice(0, 160)}`).join("\n");
  return `These are bank transaction lines (USD) from a moving & storage company. For each, suggest a category from exactly this list (or "" if unsure): ${catNames.join(" | ")}. ` +
    `Lines:\n${list}\n` +
    `Respond with ONLY compact JSON: {"lines":[{"i":0,"category":"","confidence":0}]} — one entry per input line, same order, "i" is the input index.`;
}

async function claudeLines(content, catNames, requestOptions) {
  const message = await client.messages.create({
    model: "claude-opus-5",
    // Opus 5 thinks by default; thinking shares the max_tokens budget with the
    // answer, so this leaves room for a long statement plus the reasoning.
    max_tokens: 16000,
    thinking: { type: "adaptive" },
    output_config: { effort: "medium" },
    messages: [{ role: "user", content }],
  }, requestOptions);
  const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return [];
  const parsed = JSON.parse(m[0]);
  return (parsed.lines || []).map(l => ({
    ...l,
    amount: Math.abs(Number(l.amount) || 0),
    direction: l.direction === "out" ? "out" : "in",
    category: catNames.includes(l.category) ? l.category : "",
    confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0)),
  }));
}

// Category guesses for lines the bank feed is about to import (filled in
// place, same fields the CSV import sets). Bounded in time: the daily email
// call must answer before the Gmail script gives up on it.
const feedSuggester = (timeoutMs) => async (rows) => {
  if (!process.env.ANTHROPIC_API_KEY || !rows.length) return;
  const { data } = await admin.from("bank_categories").select("name, active");
  const catNames = (data?.length ? data.filter(c => c.active !== false).map(c => c.name) : DEFAULT_CATEGORY_NAMES).slice(0, 100);
  const descriptions = rows.map(r => ({ description: r.raw_description, amount: Math.abs(Number(r.amount) || 0), direction: r.direction }));
  const lines = await claudeLines([{ type: "text", text: suggestionPrompt(descriptions, catNames) }], catNames, { timeout: timeoutMs, maxRetries: 0 });
  for (const s of lines) {
    const r = rows[s.i];
    if (r && s.category) { r.category = s.category; r.ai_suggested_category = s.category; r.ai_confidence = s.confidence ?? null; }
  }
};

// Compare digests, not the raw strings: timingSafeEqual throws when the lengths
// differ, which would leak the secret's length through the exception.
const sha256 = (v) => createHash("sha256").update(String(v), "utf8").digest();
const secretMatches = (given, expected) => timingSafeEqual(sha256(given), sha256(expected));

const appUrlOf = (req) => {
  const env = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (env) return env;
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  return host ? `https://${host}` : "";
};

// ── /api/bank-digest (the Gmail script) ──────────────────────────────────────
async function digestEndpoint(req, res) {
  const secret = String(process.env.BANK_DIGEST_SECRET || "").trim();
  // No secret configured → refuse: this returns the bank's transactions.
  if (!secret) { res.status(503).json({ error: "server not configured: BANK_DIGEST_SECRET" }); return; }
  const given = req.headers["x-digest-secret"];
  if (!given || !secretMatches(given, secret)) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!admin) { res.status(500).json({ error: "server not configured: SUPABASE_SERVICE_ROLE_KEY" }); return; }

  try {
    if (req.method === "POST") {
      await ackDigest(admin, req.body?.ack);
      res.status(200).json({ ok: true });
      return;
    }
    if (req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }

    const settings = await getDigestSettings(admin);
    const cfg = plaidConfig();
    const ctx = { db: admin, cfg, plaid: plaidFetch, suggest: feedSuggester(25000), actor: "Bank feed" };
    // Sync first, whatever happens with the email: the lines belong in Bancos.
    const sync = cfg.ready
      ? await syncAll(ctx)
      : { imported: 0, problems: [{ kind: "not_configured", detail: cfg.missing.join(", ") }] };
    if (settings.enabled === false) { res.status(200).json({ ok: true, skip: "disabled", imported: sync.imported }); return; }
    const to = parseRecipients(settings.recipients).valid;
    if (!to.length) { res.status(200).json({ ok: true, skip: "no_recipients", imported: sync.imported }); return; }
    const d = await composeDigest(ctx, { settings, problems: sync.problems, appUrl: appUrlOf(req) });
    // Nothing linked yet (or everything unlinked): an empty table is not news.
    if (!d.accounts) { res.status(200).json({ ok: true, skip: "no_linked_accounts", imported: sync.imported }); return; }
    res.status(200).json({ ok: true, to, subject: d.subject, html: d.html, text: d.text, ack: d.ack, count: d.count, imported: sync.imported });
  } catch (e) {
    console.error("bank-digest:", e);
    res.status(500).json({ error: e?.message || "bank digest error" });
  }
}

// ── The Bancos → Accounts panel ──────────────────────────────────────────────
const VIEW_ACTIONS = new Set(["feed_status", "digest_preview"]);

async function feedAction(req, res, action, user) {
  const { data: profile } = await admin.from("profiles").select("*").eq("id", user.id).maybeSingle();
  const level = VIEW_ACTIONS.has(action) ? "view" : "edit";
  const allowed = !!profile && profile.active !== false && (isAdmin(profile) || !!profile.permissions?.bancos?.[level]);
  if (!allowed) { res.status(403).json({ error: `You need "${level}" permission on Bancos.` }); return; }

  const body = req.body || {};
  const cfg = plaidConfig();
  const ctx = { db: admin, cfg, plaid: plaidFetch, suggest: feedSuggester(60000), actor: profile.full_name || profile.email || user.email || "Bank feed" };
  const needsPlaid = ["feed_link_token", "feed_enroll", "feed_link", "feed_sync"].includes(action);
  if (needsPlaid && !cfg.ready) { res.status(503).json({ error: `The bank feed is not configured in Vercel (missing ${cfg.missing.join(", ")}).` }); return; }

  try {
    if (action === "feed_status") { res.status(200).json(await feedStatus(ctx)); return; }

    if (action === "feed_link_token") {
      // connection_id → update mode on that connection (Reconnect); none → a new one.
      const link_token = await createLinkToken(ctx, { userId: user.id, lang: body.lang, connectionId: body.connection_id ? Number(body.connection_id) : null });
      res.status(200).json({ link_token });
      return;
    }

    if (action === "feed_enroll") {
      if (body.connection_id) {
        // Back from Link in update mode: same connection, same token.
        const sync = await repairConnection(ctx, Number(body.connection_id));
        res.status(200).json({ connection_id: Number(body.connection_id), sync, status: await feedStatus(ctx) });
        return;
      }
      const connection_id = await saveEnrollment(ctx, { publicToken: body.public_token, institution: body.institution });
      res.status(200).json({ connection_id, status: await feedStatus(ctx) });
      return;
    }

    if (action === "feed_link") {
      const sync = await saveLinks(ctx, { connectionId: Number(body.connection_id), links: Array.isArray(body.links) ? body.links.slice(0, 50) : [] });
      res.status(200).json({ sync, status: await feedStatus(ctx) });
      return;
    }

    if (action === "feed_sync") {
      const sync = await syncAll(ctx);
      res.status(200).json({ sync, status: await feedStatus(ctx) });
      return;
    }

    if (action === "feed_disconnect") {
      await disconnect(ctx, Number(body.connection_id));
      res.status(200).json({ status: await feedStatus(ctx) });
      return;
    }

    if (action === "digest_settings") {
      const r = parseRecipients(body.recipients);
      if (r.invalid.length) { res.status(400).json({ error: `Not an email address: ${r.invalid.join(", ")}` }); return; }
      if (r.tooMany) { res.status(400).json({ error: `At most ${MAX_RECIPIENTS} recipients.` }); return; }
      await saveDigestSettings(ctx, { recipients: r.valid.join(", "), lang: body.lang, enabled: body.enabled });
      res.status(200).json({ status: await feedStatus(ctx) });
      return;
    }

    if (action === "digest_preview") {
      // What tomorrow's email would say right now — no sync, nothing marked sent.
      const status = await feedStatus(ctx);
      if (status.tablesMissing) { res.status(200).json({ tablesMissing: true }); return; }
      const settings = await getDigestSettings(admin);
      const d = await composeDigest(ctx, { settings, problems: problemsFromStatus(status), appUrl: appUrlOf(req) });
      res.status(200).json({ to: parseRecipients(settings.recipients).valid, subject: d.subject, html: d.html, count: d.count });
      return;
    }

    res.status(400).json({ error: "Unknown action." });
  } catch (e) {
    console.error(`bank-feed ${action}:`, e);
    res.status(500).json({ error: e?.message || "bank feed error" });
  }
}

export default async function handler(req, res) {
  const action = String(req.query?.action || req.body?.action || "");
  if (action === "digest") { await digestEndpoint(req, res); return; }

  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }

  // Require a valid logged-in user. Fails closed: with no service key there is
  // no way to verify the session, so the endpoint refuses instead of turning
  // into an open proxy on ANTHROPIC_API_KEY.
  if (!admin) { res.status(500).json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." }); return; }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { data: { user } = {}, error: authErr } = token ? await admin.auth.getUser(token) : { data: {}, error: true };
  if (authErr || !user) { res.status(401).json({ error: "No autorizado." }); return; }

  if (action.startsWith("feed_") || action.startsWith("digest_")) { await feedAction(req, res, action, user); return; }

  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }
  const { image_base64, media_type, descriptions, categories } = req.body || {};
  if (!image_base64 && !Array.isArray(descriptions)) { res.status(400).json({ error: "Falta la imagen o las descripciones." }); return; }
  const catNames = (Array.isArray(categories) && categories.length ? categories : DEFAULT_CATEGORY_NAMES)
    .map(c => String(c).slice(0, 60)).slice(0, 100);

  try {
    let content;
    if (image_base64) {
      // Vision mode: extract every statement line from a screenshot.
      const prompt = `This image is a screenshot of a US bank's online banking (or a bank statement) for a moving & storage company. All amounts are USD. ` +
        `Extract EVERY transaction line visible. For each line return: "date" (ISO YYYY-MM-DD; if the year is not visible assume the most recent plausible one), ` +
        `"description" (the verbatim transaction text), "amount" (positive number), "direction" ("in" for credits/deposits, "out" for debits/withdrawals), ` +
        `"category" (your best guess from exactly this list, or "" if unsure: ${catNames.join(" | ")}), and "confidence" (0 to 1). ` +
        `Do NOT invent lines; skip running-balance columns, headers and totals. ` +
        `Respond with ONLY compact JSON: {"lines":[{"date":"","description":"","amount":0,"direction":"in","category":"","confidence":0}]}`;
      content = [
        { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image_base64 } },
        { type: "text", text: prompt },
      ];
    } else {
      // Text mode: batch-suggest categories for already-parsed CSV lines.
      content = [{ type: "text", text: suggestionPrompt(descriptions, catNames) }];
    }
    res.status(200).json({ lines: await claudeLines(content, catNames) });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error analizando el extracto." });
  }
}
