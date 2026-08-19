// The single source of every number in the product.
//
// Screens never compute economics themselves and never display a stored result:
// production, NOI, fair market value, the tax credit and IRR all come from here.
// That is what makes the dashboard, the cost rollup and the 25-year model agree.

import type {
  CostBasis,
  Expense,
  HardCostLine,
  Project,
  PurchaseOrder,
  RateSheet,
  Scenario,
  SoftCostLine,
  SunHours,
} from "./types";

export const PROJECTION_YEARS = 25;

/**
 * Portfolio fallbacks for inputs the project manager has not supplied yet.
 *
 * Treating a missing site lease as zero was silently inflating NOI on every
 * early-phase project — the exact class of error this product exists to stop. An
 * unknown input falls back to a stated assumption, and the UI marks it as one.
 */
export const PORTFOLIO_DEFAULTS = {
  siteLeasePerWDc: 0.034,
  siteLeaseEscalator: 0.02,
  upfrontPayment: 60_000,
};

/** True when a headline number is resting on a default rather than a real input. */
export function usesDefaults(p: Project): boolean {
  return p.siteLeasePerWDc === null || p.siteLeaseEscalator === null || p.upfrontPayment === null;
}
/** O&M and insurance both escalate at a flat 2%/yr (spec §6). */
export const OPEX_ESCALATOR = 0.02;

export const HARD_COST_LINES: HardCostLine[] = [
  "Wiring",
  "Switchgear",
  "Inverters",
  "Modules",
  "Electric Labor",
  "Racking",
  "Block",
  "Slip Sheets",
];

export const SOFT_COST_LINES: SoftCostLine[] = [
  "Engineering & Design",
  "Permitting & AHJ",
  "Interconnection Fees",
  "Legal (LOI/Lease)",
  "Project Management",
  "Commissioning & Testing",
  "Contingency",
];

export const SUN_HOUR_CASES: SunHours[] = [1100, 1200, 1250];

// ── System size ─────────────────────────────────────────────────────────────

/**
 * The size every calculation uses. Three parties confirm a size in sequence and
 * all three are kept; the latest confirmed one wins. Until Avoca's final number
 * lands the project is running on a provisional size — see `sizeIsProvisional`.
 */
export function effectiveKwDc(p: Project): number {
  return (
    p.sizes.finalKwDc?.value ??
    p.sizes.structuralKwDc?.value ??
    p.sizes.helioscopeKwDc.value
  );
}

export function sizeIsProvisional(p: Project): boolean {
  return p.sizes.finalKwDc === null;
}

export const wattsDc = (p: Project): number => effectiveKwDc(p) * 1000;

// ── Inputs resolved against the active scenario ─────────────────────────────

/** $/W actually used for cost. "Actuals" falls back to budget until AP lands. */
export function costPerW(p: Project, basis: CostBasis): number {
  if (basis === "actuals" && p.assumptions.costToBuildActualPerW !== null) {
    return p.assumptions.costToBuildActualPerW;
  }
  return p.assumptions.costToBuildBudgetPerW;
}

/** Whether the $/W above is a real actual or still the budgeted placeholder. */
export function costIsActual(p: Project, basis: CostBasis): boolean {
  return basis === "actuals" && p.assumptions.costToBuildActualPerW !== null;
}

export function totalCostToBuild(p: Project, s: Scenario): number {
  return costPerW(p, s.costBasis) * wattsDc(p);
}

/**
 * Subscribers buy power at a discount to the utility rate. LMI subscribers get a
 * deeper discount, so the portfolio mix moves revenue directly.
 */
export function subscriberDiscount(p: Project, s: Scenario): number {
  const { subscriberDiscountLmi: lmi, subscriberDiscountNonLmi: non } = p.assumptions;
  if (s.subscriberMix === "lmi") return lmi;
  if (s.subscriberMix === "non_lmi") return non;
  const share = p.assumptions.lmiSharePct;
  return lmi * share + non * (1 - share);
}

