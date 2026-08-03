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

  // Crew size. A bigger crew costs more per day but finishes in fewer days —
  // the whole trade-off this model exists to weigh.
  //   baselineCrewSize    — the crew cuFtPerHour was measured with (1 driver + 1 helper)
  //   crewScalingExponent — diminishing returns. 1 would mean a third person makes
  //     the job 50% faster; in reality the stairs, the truck and coordination are
  //     the bottleneck, so 0.8 puts a 3-person crew at ~1.38x instead of 1.5x.
  //   teamDrivingBonusHours — extra useful hours per day with two drivers, who can
  //     legally split the driving. Zero until somebody measures it.
  baselineCrewSize: 2,
  crewScalingExponent: 0.8,
  teamDrivingBonusHours: 0,

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
  crewScalingExponent: "uncalibrated",
  teamDrivingBonusHours: "pending",
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

/** driver + helper, the baseline crew. Derived on purpose — never stored loose. */
export const crewDayRate = (s) => num(s.driverDayRate) + num(s.helperDayRate);

// ── Crew size ────────────────────────────────────────────────────────────────
//
// A job carries its own crew: `drivers` and `helpers`, chosen per job. Both
// default to 1, so a job that says nothing behaves exactly like the baseline
// crew and every number matches what it was before crews were configurable.

export const driversOf = (job) => Math.max(1, Math.round(num(job?.drivers, 1)));
export const helpersOf = (job) => Math.max(0, Math.round(num(job?.helpers, 1)));
export const crewSizeOf = (job) => driversOf(job) + helpersOf(job);

/** What this crew costs for one worked day. */
export function crewCostPerDay(job, s) {
  return driversOf(job) * num(s.driverDayRate) + helpersOf(job) * num(s.helperDayRate);
}

/**
 * How much faster this crew handles cargo than the baseline crew.
 * Diminishing returns: doubling the people does not halve the time.
 */
export function crewFactor(job, s) {
  const base = num(s.baselineCrewSize, 2);
  const size = crewSizeOf(job);
  if (base <= 0 || size <= 0) return 1;
  return Math.pow(size / base, num(s.crewScalingExponent, 1));
}

/** Hotel rooms needed. A room is priced per room and sleeps two. */
export const hotelRoomsFor = (job) => Math.ceil(crewSizeOf(job) / 2);

/** Useful hours in a day for this crew — two drivers can split the driving. */
export function usefulHoursFor(job, s) {
  return num(s.usefulHoursPerDay) + (driversOf(job) >= 2 ? num(s.teamDrivingBonusHours) : 0);
}

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

  // A bigger crew moves the same cubic feet in less time, with diminishing returns.
  const cf = crewFactor(job, s);
  const rate = num(s.cuFtPerHour) * cf;
  const perLeg = rate > 0 ? cuFt / rate : 0;
  const handlingHours = perLeg * mo * uplift + perLeg * md * uplift;

  const speed = num(s.avgSpeedMph);
  const drivingHours = speed > 0 ? num(totalMiles) / speed : 0;

  const day = usefulHoursFor(job, s);
  const rawDays = day > 0 ? (handlingHours + drivingHours) / day : 0;
  const truckDays = Math.max(0.5, roundHalf(rawDays));

  return { uplift, crewFactor: cf, crewSize: crewSizeOf(job), handlingHours, drivingHours, rawDays, truckDays };
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

