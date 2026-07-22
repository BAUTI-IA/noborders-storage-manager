// Fixture tests for the Bancos pure math (src/bankData.js).
// Run: node scripts/test-bank-data.mjs
import assert from "node:assert/strict";
import {
  parseCsv, mapBankCsv, dedupHash, signedAmount,
  matchBankToPayments, matchBankToExpenses, reconcileBank, bankPnl, bankPnlStatement, pnlStatementFromRows,
  SEED_BANK_CATEGORIES, PNL_GROUPS, catByName, isTransferCat,
} from "../src/bankData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// ── CSV parsing ──────────────────────────────────────────────────────────────
t("parseCsv: quoted fields, escaped quotes, embedded commas", () => {
  const rows = parseCsv('Date,Description,Amount\n2026-07-01,"DEPOSIT, BRANCH ""A""",1200.50\n2026-07-02,SHELL OIL,-89.10\n');
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], ["2026-07-01", 'DEPOSIT, BRANCH "A"', "1200.50"]);
});

t("mapBankCsv: single signed amount column by header name", () => {
  const rows = parseCsv("Date,Description,Amount\n2026-07-01,DEPOSIT,1200.50\n2026-07-02,SHELL OIL,-89.10\n");
  const drafts = mapBankCsv(rows, { date: "Date", description: "Description", amount: "Amount" }, { bank_account_id: 1 });
  assert.equal(drafts.length, 2);
  assert.equal(drafts[0].amount, 1200.5);
  assert.equal(drafts[0].direction, "in");
  assert.equal(drafts[1].amount, -89.1);
  assert.equal(drafts[1].direction, "out");
  assert.ok(drafts[0].dedup_hash.includes("1|2026-07-01|1200.50"));
});

t("mapBankCsv: split debit/credit columns → signed amount", () => {
  const rows = parseCsv("Fecha,Detalle,Debito,Credito\n07/01,PAGO SHELL,89.10,\n07/02,DEPOSITO,,500.00\n");
  const drafts = mapBankCsv(rows, { date: "Fecha", description: "Detalle", debit: "Debito", credit: "Credito" });
  assert.equal(drafts[0].amount, -89.1);
  assert.equal(drafts[1].amount, 500);
});

t("mapBankCsv: parens negative + $ and thousands separators", () => {
  const rows = parseCsv('Date,Description,Amount\n2026-07-03,"FEE","($1,234.56)"\n');
  const drafts = mapBankCsv(rows, { date: 0, description: 1, amount: 2 });
  assert.equal(drafts[0].amount, -1234.56);
});

t("dedupHash: stable across whitespace/case; changes with amount", () => {
  const a = dedupHash({ bank_account_id: 1, txn_date: "2026-07-01", amount: 100, raw_description: "  Deposit   BRANCH " });
  const b = dedupHash({ bank_account_id: 1, txn_date: "2026-07-01", amount: 100.0, raw_description: "deposit branch" });
  const c = dedupHash({ bank_account_id: 1, txn_date: "2026-07-01", amount: 101, raw_description: "deposit branch" });
  assert.equal(a, b);
  assert.notEqual(a, c);
});

t("signedAmount: direction beats raw sign; signed passthrough", () => {
  assert.equal(signedAmount({ amount: 50, direction: "out" }), -50);
  assert.equal(signedAmount({ amount: -50, direction: "in" }), 50);
  assert.equal(signedAmount({ amount: -30 }), -30);
});

// ── Fixtures for reconciliation ─────────────────────────────────────────────
// Categories use the bookkeeper's Excel taxonomy (SEED_BANK_CATEGORIES), which
// is also what the DB seed contains: names like "Job", "Fuel", "Other",
// "Transfer Between Accounts" (is_transfer).
const payments = [
  { id: 1, method: "zelle", amount: 1200, discount: 0, received: true, received_date: "2026-07-01" }, // digital → auto-banked
  { id: 2, method: "cash", amount: 300, received: true, banked: true, banked_date: "2026-07-02" },
  { id: 3, method: "cash", amount: 999, received: true, banked: true, banked_date: "2026-07-02" },     // never hit the bank
  { id: 4, method: "cash", amount: 500, received: true, banked: false },                                // in circulation → not expected in bank
];
const expenses = [
  { id: 10, expense_date: "2026-07-02", amount: 89.1, paid_from: "bank", vendor: "Shell" },
  { id: 11, expense_date: "2026-07-05", amount: 250, paid_from: "bank", vendor: "Uline" },              // never hit the bank
  { id: 12, expense_date: "2026-07-03", amount: 40, paid_from: "driver_cash" },                         // not bank → ignored
];
const bankTxns = [
  { id: 100, txn_date: "2026-07-01", amount: 1200, direction: "in", raw_description: "ZELLE DEPOSIT", status: "verified", category: "Job" },
  { id: 101, txn_date: "2026-07-03", amount: 300, direction: "in", raw_description: "ATM DEPOSIT", status: "verified", category: "Job" },
  { id: 102, txn_date: "2026-07-02", amount: 89.1, direction: "out", raw_description: "SHELL OIL", status: "verified", category: "Fuel" },
  { id: 103, txn_date: "2026-07-04", amount: 777, direction: "out", raw_description: "UNKNOWN WIRE", status: "categorized", category: "Other" }, // no backing → discrepancy
  { id: 104, txn_date: "2026-07-05", amount: 1000, direction: "out", raw_description: "TRANSFER TO SAVINGS", status: "verified", category: "Transfer Between Accounts" },
  { id: 105, txn_date: "2026-07-05", amount: 60, direction: "out", raw_description: "IGNORED DUP", status: "ignored", category: "" },
];

