#!/usr/bin/env node
// Runs the bank feed (lib/bankFeed.mjs) against Plaid's real Sandbox — fake
// bank data, real API — with an in-memory database, so the integration is
// proven against Plaid itself and not only against our own fake of it:
//
//   create a Sandbox Item → exchange → link accounts → sync (sign, pending,
//   pagination, balances) → re-sync imports nothing twice → the bank asks to
//   sign in again (/sandbox/item/reset_login) → disconnect (/item/remove).
//
// Needs the SANDBOX keys from the Plaid Dashboard (Developers → Keys). It
// never touches Production or the CRM's database. Not part of `npm test`
// because it needs network access and keys.
//
//   PLAID_CLIENT_ID=... PLAID_SECRET=<sandbox secret> node scripts/plaid-sandbox-check.mjs
//
// In a Claude cloud environment the keys can instead be a network secret for
// sandbox.plaid.com (headers PLAID-CLIENT-ID and PLAID-SECRET) that the proxy
// adds to each request; then run it with no keys in env (and
// NODE_USE_ENV_PROXY=1 so Node's fetch goes through the proxy).
import assert from "node:assert/strict";
import {
  plaidConfig, plaidFetch, saveEnrollment, saveLinks, syncAll, feedStatus, composeDigest,
  getDigestSettings, disconnect,
} from "../lib/bankFeed.mjs";
import { fakeDb } from "./fake-supabase.mjs";

let cfg = plaidConfig({ ...process.env, PLAID_ENV: "sandbox" });
if (!cfg.ready) {
  console.log(`· no ${cfg.missing.join(" / ")} in env: relying on a network secret for sandbox.plaid.com to add the keys`);
  cfg = { ...cfg, ready: true };
}

const db = fakeDb({
  bank_accounts: [{ id: 1, name: "Old checking", bank_name: "First Platypus Bank", account_last4: "", type: "checking", active: true, feed_account_id: null }],
  bank_transactions: [],
  bank_import_batches: [],
  bank_categories: [],
  bank_feed_connections: [],
  bank_digest_settings: [{ id: 1, recipients: "", lang: "en", enabled: true, last_sent_txn_id: null, last_sent_at: null }],
}, { bank_transactions: ["dedup_hash"], bank_accounts: ["feed_account_id"], bank_feed_connections: ["item_id"] });

// Every Plaid response is kept, so the sign check below compares the ledger
// against exactly what Plaid sent.
const seen = new Map();
const plaid = async (path, body, c) => {
  const r = await plaidFetch(path, body, c);
  if (path === "/transactions/sync") for (const t of r.added || []) seen.set(t.transaction_id, t);
  return r;
};
const ctx = { db, cfg, plaid, actor: "sandbox-check" };
const step = (msg) => console.log("· " + msg);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// 1. An Item, the way Link would create it (First Platypus Bank, user_good).
const { public_token } = await plaidFetch("/sandbox/public_token/create", {
  institution_id: "ins_109508", initial_products: ["transactions"],
}, cfg);
const connectionId = await saveEnrollment(ctx, { publicToken: public_token, institution: "First Platypus Bank" });
const conn = db.db.bank_feed_connections[0];
assert.ok(conn.access_token.startsWith("access-sandbox-"));
step(`connected: item ${conn.item_id}, ${conn.accounts.length} accounts`);

// 2. Link every checking/savings account as a new CRM account, 60 days back.
const since = new Date(Date.now() - 60 * 86400000).toISOString().slice(0, 10);
const status = await feedStatus(ctx);
const links = status.connections[0].links.map((l) => ({ ...l, bank_account_id: l.supported ? "new" : "", since }));
step(`linking ${links.filter((l) => l.supported).length} accounts from ${since} (${links.filter((l) => !l.supported).length} cards/loans left out)`);
let sync = await saveLinks(ctx, { connectionId, links });

// 3. Plaid gathers the Sandbox history asynchronously; give it up to ~2 minutes.
for (let i = 0; i < 12 && (sync.loading || sync.imported === 0); i++) {
  step(sync.loading ? "Plaid is still gathering the history…" : "nothing yet, retrying…");
  await wait(10000);
  const r = await syncAll(ctx);
  sync = { ...r, imported: sync.imported + r.imported };
}
const rows = db.db.bank_transactions.filter((t) => t.source === "plaid");
assert.ok(rows.length > 0, "the Sandbox history should import");
step(`imported ${rows.length} posted lines (${sync.skipped.pending} pending left out, ${sync.skipped.before_since} before ${since})`);

// 4. The sign, against Plaid's own numbers: positive in Plaid = money out = negative here.
for (const r of rows) {
  const p = seen.get(r.source_ref);
  assert.ok(p, `Plaid sent ${r.source_ref}`);
  assert.equal(r.amount, Math.round(-p.amount * 100) / 100, `${r.raw_description}: ledger ${r.amount} vs Plaid ${p.amount}`);
  assert.equal(r.direction, p.amount > 0 ? "out" : "in");
  assert.equal(p.pending, false);
}
const ins = rows.filter((r) => r.amount > 0).length, outs = rows.filter((r) => r.amount < 0).length;
step(`sign checked on every line: ${outs} out (negative), ${ins} in (positive)`);

// 5. Balances from /accounts/get, and an idempotent re-sync.
const linked = db.db.bank_accounts.filter((a) => a.feed_account_id);
assert.ok(linked.some((a) => a.feed_ledger != null), "a balance from /accounts/get");
step(`balances: ${linked.map((a) => `${a.name} ${a.feed_ledger}`).join(" · ")}`);
const again = await syncAll(ctx);
assert.equal(again.imported, 0, "a re-sync imports nothing twice");
assert.equal(db.db.bank_transactions.filter((t) => t.source === "plaid").length, rows.length);
step("re-sync: nothing imported twice");

// 6. The email for it.
const d = await composeDigest(ctx, { settings: await getDigestSettings(db) });
step(`email: "${d.subject}"`);

// 7. The bank asks to sign in again.
await plaidFetch("/sandbox/item/reset_login", { access_token: conn.access_token }, cfg);
const broken = await syncAll(ctx);
assert.equal(broken.problems[0]?.kind, "disconnected", JSON.stringify(broken.problems));
assert.equal(db.db.bank_feed_connections[0].status, "disconnected");
step(`reset_login → flagged: "${broken.problems[0].detail}"`);

// 8. Disconnect removes the Item at Plaid; the token stops working.
const token = conn.access_token;
await disconnect(ctx, connectionId);
assert.equal(db.db.bank_feed_connections.length, 0);
await assert.rejects(plaidFetch("/accounts/get", { access_token: token }, cfg), (e) => { step(`after disconnect Plaid answers ${e.code}`); return true; });
console.log("✓ Plaid Sandbox: the bank feed works end to end.");
