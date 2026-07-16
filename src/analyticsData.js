// Analytics derived-metric math (pure, no React) — every function takes plain
// arrays/objects and returns plain data, so it can be unit-tested with plain
// node (`node scripts/test-analytics-data.mjs`), same pattern as paymentAlloc.js.
//
// IMPORTANT: a job spans one row per storage unit it occupies, so every
// job-level metric MUST dedupe by jobKey first or it double-counts.

import { paymentNet } from "./paymentAlloc.js";

// ── Shared tiny helpers (moved out of App.jsx so both modules use one copy) ──
export const numv = (v) => (v && !isNaN(Number(v))) ? Number(v) : 0;
export const money = (v) => (v || v === 0) && !isNaN(Number(v)) ? `$${Number(v).toLocaleString()}` : null;
// Group key for a job: same job_number = same job (across locations). Blank number = standalone.
export const jobKey = (j) => j.job_number && j.job_number.trim() ? `n:${j.job_number.trim().toLowerCase()}` : `id:${j.id}`;
export const parseCf = (v) => { if (!v) return 0; const m = String(v).match(/[\d,.]+/); return m ? Number(m[0].replace(/,/g, "")) || 0 : 0; };
// Effective CF of a job: the REAL measured cubic feet (loaded at pickup) when
// present, else the broker's estimate parsed from `volume`. Occupancy math
// (storage + truck) must use this — reality beats the estimate.
export const effCf = (j) => { const r = Number(j?.real_cf); return isFinite(r) && r > 0 ? r : parseCf(j?.volume); };
export const hasRealCf = (j) => { const r = Number(j?.real_cf); return isFinite(r) && r > 0; };

// Cash, check and money order are physically held; everything else is digital.
// (Single copy — App.jsx and the driver P&L math must agree on what "physical" means.)
export const PHYSICAL_METHODS = ["cash", "check", "money_order"];
export const isPhysical = (m) => PHYSICAL_METHODS.includes(m);
export const isDigitalMethod = (m) => !!m && !PHYSICAL_METHODS.includes(m);

// Job status palette — the app's de-facto categorical color table.
export const STATUSES = [
  { v:"scheduled", l:"Scheduled", bg:"#E6F1FB", text:"#185FA5", dot:"#378ADD" },        // blue
  { v:"picked_up", l:"Picked up", bg:"#FEF3C7", text:"#92760B", dot:"#EAB308" },         // amber
  { v:"in_storage", l:"In storage", bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },        // green
  { v:"out_for_delivery", l:"Out for delivery", bg:"#EDE9FE", text:"#6D28D9", dot:"#7C3AED" }, // purple
  { v:"delivered", l:"Delivered", bg:"#f1f1f1", text:"#888", dot:"#bbb" },                // gray
  { v:"cancelled", l:"Cancelled", bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },          // red
  { v:"on_hold", l:"On hold", bg:"#FEF9C3", text:"#854D0E", dot:"#FACC15" },              // yellow
  { v:"redispatched", l:"Redispatched", bg:"#FDE3CF", text:"#C2410C", dot:"#EA580C" },    // orange
];
export const statusMeta = (v) => STATUSES.find(s => s.v === v) || STATUSES[0];

// ── Month helpers (ISO strings only; the whole app compares dates as strings) ──
export const monthOf = (d) => (d || "").slice(0, 7);
export function monthsBetween(fromMonth, toMonth) {
  if (!fromMonth || !toMonth || fromMonth > toMonth) return [];
  const out = [];
  let [y, m] = fromMonth.split("-").map(Number);
  const [ty, tm] = toMonth.split("-").map(Number);
  while (y < ty || (y === ty && m <= tm)) {
    out.push(`${y}-${String(m).padStart(2, "0")}`);
    m += 1; if (m > 12) { m = 1; y += 1; }
  }
  return out;
}
export function shiftMonth(month, delta) {
  let [y, m] = month.split("-").map(Number);
  m += delta;
  while (m > 12) { m -= 12; y += 1; }
  while (m < 1) { m += 12; y -= 1; }
  return `${y}-${String(m).padStart(2, "0")}`;
}
const MES = { "01":"Ene", "02":"Feb", "03":"Mar", "04":"Abr", "05":"May", "06":"Jun", "07":"Jul", "08":"Ago", "09":"Sep", "10":"Oct", "11":"Nov", "12":"Dic" };
export const monthLabel = (month) => { const [y, m] = (month || "").split("-"); return m ? `${MES[m]} ${String(y).slice(2)}` : ""; };

