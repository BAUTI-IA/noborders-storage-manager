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

  // Renting a truck near the pickup instead of sending your own. Both pending at
  // zero — U-Haul pricing varies by market and nobody has supplied it.
  rentalDayRate: 0,
  rentalPerMile: 0,

  // Warehousing the goods costs space. Zero until somebody measures it — the
  // revenue side would otherwise be counted while the cost side stays invisible.
  storageCostPerCuFtPerMonth: 0,

  // How much a single truck holds. Zero means no check at all — inventing a
  // capacity would tell the operator a job does not fit on no evidence.
  truckCapacityCuFt: 0,

  // What extra cubic feet are billed at. Typing cu ft on the Extra CF line
  // prices itself from this. Zero until the owner says what he charges.
  extraCuFtRate: 0,

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
  extraCuFtRate: "pending",
  truckCapacityCuFt: "pending",
  storageCostPerCuFtPerMonth: "pending",
  rentalDayRate: "pending",
  rentalPerMile: "pending",
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

// ── Per-job overrides ────────────────────────────────────────────────────────
//
// A job with something unusual about it — a crew that works differently, an
// access worse than the usual "stairs", fuel that costs more on that route —
// can have any parameter overridden for that job alone. The company settings
// are never touched, so a one-off never quietly becomes the standard.

/** A value the operator actually supplied. Blank fields are absent, not zero. */
const isSet = (v) => v != null && v !== "" && !(typeof v === "number" && Number.isNaN(v));

/**
 * Lay per-job overrides on top of the company settings.
 * Only keys the operator filled in win; everything else falls through to base.
 */
export function applyOverrides(base, overrides) {
  const b = mergeSettings(base);
  if (!overrides) return b;

  const out = { ...b };
  for (const [k, v] of Object.entries(overrides)) {
    if (k === "accessMultiplier" || !isSet(v)) continue;
    // baseZip is the one non-numeric setting; everything else is a number.
    out[k] = k === "baseZip" ? String(v) : num(v, b[k]);
  }

  // Overriding one access multiplier must not wipe the other two.
  const am = overrides.accessMultiplier;
  if (am) {
    out.accessMultiplier = { ...b.accessMultiplier };
    for (const [k, v] of Object.entries(am)) {
      if (isSet(v)) out.accessMultiplier[k] = num(v, b.accessMultiplier[k]);
    }
  }
  return out;
}

/**
 * What actually differs between the company settings and the effective ones.
 * The UI shows this so a verdict can never rest on adjustments nobody can see.
 */
export function overrideDiff(base, effective) {
  const b = mergeSettings(base);
  const e = mergeSettings(effective);
  const out = [];
  for (const k of Object.keys(DEFAULT_SETTINGS)) {
    if (k === "accessMultiplier") continue;
    if (String(b[k]) !== String(e[k])) out.push({ key: k, from: b[k], to: e[k] });
  }
  for (const k of ACCESS_TYPES) {
    if (String(b.accessMultiplier[k]) !== String(e.accessMultiplier[k])) {
      out.push({ key: "accessMultiplier." + k, from: b.accessMultiplier[k], to: e.accessMultiplier[k] });
    }
  }
  return out;
}

// ── Crew size ────────────────────────────────────────────────────────────────
//
// A job carries its own crew: `drivers` and `helpers`, chosen per job. Both
// default to 1, so a job that says nothing behaves exactly like the baseline
// crew and every number matches what it was before crews were configurable.

// ── Billable extras ──────────────────────────────────────────────────────────
//
// Services charged on top of the broker price: extra cubic feet, fuel surcharge,
// shuttle, packing, or anything else. Each line carries a dollar `amount` and an
// OPTIONAL `cuFt`.
//
// That optional cu ft is the whole design. Extra volume is sometimes real cargo
// to load and unload, and sometimes just a billing adjustment. Fill it in and the
// job gets heavier — more handling hours, possibly another half truck-day, more
// materials. Leave it blank and the line is pure revenue. One field, both cases,
// no toggle to get wrong.

/** Extras as a clean array, whatever the UI handed us. */
const extrasOf = (job) => (Array.isArray(job?.extras) ? job.extras : []);

