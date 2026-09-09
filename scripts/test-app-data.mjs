// Fixture tests for the main-app pure math (src/appData.js) and the paging
// helper (src/db.js). Run: npm run test:app
import assert from "node:assert/strict";
import {
  today, fmtDateLocal, addDaysStr, daysSince,
  commissionDefaults, extraCfCalc,
  collectionStatus, jobPadsMissing, sheetCalc,
  paymentNet, effectiveBanked, bankedDateOf,
  docStatus, docDaysToExpiry,
} from "../src/appData.js";
import { selectAll, PAGE_SIZE } from "../src/db.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };
const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const TODAY = "2026-09-09";

// ── Dates ────────────────────────────────────────────────────────────────────

t("today: YYYY-MM-DD", () => {
  assert.match(today(), /^\d{4}-\d{2}-\d{2}$/);
});

t("fmtDateLocal: zero-padded local date, null passthrough", () => {
  assert.equal(fmtDateLocal(new Date(2026, 0, 5)), "2026-01-05");
  assert.equal(fmtDateLocal(null), null);
});

t("addDaysStr: crosses month and year, negative steps", () => {
  assert.equal(addDaysStr("2026-01-31", 1), "2026-02-01");
  assert.equal(addDaysStr("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysStr("2026-03-01", -1), "2026-02-28");
  assert.equal(addDaysStr("2028-02-28", 1), "2028-02-29"); // leap year
});

t("daysSince: whole days from local midnight, 0 when empty", () => {
  const noon = new Date("2026-09-09T12:00:00").getTime();
  assert.equal(daysSince("2026-09-01", noon), 8);
  assert.equal(daysSince("2026-09-09", noon), 0);
  assert.equal(daysSince("", noon), 0);
  assert.equal(daysSince(null, noon), 0);
});

// ── Extras: commissions ──────────────────────────────────────────────────────

t("commissionDefaults: long carry / stairs are always driver 50%", () => {
  assert.deepEqual(commissionDefaults("long_carry", "rep_only"), { driver:50, rep:0 });
  assert.deepEqual(commissionDefaults("stairs", undefined), { driver:50, rep:0 });
});

t("commissionDefaults: shuttle splits", () => {
  assert.deepEqual(commissionDefaults("shuttle", "driver_only"), { driver:10, rep:0 });
  assert.deepEqual(commissionDefaults("shuttle", "driver_and_rep"), { driver:7, rep:3 });
  assert.deepEqual(commissionDefaults("shuttle", "rep_only"), { driver:0, rep:5 });
  assert.deepEqual(commissionDefaults("shuttle", undefined), { driver:0, rep:0 });
});

t("commissionDefaults: everything else (extra cf, packing, other)", () => {
  assert.deepEqual(commissionDefaults("extra_cf", "driver_only"), { driver:10, rep:0 });
  assert.deepEqual(commissionDefaults("packing", "driver_and_rep"), { driver:7, rep:3 });
  assert.deepEqual(commissionDefaults("extra_cf", "rep_only"), { driver:0, rep:10 });
  assert.deepEqual(commissionDefaults("other", undefined), { driver:0, rep:0 });
});

t("extraCfCalc: subtotal, fuel surcharge, total and commission base", () => {
  const r = extraCfCalc({ extra_cf_count:"100", extra_cf_rate:"4", fuel_surcharge_pct:"10" });
  assert.equal(r.cfSub, 400);
  assert.equal(r.fuelAmt, 40);
  assert.equal(r.total, 440);
  assert.equal(r.commissionBase, "with_fuel");
  assert.equal(r.base, 440);
  const noFuel = extraCfCalc({ extra_cf_count:"100", extra_cf_rate:"4", fuel_surcharge_pct:"10", commission_base:"without_fuel" });
  assert.equal(noFuel.base, 400);
  assert.equal(noFuel.total, 440);
});

t("extraCfCalc: empty strings are zeros", () => {
  const r = extraCfCalc({ extra_cf_count:"", extra_cf_rate:"", fuel_surcharge_pct:"" });
  assert.deepEqual(r, { cfCount:0, cfRate:0, cfSub:0, fuelPct:0, fuelAmt:0, total:0, commissionBase:"with_fuel", base:0 });
});

// ── BOL collection ───────────────────────────────────────────────────────────

t("collectionStatus: complete / partial / pending", () => {
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"500" }).key, "complete");
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"600" }).key, "complete");
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"100" }).key, "partial");
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"0" }).key, "pending");
  assert.equal(collectionStatus({ bol_balance:"0", bol_collected:"50" }).key, "partial");
  assert.equal(collectionStatus({}).key, "pending");
});

