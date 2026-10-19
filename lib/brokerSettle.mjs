// Broker settlements — the running balance with each broker we haul for.
//
// A closing sheet (src/appData.js sheetCalc) ends in a net: > 0 the broker owes
// us, < 0 we owe the broker. Until now a sheet counted in full until someone
// flipped it to "settled", with no record of what was paid. broker_payments
// records each payment (either direction) and how it was spread over sheets
// (`allocations: [{ sheet_id, amount }]`, amounts always positive), so a sheet
// can be paid in parts and a broker has one running balance.
//
// Sheets closed by hand before payments existed (status "settled", nothing
// allocated) count as paid: they were settled outside the CRM.
//
// Pure and import-free so plain node (scripts/test-broker-settle.mjs), the app
// (src/brokerSettleData.js) and the agent can all load it.

const num = (v) => (v === "" || v == null || isNaN(Number(v))) ? 0 : Number(v);
const round2 = (v) => Math.round(v * 100) / 100;
const OPEN = 0.005;
const notDel = (r) => r && !r.deleted_at;

/** Σ allocated to each sheet, over live payments: { [sheetId]: amount }. */
export function allocatedBySheet(payments) {
  const m = {};
  for (const p of payments || []) {
    if (!notDel(p)) continue;
    for (const a of Array.isArray(p.allocations) ? p.allocations : []) {
      if (a?.sheet_id == null) continue;
      m[a.sheet_id] = round2((m[a.sheet_id] || 0) + num(a.amount));
    }
  }
  return m;
}

/**
 * What is still open on a sheet, signed like its net (> 0 the broker owes us).
 * A settled sheet with nothing allocated was closed outside the CRM: 0.
 */
export function sheetRemaining(sheet, net, allocated = 0) {
  if (!sheet || sheet.status === "settled" && !(allocated > 0)) return 0;
  const left = Math.max(0, Math.abs(num(net)) - num(allocated));
  if (left < OPEN) return 0;
  return round2(Math.sign(num(net)) * left);
}

/** Payment amount not yet spread over any sheet (credit on account). */
export function unallocated(p) {
  const used = (Array.isArray(p?.allocations) ? p.allocations : []).reduce((s, a) => s + num(a?.amount), 0);
  return round2(Math.max(0, num(p?.amount) - used));
}

/**
 * Running balance per broker.
 *   balance = Σ open remaining on sheets − unallocated paid to us + unallocated paid by us
 * > 0: the broker owes us. < 0: we owe the broker.
 */
export function brokerLedger({ sheets = [], calcById = {}, payments = [] } = {}) {
  const alloc = allocatedBySheet(payments);
  const rows = new Map();
  const row = (id) => {
    if (!rows.has(id)) rows.set(id, { brokerId: id, owesUs: 0, weOwe: 0, credit: 0, paidIn: 0, paidOut: 0, balance: 0, openSheets: 0, oldest: null });
    return rows.get(id);
  };
  for (const s of sheets) {
    if (!notDel(s) || s.broker_id == null) continue;
    const rem = sheetRemaining(s, calcById[s.id]?.net, alloc[s.id] || 0);
    if (!rem) continue;
    const r = row(s.broker_id);
    if (rem > 0) r.owesUs += rem; else r.weOwe -= rem;
    r.openSheets++;
    const day = String(s.load_date || s.created_at || "").slice(0, 10) || null;
    if (day && (!r.oldest || day < r.oldest)) r.oldest = day;
  }
  for (const p of payments) {
    if (!notDel(p) || p.broker_id == null) continue;
    const r = row(p.broker_id);
    if (p.direction === "out") { r.paidOut += num(p.amount); r.credit -= unallocated(p); }
    else { r.paidIn += num(p.amount); r.credit += unallocated(p); }
  }
  for (const r of rows.values()) {
    r.owesUs = round2(r.owesUs); r.weOwe = round2(r.weOwe); r.credit = round2(r.credit);
    r.paidIn = round2(r.paidIn); r.paidOut = round2(r.paidOut);
    r.balance = round2(r.owesUs - r.weOwe - r.credit);
    if (Math.abs(r.balance) < OPEN) r.balance = 0;
  }
  return [...rows.values()];
}

