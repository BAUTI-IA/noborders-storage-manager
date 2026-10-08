// The bank feed end to end (lib/bankFeed.mjs) against an in-memory stand-in
// for supabase-js and a fake Teller: connect → link accounts → first sync →
// daily email → ack → re-sync → a disconnected bank → disconnect.
// Run: node scripts/test-bank-feed.mjs (npm test picks it up).
import assert from "node:assert/strict";
import {
  tellerConfig, TellerError, saveEnrollment, saveLinks, syncAll, feedStatus, composeDigest, ackDigest,
  getDigestSettings, disconnect, problemsFromStatus,
} from "../lib/bankFeed.mjs";
import { dedupHash } from "../src/bankData.js";

const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + (e.stack || e.message)); process.exitCode = 1; } };

// ── PostgREST-shaped fake ────────────────────────────────────────────────────
// The chain shapes lib/bankFeed.mjs uses: select (with count/head), insert,
// upsert (onConflict, ignoreDuplicates), update, delete; eq/in/gt/gte/not-is;
// order/limit; single/maybeSingle. Ids are identity-like; `unique` columns
// reject duplicates like a unique index; a missing table answers 42P01.
function fakeDb(tables, unique = {}) {
  const db = structuredClone(tables);
  const seq = {};
  const nextId = (t) => (seq[t] = (seq[t] ?? Math.max(0, ...db[t].map((r) => Number(r.id) || 0))) + 1);
  const dup = (table, col, v, except = []) => v != null && db[table].some((x) => x[col] === v && !except.includes(x));
  function from(table) {
    const filters = [];
    let op = "select", payload = null, opts = {}, single = null, returning = false, order = null, limit = null, head = false;
    const b = {
      select(_cols, o = {}) { if (op === "select") head = !!o.head; else returning = true; return b; },
      insert(rows) { op = "insert"; payload = [].concat(rows); return b; },
      upsert(rows, o = {}) { op = "upsert"; payload = [].concat(rows); opts = o; return b; },
      update(p) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      gt(c, v) { filters.push((r) => r[c] > v); return b; },
      gte(c, v) { filters.push((r) => r[c] >= v); return b; },
      not(c, o, v) { assert.equal(o, "is"); filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return b; },
      order(c, { ascending = true } = {}) { order = { c, ascending }; return b; },
      limit(n) { limit = n; return b; },
      single() { single = "one"; return b; },
      maybeSingle() { single = "maybe"; return b; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    const run = () => {
      if (!db[table]) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      let out;
      if (op === "insert" || op === "upsert") {
        out = [];
        for (const r of payload) {
          const ex = opts.onConflict ? db[table].find((x) => x[opts.onConflict] === r[opts.onConflict]) : null;
          if (ex) { if (!opts.ignoreDuplicates) { Object.assign(ex, r); out.push(ex); } continue; }
          for (const u of unique[table] || []) if (dup(table, u, r[u])) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint (${u})` } };
          const row = { ...r, id: r.id ?? nextId(table) };
          db[table].push(row);
          out.push(row);
        }
      } else {
        const rows = db[table].filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const u of unique[table] || []) if (payload[u] != null && (rows.length > 1 || dup(table, u, payload[u], rows))) return { data: null, error: { code: "23505", message: `duplicate key (${u})` } };
          rows.forEach((r) => Object.assign(r, payload));
          out = rows;
        } else if (op === "delete") {
          db[table] = db[table].filter((r) => !rows.includes(r));
          out = rows;
        } else {
          out = [...rows];
          if (order) out.sort((x, y) => (x[order.c] > y[order.c] ? 1 : x[order.c] < y[order.c] ? -1 : 0) * (order.ascending ? 1 : -1));
          if (limit != null) out = out.slice(0, limit);
        }
      }
      if (head) return { data: null, count: out.length, error: null };
      let data = op === "select" || returning ? out.map((r) => structuredClone(r)) : null;
      if (single) {
        if (single === "one" && data?.length !== 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        data = data?.[0] ?? null;
      }
      return { data, error: null };
    };
    return b;
  }
  return { from, db };
}

// ── Fake Teller ──────────────────────────────────────────────────────────────
const chase = { id: "chase", name: "Chase" };
function fakeTeller() {
  const accounts = [
    { id: "acc_3387", name: "TOTAL CHECKING", last_four: "3387", type: "depository", subtype: "checking", institution: chase, links: { self: "x" } },
    { id: "acc_1173", name: "BUS COMPLETE CHK", last_four: "1173", type: "depository", subtype: "checking", institution: chase },
    { id: "acc_card", name: "INK BUSINESS", last_four: "9001", type: "credit", subtype: "credit_card", institution: chase },
  ];
  const p = (id, date, amount, description, extra = {}) => ({ id, date, amount: String(amount), description, status: "posted", ...extra });
  // Newest first, like the API.
  const txns = {
    acc_1173: [
      p("t6", "2026-10-07", -12, "PENDING CHARGE", { status: "pending" }),
      p("t5", "2026-10-06", -50, "PILOT #123", { running_balance: "14718.13" }),
      p("t4", "2026-10-06", -50, "PILOT #123"),
      p("t3", "2026-10-05", -89.1, "SHELL OIL"),
      p("t2", "2026-10-02", 2500, "DEPOSIT ALLIED", { details: { counterparty: { name: "ALLIED" } } }),
      p("t1", "2026-09-28", -5, "BEFORE START"),
    ],
    acc_3387: [p("u1", "2026-10-05", -300, "INSURANCE", { running_balance: "2466.23" })],
  };
  const calls = [];
  const teller = async (path, token, _cfg, { method = "GET" } = {}) => {
    calls.push({ path, token, method });
    if (token.startsWith("tok_bad")) throw new TellerError(404, "enrollment.disconnected.user_action.mfa_required", "The bank requires MFA");
    if (method === "DELETE") return null;
    if (path === "/accounts") return accounts;
    const m = path.match(/^\/accounts\/([^/]+)\/transactions\?(.*)$/);
    if (m) {
      const list = txns[decodeURIComponent(m[1])] || [];
      const qs = new URLSearchParams(m[2]);
      const start = qs.get("from_id") ? list.findIndex((t) => t.id === qs.get("from_id")) + 1 : 0;
      return list.slice(start, start + Number(qs.get("count") || 250));
    }
    throw new TellerError(404, "not_found", path);
  };
  return { teller, txns, calls, p };
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
    bank_feed_connections: ["enrollment_id"],
  });
}

const cfg = { environment: "sandbox", appId: "app_test", cert: "", key: "", missing: [], ready: true };
const NOW = new Date("2026-10-08T12:05:00Z");

async function connected() {
  const sb = world();
  const tl = fakeTeller();
  const ctx = { db: sb, cfg, teller: tl.teller, actor: "Bauti", now: NOW };
  const connectionId = await saveEnrollment(ctx, { accessToken: "tok_ok_123456", enrollmentId: "enr_12345678", institution: "Chase" });
  const status = await feedStatus(ctx);
  const links = status.connections[0].links.map((l) => ({ ...l, since: "2026-10-01" }));
  const sync = await saveLinks(ctx, { connectionId, links });
  return { sb, tl, ctx, connectionId, status, sync };
}

await ta("tellerConfig: development needs the certificate; PEM with literal \\n or base64 both work", async () => {
  assert.deepEqual(tellerConfig({ TELLER_APP_ID: "app_1" }).missing, ["TELLER_CERT", "TELLER_KEY"]);
  assert.equal(tellerConfig({ TELLER_APP_ID: "app_1", TELLER_ENV: "sandbox" }).ready, true);
  const pemText = "-----BEGIN CERTIFICATE-----\nAAA\n-----END CERTIFICATE-----";
  const c = tellerConfig({ TELLER_APP_ID: " app_1 ", TELLER_CERT: pemText.replace(/\n/g, "\\n"), TELLER_KEY: Buffer.from(pemText.replace(/CERTIFICATE/g, "PRIVATE KEY")).toString("base64") });
  assert.equal(c.ready, true);
  assert.equal(c.appId, "app_1");
  assert.equal(c.environment, "development");
  assert.ok(c.cert.includes("\nAAA\n"));
  assert.ok(c.key.startsWith("-----BEGIN PRIVATE KEY-----"));
});

await ta("feedStatus: before the migration the panel is told to run it", async () => {
  const sb = fakeDb({ bank_accounts: [] });
  const st = await feedStatus({ db: sb, cfg });
  assert.equal(st.tablesMissing, true);
  assert.equal(st.configured, true);
});

await ta("connect: the token is stored server-side and the accounts are proposed by last 4", async () => {
  const { sb, status } = await connected();
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.access_token, "tok_ok_123456");
  assert.equal(conn.accounts.length, 3);
  assert.equal(conn.accounts[0].links, undefined, "only the fields the panel needs are cached");
  // What the panel sees never carries the token.
  assert.equal(JSON.stringify(status).includes("tok_ok"), false);
  const [p3387, p1173, card] = status.connections[0].links;
  assert.equal(p3387.bank_account_id, "new");
  assert.equal(p1173.bank_account_id, 1);
  assert.equal(card.bank_account_id, "");
});

await ta("link + first sync: posted lines from the start date, deduped against the screenshot row", async () => {
  const { sb, sync } = await connected();
  const created = sb.db.bank_accounts.find((a) => a.feed_account_id === "acc_3387");
  assert.equal(created.name, "Chase TOTAL CHECKING");
  assert.equal(created.account_last4, "3387");
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_account_id, "acc_1173");
  assert.equal(sb.db.bank_accounts.some((a) => a.feed_account_id === "acc_card"), false);

  const feed = sb.db.bank_transactions.filter((t) => t.source === "teller");
  assert.deepEqual(feed.map((t) => t.source_ref).sort(), ["t3", "t4", "t5", "u1"]);
  assert.equal(sync.imported, 4);
  assert.equal(sync.skipped.duplicate, 1, "t2 is the screenshot row");
  assert.equal(sync.skipped.pending, 1);
  // t1 (09-28) is before the start date: never read into the plan at all.
  assert.ok(feed.every((t) => t.status === "unreviewed" && t.import_batch_id && t.created_by === "Bauti"));
  assert.equal(sb.db.bank_import_batches.length, 1);
  assert.equal(sb.db.bank_accounts.find((a) => a.id === 1).feed_ledger, 14718.13);
  assert.equal(created.feed_ledger, 2466.23);
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.status, "active");
  assert.equal(conn.last_sync_at, NOW.toISOString());
  // The email baseline is what was in the ledger before the first import.
  assert.equal(sb.db.bank_digest_settings[0].last_sent_txn_id, 50);
});

await ta("daily email: lists exactly the new lines; after the ack the next one starts after them", async () => {
  const { sb, ctx, tl } = await connected();
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

  // Next morning: a re-sync adds nothing twice, a new posting shows up once.
  assert.equal((await syncAll(ctx)).imported, 0);
  tl.txns.acc_1173.unshift(tl.p("t7", "2026-10-08", 1800, "ZELLE FROM CUSTOMER"));
  assert.equal((await syncAll(ctx)).imported, 1);
  const d2 = await composeDigest(ctx, { settings });
  assert.equal(d2.count, 1);
  assert.ok(d2.text.includes("ZELLE FROM CUSTOMER"));
});

await ta("an email that never went out is not lost: without the ack, the next one repeats it", async () => {
  const { sb, ctx } = await connected();
  const settings = await getDigestSettings(sb);
  assert.equal((await composeDigest(ctx, { settings })).count, 4);
  assert.equal((await composeDigest(ctx, { settings: await getDigestSettings(sb) })).count, 4);
});

await ta("category guesses are stored with the line; a failing guesser never blocks the import", async () => {
  const sb = world();
  const tl = fakeTeller();
  const suggest = async (rows) => { for (const r of rows) if (/SHELL|PILOT/.test(r.raw_description)) { r.category = "Fuel"; r.ai_suggested_category = "Fuel"; r.ai_confidence = 0.9; } };
  const ctx = { db: sb, cfg, teller: tl.teller, suggest, now: NOW };
  const id = await saveEnrollment(ctx, { accessToken: "tok_ok_123456", enrollmentId: "enr_12345678" });
  const links = (await feedStatus(ctx)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" }));
  await saveLinks(ctx, { connectionId: id, links });
  const shell = sb.db.bank_transactions.find((t) => t.source_ref === "t3");
  assert.equal(shell.category, "Fuel");
  assert.equal(shell.status, "unreviewed", "a guess is never a decision");

  const sb2 = world();
  const ctx2 = { db: sb2, cfg, teller: fakeTeller().teller, suggest: async () => { throw new Error("AI timeout"); }, now: NOW };
  const id2 = await saveEnrollment(ctx2, { accessToken: "tok_ok_123456", enrollmentId: "enr_12345678" });
  const r = await saveLinks(ctx2, { connectionId: id2, links: (await feedStatus(ctx2)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" })) });
  assert.ok(r.imported > 0);
});

await ta("bank asks to sign in again: flagged on the connection and in the email, window kept", async () => {
  const { sb, ctx } = await connected();
  sb.db.bank_feed_connections[0].access_token = "tok_bad_123456";
  const later = { ...ctx, now: new Date("2026-10-09T12:05:00Z") };
  const r = await syncAll(later);
  assert.equal(r.problems[0].kind, "disconnected");
  const conn = sb.db.bank_feed_connections[0];
  assert.equal(conn.status, "disconnected");
  assert.equal(conn.last_sync_at, NOW.toISOString(), "a failed run doesn't move the read window");
  const d = await composeDigest(later, { settings: await getDigestSettings(sb), problems: r.problems });
  assert.ok(d.subject.startsWith("⚠ "));
  assert.ok(d.html.includes("Reconnect"));
  assert.equal(problemsFromStatus(await feedStatus(later))[0].kind, "disconnected");

  // Reconnecting the same enrollment swaps the token and clears the flag.
  await saveEnrollment(ctx, { accessToken: "tok_ok_999999", enrollmentId: "enr_12345678", institution: "Chase" });
  assert.equal(sb.db.bank_feed_connections.length, 1);
  assert.equal(sb.db.bank_feed_connections[0].status, "active");
  assert.equal(sb.db.bank_feed_connections[0].access_token, "tok_ok_999999");
});

await ta("a later sync reads from its window only: older lines on the last page are not re-planned", async () => {
  const sb = world();
  const tl = fakeTeller();
  tl.txns.acc_1173.push(tl.p("t0", "2026-09-10", -7, "OLD BUT AFTER START"));
  const ctx = { db: sb, cfg, teller: tl.teller, now: NOW };
  const id = await saveEnrollment(ctx, { accessToken: "tok_ok_123456", enrollmentId: "enr_12345678" });
  const links = (await feedStatus(ctx)).connections[0].links.map((l) => ({ ...l, since: "2026-09-01" }));
  const first = await saveLinks(ctx, { connectionId: id, links });
  assert.ok(sb.db.bank_transactions.some((t) => t.source_ref === "t0"));
  assert.equal(first.imported, 6);
  // Next day the floor is last sync − 14 days (09-24): t0 (09-10) comes back on
  // the page but is outside the window, so nothing is counted or re-guessed.
  let guessed = 0;
  const r = await syncAll({ ...ctx, suggest: async (rows) => { guessed += rows.length; }, now: new Date("2026-10-09T12:05:00Z") });
  assert.equal(r.imported, 0);
  assert.equal(guessed, 0);
});

await ta("pagination: a short page is not the end; an empty or repeated page is", async () => {
  const sb = world();
  const tl = fakeTeller();
  const capped = async (path, token, c, o) => tl.teller(path.replace(/count=\d+/, "count=2"), token, c, o);
  const ctx = { db: sb, cfg, teller: capped, now: NOW };
  const id = await saveEnrollment(ctx, { accessToken: "tok_ok_123456", enrollmentId: "enr_12345678" });
  const links = (await feedStatus(ctx)).connections[0].links.map((l) => ({ ...l, since: "2026-10-01" }));
  const r = await saveLinks(ctx, { connectionId: id, links });
  assert.equal(r.imported, 4, "every line reached, two at a time");
});

await ta("a token that cannot read the bank is never saved", async () => {
  const sb = world();
  const ctx = { db: sb, cfg, teller: fakeTeller().teller, now: NOW };
  await assert.rejects(saveEnrollment(ctx, { accessToken: "tok_bad_123456", enrollmentId: "enr_12345678" }));
  await assert.rejects(saveEnrollment(ctx, { accessToken: "x y", enrollmentId: "enr_12345678" }), /invalid access token/);
  assert.equal(sb.db.bank_feed_connections.length, 0);
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

await ta("disconnect: revoked at Teller, links cleared, token gone, ledger untouched", async () => {
  const { sb, ctx, tl, connectionId } = await connected();
  const before = sb.db.bank_transactions.length;
  await disconnect(ctx, connectionId);
  assert.ok(tl.calls.some((c) => c.method === "DELETE" && c.path === "/accounts"));
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
    assert.equal((await hit({ method: "POST", body: { action: "feed_status" } })).body.error.includes("SUPABASE_SERVICE_ROLE_KEY"), true);
  });
}
