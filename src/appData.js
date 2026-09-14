// Pure math for the main app (src/App.jsx): closing-sheet settlement, extra
// commissions, BOL collection, payment banking and compliance-document expiry.
// No React, no Supabase — runs under plain node (scripts/test-app-data.mjs).
import { numv, parseCf } from "./analyticsData.js";

// ── Dates ────────────────────────────────────────────────────────────────────
export const today = () => new Date().toISOString().slice(0, 10);
export const fmtDateLocal = (d) => d ? `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}` : null;
export const addDaysStr = (dateStr, n) => { const d = new Date(dateStr + "T00:00:00"); d.setDate(d.getDate() + n); return fmtDateLocal(d); };
// Whole days elapsed since a YYYY-MM-DD date (local midnight); 0 when empty.
export const daysSince = (dateStr, now = Date.now()) => { if (!dateStr) return 0; const d = new Date(dateStr + "T00:00:00"); return Math.floor((now - d.getTime()) / 86400000); };

// ── Job extras: commissions and extra-CF math ────────────────────────────────
// Commission % auto-fill rules. Returns { driver, rep } percentages; always editable after.
export function commissionDefaults(extraType, generatedBy) {
  if (extraType === "long_carry" || extraType === "stairs") return { driver:50, rep:0 };
  if (extraType === "shuttle") {
    if (generatedBy === "driver_only") return { driver:10, rep:0 };
    if (generatedBy === "driver_and_rep") return { driver:7, rep:3 };
    if (generatedBy === "rep_only") return { driver:0, rep:5 };
  }
  // extra_cf, packing, flight_charge, other
  if (generatedBy === "driver_only") return { driver:10, rep:0 };
  if (generatedBy === "driver_and_rep") return { driver:7, rep:3 };
  if (generatedBy === "rep_only") return { driver:0, rep:10 };
  return { driver:0, rep:0 };
}
// Extra CF math: CF×rate subtotal, fuel surcharge, total, and the commission base.
export function extraCfCalc(o) {
  const cfCount = numv(o.extra_cf_count), cfRate = numv(o.extra_cf_rate);
  const cfSub = cfCount * cfRate;
  const fuelPct = numv(o.fuel_surcharge_pct);
  const fuelAmt = cfSub * fuelPct / 100;
  const total = cfSub + fuelAmt;
  const commissionBase = o.commission_base === "without_fuel" ? "without_fuel" : "with_fuel";
  const base = commissionBase === "without_fuel" ? cfSub : total;
  return { cfCount, cfRate, cfSub, fuelPct, fuelAmt, total, commissionBase, base };
}