t("collectionStatus: labels are English source strings (i18n swaps them)", () => {
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"500" }).l, "Collected");
  assert.equal(collectionStatus({ bol_balance:"500", bol_collected:"100" }).l, "Partial");
  assert.equal(collectionStatus({}).l, "Pending");
});

t("jobPadsMissing: received minus returned, floored at 0", () => {
  assert.equal(jobPadsMissing({ pads_received:"20", pads_returned:"15" }), 5);
  assert.equal(jobPadsMissing({ pads_received:"10", pads_returned:"12" }), 0);
  assert.equal(jobPadsMissing({}), 0);
});

// ── Closing sheet settlement ─────────────────────────────────────────────────

const SHEET_JOBS = [
  { volume:"1,000 cf", carrier_rate_per_cf:"1.5", bol_balance:"200", bol_collected:"100", pads_received:"10", pads_returned:"8" },
  { volume:"500",      carrier_rate_per_cf:"2",   bol_balance:"0",   bol_collected:"0",   pads_received:"5",  pads_returned:"7" },
];

t("sheetCalc: carrier fee, pads, deductions and net", () => {
  const r = sheetCalc({ charge_per_pad:null, trip_cost:"100", labor_charges:"", other_fees:"50" }, SHEET_JOBS);
  assert.equal(r.totalCf, 1500);
  assert.equal(r.carrierFee, 2500);        // 1000×1.5 + 500×2
  assert.equal(r.bolBalance, 200);
  assert.equal(r.bolCollected, 100);
  assert.equal(r.padsSent, 15);
  assert.equal(r.padsReturned, 15);
  assert.equal(r.padsMissing, 2);          // job 2 returned more than it got: floored, not netted
  assert.equal(r.padsCharge, 14);          // default $7/pad when the sheet has no rate
  assert.equal(r.deductions, 164);         // 100 + 0 + 50 + 14
  assert.equal(r.netCarrier, 2336);
  assert.equal(r.pending, 100);
  assert.equal(r.net, 2236);               // netCarrier − bolCollected
  assert.equal(r.jobCount, 2);
});

t("sheetCalc: explicit charge_per_pad wins, including 0", () => {
  assert.equal(sheetCalc({ charge_per_pad:"10" }, SHEET_JOBS).padsCharge, 20);
  assert.equal(sheetCalc({ charge_per_pad:"0" }, SHEET_JOBS).padsCharge, 0);
  assert.equal(sheetCalc(null, SHEET_JOBS).padsCharge, 14);
});

t("sheetCalc: empty sheet", () => {
  const r = sheetCalc({}, []);
  assert.equal(r.carrierFee, 0);
  assert.equal(r.net, 0);
  assert.equal(r.pending, 0);
  assert.equal(r.jobCount, 0);
});

// ── Payments ─────────────────────────────────────────────────────────────────

t("paymentNet: amount minus discount", () => {
  assert.equal(paymentNet({ amount:"100", discount:"5" }), 95);
  assert.equal(paymentNet({ amount:"100", discount:"" }), 100);
});

t("effectiveBanked: digital always banked, physical only when marked", () => {
  assert.equal(effectiveBanked({ method:"zelle", banked:null }), true);
  assert.equal(effectiveBanked({ method:"cash", banked:null }), false);
  assert.equal(effectiveBanked({ method:"cash", banked:true }), true);
  assert.equal(effectiveBanked({ method:"check", banked:false }), false);
});

t("bankedDateOf: banked_date, else received/payment date for digital, else empty", () => {
  assert.equal(bankedDateOf({ method:"cash", banked_date:"2026-09-01" }), "2026-09-01");
  assert.equal(bankedDateOf({ method:"zelle", received_date:"2026-09-02", payment_date:"2026-09-01" }), "2026-09-02");
  assert.equal(bankedDateOf({ method:"zelle", payment_date:"2026-09-03" }), "2026-09-03");
  assert.equal(bankedDateOf({ method:"cash", received_date:"2026-09-02" }), "");
});