t("matchBankToPayments: matches by amount+date; only banked payments participate", () => {
  const r = matchBankToPayments({ bankTxns, payments });
  assert.equal(r.matched.length, 2);
  assert.deepEqual(r.matched.map(m => [m.txn.id, m.payment.id]).sort(), [[100, 1], [101, 2]]);
  // payment 3 (banked, never arrived) unmatched; payment 4 (in circulation) excluded entirely
  assert.deepEqual(r.unmatchedPayments.map(p => p.id), [3]);
});

t("matchBankToExpenses: matches bank-paid expenses; driver_cash excluded", () => {
  const r = matchBankToExpenses({ bankTxns, expenses });
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].expense.id, 10);
  assert.deepEqual(r.unmatchedExpenses.map(e => e.id), [11]);
});

t("reconcileBank: discrepancy lists = no-backing + never-hit-bank; transfers/ignored excluded", () => {
  const r = reconcileBank({ bankTxns, payments, expenses });
  assert.equal(r.matchedCount, 3);
  assert.equal(r.transfersCount, 1);
  const kinds = r.discrepancies.map(d => d.kind).sort();
  assert.deepEqual(kinds, ["bank_no_backing", "expense_no_bank", "payment_no_bank"]);
  const noBacking = r.discrepancies.find(d => d.kind === "bank_no_backing");
  assert.equal(noBacking.txn.id, 103);
  assert.equal(r.discrepancies.find(d => d.kind === "payment_no_bank").payment.id, 3);
  assert.equal(r.discrepancies.find(d => d.kind === "expense_no_bank").expense.id, 11);
  assert.equal(r.balances.matchedIn, 1500);
  assert.ok(Math.abs(r.balances.matchedOut - 89.1) < 1e-9);
});

t("reconcileBank: links map points each matched txn at its counterpart", () => {
  const r = reconcileBank({ bankTxns, payments, expenses });
  assert.equal(r.links.get(100).payment_id, 1);
  assert.equal(r.links.get(102).expense_id, 10);
  assert.equal(r.links.get(103), undefined);
});

// ── Bank P&L ────────────────────────────────────────────────────────────────
t("bankPnl: verified-only, transfers excluded, per-category totals + net", () => {
  const r = bankPnl({ bankTxns, from: "2026-07-01", to: "2026-07-31" });
  // verified & non-transfer: +1200 +300 −89.10  (103 is categorized-only, 104 transfer, 105 ignored)
  assert.equal(r.income, 1500);
  assert.ok(Math.abs(r.expense - 89.1) < 1e-9);
  assert.ok(Math.abs(r.net - 1410.9) < 1e-9);
  assert.equal(r.count, 3);
  const job = r.categories.find(c => c.name === "Job");
  assert.equal(job.total, 1500);
  assert.equal(job.meta.direction, "in");
});

t("bankPnl: groups mirror the Excel P&L structure (Ingresos + Type groups)", () => {
  const r = bankPnl({ bankTxns, from: "2026-07-01", to: "2026-07-31", onlyVerified: false });
  const names = r.groups.map(g => g.group);
  assert.deepEqual(names, ["Ingresos", "Cost of Revenues", "Structure Expenses"]);
  assert.equal(r.groups[0].total, 1500);                            // Job
  assert.ok(Math.abs(r.groups[1].total - -89.1) < 1e-9);            // Fuel
  assert.ok(Math.abs(r.groups[2].total - -777) < 1e-9);             // Other
});

t("bankPnl: onlyVerified=false pulls in categorized rows", () => {
  const r = bankPnl({ bankTxns, from: "2026-07-01", to: "2026-07-31", onlyVerified: false });
  assert.ok(Math.abs(r.expense - (89.1 + 777)) < 1e-9);
});

t("bankPnl: monthly series zero-fills the range", () => {
  const r = bankPnl({ bankTxns, from: "2026-06-01", to: "2026-07-31" });
  assert.deepEqual(r.series.map(s => s.month), ["2026-06", "2026-07"]);
  assert.equal(r.series[0].net, 0);
});

