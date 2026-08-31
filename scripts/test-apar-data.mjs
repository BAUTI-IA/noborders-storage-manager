// Fixture tests for the AP / AR pure math (src/aparData.js).
// Run: npm run test:apar
import assert from "node:assert/strict";
import {
  buildReceivables, buildPayables, buildDriverPayables,
  netPosition, aging, sumRows, overdueRows, dueWithin,
  nextDueDate, addMonthsISO, rentDueDate, dueBillsToGenerate, overdueBillIds,
} from "../src/aparData.js";
import { dedupeJobs, agingBuckets } from "../src/analyticsData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const TODAY = "2026-08-31";
const LABELS = ["0–30", "31–60", "61–90", "90+"];
const byId = (rows, id) => rows.find(r => r.id === id);

// ── Dates ────────────────────────────────────────────────────────────────────

t("addMonthsISO: clamps to the target month's last day", () => {
  assert.equal(addMonthsISO("2026-01-31", 1), "2026-02-28");
  assert.equal(addMonthsISO("2028-01-31", 1), "2028-02-29"); // leap year
  assert.equal(addMonthsISO("2026-01-15", 1), "2026-02-15");
  assert.equal(addMonthsISO("2026-12-15", 1), "2027-01-15"); // year rollover
});

t("nextDueDate: one step per recurrence, null for one-offs", () => {
  assert.equal(nextDueDate("2026-08-10", "monthly"), "2026-09-10");
  assert.equal(nextDueDate("2026-08-10", "quarterly"), "2026-11-10");
  assert.equal(nextDueDate("2026-08-10", "yearly"), "2027-08-10");
  assert.equal(nextDueDate("2026-08-10", "once"), null);
  assert.equal(nextDueDate(null, "monthly"), null);
});

t("rentDueDate: stored date wins; otherwise opened + 30d rolled to today", () => {
  assert.equal(rentDueDate({ payment_due_date: "2026-09-05", date_opened: "2020-01-01" }, TODAY), "2026-09-05");
  // Opened 2026-06-01 → 07-01, 07-31, 08-30, 09-29: first landing on/after today.
  assert.equal(rentDueDate({ date_opened: "2026-06-01" }, TODAY), "2026-09-29");
  assert.equal(rentDueDate({}, TODAY), null);
});

// ── Receivables ──────────────────────────────────────────────────────────────

// A split job: two storage_jobs rows share a job_number; the peeled-off portion
// carries zeroed money. dedupeJobs must collapse them into ONE receivable.
const splitJobRows = [
  { id: 1, job_number: "J-100", customer: "Ann", split_group: "g1", status: "delivered",
    pickup_balance: 1000, delivery_balance: 500, bol_balance: 0, bol_collected: 300,
    delivery_date: "2026-08-20", date_out: "2026-08-20" },
  { id: 2, job_number: "J-100", customer: "Ann", split_group: "g1", status: "delivered",
    pickup_balance: 0, delivery_balance: 0, bol_balance: 0, delivery_date: "2026-08-20", date_out: "2026-08-20" },
];
const scheduledJobRow = { id: 3, job_number: "J-200", customer: "Bob", status: "scheduled",
  pickup_balance: 900, delivery_balance: 0, bol_balance: 0, pickup_date: "2026-09-10" };
const cancelledJobRow = { id: 4, job_number: "J-300", customer: "Cid", status: "cancelled",
  pickup_balance: 700, delivery_balance: 0, bol_balance: 0, pickup_date: "2026-07-01" };
const oldJobRow = { id: 5, job_number: "J-400", customer: "Dee", status: "delivered",
  pickup_balance: 400, delivery_balance: 0, bol_balance: 0, delivery_date: "2026-04-01", date_out: "2026-04-01" };

const allJobRows = [...splitJobRows, scheduledJobRow, cancelledJobRow, oldJobRow];
const allGroups = [...dedupeJobs(allJobRows).values()];
// Stands in for App.jsx's jobOutstanding: balance minus what was collected.
const outstanding = (j) =>
  Math.max(0, (j.pickup_balance || 0) + (j.delivery_balance || 0) + (j.bol_balance || 0) - (j.bol_collected || 0));

t("receivables: a split job counts once, from the money-bearing row", () => {
  const rows = buildReceivables({ groups: allGroups, jobOutstanding: outstanding });
  const job = rows.filter(r => r.source === "job" && r.label === "J-100");
  assert.equal(job.length, 1);
  assert.equal(job[0].amount, 1200);          // 1000 + 500 − 300
  assert.equal(job[0].dueDate, "2026-08-20");
  assert.equal(job[0].party, "Ann");
});

