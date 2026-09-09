// Field Expenses — catálogo de categorías y el merge con los movimientos del
// banco. Sin React, así se puede testear con node plano
// (`node scripts/test-expenses-data.mjs`), mismo patrón que analyticsData.js /
// bankData.js.

import { numv } from "./analyticsData.js";
import { matchBankToExpenses, signedAmount } from "./bankData.js";

// Field expense catalog. `v` is what gets stored in expenses.category, so the
// seven original values (fuel, hotel, materials, tolls, maintenance, meals,
// other) MUST keep their spelling — rows already reference them.
// `bank` names the equivalent category in the Bancos chart of accounts, so the
// same cost has one vocabulary whether it was typed here or came off the
// statement. null means the bank has no equivalent: it never shows up there
// because it is paid in cash out on the road.
export const EXPENSE_CATEGORIES = [
  // On the road
  { v:"fuel",             l:"Fuel",                              icon:"⛽",  bank:"Fuel" },
  { v:"tolls",            l:"Tolls",                             icon:"🛣️",  bank:"Toll" },
  { v:"parking",          l:"Parking",                           icon:"🅿️",  bank:null },
  { v:"scales",           l:"Weigh station / scales",            icon:"⚖️",  bank:null },
  { v:"hotel",            l:"Hotel / Lodging",                   icon:"🏨",  bank:"Hotels" },
  { v:"meals",            l:"Meals / Per diem",                  icon:"🍔",  bank:null },
  { v:"laundry",          l:"Laundry (pads / blankets)",         icon:"🧺",  bank:null },
  // Truck
  { v:"maintenance",      l:"Truck maintenance",                 icon:"🔧",  bank:"Truck Maintenance" },
  { v:"repair",           l:"Truck repair (breakdown)",          icon:"🛠️",  bank:"Truck Repair" },
  { v:"tires",            l:"Tires",                             icon:"🛞",  bank:null },
  { v:"truck_wash",       l:"Truck wash",                        icon:"🧽",  bank:null },
  { v:"truck_rental",     l:"Truck rental",                      icon:"🚛",  bank:"Truck Rental" },
  { v:"permits",          l:"Permits & licensing",               icon:"📋",  bank:"Truck Licensing Fees" },
  { v:"fines",            l:"Fines & tickets",                   icon:"🚨",  bank:"Fines" },
  // On the job
  { v:"materials",        l:"Materials / Packing supplies",      icon:"📦",  bank:"Packaging" },
  { v:"helpers",          l:"Day labor / helpers",               icon:"💪",  bank:"Salaries - Helpers" },
  { v:"equipment_rental", l:"Equipment rental (dollies, ramps)", icon:"🧰",  bank:null },
  { v:"storage",          l:"Storage / warehouse",               icon:"🏬",  bank:"Storage" },
  { v:"shuttle",          l:"Shuttle / extra truck",             icon:"🚐",  bank:null },
  { v:"claim",            l:"Damage claim",                      icon:"⚠️",  bank:"Claims" },
  // Crew travel
  { v:"ground_transport", l:"Ground transportation (Uber, taxi)", icon:"🚕", bank:"Ground Transportation" },
  { v:"airfare",          l:"Airfare",                           icon:"✈️",  bank:"Airfare" },
  { v:"other",            l:"Other",                             icon:"💵",  bank:"Other" },
];

export const expenseCatMeta = (v) =>
  EXPENSE_CATEGORIES.find(c => c.v === v) || EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];

// Bank category name → field category value. Only the categories that exist on
// both sides; everything else on the statement (Software Licenses, Office
// Supplies, Fees…) is not a field cost and never reaches this page.
export const FIELD_CAT_BY_BANK = Object.fromEntries(
  EXPENSE_CATEGORIES.filter(c => c.bank).map(c => [c.bank, c.v]));

export const isFieldBankCategory = (name) => Object.prototype.hasOwnProperty.call(FIELD_CAT_BY_BANK, name || "");

// ── The unified list ────────────────────────────────────────────────────────
// One row per real cost, no matter where it was entered:
//   · a manual expense (the only side that carries driver / truck / trip / job)
//   · a statement line whose category is a field cost and that nobody typed here
//
// A manual expense paid by bank and its statement line are THE SAME COST, so
// they collapse into one row — the manual one, because it is the one with the
// attribution — flagged `reconciled`. Without that collapse the page would
// double-count every bank-paid expense, which is exactly the trap of showing
// both ledgers side by side.
//
// The pairing reuses matchBankToExpenses (amount within a cent, date within a
// window), the same heuristic the Bancos reconciliation tab uses. It is a
// guess, not an identity: `reconciled` is a hint for the reader, never a
// number the page adds up twice.
export function mergeFieldExpenses({ expenses = [], bankTxns = [], categories = [], windowDays = 7 }) {
  const fieldTxns = bankTxns.filter(t =>
    t.status !== "ignored" &&
    signedAmount(t) < 0 &&
    isFieldBankCategory(t.category));

  const { matched } = matchBankToExpenses({ bankTxns: fieldTxns, expenses, categories, windowDays });
  const matchedTxnIds = new Set(matched.map(m => m.txn.id));
  const matchedExpenseIds = new Set(matched.map(m => m.expense.id));

  const rows = expenses.map(e => ({
    key: `m-${e.id}`,
    source: "manual",
    id: e.id,
    date: e.expense_date || (e.created_at || "").slice(0, 10),
    amount: numv(e.amount),
    category: e.category || "other",
    vendor: e.vendor || "",
    notes: e.notes || "",
    driverId: e.driver_id || null,
    truckId: e.truck_id || null,
    tripId: e.trip_id || null,
    jobNumber: e.job_number || "",
    paidFrom: e.paid_from || "bank",
    status: e.status || "pending",
    reconciled: matchedExpenseIds.has(e.id),
    raw: e,
  }));

  for (const t of fieldTxns) {
    if (matchedTxnIds.has(t.id)) continue; // already represented by its manual row
    rows.push({
      key: `b-${t.id}`,
      source: "bank",
      id: t.id,
      date: t.txn_date || "",
      amount: Math.abs(signedAmount(t)),
      category: FIELD_CAT_BY_BANK[t.category],
      bankCategory: t.category,
      vendor: t.raw_description || "",
      notes: "",
      driverId: null, truckId: null, tripId: null, jobNumber: "",
      paidFrom: "bank",
      status: t.status || "unreviewed",
      reconciled: false,
      raw: t,
    });
  }

  rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  return rows;
}

// Totals for the tiles. `unattributed` is the number the page exists to shrink:
// money that moved but that nobody tied to a driver, truck, trip or job.
export function fieldExpenseTotals(rows) {
  let total = 0, fromBank = 0, manual = 0, unattributed = 0, unattributedCount = 0;
  for (const r of rows) {
    total += r.amount;
    if (r.source === "bank") fromBank += r.amount; else manual += r.amount;
    if (!r.driverId && !r.truckId && !r.tripId && !r.jobNumber) {
      unattributed += r.amount;
      unattributedCount += 1;
    }
  }
  return { total, fromBank, manual, unattributed, unattributedCount, count: rows.length };
}
