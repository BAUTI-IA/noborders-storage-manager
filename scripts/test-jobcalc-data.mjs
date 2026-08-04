#!/usr/bin/env node
// Fixture tests for the Job Decision Calculator pure math (src/jobCalcData.js).
// Run: node scripts/test-jobcalc-data.mjs
import assert from "node:assert/strict";
import {
  roundHalf, mergeSettings, crewDayRate, DEFAULT_SETTINGS, SETTING_FLAGS,
  assembleMiles, computeTime, hotelNightsFor, computeVariable, computeFixed,
  computeMetrics, verdictFor, evaluateJob, calibrate, calibrationPatch,
  VERDICT, REASON, ACCESS_TYPES, applyOverrides, overrideDiff, capacityCheck, deadheadFor, compareDeadhead, compareRental, DEADHEAD_MODES, crewCostPerDay, crewFactor, crewSizeOf, hotelRoomsFor, usefulHoursFor, compareCrews, CREW_OPTIONS,
} from "../src/jobCalcData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };
const near = (a, b, tol = 0.5) => assert.ok(Math.abs(a - b) <= tol, `expected ~${b}, got ${a}`);

const S = mergeSettings({});

// ── Helpers ──────────────────────────────────────────────────────────────────

t("roundHalf: rounds to the nearest half", () => {
  assert.equal(roundHalf(3.13), 3);
  assert.equal(roundHalf(3.25), 3.5);
  assert.equal(roundHalf(3.24), 3);
  assert.equal(roundHalf(3.75), 4);
  assert.equal(roundHalf(0.2), 0);
});

t("mergeSettings: saved row overrides defaults, access multipliers merge deeply", () => {
  const s = mergeSettings({ cuFtPerHour: 300, accessMultiplier: { stairs: 1.8 } });
  assert.equal(s.cuFtPerHour, 300);
  assert.equal(s.accessMultiplier.stairs, 1.8);
  assert.equal(s.accessMultiplier.direct, 1.0, "untouched multipliers survive the merge");
  assert.equal(s.driverDayRate, 250);
});

t("crewDayRate: derived from driver + helper, never stored loose", () => {
  assert.equal(crewDayRate(S), 475);
  assert.equal(DEFAULT_SETTINGS.crewDayRate, undefined, "crewDayRate must not exist as a stored setting");
});

t("PENDING settings ship at zero/empty — no invented values", () => {
  for (const k of ["depreciationMonthlyPerTruck", "overheadMonthly", "tollPerMile", "materialsPerCuFt", "damagesReservePct"]) {
    assert.equal(DEFAULT_SETTINGS[k], 0, `${k} must default to 0`);
    assert.equal(SETTING_FLAGS[k], "pending");
  }
  assert.equal(DEFAULT_SETTINGS.baseZip, "");
  assert.equal(SETTING_FLAGS.hotelPerNight, undefined, "hotel is validated: $90 per room, fits driver + helper");
});

// ── Distances ────────────────────────────────────────────────────────────────