t("receivables: scheduled and cancelled jobs are not debts", () => {
  const rows = buildReceivables({ groups: allGroups, jobOutstanding: outstanding });
  assert.equal(rows.some(r => r.label === "J-200"), false);
  assert.equal(rows.some(r => r.label === "J-300"), false);
});

t("receivables: storage billing counts only pending and overdue rows", () => {
  const billing = [
    { id: 10, job_id: 1, amount: 250, status: "pending", billing_period_start: "2026-08-01", billing_period_end: "2026-08-31" },
    { id: 11, job_id: 1, amount: 250, status: "overdue", billing_period_start: "2026-07-01", billing_period_end: "2026-07-31" },
    { id: 12, job_id: 1, amount: 250, status: "paid", billing_period_end: "2026-06-30" },
    { id: 13, job_id: 1, amount: 250, status: "pending", billing_period_end: "2026-05-31", deleted_at: "2026-06-01" },
  ];
  const rows = buildReceivables({ groups: [], billing, jobs: allJobRows, jobOutstanding: outstanding });
  assert.deepEqual(rows.map(r => r.id), ["storage_billing:11", "storage_billing:10"]);
  assert.equal(rows[0].party, "Ann");
  assert.equal(sumRows(rows), 500);
});

t("receivables: a closing sheet with a positive net is the broker owing us", () => {
  const closingSheets = [
    { id: 20, broker_id: 7, closing_sheet_number: "CS-1", status: "open", load_date: "2026-08-01" },
    { id: 21, broker_id: 7, closing_sheet_number: "CS-2", status: "open", load_date: "2026-08-02" },
    { id: 22, broker_id: 7, closing_sheet_number: "CS-3", status: "settled", load_date: "2026-08-03" },
  ];
  const sheetCalcById = { 20: { net: 800 }, 21: { net: -400 }, 22: { net: 999 } };
  const rows = buildReceivables({
    groups: [], closingSheets, sheetCalcById, jobOutstanding: outstanding,
    brokerName: (id) => (id === 7 ? "Allied" : ""),
  });
  assert.deepEqual(rows.map(r => r.id), ["settlement:20"]);
  assert.equal(rows[0].amount, 800);
  assert.equal(rows[0].party, "Allied");
});

t("receivables: sorted oldest due date first, undated last", () => {
  const billing = [
    { id: 30, job_id: 1, amount: 100, status: "pending", billing_period_end: "2026-08-01" },
    { id: 31, job_id: 1, amount: 100, status: "pending", billing_period_end: null },
    { id: 32, job_id: 1, amount: 100, status: "pending", billing_period_end: "2026-01-01" },
  ];
  const rows = buildReceivables({ groups: [], billing, jobs: allJobRows, jobOutstanding: outstanding });
  assert.deepEqual(rows.map(r => r.id), ["storage_billing:32", "storage_billing:30", "storage_billing:31"]);
});

// ── Payables ─────────────────────────────────────────────────────────────────

t("payables: a bank expense drops off once its statement line is imported", () => {
  const expenses = [
    { id: 40, amount: 300, vendor: "Pilot", category: "fuel", paid_from: "bank", status: "approved", expense_date: "2026-08-20" },
    { id: 41, amount: 120, vendor: "Motel 6", category: "hotel", paid_from: "bank", status: "pending", expense_date: "2026-08-25" },
    { id: 42, amount: 90, vendor: "Home Depot", category: "materials", paid_from: "driver_cash", status: "approved", expense_date: "2026-08-26" },
    { id: 43, amount: 500, vendor: "X", category: "other", paid_from: "bank", status: "rejected", expense_date: "2026-08-27" },
  ];
  // Only the Pilot expense has a matching bank outflow.
  const bankTxns = [{ id: 90, amount: -300, direction: "out", txn_date: "2026-08-21", status: "categorized" }];
  const rows = buildPayables({ expenses, bankTxns });
  assert.deepEqual(rows.map(r => r.ref.expenseId), [41]);
  assert.equal(rows[0].amount, 120);
  // Driver-cash and rejected expenses were never bank payables at all.
  assert.equal(rows.some(r => r.ref.expenseId === 42 || r.ref.expenseId === 43), false);
});

