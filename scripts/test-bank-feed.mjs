// The bank feed end to end (lib/bankFeed.mjs) against an in-memory stand-in
// for supabase-js and a fake Plaid: connect → link accounts → first sync →
// daily email → ack → re-sync → a bank that asks to sign in again → repair →
// disconnect. The same flow runs against Plaid's real Sandbox with
// scripts/plaid-sandbox-check.mjs.
// Run: node scripts/test-bank-feed.mjs (npm test picks it up).
import assert from "node:assert/strict";
import {
  plaidConfig, PlaidError, saveEnrollment, saveLinks, syncAll, feedStatus, composeDigest, ackDigest,
  getDigestSettings, disconnect, problemsFromStatus, createLinkToken, repairConnection,
} from "../lib/bankFeed.mjs";
import { dedupHash } from "../src/bankData.js";
import { fakeDb } from "./fake-supabase.mjs";

const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + (e.stack || e.message)); process.exitCode = 1; } };

// ── Fake Plaid ───────────────────────────────────────────────────────────────
// /transactions/sync is modeled as Plaid describes it: an ordered stream of
// updates per Item and a cursor that points into it. Amounts use Plaid's sign
// (positive = money out).
function fakePlaid({ pageCap = Infinity } = {}) {
  const accounts = [
    { account_id: "acc_3387", name: "TOTAL CHECKING", mask: "3387", type: "depository", subtype: "checking", balances: { current: 2466.23, available: 2466.23 } },
    { account_id: "acc_1173", name: "BUS COMPLETE CHK", mask: "1173", type: "depository", subtype: "checking", balances: { current: 15805.06, available: 14718.13 } },
    { account_id: "acc_card", name: "INK BUSINESS", mask: "9001", type: "credit", subtype: "credit card", balances: { current: 120 } },
  ];
  const p = (id, account_id, date, amount, original_description, extra = {}) => ({
    transaction_id: id, account_id, date, amount, original_description, name: original_description.toLowerCase(),
    merchant_name: null, pending: false, ...extra,
  });
  const stream = [
    p("t1", "acc_1173", "2026-09-28", 5, "BEFORE START"),
    p("t2", "acc_1173", "2026-10-02", -2500, "DEPOSIT ALLIED", { merchant_name: "Allied" }),
    p("t3", "acc_1173", "2026-10-05", 89.1, "SHELL OIL"),
    p("t4", "acc_1173", "2026-10-06", 50, "PILOT #123"),
    p("t5", "acc_1173", "2026-10-06", 50, "PILOT #123"),
    p("t6", "acc_1173", "2026-10-07", 12, "PENDING CHARGE", { pending: true }),
    p("u1", "acc_3387", "2026-10-05", 300, "INSURANCE"),
    p("c1", "acc_card", "2026-10-05", 40, "AMAZON"),
  ];
  const state = { notReady: false, mutateOnce: false, loginRequired: false, removed: [], calls: [], exchanged: 0 };
  const plaid = async (path, body) => {
    state.calls.push({ path, body });
    if (path === "/link/token/create") return { link_token: "link-sandbox-abc", expiration: "2026-10-08T16:00:00Z" };
    if (path === "/item/public_token/exchange") {
      if (body.public_token.includes("bad")) throw new PlaidError(400, "INVALID_PUBLIC_TOKEN", "provided public token is in an invalid format");
      state.exchanged++;
      return { access_token: "access-sandbox-11111111-2222", item_id: "item_abc" };
    }
    if (path === "/item/remove") { state.removed.push(body.access_token); return { request_id: "r" }; }
    if (state.loginRequired) throw new PlaidError(400, "ITEM_LOGIN_REQUIRED", "the login details of this item have changed");
    if (path === "/accounts/get") return { accounts, item: { item_id: "item_abc", institution_name: "Chase" } };
    if (path === "/transactions/sync") {
      if (state.notReady) return { added: [], modified: [], removed: [], next_cursor: "", has_more: false, transactions_update_status: "NOT_READY" };
      const start = body.cursor ? Number(body.cursor.slice(1)) : 0;
      if (state.mutateOnce && start > 0) { state.mutateOnce = false; throw new PlaidError(400, "TRANSACTIONS_SYNC_MUTATION_DURING_PAGINATION", "mutation during pagination"); }
      const page = stream.slice(start, start + Math.min(body.count || 100, pageCap));
      const next = start + page.length;
      return { added: page, modified: [], removed: [], next_cursor: "c" + next, has_more: next < stream.length, transactions_update_status: "HISTORICAL_UPDATE_COMPLETE", accounts: [] };
    }
    throw new PlaidError(404, "NOT_FOUND", path);
  };
  return { plaid, state, stream, p };
}

