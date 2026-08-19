import { describe, it, expect } from "vitest";
import {
  cashFlows, effectiveKwDc, fairMarketValue, fmvPerW, hardCostRollup, irr,
  irrBySunHours, npv, portfolioCashFlow, portfolioTotals, rateSheetTotal,
  taxCredit, totalCostToBuild, unleveredIrr, verdict, wattsDc, year1Noi,
} from "./model";
import { PROJECTS, PURCHASE_ORDERS, RATE_SHEET } from "./seed";
import { DEFAULT_SCENARIO, type Scenario } from "./types";

const S = DEFAULT_SCENARIO;
const p0 = PROJECTS[0];
const built = PROJECTS.filter((p) => p.phase === "f2_construction" || p.phase === "f3_maintenance");

describe("system size", () => {
  it("uses the latest confirmed size, final winning over structural", () => {
    for (const p of PROJECTS) {
      const expected =
        p.sizes.finalKwDc?.value ?? p.sizes.structuralKwDc?.value ?? p.sizes.helioscopeKwDc.value;
      expect(effectiveKwDc(p)).toBe(expected);
    }
  });

  it("structural review never revises the array upward", () => {
    for (const p of PROJECTS) {
      if (!p.sizes.structuralKwDc) continue;
      expect(p.sizes.structuralKwDc.value).toBeLessThanOrEqual(p.sizes.helioscopeKwDc.value);
    }
  });
});

describe("production", () => {
  it("year 1 production is size x sun hours, undegraded", () => {
    const rows = cashFlows(p0, S);
    expect(rows[0].productionKwh).toBeCloseTo(effectiveKwDc(p0) * S.sunHours, 6);
  });

  it("degrades at the scenario rate every year after the first", () => {
    const rows = cashFlows(p0, S);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i].productionKwh / rows[i - 1].productionKwh).toBeCloseTo(1 - S.degradation, 9);
    }
  });

  it("more sun hours means more production and more NOI", () => {
    const lo = year1Noi(p0, { ...S, sunHours: 1100 });
    const hi = year1Noi(p0, { ...S, sunHours: 1250 });
    expect(hi).toBeGreaterThan(lo);
  });
});

describe("NOI", () => {
  it("is revenue less the management fee, site lease, O&M and insurance", () => {
    const r = cashFlows(p0, S)[0];
    expect(r.noi).toBeCloseTo(r.revenue - r.mgmtFee - r.siteLease - r.om - r.insurance, 6);
  });

  it("a deeper subscriber discount lowers revenue", () => {
    const lmi = year1Noi(p0, { ...S, subscriberMix: "lmi" });
    const non = year1Noi(p0, { ...S, subscriberMix: "non_lmi" });
    expect(lmi).toBeLessThan(non); // LMI discount is the deeper one
  });
});

describe("valuation", () => {
  it("FMV is the multiple times year-1 NOI", () => {
    expect(fairMarketValue(p0, S)).toBeCloseTo(17 * year1Noi(p0, S), 6);
  });

  it("FMV per watt divides by system size, and the credit multiplies it back", () => {
    const perW = fmvPerW(p0, S);
    expect(perW * wattsDc(p0)).toBeCloseTo(fairMarketValue(p0, S), 4);
    expect(taxCredit(p0, S)).toBeCloseTo(perW * wattsDc(p0) * S.taxCreditPct, 4);
  });

  it("the FMV multiple toggle moves value proportionally", () => {
    const at15 = fairMarketValue(p0, { ...S, fmvMultiple: 15 });
    const at19 = fairMarketValue(p0, { ...S, fmvMultiple: 19 });
    expect(at19 / at15).toBeCloseTo(19 / 15, 9);
  });

  it("40% tax credit is worth a third more than 30%", () => {
    const a = taxCredit(p0, { ...S, taxCreditPct: 0.3 });
    const b = taxCredit(p0, { ...S, taxCreditPct: 0.4 });
    expect(b / a).toBeCloseTo(4 / 3, 9);
  });
});

describe("IRR", () => {
  it("npv at 0% is the plain sum of the flows", () => {
    expect(npv(0, [-100, 50, 60])).toBeCloseTo(10, 9);
  });

  it("solves a known series", () => {
    // -100 now, 110 in a year is exactly 10%.
    expect(irr([-100, 110])!).toBeCloseTo(0.1, 6);
  });

  it("returns null when the flows never turn positive", () => {
    expect(irr([-100, -1, -1])).toBeNull();
  });

  it("rises monotonically with sun hours for every project", () => {
    for (const p of PROJECTS) {
      const by = irrBySunHours(p, S);
      expect(by[1100]).not.toBeNull();
      expect(by[1100]!).toBeLessThan(by[1200]!);
      expect(by[1200]!).toBeLessThan(by[1250]!);
    }
  });

  it("falls when the build costs more", () => {
    const cheap = unleveredIrr(p0, S)!;
    const dear = unleveredIrr(
      { ...p0, assumptions: { ...p0.assumptions, costToBuildBudgetPerW: p0.assumptions.costToBuildBudgetPerW * 1.3, costToBuildActualPerW: null } },
      { ...S, costBasis: "budget" },
    )!;
    expect(dear).toBeLessThan(cheap);
  });

  it("lands in a plausible band for a real solar asset", () => {
    for (const p of PROJECTS) {
      const v = unleveredIrr(p, S)!;
      expect(v).toBeGreaterThan(0.04);
      expect(v).toBeLessThan(0.28);
    }
  });
});