t("payables: a bill counts its unpaid remainder, not its face value", () => {
  const bills = [
    { id: 50, vendor: "Geico", description: "Truck insurance", amount: 1000, amount_paid: 400, status: "pending", due_date: "2026-09-05" },
    { id: 51, vendor: "T-Mobile", amount: 90, amount_paid: 90, status: "paid", due_date: "2026-08-05" },
    { id: 52, vendor: "Void Co", amount: 500, status: "void", due_date: "2026-08-05" },
    { id: 53, vendor: "Deleted Co", amount: 500, status: "pending", due_date: "2026-08-05", deleted_at: "2026-08-06" },
  ];
  const rows = buildPayables({ bills });
  assert.deepEqual(rows.map(r => r.id), ["bill:50"]);
  assert.equal(rows[0].amount, 600);
  assert.equal(rows[0].meta.partial, true);
});

t("payables: a closing sheet with a negative net is us owing the broker", () => {
  const closingSheets = [
    { id: 20, broker_id: 7, closing_sheet_number: "CS-1", status: "open", load_date: "2026-08-01" },
    { id: 21, broker_id: 7, closing_sheet_number: "CS-2", status: "open", load_date: "2026-08-02" },
  ];
  const sheetCalcById = { 20: { net: 800 }, 21: { net: -400 } };
  const rows = buildPayables({ closingSheets, sheetCalcById, brokerName: () => "Allied" });
  assert.deepEqual(rows.map(r => r.id), ["settlement:21"]);
  assert.equal(rows[0].amount, 400, "the payable amount is positive; the side carries the sign");
});

// ── Driver payables ──────────────────────────────────────────────────────────

// 2026-08-19 is a Wednesday, so it opens the pay week 08-19 → 08-25,
// paid the following Wednesday, 08-26.
const driversList = [{ id: 1, name: "Luis", daily_rate: 250 }, { id: 2, name: "Marta", daily_rate: 200 }];

t("driver payables: one row per unpaid pay week, paid on the next Wednesday", () => {
  const workDays = [
    { id: 1, driver_id: 1, work_date: "2026-08-19", day_type: "full", rate: 250 },
    { id: 2, driver_id: 1, work_date: "2026-08-20", day_type: "half", rate: 250 },
    { id: 3, driver_id: 1, work_date: "2026-08-12", day_type: "full", rate: 250, paid_date: "2026-08-19" },
  ];
  const jobExtras = [
    { id: 1, driver_id: 1, driver_commission_amount: 75, extra_date: "2026-08-21", active: true },
    { id: 2, driver_id: 1, driver_commission_amount: 50, extra_date: "2026-08-21", active: true, commission_paid_date: "2026-08-26" },
    { id: 3, driver_id: 1, driver_commission_amount: 60, extra_date: "2026-08-21", active: false },
  ];
  const adjustments = [
    { id: 1, driver_id: 1, adj_date: "2026-08-20", kind: "bonus", amount: 100 },
    { id: 2, driver_id: 1, adj_date: "2026-08-20", kind: "deduction", amount: 30 },
  ];
  const rows = buildDriverPayables({
    driversList, workDays, jobExtras, adjustments, cashOnHandByDriver: { 1: 450 },
  });
  assert.equal(rows.length, 1, "the already-paid week is gone");
  const r = rows[0];
  assert.equal(r.id, "driver:1:2026-08-19");
  assert.equal(r.label, "2026-08-19");
  assert.equal(r.dueDate, "2026-08-26");
  assert.equal(r.ref.weekEnd, "2026-08-25");
  // 250 (full) + 125 (half) + 75 (commission) + 100 (bonus) − 30 (deduction)
  assert.equal(r.amount, 520);
  assert.equal(r.meta.labor, 375);
  assert.equal(r.meta.commissions, 75);
  assert.equal(r.meta.days, 2);
  assert.equal(r.meta.cashOnHand, 450, "cash held is a note, never netted off the payout");
  // The row carries the exact rows to stamp, so "mark week paid" never has to
  // re-derive them from a date range.
  assert.deepEqual(r.ref.workDayIds, [1, 2]);
  assert.deepEqual(r.ref.extraIds, [1], "only the unpaid, active commission");
  assert.deepEqual(r.ref.adjustmentIds, [1, 2]);
});