function world() {
  const shot = { bank_account_id: 1, txn_date: "2026-10-02", amount: 2500, raw_description: "Deposit  ALLIED" };
  return fakeDb({
    bank_accounts: [
      { id: 1, name: "Chase Bank", bank_name: "Chase", account_last4: "1173", type: "checking", active: true, feed_account_id: null },
      { id: 2, name: "Amex Platinum", bank_name: "American Express", account_last4: "1004", type: "credit_card", active: true, feed_account_id: null },
    ],
    bank_transactions: [
      { id: 40, bank_account_id: 2, txn_date: "2026-09-01", amount: -10, raw_description: "AMEX FEE", dedup_hash: "amex", source: "csv", status: "verified" },
      // The 10-02 deposit was already loaded from a screenshot.
      { id: 50, ...shot, dedup_hash: dedupHash(shot), source: "screenshot", status: "verified" },
    ],
    bank_import_batches: [],
    bank_categories: [],
    bank_feed_connections: [],
    bank_digest_settings: [{ id: 1, recipients: "owner@example.com", lang: "en", enabled: true, last_sent_txn_id: null, last_sent_at: null }],
  }, {
    bank_transactions: ["dedup_hash"],
    bank_accounts: ["feed_account_id"],
    bank_feed_connections: ["item_id"],
  });
}

const cfg = { environment: "sandbox", clientId: "cid", secret: "sec", base: "https://sandbox.plaid.com", missing: [], ready: true };
const NOW = new Date("2026-10-08T12:05:00Z");

async function connected({ since = "2026-10-01", plaidOpts } = {}) {
  const sb = world();
  const fp = fakePlaid(plaidOpts);
  const ctx = { db: sb, cfg, plaid: fp.plaid, actor: "Bauti", now: NOW };
  const connectionId = await saveEnrollment(ctx, { publicToken: "public-sandbox-1234abcd-5678", institution: "Chase" });
  const status = await feedStatus(ctx);
  const links = status.connections[0].links.map((l) => ({ ...l, since }));
  const sync = await saveLinks(ctx, { connectionId, links });
  return { sb, fp, ctx, connectionId, status, sync };
}

await ta("plaidConfig: both keys required; Production unless PLAID_ENV=sandbox", async () => {
  assert.deepEqual(plaidConfig({}).missing, ["PLAID_CLIENT_ID", "PLAID_SECRET"]);
  const c = plaidConfig({ PLAID_CLIENT_ID: " cid ", PLAID_SECRET: '"sec"' });
  assert.equal(c.ready, true);
  assert.equal(c.clientId, "cid");
  assert.equal(c.secret, "sec");
  assert.equal(c.environment, "production");
  assert.equal(c.base, "https://production.plaid.com");
  assert.equal(plaidConfig({ PLAID_CLIENT_ID: "a", PLAID_SECRET: "b", PLAID_ENV: "Sandbox" }).base, "https://sandbox.plaid.com");
});

await ta("feedStatus: before the migration the panel is told to run it", async () => {
  const st = await feedStatus({ db: fakeDb({ bank_accounts: [] }), cfg });
  assert.equal(st.tablesMissing, true);
  assert.equal(st.configured, true);
});