/**
 * Spread a payment over a broker's open sheets, oldest first.
 * direction "in" (the broker pays us) covers sheets that owe us; "out" covers
 * sheets where we owe them. Returns { allocations: [{ sheet_id, amount }], unassigned }.
 */
export function allocatePayment(amount, openSheets, direction = "in") {
  let left = Math.max(0, num(amount));
  const want = (s) => direction === "out" ? s.remaining < 0 : s.remaining > 0;
  const order = (openSheets || []).filter(want).slice().sort((a, b) =>
    String(a.load_date || "").localeCompare(String(b.load_date || "")) || num(a.id) - num(b.id));
  const allocations = [];
  for (const s of order) {
    if (left < OPEN) break;
    const take = round2(Math.min(left, Math.abs(s.remaining)));
    if (take < OPEN) continue;
    allocations.push({ sheet_id: s.id, amount: take });
    left = round2(left - take);
  }
  return { allocations, unassigned: round2(left) };
}

/** Open sheets of one broker with what is left on each, for the payment form. */
export function openSheetsFor(brokerId, { sheets = [], calcById = {}, payments = [] } = {}) {
  const alloc = allocatedBySheet(payments);
  return sheets
    .filter((s) => notDel(s) && s.broker_id === brokerId)
    .map((s) => ({ ...s, net: round2(num(calcById[s.id]?.net)), allocated: alloc[s.id] || 0, remaining: sheetRemaining(s, calcById[s.id]?.net, alloc[s.id] || 0) }))
    .filter((s) => s.remaining !== 0)
    .sort((a, b) => String(a.load_date || "").localeCompare(String(b.load_date || "")) || num(a.id) - num(b.id));
}

/** Sheets a payment just paid off: not settled yet, something allocated, nothing left. */
export function sheetsToSettle({ sheets = [], calcById = {}, payments = [] } = {}) {
  const alloc = allocatedBySheet(payments);
  return sheets.filter((s) => notDel(s) && s.status !== "settled" && (alloc[s.id] || 0) > 0
    && sheetRemaining(s, calcById[s.id]?.net, alloc[s.id]) === 0).map((s) => s.id);
}

/**
 * Statement of account for one broker: sheets and payments by date, with a
 * running balance. Sheets settled outside the CRM are left out.
 */
export function brokerStatement(brokerId, { sheets = [], calcById = {}, payments = [] } = {}) {
  const alloc = allocatedBySheet(payments);
  const lines = [];
  for (const s of sheets) {
    if (!notDel(s) || s.broker_id !== brokerId) continue;
    if (s.status === "settled" && !(alloc[s.id] > 0)) continue;
    const net = round2(num(calcById[s.id]?.net));
    if (!net) continue;
    lines.push({ kind: "sheet", id: s.id, date: String(s.load_date || s.created_at || "").slice(0, 10), label: s.closing_sheet_number || `#${s.id}`, amount: net, status: s.status || "open" });
  }
  for (const p of payments) {
    if (!notDel(p) || p.broker_id !== brokerId) continue;
    lines.push({ kind: "payment", id: p.id, date: String(p.paid_date || p.created_at || "").slice(0, 10), label: [p.method, p.reference].filter(Boolean).join(" · "), amount: round2(p.direction === "out" ? num(p.amount) : -num(p.amount)), direction: p.direction || "in" });
  }
  lines.sort((a, b) => a.date.localeCompare(b.date) || (a.kind === b.kind ? num(a.id) - num(b.id) : a.kind === "sheet" ? -1 : 1));
  let run = 0;
  for (const l of lines) { run = round2(run + l.amount); l.balance = run; }
  return { lines, balance: run };
}