t("assembleMiles: total = loaded + deadhead", () => {
  const d = assembleMiles({ loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(d.totalMiles, 1334);
});

// ── Time ─────────────────────────────────────────────────────────────────────

const JOB = {
  originZip: "33125", destZip: "30301", cuFt: 1200, brokerPrice: 4800,
  originAccess: "stairs", destAccess: "direct", longCarry: false, shuttle: false,
};

t("computeTime: handling applies the access multiplier per leg, uplift to both", () => {
  const r = computeTime(JOB, S, 1334);
  near(r.handlingHours, 6.545 + 4.364, 0.01);   // stairs leg + direct leg
  near(r.drivingHours, 26.68, 0.01);
  assert.equal(r.uplift, 1, "no long carry, no shuttle");
});

t("computeTime: uplift stacks long carry + shuttle onto both legs", () => {
  const r = computeTime({ ...JOB, longCarry: true, shuttle: true }, S, 1334);
  assert.equal(r.uplift, 1.4);
  near(r.handlingHours, (6.545 + 4.364) * 1.4, 0.01);
});

t("truckDays: never below 0.5, however tiny the job", () => {
  const tiny = computeTime({ ...JOB, cuFt: 1, originAccess: "direct" }, S, 0);
  assert.equal(tiny.truckDays, 0.5);
  const zero = computeTime({ ...JOB, cuFt: 0, originAccess: "direct" }, S, 0);
  assert.equal(zero.truckDays, 0.5, "a zero job still costs half a day of crew");
});

t("truckDays: rounds to the nearest half day", () => {
  // 12h useful/day → 39h lands on 3.25 → rounds up to 3.5
  const s = mergeSettings({ cuFtPerHour: 1e9 });   // kill handling, drive only
  assert.equal(computeTime(JOB, s, 50 * 39).truckDays, 3.5);
  assert.equal(computeTime(JOB, s, 50 * 38.9).truckDays, 3);
});

t("hotelNights: zero below the long-distance threshold", () => {
  assert.equal(hotelNightsFor(3.5, 250, S), 0);
  assert.equal(hotelNightsFor(3.5, 301, S), 3);
});

t("hotelNights: ceil(truckDays) - 1, floored at zero", () => {
  assert.equal(hotelNightsFor(0.5, 1334, S), 0);
  assert.equal(hotelNightsFor(1, 1334, S), 0);
  assert.equal(hotelNightsFor(3, 1334, S), 2);
  assert.equal(hotelNightsFor(3.5, 1334, S), 3);
});

// ── Costs ────────────────────────────────────────────────────────────────────

t("computeVariable: crew is variable — paid per day worked, full days only", () => {
  const v = computeVariable({ truckDays: 3.5, hotelNights: 3, totalMiles: 1408, cuFt: 1200, brokerPrice: 4800 }, S);
  near(v.crew, 1662.5, 0.01);      // 3.5 x 475
  near(v.fuel, 1224.96, 0.01);     // 1408 x 0.87
  near(v.hotel, 270, 0.01);        // 3 x 90, per room
  assert.equal(v.tolls, 0);
  assert.equal(v.materials, 0);
  assert.equal(v.damages, 0);
});

t("computeVariable: contingency excludes damages, damages ride on broker price", () => {
  const s = mergeSettings({ damagesReservePct: 0.05 });
  const v = computeVariable({ truckDays: 1, hotelNights: 0, totalMiles: 0, cuFt: 0, brokerPrice: 1000 }, s);
  assert.equal(v.damages, 50);
  near(v.contingency, 47.5, 0.01, "10% of crew only — damages are not in the contingency base");
  near(v.variableCost, 475 + 50 + 47.5, 0.01);
});

t("computeFixed: overhead splits across the fleet, then divides by days WORKED", () => {
  const f = computeFixed(3.5, S);
  assert.equal(f.fixedMonthlyPerTruck, 2250);          // 1050 + 1200 + 0 + 0/11
  assert.equal(f.fixedPerWorkedDay, 150);              // 2250 / 15 worked days, not 30
  assert.equal(f.absorbedFixed, 525);
});

t("computeFixed: insurance per WORKED day is double the per-calendar-day figure", () => {
  const f = computeFixed(1, mergeSettings({ maintenanceReserveMonthlyPerTruck: 0 }));
  assert.equal(f.fixedPerWorkedDay, 70, "$1050/15 = $70, not the $35/day the invoice implies");
});

t("computeFixed: overheadMonthly is shared across activeTrucks", () => {
  const f = computeFixed(1, mergeSettings({ overheadMonthly: 11000, activeTrucks: 11 }));
  assert.equal(f.fixedMonthlyPerTruck, 3250);          // 2250 + 1000
});

// ── Metrics ──────────────────────────────────────────────────────────────────

t("computeMetrics: contribution per truck-day, hurdle and ask price", () => {
  const m = computeMetrics(
    { brokerPrice: 4800, truckDays: 3.5, variableCost: 3400, fixedPerWorkedDay: 150, absorbedFixed: 525 }, S);
  assert.equal(m.contributionMargin, 1400);
  assert.equal(m.contributionPerTruckDay, 400);
  assert.equal(m.operatingMargin, 875);
  assert.equal(m.breakevenPrice, 3925);
  assert.equal(m.hurdlePerTruckDay, 200);              // 150 / (1 - 0.25)
  assert.equal(m.askPrice, 4100);                      // 3400 + 200 x 3.5
});

t("computeMetrics: the dollar total lies, contribution per truck-day does not", () => {
  const big = computeMetrics({ brokerPrice: 2000, truckDays: 3, variableCost: 800, fixedPerWorkedDay: 150, absorbedFixed: 450 }, S);
  const small = computeMetrics({ brokerPrice: 900, truckDays: 1, variableCost: 400, fixedPerWorkedDay: 150, absorbedFixed: 150 }, S);
  assert.ok(big.contributionMargin > small.contributionMargin, "$2000 job wins on raw dollars");
  assert.ok(big.contributionPerTruckDay < small.contributionPerTruckDay, "...and loses on the metric that matters");
});

// ── Traffic light: every boundary ────────────────────────────────────────────

const light = (cm, cpd, fixed, hurdle, stressOp) =>
  verdictFor({ contributionMargin: cm, contributionPerTruckDay: cpd, fixedPerWorkedDay: fixed, hurdlePerTruckDay: hurdle },
    stressOp == null ? null : { operatingMargin: stressOp });

t("light RED: contribution margin below zero", () => {
  assert.deepEqual(light(-1, 500, 150, 200, 100), { verdict: VERDICT.RED, reason: REASON.NEGATIVE_CONTRIBUTION });
});

t("light RED: contribution per truck-day under the fixed-cost floor", () => {
  assert.equal(light(100, 149.99, 150, 200, 100).verdict, VERDICT.RED);
  assert.equal(light(100, 149.99, 150, 200, 100).reason, REASON.BELOW_FIXED);
});

t("light boundary: exactly at the fixed floor is NOT red (strict <)", () => {
  assert.notEqual(light(100, 150, 150, 200, 100).verdict, VERDICT.RED);
});

t("light YELLOW: above the floor but under the hurdle", () => {
  assert.deepEqual(light(100, 199.99, 150, 200, 100), { verdict: VERDICT.YELLOW, reason: REASON.BELOW_HURDLE });
});

t("light boundary: exactly at the hurdle is NOT yellow (strict <)", () => {
  assert.equal(light(100, 200, 150, 200, 100).verdict, VERDICT.GREEN);
});

t("light YELLOW: clears the hurdle but the worst stress case goes underwater", () => {
  assert.deepEqual(light(100, 500, 150, 200, -0.01), { verdict: VERDICT.YELLOW, reason: REASON.STRESS_NEGATIVE });
});

t("light boundary: stress operating margin of exactly zero is NOT yellow", () => {
  assert.equal(light(100, 500, 150, 200, 0).verdict, VERDICT.GREEN);
});

t("light GREEN: clears every gate", () => {
  assert.deepEqual(light(1400, 400, 150, 200, 50), { verdict: VERDICT.GREEN, reason: REASON.OK });
});

t("light: red wins over yellow when both would fire", () => {
  assert.equal(light(-1, 10, 150, 200, -500).verdict, VERDICT.RED);
});

// ── End-to-end: the reference case ───────────────────────────────────────────
//
// Miami 33125 → Atlanta 30301, 1200 cu ft, stairs → direct, $4,800, base 33166.
// Routed distance is ~663 loaded + ~671 deadhead = ~1,334 miles.

t("reference case @ 1334 routed miles: 3 truck-days, 2 nights, ~$3,042 variable, GREEN", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(r.totalMiles, 1334);
  near(r.rawDays, 3.13, 0.01);
  assert.equal(r.truckDays, 3, "3.13 rounds DOWN to 3.0 — the case sits just under the 3.25 boundary");
  assert.equal(r.hotelNights, 2);
  near(r.variableCost, 3042, 2);
  assert.equal(r.verdict, VERDICT.GREEN);
});

t("reference case @ 1408 miles: the spec's 3.5 days / 3 nights / ~$3,400 — but YELLOW, not green", () => {
  // The brief expected 3.5 days, 3 nights, ~$3,400 AND a green light. The first
  // three only appear at ~1,408 total miles, and at that point the combined
  // stress scenario (+1 day AND +20% miles) drives operating margin negative,
  // which the brief's own rule says must show yellow. The two expectations
  // cannot both hold. The model follows the rule as written.
  const r = evaluateJob(JOB, {}, { loadedMiles: 700, deadheadMiles: 708 });
  assert.equal(r.truckDays, 3.5);
  assert.equal(r.hotelNights, 3);
  near(r.variableCost, 3473, 3);
  near(r.contributionPerTruckDay, 379, 1);
  assert.ok(r.contributionPerTruckDay > r.hurdlePerTruckDay, "clears the hurdle on its own");
  near(r.worstStress.operatingMargin, -239, 2);
  assert.equal(r.verdict, VERDICT.YELLOW);
  assert.equal(r.reason, REASON.STRESS_NEGATIVE);
});

t("evaluateJob: askPrice is what turns a yellow into a deal worth taking", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 700, deadheadMiles: 708 });
  // The baseline requirement alone would be 3473 + 200 x 3.5 = 4173, which is
  // BELOW the $4,800 on offer — asking for that would be asking for less. The
  // binding requirement here is the worst stress case breaking even: its 4364
  // of variable cost plus 675 of absorbed fixed.
  near(r.baselineAsk, 3473 + 200 * 3.5, 3);
  near(r.askPrice, 5039, 3);
  assert.ok(r.askPrice > r.brokerPrice);
});

t("evaluateJob: truck-days override recalculates hotel nights and every downstream number", () => {
  const base = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const over = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 }, { truckDaysOverride: 5 });
  assert.equal(over.truckDays, 5);
  assert.equal(over.truckDaysEstimated, 3, "the estimate is kept for comparison");
  assert.equal(over.truckDaysOverridden, true);
  assert.equal(over.hotelNights, 4, "nights follow the override");
  assert.ok(over.crew > base.crew);
  assert.ok(over.absorbedFixed > base.absorbedFixed);
  assert.ok(over.contributionPerTruckDay < base.contributionPerTruckDay);
});

t("evaluateJob: override is still floored at half a day", () => {
  assert.equal(evaluateJob(JOB, {}, { loadedMiles: 10, deadheadMiles: 10 }, { truckDaysOverride: 0.1 }).truckDays, 0.5);
});

t("evaluateJob: three stress scenarios, worst one drives the light", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(r.stress.length, 3);
  assert.deepEqual(r.stress.map(s => s.id), ["extraDay", "extraMiles", "both"]);
  assert.equal(r.stress[0].truckDays, 4);
  assert.equal(r.stress[0].hotelNights, 3);
  near(r.stress[1].totalMiles, 1600.8, 0.1);
  assert.equal(r.stress[2].id, r.worstStress.id, "combined scenario is the harshest");
});