await ta("link token: a new connection asks for transactions; Reconnect opens update mode on the same one", async () => {
  const { ctx, fp, connectionId } = await connected();
  await createLinkToken(ctx, { userId: "user-1", lang: "es" });
  const fresh = fp.state.calls.filter((c) => c.path === "/link/token/create").at(-1).body;
  assert.deepEqual(fresh.products, ["transactions"]);
  assert.equal(fresh.access_token, undefined);
  assert.equal(fresh.language, "es");
  assert.deepEqual(fresh.country_codes, ["US"]);
  assert.equal(fresh.user.client_user_id, "user-1");
  await createLinkToken(ctx, { userId: "user-1", lang: "en", connectionId });
  const update = fp.state.calls.filter((c) => c.path === "/link/token/create").at(-1).body;
  assert.equal(update.access_token, "access-sandbox-11111111-2222");
  assert.equal(update.products, undefined, "update mode must not list products");
});

await ta("connect: the public token is swapped server-side; the token never reaches the panel", async () => {
  const { sb, status } = await connected();
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.access_token, "access-sandbox-11111111-2222");
  assert.equal(conn.item_id, "item_abc");
  assert.equal(conn.provider, "plaid");
  assert.equal(conn.accounts.length, 3);
  assert.equal(JSON.stringify(conn.accounts).includes("balances"), false, "only the fields the panel needs are cached");
  assert.equal(JSON.stringify(status).includes("access-sandbox"), false);
  const [p3387, p1173, card] = status.connections[0].links;
  assert.equal(p3387.bank_account_id, "new");
  assert.equal(p1173.bank_account_id, 1);
  assert.equal(card.bank_account_id, "");
});

await ta("link + first sync: posted lines from the start date, money out negative, deduped against the screenshot", async () => {
  const { sb, sync } = await connected();
  const created = sb.db.bank_accounts.find((a) => a.feed_account_id === "acc_3387");
  assert.equal(created.name, "Chase TOTAL CHECKING");
  assert.equal(created.account_last4, "3387");
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_account_id, "acc_1173");
  assert.equal(sb.db.bank_accounts.some((a) => a.feed_account_id === "acc_card"), false);

  const feed = sb.db.bank_transactions.filter((t) => t.source === "plaid");
  assert.deepEqual(feed.map((t) => t.source_ref).sort(), ["t3", "t4", "t5", "u1"]);
  assert.equal(feed.find((t) => t.source_ref === "t3").amount, -89.1, "Plaid's +89.10 (money out) is −89.10 in the ledger");
  assert.equal(feed.find((t) => t.source_ref === "t3").direction, "out");
  assert.equal(sync.imported, 4);
  assert.equal(sync.skipped.duplicate, 1, "t2 is the screenshot row");
  assert.equal(sync.skipped.pending, 1);
  assert.equal(sync.skipped.before_since, 1);
  assert.ok(feed.every((t) => t.status === "unreviewed" && t.import_batch_id && t.created_by === "Bauti"));
  assert.equal(sb.db.bank_import_batches.length, 1);
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_ledger, 15805.06, "balance = /accounts/get current");
  assert.equal(created.feed_ledger, 2466.23);
  assert.equal(created.feed_balance_at, "2026-10-08");
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.status, "active");
  assert.equal(conn.sync_cursor, "c8");
  assert.equal(conn.last_sync_at, NOW.toISOString());
  // The email baseline is what was in the ledger before the first import.
  assert.equal(sb.db.bank_digest_settings[0].last_sent_txn_id, 50);
});

await ta("cost guard: never the per-call billed endpoints", async () => {
  const { fp, ctx } = await connected();
  await syncAll(ctx);
  assert.equal(fp.state.calls.some((c) => c.path === "/accounts/balance/get" || c.path === "/transactions/refresh"), false);
});