// Date range from a preset id. Returns { fromMonth, toMonth } ("todo" → fromMonth null).
export function rangeFromPreset(preset, todayISO) {
  const cur = monthOf(todayISO);
  if (preset === "mes") return { fromMonth: cur, toMonth: cur };
  if (preset === "3m") return { fromMonth: shiftMonth(cur, -2), toMonth: cur };
  if (preset === "6m") return { fromMonth: shiftMonth(cur, -5), toMonth: cur };
  if (preset === "12m") return { fromMonth: shiftMonth(cur, -11), toMonth: cur };
  if (preset === "ytd") return { fromMonth: cur.slice(0, 4) + "-01", toMonth: cur };
  return { fromMonth: null, toMonth: cur }; // todo
}
// The equal-length period immediately before [fromMonth..toMonth] (null for "todo").
export function previousRange(range) {
  if (!range.fromMonth) return null;
  const len = monthsBetween(range.fromMonth, range.toMonth).length;
  return { fromMonth: shiftMonth(range.fromMonth, -len), toMonth: shiftMonth(range.fromMonth, -1) };
}

// ── Job grouping ──────────────────────────────────────────────────────────────
// One entry per real job. Representative fields come from the first row seen
// (parts of a job share customer/balances/etc.); date_in keeps the earliest,
// activity flags aggregate across parts.
export function dedupeJobs(jobs) {
  const m = new Map();
  for (const j of jobs) {
    const k = jobKey(j);
    let g = m.get(k);
    if (!g) {
      g = { key: k, rep: j, parts: [], anyOut: false, allOut: true, dateIn: j.date_in || null, dateOut: null };
      m.set(k, g);
    }
    // A split job has extra "portion" rows (same job_number, own CF, money zeroed)
    // so it can ride two trucks. The representative must be the row that carries the
    // money: a non-split unit row if any, else the original (lowest id) split row —
    // the peeled-off portions always have a higher id and zeroed money.
    else if (g.rep.split_group && (!j.split_group || j.id < g.rep.id)) g.rep = j;
    g.parts.push(j);
    if (j.date_in && (!g.dateIn || j.date_in < g.dateIn)) g.dateIn = j.date_in;
    if (j.date_out) { g.anyOut = true; if (!g.dateOut || j.date_out > g.dateOut) g.dateOut = j.date_out; }
    else g.allOut = false;
  }
  return m;
}
// The month a job belongs to for time-series purposes.
export const groupMonth = (g) => monthOf(g.rep.pickup_date || g.dateIn || g.rep.created_at);
// What was actually collected on a job (BOL first, legacy balances as fallback).
export const groupCollected = (g) => numv(g.rep.bol_collected) || (numv(g.rep.pickup_balance) + numv(g.rep.delivery_balance));
// Broker share of a job's collected amount (explicit amount wins over pct).
export const groupBrokerShare = (g) => {
  const j = g.rep;
  return j.broker_job_share_amount != null ? numv(j.broker_job_share_amount) : (groupCollected(g) * numv(j.broker_job_share_pct) / 100);
};
export const extraBrokerShare = (e) => e.broker_share_amount != null ? numv(e.broker_share_amount) : (numv(e.amount) * numv(e.broker_share_pct) / 100);