/** Total billed on top of the broker price. Negative lines are allowed — a discount is an extra too. */
export const extrasTotal = (job) => extrasOf(job).reduce((a, e) => a + num(e?.amount), 0);

/** Cubic feet the extras physically add to the job. Only lines that filled it in. */
export const extrasCuFt = (job) => extrasOf(job).reduce((a, e) => a + Math.max(0, num(e?.cuFt)), 0);

/** The volume actually being moved: what was quoted plus any extra that is real cargo. */
export const effectiveCuFt = (job) => num(job?.cuFt) + extrasCuFt(job);

// ── Storage billing ──────────────────────────────────────────────────────────
//
// A job parked in the warehouse is billed to the client monthly, the same way the
// CRM's storage billing works: a flat rate per job, with an optional free first
// month. On a job that sits for months this is real money the decision was
// ignoring — and the space it occupies is a real cost, so both sides are counted.

/** Months billed, honouring a free first month. */
export function storageBillableMonths(job) {
  const months = Math.max(0, num(job?.storageMonths));
  return job?.storageFirstMonthFree ? Math.max(0, months - 1) : months;
}

/** What the client pays for the months in storage. */
export const storageRevenue = (job) => storageBillableMonths(job) * Math.max(0, num(job?.storageMonthlyRate));

/** What holding that volume costs you. Zero until the rate is supplied. */
export const storageCost = (job, s) =>
  Math.max(0, num(job?.storageMonths)) * effectiveCuFt(job) * num(s?.storageCostPerCuFtPerMonth);

/** Everything this job brings in. The traffic light runs on this, not on the broker price alone. */
export const totalRevenue = (job) => num(job?.brokerPrice) + extrasTotal(job) + storageRevenue(job);

/**
 * Does the load fit on the trucks assigned? Silent until truckCapacityCuFt is
 * set — telling an operator his job does not fit, on a capacity nobody supplied,
 * would be inventing the most consequential number on the screen.
 */
export function capacityCheck(job, s) {
  const cap = num(s?.truckCapacityCuFt);
  if (cap <= 0) return { checked: false, overCapacity: false, trucksNeeded: trucksOf(job) };
  const needed = Math.max(1, Math.ceil(effectiveCuFt(job) / cap));
  return { checked: true, overCapacity: needed > trucksOf(job), trucksNeeded: needed };
}

/**
 * Trucks assigned to the job. Not an input yet — the per-truck-day denominator
 * is built around it so that adding multi-truck jobs later needs no rework here.
 * At 1 truck every figure is exactly what it was before.
 */
export const trucksOf = (job) => Math.max(1, Math.round(num(job?.trucks, 1)));

// Every truck needs someone behind the wheel, so the driver count can never sit
// below the truck count however the form was filled in.
export const driversOf = (job) => Math.max(trucksOf(job), Math.round(num(job?.drivers, 1)));
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

// ── Deadhead assumptions ─────────────────────────────────────────────────────
//
// A job a week out does not have ONE cost. What the empty miles cost depends on
// logistics nobody has planned yet: does the truck drive out for this alone, is
// it already nearby, does it come home empty or find a backhaul? On a long lane
// that spread is thousands of dollars, so the app names the assumption instead of
// quietly picking the flattering one.

export const DEADHEAD_MODES = ["roundTrip", "oneWay", "none"];

/** Empty miles implied by an assumption, given the two legs the router returned. */
export function deadheadFor(mode, legs) {
  const out = Math.max(0, num(legs?.deadheadOutMiles));
  const back = Math.max(0, num(legs?.deadheadBackMiles));
  if (mode === "none") return 0;             // truck is already there and stays out
  if (mode === "oneWay") return out;         // drives out for it, does not come home empty
  return out + back;                          // dedicated round trip — the conservative read
}

/** Is this job being run on a rented truck rather than one of yours? */
export const isRented = (job) => job?.rented === true;

// ── 2. Time ──────────────────────────────────────────────────────────────────