// ── The 25-year model ───────────────────────────────────────────────────────

export interface YearLine {
  year: number;
  productionKwh: number;
  revenue: number;
  mgmtFee: number;
  siteLease: number;
  om: number;
  insurance: number;
  noi: number;
}

/**
 * One row per operating year. Production degrades, the electric rate escalates,
 * and the site lease, O&M and insurance escalate on their own curves.
 */
export function cashFlows(p: Project, s: Scenario): YearLine[] {
  const kw = effectiveKwDc(p);
  const w = kw * 1000;
  const discount = subscriberDiscount(p, s);
  const a = p.assumptions;
  const leasePerW = p.siteLeasePerWDc ?? PORTFOLIO_DEFAULTS.siteLeasePerWDc;
  const leaseEsc = p.siteLeaseEscalator ?? PORTFOLIO_DEFAULTS.siteLeaseEscalator;

  const rows: YearLine[] = [];
  for (let year = 1; year <= PROJECTION_YEARS; year++) {
    const t = year - 1;
    const productionKwh = kw * s.sunHours * Math.pow(1 - s.degradation, t);
    const rate = a.vderRate.value * Math.pow(1 + s.electricRateEscalator, t);

    const revenue = productionKwh * rate * (1 - discount);
    const mgmtFee = productionKwh * a.subscriptionMgmtFeePerKwh;
    const siteLease = w * leasePerW * Math.pow(1 + leaseEsc, t);
    const om = kw * a.omPerKwDc * Math.pow(1 + OPEX_ESCALATOR, t);
    const insurance = kw * a.insurancePerKwDc * Math.pow(1 + OPEX_ESCALATOR, t);

    rows.push({
      year,
      productionKwh,
      revenue,
      mgmtFee,
      siteLease,
      om,
      insurance,
      noi: revenue - mgmtFee - siteLease - om - insurance,
    });
  }
  return rows;
}

export function year1Noi(p: Project, s: Scenario): number {
  return cashFlows(p, s)[0].noi;
}

// ── Valuation ───────────────────────────────────────────────────────────────

/**
 * Fair market value is a multiple of year-1 NOI. It is shown per watt, and the
 * same dollar figure is the basis the investment tax credit is struck against.
 */
export function fairMarketValue(p: Project, s: Scenario): number {
  return s.fmvMultiple * year1Noi(p, s);
}

export function fmvPerW(p: Project, s: Scenario): number {
  return fairMarketValue(p, s) / wattsDc(p);
}

export function taxCredit(p: Project, s: Scenario): number {
  return fairMarketValue(p, s) * s.taxCreditPct;
}

// ── IRR ─────────────────────────────────────────────────────────────────────

/** Net present value of a cash-flow series where flows[0] sits at t=0. */
export function npv(rate: number, flows: number[]): number {
  return flows.reduce((acc, f, i) => acc + f / Math.pow(1 + rate, i), 0);
}

/**
 * Bisection rather than Newton: the flow shape here (one big outflow, then 25
 * inflows) is well behaved and bisection cannot diverge. Returns null when the
 * series never crosses zero in a sane range — a project that cannot pay back.
 */
export function irr(flows: number[]): number | null {
  let lo = -0.9;
  let hi = 2;
  let fLo = npv(lo, flows);
  const fHi = npv(hi, flows);
  if (Number.isNaN(fLo) || Number.isNaN(fHi) || fLo * fHi > 0) return null;
  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    const fMid = npv(mid, flows);
    if (Math.abs(fMid) < 1e-7) return mid;
    if (fLo * fMid <= 0) {
      hi = mid;
    } else {
      lo = mid;
      fLo = fMid;
    }
  }
  return (lo + hi) / 2;
}