t("evaluateJob: a job priced below its own variable cost is red on contribution", () => {
  const r = evaluateJob({ ...JOB, brokerPrice: 500 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.ok(r.contributionMargin < 0);
  assert.equal(r.verdict, VERDICT.RED);
  assert.equal(r.reason, REASON.NEGATIVE_CONTRIBUTION);
});

t("evaluateJob: missing distance does not crash — it just yields a half-day floor", () => {
  const r = evaluateJob(JOB, {}, {});
  assert.equal(r.totalMiles, 0);
  assert.equal(r.hotelNights, 0);
  assert.ok(Number.isFinite(r.variableCost));
});

t("evaluateJob: zero-division settings degrade to zero instead of NaN", () => {
  const s = { cuFtPerHour: 0, avgSpeedMph: 0, usefulHoursPerDay: 0, workedDaysPerMonth: 0, activeTrucks: 0 };
  const r = evaluateJob(JOB, s, { loadedMiles: 663, deadheadMiles: 671 });
  for (const k of ["handlingHours", "drivingHours", "truckDays", "variableCost", "absorbedFixed", "contributionMargin"]) {
    assert.ok(Number.isFinite(r[k]), `${k} became ${r[k]}`);
  }
  assert.equal(r.truckDays, 0.5);
});

// ── Calibration ──────────────────────────────────────────────────────────────

const snap = { ...DEFAULT_SETTINGS };
const row = (o) => ({
  origin_access: "direct", dest_access: "direct", long_carry: false, shuttle: false,
  cu_ft: 1200, truck_days: 3, total_miles: 1000, settings_snapshot: snap, ...o,
});

t("calibrate: backs cuFtPerHour out of clean jobs only", () => {
  // 1000 mi / 50 mph = 20h driving. 3 days x 12h = 36h useful → 16h handling.
  // Two direct legs → rate = 2 x 1200 / 16 = 150 cu ft/h.
  const cal = calibrate([row({ actual_truck_days: 3, actual_miles: 1000 })]);
  near(cal.cuFtPerHour, 150, 0.01);
  assert.equal(cal.cuFtPerHourSamples, 1);
});

t("calibrate: jobs with stairs or uplifts never contaminate the productivity rate", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ origin_access: "stairs", dest_access: "stairs", actual_truck_days: 5, actual_miles: 1000 }),
    row({ long_carry: true, actual_truck_days: 6, actual_miles: 1000 }),
  ]);
  assert.equal(cal.cuFtPerHourSamples, 1, "only the clean direct/direct row counts");
  near(cal.cuFtPerHour, 150, 0.01);
});

t("calibrate: derives the real access multiplier from same-access-both-legs jobs", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),                                                  // rate = 150 cu ft/h
    row({ origin_access: "stairs", dest_access: "stairs", actual_truck_days: 4, actual_miles: 1000 }),  // 48h useful - 20h drive = 28h handling
  ]);
  // load = 28h x 150 / 1200 cu ft = 3.5 → 1.75 per leg. The stairs guess of 1.5
  // was optimistic — which is exactly what calibration is for.
  near(cal.accessMultiplier.stairs, 1.75, 0.01);
  assert.equal(cal.accessSamples.stairs, 1);
  near(cal.accessMultiplier.direct, 1.0, 0.01);
});

t("calibrate: real fuel and toll rates come off the miles actually driven", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000, actual_fuel: 950, actual_tolls: 40 }),
    row({ actual_truck_days: 3, actual_miles: 500, actual_fuel: 500, actual_tolls: 20 }),
  ]);
  near(cal.fuelCostPerMile, 1450 / 1500, 0.001);
  near(cal.tollPerMile, 60 / 1500, 0.001);
  assert.equal(cal.fuelSamples, 2);
});

t("calibrate: reports how far the day estimate runs off, absolute and percent", () => {
  const cal = calibrate([
    row({ truck_days: 3, actual_truck_days: 4, actual_miles: 1000 }),
    row({ truck_days: 4, actual_truck_days: 5, actual_miles: 1000 }),
  ]);
  near(cal.dayDeviation, 1, 0.001);
  near(cal.dayDeviationPct, (1 / 3 + 1 / 4) / 2, 0.001);
});

t("calibrate: rows without actuals and soft-deleted rows are ignored", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ actual_truck_days: null }),
    row({ actual_truck_days: 3, actual_miles: 1000, deleted_at: "2026-01-01" }),
  ]);
  assert.equal(cal.sampleSize, 1);
});

t("calibrate: no data yields nulls, never fabricated numbers", () => {
  const cal = calibrate([]);
  assert.equal(cal.sampleSize, 0);
  assert.equal(cal.cuFtPerHour, null);
  assert.equal(cal.fuelCostPerMile, null);
  assert.deepEqual(cal.accessMultiplier, {});
});

t("calibrationPatch: only writes parameters that actually have a reading", () => {
  const empty = calibrationPatch(calibrate([]), {});
  assert.deepEqual(empty, {}, "nothing measured, nothing written");

  const cal = calibrate([row({ actual_truck_days: 3, actual_miles: 1000, actual_fuel: 950 })]);
  const patch = calibrationPatch(cal, {});
  near(patch.cuFtPerHour, 150, 0.01);
  near(patch.fuelCostPerMile, 0.95, 0.01);
  assert.equal(patch.accessMultiplier.elevator, 1.25, "unmeasured multipliers keep their current value");
});

t("ACCESS_TYPES matches the access multiplier keys", () => {
  assert.deepEqual(ACCESS_TYPES.slice().sort(), Object.keys(DEFAULT_SETTINGS.accessMultiplier).sort());
});

// ── Crew sizing ──────────────────────────────────────────────────────────────