t("driver payables: a week that nets to zero or less is not a payable", () => {
  const rows = buildDriverPayables({
    driversList,
    workDays: [{ id: 1, driver_id: 2, work_date: "2026-08-19", day_type: "full", rate: 200 }],
    adjustments: [{ id: 1, driver_id: 2, adj_date: "2026-08-20", kind: "deduction", amount: 200 }],
  });
  assert.deepEqual(rows, []);
});

t("driver payables: rows for an unknown driver are dropped, not attributed", () => {
  const rows = buildDriverPayables({
    driversList,
    workDays: [{ id: 1, driver_id: 99, work_date: "2026-08-19", day_type: "full", rate: 300 }],
  });
  assert.deepEqual(rows, []);
});

// ── Aging and net position ───────────────────────────────────────────────────

t("aging: buckets by days past due; no due date counts as due today", () => {
  const rows = [
    { id: "a", amount: 100, dueDate: "2026-08-20" }, //  11 days → 0–30
    { id: "b", amount: 200, dueDate: "2026-07-20" }, //  42 days → 31–60
    { id: "c", amount: 300, dueDate: "2026-06-10" }, //  82 days → 61–90
    { id: "d", amount: 400, dueDate: "2026-01-01" }, // 242 days → 90+
    { id: "e", amount: 500, dueDate: null },         //   0 days → 0–30
    { id: "f", amount: 600, dueDate: "2026-12-01" }, // future, clamped to 0
    { id: "g", amount: 0, dueDate: "2026-01-01" },   // ignored
  ];
  const { buckets, total, avgDays } = aging(rows, TODAY, LABELS);
  assert.deepEqual(buckets.map(b => b.amount), [1200, 200, 300, 400]);
  assert.deepEqual(buckets.map(b => b.count), [3, 1, 1, 1]);
  assert.equal(total, 2100);
  assert.ok(avgDays > 0);
  assert.deepEqual(buckets[0].rows.map(r => r.id), ["f", "e", "a"], "each bucket keeps its rows, biggest first");
  assert.equal(agingBuckets(rows, TODAY, LABELS).total, total, "aging is the shared agingBuckets");
});

t("overdue and dueWithin split the list on today", () => {
  const rows = [
    { id: "a", amount: 100, dueDate: "2026-08-30" },
    { id: "b", amount: 200, dueDate: "2026-08-31" },
    { id: "c", amount: 300, dueDate: "2026-09-20" },
    { id: "d", amount: 400, dueDate: "2026-11-01" },
    { id: "e", amount: 500, dueDate: null },
  ];
  assert.deepEqual(overdueRows(rows, TODAY).map(r => r.id), ["a"]);
  assert.deepEqual(dueWithin(rows, TODAY, 30).map(r => r.id), ["b", "c"]);
});

t("netPosition: receivable minus payable, with both overdue totals", () => {
  const receivables = [
    { id: "r1", amount: 1000, dueDate: "2026-08-01" },
    { id: "r2", amount: 500, dueDate: "2026-09-10" },
  ];
  const payables = [
    { id: "p1", amount: 300, dueDate: "2026-08-15" },
    { id: "p2", amount: 200, dueDate: "2026-09-05" },
  ];
  const n = netPosition({ receivables, payables, todayISO: TODAY });
  assert.equal(n.ar, 1500);
  assert.equal(n.ap, 500);
  assert.equal(n.net, 1000);
  assert.equal(n.arOverdue, 1000);
  assert.equal(n.apOverdue, 300);
  assert.equal(n.arSoon, 500);
  assert.equal(n.apSoon, 200);
});

// ── Auto-generated bills ─────────────────────────────────────────────────────

t("dueBillsToGenerate: rent for each open unit, once", () => {
  const storages = [
    { id: 1, brand: "CubeSmart", unit: "A12", state: "NJ", monthly_cost: 180, payment_due_date: "2026-09-05", situation: "Open" },
    { id: 2, brand: "Extra Space", unit: "B3", state: "IN", monthly_cost: 210, payment_due_date: "2026-09-08", situation: "Open" },
    { id: 3, brand: "Closed One", monthly_cost: 300, payment_due_date: "2026-09-08", situation: "Close" },
    { id: 4, brand: "Free One", monthly_cost: 0, payment_due_date: "2026-09-08", situation: "Open" },
  ];
  const first = dueBillsToGenerate({ bills: [], storages, todayISO: TODAY });
  assert.deepEqual(first.map(b => b.storage_id), [1, 2]);
  assert.equal(first[0].amount, 180);
  assert.equal(first[0].source, "storage_rent");
  assert.equal(first[0].description, "CubeSmart · Unit A12 · NJ");
  assert.equal(first[0].status, "pending");

  // Re-running against the bills it just produced generates nothing.
  const existing = first.map((b, i) => ({ ...b, id: 100 + i }));
  assert.deepEqual(dueBillsToGenerate({ bills: existing, storages, todayISO: TODAY }), []);
});

