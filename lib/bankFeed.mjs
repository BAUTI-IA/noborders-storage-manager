// Bank feed — the I/O half: Teller over mTLS and the Supabase reads/writes.
// The rules (what gets imported, what the email says) are pure and live in
// src/bankFeedData.js; the HTTP surface is api/bank-analyze.mjs (feed_* and
// digest_* actions, and /api/bank-digest for the Gmail script). See
// docs/bank-feed.md.
//
// Teller authenticates twice: the APPLICATION with a client certificate (mTLS,
// required outside sandbox) and the ENROLLMENT with its access token as the
// HTTP Basic username. A leaked token reads nothing without the certificate,
// which only exists in Vercel env.
//
// Cost guard: Teller bills balance lookups per call, so nothing here calls
// /balances — the bank's balance comes off the transactions' running_balance.
//
// Every function takes a context { db, cfg, teller, suggest?, actor?, now? }
// so the whole flow can run against fakes without a bank or a database.
import { request } from "node:https";
import {
  FEED_SOURCE, planFeedImport, latestRunningBalance, fetchFloor, todayInTz,
  newAccountName, crmTypeOf, isFeedSupported, proposeLinks, buildDigest,
} from "../src/bankFeedData.js";

const TELLER_API = "https://api.teller.io";
const PAGE = 250;
const MAX_PAGES = 20;

const cleanEnv = (v) => String(v || "").trim().replace(/^["']+|["']+$/g, "");
// A PEM pasted into Vercel arrives as-is, with literal "\n", or base64-encoded.
const pem = (v) => {
  const s = cleanEnv(v);
  if (!s) return "";
  if (s.includes("-----BEGIN")) return s.replace(/\\n/g, "\n");
  return Buffer.from(s, "base64").toString("utf8");
};

export function tellerConfig(env = process.env) {
  const e = cleanEnv(env.TELLER_ENV);
  const environment = ["sandbox", "development", "production"].includes(e) ? e : "development";
  const appId = cleanEnv(env.TELLER_APP_ID);
  const cert = pem(env.TELLER_CERT), key = pem(env.TELLER_KEY);
  const missing = [];
  if (!appId) missing.push("TELLER_APP_ID");
  if (environment !== "sandbox") {
    if (!cert.includes("-----BEGIN")) missing.push("TELLER_CERT");
    if (!key.includes("-----BEGIN")) missing.push("TELLER_KEY");
  }
  return { environment, appId, cert, key, missing, ready: missing.length === 0 };
}

export class TellerError extends Error {
  constructor(status, code, message) {
    super(message || `Teller HTTP ${status}`);
    this.status = status;
    this.code = code || "";
  }
}
// The bank wants the person to sign in again (password changed, new MFA…):
// only a Reconnect from the Bancos panel fixes it.
export const isDisconnected = (e) => /^enrollment\.disconnected/.test(e?.code || "");

export function tellerFetch(path, accessToken, cfg, { method = "GET", timeoutMs = 30000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(TELLER_API + path, {
      method,
      cert: cfg.cert || undefined,
      key: cfg.key || undefined,
      headers: { Authorization: "Basic " + Buffer.from(`${accessToken}:`).toString("base64"), Accept: "application/json" },
    }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c) => { body += c; });
      res.on("end", () => {
        let json = null;
        try { json = body ? JSON.parse(body) : null; } catch { /* an HTML error page */ }
        if (res.statusCode >= 200 && res.statusCode < 300) { resolve(json); return; }
        reject(new TellerError(res.statusCode, json?.error?.code, json?.error?.message || body.slice(0, 200) || `Teller HTTP ${res.statusCode}`));
      });
    });
    req.setTimeout(timeoutMs, () => req.destroy(new Error("Teller did not answer in time")));
    req.on("error", reject);
    req.end();
  });
}

// What the panel needs to label an account — never the full account number.
const slimAccount = (a) => ({
  id: a.id, name: a.name, last_four: a.last_four || "", type: a.type, subtype: a.subtype,
  institution: { id: a.institution?.id || "", name: a.institution?.name || "" },
});

