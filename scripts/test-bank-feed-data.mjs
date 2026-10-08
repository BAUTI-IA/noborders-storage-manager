// Fixture tests for the bank feed + daily bank email (src/bankFeedData.js).
// Run: node scripts/test-bank-feed-data.mjs
import assert from "node:assert/strict";
import {
  FEED_SOURCE, proposeLinks, planFeedImport, fromPlaidTxn, fromPlaidAccount, ledgerAmount,
  parseRecipients, buildDigest, problemText, money, isFeedSupported, MAX_RECIPIENTS,
} from "../src/bankFeedData.js";
import { dedupHash } from "../src/bankData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// Plaid fixtures, shaped like /accounts/get and /transactions/sync. Plaid's
// amount is POSITIVE when money moves OUT (the opposite of the ledger).
const PA = [
  { account_id: "acc_3387", name: "TOTAL CHECKING", mask: "3387", type: "depository", subtype: "checking", balances: { current: 2466.23 } },
  { account_id: "acc_1173", name: "BUS COMPLETE CHK", mask: "1173", type: "depository", subtype: "checking", balances: { current: 15805.06 } },
  { account_id: "acc_card", name: "INK BUSINESS", mask: "9001", type: "credit", subtype: "credit card", balances: { current: 120 } },
];
const FA = PA.map((a) => fromPlaidAccount(a, "Chase"));
const ptx = (id, date, plaidAmount, description, extra = {}) => ({
  transaction_id: id, account_id: "acc_1173", date, amount: plaidAmount, name: description.toLowerCase(),
  original_description: description, merchant_name: null, pending: false, ...extra,
});
const tx = (...a) => fromPlaidTxn(ptx(...a));

// ── Plaid shapes ─────────────────────────────────────────────────────────────
t("ledgerAmount / fromPlaidTxn: Plaid's sign is flipped (positive = money out)", () => {
  assert.equal(ledgerAmount(89.1), -89.1);
  assert.equal(ledgerAmount(-2500), 2500);
  assert.equal(ledgerAmount(86.456), -86.46);
  const n = fromPlaidTxn(ptx("t1", "2026-10-06", 89.1, "SHELL OIL 57444", { merchant_name: "Shell" }));
  assert.deepEqual(n, { id: "t1", account_id: "acc_1173", date: "2026-10-06", amount: -89.1, description: "SHELL OIL 57444", counterparty: "Shell", pending: false });
  // No original_description from the bank → Plaid's cleaned name.
  assert.equal(fromPlaidTxn({ ...ptx("t2", "2026-10-06", 5, "X"), original_description: null, name: "Fee" }).description, "Fee");
});

t("fromPlaidAccount: last 4 from the mask, institution carried, no account number", () => {
  assert.deepEqual(FA[1], { id: "acc_1173", name: "BUS COMPLETE CHK", last_four: "1173", type: "depository", subtype: "checking", institution: { name: "Chase" } });
  assert.equal(JSON.stringify(FA).includes("balances"), false);
});

// ── Account links ────────────────────────────────────────────────────────────
t("proposeLinks: last-4 match, new for checking, skip for cards", () => {
  const crm = [{ id: 7, name: "Chase Bank", account_last4: "1173", active: true }, { id: 8, name: "Amex", account_last4: "1004" }];
  const p = proposeLinks(FA, crm, "2026-10-08");
  assert.equal(p.length, 3);
  assert.equal(p[0].bank_account_id, "new");
  assert.equal(p[1].bank_account_id, 7);
  assert.equal(p[2].bank_account_id, "");
  assert.equal(p[2].supported, false);
  assert.equal(p[0].since, "2026-10-08");
  assert.equal(p[1].label, "Chase BUS COMPLETE CHK ····1173");
});

t("proposeLinks: an existing link wins over a last-4 match and keeps its start date", () => {
  const crm = [
    { id: 7, name: "Old 1173", account_last4: "1173" },
    { id: 9, name: "Operating", account_last4: "", feed_account_id: "acc_1173", feed_since: "2026-09-01" },
  ];
  const p = proposeLinks(FA, crm, "2026-10-08");
  assert.equal(p[1].bank_account_id, 9);
  assert.equal(p[1].since, "2026-09-01");
  assert.equal(p[1].linked, true);
});

t("proposeLinks: one CRM account is never proposed for two bank accounts", () => {
  const twins = [{ ...FA[0], id: "a1", last_four: "5555" }, { ...FA[0], id: "a2", last_four: "5555" }];
  const p = proposeLinks(twins, [{ id: 3, name: "X", account_last4: "5555" }]);
  assert.equal(p[0].bank_account_id, 3);
  assert.equal(p[1].bank_account_id, "new");
});