/**
 * Unlevered project cash flows: capex and the upfront payment to the site host
 * go out at t=0, the NYSERDA incentive comes back at t=0, the tax credit is
 * monetised in year 1, and NOI runs for 25 years. No debt, no residual value —
 * FMV is reported separately rather than baked in as a terminal flow.
 */
export function unleveredFlows(p: Project, s: Scenario): number[] {
  const w = wattsDc(p);
  const capex = totalCostToBuild(p, s);
  const incentive = p.assumptions.nyserdaIncentivePerW.value * w;
  const upfront = p.upfrontPayment ?? PORTFOLIO_DEFAULTS.upfrontPayment;

  const flows = [-(capex + upfront) + incentive];
  const rows = cashFlows(p, s);
  for (const r of rows) flows.push(r.noi);
  flows[1] += taxCredit(p, s);
  return flows;
}

export function unleveredIrr(p: Project, s: Scenario): number | null {
  return irr(unleveredFlows(p, s));
}

/** IRR at each of the three sun-hour cases — the sensitivity table's row. */
export function irrBySunHours(p: Project, s: Scenario): Record<SunHours, number | null> {
  const out = {} as Record<SunHours, number | null>;
  for (const sh of SUN_HOUR_CASES) out[sh] = unleveredIrr(p, { ...s, sunHours: sh });
  return out;
}

export type Verdict = "pass" | "flag" | "fail";

/**
 * The pass/fail line, and the case that actually needs a human. A deal that
 * clears the benchmark at 1,200 sun hours but fails at 1,100 is not a
 * calculation any more — it is a decision, so it gets flagged rather than
 * silently counted as a pass.
 */
export function verdict(p: Project, s: Scenario): Verdict {
  const by = irrBySunHours(p, s);
  const low = by[1100];
  const base = by[1200];
  if (low !== null && low >= s.benchmarkIrr) return "pass";
  if (base !== null && base >= s.benchmarkIrr) return "flag";
  return "fail";
}

// ── Portfolio rollups ───────────────────────────────────────────────────────

export interface PortfolioTotals {
  year1Noi: number;
  fmv: number;
  taxCredit: number;
  totalCostToBuild: number;
  mwDc: number;
  belowBenchmark: number;
  flagged: number;
  blendedCostPerW: number;
}

export function portfolioTotals(projects: Project[], s: Scenario): PortfolioTotals {
  let noi = 0;
  let fmv = 0;
  let tc = 0;
  let cost = 0;
  let w = 0;
  let below = 0;
  let flagged = 0;

  for (const p of projects) {
    noi += year1Noi(p, s);
    fmv += fairMarketValue(p, s);
    tc += taxCredit(p, s);
    cost += totalCostToBuild(p, s);
    w += wattsDc(p);
    const v = verdict(p, s);
    if (v === "fail") below++;
    if (v === "flag") flagged++;
  }

  return {
    year1Noi: noi,
    fmv,
    taxCredit: tc,
    totalCostToBuild: cost,
    mwDc: w / 1_000_000,
    belowBenchmark: below,
    flagged,
    blendedCostPerW: w > 0 ? cost / w : 0,
  };
}

/** Portfolio cash flow, summed across projects, for the 25-year chart. */
export function portfolioCashFlow(projects: Project[], s: Scenario): YearLine[] {
  const out: YearLine[] = [];
  for (let year = 1; year <= PROJECTION_YEARS; year++) {
    out.push({
      year,
      productionKwh: 0,
      revenue: 0,
      mgmtFee: 0,
      siteLease: 0,
      om: 0,
      insurance: 0,
      noi: 0,
    });
  }
  for (const p of projects) {
    const rows = cashFlows(p, s);
    for (let i = 0; i < rows.length; i++) {
      const a = out[i];
      const b = rows[i];
      a.productionKwh += b.productionKwh;
      a.revenue += b.revenue;
      a.mgmtFee += b.mgmtFee;
      a.siteLease += b.siteLease;
      a.om += b.om;
      a.insurance += b.insurance;
      a.noi += b.noi;
    }
  }
  return out;
}

