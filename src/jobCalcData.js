// Job Decision Calculator — pure math.
//
// Brokers send jobs with the price already fixed; the only decision is take it
// or leave it. The operator enters four things (ZIPs, volume, price) plus the
// access conditions; everything else — miles, hours, truck-days, hotel nights —
// is DERIVED here. That is the whole point of the module: the operator does not
// know how many days a job will take, and estimating it is the app's job.
//
// No React, no I/O, no constants of its own: every number comes in through
// `settings`. Reason codes (not sentences) come out, so the UI owns the wording
// and the i18n dictionary owns the translation.
//
// Tests: scripts/test-jobcalc-data.mjs (npm run test:jobcalc)

// ── Domain ───────────────────────────────────────────────────────────────────

export const ACCESS_TYPES = ["direct", "elevator", "stairs"];

/** Round to the nearest half — truck-days are only ever whole or half days. */
export const roundHalf = (x) => Math.round(x * 2) / 2;

/** Coerce anything the UI hands us (empty string, null, "12.5") to a number. */
export const num = (v, fallback = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

// ── Settings ─────────────────────────────────────────────────────────────────

// Defaults live here, NOT in the component, so the UI never hardcodes a number.
// A saved settings row is merged on top of these (mergeSettings below).
export const DEFAULT_SETTINGS = {
  // Crew — paid per day WORKED, so wages behave as a variable cost.
  driverDayRate: 250,
  helperDayRate: 225,

  // Operation
  fuelCostPerMile: 0.87,
  avgSpeedMph: 50,
  usefulHoursPerDay: 12,

  // Productivity — the most sensitive parameter in the whole model.
  cuFtPerHour: 275,
  accessMultiplier: { direct: 1.0, elevator: 1.25, stairs: 1.5 },
  longCarryUplift: 0.15,
  shuttleUplift: 0.25,

  // Fixed cost per truck, monthly
  insuranceMonthlyPerTruck: 1050,
  maintenanceReserveMonthlyPerTruck: 1200,
  depreciationMonthlyPerTruck: 0,
  overheadMonthly: 0,
  activeTrucks: 11,

  // Per-unit costs
  hotelPerNight: 90, // per ROOM; driver + helper share it
  tollPerMile: 0,
  materialsPerCuFt: 0,
  damagesReservePct: 0,
  contingencyPct: 0.1,

  // Decision
  workedDaysPerMonth: 15,
  targetMarginPct: 0.25,
  longDistanceThresholdMiles: 300,

  // Base
  baseZip: "",
};

// How much each setting can be trusted. The UI must show this — the operator has
// to see that a green light rests on assumptions, not on measured data.
//   "pending"      — no real value yet, left at zero/empty on purpose
//   "uncalibrated" — a plausible guess, never checked against executed jobs
//   "unvalidated"  — a real-looking number nobody has reconciled against receipts
// Anything absent from this map is considered validated.
export const SETTING_FLAGS = {
  fuelCostPerMile: "unvalidated",
  cuFtPerHour: "uncalibrated",
  accessMultiplier: "uncalibrated",
  longCarryUplift: "uncalibrated",
  shuttleUplift: "uncalibrated",
  depreciationMonthlyPerTruck: "pending",
  overheadMonthly: "pending",
  tollPerMile: "pending",
  materialsPerCuFt: "pending",
  damagesReservePct: "pending",
  baseZip: "pending",
};

/** Settings whose flag makes the number itself unreliable (not merely absent). */
export const isAssumption = (key) => SETTING_FLAGS[key] === "uncalibrated" || SETTING_FLAGS[key] === "unvalidated";

/** Merge a persisted settings row over the defaults, keeping nested access multipliers intact. */
export function mergeSettings(saved) {
  const s = { ...DEFAULT_SETTINGS, ...(saved || {}) };
  s.accessMultiplier = { ...DEFAULT_SETTINGS.accessMultiplier, ...((saved && saved.accessMultiplier) || {}) };
  return s;
}

/** driver + helper. Derived on purpose — never stored loose. */
export const crewDayRate = (s) => num(s.driverDayRate) + num(s.helperDayRate);

// ── 1. Distances ─────────────────────────────────────────────────────────────
//
// Real routed miles come from /api/distance (server-side, cached per ZIP pair).
// This module only assembles them — it never invents a distance.

export function assembleMiles({ loadedMiles, deadheadMiles }) {
  const loaded = num(loadedMiles);
  const deadhead = num(deadheadMiles);
  return { loadedMiles: loaded, deadheadMiles: deadhead, totalMiles: loaded + deadhead };
}

// ── 2. Time ──────────────────────────────────────────────────────────────────

export function computeTime(job, s, totalMiles) {
  const cuFt = num(job.cuFt);
  const uplift = 1 + (job.longCarry ? num(s.longCarryUplift) : 0) + (job.shuttle ? num(s.shuttleUplift) : 0);
  const mo = num(s.accessMultiplier?.[job.originAccess], 1);
  const md = num(s.accessMultiplier?.[job.destAccess], 1);

  const rate = num(s.cuFtPerHour);
  const perLeg = rate > 0 ? cuFt / rate : 0;
  const handlingHours = perLeg * mo * uplift + perLeg * md * uplift;

  const speed = num(s.avgSpeedMph);
  const drivingHours = speed > 0 ? num(totalMiles) / speed : 0;

  const day = num(s.usefulHoursPerDay);
  const rawDays = day > 0 ? (handlingHours + drivingHours) / day : 0;
  const truckDays = Math.max(0.5, roundHalf(rawDays));

  return { uplift, handlingHours, drivingHours, rawDays, truckDays };
}

/**
 * Hotel nights follow whatever truck-days we ended up with — including a manual
 * override — so the two can never drift apart.
 */
export function hotelNightsFor(truckDays, totalMiles, s) {
  if (num(totalMiles) <= num(s.longDistanceThresholdMiles)) return 0;
  return Math.max(0, Math.ceil(num(truckDays)) - 1);
}

// ── 3. Variable costs ────────────────────────────────────────────────────────
//
// Wages sit here, not in fixed costs: the crew is paid only for days actually
// worked. A day is paid in full even when the job only fills half of it.

export function computeVariable({ truckDays, hotelNights, totalMiles, cuFt, brokerPrice }, s) {
  const crew = num(truckDays) * crewDayRate(s);
  const fuel = num(totalMiles) * num(s.fuelCostPerMile);
  const hotel = num(hotelNights) * num(s.hotelPerNight);
  const tolls = num(totalMiles) * num(s.tollPerMile);
  const materials = num(cuFt) * num(s.materialsPerCuFt);
  const damages = num(brokerPrice) * num(s.damagesReservePct);
  const contingency = (crew + fuel + hotel + tolls + materials) * num(s.contingencyPct);
  const variableCost = crew + fuel + hotel + tolls + materials + damages + contingency;
  return { crew, fuel, hotel, tolls, materials, damages, contingency, variableCost };
}

// ── 4. Fixed costs ───────────────────────────────────────────────────────────
//
// Insurance and the maintenance reserve are paid all 30 days, but the truck does
// not work all 30. Dividing by days WORKED is what makes the number honest: at
// 15 worked days, insurance really costs $70 per working day, not $35.

export function computeFixed(truckDays, s) {
  const trucks = num(s.activeTrucks);
  const fixedMonthlyPerTruck =
    num(s.insuranceMonthlyPerTruck) +
    num(s.maintenanceReserveMonthlyPerTruck) +
    num(s.depreciationMonthlyPerTruck) +
    (trucks > 0 ? num(s.overheadMonthly) / trucks : 0);

  const worked = num(s.workedDaysPerMonth);
  const fixedPerWorkedDay = worked > 0 ? fixedMonthlyPerTruck / worked : 0;
  const absorbedFixed = fixedPerWorkedDay * num(truckDays);

  return { fixedMonthlyPerTruck, fixedPerWorkedDay, absorbedFixed };
}

// ── 5. Decision metrics ──────────────────────────────────────────────────────

export function computeMetrics({ brokerPrice, truckDays, variableCost, fixedPerWorkedDay, absorbedFixed }, s) {
  const price = num(brokerPrice);
  const days = num(truckDays);

  const contributionMargin = price - variableCost;
  // The metric that rules. A $2,000 job eating 3 days can be a worse deal than a
  // $900 job done in 1 — the dollar total lies, contribution per truck-day does not.
  const contributionPerTruckDay = days > 0 ? contributionMargin / days : 0;
  const operatingMargin = contributionMargin - absorbedFixed;
  const breakevenPrice = variableCost + absorbedFixed;

  const target = num(s.targetMarginPct);
  const hurdlePerTruckDay = target < 1 ? fixedPerWorkedDay / (1 - target) : Infinity;
  // The negotiation number: what the broker has to pay for the truck to be worth tying up.
  const askPrice = variableCost + hurdlePerTruckDay * days;

  return { contributionMargin, contributionPerTruckDay, operatingMargin, breakevenPrice, hurdlePerTruckDay, askPrice };
}

// ── 6. Stress scenarios ──────────────────────────────────────────────────────

export const STRESS_SCENARIOS = [
  { id: "extraDay", days: 1, nights: 1, milesFactor: 1 },
  { id: "extraMiles", days: 0, nights: 0, milesFactor: 1.2 },
  { id: "both", days: 1, nights: 1, milesFactor: 1.2 },
];

function runScenario(base, s, sc) {
  const truckDays = base.truckDays + sc.days;
  const hotelNights = base.hotelNights + sc.nights;
  const totalMiles = base.totalMiles * sc.milesFactor;

  const v = computeVariable(
    { truckDays, hotelNights, totalMiles, cuFt: base.cuFt, brokerPrice: base.brokerPrice },
    s
  );
  const f = computeFixed(truckDays, s);
  const m = computeMetrics(
    {
      brokerPrice: base.brokerPrice,
      truckDays,
      variableCost: v.variableCost,
      fixedPerWorkedDay: f.fixedPerWorkedDay,
      absorbedFixed: f.absorbedFixed,
    },
    s
  );

  return { id: sc.id, truckDays, hotelNights, totalMiles, ...v, ...f, ...m };
}

// ── 7. Traffic light ─────────────────────────────────────────────────────────

export const VERDICT = { RED: "red", YELLOW: "yellow", GREEN: "green" };

// Reason codes, not sentences: the UI renders the English copy and I18N_ES
// translates it, so this module stays pure and testable.
export const REASON = {
  NEGATIVE_CONTRIBUTION: "negative_contribution",
  BELOW_FIXED: "below_fixed",
  BELOW_HURDLE: "below_hurdle",
  STRESS_NEGATIVE: "stress_negative",
  OK: "ok",
};

export function verdictFor({ contributionMargin, contributionPerTruckDay, fixedPerWorkedDay, hurdlePerTruckDay }, worstStress) {
  if (contributionMargin < 0) return { verdict: VERDICT.RED, reason: REASON.NEGATIVE_CONTRIBUTION };
  if (contributionPerTruckDay < fixedPerWorkedDay) return { verdict: VERDICT.RED, reason: REASON.BELOW_FIXED };
  if (contributionPerTruckDay < hurdlePerTruckDay) return { verdict: VERDICT.YELLOW, reason: REASON.BELOW_HURDLE };
  if (worstStress && worstStress.operatingMargin < 0) return { verdict: VERDICT.YELLOW, reason: REASON.STRESS_NEGATIVE };
  return { verdict: VERDICT.GREEN, reason: REASON.OK };
}

// ── Top-level evaluation ─────────────────────────────────────────────────────

/**
 * Evaluate one job end to end.
 *
 * @param job      { originZip, destZip, cuFt, brokerPrice, originAccess, destAccess, longCarry, shuttle }
 * @param settings merged settings (see mergeSettings)
 * @param miles    { loadedMiles, deadheadMiles } — routed miles from /api/distance
 * @param opts     { truckDaysOverride } — operator's manual correction, recalculates everything
 */
export function evaluateJob(job, settings, miles, opts = {}) {
  const s = mergeSettings(settings);
  const dist = assembleMiles(miles || {});
  const time = computeTime(job, s, dist.totalMiles);

  const overridden = opts.truckDaysOverride != null && opts.truckDaysOverride !== "";
  const truckDays = overridden ? Math.max(0.5, num(opts.truckDaysOverride, time.truckDays)) : time.truckDays;
  const hotelNights = hotelNightsFor(truckDays, dist.totalMiles, s);

  const cuFt = num(job.cuFt);
  const brokerPrice = num(job.brokerPrice);

  const variable = computeVariable({ truckDays, hotelNights, totalMiles: dist.totalMiles, cuFt, brokerPrice }, s);
  const fixed = computeFixed(truckDays, s);
  const metrics = computeMetrics(
    { brokerPrice, truckDays, variableCost: variable.variableCost, fixedPerWorkedDay: fixed.fixedPerWorkedDay, absorbedFixed: fixed.absorbedFixed },
    s
  );

  const base = { ...dist, cuFt, brokerPrice, truckDays, hotelNights };
  const stress = STRESS_SCENARIOS.map((sc) => runScenario(base, s, sc));
  const worstStress = stress.reduce((w, x) => (w == null || x.operatingMargin < w.operatingMargin ? x : w), null);

  const { verdict, reason } = verdictFor(
    {
      contributionMargin: metrics.contributionMargin,
      contributionPerTruckDay: metrics.contributionPerTruckDay,
      fixedPerWorkedDay: fixed.fixedPerWorkedDay,
      hurdlePerTruckDay: metrics.hurdlePerTruckDay,
    },
    worstStress
  );

  return {
    ...dist,
    ...time,
    truckDays,
    truckDaysEstimated: time.truckDays,
    truckDaysOverridden: overridden,
    hotelNights,
    ...variable,
    ...fixed,
    ...metrics,
    stress,
    worstStress,
    verdict,
    reason,
  };
}

// ── Calibration ──────────────────────────────────────────────────────────────
//
// Every evaluated job is stored with its inputs, its derived values and the
// settings snapshot used. Once executed, the operator records what ACTUALLY
// happened, and these functions back out the true parameters — so the model
// corrects itself as it gets used instead of staying frozen on guesses.

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** Handling hours implied by the real truck-days: total useful hours minus driving. */
function impliedHandlingHours(row) {
  const s = mergeSettings(row.settings_snapshot);
  const miles = num(row.actual_miles, num(row.total_miles));
  const speed = num(s.avgSpeedMph);
  const drivingHours = speed > 0 ? miles / speed : 0;
  const useful = num(row.actual_truck_days) * num(s.usefulHoursPerDay);
  const handling = useful - drivingHours;
  return handling > 0 ? handling : null;
}

/** Access + uplift load of a row: (originMult + destMult) x uplift, per the settings used. */
function accessLoad(row) {
  const s = mergeSettings(row.settings_snapshot);
  const uplift = 1 + (row.long_carry ? num(s.longCarryUplift) : 0) + (row.shuttle ? num(s.shuttleUplift) : 0);
  const mo = num(s.accessMultiplier?.[row.origin_access], 1);
  const md = num(s.accessMultiplier?.[row.dest_access], 1);
  return (mo + md) * uplift;
}

/**
 * Derive the real parameters from executed jobs.
 * Every output carries its sample size — a multiplier from two jobs is a rumour,
 * not a measurement, and the UI has to say so.
 */
export function calibrate(rows) {
  const done = (rows || []).filter((r) => !r.deleted_at && num(r.actual_truck_days) > 0);

  // cuFtPerHour: only clean rows (direct/direct, no long carry, no shuttle) so
  // the access multipliers cannot contaminate the productivity rate.
  const clean = done.filter(
    (r) => r.origin_access === "direct" && r.dest_access === "direct" && !r.long_carry && !r.shuttle && num(r.cu_ft) > 0
  );
  const cuFtPerHourSamples = clean
    .map((r) => {
      const h = impliedHandlingHours(r);
      return h ? (2 * num(r.cu_ft)) / h : null;
    })
    .filter((x) => x != null && Number.isFinite(x) && x > 0);

  const cuFtPerHour = avg(cuFtPerHourSamples);

  // Access multipliers: rows where BOTH legs share one access type give a clean
  // reading. Mixed rows cannot separate the two legs, so they are skipped.
  const rate = cuFtPerHour || null;
  const accessMultiplier = {};
  const accessSamples = {};
  for (const type of ACCESS_TYPES) {
    const sameBoth = done.filter((r) => r.origin_access === type && r.dest_access === type && num(r.cu_ft) > 0);
    const vals = sameBoth
      .map((r) => {
        const h = impliedHandlingHours(r);
        if (!h || !rate) return null;
        const s = mergeSettings(r.settings_snapshot);
        const uplift = 1 + (r.long_carry ? num(s.longCarryUplift) : 0) + (r.shuttle ? num(s.shuttleUplift) : 0);
        // handling = (cuFt / rate) x uplift x (mo + md), and mo === md === m here
        const load = (h * rate) / (num(r.cu_ft) * uplift);
        return load / 2;
      })
      .filter((x) => x != null && Number.isFinite(x) && x > 0);
    if (vals.length) {
      accessMultiplier[type] = avg(vals);
      accessSamples[type] = vals.length;
    }
  }

  // Fuel and tolls: straight totals over the miles actually driven.
  const fuelRows = done.filter((r) => num(r.actual_fuel) > 0 && num(r.actual_miles, num(r.total_miles)) > 0);
  const fuelMiles = fuelRows.reduce((a, r) => a + num(r.actual_miles, num(r.total_miles)), 0);
  const fuelCostPerMile = fuelMiles > 0 ? fuelRows.reduce((a, r) => a + num(r.actual_fuel), 0) / fuelMiles : null;

  const tollRows = done.filter((r) => r.actual_tolls != null && num(r.actual_miles, num(r.total_miles)) > 0);
  const tollMiles = tollRows.reduce((a, r) => a + num(r.actual_miles, num(r.total_miles)), 0);
  const tollPerMile = tollMiles > 0 ? tollRows.reduce((a, r) => a + num(r.actual_tolls), 0) / tollMiles : null;

  const materialRows = done.filter((r) => r.actual_materials != null && num(r.cu_ft) > 0);
  const materialCuFt = materialRows.reduce((a, r) => a + num(r.cu_ft), 0);
  const materialsPerCuFt =
    materialCuFt > 0 ? materialRows.reduce((a, r) => a + num(r.actual_materials), 0) / materialCuFt : null;

  // How far off the day estimate runs, in days and in percent.
  const dayDeltas = done.map((r) => num(r.actual_truck_days) - num(r.truck_days));
  const dayDeviation = avg(dayDeltas);
  const dayDeviationPct = avg(
    done.filter((r) => num(r.truck_days) > 0).map((r) => (num(r.actual_truck_days) - num(r.truck_days)) / num(r.truck_days))
  );

  return {
    sampleSize: done.length,
    cuFtPerHour,
    cuFtPerHourSamples: cuFtPerHourSamples.length,
    accessMultiplier,
    accessSamples,
    fuelCostPerMile,
    fuelSamples: fuelRows.length,
    tollPerMile,
    tollSamples: tollRows.length,
    materialsPerCuFt,
    materialSamples: materialRows.length,
    dayDeviation,
    dayDeviationPct,
  };
}

/** Build the settings patch the "apply calibration" button writes, skipping empty readings. */
export function calibrationPatch(cal, current) {
  const patch = {};
  if (cal.cuFtPerHour) patch.cuFtPerHour = cal.cuFtPerHour;
  if (cal.fuelCostPerMile) patch.fuelCostPerMile = cal.fuelCostPerMile;
  if (cal.tollPerMile != null) patch.tollPerMile = cal.tollPerMile;
  if (cal.materialsPerCuFt != null) patch.materialsPerCuFt = cal.materialsPerCuFt;
  if (Object.keys(cal.accessMultiplier || {}).length) {
    patch.accessMultiplier = { ...mergeSettings(current).accessMultiplier, ...cal.accessMultiplier };
  }
  return patch;
}