// ── Global filter context ─────────────────────────────────────────────────────
// The ONE object every period-scoped chart reads. Jobs are sliced by their
// group month, payments by received/payment date, extras by their job's month.
// state filter = the job touches a unit in that state; brokerId = exact match.
export function buildFilterCtx({ records, jobs, jobExtras, payments, range, stateF, brokerF }) {
  const storageState = {};
  for (const r of records) storageState[r.id] = r.state || "";
  const allGroups = [...dedupeJobs(jobs).values()];
  for (const g of allGroups) {
    g.states = [...new Set(g.parts.map(p => storageState[p.storage_id]).filter(Boolean))];
    g.month = groupMonth(g);
  }
  const inSegment = (g) =>
    (!brokerF || String(g.rep.broker_id) === String(brokerF)) &&
    (!stateF || g.states.includes(stateF));
  const inRange = (m) => m && (!range.fromMonth || (m >= range.fromMonth && m <= range.toMonth));

  const segGroups = allGroups.filter(inSegment);
  const groups = segGroups.filter(g => inRange(g.month));

  const keyByRowId = {};
  for (const j of jobs) keyByRowId[j.id] = jobKey(j);
  const segKeys = new Set(segGroups.map(g => g.key));
  const groupByKey = new Map(segGroups.map(g => [g.key, g]));

  const payMonth = (p) => monthOf(p.received_date || p.payment_date || p.created_at);
  const segPayments = payments.filter(p => { const k = keyByRowId[p.job_id]; return !k || segKeys.has(k); });
  const ctxPayments = segPayments.filter(p => inRange(payMonth(p)));

  const extraMonth = (e) => { const g = groupByKey.get(keyByRowId[e.job_id]); return monthOf(g?.dateIn) || monthOf(e.created_at); };
  const segExtras = jobExtras.filter(e => { const k = keyByRowId[e.job_id]; return k && segKeys.has(k); });
  const ctxExtras = segExtras.filter(e => inRange(extraMonth(e)));

  const ctxRecords = stateF ? records.filter(r => r.state === stateF) : records;

  // Zero-filled month axis: explicit range, or every month present in the data for "todo".
  let fromMonth = range.fromMonth;
  if (!fromMonth) {
    const seen = [
      ...groups.map(g => g.month),
      ...ctxPayments.map(payMonth),
      ...ctxRecords.map(r => monthOf(r.date_opened)),
    ].filter(Boolean).sort();
    fromMonth = seen[0] || range.toMonth;
  }
  const months = monthsBetween(fromMonth, range.toMonth);

  return {
    range, stateF, brokerF,
    groups, segGroups, allGroups, groupByKey, keyByRowId,
    payments: ctxPayments, extras: ctxExtras, records: ctxRecords,
    months, payMonth, extraMonth,
  };
}

// ── Storage P&L (snapshot — the date range does not apply) ────────────────────
// What the company PAYS per rented unit vs what clients PAY for storage in it.
// Every non-closed rented unit counts as expense — a vacant unit still gets
// paid every month. A job spanning several units splits its rate evenly so the
// per-unit table sums to the same total as Storage Billing.
export function computeStoragePnl(records, jobs, sitFn) {
  const activeParts = jobs.filter(j => !j.date_out && j.status !== "cancelled");
  const partsByKey = {};
  for (const p of activeParts) { const k = jobKey(p); (partsByKey[k] = partsByKey[k] || []).push(p); }
  const incomeByStorage = {}, jobsByStorage = {};
  for (const parts of Object.values(partsByKey)) {
    // Billing lives on the money-bearing row: a non-split unit row if any, else the
    // original (lowest id) split row. Peeled-off portions have billing zeroed.
    const j = parts.find(p => !p.split_group) || parts.reduce((a, b) => (b.id < a.id ? b : a));
    const storageParts = parts.filter(p => p.storage_id);
    for (const p of storageParts) (jobsByStorage[p.storage_id] = jobsByStorage[p.storage_id] || []).push(p);
    if (!j.billing_active) continue;
    const rate = Number(j.client_monthly_rate) || 0;
    if (!rate || !storageParts.length) continue;
    const share = rate / storageParts.length;
    for (const p of storageParts) incomeByStorage[p.storage_id] = (incomeByStorage[p.storage_id] || 0) + share;
  }
  const rows = records
    .filter(r => r.space_type !== "warehouse" && r.situation !== "Close")
    .map(r => {
      const pay = Number(r.monthly_cost) > 0 ? Number(r.monthly_cost) : 0;
      const income = incomeByStorage[r.id] || 0;
      return {
        id: r.id,
        name: [r.brand, r.unit && ("U" + r.unit), r.state].filter(Boolean).join(" · ") || "—",
        brand: (r.brand || "").trim() || "—",
        state: r.state || "",
        pay, income, margin: income - pay,
        hasCost: Number(r.monthly_cost) > 0,
        occupied: sitFn(r) === "Open",
        jobs: jobsByStorage[r.id] || [],
      };
    })
    .sort((a, b) => a.margin - b.margin);
  const totals = rows.reduce((t, r) => ({ pay: t.pay + r.pay, income: t.income + r.income }), { pay: 0, income: 0 });
  return { rows, totals, missingCost: rows.filter(r => !r.hasCost).length };
}

// Headline snapshot metrics (parity with the old analytics KPI cards).
export function computeMetrics(records, jobs, storagePnl) {
  const activeParts = jobs.filter(j => !j.date_out);
  const deliveredParts = jobs.filter(j => j.date_out);
  const occupied = new Set(activeParts.map(j => j.storage_id).filter(Boolean));
  return {
    activeJobs: new Set(activeParts.map(jobKey)).size,
    deliveredJobs: new Set(deliveredParts.map(jobKey)).size,
    units: records.length,
    occupied: occupied.size,
    states: new Set(records.map(r => r.state).filter(Boolean)).size,
    totalCost: Math.round(storagePnl.totals.pay),
    vacantCost: Math.round(storagePnl.rows.filter(r => !r.occupied).reduce((s, r) => s + r.pay, 0)),
    storageIncome: Math.round(storagePnl.totals.income),
    storageMargin: Math.round(storagePnl.totals.income - storagePnl.totals.pay),
    missingCost: storagePnl.missingCost,
  };
}

