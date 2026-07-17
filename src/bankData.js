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
// One shared copy. `dir` drives the P&L sign; `mapExpense` maps to the existing
// EXPENSE_CATEGORIES keys (src/expenses.jsx) so outflow reconciliation is direct.
// `transfer` rows are kept for reconciliation but excluded from the P&L.
export const BANK_CATEGORIES = [
  // Income (inflows)
  { v:"customer_payment", l:"Cobro de cliente", icon:"💰", dir:"in" },
  { v:"broker_payment",   l:"Pago de broker",   icon:"🤝", dir:"in" },
  { v:"storage_income",   l:"Ingreso storage",  icon:"🏬", dir:"in" },
  { v:"refund_in",        l:"Reembolso recibido", icon:"↩️", dir:"in" },
  { v:"owner_contribution", l:"Aporte del dueño", icon:"➕", dir:"in" },
  { v:"transfer_in",      l:"Transferencia entre cuentas (entra)", icon:"🔁", dir:"transfer" },
  { v:"other_income",     l:"Otro ingreso",     icon:"🟢", dir:"in" },
  // Expense (outflows)
  { v:"fuel",         l:"Combustible", icon:"⛽", dir:"out", mapExpense:"fuel" },
  { v:"tolls",        l:"Peajes",      icon:"🛣️", dir:"out", mapExpense:"tolls" },
  { v:"maintenance",  l:"Mantenimiento", icon:"🔧", dir:"out", mapExpense:"maintenance" },
  { v:"materials",    l:"Materiales",  icon:"📦", dir:"out", mapExpense:"materials" },
  { v:"lodging",      l:"Hotel / alojamiento", icon:"🏨", dir:"out", mapExpense:"hotel" },
  { v:"meals",        l:"Comidas",     icon:"🍔", dir:"out", mapExpense:"meals" },
  { v:"truck_lease",  l:"Lease / cuota camión", icon:"🚛", dir:"out" },
  { v:"driver_pay",   l:"Pago a drivers", icon:"🧑‍✈️", dir:"out" },
  { v:"payroll_office", l:"Sueldos oficina", icon:"👔", dir:"out" },
  { v:"commissions",  l:"Comisiones",  icon:"📈", dir:"out" },
  { v:"insurance",    l:"Seguros",     icon:"🛡️", dir:"out" },
  { v:"rent_storage", l:"Alquiler depósito", icon:"🏢", dir:"out" },
  { v:"utilities",    l:"Servicios (luz, agua…)", icon:"💡", dir:"out" },
  { v:"software_subscriptions", l:"Software / suscripciones", icon:"💻", dir:"out" },
  { v:"bank_fees",    l:"Comisiones bancarias", icon:"🏦", dir:"out" },
  { v:"taxes",        l:"Impuestos",   icon:"🧾", dir:"out" },
  { v:"marketing",    l:"Marketing",   icon:"📣", dir:"out" },
  { v:"refund_out",   l:"Reembolso a cliente", icon:"↪️", dir:"out" },
  { v:"owner_draw",   l:"Retiro del dueño", icon:"➖", dir:"out" },
  { v:"transfer_out", l:"Transferencia entre cuentas (sale)", icon:"🔁", dir:"transfer" },
  { v:"other_expense", l:"Otro gasto",  icon:"🔴", dir:"out" },
];
export const bankCatMeta = (v) => BANK_CATEGORIES.find(c => c.v === v) || null;
export const isTransferCat = (v) => bankCatMeta(v)?.dir === "transfer";

export const BANK_STATUS = {
  unreviewed: { l:"Sin revisar", bg:"#FEF3C7", text:"#92760B" },
  categorized:{ l:"Categorizado", bg:"#E6F1FB", text:"#185FA5" },
  verified:   { l:"Verificado", bg:"#EAF3DE", text:"#3B6D11" },
  ignored:    { l:"Ignorado", bg:"#f1f1f1", text:"#888" },
};

export const EMPTY_BANK_ACCOUNT = { name:"", bank_name:"", account_last4:"", type:"checking", currency:"USD", opening_balance:"", opening_date:"", notes:"" };
export const EMPTY_BANK_TXN = { bank_account_id:"", txn_date:"", amount:"", direction:"in", raw_description:"", counterparty:"", category:"", notes:"" };

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
export function matchBankToPayments({ bankTxns, payments, tolerance = 0.01, windowDays = 5 }) {
  const inflows = bankTxns.filter(t => signedAmount(t) > 0 && !isTransferCat(t.category));
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
export function matchBankToExpenses({ bankTxns, expenses, tolerance = 0.01, windowDays = 7 }) {
  const outflows = bankTxns.filter(t => signedAmount(t) < 0 && !isTransferCat(t.category));
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
export function reconcileBank({ bankTxns, payments, expenses, tolerance = 0.01 }) {
  const txns = bankTxns.filter(t => t.status !== "ignored");
  const pay = matchBankToPayments({ bankTxns: txns, payments, tolerance });
  const exp = matchBankToExpenses({ bankTxns: txns, expenses, tolerance });

  const linkByTxn = new Map();
  for (const m of pay.matched) linkByTxn.set(m.txn.id, { match_status: "matched", match_kind: "payment", payment_id: m.payment.id });
  for (const m of exp.matched) linkByTxn.set(m.txn.id, { match_status: "matched", match_kind: "expense", expense_id: m.expense.id });

  const transfers = txns.filter(t => isTransferCat(t.category));
  const discrepancies = [];
  // A) bank lines (non-transfer) with no match
  for (const t of [...pay.unmatchedBank, ...exp.unmatchedBank]) {
    if (isTransferCat(t.category)) continue;
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
// Categorized inflows − outflows over a period. Considers only verified rows by
// default (owner shouldn't build a P&L on un-reviewed data); transfers excluded.
export function bankPnl({ bankTxns, from, to, onlyVerified = true }) {
  const inRange = (d) => (!from || d >= from) && (!to || d <= to);
  const rows = bankTxns.filter(t =>
    t.status !== "ignored" &&
    (!onlyVerified || t.status === "verified") &&
    !isTransferCat(t.category) &&
    inRange(t.txn_date || ""));

  const byCat = {};
  let income = 0, expense = 0;
  for (const t of rows) {
    const amt = signedAmount(t);
    const cat = t.category || (amt >= 0 ? "other_income" : "other_expense");
    byCat[cat] = (byCat[cat] || 0) + amt;
    if (amt >= 0) income += amt; else expense += amt; // expense is negative
  }
  const categories = Object.entries(byCat)
    .map(([v, total]) => ({ v, meta: bankCatMeta(v), total }))
    .sort((a, b) => b.total - a.total);

  // Monthly net series (zero-filled across the range when both ends are known).
  const monthTotals = {};
  for (const t of rows) {
    const mo = monthOf(t.txn_date || "");
    if (mo) monthTotals[mo] = (monthTotals[mo] || 0) + signedAmount(t);
  }
  const fromMo = monthOf(from || ""), toMo = monthOf(to || "");
  const months = (fromMo && toMo) ? monthsBetween(fromMo, toMo) : Object.keys(monthTotals).sort();
  const series = months.map(mo => ({ month: mo, net: monthTotals[mo] || 0 }));

  return { income, expense: Math.abs(expense), net: income + expense, categories, series, count: rows.length };
}
