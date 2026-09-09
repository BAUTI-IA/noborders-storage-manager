// Fixture tests for the Field Expenses pure logic (src/expensesData.js).
// Run: node scripts/test-expenses-data.mjs
import assert from "node:assert/strict";
import {
  EXPENSE_CATEGORIES, FIELD_CAT_BY_BANK, expenseCatMeta,
  isFieldBankCategory, mergeFieldExpenses, fieldExpenseTotals,
} from "../src/expensesData.js";
import { SEED_BANK_CATEGORIES } from "../src/bankData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

t("catalog: the seven original values survive (rows in the DB point at them)", () => {
  for (const v of ["fuel", "hotel", "materials", "tolls", "maintenance", "meals", "other"])
    assert.ok(EXPENSE_CATEGORIES.some(c => c.v === v), v + " disappeared — existing expenses would break");
  assert.equal(new Set(EXPENSE_CATEGORIES.map(c => c.v)).size, EXPENSE_CATEGORIES.length, "duplicate category value");
  assert.equal(expenseCatMeta("nope").v, "other", "unknown category must fall back to Other");
});

t("catalog: every bank mapping points at a category that really exists", () => {
  const known = new Set(SEED_BANK_CATEGORIES.map(c => c.name));
  for (const c of EXPENSE_CATEGORIES) {
    if (!c.bank) continue;
    assert.ok(known.has(c.bank), `${c.v} maps to "${c.bank}", which is not in the bank chart of accounts`);
  }
  assert.ok(isFieldBankCategory("Fuel"));
  assert.ok(!isFieldBankCategory("Software Licenses"), "an office cost is not a field expense");
  assert.ok(!isFieldBankCategory(""));
});

// ── merge ───────────────────────────────────────────────────────────────────
const expenses = [
  // Paid by bank AND typed here: same cost, must collapse into one row.
  { id: 1, expense_date: "2026-07-02", amount: 89.1, category: "fuel", paid_from: "bank", vendor: "Shell", driver_id: 7, truck_id: 3, job_number: "J-100" },
  // Driver cash: the bank will never see it.
  { id: 2, expense_date: "2026-07-03", amount: 40, category: "meals", paid_from: "driver_cash", vendor: "Wendy's", driver_id: 7 },
];
const bankTxns = [
  { id: 100, txn_date: "2026-07-02", amount: 89.1, direction: "out", raw_description: "SHELL OIL", category: "Fuel", status: "verified" },
  { id: 101, txn_date: "2026-07-05", amount: 300, direction: "out", raw_description: "MOTEL 6", category: "Hotels", status: "verified" },
  { id: 102, txn_date: "2026-07-06", amount: 1200, direction: "out", raw_description: "ADOBE", category: "Software Licenses", status: "verified" },
  { id: 103, txn_date: "2026-07-07", amount: 5000, direction: "in", raw_description: "CUSTOMER", category: "Job", status: "verified" },
  { id: 104, txn_date: "2026-07-08", amount: 60, direction: "out", raw_description: "IGNORED", category: "Fuel", status: "ignored" },
];

t("merge: a bank-paid expense and its statement line collapse into ONE row", () => {
  const rows = mergeFieldExpenses({ expenses, bankTxns });
  const fuel = rows.filter(r => r.category === "fuel");
  assert.equal(fuel.length, 1, "the same fuel cost was counted twice");
  assert.equal(fuel[0].source, "manual", "the manual row wins — it is the one carrying the attribution");
  assert.equal(fuel[0].reconciled, true);
  assert.equal(fuel[0].truckId, 3);
});

t("merge: only field costs come off the statement", () => {
  const rows = mergeFieldExpenses({ expenses, bankTxns });
  const fromBank = rows.filter(r => r.source === "bank");
  assert.deepEqual(fromBank.map(r => r.id), [101], "office costs, income and ignored rows must stay out");
  assert.equal(fromBank[0].category, "hotel");
  assert.equal(fromBank[0].bankCategory, "Hotels");
  assert.equal(fromBank[0].amount, 300, "amounts come through positive");
});

t("merge: driver cash survives — the bank never sees it", () => {
  const rows = mergeFieldExpenses({ expenses, bankTxns });
  const cash = rows.find(r => r.id === 2 && r.source === "manual");
  assert.ok(cash, "a driver-cash expense disappeared");
  assert.equal(cash.reconciled, false);
});

t("merge: newest first", () => {
  const dates = mergeFieldExpenses({ expenses, bankTxns }).map(r => r.date);
  assert.deepEqual(dates, [...dates].sort().reverse());
});

t("totals: unattributed is the money nobody tied to a driver/truck/trip/job", () => {
  const rows = mergeFieldExpenses({ expenses, bankTxns });
  const tot = fieldExpenseTotals(rows);
  assert.equal(tot.count, 3);
  assert.ok(Math.abs(tot.total - (89.1 + 40 + 300)) < 1e-9);
  assert.equal(tot.fromBank, 300);
  assert.ok(Math.abs(tot.manual - 129.1) < 1e-9);
  // Only the Motel 6 line has no driver/truck/job on it.
  assert.equal(tot.unattributedCount, 1);
  assert.equal(tot.unattributed, 300);
});

t("merge: empty inputs don't explode", () => {
  assert.deepEqual(mergeFieldExpenses({}), []);
  assert.equal(fieldExpenseTotals([]).count, 0);
});