describe("verdict", () => {
  it("flags exactly the deals that clear at 1,200 but fail at 1,100", () => {
    for (const p of PROJECTS) {
      const by = irrBySunHours(p, S);
      const v = verdict(p, S);
      if (v === "pass") expect(by[1100]!).toBeGreaterThanOrEqual(S.benchmarkIrr);
      if (v === "flag") {
        expect(by[1100]!).toBeLessThan(S.benchmarkIrr);
        expect(by[1200]!).toBeGreaterThanOrEqual(S.benchmarkIrr);
      }
      if (v === "fail") expect(by[1200]!).toBeLessThan(S.benchmarkIrr);
    }
  });

  it("a stricter benchmark can only reduce the number of passes", () => {
    const at9 = PROJECTS.filter((p) => verdict(p, { ...S, benchmarkIrr: 0.09 }) === "pass").length;
    const at13 = PROJECTS.filter((p) => verdict(p, { ...S, benchmarkIrr: 0.13 }) === "pass").length;
    expect(at13).toBeLessThanOrEqual(at9);
  });
});

describe("portfolio", () => {
  it("totals are the sum of the parts", () => {
    const t = portfolioTotals(PROJECTS, S);
    const noi = PROJECTS.reduce((a, p) => a + year1Noi(p, S), 0);
    const cost = PROJECTS.reduce((a, p) => a + totalCostToBuild(p, S), 0);
    expect(t.year1Noi).toBeCloseTo(noi, 4);
    expect(t.totalCostToBuild).toBeCloseTo(cost, 4);
    expect(t.fmv).toBeCloseTo(17 * noi, 3);
  });

  it("blended cost per watt is cost over watts, not an average of averages", () => {
    const t = portfolioTotals(PROJECTS, S);
    const w = PROJECTS.reduce((a, p) => a + wattsDc(p), 0);
    expect(t.blendedCostPerW).toBeCloseTo(t.totalCostToBuild / w, 9);
  });

  it("the 25-year portfolio flow sums the project flows year by year", () => {
    const port = portfolioCashFlow(PROJECTS, S);
    expect(port).toHaveLength(25);
    const y1 = PROJECTS.reduce((a, p) => a + cashFlows(p, S)[0].noi, 0);
    expect(port[0].noi).toBeCloseTo(y1, 4);
  });

  it("switching cost basis to budget changes the blend", () => {
    const a = portfolioTotals(PROJECTS, { ...S, costBasis: "budget" }).blendedCostPerW;
    const b = portfolioTotals(PROJECTS, { ...S, costBasis: "actuals" }).blendedCostPerW;
    expect(a).not.toBeCloseTo(b, 6);
  });
});

describe("cost to build", () => {
  it("the rate sheet totals the eight hard lines plus the soft stack", () => {
    expect(rateSheetTotal(RATE_SHEET)).toBeCloseTo(1.359, 3);
  });

  it("counts only the allocated share of an order against a project", () => {
    const w = built.reduce((a, p) => a + wattsDc(p), 0);
    const rows = hardCostRollup(PURCHASE_ORDERS, RATE_SHEET, w);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.actualPerW).toBeGreaterThanOrEqual(0);
      expect(r.budgetPerW).toBeGreaterThan(0);
    }
    // An order with no allocation contributes nothing.
    const none = hardCostRollup(
      PURCHASE_ORDERS.map((p) => ({ ...p, allocations: [] })),
      RATE_SHEET,
      w,
    );
    expect(none.every((r) => r.actualPerW === 0)).toBe(true);
  });
});

describe("scenario coherence", () => {
  it("every scenario toggle moves at least one headline number", () => {
    const base = portfolioTotals(PROJECTS, S);
    const variants: Partial<Scenario>[] = [
      { sunHours: 1100 }, { taxCreditPct: 0.4 }, { costBasis: "budget" },
      { subscriberMix: "lmi" }, { fmvMultiple: 19 },
    ];
    for (const v of variants) {
      const t = portfolioTotals(PROJECTS, { ...S, ...v });
      const moved =
        Math.abs(t.year1Noi - base.year1Noi) > 1 ||
        Math.abs(t.fmv - base.fmv) > 1 ||
        Math.abs(t.taxCredit - base.taxCredit) > 1 ||
        Math.abs(t.blendedCostPerW - base.blendedCostPerW) > 1e-6;
      expect(moved, `toggle ${JSON.stringify(v)} changed nothing`).toBe(true);
    }
  });

  it("degradation and the rate escalator bite later, not in year 1", () => {
    // They must leave year-1 NOI untouched and still move the 25-year tail —
    // that is exactly why they belong in the model and not in a headline KPI.
    for (const v of [{ degradation: 0.007 } as const, { electricRateEscalator: 0.03 } as const]) {
      const base = portfolioCashFlow(PROJECTS, S);
      const alt = portfolioCashFlow(PROJECTS, { ...S, ...v });
      expect(alt[0].noi).toBeCloseTo(base[0].noi, 4);
      expect(Math.abs(alt[24].noi - base[24].noi)).toBeGreaterThan(1);
    }
  });
});
