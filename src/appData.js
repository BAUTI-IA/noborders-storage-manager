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

// ── Compliance documents ─────────────────────────────────────────────────────
// Auto status from expiry date: expired / expiring_soon (≤30d) / active / none.
export function docStatus(doc, td = today()) {
  if (!doc || !doc.expiry_date) return "none";
  if (doc.expiry_date < td) return "expired";
  if (doc.expiry_date <= addDaysStr(td, 30)) return "expiring_soon";
  return "active";
}
export const docDaysToExpiry = (doc, td = today()) => doc?.expiry_date ? Math.round((new Date(doc.expiry_date + "T00:00:00") - new Date(td + "T00:00:00")) / 86400000) : null;