// ── Revenue ───────────────────────────────────────────────────────────────────
// Gross vs net totals + per-broker-per-month share. Port of the old
// revenueAnalytics memo: dedupe by (broker, jobKey), explicit share amount wins.
export function computeRevenueSplit(jobs, jobExtras, keyByRowId, groupByKey, allowedKeys) {
  let grossJob = 0, brokerJob = 0, grossExtras = 0, brokerExtras = 0;
  const seen = new Set();
  const monthly = {}; // month -> { brokerId -> amount }
  const addMonthly = (mo, bid, amt) => { if (!amt || !bid || !mo) return; (monthly[mo] = monthly[mo] || {}); monthly[mo][bid] = (monthly[mo][bid] || 0) + amt; };
  const series = {};   // month -> { gross, broker }
  const addSeries = (mo, gross, broker) => { if (!mo) return; const s = (series[mo] = series[mo] || { gross: 0, broker: 0 }); s.gross += gross; s.broker += broker; };
  for (const j of jobs) {
    const k = jobKey(j);
    if (allowedKeys && !allowedKeys.has(k)) continue;
    const sk = (j.broker_id || "x") + "|" + k; if (seen.has(sk)) continue; seen.add(sk);
    const collected = numv(j.bol_collected) || (numv(j.pickup_balance) + numv(j.delivery_balance));
    grossJob += collected;
    const share = j.broker_job_share_amount != null ? numv(j.broker_job_share_amount) : (collected * numv(j.broker_job_share_pct) / 100);
    brokerJob += share;
    const mo = monthOf(j.date_in || j.delivery_date || j.created_at);
    addMonthly(mo, j.broker_id, share);
    addSeries(mo, collected, share);
  }
  for (const e of jobExtras) {
    if (e.active === false) continue;
    const k = keyByRowId[e.job_id];
    if (allowedKeys && (!k || !allowedKeys.has(k))) continue;
    const g = k ? groupByKey.get(k) : null;
    grossExtras += numv(e.amount);
    const share = extraBrokerShare(e); brokerExtras += share;
    const mo = monthOf(g?.dateIn) || monthOf(e.created_at);
    addMonthly(mo, g?.rep?.broker_id ?? g?.broker_id, share);
    addSeries(mo, numv(e.amount), share);
  }
  const gross = grossJob + grossExtras, broker = brokerJob + brokerExtras;
  return { gross, broker, net: gross - broker, grossJob, grossExtras, brokerJob, brokerExtras, monthly, series };
}

// Money actually collected per month from the payments ledger (net of discounts),
// split received vs pending. Fallback (no payments table): approximate from job
// fields by the job's month.
export function monthlyRevenueSeries(ctx, paymentsMissing) {
  const by = {};
  const get = (m) => (by[m] = by[m] || { collected: 0, pending: 0 });
  if (!paymentsMissing) {
    for (const p of ctx.payments) {
      const m = ctx.payMonth(p); if (!m) continue;
      const net = paymentNet(p);
      if (p.received) get(m).collected += net; else get(m).pending += net;
    }
  } else {
    for (const g of ctx.groups) {
      const m = g.month; if (!m) continue;
      get(m).collected += groupCollected(g);
    }
  }
  return ctx.months.map(month => ({ month, label: monthLabel(month), ...((by[month]) || { collected: 0, pending: 0 }) }));
}

