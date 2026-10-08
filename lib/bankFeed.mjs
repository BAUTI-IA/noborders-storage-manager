// Bank feed — the I/O half: Plaid's API and the Supabase reads/writes. The
// rules (what gets imported, what the email says) are pure and live in
// src/bankFeedData.js; the HTTP surface is api/bank-analyze.mjs (feed_* and
// digest_* actions, and /api/bank-digest for the Gmail script). See
// docs/bank-feed.md.
//
// Plaid authenticates the APPLICATION with client_id + secret (Vercel env
// only) and the CONNECTION ("Item") with its access token. A leaked token
// reads nothing without the secret. The browser only ever holds a short-lived
// link_token and a one-time public_token; the access token never leaves the
// server.
//
// Cost guard (Plaid bills these per call, docs "Pricing and billing"): nothing
// here calls /accounts/balance/get or /transactions/refresh. The balance comes
// from /accounts/get, which is free, and is as recent as the last transaction
// update.
//
// Every function takes a context { db, cfg, plaid, suggest?, actor?, now? }
// so the whole flow can run against fakes without a bank or a database.
import {
  FEED_SOURCE, planFeedImport, todayInTz, fromPlaidTxn, fromPlaidAccount,
  newAccountName, crmTypeOf, isFeedSupported, proposeLinks, buildDigest,
} from "../src/bankFeedData.js";

const SYNC_PAGE = 500;  // Plaid's maximum for /transactions/sync
const MAX_PAGES = 40;   // 20,000 updates per run; anything past that comes next run