// ── Compliance documents ─────────────────────────────────────────────────────

t("docStatus: expired / expiring_soon (≤30d) / active / none", () => {
  assert.equal(docStatus({ expiry_date:"2026-09-08" }, TODAY), "expired");
  assert.equal(docStatus({ expiry_date:"2026-09-09" }, TODAY), "expiring_soon");
  assert.equal(docStatus({ expiry_date:"2026-10-09" }, TODAY), "expiring_soon"); // day 30 inclusive
  assert.equal(docStatus({ expiry_date:"2026-10-10" }, TODAY), "active");
  assert.equal(docStatus({ expiry_date:"" }, TODAY), "none");
  assert.equal(docStatus(null, TODAY), "none");
});

t("docDaysToExpiry: signed day count, null without a date", () => {
  assert.equal(docDaysToExpiry({ expiry_date:"2026-09-19" }, TODAY), 10);
  assert.equal(docDaysToExpiry({ expiry_date:"2026-09-01" }, TODAY), -8);
  assert.equal(docDaysToExpiry({}, TODAY), null);
  assert.equal(docDaysToExpiry(null, TODAY), null);
});

// ── selectAll (src/db.js) ────────────────────────────────────────────────────
// A fake query builder: order() records the tiebreak, range() slices the table
// the way PostgREST would, capped at max-rows.

function fakeTable(rows, { cap = PAGE_SIZE, failAt = -1 } = {}) {
  const calls = [];
  const build = () => {
    const orders = [];
    const q = {
      order(col) { orders.push(col); return q; },
      range(from, to) {
        calls.push({ from, to, orders: orders.slice() });
        if (calls.length - 1 === failAt) return Promise.resolve({ data: null, error: { message: "boom" } });
        return Promise.resolve({ data: rows.slice(from, Math.min(to + 1, from + cap)), error: null });
      },
    };
    return q;
  };
  return { build, calls };
}
const rowsOf = (n) => Array.from({ length: n }, (_, i) => ({ id: i + 1 }));

await ta("selectAll: one request for a table under the cap", async () => {
  const tbl = fakeTable(rowsOf(10));
  const { data, error } = await selectAll(tbl.build);
  assert.equal(error, null);
  assert.equal(data.length, 10);
  assert.equal(tbl.calls.length, 1);
  assert.deepEqual([tbl.calls[0].from, tbl.calls[0].to], [0, 999]);
});

await ta("selectAll: pages past the cap and returns every row", async () => {
  const tbl = fakeTable(rowsOf(2500));
  const { data } = await selectAll(tbl.build);
  assert.equal(data.length, 2500);
  assert.equal(data[2499].id, 2500);
  assert.deepEqual(tbl.calls.map(c => [c.from, c.to]), [[0, 999], [1000, 1999], [2000, 2999]]);
});

await ta("selectAll: exactly one full page needs one extra (empty) request", async () => {
  const tbl = fakeTable(rowsOf(1000));
  const { data } = await selectAll(tbl.build);
  assert.equal(data.length, 1000);
  assert.equal(tbl.calls.length, 2);
});

await ta("selectAll: appends the id tiebreak unless told not to", async () => {
  const a = fakeTable(rowsOf(1));
  await selectAll(() => a.build().order("name"));
  assert.deepEqual(a.calls[0].orders, ["name", "id"]);
  const b = fakeTable(rowsOf(1));
  await selectAll(() => b.build().order("name"), { tiebreak: null });
  assert.deepEqual(b.calls[0].orders, ["name"]);
});

await ta("selectAll: an error on any page surfaces as { data: null, error }", async () => {
  const tbl = fakeTable(rowsOf(2500), { failAt: 1 });
  const { data, error } = await selectAll(tbl.build);
  assert.equal(data, null);
  assert.equal(error.message, "boom");
});

console.log(process.exitCode ? "\nSome tests FAILED." : "\nAll app-data tests passed.");