t("bankPnlStatement: waterfall Revenue → Gross → Net with monthly columns", () => {
  const txns = [
    { id: 1, txn_date: "2026-06-10", amount: 1000, direction: "in", status: "verified", category: "Job" },
    { id: 2, txn_date: "2026-07-05", amount: 2000, direction: "in", status: "verified", category: "Job" },
    { id: 3, txn_date: "2026-07-06", amount: 600, direction: "out", status: "verified", category: "Fuel" },      // Cost of Revenues
    { id: 4, txn_date: "2026-07-07", amount: 300, direction: "out", status: "verified", category: "Fees" },      // Structure
    { id: 5, txn_date: "2026-07-08", amount: 100, direction: "out", status: "verified", category: "Transfer Between Accounts" },
  ];
  const r = bankPnlStatement({ bankTxns: txns, from: "2026-06-01", to: "2026-07-31" });
  assert.deepEqual(r.months, ["2026-06", "2026-07"]);
  assert.deepEqual(r.sections.map(s => s.group), ["Revenue", "Cost of Revenues", "Structure Expenses"]);
  assert.equal(r.sections[0].total, 3000);
  assert.equal(r.sections[0].byMonth["2026-07"], 2000);
  assert.equal(r.gross.total, 2400);            // 3000 − 600
  assert.equal(r.gross.byMonth["2026-07"], 1400); // 2000 − 600
  assert.equal(r.net.total, 2100);              // − 300 Fees; transfer excluded
  assert.equal(r.net.byMonth["2026-06"], 1000);
});

t("bankPnlStatement: 'Financing' excluded like a transfer (matches the RPC)", () => {
  const txns = [
    { id: 1, txn_date: "2026-07-01", amount: 1000, direction: "in", status: "verified", category: "Job" },
    { id: 2, txn_date: "2026-07-02", amount: 5000, direction: "in", status: "verified", category: "Financing" },
  ];
  const r = bankPnlStatement({ bankTxns: txns, from: "2026-07-01", to: "2026-07-31" });
  assert.equal(r.net.total, 1000);
});

t("pnlStatementFromRows: builds the same waterfall from bank_pnl RPC rows", () => {
  const rpcRows = [
    { month: "2026-06", category: "Job", direction: "in", pnl_group: null, total: 1000, txn_count: 3 },
    { month: "2026-07", category: "Job", direction: "in", pnl_group: null, total: 2000, txn_count: 5 },
    { month: "2026-07", category: "Fuel", direction: "out", pnl_group: "Cost of Revenues", total: -600, txn_count: 4 },
    { month: "2026-07", category: "Fees", direction: "out", pnl_group: "Structure Expenses", total: -300, txn_count: 2 },
    { month: "2026-07", category: "(sin categoría)", direction: null, pnl_group: null, total: -50, txn_count: 1 },
  ];
  const r = pnlStatementFromRows(rpcRows, { from: "2026-06-01", to: "2026-07-31" });
  assert.deepEqual(r.months, ["2026-06", "2026-07"]);
  assert.deepEqual(r.sections.map(s => s.group), ["Revenue", "Cost of Revenues", "Structure Expenses", "Otros egresos"]);
  assert.equal(r.sections[0].total, 3000);
  assert.equal(r.gross.total, 2400);
  assert.equal(r.gross.byMonth["2026-07"], 1400);
  assert.equal(r.net.total, 2050);
  assert.equal(r.count, 15);
});

// ── Catalog (seed = the Excel taxonomy; helpers accept a live DB catalog) ───
t("catalog: seed mirrors the Excel taxonomy; transfer detected; PNL groups valid", () => {
  for (const c of SEED_BANK_CATEGORIES) {
    assert.ok(c.is_transfer || ["in", "out"].includes(c.direction), c.name);
    if (c.pnl_group) assert.ok(PNL_GROUPS.includes(c.pnl_group), c.name);
  }
  for (const name of ["Job", "Refund", "Hotels", "Fuel", "Salaries - Employees", "Storage", "Broker", "Marketing", "Loren Expenses", "Bauti Expenses"])
    assert.ok(catByName([], name), name + " missing from seed");
  assert.ok(isTransferCat([], "Transfer Between Accounts"));
  assert.ok(!isTransferCat([], "Fuel"));
  assert.equal(catByName([], "nope"), null);
});

t("catalog: a live DB catalog (owner-added category) overrides the seed", () => {
  const live = [{ name: "Truck Wash", direction: "out", pnl_group: "Cost of Revenues", is_transfer: false }];
  assert.ok(catByName(live, "Truck Wash"));
  assert.equal(catByName(live, "Fuel"), null); // live catalog wins entirely
});