// ── Cost to build ───────────────────────────────────────────────────────────

/** Budgeted $/W for a rate sheet: the eight hard lines plus the soft stack. */
export function rateSheetHardTotal(rs: RateSheet): number {
  return HARD_COST_LINES.reduce((a, k) => a + rs.hard[k], 0);
}

export function rateSheetSoftTotal(rs: RateSheet): number {
  return SOFT_COST_LINES.reduce((a, k) => a + rs.soft[k], 0);
}

export function rateSheetTotal(rs: RateSheet): number {
  return rateSheetHardTotal(rs) + rateSheetSoftTotal(rs);
}

export interface HardCostRow {
  line: HardCostLine;
  budgetPerW: number;
  actualPerW: number;
  variancePct: number;
  tone: "under" | "on" | "over";
}

/**
 * Budget vs actual per hard-cost line. Actuals come from purchase orders, and
 * only the ALLOCATED share of an order counts against a project — the rest is
 * still sitting in inventory with nobody's name on it.
 */
export function hardCostRollup(
  pos: PurchaseOrder[],
  rs: RateSheet,
  allocatedWatts: number,
): HardCostRow[] {
  const spent = new Map<HardCostLine, number>();
  for (const po of pos) {
    const allocated = po.allocations.reduce((a, x) => a + x.pct, 0);
    spent.set(po.costLine, (spent.get(po.costLine) ?? 0) + po.total * allocated);
  }
  return HARD_COST_LINES.map((line) => {
    const budgetPerW = rs.hard[line];
    const actualPerW = allocatedWatts > 0 ? (spent.get(line) ?? 0) / allocatedWatts : 0;
    const variancePct = budgetPerW > 0 ? (actualPerW - budgetPerW) / budgetPerW : 0;
    const tone: HardCostRow["tone"] =
      variancePct < -0.01 ? "under" : variancePct > 0.01 ? "over" : "on";
    return { line, budgetPerW, actualPerW, variancePct, tone };
  });
}

/** Stock that has physically arrived or is on its way — not every order raised. */
export const onHandPos = (pos: PurchaseOrder[]) =>
  pos.filter((p) => p.status === "received" || p.status === "in_transit");

export function inventoryOnHand(pos: PurchaseOrder[]): number {
  return onHandPos(pos).reduce((a, p) => a + p.total, 0);
}

/** Share of on-hand inventory value that carries a project's name. */
export function allocatedShare(pos: PurchaseOrder[]): number {
  const on = onHandPos(pos);
  const total = on.reduce((a, p) => a + p.total, 0);
  if (total === 0) return 0;
  const alloc = on.reduce(
    (a, p) => a + p.total * p.allocations.reduce((x, y) => x + y.pct, 0),
    0,
  );
  return alloc / total;
}

export const openPos = (pos: PurchaseOrder[]) => pos.filter((p) => p.status !== "received");

// ── Accounting ──────────────────────────────────────────────────────────────

export const unattributed = (xs: Expense[]) => xs.filter((e) => e.attributedProjectId === null);

export function unattributedValue(xs: Expense[]): number {
  return unattributed(xs).reduce((a, e) => a + e.amount, 0);
}

/**
 * Committed equipment spend per project, from the allocated share of orders.
 * This is the bulk of a project's actual cost; the expense feed adds the soft
 * costs and services on top.
 */
export function allocatedPoValueByProject(pos: PurchaseOrder[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const po of pos) {
    for (const a of po.allocations) {
      m.set(a.projectId, (m.get(a.projectId) ?? 0) + po.total * a.pct);
    }
  }
  return m;
}

/** Actual spend booked against a project, from attributed expenses. */
export function actualsByProject(xs: Expense[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of xs) {
    if (!e.attributedProjectId) continue;
    m.set(e.attributedProjectId, (m.get(e.attributedProjectId) ?? 0) + e.amount);
  }
  return m;
}
