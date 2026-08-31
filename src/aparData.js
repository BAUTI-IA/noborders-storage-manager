// AP / AR math (pure, no React, no I/O) — what the company is owed and what it
// owes, consolidated from the ledgers that already exist. Unit-tested with plain
// node (`npm run test:apar`), same pattern as bankData.js / jobCalcData.js.
//
// THE RULE OF THIS FILE: almost nothing here is a new source of truth. Job
// balances live in storage_jobs + payments, storage rent charged to a client
// lives in storage_billing, the broker balance lives in closing_sheets, and
// driver pay lives in driver_work_days + job_extras. This module only reads
// them and puts them on one dated list. The single exception is ap_bills, the
// bills the CRM never modelled (rent, insurance, software, a supplier invoice).
//
// Every row on both sides shares one shape, so the aging ladder, the totals and
// the table can be written once:
//
//   { id, source, party, label, amount, dueDate, ref, meta }
//
//   id      — stable across reloads ("job:n:12345", "bill:17"), used as React key
//   source  — which ledger it came from; drives the row's badge and its action
//   party   — who owes us / who we owe (customer, broker, vendor, driver)
//   label   — the human reference (job number, billing period, sheet number)
//   amount  — always POSITIVE; the side of the list says the direction
//   dueDate — ISO date the aging ladder counts from; null = treated as today
//   ref     — ids the UI needs to act on the row or navigate to its own module
//   meta    — extra display-only detail (never used in a total)

import {
  numv, jobKey, agingBuckets, payWeekStart, addDaysISO, workDayPay,
} from "./analyticsData.js";
import { matchBankToExpenses } from "./bankData.js";

export const AR_SOURCES = ["job", "storage_billing", "settlement"];
export const AP_SOURCES = ["bill", "expense", "settlement", "driver"];

export const BILL_RECURRENCES = ["once", "monthly", "quarterly", "yearly"];
export const BILL_STATUSES = ["pending", "overdue", "paid", "void"];
export const BILL_PAID_FROM = ["bank", "company_card", "cash", "other"];

const notDel = (r) => !r?.deleted_at;
const round2 = (n) => Math.round(n * 100) / 100;
// Money below a cent is rounding noise, not a receivable.
const OPEN = 0.01;

// ── Dates ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");
const isoOf = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

/** Whole days between two ISO dates (b − a); negative when b is before a. */
export function daysBetween(aISO, bISO) {
  if (!aISO || !bISO) return 0;
  return Math.round((new Date(bISO + "T00:00:00") - new Date(aISO + "T00:00:00")) / 86400000);
}

/**
 * Add whole months to an ISO date, clamping the day to the target month's
 * length so the 31st of January rolls to the 28th/29th of February rather than
 * silently jumping into March.
 */
export function addMonthsISO(dateISO, months) {
  const [y, m, d] = dateISO.split("-").map(Number);
  const target = new Date(y, m - 1 + months, 1);
  const lastDay = new Date(target.getFullYear(), target.getMonth() + 1, 0).getDate();
  target.setDate(Math.min(d, lastDay));
  return isoOf(target);
}

const RECURRENCE_MONTHS = { monthly: 1, quarterly: 3, yearly: 12 };

/** The due date of the cycle after `dueDate`, or null for a one-off bill. */
export function nextDueDate(dueDate, recurrence) {
  const step = RECURRENCE_MONTHS[recurrence];
  if (!dueDate || !step) return null;
  return addMonthsISO(dueDate, step);
}

/**
 * The storage-unit rent cycle currently owed: the stored payment_due_date, else
 * date_opened + 30 days rolled forward in 30-day steps until it lands on or
 * after today. Same rule the Storage section already shows on each unit — the
 * AP list must not invent a different one.
 */
export function rentDueDate(storage, todayISO) {
  if (!storage) return null;
  if (storage.payment_due_date) return storage.payment_due_date;
  if (!storage.date_opened) return null;
  let due = addDaysISO(storage.date_opened, 30);
  // Guard the loop: a date_opened far in the past would otherwise iterate for
  // as many 30-day steps as it takes, and a corrupt one could not terminate.
  for (let i = 0; i < 1000 && due < todayISO; i++) due = addDaysISO(due, 30);
  return due;
}