export function computeVariable({ truckDays, hotelNights, totalMiles, cuFt, brokerPrice, job }, s) {
  const crew = num(truckDays) * crewCostPerDay(job, s);
  const fuel = num(totalMiles) * num(s.fuelCostPerMile);
  // A room sleeps two, so a crew of three needs two rooms every night.
  const hotelRooms = hotelRoomsFor(job);
  const hotel = num(hotelNights) * hotelRooms * num(s.hotelPerNight);
  const tolls = num(totalMiles) * num(s.tollPerMile);
  const materials = num(cuFt) * num(s.materialsPerCuFt);
  const damages = num(brokerPrice) * num(s.damagesReservePct);
  const contingency = (crew + fuel + hotel + tolls + materials) * num(s.contingencyPct);
  const variableCost = crew + fuel + hotel + tolls + materials + damages + contingency;
  return { crew, fuel, hotel, hotelRooms, tolls, materials, damages, contingency, variableCost };
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
    { truckDays, hotelNights, totalMiles, cuFt: base.cuFt, brokerPrice: base.brokerPrice, job: base.job },
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

  const variable = computeVariable({ truckDays, hotelNights, totalMiles: dist.totalMiles, cuFt, brokerPrice, job }, s);
  const fixed = computeFixed(truckDays, s);
  const metrics = computeMetrics(
    { brokerPrice, truckDays, variableCost: variable.variableCost, fixedPerWorkedDay: fixed.fixedPerWorkedDay, absorbedFixed: fixed.absorbedFixed },
    s
  );

  const base = { ...dist, cuFt, brokerPrice, truckDays, hotelNights, job };
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
    drivers: driversOf(job),
    helpers: helpersOf(job),
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

// ── Crew comparison ──────────────────────────────────────────────────────────
//
// The point of a bigger crew is that it costs more per day and finishes in
// fewer days. Whether that trade is worth taking is exactly what
// contributionPerTruckDay answers, so the app can just try each crew and say
// which one wins instead of making the operator guess.

export const CREW_OPTIONS = [
  { drivers: 1, helpers: 1 },
  { drivers: 1, helpers: 2 },
  { drivers: 1, helpers: 3 },
  { drivers: 2, helpers: 1 },
  { drivers: 2, helpers: 2 },
];

/**
 * Evaluate the same job under each crew option.
 * A manual truck-days override is deliberately NOT applied here: it describes
 * the crew that is actually on the job, so carrying it across sizes would
 * compare a measured number against estimated ones.
 */
export function compareCrews(job, settings, miles, opts = {}) {
  const options = opts.options || CREW_OPTIONS;
  const curD = driversOf(job);
  const curH = helpersOf(job);

  const rows = options.map((o) => {
    const r = evaluateJob({ ...job, drivers: o.drivers, helpers: o.helpers }, settings, miles);
    return {
      drivers: o.drivers,
      helpers: o.helpers,
      crewSize: o.drivers + o.helpers,
      truckDays: r.truckDays,
      hotelRooms: r.hotelRooms,
      crew: r.crew,
      variableCost: r.variableCost,
      contributionMargin: r.contributionMargin,
      contributionPerTruckDay: r.contributionPerTruckDay,
      operatingMargin: r.operatingMargin,
      verdict: r.verdict,
      isCurrent: o.drivers === curD && o.helpers === curH,
    };
  });

  const best = rows.reduce((b, x) => (b == null || x.contributionPerTruckDay > b.contributionPerTruckDay ? x : b), null);
  return rows.map((r) => ({ ...r, isBest: best != null && r.drivers === best.drivers && r.helpers === best.helpers }));
}

// ── Calibration ──────────────────────────────────────────────────────────────
//
// Every evaluated job is stored with its inputs, its derived values and the
// settings snapshot used. Once executed, the operator records what ACTUALLY
// happened, and these functions back out the true parameters — so the model
// corrects itself as it gets used instead of staying frozen on guesses.

const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/** The crew that actually ran a stored evaluation. Rows predating crew sizing default to 1 + 1. */
const rowCrew = (row) => ({ drivers: num(row.drivers, 1), helpers: num(row.helpers, 1) });

/** Handling hours implied by the real truck-days: total useful hours minus driving. */
function impliedHandlingHours(row) {
  const s = mergeSettings(row.settings_snapshot);
  const miles = num(row.actual_miles, num(row.total_miles));
  const speed = num(s.avgSpeedMph);
  const drivingHours = speed > 0 ? miles / speed : 0;
  const useful = num(row.actual_truck_days) * usefulHoursFor(rowCrew(row), s);
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

  // cuFtPerHour: only clean rows — direct/direct, no long carry, no shuttle AND
  // the baseline crew, so neither the access multipliers nor the crew scaling
  // can contaminate the productivity rate. Everything else is derived from it,
  // so it has to come first and come clean.
  const atBaseline = (r) => {
    const s = mergeSettings(r.settings_snapshot);
    return crewSizeOf(rowCrew(r)) === num(s.baselineCrewSize, 2);
  };
  const clean = done.filter(
    (r) => r.origin_access === "direct" && r.dest_access === "direct" && !r.long_carry && !r.shuttle && num(r.cu_ft) > 0 && atBaseline(r)
  );
  // POOLED, not an average of per-row ratios. Implied handling is a residual of a
  // half-day-quantized day count, so on a long haul it can come out near zero and
  // send that row's ratio towards infinity. One such row would wreck a mean of
  // ratios forever; totalling the cubic feet and the hours first cannot blow up,
  // and it weights each job by how much cargo it actually moved.
  const cleanPairs = clean
    .map((r) => ({ cuFt: num(r.cu_ft), h: impliedHandlingHours(r) }))
    .filter((x) => x.h != null && x.h > 0 && x.cuFt > 0);
  const cleanCuFt = cleanPairs.reduce((a, x) => a + 2 * x.cuFt, 0);
  const cleanHours = cleanPairs.reduce((a, x) => a + x.h, 0);
  const cuFtPerHour = cleanHours > 0 ? cleanCuFt / cleanHours : null;

  // Access multipliers: rows where BOTH legs share one access type give a clean
  // reading. Mixed rows cannot separate the two legs, so they are skipped, and
  // so are long-carry/shuttle rows — dividing by an uncalibrated uplift to
  // recover a multiplier just launders one guess into another. Excluding them
  // also makes `direct` come out at exactly 1.0 by construction, since it then
  // rests on the very rows cuFtPerHour was derived from.
  const rate = cuFtPerHour || null;
  const accessMultiplier = {};
  const accessSamples = {};
  for (const type of ACCESS_TYPES) {
    const sameBoth = done.filter(
      (r) => r.origin_access === type && r.dest_access === type && !r.long_carry && !r.shuttle && num(r.cu_ft) > 0
    );
    const pairs = sameBoth
      .map((r) => {
        const h = impliedHandlingHours(r);
        if (!h || !rate) return null;
        const s = mergeSettings(r.settings_snapshot);
        // handling = cuFt / (rate x crewFactor) x (mo + md), and mo === md === m here
        return { load: h * rate * crewFactor(rowCrew(r), s), cuFt: num(r.cu_ft) };
      })
      .filter((x) => x != null && Number.isFinite(x.load) && x.load > 0 && x.cuFt > 0);
    const totCuFt = pairs.reduce((a, x) => a + x.cuFt, 0);
    if (totCuFt > 0) {
      accessMultiplier[type] = pairs.reduce((a, x) => a + x.load, 0) / totCuFt / 2;
      accessSamples[type] = pairs.length;
    }
  }

  // Crew scaling: how much faster a non-baseline crew really worked. Measured
  // only on otherwise-clean jobs, against the rate derived above.
  //   handling = 2 x cuFt / (rate x crewFactor)  →  crewFactor = 2 x cuFt / (handling x rate)
  //   crewFactor = (size / baseline) ^ exponent  →  exponent = ln(factor) / ln(size / baseline)
  const crewSamples = done
    .filter((r) => r.origin_access === "direct" && r.dest_access === "direct" && !r.long_carry && !r.shuttle && num(r.cu_ft) > 0 && !atBaseline(r))
    .map((r) => {
      const h = impliedHandlingHours(r);
      if (!h || !rate) return null;
      const s = mergeSettings(r.settings_snapshot);
      const ratio = crewSizeOf(rowCrew(r)) / num(s.baselineCrewSize, 2);
      if (!(ratio > 0) || ratio === 1) return null;
      const factor = (2 * num(r.cu_ft)) / (h * rate);
      if (!(factor > 0)) return null;
      return Math.log(factor) / Math.log(ratio);
    })
    .filter((x) => x != null && Number.isFinite(x));

  const crewScalingExponent = avg(crewSamples);

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
    cuFtPerHourSamples: cleanPairs.length,
    crewScalingExponent,
    crewSamples: crewSamples.length,
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
  if (cal.crewScalingExponent != null && Number.isFinite(cal.crewScalingExponent)) {
    patch.crewScalingExponent = cal.crewScalingExponent;
  }
  if (cal.fuelCostPerMile) patch.fuelCostPerMile = cal.fuelCostPerMile;
  if (cal.tollPerMile != null) patch.tollPerMile = cal.tollPerMile;
  if (cal.materialsPerCuFt != null) patch.materialsPerCuFt = cal.materialsPerCuFt;
  if (Object.keys(cal.accessMultiplier || {}).length) {
    patch.accessMultiplier = { ...mergeSettings(current).accessMultiplier, ...cal.accessMultiplier };
  }
  return patch;
}