// ── AR aging (snapshot) ───────────────────────────────────────────────────────
// Outstanding BOL balance on delivered jobs, bucketed by days since delivery.
export function arAging(groups, todayISO) {
  const buckets = [
    { label: "0–30 días", min: 0, max: 30, amount: 0, count: 0, jobs: [] },
    { label: "31–60 días", min: 31, max: 60, amount: 0, count: 0, jobs: [] },
    { label: "61–90 días", min: 61, max: 90, amount: 0, count: 0, jobs: [] },
    { label: "90+ días", min: 91, max: Infinity, amount: 0, count: 0, jobs: [] },
  ];
  let total = 0, weighted = 0;
  const today = new Date(todayISO + "T00:00:00");
  for (const g of groups) {
    const j = g.rep;
    const delivered = g.anyOut || j.status === "delivered";
    if (!delivered) continue;
    const owed = Math.max(0, numv(j.bol_balance) - numv(j.bol_collected));
    if (owed <= 0) continue;
    const ref = j.delivery_date || g.dateOut || todayISO;
    const days = Math.max(0, Math.round((today - new Date(ref + "T00:00:00")) / 86400000));
    const b = buckets.find(b => days >= b.min && days <= b.max);
    b.amount += owed; b.count += 1;
    b.jobs.push({ key: g.key, job_number: j.job_number || "", customer: j.customer || "", owed, days, broker_id: j.broker_id });
    total += owed; weighted += owed * days;
  }
  for (const b of buckets) b.jobs.sort((a, c) => c.owed - a.owed);
  return { buckets, total, dso: total > 0 ? Math.round(weighted / total) : 0 };
}

// ── Occupancy over time ───────────────────────────────────────────────────────
// Units with a job physically in them during the month vs units open that month.
// Limitation: storages have no close date, so "Close" units are excluded from
// all history (surface this in the card caption).
export function occupancySeries(records, allGroups, months) {
  const units = records.filter(r => r.space_type !== "warehouse" && r.situation !== "Close");
  return months.map(month => {
    const open = units.filter(r => !r.date_opened || monthOf(r.date_opened) <= month);
    const occupiedIds = new Set();
    for (const g of allGroups) {
      if (g.rep.status === "cancelled") continue;
      const inM = g.dateIn && monthOf(g.dateIn) <= month;
      const outBefore = g.allOut && g.dateOut && monthOf(g.dateOut) < month;
      if (!inM || outBefore) continue;
      for (const p of g.parts) if (p.storage_id) occupiedIds.add(p.storage_id);
    }
    const openIds = new Set(open.map(r => r.id));
    const occupied = [...occupiedIds].filter(id => openIds.has(id)).length;
    return { month, label: monthLabel(month), open: open.length, occupied, pct: open.length ? Math.round(occupied / open.length * 100) : 0 };
  });
}

// Length of stay for delivered jobs (days between date_in and date_out).
export function lengthOfStayStats(groups) {
  const days = [];
  for (const g of groups) {
    if (!g.allOut || !g.dateIn || !g.dateOut) continue;
    const d = Math.round((new Date(g.dateOut + "T00:00:00") - new Date(g.dateIn + "T00:00:00")) / 86400000);
    if (d >= 0) days.push(d);
  }
  days.sort((a, b) => a - b);
  const avg = days.length ? Math.round(days.reduce((s, d) => s + d, 0) / days.length) : 0;
  const median = days.length ? days[Math.floor(days.length / 2)] : 0;
  const buckets = [
    { label: "≤30d", min: 0, max: 30 }, { label: "31–60d", min: 31, max: 60 },
    { label: "61–90d", min: 61, max: 90 }, { label: "91–180d", min: 91, max: 180 },
    { label: "180d+", min: 181, max: Infinity },
  ].map(b => ({ ...b, count: days.filter(d => d >= b.min && d <= b.max).length }));
  return { avg, median, n: days.length, buckets };
}

// ── Broker profitability ──────────────────────────────────────────────────────
// Net revenue each broker's jobs leave in the company, over the filtered slice.
export function brokerProfitability(ctx, brokers) {
  const by = {};
  const get = (bid) => (by[bid] = by[bid] || { id: bid, jobs: 0, gross: 0, share: 0, cf: 0 });
  for (const g of ctx.groups) {
    const bid = g.rep.broker_id; if (!bid) continue;
    const b = get(bid);
    b.jobs += 1;
    b.gross += groupCollected(g);
    b.share += groupBrokerShare(g);
    b.cf += effCf(g.rep);
  }
  for (const e of ctx.extras) {
    if (e.active === false) continue;
    const g = ctx.groupByKey.get(ctx.keyByRowId[e.job_id]);
    const bid = g?.rep?.broker_id; if (!bid) continue;
    const b = get(bid);
    b.gross += numv(e.amount);
    b.share += extraBrokerShare(e);
  }
  const nameById = {};
  for (const b of brokers) nameById[b.id] = b.name;
  return Object.values(by).map(b => ({
    ...b,
    name: nameById[b.id] || `Broker #${b.id}`,
    net: b.gross - b.share,
    perJob: b.jobs ? (b.gross - b.share) / b.jobs : 0,
    perCf: b.cf ? (b.gross - b.share) / b.cf : 0,
  })).sort((a, b) => b.net - a.net);
}