// ── Receivable ───────────────────────────────────────────────────────────────

// A job only becomes a receivable once it has actually been picked up: a
// scheduled job's balance is a future sale, not a debt, and a cancelled one is
// no debt at all.
const NON_RECEIVABLE_STATUS = new Set(["scheduled", "cancelled"]);

/**
 * Everything owed TO the company, from the four ledgers that hold it.
 *
 * `jobOutstanding` is App.jsx's own callback, passed in rather than
 * reimplemented: it already resolves split jobs, the bol_collected ↔ payments
 * mirror (max, never sum) and unpaid extras. Duplicating that math here is the
 * one way this section could disagree with the number Dispatching shows.
 */
export function buildReceivables({
  groups = [], billing = [], closingSheets = [], sheetCalcById = {},
  jobs = [], brokerName = () => "", jobOutstanding,
}) {
  const rows = [];

  // 1. Job balances (pickup + delivery + BOL) and unpaid extras.
  for (const g of groups) {
    const j = g.rep;
    if (NON_RECEIVABLE_STATUS.has(j.status)) continue;
    const owed = numv(jobOutstanding ? jobOutstanding(j, g.key) : 0);
    if (owed < OPEN) continue;
    rows.push({
      id: `job:${g.key}`,
      source: "job",
      party: j.customer || "",
      label: j.job_number || "",
      amount: round2(owed),
      dueDate: j.delivery_date || g.dateOut || j.pickup_date || g.dateIn || null,
      ref: { jobKey: g.key, jobId: j.id, brokerId: j.broker_id || null },
      meta: { status: j.status || "", driver: j.driver || "" },
    });
  }

  // 2. Monthly storage billed to the client. This one already IS a dated
  //    receivable with its own paid/overdue state — we only surface it.
  const jobById = {};
  for (const j of jobs) if (!jobById[j.id]) jobById[j.id] = j;
  for (const b of billing) {
    if (!notDel(b)) continue;
    if (b.status !== "pending" && b.status !== "overdue") continue;
    const amount = numv(b.amount);
    if (amount < OPEN) continue;
    const j = jobById[b.job_id];
    rows.push({
      id: `storage_billing:${b.id}`,
      source: "storage_billing",
      party: j?.customer || "",
      label: j?.job_number || "",
      amount: round2(amount),
      dueDate: b.billing_period_end || null,
      ref: { billingId: b.id, jobId: b.job_id, jobKey: j ? jobKey(j) : null },
      meta: { periodStart: b.billing_period_start || "", periodEnd: b.billing_period_end || "", status: b.status },
    });
  }

  // 3. Closing sheets where the net leaves the broker owing us.
  for (const s of closingSheets) {
    if (!notDel(s) || s.status === "settled") continue;
    const net = numv(sheetCalcById[s.id]?.net);
    if (net < OPEN) continue;
    rows.push({
      id: `settlement:${s.id}`,
      source: "settlement",
      party: brokerName(s.broker_id) || "",
      label: s.closing_sheet_number || `#${s.id}`,
      amount: round2(net),
      dueDate: s.load_date || null,
      ref: { sheetId: s.id, brokerId: s.broker_id || null },
      meta: { status: s.status || "" },
    });
  }

  return sortByDue(rows);
}

// ── Payable ──────────────────────────────────────────────────────────────────

/**
 * Everything the company owes, from five sources.
 *
 * The expense side deserves a note: an expense is listed as payable when it was
 * recorded as bank-paid but no bank movement matches it yet — "I entered it, the
 * money has not left the account". That match reuses matchBankToExpenses (the
 * same amount tolerance and 7-day window the Banks reconciliation uses), so an
 * expense drops off this list the moment its statement line is imported.
 */