t("crew defaults to 1 driver + 1 helper, so a job that says nothing is unchanged", () => {
  const a = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const b = evaluateJob({ ...JOB, drivers: 1, helpers: 1 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(a.crewSize, 2);
  assert.equal(a.crewFactor, 1, "the baseline crew is the unit — no scaling applied");
  assert.deepEqual([a.truckDays, a.variableCost], [b.truckDays, b.variableCost]);
});

t("crewCostPerDay: each body is paid its own rate", () => {
  assert.equal(crewCostPerDay({ drivers: 1, helpers: 1 }, S), 475);
  assert.equal(crewCostPerDay({ drivers: 1, helpers: 2 }, S), 700);
  assert.equal(crewCostPerDay({ drivers: 2, helpers: 1 }, S), 725);
  assert.equal(crewCostPerDay({ drivers: 1, helpers: 0 }, S), 250);
});

t("a bigger crew handles faster, with diminishing returns — not proportionally", () => {
  const two = computeTime({ ...JOB, drivers: 1, helpers: 1 }, S, 0);
  const three = computeTime({ ...JOB, drivers: 1, helpers: 2 }, S, 0);
  near(three.crewFactor, Math.pow(1.5, 0.8), 0.001);
  assert.ok(three.crewFactor < 1.5, "3 people are NOT 1.5x faster than 2");
  assert.ok(three.crewFactor > 1.2, "...but meaningfully faster");
  near(three.handlingHours, two.handlingHours / three.crewFactor, 0.001);
});

t("hotel rooms: a room sleeps two, so a crew of three needs two of them", () => {
  assert.equal(hotelRoomsFor({ drivers: 1, helpers: 1 }), 1);
  assert.equal(hotelRoomsFor({ drivers: 1, helpers: 2 }), 2);
  assert.equal(hotelRoomsFor({ drivers: 2, helpers: 2 }), 2);
  assert.equal(hotelRoomsFor({ drivers: 2, helpers: 3 }), 3);
});

t("a third crew member doubles the hotel bill", () => {
  const two = evaluateJob({ ...JOB, helpers: 1 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const three = evaluateJob({ ...JOB, helpers: 2 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(three.hotelRooms, 2);
  near(three.hotel, two.hotel * 2 * (three.hotelNights / two.hotelNights), 0.01);
});

t("teamDrivingBonusHours defaults to zero — no invented benefit for a second driver", () => {
  assert.equal(DEFAULT_SETTINGS.teamDrivingBonusHours, 0);
  assert.equal(SETTING_FLAGS.teamDrivingBonusHours, "pending");
  assert.equal(usefulHoursFor({ drivers: 2, helpers: 1 }, S), S.usefulHoursPerDay);
  assert.equal(usefulHoursFor({ drivers: 2, helpers: 1 }, mergeSettings({ teamDrivingBonusHours: 3 })), 15);
  assert.equal(usefulHoursFor({ drivers: 1, helpers: 1 }, mergeSettings({ teamDrivingBonusHours: 3 })), 12,
    "one driver gets no team bonus");
});

t("compareCrews: ranks every option and flags the current one and the best", () => {
  const rows = compareCrews({ ...JOB, drivers: 1, helpers: 1 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(rows.length, CREW_OPTIONS.length);
  assert.equal(rows.filter(r => r.isCurrent).length, 1);
  assert.equal(rows.filter(r => r.isBest).length, 1);
  const best = rows.find(r => r.isBest);
  for (const r of rows) assert.ok(best.contributionPerTruckDay >= r.contributionPerTruckDay);
});

t("compareCrews: the trade is real — more crew costs more per day but can finish sooner", () => {
  const rows = compareCrews(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const two = rows.find(r => r.drivers === 1 && r.helpers === 1);
  const three = rows.find(r => r.drivers === 1 && r.helpers === 2);
  assert.ok(three.crew / three.truckDays > two.crew / two.truckDays, "costs more per day");
  assert.ok(three.truckDays <= two.truckDays, "and never takes longer");
});

t("compareCrews: ignores a truck-days override so it never compares measured against estimated", () => {
  const plain = compareCrews(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const withOverride = compareCrews(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 }, { truckDaysOverride: 9 });
  assert.deepEqual(plain.map(r => r.truckDays), withOverride.map(r => r.truckDays));
});

t("crew size never divides by zero or goes negative", () => {
  for (const j of [{ drivers: 0, helpers: 0 }, { drivers: -3, helpers: -2 }, { drivers: "x", helpers: null }]) {
    const r = evaluateJob({ ...JOB, ...j }, {}, { loadedMiles: 663, deadheadMiles: 671 });
    assert.ok(Number.isFinite(r.variableCost) && r.variableCost > 0, `broke on ${JSON.stringify(j)}`);
    assert.ok(r.crewSize >= 1);
  }
  assert.equal(crewFactor({ drivers: 1, helpers: 1 }, mergeSettings({ baselineCrewSize: 0 })), 1);
});

// ── Calibration robustness (regressions from the adversarial review) ─────────

t("calibrate: cuFtPerHour is pooled, so one near-zero-handling row cannot blow it up", () => {
  // Second row: 20h driving against 20h of useful time leaves ~0 handling hours.
  // A mean of per-row ratios would run away to infinity; pooling cannot.
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ actual_truck_days: 1.67, actual_miles: 1000, cu_ft: 1200 }),
  ]);
  assert.ok(Number.isFinite(cal.cuFtPerHour), "must stay finite");
  assert.ok(cal.cuFtPerHour < 1000, `pooled estimate stayed sane: ${cal.cuFtPerHour}`);
});

t("calibrate: long-carry and shuttle rows never reach the access multipliers", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ long_carry: true, actual_truck_days: 6, actual_miles: 1000 }),
    row({ shuttle: true, actual_truck_days: 7, actual_miles: 1000 }),
  ]);
  near(cal.accessMultiplier.direct, 1.0, 0.001,
    "direct must come out at exactly 1.0 — it rests on the same rows as cuFtPerHour");
  assert.equal(cal.accessSamples.direct, 1);
});

t("calibrate: only baseline-crew rows set the productivity rate", () => {
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ drivers: 1, helpers: 3, actual_truck_days: 2, actual_miles: 1000 }),
  ]);
  assert.equal(cal.cuFtPerHourSamples, 1, "the 4-person crew is excluded from the rate");
  near(cal.cuFtPerHour, 150, 0.01);
});

t("calibrate: derives the real crew speed-up exponent from non-baseline crews", () => {
  // rate = 150 from the clean baseline row. Then a 3-person crew (ratio 1.5)
  // that did 1200 cu ft in 16h handling => factor 2400/(16*150) = 1.0 => exponent 0.
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ drivers: 1, helpers: 2, actual_truck_days: 3, actual_miles: 1000 }),
  ]);
  assert.equal(cal.crewSamples, 1);
  near(cal.crewScalingExponent, 0, 0.001, "a crew that was no faster reads as zero speed-up");
});

t("calibrationPatch: writes the crew exponent only once it has been measured", () => {
  assert.equal(calibrationPatch(calibrate([]), {}).crewScalingExponent, undefined);
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000 }),
    row({ drivers: 1, helpers: 2, actual_truck_days: 2, actual_miles: 1000 }),
  ]);
  assert.ok(Number.isFinite(calibrationPatch(cal, {}).crewScalingExponent));
});

// ── Per-job overrides ────────────────────────────────────────────────────────

t("applyOverrides: an adjustment changes the job and leaves the company row untouched", () => {
  const company = mergeSettings({});
  const eff = applyOverrides(company, { cuFtPerHour: "150" });
  assert.equal(eff.cuFtPerHour, 150);
  assert.equal(company.cuFtPerHour, 275, "the company settings object must not be mutated");
  assert.equal(mergeSettings({}).cuFtPerHour, 275, "and the defaults must not be mutated either");
});

t("applyOverrides: blank, null and undefined fall through to the company value", () => {
  const eff = applyOverrides({}, { cuFtPerHour: "", fuelCostPerMile: null, avgSpeedMph: undefined });
  assert.equal(eff.cuFtPerHour, 275);
  assert.equal(eff.fuelCostPerMile, 0.87);
  assert.equal(eff.avgSpeedMph, 50);
});

t("applyOverrides: garbage keeps the company value instead of becoming zero", () => {
  const eff = applyOverrides({}, { cuFtPerHour: "abc", fuelCostPerMile: "$1.20" });
  assert.equal(eff.cuFtPerHour, 275, "unparseable input must not silently zero a divisor");
  assert.equal(eff.fuelCostPerMile, 0.87);
});

t("applyOverrides: one access multiplier can be adjusted without wiping the other two", () => {
  const eff = applyOverrides({}, { accessMultiplier: { stairs: "1.9" } });
  assert.equal(eff.accessMultiplier.stairs, 1.9);
  assert.equal(eff.accessMultiplier.direct, 1.0);
  assert.equal(eff.accessMultiplier.elevator, 1.25);
});

t("applyOverrides: baseZip stays a string, never a number", () => {
  assert.equal(applyOverrides({}, { baseZip: "07030" }).baseZip, "07030");
});

t("overrides flow through to the verdict, and clearing them restores it exactly", () => {
  const company = {};
  const plain = evaluateJob(JOB, company, { loadedMiles: 663, deadheadMiles: 671 });
  const slow = evaluateJob(JOB, applyOverrides(company, { cuFtPerHour: "80" }), { loadedMiles: 663, deadheadMiles: 671 });
  assert.ok(slow.truckDays > plain.truckDays, "a slower crew rate must cost more days");
  assert.ok(slow.variableCost > plain.variableCost);

  const restored = evaluateJob(JOB, applyOverrides(company, { cuFtPerHour: "" }), { loadedMiles: 663, deadheadMiles: 671 });
  assert.deepEqual(
    [restored.truckDays, restored.variableCost, restored.verdict],
    [plain.truckDays, plain.variableCost, plain.verdict]
  );
});