// Margin per state from extended P&L rows → feeds the map + state bars.
export function marginByState(pnlRows) {
  const by = {};
  for (const r of pnlRows) {
    if (!r.state) continue;
    const s = (by[r.state] = by[r.state] || { state: r.state, units: 0, pay: 0, income: 0, vacantCost: 0 });
    s.units += 1; s.pay += r.pay; s.income += r.income;
    if (!r.occupied) s.vacantCost += r.pay;
  }
  for (const s of Object.values(by)) s.margin = s.income - s.pay;
  return by;
}

// CF moved per month (job volume by the job's month), zero-filled.
export function cfMovedSeries(ctx) {
  const by = {};
  for (const g of ctx.groups) { if (g.month) by[g.month] = (by[g.month] || 0) + effCf(g.rep); }
  return ctx.months.map(month => ({ month, label: monthLabel(month), cf: Math.round(by[month] || 0) }));
}

// Realized $/CF per month (collected ÷ volume over jobs that have both).
export function dollarsPerCfSeries(ctx) {
  const by = {};
  for (const g of ctx.groups) {
    const cf = effCf(g.rep), coll = groupCollected(g);
    if (!g.month || !cf || !coll) continue;
    const s = (by[g.month] = by[g.month] || { coll: 0, cf: 0 });
    s.coll += coll; s.cf += cf;
  }
  let costSum = 0, costN = 0;
  for (const g of ctx.groups) { const c = numv(g.rep.carrier_rate_per_cf); if (c) { costSum += c; costN += 1; } }
  return {
    series: ctx.months.map(month => {
      const s = by[month];
      return { month, label: monthLabel(month), value: s && s.cf ? +(s.coll / s.cf).toFixed(2) : null };
    }),
    avgCarrierRate: costN ? +(costSum / costN).toFixed(2) : null,
  };
}

// FADD compliance: delivered jobs with a FADD — % delivered on/before it.
export function faddCompliance(ctx) {
  const by = {};
  let onTime = 0, late = 0, lateDays = 0;
  for (const g of ctx.groups) {
    const j = g.rep;
    const delivered = g.anyOut || j.status === "delivered";
    const deliveredOn = j.delivery_date || g.dateOut;
    if (!delivered || !j.fadd || !deliveredOn) continue;
    const m = monthOf(deliveredOn);
    const s = (by[m] = by[m] || { onTime: 0, late: 0 });
    if (deliveredOn <= j.fadd) { s.onTime += 1; onTime += 1; }
    else {
      s.late += 1; late += 1;
      lateDays += Math.round((new Date(deliveredOn + "T00:00:00") - new Date(j.fadd + "T00:00:00")) / 86400000);
    }
  }
  const total = onTime + late;
  return {
    total, onTime, late,
    onTimePct: total ? Math.round(onTime / total * 100) : null,
    avgDaysLate: late ? Math.round(lateDays / late) : 0,
    series: ctx.months.map(month => {
      const s = by[month], t = s ? s.onTime + s.late : 0;
      return { month, label: monthLabel(month), pct: t ? Math.round(s.onTime / t * 100) : null, n: t };
    }),
  };
}

// Jobs by status in canonical STATUSES order.
export function statusFunnel(groups) {
  const counts = {};
  for (const g of groups) { const s = g.rep.status || "scheduled"; counts[s] = (counts[s] || 0) + 1; }
  return STATUSES.map(st => ({ ...st, count: counts[st.v] || 0 })).filter(s => s.count > 0);
}

// New vs delivered jobs per month (operation flow).
export function jobsFlowSeries(ctx) {
  const by = {};
  const get = (m) => (by[m] = by[m] || { nuevos: 0, entregados: 0 });
  for (const g of ctx.segGroups) {
    const mIn = monthOf(g.dateIn || g.rep.pickup_date || g.rep.created_at);
    if (mIn) get(mIn).nuevos += 1;
    if (g.anyOut && g.dateOut) get(monthOf(g.dateOut)).entregados += 1;
  }
  return ctx.months.map(month => ({ month, label: monthLabel(month), ...(by[month] || { nuevos: 0, entregados: 0 }) }));
}