await ta("daily email: lists exactly the new lines; after the ack the next one starts after them", async () => {
  const { sb, ctx, fp } = await connected();
  let settings = await getDigestSettings(sb);
  const d1 = await composeDigest(ctx, { settings });
  assert.equal(d1.count, 4);
  assert.ok(d1.subject.startsWith("Chase · Thu, Oct 8: 4 new transactions"));
  assert.ok(!d1.text.includes("AMEX FEE"), "unlinked accounts stay out");
  assert.ok(d1.text.includes("4 transactions are waiting for review"));
  await ackDigest(sb, d1.ack);
  settings = await getDigestSettings(sb);
  assert.equal(settings.last_sent_txn_id, d1.ack);
  assert.equal((await composeDigest(ctx, { settings })).count, 0);

  // Next morning: the cursor is at the end, so nothing comes twice; a new
  // posting shows up once.
  assert.equal((await syncAll(ctx)).imported, 0);
  fp.stream.push(fp.p("t7", "acc_1173", "2026-10-08", -1800, "ZELLE FROM CUSTOMER"));
  assert.equal((await syncAll(ctx)).imported, 1);
  const d2 = await composeDigest(ctx, { settings });
  assert.equal(d2.count, 1);
  assert.ok(d2.text.includes("ZELLE FROM CUSTOMER"));
  assert.ok(d2.text.includes("$1,800.00"));
});

await ta("an email that never went out is not lost: without the ack, the next one repeats it", async () => {
  const { sb, ctx } = await connected();
  assert.equal((await composeDigest(ctx, { settings: await getDigestSettings(sb) })).count, 4);
  assert.equal((await composeDigest(ctx, { settings: await getDigestSettings(sb) })).count, 4);
});

