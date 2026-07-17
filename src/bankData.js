// Bancos module — pure derived-metric math (no React), so it can be unit-tested
// with plain node (`node scripts/test-bank-data.mjs`), same pattern as
// analyticsData.js / paymentAlloc.js.
//
// This is the reconciliation + bank-P&L brain: it takes the real bank statement
// lines (bank_transactions) plus the operational ledgers (payments, expenses)
// and computes — WITHOUT mutating anything — whether "los números dan": which
// bank lines have an operational counterpart, and which discrepancies (money in
// the bank with no backing, or recorded money that never hit the bank) the owner
// should investigate.

import { paymentNet } from "./paymentAlloc.js";
import { numv, monthOf, monthsBetween } from "./analyticsData.js";
import { effectiveBanked, bankedDateOf } from "./bankShared.js";

// ── Chart of accounts ───────────────────────────────────────────────────────
// The catalog lives in the DB (public.bank_categories) so the owner can add his
// own categories from the UI. This seed replicates EXACTLY the taxonomy the
// bookkeeper already uses in the Bank Flows Excel (concept names + the Type
// grouping used for the P&L), so nobody has to re-learn anything. Transactions
// store the category NAME (bank_transactions.category); renaming a category in
// the UI cascade-updates its transactions.
//   direction: 'in' | 'out' | null (null = transfer, usable both ways)
//   pnl_group: the Excel "Type" column — drives the P&L sections
//   is_transfer: kept for reconciliation but excluded from the P&L
export const PNL_GROUPS = ["Cost of Revenues", "Production Expenses", "Structure Expenses", "Sales & Marketing Expenses", "Broker", "CapEx"];
export const SEED_BANK_CATEGORIES = [
  // Inflows
  { name:"Job",    direction:"in", pnl_group:null, is_transfer:false, icon:"💰", sort:1 },
  { name:"Refund", direction:"in", pnl_group:null, is_transfer:false, icon:"↩️", sort:2 },
  // Outflows · Cost of Revenues
  { name:"Hotels",              direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"🏨", sort:10 },
  { name:"Fuel",                direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"⛽", sort:11 },
  { name:"Salaries - Employees", direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"🧑‍✈️", sort:12 },
  { name:"Salaries - Helpers",  direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"💪", sort:13 },
  { name:"Toll",                direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"🛣️", sort:14 },
  { name:"Truck Repair",        direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"🔧", sort:15 },
  { name:"Packaging",           direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"📦", sort:16 },
  { name:"Commissions",         direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"📈", sort:17 },
  { name:"Claims",              direction:"out", pnl_group:"Cost of Revenues", is_transfer:false, icon:"⚠️", sort:18 },
  // Outflows · Production Expenses
  { name:"Storage",             direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"🏬", sort:20 },
  { name:"Truck Licensing Fees", direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"📋", sort:21 },
  { name:"Truck Rental",        direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"🚛", sort:22 },
  { name:"Truck Maintenance",   direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"🛠️", sort:23 },
  { name:"Truck Insurance",     direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"🛡️", sort:24 },
  { name:"Truck Utilities",     direction:"out", pnl_group:"Production Expenses", is_transfer:false, icon:"💡", sort:25 },
  // Outflows · Structure Expenses
  { name:"Fees",                direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🏦", sort:30 },
  { name:"Software Licenses",   direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"💻", sort:31 },
  { name:"Ground Transportation", direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🚕", sort:32 },
  { name:"Airfare",             direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"✈️", sort:33 },
  { name:"Car Rental",          direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🚗", sort:34 },
  { name:"Office Supplies",     direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🖇️", sort:35 },
  { name:"Loren Expenses",      direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"👤", sort:36 },
  { name:"Bauti Expenses",      direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"👤", sort:37 },
  { name:"Taxes",               direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🧾", sort:38 },
  { name:"Fines",               direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"🚨", sort:39 },
  { name:"Other",               direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"💵", sort:40 },
  // Outflows · Broker / Sales & Marketing
  { name:"Broker",              direction:"out", pnl_group:"Broker", is_transfer:false, icon:"🤝", sort:50 },
  { name:"Marketing",           direction:"out", pnl_group:"Sales & Marketing Expenses", is_transfer:false, icon:"📣", sort:51 },
  // Transfers (both directions; excluded from P&L and reconciliation)
  { name:"Transfer Between Accounts", direction:null, pnl_group:null, is_transfer:true, icon:"🔁", sort:90 },
];

// Category helpers take the live catalog (rows of bank_categories) so they see
// whatever the owner added; they fall back to the seed when none is passed
// (tests, or the DB table hasn't loaded yet).
export const catByName = (categories, name) =>
  (categories?.length ? categories : SEED_BANK_CATEGORIES).find(c => c.name === name) || null;
export const isTransferCat = (categories, name) => !!catByName(categories, name)?.is_transfer;

export const BANK_STATUS = {
  unreviewed: { l:"Sin revisar", bg:"#FEF3C7", text:"#92760B" },
  categorized:{ l:"Categorizado", bg:"#E6F1FB", text:"#185FA5" },
  verified:   { l:"Verificado", bg:"#EAF3DE", text:"#3B6D11" },
  ignored:    { l:"Ignorado", bg:"#f1f1f1", text:"#888" },
};

export const PAYMENT_METHODS_BANK = ["Zelle", "Venmo", "Cash Deposit", "Money Order", "Cashier's Check", "Personal Check", "Official Check", "Online Transfer", "Card", "Debit", "Credit", "Check", "Transfer", "Other"];

export const EMPTY_BANK_ACCOUNT = { name:"", bank_name:"", account_last4:"", type:"checking", currency:"USD", opening_balance:"", opening_date:"", notes:"" };
export const EMPTY_BANK_CATEGORY = { name:"", direction:"out", pnl_group:"Structure Expenses", is_transfer:false, icon:"", active:true };

// ── Normalization / dedup ────────────────────────────────────────────────────
export const normDesc = (s) => (s || "").toLowerCase().replace(/\s+/g, " ").trim();
// Stable identity of a statement line so re-uploading the same statement doesn't
// duplicate rows. account | date | signed-amount(2dp) | normalized description.
export function dedupHash({ bank_account_id, txn_date, amount, raw_description }) {
  const amt = numv(amount).toFixed(2);
  return [bank_account_id ?? "", txn_date || "", amt, normDesc(raw_description)].join("|");
}
// A line's signed amount: inflows positive, outflows negative, regardless of how
// the source expressed it (sign, or a debit/credit column).
export function signedAmount({ amount, direction }) {
  const a = numv(amount);
  if (direction === "out" || direction === "debit") return -Math.abs(a);
  if (direction === "in" || direction === "credit") return Math.abs(a);
  return a; // already signed
}

// ── CSV parser (no dependency) ───────────────────────────────────────────────
// Quoted-field aware ("" escapes, embedded commas/newlines). Returns array of
// string arrays (rows of cells).
export function parseCsv(text) {
  const rows = [];
  let row = [], cell = "", i = 0, inQuotes = false;
  const s = String(text ?? "").replace(/\r\n?/g, "\n");
  while (i < s.length) {
    const ch = s[i];
    if (inQuotes) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuotes = true; i++; continue; }
    if (ch === ",") { row.push(cell); cell = ""; i++; continue; }
    if (ch === "\n") { row.push(cell); rows.push(row); row = []; cell = ""; i++; continue; }
    cell += ch; i++;
  }
  if (cell !== "" || row.length) { row.push(cell); rows.push(row); }
  return rows.filter(r => r.length && r.some(c => c.trim() !== ""));
}

const parseMoney = (v) => {
  if (v == null) return 0;
  const neg = /^\s*[(-]/.test(String(v)); // (123.45) or -123.45
  const n = Number(String(v).replace(/[^0-9.]/g, ""));
  if (!isFinite(n)) return 0;
  return neg ? -Math.abs(n) : n;
};

// Map parsed CSV rows to bank_transaction drafts. `mapping` names the columns by
// header (case-insensitive) or 0-based index: { date, description, amount }  OR
// { date, description, debit, credit } for banks that split in/out into columns.
// `hasHeader` (default true) skips the first row and enables header-name lookup.
export function mapBankCsv(rows, mapping, { hasHeader = true, bank_account_id = null } = {}) {
  if (!rows.length) return [];
  const header = hasHeader ? rows[0].map(h => normDesc(h)) : null;
  const body = hasHeader ? rows.slice(1) : rows;
  const idxOf = (key) => {
    const m = mapping[key];
    if (m == null || m === "") return -1;
    if (typeof m === "number") return m;
    return header ? header.indexOf(normDesc(m)) : -1;
  };
  const iDate = idxOf("date"), iDesc = idxOf("description");
  const iAmount = idxOf("amount"), iDebit = idxOf("debit"), iCredit = idxOf("credit");
  return body.map(r => {
    let amt;
    if (iAmount >= 0) amt = parseMoney(r[iAmount]);
    else {
      const debit = iDebit >= 0 ? Math.abs(parseMoney(r[iDebit])) : 0;
      const credit = iCredit >= 0 ? Math.abs(parseMoney(r[iCredit])) : 0;
      amt = credit - debit; // credit = inflow (+), debit = outflow (−)
    }
    const raw_description = iDesc >= 0 ? String(r[iDesc] ?? "").trim() : "";
    const txn_date = iDate >= 0 ? String(r[iDate] ?? "").trim() : "";
    const draft = { bank_account_id, txn_date, amount: amt, direction: amt < 0 ? "out" : "in", raw_description, source: "csv" };
    return { ...draft, dedup_hash: dedupHash(draft) };
  }).filter(d => d.txn_date || d.raw_description || d.amount);
}

// ── Reconciliation ───────────────────────────────────────────────────────────
const daysApart = (a, b) => {
  if (!a || !b) return Infinity;
  return Math.abs((new Date(a + "T00:00:00") - new Date(b + "T00:00:00")) / 86400000);
};

// Match inflows to banked payments. One-to-one greedy match by amount (within
// tolerance) and date proximity (within windowDays). Excludes transfers.
export function matchBankToPayments({ bankTxns, payments, categories = [], tolerance = 0.01, windowDays = 5 }) {
  const inflows = bankTxns.filter(t => signedAmount(t) > 0 && !isTransferCat(categories, t.category));
  const banked = payments.filter(p => effectiveBanked(p));
  const usedP = new Set();
  const matched = [], unmatchedBank = [];
  for (const t of inflows) {
    const amt = signedAmount(t);
    const cand = banked
      .filter(p => !usedP.has(p.id) && Math.abs(paymentNet(p) - amt) <= tolerance)
      .sort((a, b) => daysApart(bankedDateOf(a), t.txn_date) - daysApart(bankedDateOf(b), t.txn_date))[0];
    if (cand && daysApart(bankedDateOf(cand), t.txn_date) <= windowDays) {
      usedP.add(cand.id);
      matched.push({ txn: t, payment: cand });
    } else unmatchedBank.push(t);
  }
  const unmatchedPayments = banked.filter(p => !usedP.has(p.id));
  return { matched, unmatchedBank, unmatchedPayments };
}

// Match outflows to bank-paid expenses.
export function matchBankToExpenses({ bankTxns, expenses, categories = [], tolerance = 0.01, windowDays = 7 }) {
  const outflows = bankTxns.filter(t => signedAmount(t) < 0 && !isTransferCat(categories, t.category));
  const bankExp = expenses.filter(e => (e.paid_from || "bank") === "bank");
  const usedE = new Set();
  const matched = [], unmatchedBank = [];
  for (const t of outflows) {
    const amt = Math.abs(signedAmount(t));
    const cand = bankExp
      .filter(e => !usedE.has(e.id) && Math.abs(numv(e.amount) - amt) <= tolerance)
      .sort((a, b) => daysApart(a.expense_date, t.txn_date) - daysApart(b.expense_date, t.txn_date))[0];
    if (cand && daysApart(cand.expense_date, t.txn_date) <= windowDays) {
      usedE.add(cand.id);
      matched.push({ txn: t, expense: cand });
    } else unmatchedBank.push(t);
  }
  const unmatchedExpenses = bankExp.filter(e => !usedE.has(e.id));
  return { matched, unmatchedBank, unmatchedExpenses };
}

// Full reconciliation: returns per-txn match links plus the discrepancy lists
// that answer "¿cuadra o no cuadra?".
//  A) bank money with no operational counterpart (unrecorded income / theft)
//  B) recorded banked payment / bank expense that never hit the bank
//  C) (amount mismatches surface as A+B pairs the reviewer eyeballs)
export function reconcileBank({ bankTxns, payments, expenses, categories = [], tolerance = 0.01 }) {
  const txns = bankTxns.filter(t => t.status !== "ignored");
  const pay = matchBankToPayments({ bankTxns: txns, payments, categories, tolerance });
  const exp = matchBankToExpenses({ bankTxns: txns, expenses, categories, tolerance });

  const linkByTxn = new Map();
  for (const m of pay.matched) linkByTxn.set(m.txn.id, { match_status: "matched", match_kind: "payment", payment_id: m.payment.id });
  for (const m of exp.matched) linkByTxn.set(m.txn.id, { match_status: "matched", match_kind: "expense", expense_id: m.expense.id });

  const transfers = txns.filter(t => isTransferCat(categories, t.category));
  const discrepancies = [];
  // A) bank lines (non-transfer) with no match
  for (const t of [...pay.unmatchedBank, ...exp.unmatchedBank]) {
    if (isTransferCat(categories, t.category)) continue;
    discrepancies.push({ kind: "bank_no_backing", txn: t, amount: signedAmount(t),
      reason: signedAmount(t) > 0 ? "Entró plata al banco sin cobro operativo asociado" : "Salió plata del banco sin gasto operativo asociado" });
  }
  // B) operational money that never appears in the bank
  for (const p of pay.unmatchedPayments)
    discrepancies.push({ kind: "payment_no_bank", payment: p, amount: paymentNet(p), reason: "Cobro marcado como depositado que no aparece en el banco" });
  for (const e of exp.unmatchedExpenses)
    discrepancies.push({ kind: "expense_no_bank", expense: e, amount: numv(e.amount), reason: "Gasto pagado por banco que no aparece en el extracto" });

  return {
    links: linkByTxn,
    matchedCount: pay.matched.length + exp.matched.length,
    transfersCount: transfers.length,
    discrepancies,
    balances: reconcileTotals(pay, exp),
  };
}

function reconcileTotals(pay, exp) {
  const matchedIn = pay.matched.reduce((s, m) => s + paymentNet(m.payment), 0);
  const matchedOut = exp.matched.reduce((s, m) => s + numv(m.expense.amount), 0);
  return { matchedIn, matchedOut };
}

// ── Bank-based P&L ───────────────────────────────────────────────────────────
// Categorized inflows − outflows over a period, with the same section structure
// the bookkeeper's Excel uses (the category's pnl_group). Considers only
// verified rows by default (the owner shouldn't build a P&L on un-reviewed
// data); transfers excluded.
export function bankPnl({ bankTxns, categories = [], from, to, onlyVerified = true }) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const rows = bankTxns.filter(t =>
    t.status !== "ignored" &&
    (!onlyVerified || t.status === "verified") &&
    !isTransferCat(categories, t.category) &&
    inRange(t.txn_date || ""));

  const byCat = {};
  let income = 0, expense = 0;
  for (const t of rows) {
    const amt = signedAmount(t);
    const cat = t.category || (amt >= 0 ? "(sin categoría)" : "(sin categoría)");
    byCat[cat] = (byCat[cat] || 0) + amt;
    if (amt >= 0) income += amt; else expense += amt; // expense is negative
  }
  const catRows = Object.entries(byCat)
    .map(([name, total]) => ({ name, meta: catByName(categories, name), total }))
    .sort((a, b) => b.total - a.total);

  // Sections in the bookkeeper's P&L structure: Ingresos first, then the Excel
  // "Type" groups in their canonical order, then anything else.
  const groupOf = (r) => r.total >= 0 && r.meta?.direction !== "out"
    ? "Ingresos"
    : (r.meta?.pnl_group || "Otros egresos");
  const groupOrder = ["Ingresos", ...PNL_GROUPS, "Otros egresos"];
  const byGroup = {};
  for (const r of catRows) {
    const g = groupOf(r);
    (byGroup[g] = byGroup[g] || { group: g, total: 0, categories: [] });
    byGroup[g].total += r.total;
    byGroup[g].categories.push(r);
  }
  const groups = groupOrder.filter(g => byGroup[g]).map(g => byGroup[g]);

  // Monthly net series (zero-filled across the range when both ends are known).
  const monthTotals = {};
  for (const t of rows) {
    const mo = monthOf(t.txn_date || "");
    if (mo) monthTotals[mo] = (monthTotals[mo] || 0) + signedAmount(t);
  }
  const fromMo = monthOf(from || ""), toMo = monthOf(to || "");
  const months = (fromMo && toMo) ? monthsBetween(fromMo, toMo) : Object.keys(monthTotals).sort();
  const series = months.map(mo => ({ month: mo, net: monthTotals[mo] || 0 }));

  return { income, expense: Math.abs(expense), net: income + expense, categories: catRows, groups, series, count: rows.length };
}