export function computeTime(job, s, totalMiles) {
  // Extras that carry real cargo make the job heavier, not just richer.
  const cuFt = effectiveCuFt(job);
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

export function computeVariable({ truckDays, hotelNights, totalMiles, fleetMiles, cuFt, brokerPrice, job }, s) {
  const crew = num(truckDays) * crewCostPerDay(job, s);
  // Fuel and tolls are bought by the FLEET: trucks starting from different places
  // drive different distances, so summing their routes is not the same as
  // multiplying one route by the truck count. When they do start together the two
  // are identical. Handling is NOT per truck — a second truck splits the load, it
  // does not carry it twice — and hotel rooms come from people, not trucks.
  const trucks = trucksOf(job);
  const fleet = num(fleetMiles, num(totalMiles) * trucks);
  const fuel = fleet * num(s.fuelCostPerMile);
  // A room sleeps two, so a crew of three needs two rooms every night.
  const hotelRooms = hotelRoomsFor(job);
  const hotel = num(hotelNights) * hotelRooms * num(s.hotelPerNight);
  const tolls = fleet * num(s.tollPerMile);
  // A rented truck costs a daily rate plus mileage instead of your own truck's
  // insurance and maintenance. The crew is paid either way.
  const rental = isRented(job)
    ? trucks * num(truckDays) * num(s.rentalDayRate) + fleet * num(s.rentalPerMile)
    : 0;
  // Paid to a third party for a leg you are not running. Common pattern: your
  // crew does the local pickup into the warehouse and a carrier takes the
  // linehaul. It is a real cost of the job even though no truck of yours moves.
  const subcontract = Math.max(0, num(job?.subcontractCost));
  const storage = storageCost(job, s);
  const materials = num(cuFt) * num(s.materialsPerCuFt);
  // Reserve rides on everything invoiced, not just the broker's share.
  const damages = num(brokerPrice) * num(s.damagesReservePct);
  // Contingency does not pad the subcontract: it is an agreed price, not an
  // estimate that can run over. Same reasoning as the damages reserve.
  const contingency = (crew + fuel + hotel + tolls + materials + rental + storage) * num(s.contingencyPct);
  const variableCost = crew + fuel + hotel + tolls + materials + rental + storage + subcontract + damages + contingency;
  return { crew, fuel, hotel, hotelRooms, tolls, materials, rental, storage, subcontract, damages, contingency, variableCost, fleetMiles: fleet };
}

// ── 4. Fixed costs ───────────────────────────────────────────────────────────
//
// Insurance and the maintenance reserve are paid all 30 days, but the truck does
// not work all 30. Dividing by days WORKED is what makes the number honest: at
// 15 worked days, insurance really costs $70 per working day, not $35.

export function computeFixed(truckDays, s, trucksOnJob = 1, rented = false) {
  const fleet = num(s.activeTrucks);
  const fixedMonthlyPerTruck =
    num(s.insuranceMonthlyPerTruck) +
    num(s.maintenanceReserveMonthlyPerTruck) +
    num(s.depreciationMonthlyPerTruck) +
    (fleet > 0 ? num(s.overheadMonthly) / fleet : 0);

  const worked = num(s.workedDaysPerMonth);
  const fixedPerWorkedDay = worked > 0 ? fixedMonthlyPerTruck / worked : 0;
  // Each truck on the job carries its own insurance and maintenance for every
  // day it is tied up — two trucks for three days absorb six days of fixed cost.
  // A rented truck absorbs none of YOUR fixed cost — your own truck stays free to
  // earn elsewhere. That is the whole point of comparing the two.
  const absorbedFixed = rented ? 0 : fixedPerWorkedDay * num(truckDays) * Math.max(1, num(trucksOnJob, 1));

  return { fixedMonthlyPerTruck, fixedPerWorkedDay, absorbedFixed };
}

// ── 5. Decision metrics ──────────────────────────────────────────────────────

export function computeMetrics({ brokerPrice, truckDays, trucks, variableCost, fixedPerWorkedDay, absorbedFixed, worstStressBreakeven, subcontract }, s) {
  const price = num(brokerPrice);
  const days = num(truckDays);

  // The unit every "per truck-day" figure is measured in. Two trucks for three
  // days is SIX truck-days, not three — otherwise a two-truck job would look
  // twice as good as it is, which is the exact error this metric exists to
  // prevent. Defaults to 1 truck, so today's numbers are unchanged.
  const truckDayUnits = Math.max(1, num(trucks, 1)) * days;

  const contributionMargin = price - variableCost;
  // The metric that rules. A $2,000 job eating 3 days can be a worse deal than a
  // $900 job done in 1 — the dollar total lies, contribution per truck-day does not.
  const contributionPerTruckDay = truckDayUnits > 0 ? contributionMargin / truckDayUnits : 0;
  const operatingMargin = contributionMargin - absorbedFixed;
  const breakevenPrice = variableCost + absorbedFixed;

  // What the job brings in, what it really costs, and what is left — all in the
  // same unit, so they reconcile on screen: revenue - cost = profit.
  const revenuePerTruckDay = truckDayUnits > 0 ? price / truckDayUnits : 0;
  const costPerTruckDay = truckDayUnits > 0 ? (variableCost + absorbedFixed) / truckDayUnits : 0;
  const profitPerTruckDay = truckDayUnits > 0 ? operatingMargin / truckDayUnits : 0;

  const target = num(s.targetMarginPct);
  const hurdlePerTruckDay = target < 1 ? fixedPerWorkedDay / (1 - target) : Infinity;

  // The negotiation number: what the broker has to pay for the truck to be worth
  // tying up. It has to answer whatever is ACTUALLY wrong with the job, which is
  // two different things:
  //   · the plan as costed has to clear the target margin, and
  //   · the worst stress case has to at least not lose money.
  // Pricing only the first is how this card ended up telling operators to ask for
  // LESS than the broker already offered: on a job that is yellow purely because
  // the stress case goes under, the baseline plan clears its hurdle easily, so the
  // baseline ask lands below the offer. Taking the max fixes the advice.
  const baselineAsk = variableCost + hurdlePerTruckDay * truckDayUnits;
  const stressAsk = num(worstStressBreakeven, 0);
  const askPrice = Math.max(baselineAsk, stressAsk);
  // True when the stress case, not the baseline margin, is what sets the ask —
  // the operator needs to know the extra buys downside cover, not extra profit.
  const askDrivenByStress = stressAsk > baselineAsk;

  // The most a third party could be paid for the rest of the job. Without this,
  // the margin left over reads like profit when it is really a budget.
  const paid = Math.max(0, num(subcontract));
  const maxSubcontract = operatingMargin + paid;
  const maxSubcontractAtTarget = maxSubcontract - num(s.targetMarginPct) * price;

  return {
    contributionMargin, contributionPerTruckDay, operatingMargin, breakevenPrice,
    hurdlePerTruckDay, askPrice, baselineAsk, askDrivenByStress,
    maxSubcontract, maxSubcontractAtTarget,
    truckDayUnits, revenuePerTruckDay, costPerTruckDay, profitPerTruckDay,
  };
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
    { truckDays, hotelNights, totalMiles,
      fleetMiles: base.fleetMiles * (base.totalMiles > 0 ? totalMiles / base.totalMiles : 1),
      cuFt: base.cuFt, brokerPrice: base.brokerPrice, job: base.job },
    s
  );
  const f = computeFixed(truckDays, s, trucksOf(base.job), isRented(base.job));
  const m = computeMetrics(
    {
      brokerPrice: base.brokerPrice,
      truckDays,
      trucks: trucksOf(base.job),
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

  // What is really being moved, and everything really being charged. Extras that
  // carry cargo raise the first; every extra raises the second.
  const brokerPrice = num(job.brokerPrice);
  const cuFt = effectiveCuFt(job);
  const revenue = totalRevenue(job);

  // Miles the whole fleet buys fuel for. Defaults to one route times the truck
  // count, which is exactly right when they all leave from the same yard.
  const fleetMiles = num(miles?.fleetMiles, dist.totalMiles * trucksOf(job));

  const variable = computeVariable(
    { truckDays, hotelNights, totalMiles: dist.totalMiles, fleetMiles, cuFt, brokerPrice: revenue, job },
    s
  );
  const fixed = computeFixed(truckDays, s, trucksOf(job), isRented(job));

  // Stress first: the ask price has to know the worst case before it can name a
  // number. The scenarios call computeMetrics themselves without a stress input,
  // which is what stops this from recursing — a scenario has no sub-scenarios.
  const base = { ...dist, fleetMiles, cuFt, brokerPrice: revenue, truckDays, hotelNights, job };
  const stress = STRESS_SCENARIOS.map((sc) => runScenario(base, s, sc));
  const worstStress = stress.reduce((w, x) => (w == null || x.operatingMargin < w.operatingMargin ? x : w), null);

  const metrics = computeMetrics(
    {
      brokerPrice: revenue, truckDays, trucks: trucksOf(job),
      variableCost: variable.variableCost,
      fixedPerWorkedDay: fixed.fixedPerWorkedDay,
      absorbedFixed: fixed.absorbedFixed,
      worstStressBreakeven: worstStress ? worstStress.breakevenPrice : 0,
      subcontract: variable.subcontract,
    },
    s
  );

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
    brokerPrice,
    extrasTotal: extrasTotal(job),
    storageRevenue: storageRevenue(job),
    storageMonthsBilled: storageBillableMonths(job),
    extrasCuFt: extrasCuFt(job),
    totalRevenue: revenue,
    effectiveCuFt: cuFt,
    quotedCuFt: num(job.cuFt),
    trucks: trucksOf(job),
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

// ── The cost of a job you have not planned the logistics for yet ─────────────
//
// A broker sends a job a week out. The honest answer to "what will this cost me"
// is not one number: it is a range, and which end you land on is a logistics
// decision still to be made. Showing only the optimistic end is how an operator
// takes a job that loses money; showing only the pessimistic end is how he turns
// down a good one. So show all three and name each assumption.

const scenarioSummary = (r) => ({
  totalMiles: r.totalMiles,
  truckDays: r.truckDays,
  variableCost: r.variableCost,
  absorbedFixed: r.absorbedFixed,
  operatingMargin: r.operatingMargin,
  contributionPerTruckDay: r.contributionPerTruckDay,
  profitPerTruckDay: r.profitPerTruckDay,
  verdict: r.verdict,
});

/**
 * The same job under each deadhead assumption.
 * @param legs { loadedMiles, deadheadOutMiles, deadheadBackMiles } from /api/distance
 */
export function compareDeadhead(job, settings, legs, opts = {}) {
  const loadedMiles = num(legs?.loadedMiles);
  return DEADHEAD_MODES.map((mode) => {
    const deadheadMiles = deadheadFor(mode, legs);
    const r = evaluateJob(job, settings, { loadedMiles, deadheadMiles }, opts);
    return { mode, deadheadMiles, ...scenarioSummary(r) };
  });
}

/**
 * Send your own truck, or rent one near the pickup?
 * Renting frees your truck to earn elsewhere, which is why its absorbed fixed
 * cost drops to zero and a rental charge takes its place.
 */
export function compareRental(job, settings, miles, opts = {}) {
  return [false, true].map((rented) => {
    const r = evaluateJob({ ...job, rented }, settings, miles, opts);
    return { rented, rental: r.rental, ...scenarioSummary(r) };
  });
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
  const curD = driversOf(job);
  const curH = helpersOf(job);

  // The crew actually chosen is always in the table. Ranking the alternatives
  // while leaving out the one the operator picked would compare against nothing.
  const options = (opts.options || CREW_OPTIONS).slice();
  if (!options.some((o) => o.drivers === curD && o.helpers === curH)) {
    options.push({ drivers: curD, helpers: curH });
    options.sort((a, b) => a.drivers + a.helpers - (b.drivers + b.helpers) || a.drivers - b.drivers);
  }

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
// Prefer what ACTUALLY went out over what was planned. Calibrating a crew of 4
// as if it had been the 2 on the estimate misattributes the productivity and
// poisons cuFtPerHour, the most sensitive parameter in the model.
const rowCrew = (row) => ({
  drivers: num(row.actual_drivers, num(row.drivers, 1)),
  helpers: num(row.actual_helpers, num(row.helpers, 1)),
  trucks: num(row.actual_trucks, num(row.trucks, 1)),
});

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