t("an override can flip the traffic light without touching the standard", () => {
  const company = mergeSettings({});
  const green = evaluateJob(JOB, company, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(green.verdict, VERDICT.GREEN);
  const red = evaluateJob(JOB, applyOverrides(company, { cuFtPerHour: "40" }), { loadedMiles: 663, deadheadMiles: 671 });
  assert.notEqual(red.verdict, VERDICT.GREEN);
  assert.equal(company.cuFtPerHour, 275);
});

t("overrideDiff: lists only what genuinely changed", () => {
  const company = mergeSettings({});
  assert.deepEqual(overrideDiff(company, applyOverrides(company, {})), []);
  assert.deepEqual(overrideDiff(company, applyOverrides(company, { cuFtPerHour: "275" })), [],
    "typing the same value is not an adjustment");

  const d = overrideDiff(company, applyOverrides(company, { cuFtPerHour: "150", fuelCostPerMile: "1.1" }));
  assert.equal(d.length, 2);
  assert.deepEqual(d.find(x => x.key === "cuFtPerHour"), { key: "cuFtPerHour", from: 275, to: 150 });
});

t("overrideDiff: reports an adjusted access multiplier under its own key", () => {
  const company = mergeSettings({});
  const d = overrideDiff(company, applyOverrides(company, { accessMultiplier: { stairs: "1.9" } }));
  assert.deepEqual(d, [{ key: "accessMultiplier.stairs", from: 1.5, to: 1.9 }]);
});

t("the saved snapshot must carry the EFFECTIVE settings, so calibration inverts the right assumptions", () => {
  // A job priced with an adjusted rate, then executed. Calibration reads the
  // snapshot; if it held the company value the algebra would invert a rate that
  // was never used.
  const snapshot = applyOverrides({}, { usefulHoursPerDay: "10" });
  assert.equal(snapshot.usefulHoursPerDay, 10);
  const cal = calibrate([
    row({ actual_truck_days: 3, actual_miles: 1000, settings_snapshot: snapshot }),
  ]);
  // 3 days x 10h = 30h useful, minus 20h driving = 10h handling → 2 x 1200 / 10
  near(cal.cuFtPerHour, 240, 0.01);
});

// ── Regressions found reviewing the crew + overrides work ────────────────────

t("compareCrews: the crew actually chosen is always in the table", () => {
  // 3 drivers is not in CREW_OPTIONS. Ranking alternatives while omitting the
  // operator's own choice compares against nothing.
  const rows = compareCrews({ ...JOB, drivers: 3, helpers: 4 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const cur = rows.filter((r) => r.isCurrent);
  assert.equal(cur.length, 1, "the chosen crew must appear exactly once");
  assert.equal(cur[0].drivers, 3);
  assert.equal(cur[0].helpers, 4);
  assert.equal(rows.length, CREW_OPTIONS.length + 1);
});

t("compareCrews: a crew already in the list is not duplicated", () => {
  const rows = compareCrews({ ...JOB, drivers: 1, helpers: 2 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(rows.length, CREW_OPTIONS.length);
  assert.equal(rows.filter((r) => r.isCurrent).length, 1);
});

t("compareCrews: rows come out ordered by crew size", () => {
  const rows = compareCrews({ ...JOB, drivers: 3, helpers: 0 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const sizes = rows.map((r) => r.crewSize);
  assert.deepEqual(sizes, sizes.slice().sort((a, b) => a - b));
});

// ── Revenue / cost / profit per truck-day ────────────────────────────────────

t("per-truck-day trio: computed on the reference case", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(r.truckDays, 3);
  near(r.revenuePerTruckDay, 4800 / 3, 0.01);
  near(r.costPerTruckDay, (r.variableCost + r.absorbedFixed) / 3, 0.01);
  near(r.profitPerTruckDay, r.operatingMargin / 3, 0.01);
});

t("per-truck-day trio: they reconcile — revenue - cost = profit", () => {
  for (const price of [500, 4800, 9955]) {
    const r = evaluateJob({ ...JOB, brokerPrice: price }, {}, { loadedMiles: 663, deadheadMiles: 671 });
    near(r.revenuePerTruckDay - r.costPerTruckDay, r.profitPerTruckDay, 0.01, `broke at $${price}`);
  }
});

t("per-truck-day trio: profit goes negative exactly when the operating margin does", () => {
  const bad = evaluateJob({ ...JOB, brokerPrice: 500 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.ok(bad.operatingMargin < 0 && bad.profitPerTruckDay < 0);
  const good = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.ok(good.operatingMargin > 0 && good.profitPerTruckDay > 0);
});

t("evaluateJob exposes the broker price so the breakdown shows what it subtracts from", () => {
  assert.equal(evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 }).brokerPrice, 4800);
});

t("truck-day units: one truck by default, so nothing moved", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(r.trucks, 1);
  assert.equal(r.truckDayUnits, r.truckDays);
  near(r.contributionPerTruckDay, r.contributionMargin / r.truckDays, 0.01);
});

t("truck-day units: two trucks for three days is SIX truck-days, not three", () => {
  // Without this the same money spread over twice the iron would look identical.
  const one = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const two = evaluateJob({ ...JOB, trucks: 2 }, {}, { loadedMiles: 663, deadheadMiles: 671 });
  assert.equal(two.truckDayUnits, one.truckDays * 2);
  // Revenue is fixed, so spreading it over twice the truck-days halves it exactly.
  near(two.revenuePerTruckDay, one.revenuePerTruckDay / 2, 0.01);
  // Contribution falls by MORE than half, because the second truck also burns its
  // own fuel and absorbs its own fixed cost. Halving alone would flatter the job.
  assert.ok(two.contributionPerTruckDay < one.contributionPerTruckDay / 2);
});

t("per-truck-day figures never come out NaN or Infinity on degenerate settings", () => {
  const s = { cuFtPerHour: 0, avgSpeedMph: 0, usefulHoursPerDay: 0, workedDaysPerMonth: 0, activeTrucks: 0 };
  const r = evaluateJob(JOB, s, { loadedMiles: 663, deadheadMiles: 671 });
  for (const k of ["revenuePerTruckDay", "costPerTruckDay", "profitPerTruckDay", "truckDayUnits"]) {
    assert.ok(Number.isFinite(r[k]), `${k} became ${r[k]}`);
  }
});

// ── askPrice must never tell you to ask for less ─────────────────────────────

t("askPrice: a job yellow ONLY on stress still asks for MORE than the offer", () => {
  // The regression that started this: the baseline plan clears its hurdle easily,
  // so the baseline ask lands below the offer and the card said "ask for less".
  const r = evaluateJob(JOB, {}, { loadedMiles: 700, deadheadMiles: 708 });
  assert.equal(r.verdict, VERDICT.YELLOW);
  assert.equal(r.reason, REASON.STRESS_NEGATIVE);
  assert.ok(r.contributionPerTruckDay > r.hurdlePerTruckDay, "the baseline plan is fine");
  assert.ok(r.baselineAsk < r.brokerPrice, "...which is exactly why the old ask went under");
  assert.ok(r.askPrice > r.brokerPrice, `ask ${r.askPrice} must exceed the ${r.brokerPrice} offer`);
  assert.equal(r.askDrivenByStress, true);
});

t("askPrice: whenever the light is not green, asking for less is never the answer", () => {
  for (const price of [100, 1000, 3000, 3500, 4000, 4800, 5200]) {
    const r = evaluateJob({ ...JOB, brokerPrice: price }, {}, { loadedMiles: 700, deadheadMiles: 708 });
    if (r.verdict === VERDICT.GREEN) continue;
    assert.ok(r.askPrice >= price, `at $${price} (${r.verdict}/${r.reason}) ask was ${Math.round(r.askPrice)}`);
  }
});

t("askPrice: paying it makes the worst stress case stop losing money", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 700, deadheadMiles: 708 });
  const paid = evaluateJob({ ...JOB, brokerPrice: r.askPrice }, {}, { loadedMiles: 700, deadheadMiles: 708 });
  assert.ok(paid.worstStress.operatingMargin >= -0.01, `worst case still at ${paid.worstStress.operatingMargin}`);
});

t("askPrice: when the baseline margin is the binding requirement, IT sets the ask", () => {
  // A steep target margin makes the baseline requirement (7542) outrun the
  // stress break-even (4519), and the max must then leave the baseline alone.
  const r = evaluateJob(JOB, { targetMarginPct: 0.9 }, { loadedMiles: 663, deadheadMiles: 671 });
  assert.ok(r.baselineAsk > r.worstStress.breakevenPrice);
  near(r.askPrice, r.baselineAsk, 0.01);
  assert.equal(r.askDrivenByStress, false);
});

t("askPrice: is always the higher of the two requirements, never a blend", () => {
  for (const target of [0, 0.25, 0.5, 0.9]) {
    const r = evaluateJob(JOB, { targetMarginPct: target }, { loadedMiles: 663, deadheadMiles: 671 });
    near(r.askPrice, Math.max(r.baselineAsk, r.worstStress.breakevenPrice), 0.01, `target ${target}`);
    assert.ok(r.askPrice >= r.baselineAsk);
    assert.ok(r.askPrice >= r.worstStress.breakevenPrice);
  }
});

t("askPrice: the base-case break-even is untouched by all of this", () => {
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  near(r.breakevenPrice, r.variableCost + r.absorbedFixed, 0.01);
});

t("askPrice: does not feed the traffic light", () => {
  // Same job, same verdict, regardless of how the ask is derived.
  const r = evaluateJob(JOB, {}, { loadedMiles: 663, deadheadMiles: 671 });
  const v = verdictFor({
    contributionMargin: r.contributionMargin,
    contributionPerTruckDay: r.contributionPerTruckDay,
    fixedPerWorkedDay: r.fixedPerWorkedDay,
    hurdlePerTruckDay: r.hurdlePerTruckDay,
  }, r.worstStress);
  assert.equal(v.verdict, r.verdict);
});

t("askPrice: computeMetrics without a stress input keeps the plain baseline ask", () => {
  const m = computeMetrics(
    { brokerPrice: 4800, truckDays: 3.5, variableCost: 3400, fixedPerWorkedDay: 150, absorbedFixed: 525 }, S);
  assert.equal(m.askPrice, 4100);
  assert.equal(m.askDrivenByStress, false);
});

// ── Billable extras ──────────────────────────────────────────────────────────

const MILES = { loadedMiles: 663, deadheadMiles: 671 };
const withExtras = (extras) => evaluateJob({ ...JOB, extras }, {}, MILES);

t("extras: no extras means every number is exactly what it was before", () => {
  const a = evaluateJob(JOB, {}, MILES);
  const b = withExtras([]);
  for (const k of ["truckDays", "handlingHours", "variableCost", "contributionMargin", "verdict"]) {
    assert.deepEqual(a[k], b[k], `${k} moved`);
  }
  assert.equal(b.extrasTotal, 0);
  assert.equal(b.totalRevenue, 4800);
});

t("extras: money-only lines raise revenue and move NO cost at all", () => {
  const base = evaluateJob(JOB, {}, MILES);
  const r = withExtras([{ concept: "Fuel surcharge", amount: 400 }, { concept: "Packing", amount: 250 }]);
  assert.equal(r.extrasTotal, 650);
  assert.equal(r.totalRevenue, 5450);
  // Not one cost line may move.
  for (const k of ["crew", "fuel", "hotel", "tolls", "materials", "contingency", "variableCost", "truckDays", "handlingHours"]) {
    near(r[k], base[k], 0.001, `${k} should not have moved`);
  }
  near(r.contributionMargin, base.contributionMargin + 650, 0.01);
});

t("extras: a line WITH cu ft is real cargo — it costs time, not just money", () => {
  const base = evaluateJob(JOB, {}, MILES);
  const r = withExtras([{ concept: "Extra CF", amount: 900, cuFt: 600 }]);
  assert.equal(r.effectiveCuFt, 1800);
  assert.equal(r.quotedCuFt, 1200);
  assert.ok(r.handlingHours > base.handlingHours, "more volume, more handling");
  assert.ok(r.truckDays >= base.truckDays);
  assert.equal(r.totalRevenue, 5700);
});

t("extras: cu ft on an extra can push the job into another truck-day", () => {
  const base = evaluateJob(JOB, {}, MILES);
  const r = withExtras([{ concept: "Extra CF", amount: 3000, cuFt: 4000 }]);
  assert.ok(r.truckDays > base.truckDays, `${r.truckDays} vs ${base.truckDays}`);
  assert.ok(r.crew > base.crew, "extra days cost extra crew");
});

t("extras: blank cu ft is money only, zero cu ft is money only, both are safe", () => {
  const a = withExtras([{ amount: 500 }]);
  const b = withExtras([{ amount: 500, cuFt: "" }]);
  const c = withExtras([{ amount: 500, cuFt: 0 }]);
  for (const r of [a, b, c]) {
    assert.equal(r.effectiveCuFt, 1200);
    assert.equal(r.totalRevenue, 5300);
  }
});

t("extras: the traffic light runs on total revenue, not the broker price alone", () => {
  const poor = evaluateJob({ ...JOB, brokerPrice: 3200 }, {}, MILES);
  assert.notEqual(poor.verdict, VERDICT.GREEN);
  const saved = evaluateJob({ ...JOB, brokerPrice: 3200, extras: [{ amount: 2500 }] }, {}, MILES);
  assert.equal(saved.verdict, VERDICT.GREEN, "extras can rescue an underpriced job");
});

t("extras: the damages reserve rides on everything invoiced, not just the broker's share", () => {
  const r = evaluateJob({ ...JOB, extras: [{ amount: 1000 }] }, { damagesReservePct: 0.05 }, MILES);
  near(r.damages, 5800 * 0.05, 0.01);
});

t("extras: the per-truck-day trio still reconciles with extras loaded", () => {
  const r = withExtras([{ amount: 700 }, { amount: 300, cuFt: 200 }]);
  near(r.revenuePerTruckDay - r.costPerTruckDay, r.profitPerTruckDay, 0.01);
  near(r.revenuePerTruckDay, r.totalRevenue / r.truckDays, 0.01);
});

t("extras: garbage in the fields never fabricates money or breaks the math", () => {
  const r = withExtras([
    { amount: "abc", cuFt: "xyz" }, { amount: null, cuFt: null },
    { amount: "", cuFt: "" }, { amount: undefined }, {},
  ]);
  assert.equal(r.extrasTotal, 0);
  assert.equal(r.effectiveCuFt, 1200);
  assert.ok(Number.isFinite(r.variableCost) && Number.isFinite(r.contributionMargin));
});

t("extras: a negative line is a discount, and negative cu ft never shrinks the load", () => {
  const r = withExtras([{ amount: -500, cuFt: -900 }]);
  assert.equal(r.extrasTotal, -500);
  assert.equal(r.totalRevenue, 4300);
  assert.equal(r.effectiveCuFt, 1200, "you cannot unload cargo by typing a negative");
});

t("extras: numbers typed as strings work, since the UI keeps raw text", () => {
  const r = withExtras([{ amount: "450.50", cuFt: "300" }]);
  near(r.extrasTotal, 450.5, 0.001);
  assert.equal(r.effectiveCuFt, 1500);
});

t("extraCuFtRate ships pending at zero — no invented billing rate", () => {
  assert.equal(DEFAULT_SETTINGS.extraCuFtRate, 0);
  assert.equal(SETTING_FLAGS.extraCuFtRate, "pending");
});

// ── Base ZIP and crew rates promoted to the main card ────────────────────────

t("promoted fields: overriding them from the card equals overriding from the panel", () => {
  // Same mechanism, so the card must not need its own path through the math.
  const viaOverrides = applyOverrides(mergeSettings({}), { driverDayRate: "300", helperDayRate: "260", baseZip: "54962" });
  assert.equal(viaOverrides.driverDayRate, 300);
  assert.equal(viaOverrides.helperDayRate, 260);
  assert.equal(viaOverrides.baseZip, "54962");
  const r = evaluateJob({ ...JOB, drivers: 2, helpers: 2 }, viaOverrides, MILES);
  near(r.crew, r.truckDays * (2 * 300 + 2 * 260), 0.01);
});

// ── Two-truck jobs ───────────────────────────────────────────────────────────

// Crew held FIXED, so only the truck count differs — that isolates what a second
// truck actually costs from what the driver it needs costs.
const T1 = { ...JOB, drivers: 2, helpers: 1, trucks: 1 };
const T2 = { ...JOB, drivers: 2, helpers: 1, trucks: 2 };

t("two trucks: fuel and tolls double — each truck drives the whole route", () => {
  const a = evaluateJob(T1, { tollPerMile: 0.3 }, MILES);
  const b = evaluateJob(T2, { tollPerMile: 0.3 }, MILES);
  near(b.fuel, a.fuel * 2, 0.01);
  near(b.tolls, a.tolls * 2, 0.01);
  assert.ok(a.tolls > 0, "the toll assertion has to be testing something");
});

t("two trucks: each absorbs its own fixed cost", () => {
  const a = evaluateJob(T1, {}, MILES);
  const b = evaluateJob(T2, {}, MILES);
  near(b.absorbedFixed, a.absorbedFixed * 2, 0.01);
  near(b.absorbedFixed, b.fixedPerWorkedDay * b.truckDays * 2, 0.01);
});

t("two trucks: handling does NOT double — the load is split, not repeated", () => {
  const a = evaluateJob(T1, {}, MILES);
  const b = evaluateJob(T2, {}, MILES);
  near(b.handlingHours, a.handlingHours, 0.001);
  near(b.drivingHours, a.drivingHours, 0.001, "they drive together, not twice");
  near(b.hotel, a.hotel, 0.001, "rooms come from crew size, not truck count");
  near(b.crew, a.crew, 0.001);
});

t("two trucks: a second truck forces a second driver", () => {
  const r = evaluateJob({ ...JOB, trucks: 2, drivers: 1 }, {}, MILES);
  assert.equal(r.drivers, 2, "somebody has to drive it");
  assert.equal(evaluateJob({ ...JOB, trucks: 3, drivers: 1 }, {}, MILES).drivers, 3);
  assert.equal(evaluateJob({ ...JOB, trucks: 1, drivers: 3 }, {}, MILES).drivers, 3, "the floor never caps");
});

t("two trucks: the per-truck-day trio still reconciles", () => {
  const r = evaluateJob(T2, {}, MILES);
  near(r.revenuePerTruckDay - r.costPerTruckDay, r.profitPerTruckDay, 0.01);
  assert.equal(r.truckDayUnits, r.truckDays * 2);
});

t("one truck: every number is identical to before multi-truck existed", () => {
  const explicit = evaluateJob({ ...JOB, trucks: 1 }, {}, MILES);
  const implicit = evaluateJob(JOB, {}, MILES);
  for (const k of ["fuel", "tolls", "crew", "hotel", "absorbedFixed", "variableCost", "contributionPerTruckDay", "verdict"]) {
    assert.deepEqual(explicit[k], implicit[k], `${k} moved`);
  }
});

t("capacity: silent until somebody says what a truck holds", () => {
  const off = capacityCheck({ ...JOB, cuFt: 99999 }, mergeSettings({}));
  assert.equal(off.checked, false);
  assert.equal(off.overCapacity, false, "never warn on a capacity nobody supplied");
});

t("capacity: once set, it says how many trucks the load really needs", () => {
  const s = mergeSettings({ truckCapacityCuFt: 1600 });
  const fits = capacityCheck({ ...JOB, cuFt: 1200, trucks: 1 }, s);
  assert.equal(fits.overCapacity, false);
  assert.equal(fits.trucksNeeded, 1);

  // The real job that prompted this: 3,456 cu ft never fitted on one truck.
  const over = capacityCheck({ ...JOB, cuFt: 3456, trucks: 1 }, s);
  assert.equal(over.checked, true);
  assert.equal(over.overCapacity, true);
  assert.equal(over.trucksNeeded, 3);
  assert.equal(capacityCheck({ ...JOB, cuFt: 3456, trucks: 3 }, s).overCapacity, false);
});

t("capacity: counts the cu ft that extras actually add", () => {
  const s = mergeSettings({ truckCapacityCuFt: 1600 });
  const r = capacityCheck({ ...JOB, cuFt: 1500, trucks: 1, extras: [{ amount: 500, cuFt: 400 }] }, s);
  assert.equal(r.overCapacity, true, "1500 + 400 does not fit in 1600");
});

// ── Calibration believes what actually happened ──────────────────────────────

t("calibration: the crew that ACTUALLY went out beats the one that was planned", () => {
  // Planned 1+1, really went 1+3. Attributing a 4-person crew's output to a
  // 2-person crew would inflate cuFtPerHour for every future job.
  const planned = calibrate([row({ actual_truck_days: 3, actual_miles: 1000 })]);
  const real = calibrate([row({ actual_truck_days: 3, actual_miles: 1000, actual_drivers: 1, actual_helpers: 3 })]);
  assert.ok(real.cuFtPerHourSamples === 0 || real.cuFtPerHour !== planned.cuFtPerHour,
    "a different real crew must not calibrate to the same rate");
});

t("calibration: rows with no actual crew still fall back to the planned one", () => {
  const a = calibrate([row({ actual_truck_days: 3, actual_miles: 1000 })]);
  const b = calibrate([row({ actual_truck_days: 3, actual_miles: 1000, drivers: 1, helpers: 1 })]);
  near(a.cuFtPerHour, b.cuFtPerHour, 0.01);
  near(a.cuFtPerHour, 150, 0.01, "and it is still the old, correct number");
});

// ── Deadhead assumptions ─────────────────────────────────────────────────────

const LEGS = { loadedMiles: 1405, deadheadOutMiles: 450, deadheadBackMiles: 1230 };

t("deadheadFor: each assumption counts exactly the legs it claims to", () => {
  assert.equal(deadheadFor("roundTrip", LEGS), 1680);
  assert.equal(deadheadFor("oneWay", LEGS), 450, "drives out, does not come home empty");
  assert.equal(deadheadFor("none", LEGS), 0, "truck is already there");
  assert.equal(deadheadFor("roundTrip", {}), 0, "no route, no invented miles");
  assert.equal(deadheadFor("roundTrip", { deadheadOutMiles: -50, deadheadBackMiles: -50 }), 0);
});

t("compareDeadhead: the spread between assumptions is the real answer", () => {
  const job = { originZip: "54962", destZip: "87114", cuFt: 3456, brokerPrice: 9955,
    originAccess: "direct", destAccess: "direct", longCarry: false, shuttle: false,
    drivers: 2, helpers: 2, trucks: 2 };
  const s = { fuelCostPerMile: 0.8, tollPerMile: 0.3, driverDayRate: 250, helperDayRate: 250, cuFtPerHour: 575.6 };
  const rows = compareDeadhead(job, s, LEGS);
  assert.equal(rows.length, 3);
  const [round, oneWay, none] = rows;
  assert.deepEqual(rows.map(r => r.mode), ["roundTrip", "oneWay", "none"]);
  // More empty miles can only cost more.
  assert.ok(round.variableCost > oneWay.variableCost);
  assert.ok(oneWay.variableCost > none.variableCost);
  assert.ok(round.operatingMargin < none.operatingMargin);
  // The real job: fine if the truck is already there, a loss if it drives out for it.
  assert.ok(none.operatingMargin > 0, "already-there case is positive");
  assert.ok(round.operatingMargin < 0, "dedicated round trip loses money");
});

t("compareDeadhead: with no base ZIP every assumption collapses to the same thing", () => {
  const rows = compareDeadhead(JOB, {}, { loadedMiles: 1405 });
  for (const r of rows) assert.equal(r.deadheadMiles, 0);
  assert.equal(new Set(rows.map(r => Math.round(r.variableCost))).size, 1);
});

// ── Rented truck ─────────────────────────────────────────────────────────────

t("rented: your own truck absorbs nothing, because it is not tied up", () => {
  const own = evaluateJob(JOB, {}, MILES);
  const rent = evaluateJob({ ...JOB, rented: true }, {}, MILES);
  assert.ok(own.absorbedFixed > 0);
  assert.equal(rent.absorbedFixed, 0);
});

t("rented: a rental charge takes the place of the fixed cost", () => {
  const s = { rentalDayRate: 120, rentalPerMile: 0.99 };
  const r = evaluateJob({ ...JOB, rented: true }, s, MILES);
  near(r.rental, r.truckDays * 120 + r.totalMiles * 0.99, 0.01);
  assert.ok(r.variableCost > evaluateJob({ ...JOB, rented: true }, {}, MILES).variableCost);
});

t("rented: the rental rides inside the contingency base, like every other cost", () => {
  const s = { rentalDayRate: 100, rentalPerMile: 0 };
  const r = evaluateJob({ ...JOB, rented: true }, s, MILES);
  near(r.contingency, (r.crew + r.fuel + r.hotel + r.tolls + r.materials + r.rental) * 0.1, 0.01);
});

t("rented: two rented trucks cost two rentals", () => {
  const s = { rentalDayRate: 120, rentalPerMile: 0.99 };
  const one = evaluateJob({ ...JOB, rented: true, trucks: 1, drivers: 2, helpers: 2 }, s, MILES);
  const two = evaluateJob({ ...JOB, rented: true, trucks: 2, drivers: 2, helpers: 2 }, s, MILES);
  near(two.rental, one.rental * 2, 0.01);
});

t("rented: ships pending at zero — no invented U-Haul pricing", () => {
  assert.equal(DEFAULT_SETTINGS.rentalDayRate, 0);
  assert.equal(DEFAULT_SETTINGS.rentalPerMile, 0);
  assert.equal(SETTING_FLAGS.rentalDayRate, "pending");
  assert.equal(evaluateJob({ ...JOB, rented: true }, {}, MILES).rental, 0);
});

t("compareRental: own versus rented, side by side on the same job", () => {
  const s = { rentalDayRate: 120, rentalPerMile: 0.99 };
  const [own, rent] = compareRental(JOB, s, MILES);
  assert.equal(own.rented, false);
  assert.equal(rent.rented, true);
  assert.ok(own.absorbedFixed > 0 && rent.absorbedFixed === 0);
  assert.ok(rent.rental > 0 && own.rental === 0);
  for (const r of [own, rent]) assert.ok(Number.isFinite(r.contributionPerTruckDay));
});

t("not renting leaves every number exactly where it was", () => {
  const a = evaluateJob(JOB, { rentalDayRate: 999, rentalPerMile: 9 }, MILES);
  const b = evaluateJob(JOB, {}, MILES);
  assert.equal(a.rental, 0);
  near(a.variableCost, b.variableCost, 0.001);
  assert.equal(a.verdict, b.verdict);
});

// ── Subcontracting a leg to a third party ────────────────────────────────────

t("subcontract: what you pay a third party is a real cost of the job", () => {
  const a = evaluateJob(JOB, {}, MILES);
  const b = evaluateJob({ ...JOB, subcontractCost: 2000 }, {}, MILES);
  assert.equal(b.subcontract, 2000);
  near(b.variableCost, a.variableCost + 2000, 0.01);
  near(b.operatingMargin, a.operatingMargin - 2000, 0.01);
});

t("subcontract: contingency does not pad it — it is an agreed price, not an estimate", () => {
  const a = evaluateJob(JOB, {}, MILES);
  const b = evaluateJob({ ...JOB, subcontractCost: 2000 }, {}, MILES);
  near(b.contingency, a.contingency, 0.001);
});

t("subcontract: the leftover is a BUDGET, and the app says how big it is", () => {
  const r = evaluateJob(JOB, {}, MILES);
  // With nothing paid out yet, the room to pay equals the whole operating margin.
  near(r.maxSubcontract, r.operatingMargin, 0.01);
  // Paying exactly that lands on break-even.
  const spent = evaluateJob({ ...JOB, subcontractCost: r.maxSubcontract }, {}, MILES);
  near(spent.operatingMargin, 0, 0.01);
  // And the budget itself does not move: it is a property of the job, not of what was paid.
  near(spent.maxSubcontract, r.maxSubcontract, 0.01);
});

t("subcontract: the target-margin budget leaves the margin behind", () => {
  const r = evaluateJob(JOB, {}, MILES);
  near(r.maxSubcontractAtTarget, r.maxSubcontract - 0.25 * r.totalRevenue, 0.01);
  const spent = evaluateJob({ ...JOB, subcontractCost: r.maxSubcontractAtTarget }, {}, MILES);
  near(spent.operatingMargin, 0.25 * r.totalRevenue, 0.01);
});

t("subcontract: the real pattern — long haul subcontracted beats running it yourself", () => {
  const job = { originZip: "54962", destZip: "47805", cuFt: 3456, brokerPrice: 9955,
    originAccess: "direct", destAccess: "direct", longCarry: false, shuttle: false,
    drivers: 2, helpers: 2, trucks: 2 };
  const s = { fuelCostPerMile: 0.8, tollPerMile: 0.3, driverDayRate: 250, helperDayRate: 250, cuFtPerHour: 575.6 };
  const own = evaluateJob({ ...job, destZip: "87114" }, s, { loadedMiles: 1405, deadheadMiles: 1680 });
  const local = evaluateJob(job, s, { loadedMiles: 450, deadheadMiles: 450 });
  assert.ok(own.operatingMargin < 0, "running it all yourself loses money");
  assert.ok(local.maxSubcontract > 4000, "and there is real room to pay a carrier");
  // Paying a carrier less than the budget keeps the job positive.
  const done = evaluateJob({ ...job, subcontractCost: 3000 }, s, { loadedMiles: 450, deadheadMiles: 450 });
  assert.ok(done.operatingMargin > 0);
  assert.ok(done.operatingMargin > own.operatingMargin);
});

t("subcontract: garbage and negatives never create money", () => {
  for (const v of ["", null, "abc", -5000]) {
    const r = evaluateJob({ ...JOB, subcontractCost: v }, {}, MILES);
    assert.equal(r.subcontract, 0, `broke on ${JSON.stringify(v)}`);
  }
});