export function buildPayables({
  bills = [], expenses = [], bankTxns = [], bankCategories = [],
  closingSheets = [], sheetCalcById = {}, driverPayables = [],
  brokerName = () => "",
}) {
  const rows = [];

  // 1. Bills — the only payables this module owns.
  for (const b of bills) {
    if (!notDel(b) || b.status === "paid" || b.status === "void") continue;
    const outstanding = numv(b.amount) - numv(b.amount_paid);
    if (outstanding < OPEN) continue;
    rows.push({
      id: `bill:${b.id}`,
      source: "bill",
      party: b.vendor || "",
      label: b.description || b.category || "",
      amount: round2(outstanding),
      dueDate: b.due_date || null,
      ref: { billId: b.id },
      meta: {
        category: b.category || "", recurrence: b.recurrence || "once",
        billSource: b.source || "manual", partial: numv(b.amount_paid) > 0,
        amountTotal: numv(b.amount), amountPaid: numv(b.amount_paid),
        documentUrl: b.document_url || "",
      },
    });
  }

  // 2. Expenses recorded against the bank that no statement line covers yet.
  const live = expenses.filter(e => notDel(e) && e.status !== "rejected");
  const { unmatchedExpenses } = matchBankToExpenses({
    bankTxns: bankTxns.filter(t => notDel(t) && t.status !== "ignored"),
    expenses: live,
    categories: bankCategories,
  });
  for (const e of unmatchedExpenses) {
    const amount = numv(e.amount);
    if (amount < OPEN) continue;
    rows.push({
      id: `expense:${e.id}`,
      source: "expense",
      party: e.vendor || "",
      label: e.category || "",
      amount: round2(amount),
      dueDate: e.expense_date || null,
      ref: { expenseId: e.id, jobId: e.job_id || null },
      meta: { status: e.status || "", jobNumber: e.job_number || "", receiptUrl: e.receipt_url || "" },
    });
  }

  // 3. Closing sheets where the net leaves us owing the broker.
  for (const s of closingSheets) {
    if (!notDel(s) || s.status === "settled") continue;
    const net = numv(sheetCalcById[s.id]?.net);
    if (net > -OPEN) continue;
    rows.push({
      id: `settlement:${s.id}`,
      source: "settlement",
      party: brokerName(s.broker_id) || "",
      label: s.closing_sheet_number || `#${s.id}`,
      amount: round2(-net),
      dueDate: s.load_date || null,
      ref: { sheetId: s.id, brokerId: s.broker_id || null },
      meta: { status: s.status || "" },
    });
  }

  // 4. Driver pay weeks (built separately so the UI can also settle them).
  for (const d of driverPayables) rows.push(d);

  return sortByDue(rows);
}

/**
 * What each driver is owed, one row per unpaid pay week (Wednesday → Tuesday,
 * paid the following Wednesday — the convention the Expenses pay grid already
 * uses). A week is made of three parts, each with its own paid stamp, so
 * "mark week paid" clears the row whole:
 *
 *   days worked (driver_work_days) + extra commissions (job_extras)
 *   + bonuses − deductions (driver_adjustments)
 *
 * Cash the driver is holding is NOT netted off here. That is the opposite
 * direction — money he owes the company — and it settles through its own flow
 * in Expenses; netting two ledgers into one number is how both stop being
 * checkable. It rides along in `meta.cashOnHand` as a note for the operator.
 */