// ── Driver P&L ────────────────────────────────────────────────────────────────
// Revenue attributed per driver over deduped job groups. Multi-driver jobs split
// evenly across driver_ids (union over the group's parts) — an approximation the
// owner can sanity-check by hand; weight-based strategies can plug in later.
// Legacy jobs with only the free-text `driver` field match drivers by name.
export function attributeRevenueToDrivers(groups, driversList, { strategy = "even" } = {}) {
  void strategy; // only "even" exists today
  const nameToId = driversList
    .filter(d => (d.name || "").trim())
    .map(d => [d.name.trim().toLowerCase(), d.id]);
  const byId = new Map(); // driverId -> { revenue, jobs }
  for (const g of groups) {
    const ids = new Set();
    for (const p of g.parts) for (const id of (Array.isArray(p.driver_ids) ? p.driver_ids : [])) ids.add(id);
    if (!ids.size) {
      const txt = (g.rep.driver || "").toLowerCase();
      if (txt) for (const [nm, id] of nameToId) if (txt.includes(nm)) ids.add(id);
    }
    if (!ids.size) continue;
    const share = groupCollected(g) / ids.size;
    for (const id of ids) {
      const cur = byId.get(id) || { revenue: 0, jobs: 0 };
      cur.revenue += share; cur.jobs += 1;
      byId.set(id, cur);
    }
  }
  return byId;
}

// Full per-driver P&L: attributed revenue vs labor (work days × rate) + approved
// expenses + extras commissions. `groups` and `jobExtras` come pre-filtered from
// the analytics ctx; expenses/workDays are filtered here by their own dates.
export function computeDriverPnl({ driversList, groups, jobExtras, expenses, workDays, range }) {
  const inRange = (d) => { const m = monthOf(d); return !!m && (!range || !range.fromMonth || (m >= range.fromMonth && m <= range.toMonth)); };
  const revById = attributeRevenueToDrivers(groups, driversList);
  const rows = driversList.map(d => {
    const rev = revById.get(d.id) || { revenue: 0, jobs: 0 };
    const days = workDays.filter(w => w.driver_id === d.id && inRange(w.work_date));
    const laborCost = days.reduce((s, w) => s + (w.rate != null && w.rate !== "" ? numv(w.rate) : numv(d.daily_rate)), 0);
    const mine = expenses.filter(e => e.driver_id === d.id && inRange(e.expense_date || (e.created_at || "").slice(0, 10)));
    const expensesByCategory = {};
    let expensesTotal = 0, pendingTotal = 0;
    for (const e of mine) {
      if (e.status === "rejected") continue;
      const amt = numv(e.amount);
      if (e.status === "approved") {
        expensesByCategory[e.category || "other"] = (expensesByCategory[e.category || "other"] || 0) + amt;
        expensesTotal += amt;
      } else pendingTotal += amt;
    }
    const commissions = jobExtras
      .filter(e => e.driver_id === d.id && e.active !== false)
      .reduce((s, e) => s + numv(e.driver_commission_amount), 0);
    const totalCost = laborCost + expensesTotal + commissions;
    const net = rev.revenue - totalCost;
    return {
      driverId: d.id, name: d.name || `Driver #${d.id}`, active: d.active !== false,
      revenue: rev.revenue, jobsCount: rev.jobs,
      workedDays: days.length, laborCost,
      expensesByCategory, expensesTotal, pendingTotal, commissions,
      totalCost, net,
      margin: rev.revenue > 0 ? net / rev.revenue : null,
    };
  }).filter(r => r.revenue || r.totalCost || r.pendingTotal || r.workedDays)
    .sort((a, b) => b.net - a.net);
  const totals = rows.reduce((t, r) => ({
    revenue: t.revenue + r.revenue, laborCost: t.laborCost + r.laborCost,
    expensesTotal: t.expensesTotal + r.expensesTotal, commissions: t.commissions + r.commissions,
    totalCost: t.totalCost + r.totalCost, net: t.net + r.net,
  }), { revenue: 0, laborCost: 0, expensesTotal: 0, commissions: 0, totalCost: 0, net: 0 });
  return { rows, totals };
}

// Cash the driver should still hand in: physical payments they hold (received,
// not banked — the same rule as the Payments "in circulation" view, matched by
// holder NAME) minus approved driver_cash expenses not yet settled (matched by
// driver ID). Computed, never stored — the payments ledger is untouched.
export function driverCashReconciliation({ payments, expenses, driverName, driverId }) {
  const name = (driverName || "").trim();
  const mine = payments.filter(p => [p.cash_with_whom, p.received_by].some(v => (v || "").trim() && (v || "").trim() === name));
  const holding = mine.filter(p => isPhysical(p.method) && p.received && !p.banked);
  const held = holding.reduce((s, p) => s + paymentNet(p), 0);
  const unsettledItems = expenses.filter(e => e.driver_id === driverId && e.paid_from === "driver_cash" && e.status === "approved" && !e.settled);
  const approvedCashExpenses = unsettledItems.reduce((s, e) => s + numv(e.amount), 0);
  return { held, holdingCount: holding.length, approvedCashExpenses, expectedOnHand: held - approvedCashExpenses, unsettledItems };
}