export const isMissingSchema = (error) =>
  ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache/i.test(error?.message || "");

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

// Newest-first pages until the floor date (or the end of the history).
async function fetchPosted(ctx, token, accountId, floor) {
  const out = [];
  const seen = new Set();
  let fromId = null;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ count: String(PAGE) });
    if (fromId) qs.set("from_id", fromId);
    const batch = await ctx.teller(`/accounts/${encodeURIComponent(accountId)}/transactions?${qs}`, token, ctx.cfg);
    if (!Array.isArray(batch) || !batch.length) break;
    let fresh = 0, reachedFloor = false;
    for (const t of batch) {
      if (seen.has(t.id)) continue;
      seen.add(t.id);
      fresh++;
      out.push(t);
      if (floor && t.date && t.date < floor) reachedFloor = true;
    }
    // A short page is not taken as the end: if Teller caps `count` lower than
    // asked, the next page is still there. The end is an empty or repeated page.
    if (!fresh || reachedFloor) break;
    fromId = batch[batch.length - 1].id;
  }
  return out;
}

const problemFrom = (e, label) => ({ kind: isDisconnected(e) ? "disconnected" : "error", label, detail: e?.message || String(e) });

// Pull one connection's linked accounts into bank_transactions.
//   backfill: read from each account's import start, not from the last sync
//             (right after linking, or after moving the start date back).
export async function syncConnection(ctx, conn, { backfill = false } = {}) {
  const { db } = ctx;
  const label = conn.institution || "Bank";
  const result = { imported: 0, skipped: { pending: 0, before_since: 0, already: 0, duplicate: 0 }, problems: [] };
  const mark = async (patch) => must(await db.from("bank_feed_connections")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", conn.id), "bank_feed_connections");

  let feedAccounts;
  try {
    feedAccounts = await ctx.teller("/accounts", conn.access_token, ctx.cfg);
  } catch (e) {
    const p = problemFrom(e, label);
    await mark({ status: p.kind === "disconnected" ? "disconnected" : "error", last_error: p.detail });
    result.problems.push(p);
    return result;
  }

  const linked = must(await db.from("bank_accounts").select("id, name, feed_account_id, feed_since")
    .eq("feed_connection_id", conn.id), "bank_accounts") || [];
  const rows = [];
  const balances = [];
  for (const acc of linked) {
    if (!acc.feed_account_id) continue;
    const fa = (feedAccounts || []).find((a) => a.id === acc.feed_account_id);
    if (!fa) { result.problems.push({ kind: "missing_account", label: acc.name }); continue; }
    if (!isFeedSupported(fa)) continue;
    const floor = backfill ? acc.feed_since || null : fetchFloor({ since: acc.feed_since, lastSyncAt: conn.last_sync_at });
    let txns;
    try {
      txns = await fetchPosted(ctx, conn.access_token, fa.id, floor);
    } catch (e) {
      result.problems.push(problemFrom(e, acc.name));
      if (isDisconnected(e)) break;
      continue;
    }
    let q = db.from("bank_transactions").select("dedup_hash, source, source_ref").eq("bank_account_id", acc.id).limit(20000);
    if (floor) q = q.gte("txn_date", floor);
    const existing = must(await q, "bank_transactions") || [];
    // The last page runs past the floor; lines older than it were settled by
    // an earlier sync, and `existing` only covers the floor onwards.
    const inWindow = floor ? txns.filter((t) => t.date && t.date >= floor) : txns;
    const plan = planFeedImport({ txns: inWindow, account: acc, existing });
    rows.push(...plan.rows);
    for (const k of Object.keys(result.skipped)) result.skipped[k] += plan.skipped[k];
    const bal = latestRunningBalance(txns);
    if (bal) balances.push({ id: acc.id, ...bal });
  }

  if (rows.length) {
    // Category suggestions are a nicety: a slow or failed AI call never
    // blocks the import (the lines just arrive without a guess).
    if (ctx.suggest) { try { await ctx.suggest(rows); } catch { /* optional */ } }
    const batch = must(await db.from("bank_import_batches").insert({
      bank_account_id: linked.length === 1 ? linked[0].id : null, source: FEED_SOURCE, file_ref: label,
      rows_extracted: rows.length, rows_imported: rows.length, created_by: ctx.actor || "Bank feed",
    }).select("id").single(), "bank_import_batches");
    const stamped = rows.map((r) => ({ ...r, import_batch_id: batch.id, created_by: ctx.actor || "Bank feed" }));
    // Same guard as the screenshot import: two syncs racing can't double a line.
    must(await db.from("bank_transactions").upsert(stamped, { onConflict: "dedup_hash", ignoreDuplicates: true }), "bank_transactions");
    result.imported = rows.length;
  }
  for (const b of balances) {
    must(await db.from("bank_accounts").update({ feed_ledger: b.ledger, feed_balance_at: b.date }).eq("id", b.id), "bank_accounts");
  }

  const hard = result.problems.find((p) => p.kind === "disconnected" || p.kind === "error");
  // last_sync_at only moves on a clean run: it sets how far back the next
  // sync reads, so a failed account keeps its window until it works again.
  await mark({
    status: hard?.kind === "disconnected" ? "disconnected" : hard ? "error" : "active",
    last_error: hard ? hard.detail : null,
    accounts: (feedAccounts || []).map(slimAccount),
    ...(hard ? {} : { last_sync_at: (ctx.now || new Date()).toISOString() }),
  });
  return result;
}

export async function syncAll(ctx, opts) {
  const conns = must(await ctx.db.from("bank_feed_connections").select("*").order("id"), "bank_feed_connections") || [];
  const total = { connections: conns.length, imported: 0, skipped: { pending: 0, before_since: 0, already: 0, duplicate: 0 }, problems: [] };
  for (const c of conns) {
    try {
      const r = await syncConnection(ctx, c, opts);
      total.imported += r.imported;
      for (const k of Object.keys(total.skipped)) total.skipped[k] += r.skipped[k];
      total.problems.push(...r.problems);
    } catch (e) {
      total.problems.push({ kind: "error", label: c.institution || "Bank", detail: e?.message || String(e) });
    }
  }
  return total;
}

// ── Connect / link / disconnect ──────────────────────────────────────────────
const TOKEN_RE = /^[A-Za-z0-9_\-.]{8,200}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// Teller Connect's onSuccess hands the browser an access token. It is saved
// only after it proves it can read the accounts. Reconnecting the same
// enrollment replaces its token and clears the error.
export async function saveEnrollment(ctx, { accessToken, enrollmentId, institution }) {
  if (!TOKEN_RE.test(String(accessToken || ""))) throw new Error("invalid access token");
  if (!TOKEN_RE.test(String(enrollmentId || ""))) throw new Error("invalid enrollment id");
  const accounts = await ctx.teller("/accounts", accessToken, ctx.cfg);
  const row = must(await ctx.db.from("bank_feed_connections").upsert({
    provider: FEED_SOURCE, enrollment_id: enrollmentId, access_token: accessToken,
    institution: String(institution || accounts?.[0]?.institution?.name || "Bank").slice(0, 80),
    accounts: (accounts || []).map(slimAccount), status: "active", last_error: null,
    created_by: ctx.actor || null, updated_at: new Date().toISOString(),
  }, { onConflict: "enrollment_id" }).select("id").single(), "bank_feed_connections");
  return row.id;
}

// The first email must not list the whole history of an account linked today:
// it starts from whatever is in the ledger right now.
async function baselineDigest(db) {
  const s = await getDigestSettings(db);
  if (s.last_sent_txn_id != null) return;
  const top = must(await db.from("bank_transactions").select("id").order("id", { ascending: false }).limit(1), "bank_transactions");
  must(await db.from("bank_digest_settings").upsert({ id: 1, last_sent_txn_id: top?.[0]?.id || 0 }, { onConflict: "id" }), "bank_digest_settings");
}

// links: [{ feed_account_id, bank_account_id: id | "new" | "", since }]
export async function saveLinks(ctx, { connectionId, links = [] }) {
  const { db } = ctx;
  const conn = must(await db.from("bank_feed_connections").select("id, institution, accounts").eq("id", connectionId).maybeSingle(), "bank_feed_connections");
  if (!conn) throw new Error("connection not found");
  const crm = must(await db.from("bank_accounts").select("id, feed_account_id, feed_since"), "bank_accounts") || [];
  const today = todayInTz(ctx.now);
  await baselineDigest(db);
  const clear = { feed_connection_id: null, feed_account_id: null, feed_ledger: null, feed_balance_at: null };
  let backfill = false;

  for (const l of links) {
    const fa = (conn.accounts || []).find((a) => a.id === l.feed_account_id);
    if (!fa) continue;
    const since = ISO_DATE.test(String(l.since || "")) ? l.since : today;
    // `crm` is kept in step with every write below, so a swap (A→1, B→2 while
    // 1 held B) never clears a link this same save just made.
    const holder = crm.find((c) => c.feed_account_id === fa.id);
    const release = async () => {
      if (!holder) return;
      must(await db.from("bank_accounts").update(clear).eq("id", holder.id), "bank_accounts");
      holder.feed_account_id = null;
    };
    const target = l.bank_account_id === "new" || l.bank_account_id === "" ? l.bank_account_id : Number(l.bank_account_id);

    if (target === "") { await release(); continue; }
    if (!isFeedSupported(fa)) throw new Error(`${newAccountName(fa)}: only checking and savings accounts can be imported`);
    const feed = { feed_connection_id: conn.id, feed_account_id: fa.id, feed_since: since };

    if (target === "new") {
      await release();
      const created = must(await db.from("bank_accounts").insert({
        name: newAccountName(fa), bank_name: fa.institution?.name || conn.institution || null,
        account_last4: fa.last_four || null, type: crmTypeOf(fa), currency: "USD", active: true, ...feed,
      }).select("id").single(), "bank_accounts");
      crm.push({ id: created.id, feed_account_id: fa.id, feed_since: since });
      backfill = true;
      continue;
    }
    const acc = crm.find((c) => c.id === target);
    if (!acc) throw new Error(`bank account ${target} not found`);
    if (holder && holder.id !== acc.id) await release();
    if (acc.feed_account_id !== fa.id || !acc.feed_since || since < acc.feed_since) backfill = true;
    must(await db.from("bank_accounts").update(feed).eq("id", acc.id), "bank_accounts");
    acc.feed_account_id = fa.id;
    acc.feed_since = since;
  }
  const full = must(await db.from("bank_feed_connections").select("*").eq("id", conn.id).single(), "bank_feed_connections");
  return syncConnection(ctx, full, { backfill });
}

export async function disconnect(ctx, connectionId) {
  const { db } = ctx;
  const conn = must(await db.from("bank_feed_connections").select("*").eq("id", connectionId).maybeSingle(), "bank_feed_connections");
  if (!conn) return;
  // Revoke on Teller's side too, so the enrollment stops being billed. Best
  // effort: the bank side may already be gone.
  try { await ctx.teller("/accounts", conn.access_token, ctx.cfg, { method: "DELETE" }); } catch { /* already gone */ }
  must(await db.from("bank_accounts").update({ feed_connection_id: null, feed_account_id: null, feed_ledger: null, feed_balance_at: null })
    .eq("feed_connection_id", conn.id), "bank_accounts");
  must(await db.from("bank_feed_connections").delete().eq("id", conn.id), "bank_feed_connections");
}

// ── Status (the Bancos panel) ────────────────────────────────────────────────
const DEFAULT_SETTINGS = { id: 1, recipients: "", lang: "en", enabled: true, last_sent_txn_id: null, last_sent_at: null };
export async function getDigestSettings(db) {
  const row = must(await db.from("bank_digest_settings").select("*").eq("id", 1).maybeSingle(), "bank_digest_settings");
  return { ...DEFAULT_SETTINGS, ...(row || {}) };
}

export async function feedStatus(ctx) {
  const { db, cfg } = ctx;
  const conns = await db.from("bank_feed_connections").select("id, enrollment_id, institution, status, last_error, last_sync_at, accounts, created_at").order("id");
  const crm = await db.from("bank_accounts").select("id, name, account_last4, active, feed_account_id, feed_since").order("name");
  const settings = await db.from("bank_digest_settings").select("*").eq("id", 1).maybeSingle();
  const broken = [conns, crm, settings].find((r) => r.error);
  const setup = { configured: cfg.ready, environment: cfg.environment, missing: cfg.missing };
  if (broken) {
    if (isMissingSchema(broken.error)) return { tablesMissing: true, ...setup };
    throw new Error(broken.error.message);
  }
  const today = todayInTz(ctx.now);
  const s = { ...DEFAULT_SETTINGS, ...(settings.data || {}) };
  return {
    tablesMissing: false,
    ...setup,
    appId: cfg.ready ? cfg.appId : null,
    // Never the token, even if a select above ever widens to "*".
    connections: (conns.data || []).map(({ access_token: _token, ...c }) => ({ ...c, links: proposeLinks(c.accounts || [], crm.data || [], today) })),
    settings: { recipients: s.recipients || "", lang: s.lang || "en", enabled: s.enabled !== false, last_sent_at: s.last_sent_at },
  };
}

export async function saveDigestSettings(ctx, { recipients, lang, enabled }) {
  must(await ctx.db.from("bank_digest_settings").upsert({
    id: 1, recipients, lang: lang === "es" ? "es" : "en", enabled: enabled !== false,
    updated_by: ctx.actor || null, updated_at: new Date().toISOString(),
  }, { onConflict: "id" }), "bank_digest_settings");
}

// ── The email ────────────────────────────────────────────────────────────────
// Everything that landed in the linked accounts since the last email.
//   -> { ...buildDigest(), ack } — ack goes back with POST /api/bank-digest
//      once Gmail has sent it.
export async function composeDigest(ctx, { settings, problems = [], appUrl = "" }) {
  const { db } = ctx;
  const accounts = must(await db.from("bank_accounts")
    .select("id, name, account_last4, bank_name, feed_ledger, feed_balance_at")
    .not("feed_account_id", "is", null).order("name"), "bank_accounts") || [];
  const ids = accounts.map((a) => a.id);
  let txns = [], unreviewed = 0, baseline = 0;
  if (ids.length) {
    let q = db.from("bank_transactions").select("id, bank_account_id, txn_date, amount, raw_description, category, status")
      .in("bank_account_id", ids).order("id", { ascending: true }).limit(2000);
    if (settings.last_sent_txn_id != null) q = q.gt("id", settings.last_sent_txn_id);
    else {
      // Never sent and never baselined: the last two days, then it is.
      q = q.gte("txn_date", new Date((ctx.now || new Date()).getTime() - 2 * 86400000).toISOString().slice(0, 10));
      const top = must(await db.from("bank_transactions").select("id").order("id", { ascending: false }).limit(1), "bank_transactions");
      baseline = top?.[0]?.id || 0;
    }
    txns = must(await q, "bank_transactions") || [];
    const c = await db.from("bank_transactions").select("id", { count: "exact", head: true }).in("bank_account_id", ids).eq("status", "unreviewed");
    if (c.error) throw new Error(`bank_transactions: ${c.error.message}`);
    unreviewed = c.count || 0;
  }
  const d = buildDigest({ accounts, txns, unreviewed, problems, since: settings.last_sent_at, now: ctx.now || new Date(), lang: settings.lang, appUrl });
  return { ...d, accounts: accounts.length, ack: Math.max(d.ackId || 0, baseline) || null };
}

export async function ackDigest(db, id) {
  const s = await getDigestSettings(db);
  const next = Math.max(Number(s.last_sent_txn_id) || 0, Number(id) || 0);
  must(await db.from("bank_digest_settings").upsert({ id: 1, last_sent_txn_id: next, last_sent_at: new Date().toISOString() }, { onConflict: "id" }), "bank_digest_settings");
}

// The problems a preview shows without re-syncing: what the last sync left.
export const problemsFromStatus = (status) => (status?.connections || [])
  .filter((c) => c.status === "disconnected" || c.status === "error")
  .map((c) => ({ kind: c.status === "disconnected" ? "disconnected" : "error", label: c.institution, detail: c.last_error }));