export function buildDriverPayables({
  driversList = [], workDays = [], adjustments = [], jobExtras = [],
  cashOnHandByDriver = {},
}) {
  const driverById = {};
  for (const d of driversList) driverById[d.id] = d;
  // driverId -> weekStart -> accumulator
  const weeks = new Map();
  const bucket = (driverId, dateISO) => {
    if (driverId == null || !dateISO) return null;
    if (!driverById[driverId]) return null;
    const week = payWeekStart(dateISO);
    const key = `${driverId}|${week}`;
    let acc = weeks.get(key);
    if (!acc) {
      acc = {
        driverId, week, labor: 0, commissions: 0, bonuses: 0, deductions: 0, days: 0, extras: 0,
        // The exact rows that make up this week. "Mark week paid" stamps THESE
        // ids rather than re-deriving them from a date range: an extra with no
        // extra_date is bucketed by created_at, so a date filter would leave it
        // unstamped and the row would never clear.
        workDayIds: [], adjustmentIds: [], extraIds: [],
      };
      weeks.set(key, acc);
    }
    return acc;
  };

  for (const w of workDays) {
    if (!notDel(w) || w.paid_date) continue;
    const acc = bucket(w.driver_id, w.work_date);
    if (!acc) continue;
    acc.labor += numv(workDayPay(w, driverById[w.driver_id]));
    acc.days += 1;
    acc.workDayIds.push(w.id);
  }
  for (const e of jobExtras) {
    if (!notDel(e) || e.active === false || e.commission_paid_date) continue;
    const amount = numv(e.driver_commission_amount);
    if (amount <= 0) continue;
    const acc = bucket(e.driver_id, e.extra_date || (e.created_at || "").slice(0, 10));
    if (!acc) continue;
    acc.commissions += amount;
    acc.extras += 1;
    acc.extraIds.push(e.id);
  }
  for (const a of adjustments) {
    if (!notDel(a) || a.paid_date) continue;
    const acc = bucket(a.driver_id, a.adj_date || (a.created_at || "").slice(0, 10));
    if (!acc) continue;
    if (a.kind === "bonus") acc.bonuses += numv(a.amount);
    else acc.deductions += numv(a.amount);
    acc.adjustmentIds.push(a.id);
  }

  const rows = [];
  for (const acc of weeks.values()) {
    const total = acc.labor + acc.commissions + acc.bonuses - acc.deductions;
    if (total < OPEN) continue;
    const d = driverById[acc.driverId];
    rows.push({
      id: `driver:${acc.driverId}:${acc.week}`,
      source: "driver",
      party: d?.name || `Driver #${acc.driverId}`,
      label: acc.week,
      amount: round2(total),
      // Paid on the Wednesday that closes the week (the week starts Wednesday).
      dueDate: addDaysISO(acc.week, 7),
      ref: {
        driverId: acc.driverId, week: acc.week, weekEnd: addDaysISO(acc.week, 6),
        workDayIds: acc.workDayIds, adjustmentIds: acc.adjustmentIds, extraIds: acc.extraIds,
      },
      meta: {
        labor: round2(acc.labor), commissions: round2(acc.commissions),
        bonuses: round2(acc.bonuses), deductions: round2(acc.deductions),
        days: acc.days, extras: acc.extras,
        cashOnHand: round2(numv(cashOnHandByDriver[acc.driverId])),
      },
    });
  }
  return sortByDue(rows);
}

// ── Rollups ──────────────────────────────────────────────────────────────────

// Oldest debt first; rows with no due date sort last rather than pretending to
// be the most urgent thing on the list. Ties break on amount then id, so the
// order is stable across reloads.
function sortByDue(rows) {
  return rows.slice().sort((a, b) =>
    (a.dueDate || "9999-12-31").localeCompare(b.dueDate || "9999-12-31") ||
    b.amount - a.amount ||
    String(a.id).localeCompare(String(b.id)));
}

export const sumRows = (rows) => round2(rows.reduce((s, r) => s + numv(r.amount), 0));
export const overdueRows = (rows, todayISO) => rows.filter(r => r.dueDate && r.dueDate < todayISO);
export const dueWithin = (rows, todayISO, days) =>
  rows.filter(r => r.dueDate && r.dueDate >= todayISO && daysBetween(todayISO, r.dueDate) <= days);

/**
 * The six numbers at the top of the section. `net > 0` means more is coming in
 * than going out — the only headline figure the CRM never had.
 */