// Materials each driver should still have on hand: issued − returned − consumed
// (± adjustments carrying a driver_id). A positive balance that never comes back
// is the shortage the owner wants to see. Value uses the movement's cost snapshot,
// falling back to the item's current unit_cost.
export function materialShortages({ items, movements }) {
  const itemById = {};
  for (const it of items) itemById[it.id] = it;
  const by = {}; // driverId|itemId -> row
  for (const mv of movements) {
    if (!mv.driver_id || !itemById[mv.item_id]) continue;
    const k = mv.driver_id + "|" + mv.item_id;
    const r = (by[k] = by[k] || { driverId: mv.driver_id, itemId: mv.item_id, issued: 0, returned: 0, consumed: 0, onHand: 0, value: 0 });
    const qty = numv(mv.quantity);
    const cost = mv.unit_cost != null ? numv(mv.unit_cost) : numv(itemById[mv.item_id].unit_cost);
    if (mv.movement_type === "issue") { r.issued += qty; r.onHand += qty; r.value += qty * cost; }
    else if (mv.movement_type === "return") { r.returned += qty; r.onHand -= qty; r.value -= qty * cost; }
    else if (mv.movement_type === "consume") { r.consumed += qty; r.onHand -= qty; r.value -= qty * cost; }
    else if (mv.movement_type === "adjust") { r.onHand += qty; r.value += qty * cost; }
  }
  return Object.values(by)
    .map(r => ({ ...r, itemName: itemById[r.itemId]?.name || `#${r.itemId}`, unit: itemById[r.itemId]?.unit || "unit" }))
    .sort((a, b) => b.value - a.value);
}

// Fuel theft signals from manual data (ELD refines this later):
// price-per-gallon vs the fleet median (flag >1.5× / <0.5×), and $/mile between
// consecutive odometer readings per truck.
export function fuelOutliers({ expenses }) {
  const fuel = expenses.filter(e => e.category === "fuel" && e.status !== "rejected" && numv(e.amount) > 0);
  const withPpg = fuel.filter(e => numv(e.gallons) > 0).map(e => ({ ...e, ppg: numv(e.amount) / numv(e.gallons) }));
  const sorted = withPpg.map(e => e.ppg).sort((a, b) => a - b);
  const medianPpg = sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
  const outliers = medianPpg
    ? withPpg.filter(e => e.ppg > medianPpg * 1.5 || e.ppg < medianPpg * 0.5)
        .map(e => ({ id: e.id, expense_date: e.expense_date, driver_id: e.driver_id, truck_id: e.truck_id, amount: numv(e.amount), gallons: numv(e.gallons), ppg: e.ppg, medianPpg }))
    : [];
  // $/mile between consecutive fills per truck (needs odometer on both fills).
  const byTruck = {};
  for (const e of fuel) { if (e.truck_id && numv(e.odometer) > 0) (byTruck[e.truck_id] = byTruck[e.truck_id] || []).push(e); }
  const costPerMile = [];
  for (const [truckId, list] of Object.entries(byTruck)) {
    list.sort((a, b) => numv(a.odometer) - numv(b.odometer));
    for (let i = 1; i < list.length; i++) {
      const miles = numv(list[i].odometer) - numv(list[i - 1].odometer);
      if (miles <= 0) continue;
      costPerMile.push({ truckId: Number(truckId), from: list[i - 1].expense_date, to: list[i].expense_date, miles, amount: numv(list[i].amount), perMile: numv(list[i].amount) / miles, driver_id: list[i].driver_id });
    }
  }
  costPerMile.sort((a, b) => b.perMile - a.perMile);
  return { medianPpg, outliers, costPerMile, fillsWithGallons: withPpg.length, fills: fuel.length };
}

// First n rows + an "Otros" catch-all summing the tail.
export function topN(rows, n, valueKey, labelKey = "label") {
  if (rows.length <= n) return rows;
  const head = rows.slice(0, n);
  const tailSum = rows.slice(n).reduce((s, r) => s + (Number(r[valueKey]) || 0), 0);
  return [...head, { [labelKey]: `Otros (${rows.length - n})`, [valueKey]: tailSum, isOther: true }];
}
