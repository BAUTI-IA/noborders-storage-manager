#!/usr/bin/env node
// Fixture tests for the Job Decision Calculator pure math (src/jobCalcData.js).
// Run: node scripts/test-jobcalc-data.mjs
import assert from "node:assert/strict";
import {
  roundHalf, mergeSettings, crewDayRate, DEFAULT_SETTINGS, SETTING_FLAGS,
  assembleMiles, computeTime, hotelNightsFor, computeVariable, computeFixed,
  computeMetrics, verdictFor, evaluateJob, calibrate, calibrationPatch,
  VERDICT, REASON, ACCESS_TYPES, crewCostPerDay, crewFactor, crewSizeOf, hotelRoomsFor, usefulHoursFor, compareCrews, CREW_OPTIONS,
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
  near(r.askPrice, 3473 + 200 * 3.5, 3);
  assert.ok(r.askPrice > 0);
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