export function netPosition({ receivables = [], payables = [], todayISO, horizonDays = 30 }) {
  const ar = sumRows(receivables);
  const ap = sumRows(payables);
  return {
    ar, ap, net: round2(ar - ap),
    arOverdue: sumRows(overdueRows(receivables, todayISO)),
    apOverdue: sumRows(overdueRows(payables, todayISO)),
    arSoon: sumRows(dueWithin(receivables, todayISO, horizonDays)),
    apSoon: sumRows(dueWithin(payables, todayISO, horizonDays)),
    horizonDays,
  };
}

/** Aging ladder for either side. Labels come from the caller (i18n lives in the UI). */
export const aging = (rows, todayISO, labels) => agingBuckets(rows, todayISO, labels);

// ── Auto-generated bills ─────────────────────────────────────────────────────

/**
 * The bill rows that SHOULD exist but do not yet — returned as insert payloads,
 * never written here (this file does no I/O).
 *
 * Two generators, both keyed so re-running is a no-op (and the ap_bills_autogen
 * unique index backstops a race):
 *
 *   storage_rent — every open unit with a monthly cost already carries its rent
 *     and its due date in `storages`; nobody was turning that into a payable.
 *   recurring    — once a recurring bill is settled, the next cycle is due.
 *
 * `horizonDays` keeps the list from running away into the future: only cycles
 * due within the horizon are materialised.
 */
export function dueBillsToGenerate({ bills = [], storages = [], todayISO, horizonDays = 45 }) {
  const live = bills.filter(notDel);
  const limit = addDaysISO(todayISO, horizonDays);
  const seen = new Set(
    live.filter(b => (b.source || "manual") !== "manual")
      .map(b => `${b.source}|${b.storage_id ?? ""}|${b.due_date ?? ""}`)
  );
  const out = [];
  const claim = (key, payload) => { if (!seen.has(key)) { seen.add(key); out.push(payload); } };

  // Rent owed on each open storage unit.
  for (const s of storages) {
    if (!notDel(s) || s.situation === "Close") continue;
    const amount = numv(s.monthly_cost);
    if (amount < OPEN) continue;
    const due = rentDueDate(s, todayISO);
    if (!due || due > limit) continue;
    claim(`storage_rent|${s.id}|${due}`, {
      vendor: s.brand || "",
      category: "Storage rent",
      description: [s.brand, s.unit && `Unit ${s.unit}`, s.state].filter(Boolean).join(" · "),
      amount,
      bill_date: todayISO,
      due_date: due,
      status: due < todayISO ? "overdue" : "pending",
      recurrence: "monthly",
      source: "storage_rent",
      storage_id: s.id,
    });
  }

  // The cycle after a settled recurring bill.
  for (const b of live) {
    const step = RECURRENCE_MONTHS[b.recurrence];
    if (!step || !b.due_date) continue;
    if (b.status !== "paid") continue;
    const due = nextDueDate(b.due_date, b.recurrence);
    if (!due || due > limit) continue;
    // A manual recurring bill has no storage_id, so its key is source+due date;
    // the unique index only covers non-manual rows, hence the explicit dedupe
    // against every live cycle of the same parent below.
    const parent = b.parent_bill_id ?? b.id;
    const already = live.some(x =>
      (x.parent_bill_id ?? x.id) === parent && x.id !== b.id && x.due_date === due);
    if (already) continue;
    claim(`recurring|${parent}|${due}`, {
      vendor: b.vendor || "",
      category: b.category || "",
      description: b.description || "",
      amount: numv(b.amount),
      bill_date: todayISO,
      due_date: due,
      status: due < todayISO ? "overdue" : "pending",
      recurrence: b.recurrence,
      recurrence_day: b.recurrence_day ?? null,
      parent_bill_id: parent,
      source: "recurring",
      bank_account: b.bank_account || null,
      paid_from: b.paid_from || "bank",
    });
  }

  return out;
}

/** Bills whose due date has passed while still pending — flipped to overdue. */
export function overdueBillIds(bills, todayISO) {
  return bills.filter(b => notDel(b) && b.status === "pending" && b.due_date && b.due_date < todayISO)
    .map(b => b.id);
}