t("isFeedSupported: checking/savings yes, cards no", () => {
  assert.equal(isFeedSupported(FA[0]), true);
  assert.equal(isFeedSupported(FA[2]), false);
});

// ── Import plan ──────────────────────────────────────────────────────────────
const acct = { id: 7, feed_since: "2026-10-01" };

t("planFeedImport: posted lines become unreviewed rows; money out is negative", () => {
  const { rows, skipped } = planFeedImport({
    account: acct,
    txns: [tx("t1", "2026-10-06", 89.1, "SHELL OIL"), tx("t2", "2026-10-06", -2500, "DEPOSIT", { merchant_name: "Allied" })],
  });
  assert.equal(rows.length, 2);
  const shell = rows.find((r) => r.source_ref === "t1");
  assert.equal(shell.amount, -89.1);
  assert.equal(shell.direction, "out");
  assert.equal(shell.status, "unreviewed");
  assert.equal(shell.source, FEED_SOURCE);
  assert.equal(shell.dedup_hash, dedupHash({ bank_account_id: 7, txn_date: "2026-10-06", amount: -89.1, raw_description: "SHELL OIL" }));
  const dep = rows.find((r) => r.source_ref === "t2");
  assert.equal(dep.amount, 2500);
  assert.equal(dep.direction, "in");
  assert.equal(dep.counterparty, "Allied");
  assert.deepEqual(skipped, { pending: 0, before_since: 0, already: 0, duplicate: 0 });
});

t("planFeedImport: pending lines and lines before the import start are left out", () => {
  const { rows, skipped } = planFeedImport({
    account: acct,
    txns: [tx("p1", "2026-10-07", 10, "PENDING THING", { pending: true }), tx("o1", "2026-09-30", 5, "OLD"), tx("k1", "2026-10-01", 5, "ON START DAY")],
  });
  assert.deepEqual(rows.map((r) => r.source_ref), ["k1"]);
  assert.equal(skipped.pending, 1);
  assert.equal(skipped.before_since, 1);
});

t("planFeedImport: a re-sync imports nothing twice", () => {
  const first = planFeedImport({ account: acct, txns: [tx("t1", "2026-10-06", 89.1, "SHELL OIL")] });
  const again = planFeedImport({ account: acct, txns: [tx("t1", "2026-10-06", 89.1, "SHELL OIL")], existing: first.rows });
  assert.equal(again.rows.length, 0);
  assert.equal(again.skipped.already, 1);
});

t("planFeedImport: a line already loaded from a screenshot is that row, not a new one", () => {
  const shot = { dedup_hash: dedupHash({ bank_account_id: 7, txn_date: "2026-10-06", amount: -89.1, raw_description: "Shell  oil" }), source: "screenshot", source_ref: "x.png" };
  const { rows, skipped } = planFeedImport({ account: acct, txns: [tx("t1", "2026-10-06", 89.1, "SHELL OIL")], existing: [shot] });
  assert.equal(rows.length, 0);
  assert.equal(skipped.duplicate, 1);
});

t("planFeedImport: two identical lines the same day are both real", () => {
  const txns = [tx("t9", "2026-10-06", 50, "PILOT #123"), tx("t8", "2026-10-06", 50, "PILOT #123")];
  const { rows } = planFeedImport({ account: acct, txns });
  assert.equal(rows.length, 2);
  assert.notEqual(rows[0].dedup_hash, rows[1].dedup_hash);
  // Stable across syncs: re-planning against what was stored adds nothing.
  assert.equal(planFeedImport({ account: acct, txns, existing: rows }).rows.length, 0);
});

t("planFeedImport: screenshot had one of an identical pair → the feed adds only the other", () => {
  const h = dedupHash({ bank_account_id: 7, txn_date: "2026-10-06", amount: -50, raw_description: "PILOT #123" });
  const txns = [tx("t8", "2026-10-06", 50, "PILOT #123"), tx("t9", "2026-10-06", 50, "PILOT #123")];
  const first = planFeedImport({ account: acct, txns, existing: [{ dedup_hash: h, source: "screenshot" }] });
  assert.equal(first.rows.length, 1);
  assert.equal(first.rows[0].dedup_hash, `${h}|${FEED_SOURCE}:t9`);
  const again = planFeedImport({ account: acct, txns, existing: [{ dedup_hash: h, source: "screenshot" }, ...first.rows] });
  assert.equal(again.rows.length, 0);
});