await ta("category guesses are stored with the line; a failing guesser never blocks the import", async () => {
  const sb = world();
  const fp = fakePlaid();
  const suggest = async (rows) => { for (const r of rows) if (/SHELL|PILOT/.test(r.raw_description)) { r.category = "Fuel"; r.ai_suggested_category = "Fuel"; r.ai_confidence = 0.9; } };
  const ctx = { db: sb, cfg, plaid: fp.plaid, suggest, now: NOW };
  const id = await saveEnrollment(ctx, { publicToken: "public-sandbox-1234abcd-5678" });
  await saveLinks(ctx, { connectionId: id, links: (await feedStatus(ctx)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" })) });
  const shell = sb.db.bank_transactions.find((t) => t.source_ref === "t3");
  assert.equal(shell.category, "Fuel");
  assert.equal(shell.status, "unreviewed", "a guess is never a decision");

  const sb2 = world();
  const ctx2 = { db: sb2, cfg, plaid: fakePlaid().plaid, suggest: async () => { throw new Error("AI timeout"); }, now: NOW };
  const id2 = await saveEnrollment(ctx2, { publicToken: "public-sandbox-1234abcd-5678" });
  const r = await saveLinks(ctx2, { connectionId: id2, links: (await feedStatus(ctx2)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" })) });
  assert.equal(r.imported, 4);
});

await ta("bank asks to sign in again: flagged on the connection and in the email; Reconnect repairs it and catches up", async () => {
  const { sb, ctx, fp, connectionId } = await connected();
  fp.state.loginRequired = true;
  const later = { ...ctx, now: new Date("2026-10-09T12:05:00Z") };
  const r = await syncAll(later);
  assert.equal(r.problems[0].kind, "disconnected");
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.status, "disconnected");
  assert.equal(conn.sync_cursor, "c8", "a failed run doesn't move the cursor");
  const d = await composeDigest(later, { settings: await getDigestSettings(sb), problems: r.problems });
  assert.ok(d.subject.startsWith("⚠ "));
  assert.ok(d.html.includes("Reconnect"));
  assert.equal(problemsFromStatus(await feedStatus(later))[0].kind, "disconnected");

  // Link in update mode succeeds: same connection, same token, no exchange.
  fp.state.loginRequired = false;
  fp.stream.push(fp.p("t8", "acc_1173", "2026-10-09", 20, "TOLL"));
  const exchangesBefore = fp.state.exchanged;
  const repaired = await repairConnection(later, connectionId);
  assert.equal(fp.state.exchanged, exchangesBefore);
  assert.equal(sb.db.bank_feed_connections.length, 1);
  assert.equal(sb.db.bank_feed_connections[0].status, "active");
  assert.equal(repaired.imported, 1);
});

await ta("a public token that fails to exchange saves nothing; a malformed one is never sent", async () => {
  const sb = world();
  const fp = fakePlaid();
  const ctx = { db: sb, cfg, plaid: fp.plaid, now: NOW };
  await assert.rejects(saveEnrollment(ctx, { publicToken: "public-sandbox-bad00000" }), /invalid format/);
  await assert.rejects(saveEnrollment(ctx, { publicToken: "x y" }), /invalid public token/);
  assert.equal(sb.db.bank_feed_connections.length, 0);
  assert.equal(fp.state.calls.filter((c) => c.path === "/item/public_token/exchange").length, 1);
});

await ta("relinking: swapping two accounts keeps both links; unlinking stops the import", async () => {
  const { sb, ctx, connectionId } = await connected();
  const newId = sb.db.bank_accounts.find((a) => a.feed_account_id === "acc_3387").id;
  await saveLinks(ctx, { connectionId, links: [
    { feed_account_id: "acc_3387", bank_account_id: 1, since: "2026-10-01" },
    { feed_account_id: "acc_1173", bank_account_id: newId, since: "2026-10-01" },
  ] });
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_account_id, "acc_3387");
  assert.equal(sb.db.bank_accounts.find((a) => a.id === newId).feed_account_id, "acc_1173");

  await saveLinks(ctx, { connectionId, links: [{ feed_account_id: "acc_3387", bank_account_id: "" }] });
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_account_id, null);
  await assert.rejects(saveLinks(ctx, { connectionId, links: [{ feed_account_id: "acc_card", bank_account_id: "new" }] }), /only checking and savings/);
});

await ta("linking an account later reads Plaid's history again for it, without doubling the others", async () => {
  const sb = world();
  const fp = fakePlaid();
  const ctx = { db: sb, cfg, plaid: fp.plaid, now: NOW };
  const id = await saveEnrollment(ctx, { publicToken: "public-sandbox-1234abcd-5678" });
  // First only the 1173 account…
  await saveLinks(ctx, { connectionId: id, links: [{ feed_account_id: "acc_1173", bank_account_id: 1, since: "2026-10-01" }] });
  assert.equal(sb.db.bank_transactions.some((t) => t.source_ref === "u1"), false);
  assert.equal(sb.db.bank_feed_connections[0].sync_cursor, "c8", "the cursor went past u1");
  // …then 3387 too: its line from before is still imported, the rest is not doubled.
  const r = await saveLinks(ctx, { connectionId: id, links: [{ feed_account_id: "acc_3387", bank_account_id: "new", since: "2026-10-01" }] });
  assert.equal(r.imported, 1);
  assert.equal(sb.db.bank_transactions.filter((t) => t.source_ref === "u1").length, 1);
  assert.equal(sb.db.bank_transactions.filter((t) => t.source === "plaid").length, 4);
});

await ta("pagination: every page is read; a mutation mid-way restarts from the first cursor", async () => {
  const { sb, sync } = await connected({ plaidOpts: { pageCap: 3 } });
  assert.equal(sync.imported, 4, "eight updates, three per page");
  assert.equal(sb.db.bank_feed_connections[0].sync_cursor, "c8");

  const s2 = world();
  const fp2 = fakePlaid({ pageCap: 3 });
  fp2.state.mutateOnce = true;
  const ctx2 = { db: s2, cfg, plaid: fp2.plaid, now: NOW };
  const id2 = await saveEnrollment(ctx2, { publicToken: "public-sandbox-1234abcd-5678" });
  const r = await saveLinks(ctx2, { connectionId: id2, links: (await feedStatus(ctx2)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" })) });
  assert.equal(r.imported, 4);
  const syncCalls = fp2.state.calls.filter((c) => c.path === "/transactions/sync");
  assert.equal(syncCalls.filter((c) => !c.body.cursor).length, 2, "restarted from the loop's first cursor (none)");
});

await ta("right after connecting Plaid may still be gathering the history: nothing lost, it comes on the next sync", async () => {
  const sb = world();
  const fp = fakePlaid();
  fp.state.notReady = true;
  const ctx = { db: sb, cfg, plaid: fp.plaid, now: NOW };
  const id = await saveEnrollment(ctx, { publicToken: "public-sandbox-1234abcd-5678" });
  const first = await saveLinks(ctx, { connectionId: id, links: (await feedStatus(ctx)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" })) });
  assert.equal(first.loading, true);
  assert.equal(first.imported, 0);
  assert.equal(sb.db.bank_feed_connections[0].sync_cursor, null);
  fp.state.notReady = false;
  const second = await syncAll(ctx);
  assert.equal(second.loading, false);
  assert.equal(second.imported, 4);
});

await ta("disconnect: removed at Plaid, links cleared, token gone, ledger untouched", async () => {
  const { sb, ctx, fp, connectionId } = await connected();
  const before = sb.db.bank_transactions.length;
  await disconnect(ctx, connectionId);
  assert.deepEqual(fp.state.removed, ["access-sandbox-11111111-2222"]);
  assert.equal(sb.db.bank_feed_connections.length, 0);
  assert.equal(sb.db.bank_accounts.filter((a) => a.feed_account_id).length, 0);
  assert.equal(sb.db.bank_transactions.length, before);
});

await ta("never baselined: the email covers the last two days only, then sets the baseline", async () => {
  const sb = world();
  sb.db.bank_accounts[0].feed_account_id = "acc_1173";
  sb.db.bank_transactions.push(
    { id: 60, bank_account_id: 1, txn_date: "2026-10-07", amount: -9, raw_description: "RECENT", dedup_hash: "r", source: "manual" },
    { id: 61, bank_account_id: 1, txn_date: "2026-08-01", amount: -9, raw_description: "ANCIENT", dedup_hash: "a", source: "manual" },
  );
  const d = await composeDigest({ db: sb, now: NOW }, { settings: await getDigestSettings(sb) });
  assert.equal(d.count, 1);
  assert.ok(d.text.includes("RECENT") && !d.text.includes("ANCIENT"));
  assert.equal(d.ack, 61);
});

// ── The door (api/bank-analyze.mjs) ──────────────────────────────────────────
// Only the auth decisions: they run before any database or bank is touched.
{
  process.env.ANTHROPIC_API_KEY ||= "test-key"; // the SDK client is built at import
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { default: handler } = await import("../api/bank-analyze.mjs");
  const fakeRes = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } });
  const hit = async (req) => { const res = fakeRes(); await handler({ headers: {}, query: {}, body: {}, ...req }, res); return res; };
  const digest = (headers, method = "GET") => hit({ method, headers, query: { action: "digest" } });

  await ta("digest endpoint: no BANK_DIGEST_SECRET → nobody gets in", async () => {
    delete process.env.BANK_DIGEST_SECRET;
    assert.equal((await digest({ "x-digest-secret": "anything" })).statusCode, 503);
  });
  await ta("digest endpoint: wrong or missing secret → 401, for the email and for the ack", async () => {
    process.env.BANK_DIGEST_SECRET = "s3cret-digest";
    assert.equal((await digest({ "x-digest-secret": "nope" })).statusCode, 401);
    assert.equal((await digest({})).statusCode, 401);
    assert.equal((await digest({ "x-digest-secret": "nope" }, "POST")).statusCode, 401);
    // Right secret gets past the door (and stops at the missing service key here).
    assert.equal((await digest({ "x-digest-secret": "s3cret-digest" })).statusCode, 500);
  });
  await ta("panel actions and the screenshot reader still need a logged-in user", async () => {
    assert.equal((await hit({ method: "GET", body: { action: "feed_status" } })).statusCode, 405);
    assert.equal((await hit({ method: "POST", body: { action: "feed_link_token" } })).body.error.includes("SUPABASE_SERVICE_ROLE_KEY"), true);
  });
}