// ── BOL collection and closing-sheet settlement ──────────────────────────────
// Collection status for a BOL job: complete / partial / pending.
export function collectionStatus(j) {
  const bal = numv(j.bol_balance), col = numv(j.bol_collected);
  if (bal > 0 && col >= bal) return { key:"complete", l:"Collected", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" };
  if (col > 0) return { key:"partial", l:"Partial", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" };
  return { key:"pending", l:"Pending", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" };
}
// Missing pads for a single job (received minus returned, floored at 0).
export const jobPadsMissing = (j) => Math.max(0, numv(j.pads_received) - numv(j.pads_returned));
// All settlement math for a closing sheet given its (deduped-by-job) job rows.
// Pads are tallied per job (received/returned), not from the sheet header.
export function sheetCalc(sheet, jobsIn) {
  let carrierFee = 0, bolBalance = 0, bolCollected = 0, totalCf = 0, padsSent = 0, padsReturned = 0, padsMissing = 0;
  for (const j of jobsIn) {
    const cf = parseCf(j.volume);
    totalCf += cf;
    carrierFee += cf * numv(j.carrier_rate_per_cf);
    bolBalance += numv(j.bol_balance);
    bolCollected += numv(j.bol_collected);
    padsSent += numv(j.pads_received);
    padsReturned += numv(j.pads_returned);
    padsMissing += jobPadsMissing(j);
  }
  const padsCharge = padsMissing * (sheet?.charge_per_pad != null ? numv(sheet.charge_per_pad) : 7);
  const deductions = numv(sheet?.trip_cost) + numv(sheet?.labor_charges) + numv(sheet?.other_fees) + padsCharge;
  const netCarrier = carrierFee - deductions;       // what the broker owes us
  const pending = Math.max(0, bolBalance - bolCollected);
  const net = netCarrier - bolCollected;            // >0 broker owes us, <0 we owe broker
  return { carrierFee, bolBalance, bolCollected, totalCf, padsSent, padsReturned, padsMissing, padsCharge, deductions, netCarrier, pending, net, jobCount: jobsIn.length };
}

// ── Payments: money in, who holds it, what's banked ──────────────────────────
// These rules already live in bankShared.js / paymentAlloc.js (the bank
// reconciliation and AP/AR import them there); App.jsx used to carry inline
// copies. Re-exported so the main app reads them from one place.
export { effectiveBanked, bankedDateOf } from "./bankShared.js";
export { paymentNet } from "./paymentAlloc.js";
import { effectiveBanked as _effBanked } from "./bankShared.js";
import { paymentNet as _payNet } from "./paymentAlloc.js";

// ── How a payment is SHOWN ───────────────────────────────────────────────────
// A payment that the client made with several methods, or that was applied to
// several charges, is stored as several rows sharing a split_group (one method
// and one charge per row). The UI shows it as ONE payment: this groups the rows
// back, and splits each group two ways — by how it was paid (`lines`) and by
// what it covered (`covers`).
//   moneyStatus(row) → "pending" | "circulation" | "deposited"
//   groupPayments(rows) → [{ key, rows, total, date, received_by, lines, covers, onAccount }]
//     lines:  [{ key, method, serial, check_type, mo_type, amount, status, holder, account, rows }]
//     covers: [{ key, concept, extra_type, job_extra_id, amount, rows }]
export function moneyStatus(p) {
  if (!p.received) return "pending";
  return _effBanked(p) ? "deposited" : "circulation";
}
export function groupPayments(rows) {
  const byKey = new Map();
  for (const p of rows || []) {
    const key = p.split_group ? "g:" + p.split_group : "p:" + p.id;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(p);
  }
  const out = [];
  for (const [key, grp] of byKey) {
    const sorted = grp.slice().sort((a, b) => numv(a.id) - numv(b.id));
    const rep = sorted[0];
    const lines = new Map(), covers = new Map();
    for (const p of sorted) {
      const serial = p.check_serial || p.mo_serial || "";
      const lk = [p.method || "", serial, p.check_type || "", p.mo_type || ""].join("|");
      if (!lines.has(lk)) lines.set(lk, { key: lk, method: p.method || null, serial, check_type: p.check_type || null, mo_type: p.mo_type || null, amount: 0, status: moneyStatus(p), holder: p.cash_with_whom || null, account: p.bank_account || null, photo: p.check_photo_url || p.mo_photo_url || null, rows: [] });
      const l = lines.get(lk); l.amount += _payNet(p); l.rows.push(p);
      // A line is only as far along as its least-advanced row.
      const rank = { pending: 0, circulation: 1, deposited: 2 };
      if (rank[moneyStatus(p)] < rank[l.status]) l.status = moneyStatus(p);
      if (!l.holder && p.cash_with_whom) l.holder = p.cash_with_whom;
      if (!l.account && p.bank_account) l.account = p.bank_account;
      const ck = p.concept === "extra" ? "extra:" + (p.job_extra_id ?? ("t:" + (p.extra_type || ""))) : p.concept || "job";
      if (!covers.has(ck)) covers.set(ck, { key: ck, concept: p.concept || "job", extra_type: p.extra_type || null, job_extra_id: p.job_extra_id ?? null, amount: 0, rows: [] });
      const c = covers.get(ck); c.amount += _payNet(p); c.rows.push(p);
    }
    const total = sorted.reduce((s, p) => s + _payNet(p), 0);
    const onAccount = sorted.filter(p => p.concept === "on_account").reduce((s, p) => s + _payNet(p), 0);
    out.push({ key, rows: sorted, rep, total, date: rep.payment_date || null, received_by: rep.received_by || null, received_date: rep.received_date || null, notes: rep.notes || null, lines: [...lines.values()], covers: [...covers.values()], onAccount, isGroup: sorted.length > 1 });
  }
  return out.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || numv(b.rep.id) - numv(a.rep.id));
}

// ── Compliance documents ─────────────────────────────────────────────────────
// Auto status from expiry date: expired / expiring_soon (≤30d) / active / none.
export function docStatus(doc, td = today()) {
  if (!doc || !doc.expiry_date) return "none";
  if (doc.expiry_date < td) return "expired";
  if (doc.expiry_date <= addDaysStr(td, 30)) return "expiring_soon";
  return "active";
}
export const docDaysToExpiry = (doc, td = today()) => doc?.expiry_date ? Math.round((new Date(doc.expiry_date + "T00:00:00") - new Date(td + "T00:00:00")) / 86400000) : null;