// ── Recipients ───────────────────────────────────────────────────────────────
t("parseRecipients: commas, spaces, newlines; dedup; invalid ones reported", () => {
  const r = parseRecipients("Bauti@NoBorders.com, loren@noborders.com;\nbauti@noborders.com  not-an-email");
  assert.deepEqual(r.valid, ["bauti@noborders.com", "loren@noborders.com"]);
  assert.deepEqual(r.invalid, ["not-an-email"]);
  const many = parseRecipients(Array.from({ length: MAX_RECIPIENTS + 2 }, (_, i) => `a${i}@x.com`).join(","));
  assert.equal(many.valid.length, MAX_RECIPIENTS);
  assert.equal(many.tooMany, true);
});

// ── Digest ───────────────────────────────────────────────────────────────────
const accounts = [
  { id: 7, name: "Chase Operating", account_last4: "1173", bank_name: "Chase", feed_ledger: 14718.13, feed_balance_at: "2026-10-07" },
  { id: 8, name: "Chase Payroll", account_last4: "3769", bank_name: "Chase", feed_ledger: null },
];
const rows = [
  { id: 101, bank_account_id: 7, txn_date: "2026-10-07", amount: 2500, raw_description: "DEPOSIT <ALLIED>", category: "Job" },
  { id: 103, bank_account_id: 7, txn_date: "2026-10-07", amount: -89.1, raw_description: "SHELL OIL", category: "Fuel" },
  { id: 102, bank_account_id: 8, txn_date: "2026-10-06", amount: -1200, raw_description: "PAYROLL", category: null },
];
const now = new Date("2026-10-08T12:05:00Z");

t("buildDigest: totals per account, subject, ack = highest id included", () => {
  const d = buildDigest({ accounts, txns: rows, unreviewed: 3, since: "2026-10-07T12:04:00Z", now, appUrl: "https://crm.example.com/" });
  assert.equal(d.count, 3);
  assert.equal(d.ackId, 103);
  assert.deepEqual(d.totals, { in: 2500, out: 1289.1 });
  assert.equal(d.subject, "Chase · Thu, Oct 8: 3 new transactions · in $2,500.00 · out $1,289.10");
  assert.ok(d.html.includes("Chase Operating ····1173"));
  assert.ok(d.html.includes("$14,718.13"));
  assert.ok(d.text.includes("3 transactions are waiting for review"));
  assert.ok(d.text.includes("https://crm.example.com"));
  // Newest first in the list.
  assert.ok(d.text.indexOf("DEPOSIT") < d.text.indexOf("PAYROLL"));
});

t("buildDigest: bank text is escaped in the HTML", () => {
  const d = buildDigest({ accounts, txns: rows, now });
  assert.ok(d.html.includes("DEPOSIT &lt;ALLIED&gt;"));
  assert.ok(!d.html.includes("<ALLIED>"));
});

t("buildDigest: a day with nothing still sends balances; problems flag the subject", () => {
  const d = buildDigest({ accounts, txns: [], now, problems: [{ kind: "disconnected", label: "Chase" }] });
  assert.equal(d.count, 0);
  assert.equal(d.ackId, null);
  assert.ok(d.subject.startsWith("⚠ Chase · Thu, Oct 8: no new transactions"));
  assert.ok(d.html.includes("Reconnect"));
  assert.ok(d.text.includes("Chase Operating ····1173"));
});

t("buildDigest: Spanish", () => {
  const d = buildDigest({ accounts, txns: rows.slice(0, 1), now, lang: "es" });
  assert.ok(d.subject.includes("1 movimiento nuevo"));
  assert.ok(d.html.includes("Resumen bancario diario"));
  assert.ok(d.text.includes("Primer resumen"));
});

t("buildDigest: the list is capped, the totals are not", () => {
  const lots = Array.from({ length: 12 }, (_, i) => ({ id: i + 1, bank_account_id: 7, txn_date: "2026-10-07", amount: -1, raw_description: "FEE " + i }));
  const d = buildDigest({ accounts, txns: lots, now, cap: 10 });
  assert.equal(d.totals.out, 12);
  assert.equal(d.ackId, 12);
  assert.ok(d.text.includes("…and 2 more in the CRM."));
});

t("problemText / money", () => {
  assert.ok(problemText({ kind: "not_configured", detail: "TELLER_CERT" }).includes("TELLER_CERT"));
  assert.ok(problemText({ kind: "error", label: "Chase", detail: "timeout" }, "es").includes("falló"));
  assert.equal(money(-1289.1), "−$1,289.10");
  assert.equal(money(0), "$0.00");
});