t("dueBillsToGenerate: rent past its due date is generated as overdue", () => {
  const storages = [{ id: 1, brand: "CubeSmart", monthly_cost: 180, payment_due_date: "2026-08-05", situation: "Open" }];
  const [bill] = dueBillsToGenerate({ bills: [], storages, todayISO: TODAY });
  assert.equal(bill.status, "overdue");
});

t("dueBillsToGenerate: a paid recurring bill opens its next cycle, once", () => {
  const bills = [
    { id: 60, vendor: "Geico", amount: 1000, recurrence: "monthly", status: "paid", due_date: "2026-08-05", source: "manual" },
    { id: 61, vendor: "Adobe", amount: 60, recurrence: "monthly", status: "pending", due_date: "2026-09-01", source: "manual" },
    { id: 62, vendor: "One Off", amount: 90, recurrence: "once", status: "paid", due_date: "2026-08-01", source: "manual" },
  ];
  const out = dueBillsToGenerate({ bills, storages: [], todayISO: TODAY });
  assert.equal(out.length, 1, "only the paid recurring bill rolls forward");
  assert.equal(out[0].vendor, "Geico");
  assert.equal(out[0].due_date, "2026-09-05");
  assert.equal(out[0].parent_bill_id, 60);
  assert.equal(out[0].source, "recurring");

  // With the next cycle already on the books, nothing more is generated.
  const withNext = [...bills, { ...out[0], id: 63 }];
  assert.deepEqual(dueBillsToGenerate({ bills: withNext, storages: [], todayISO: TODAY }), []);
});

t("dueBillsToGenerate: cycles beyond the horizon wait", () => {
  const bills = [{ id: 70, vendor: "Insurance", amount: 1200, recurrence: "yearly", status: "paid", due_date: "2026-08-01", source: "manual" }];
  assert.deepEqual(dueBillsToGenerate({ bills, storages: [], todayISO: TODAY }), []);
  assert.equal(dueBillsToGenerate({ bills, storages: [], todayISO: TODAY, horizonDays: 400 }).length, 1);
});

t("overdueBillIds: only pending bills whose due date has passed", () => {
  const bills = [
    { id: 80, status: "pending", due_date: "2026-08-01" },
    { id: 81, status: "pending", due_date: "2026-09-01" },
    { id: 82, status: "overdue", due_date: "2026-07-01" },
    { id: 83, status: "paid", due_date: "2026-07-01" },
    { id: 84, status: "pending", due_date: "2026-07-01", deleted_at: "2026-07-02" },
  ];
  assert.deepEqual(overdueBillIds(bills, TODAY), [80]);
});

// ── The two sides together ───────────────────────────────────────────────────

t("end to end: one job, one bill and one driver week make a net position", () => {
  const receivables = buildReceivables({ groups: allGroups, jobOutstanding: outstanding });
  const driverPayables = buildDriverPayables({
    driversList,
    workDays: [{ id: 1, driver_id: 1, work_date: "2026-08-19", day_type: "full", rate: 250 }],
  });
  const payables = buildPayables({
    bills: [{ id: 50, vendor: "Geico", amount: 1000, amount_paid: 0, status: "pending", due_date: "2026-08-05" }],
    driverPayables,
  });
  const n = netPosition({ receivables, payables, todayISO: TODAY });
  assert.equal(n.ar, 1600, "J-100 (1200) + J-400 (400)");
  assert.equal(n.ap, 1250, "Geico (1000) + Luis's week (250)");
  assert.equal(n.net, 350);
  // Luis's week was payable on Wednesday 2026-08-26 and today is the 31st.
  assert.equal(n.apOverdue, 1250, "both the bill and the missed pay day are overdue");
  assert.equal(n.arOverdue, 1600);
  assert.ok(byId(payables, "driver:1:2026-08-19"));
  assert.ok(byId(receivables, "job:n:j-100"));
});

if (!process.exitCode) console.log("\nAll AP/AR data tests passed.");