const cleanEnv = (v) => String(v || "").trim().replace(/^["']+|["']+$/g, "");

export function plaidConfig(env = process.env) {
  // The free Trial plan runs on Plaid's Production environment.
  const environment = cleanEnv(env.PLAID_ENV).toLowerCase() === "sandbox" ? "sandbox" : "production";
  const clientId = cleanEnv(env.PLAID_CLIENT_ID);
  const secret = cleanEnv(env.PLAID_SECRET);
  const missing = [];
  if (!clientId) missing.push("PLAID_CLIENT_ID");
  if (!secret) missing.push("PLAID_SECRET");
  return { environment, clientId, secret, base: `https://${environment}.plaid.com`, missing, ready: missing.length === 0 };
}

export class PlaidError extends Error {
  constructor(status, code, message) {
    super(message || `Plaid HTTP ${status}`);
    this.status = status;
    this.code = code || "";
  }
}
// The bank wants the person back (signed out, password changed, consent
// expired…): only Reconnect from the Bancos panel (Link in update mode) fixes it.
const NEEDS_USER = new Set([
  "ITEM_LOGIN_REQUIRED", "PENDING_EXPIRATION", "PENDING_DISCONNECT", "ITEM_LOCKED",
  "PASSWORD_RESET_REQUIRED", "USER_SETUP_REQUIRED", "ACCESS_NOT_GRANTED", "NO_ACCOUNTS",
  "INVALID_CREDENTIALS", "INVALID_MFA",
]);
export const isDisconnected = (e) => NEEDS_USER.has(e?.code || "");

export async function plaidFetch(path, body, cfg, { timeoutMs = 30000 } = {}) {
  const res = await fetch(cfg.base + path, {
    method: "POST",
    headers: { "Content-Type": "application/json", "PLAID-CLIENT-ID": cfg.clientId, "PLAID-SECRET": cfg.secret },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let json = null;
  try { json = await res.json(); } catch { /* not JSON */ }
  if (res.ok) return json;
  throw new PlaidError(res.status, json?.error_code, json?.display_message || json?.error_message || `Plaid HTTP ${res.status}`);
}

export const isMissingSchema = (error) =>
  ["42P01", "42703", "PGRST204", "PGRST205"].includes(error?.code) || /does not exist|schema cache/i.test(error?.message || "");

const must = ({ data, error }, what) => {
  if (error) throw new Error(`${what}: ${error.message}`);
  return data;
};

// Every transaction Plaid added since the stored cursor. Plaid's rule: if a
// page fails mid-way (the data changed while paging), restart the whole loop
// from the cursor the loop began with — never resume from the failed page.
async function pullAdded(ctx, conn) {
  for (let attempt = 0; attempt < 3; attempt++) {
    let cursor = conn.sync_cursor || null;
    const added = [];
    let status = null, more = true, pages = 0;
    try {
      while (more && pages < MAX_PAGES) {
        const r = await ctx.plaid("/transactions/sync", {
          access_token: conn.access_token, ...(cursor ? { cursor } : {}),
          count: SYNC_PAGE, options: { include_original_description: true },
        }, ctx.cfg);
        // `modified` (a posted line edited by the bank) and `removed` are left
        // alone: an imported row is already in a person's hands. A pending
        // line that posts arrives here again as a new posted one.
        added.push(...(r.added || []));
        status = r.transactions_update_status || status;
        cursor = r.next_cursor || cursor;
        more = !!r.has_more;
        pages++;
      }
      return { added, cursor, status };
    } catch (e) {
      if (e?.code === "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION") continue;
      throw e;
    }
  }
  throw new PlaidError(400, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "Plaid kept changing the data while it was being read. It will be read again on the next sync.");
}

const problemFrom = (e, label) => ({ kind: isDisconnected(e) ? "disconnected" : "error", label, detail: e?.message || String(e) });

// Pull one connection's linked accounts into bank_transactions.
//   -> { imported, skipped, problems, loading } — loading: Plaid is still
//      gathering the history right after connecting.
export async function syncConnection(ctx, conn) {
  const { db } = ctx;
  const label = conn.institution || "Bank";
  const result = { imported: 0, skipped: { pending: 0, before_since: 0, already: 0, duplicate: 0 }, problems: [], loading: false };
  const mark = async (patch) => must(await db.from("bank_feed_connections")
    .update({ ...patch, updated_at: new Date().toISOString() }).eq("id", conn.id), "bank_feed_connections");

  let pulled, accounts;
  try {
    pulled = await pullAdded(ctx, conn);
    accounts = await ctx.plaid("/accounts/get", { access_token: conn.access_token }, ctx.cfg);
  } catch (e) {
    const p = problemFrom(e, label);
    await mark({ status: p.kind === "disconnected" ? "disconnected" : "error", last_error: p.detail });
    result.problems.push(p);
    return result;
  }
  result.loading = pulled.status === "NOT_READY";
  const bankAccounts = (accounts?.accounts || []).map((a) => fromPlaidAccount(a, label));

  const linked = must(await db.from("bank_accounts").select("id, name, feed_account_id, feed_since")
    .eq("feed_connection_id", conn.id), "bank_accounts") || [];
  const byAccount = new Map();
  for (const t of pulled.added) {
    const n = fromPlaidTxn(t);
    if (!byAccount.has(n.account_id)) byAccount.set(n.account_id, []);
    byAccount.get(n.account_id).push(n);
  }
  const rows = [];
  for (const acc of linked) {
    if (!acc.feed_account_id) continue;
    const fa = bankAccounts.find((a) => a.id === acc.feed_account_id);
    if (!fa) { result.problems.push({ kind: "missing_account", label: acc.name }); continue; }
    if (!isFeedSupported(fa)) continue;
    const txns = byAccount.get(fa.id) || [];
    if (!txns.length) continue;
    const floor = txns.reduce((m, t) => (t.date && t.date < m ? t.date : m), "9999-12-31");
    const existing = must(await db.from("bank_transactions").select("dedup_hash, source, source_ref")
      .eq("bank_account_id", acc.id).gte("txn_date", floor).limit(20000), "bank_transactions") || [];
    const plan = planFeedImport({ txns, account: acc, existing });
    rows.push(...plan.rows);
    for (const k of Object.keys(result.skipped)) result.skipped[k] += plan.skipped[k];
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
  const today = todayInTz(ctx.now);
  for (const acc of linked) {
    const raw = (accounts?.accounts || []).find((a) => a.account_id === acc.feed_account_id);
    const current = raw?.balances?.current;
    if (current == null) continue;
    must(await db.from("bank_accounts").update({ feed_ledger: current, feed_balance_at: today }).eq("id", acc.id), "bank_accounts");
  }

  // The cursor only moves once its lines are safely stored: a failure above
  // throws before this, and the next sync reads the same updates again.
  const hard = result.problems.find((p) => p.kind === "disconnected" || p.kind === "error");
  await mark({
    status: hard?.kind === "disconnected" ? "disconnected" : hard ? "error" : "active",
    last_error: hard ? hard.detail : null,
    accounts: bankAccounts,
    sync_cursor: pulled.cursor,
    last_sync_at: (ctx.now || new Date()).toISOString(),
  });
  return result;
}

export async function syncAll(ctx) {
  const conns = must(await ctx.db.from("bank_feed_connections").select("*").order("id"), "bank_feed_connections") || [];
  const total = { connections: conns.length, imported: 0, skipped: { pending: 0, before_since: 0, already: 0, duplicate: 0 }, problems: [], loading: false };
  for (const c of conns) {
    try {
      const r = await syncConnection(ctx, c);
      total.imported += r.imported;
      for (const k of Object.keys(total.skipped)) total.skipped[k] += r.skipped[k];
      total.problems.push(...r.problems);
      total.loading = total.loading || r.loading;
    } catch (e) {
      total.problems.push({ kind: "error", label: c.institution || "Bank", detail: e?.message || String(e) });
    }
  }
  return total;
}

// ── Connect / link / disconnect ──────────────────────────────────────────────
const PUBLIC_TOKEN_RE = /^public-(sandbox|production)-[A-Za-z0-9-]{8,}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

// The short-lived token the browser needs to open Plaid Link. With a
// connection id it opens Link in update mode on that same connection (the
// bank asked to sign in again): same access token, no new connection used.
export async function createLinkToken(ctx, { userId, lang, connectionId }) {
  const body = {
    client_name: "No Borders CRM",
    language: lang === "es" ? "es" : "en",
    country_codes: ["US"],
    user: { client_user_id: String(userId) },
  };
  if (connectionId) {
    const conn = must(await ctx.db.from("bank_feed_connections").select("access_token").eq("id", connectionId).maybeSingle(), "bank_feed_connections");
    if (!conn) throw new Error("connection not found");
    body.access_token = conn.access_token;
  } else {
    body.products = ["transactions"];
    body.transactions = { days_requested: 90 };
  }
  const r = await ctx.plaid("/link/token/create", body, ctx.cfg);
  return r.link_token;
}

// Link's onSuccess hands the browser a one-time public_token; the server swaps
// it for the access token, which is stored and never sent back out.
export async function saveEnrollment(ctx, { publicToken, institution }) {
  if (!PUBLIC_TOKEN_RE.test(String(publicToken || ""))) throw new Error("invalid public token");
  const ex = await ctx.plaid("/item/public_token/exchange", { public_token: publicToken }, ctx.cfg);
  const acc = await ctx.plaid("/accounts/get", { access_token: ex.access_token }, ctx.cfg);
  const name = String(institution || acc?.item?.institution_name || "Bank").slice(0, 80);
  const row = must(await ctx.db.from("bank_feed_connections").upsert({
    provider: FEED_SOURCE, item_id: ex.item_id, access_token: ex.access_token, sync_cursor: null,
    institution: name, accounts: (acc?.accounts || []).map((a) => fromPlaidAccount(a, name)),
    status: "active", last_error: null, created_by: ctx.actor || null, updated_at: new Date().toISOString(),
  }, { onConflict: "item_id" }).select("id").single(), "bank_feed_connections");
  return row.id;
}

// After Link in update mode: the same connection works again. Clear the flag
// and catch up on what was missed.
export async function repairConnection(ctx, connectionId) {
  const conn = must(await ctx.db.from("bank_feed_connections").select("*").eq("id", connectionId).maybeSingle(), "bank_feed_connections");
  if (!conn) throw new Error("connection not found");
  must(await ctx.db.from("bank_feed_connections").update({ status: "active", last_error: null, updated_at: new Date().toISOString() }).eq("id", conn.id), "bank_feed_connections");
  return syncConnection(ctx, { ...conn, status: "active" });
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
  // Lines of accounts that were not linked were read and dropped; a newly
  // linked account (or an earlier start date) needs Plaid's history again.
  let rewind = false;

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
      rewind = true;
      continue;
    }
    const acc = crm.find((c) => c.id === target);
    if (!acc) throw new Error(`bank account ${target} not found`);
    if (holder && holder.id !== acc.id) await release();
    if (acc.feed_account_id !== fa.id || !acc.feed_since || since < acc.feed_since) rewind = true;
    must(await db.from("bank_accounts").update(feed).eq("id", acc.id), "bank_accounts");
    acc.feed_account_id = fa.id;
    acc.feed_since = since;
  }
  if (rewind) must(await db.from("bank_feed_connections").update({ sync_cursor: null }).eq("id", conn.id), "bank_feed_connections");
  const full = must(await db.from("bank_feed_connections").select("*").eq("id", conn.id).single(), "bank_feed_connections");
  return syncConnection(ctx, full);
}

export async function disconnect(ctx, connectionId) {
  const { db } = ctx;
  const conn = must(await db.from("bank_feed_connections").select("*").eq("id", connectionId).maybeSingle(), "bank_feed_connections");
  if (!conn) return;
  // Revoke on Plaid's side too (/item/remove), so the access token dies with
  // the row. Best effort: the bank side may already be gone.
  try { await ctx.plaid("/item/remove", { access_token: conn.access_token }, ctx.cfg); } catch { /* already gone */ }
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
  const conns = await db.from("bank_feed_connections").select("id, institution, status, last_error, last_sync_at, accounts, created_at").order("id");
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
