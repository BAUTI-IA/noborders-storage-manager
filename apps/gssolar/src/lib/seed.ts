// Deterministic mock portfolio.
//
// Everything here is an INPUT. Nothing in this file is an NOI, a valuation, a
// tax credit or an IRR — those are computed in lib/model.ts so that the
// dashboard, the cost rollup and the 25-year model can never disagree.

import type {
  AssetType,
  Bid,
  Expense,
  HardCostLine,
  Lead,
  LeadSource,
  LeadStatus,
  Owned,
  Phase,
  Project,
  PurchaseOrder,
  RateSheet,
  StateCode,
} from "./types";

/** mulberry32 — small, fast, and stable across reloads so demos repeat. */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const r = rng(20260819);
const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)];
const between = (lo: number, hi: number) => lo + r() * (hi - lo);
const round = (n: number, dp = 2) => Number(n.toFixed(dp));

/** The demo's "today". Fixed so relative dates never drift between runs. */
export const TODAY = new Date("2026-08-19T12:00:00Z");

const daysAgo = (n: number) =>
  new Date(TODAY.getTime() - n * 86_400_000).toISOString().slice(0, 10);

export function daysSince(iso: string): number {
  return Math.floor((TODAY.getTime() - new Date(iso + "T12:00:00Z").getTime()) / 86_400_000);
}

export const PMS = ["Monica Ortiz", "Thomas Reed", "Meera Shah", "Kevin Doyle", "Dana Whitfield"];
export const ENGINEERS = ["Meera Shah", "Avoca Engineering", "Helioscope"];

const SITES: Record<StateCode, string[]> = {
  NY: ["Rochester", "Buffalo", "Syracuse", "Albany", "Yonkers", "Batavia", "Port Chester", "Utica", "Poughkeepsie", "White Plains"],
  NJ: ["Jersey City", "Edison", "Newark", "Trenton", "Camden", "Paterson", "Elizabeth", "Cherry Hill"],
  MA: ["Northfield", "Springfield", "Worcester", "Lowell", "Brockton", "New Bedford", "Pittsfield"],
};

const NAME_HEADS = [
  "Riverbend", "Hillside", "Warwick", "Springfield", "Nassau County", "Genesee Valley",
  "Northfield", "Meadowbrook", "Ironworks", "Clearwater", "Fairview", "Stonebridge",
  "Harborview", "Lakeshore", "Cedar Run", "Brookline", "Granite Hill", "Willow Creek",
  "Bay State", "Copperfield", "Millrace", "Kingsport", "Redfield", "Oakmont",
  "Silverton", "Ashford", "Beaumont", "Larkspur", "Windham", "Foxglove",
  "Tanner Hill", "Elmwood", "Pinehurst", "Corvina", "Halstead",
];

const NAME_TAILS: Record<AssetType, string[]> = {
  rooftop: ["Commerce Park", "Logistics Center", "Distribution", "Industrial Park"],
  ground_mount: ["Ground-Mount A", "Ground-Mount B", "Solar Field", "Ag Solar"],
  carport: ["Carport", "Transit Carport", "Campus Carport"],
  community: ["Community Solar", "Community Array", "Cooperative Solar"],
};

const COMPANY_TAILS = ["LLC", "Holdings LLC", "Properties LP", "Realty LLC", "Partners LLC"];

const ASSET_TYPES: AssetType[] = ["rooftop", "ground_mount", "carport", "community"];
const STATES: StateCode[] = ["NY", "NY", "NY", "NJ", "NJ", "MA"]; // NY-weighted, per the portfolio

/** Size bands by asset type, in kW-DC. */
const SIZE_BAND: Record<AssetType, [number, number]> = {
  rooftop: [900, 4200],
  ground_mount: [2500, 7800],
  carport: [1100, 3200],
  community: [3000, 7000],
};

/**
 * Each state runs its own incentive regime and its own value-of-energy rate:
 * NY has VDER plus NYSERDA blocks, NJ has SREC-II, MA has SMART. The band is a
 * clamp, not a draw — see `vderForMargin`.
 */
const STATE_RATE: Record<StateCode, [number, number]> = {
  NY: [0.126, 0.163],
  NJ: [0.119, 0.152],
  MA: [0.131, 0.168],
};
const STATE_INCENTIVE: Record<StateCode, [number, number]> = {
  NY: [0.16, 0.24],
  NJ: [0.08, 0.14],
  MA: [0.11, 0.18],
};

/** Carports cost the most per watt to build; ground-mount the least. */
const COST_BAND: Record<AssetType, [number, number]> = {
  rooftop: [1.2, 1.4],
  ground_mount: [1.1, 1.28],
  carport: [1.4, 1.62],
  community: [1.16, 1.36],
};

/**
 * Revenue and cost are not independent: a developer prices a site to a margin,
 * and better sites cost more to build. Drawing VDER freely produced cheap
 * projects with rich revenue and 30%+ IRRs, which no real portfolio contains.
 * So we pick a target NOI per watt as a multiple of cost per watt, solve for the
 * rate that delivers it, and clamp the result into the state's plausible band.
 *
 * With FMV struck at 17x NOI, a factor of 0.070-0.090 puts fair market value at
 * 1.2-1.5x cost to build — the spread a developer actually works in.
 */
function vderForMargin(
  costPerW: number,
  factor: number,
  leasePerW: number,
  omPerKw: number,
  insPerKw: number,
  discount: number,
  band: [number, number],
): number {
  const targetNoiPerW = costPerW * factor;
  const kwhPerW = 1.2; // the 1,200 sun-hour base case
  const revenuePerVder = kwhPerW * (1 - discount);
  const fixedPerW = kwhPerW * 0.008 + leasePerW + (omPerKw + insPerKw) / 1000;
  const raw = (targetNoiPerW + fixedPerW) / revenuePerVder;
  return round(Math.min(band[1], Math.max(band[0], raw)), 4);
}

const PHASE_MIX: Phase[] = [
  "lead", "lead", "lead",
  "qualified_site", "qualified_site", "qualified_site", "qualified_site",
  "f1_lease", "f1_lease", "f1_lease", "f1_lease", "f1_lease",
  "f2_construction", "f2_construction", "f2_construction",
  "f3_maintenance", "f3_maintenance",
];

const ROOF_DETAIL = ["TPO · 2016", "TPO · 2019", "EPDM · 2011", "EPDM · 2018", "Standing seam · 2014"];

function roofOrLand(t: AssetType): string {
  if (t === "rooftop") return pick(ROOF_DETAIL);
  if (t === "carport") return `${Math.round(between(320, 940))} stalls`;
  return `${round(between(6, 48), 1)} acres`;
}

function owned<T>(value: T, owner: string, ago: number): Owned<T> {
  return { value, owner, confirmedAt: daysAgo(ago) };
}

const QUARTERS = ["2026-Q4", "2027-Q1", "2027-Q2", "2027-Q3", "2027-Q4", "2028-Q1", "2028-Q2"];

function buildProject(i: number): Project {
  const assetType = ASSET_TYPES[i % 4];
  const state = STATES[i % STATES.length];
  const city = pick(SITES[state]);
  const head = NAME_HEADS[i % NAME_HEADS.length];
  const name = `${head} ${pick(NAME_TAILS[assetType])}`;
  const phase = PHASE_MIX[i % PHASE_MIX.length];
  const pm = PMS[i % PMS.length];

  const [loKw, hiKw] = SIZE_BAND[assetType];
  const helioscope = round(between(loKw, hiKw), 0);
  // Structural review almost always trims the array down.
  const structural = round(helioscope * between(0.88, 0.98), 0);

  // Avoca's final size only exists once the project is past leasing.
  const hasFinal = phase === "f2_construction" || phase === "f3_maintenance" || (phase === "f1_lease" && r() < 0.35);
  const final = hasFinal ? round(structural * between(0.97, 1.01), 0) : null;

  const [loRate, hiRate] = STATE_RATE[state];
  const [loInc, hiInc] = STATE_INCENTIVE[state];
  const [loCost, hiCost] = COST_BAND[assetType];

  const budgetPerW = round(between(loCost, hiCost), 3);
  // Actuals only exist once construction has started, and they drift off budget.
  const hasActuals = phase === "f2_construction" || phase === "f3_maintenance";
  const actualPerW = hasActuals ? round(budgetPerW * between(0.94, 1.11), 3) : null;

  const pastLead = phase !== "lead";
  const pastQualified = pastLead && phase !== "qualified_site";
  const inF2 = phase === "f2_construction" || phase === "f3_maintenance";
  const energized = phase === "f3_maintenance";

  // How long this project has been sitting in its CURRENT phase. Building the
  // timeline backwards from today keeps phase ages realistic; deriving them from
  // a single project age produced two-year-old "qualified sites".
  const PHASE_AGE: Record<Phase, [number, number]> = {
    lead: [8, 110],
    qualified_site: [20, 155],
    f1_lease: [25, 185],
    f2_construction: [40, 260],
    f3_maintenance: [30, 400],
  };
  const inPhase = Math.round(between(...PHASE_AGE[phase]));

  // Walk back through the gates the project has already passed.
  let cursor = inPhase;
  const maintenanceStartAt = energized ? daysAgo(cursor) : null;
  const energizedAt = maintenanceStartAt;
  if (energized) cursor += Math.round(between(180, 300));
  const constructionStartAt = inF2 ? daysAgo(energized ? cursor : inPhase) : null;
  if (inF2) cursor = energized ? cursor : inPhase;
  if (inF2) cursor += Math.round(between(10, 60));
  const leaseExecutedAt = inF2 ? daysAgo(cursor) : null;
  if (inF2) cursor += Math.round(between(30, 120));
  const loiSignedAt = pastQualified ? daysAgo(inF2 ? cursor : inPhase) : null;
  if (pastQualified) cursor = inF2 ? cursor : inPhase;
  if (pastQualified) cursor += Math.round(between(40, 160));
  const leadConvertedAt = pastLead ? daysAgo(pastQualified ? cursor : inPhase) : null;
  if (pastLead) cursor = pastQualified ? cursor : inPhase;
  const ageDays = cursor + Math.round(between(10, 60));

  const siteLeasePerWDc = pastLead ? round(between(0.026, 0.044), 3) : 0.034;
  const omPerKwDc = round(between(12.0, 15.0), 2);
  const insurancePerKwDc = round(between(10.5, 13.5), 2);
  const lmiSharePct = round(between(0.15, 0.7), 2);
  const blendedDiscount = 0.1 * lmiSharePct + 0.075 * (1 - lmiSharePct);
  const vder = vderForMargin(
    actualPerW ?? budgetPerW,
    between(0.06, 0.092),
    siteLeasePerWDc,
    omPerKwDc,
    insurancePerKwDc,
    blendedDiscount,
    [loRate, hiRate],
  );

  return {
    id: `P-${String(i + 1).padStart(3, "0")}`,
    name,
    companyName: `${head} ${pick(COMPANY_TAILS)}`,
    address: `${Math.round(between(100, 4800))} ${pick(["Riverbend Dr", "Commerce Way", "Industrial Pkwy", "Mill Street", "Depot Road", "Enterprise Blvd"])}`,
    city,
    state,
    assetType,
    pm,
    createdAt: daysAgo(ageDays),
    phase,
    milestones: {
      leadConvertedAt, loiSignedAt, leaseExecutedAt,
      constructionStartAt, energizedAt, maintenanceStartAt,
    },
    estEnergizationQuarter: QUARTERS[i % QUARTERS.length],
    // The interconnection check is the gate into F2, so anything already in F2
    // must have it; earlier projects are a coin flip.
    utilityInterconnectionCheck: inF2 ? true : r() < 0.45,
    sizes: {
      helioscopeKwDc: owned(helioscope, "Meera Shah", Math.round(ageDays * 0.8)),
      structuralKwDc: pastLead ? owned(structural, `Structural · ${pm.split(" ")[0]}`, Math.round(ageDays * 0.5)) : null,
      finalKwDc: final !== null ? owned(final, "Avoca (external)", Math.round(ageDays * 0.2)) : null,
    },
    siteLeasePerWDc: pastLead ? siteLeasePerWDc : null,
    siteLeaseEscalator: pastLead ? round(between(0.015, 0.03), 3) : null,
    upfrontPayment: pastLead ? Math.round(between(25_000, 145_000) / 5000) * 5000 : null,
    assumptions: {
      // A stale VDER rate is the single most common silent error in the old
      // spreadsheet, so ages here deliberately straddle the 90-day trigger.
      vderRate: owned(vder, pick(["Meera Shah", "Dana Whitfield"]), Math.round(between(12, 132))),
      nyserdaIncentivePerW: owned(round(between(loInc, hiInc), 3), "Meera Shah", Math.round(between(20, 160))),
      subscriberDiscountLmi: 0.1,
      subscriberDiscountNonLmi: 0.075,
      subscriptionMgmtFeePerKwh: 0.008,
      omPerKwDc,
      insurancePerKwDc,
      costToBuildBudgetPerW: budgetPerW,
      costToBuildActualPerW: actualPerW,
      lmiSharePct,
    },
    roofOrLand: roofOrLand(assetType),
    leadId: pastLead ? `L-${String(i + 1).padStart(3, "0")}` : null,
  };
}

export const PROJECTS: Project[] = Array.from({ length: 35 }, (_, i) => buildProject(i));

// ── Leads ───────────────────────────────────────────────────────────────────

const CONTACT_FIRST = ["Dana", "Ellen", "Priya", "Tom", "Greg", "Ray", "Alan", "Nina", "Marcus", "Sofia", "Deb", "Hector"];
const CONTACT_LAST = ["Whitfield", "Boyd", "Raman", "Kelly", "Sandoval", "Alvarez", "Petrosian", "Okafor", "Lindqvist", "Duarte"];
const TITLES = ["VP Facilities", "CFO", "Owner", "Dir. Real Estate", "GM", "COO", "Head of Sustainability", "Plant Manager"];
const SOURCES: LeadSource[] = ["HubSpot form", "Referral", "Outbound", "NYSERDA event", "Partner"];
const LEAD_STATUS: LeadStatus[] = ["new", "contacted", "contacted", "site_qualified", "site_qualified", "converted"];

function buildLead(i: number): Lead {
  const converted = i < PROJECTS.length && PROJECTS[i].leadId !== null;
  const status: LeadStatus = converted ? "converted" : LEAD_STATUS[i % LEAD_STATUS.length];
  const assetType = converted ? PROJECTS[i].assetType : pick(ASSET_TYPES);
  const state = converted ? PROJECTS[i].state : pick(STATES);
  const city = converted ? PROJECTS[i].city : pick(SITES[state]);
  const head = NAME_HEADS[(i * 13) % NAME_HEADS.length]; // 13 is coprime with 35, so all names appear

  return {
    id: `L-${String(i + 1).padStart(3, "0")}`,
    companyName: converted ? PROJECTS[i].companyName : `${head} ${pick(COMPANY_TAILS)}`,
    contactName: `${pick(CONTACT_FIRST)} ${pick(CONTACT_LAST)}`,
    contactTitle: pick(TITLES),
    city,
    state,
    assetType,
    estSizeKwDc: converted ? PROJECTS[i].sizes.helioscopeKwDc.value : round(between(700, 6800), 0),
    roofOrLand: converted ? PROJECTS[i].roofOrLand : roofOrLand(assetType),
    status,
    source: pick(SOURCES),
    owner: pick(PMS),
    lastTouchAt: daysAgo(Math.round(between(0, 62))),
    convertedProjectId: converted ? PROJECTS[i].id : null,
  };
}

export const LEADS: Lead[] = Array.from({ length: 60 }, (_, i) => buildLead(i));

// ── Master rate sheet ───────────────────────────────────────────────────────

export const RATE_SHEET: RateSheet = {
  version: "v4",
  effectiveFrom: "2026-07-01",
  hard: {
    Modules: 0.412,
    Inverters: 0.148,
    Racking: 0.121,
    Wiring: 0.064,
    Switchgear: 0.089,
    "Electric Labor": 0.196,
    Block: 0.048,
    "Slip Sheets": 0.021,
  },
  soft: {
    "Engineering & Design": 0.058,
    "Permitting & AHJ": 0.031,
    "Interconnection Fees": 0.047,
    "Legal (LOI/Lease)": 0.022,
    "Project Management": 0.039,
    "Commissioning & Testing": 0.018,
    Contingency: 0.045,
  },
};

// ── Purchase orders ─────────────────────────────────────────────────────────

/**
 * Equipment catalogue. `qty` is derived from the budget rather than drawn, so a
 * purchase order always describes a plausible quantity of a real thing — 3 units
 * of switchgear, not 3,576.
 */
const PO_CATALOG: {
  item: string; line: HardCostLine; vendor: string; unitLabel: string;
  /**
   * How many watts of array one unit covers, so quantities follow the size of
   * the job. `null` means the order is a single lot. Deriving qty from the order
   * value instead produced 13 MW of modules for a 3 MW roof.
   */
  wattsPerUnit: number | null;
}[] = [
  { item: "Modules — 585W bifacial", line: "Modules", vendor: "Qcells", unitLabel: "$/W", wattsPerUnit: 1 },
  { item: "Modules — 550W mono", line: "Modules", vendor: "Trina Solar", unitLabel: "$/W", wattsPerUnit: 1 },
  { item: "Inverters — CPS 250kW", line: "Inverters", vendor: "Chint Power", unitLabel: "ea", wattsPerUnit: 250_000 },
  { item: "Inverters — string 100kW", line: "Inverters", vendor: "CPS America", unitLabel: "ea", wattsPerUnit: 100_000 },
  { item: "Racking — ballasted", line: "Racking", vendor: "Unirac", unitLabel: "lot", wattsPerUnit: null },
  { item: "Racking — carport steel", line: "Racking", vendor: "TerraSmart", unitLabel: "lot", wattsPerUnit: null },
  { item: "Switchgear — 2000A", line: "Switchgear", vendor: "Eaton", unitLabel: "ea", wattsPerUnit: 1_500_000 },
  { item: "Combiner / wire harness", line: "Wiring", vendor: "Shoals", unitLabel: "lot", wattsPerUnit: null },
  { item: "Slip sheets", line: "Slip Sheets", vendor: "Carlisle", unitLabel: "ea", wattsPerUnit: 200 },
  { item: "Ballast block", line: "Block", vendor: "Oldcastle", unitLabel: "ea", wattsPerUnit: 420 },
  { item: "Electrical labor — week block", line: "Electric Labor", vendor: "Northeast Electric", unitLabel: "wk", wattsPerUnit: 800_000 },
];

/** How many orders each cost line is split across. */
const POS_PER_LINE: Record<HardCostLine, number> = {
  Modules: 5, Inverters: 4, Racking: 3, Wiring: 2,
  Switchgear: 3, "Electric Labor": 4, Block: 2, "Slip Sheets": 2,
};

/**
 * Purchase orders are generated FROM the budget, not independently of it.
 *
 * The screen they feed exists to show budget versus actual, so drawing order
 * values at random produced variances in the thousands of percent and an
 * inventory figure two orders of magnitude too large. Instead each cost line
 * gets a deliberate variance against its rate-sheet budget, and the orders are
 * sized to land there once allocation is taken into account.
 */
function buildPurchaseOrders(): PurchaseOrder[] {
  const built = PROJECTS.filter((p) => p.phase === "f2_construction" || p.phase === "f3_maintenance");
  const builtWatts = built.reduce((a, p) => a + (p.sizes.finalKwDc?.value ?? p.sizes.structuralKwDc?.value ?? p.sizes.helioscopeKwDc.value) * 1000, 0);

  // The variance the operator is meant to see on the Cost to Build screen.
  const LINE_VARIANCE: Record<HardCostLine, number> = {
    Modules: -0.031, Inverters: 0.094, Racking: 0.004, Wiring: -0.018,
    Switchgear: 0.062, "Electric Labor": 0.077, Block: 0.009, "Slip Sheets": -0.045,
  };

  const out: PurchaseOrder[] = [];
  let n = 0;

  for (const line of Object.keys(POS_PER_LINE) as HardCostLine[]) {
    const count = POS_PER_LINE[line];
    const lineTarget = RATE_SHEET.hard[line] * builtWatts * (1 + LINE_VARIANCE[line]);
    const options = PO_CATALOG.filter((c) => c.line === line);

    for (let i = 0; i < count; i++) {
      const c = options[i % options.length];
      const share = 1 / count;
      // Allocation is decided after the order is placed, and part of a bulk buy
      // often has no project name on it yet.
      const roll = r();
      const a = built[Math.floor(r() * built.length)];
      const b = built[Math.floor(r() * built.length)];
      const allocations =
        roll < 0.45 ? [{ projectId: a.id, pct: 1 }]
        : roll < 0.68 ? [{ projectId: a.id, pct: round(between(0.55, 0.82), 2) }]
        : roll < 0.9 && b.id !== a.id
          ? [{ projectId: a.id, pct: 0.6 }, { projectId: b.id, pct: 0.4 }]
          : [];
      const allocated = allocations.reduce((x, y) => x + y.pct, 0);

      // Size the order so its ALLOCATED value hits the line's share of budget.
      const wanted = lineTarget * share;
      const total = allocated > 0 ? wanted / allocated : wanted * between(0.4, 0.9);

      // Quantity follows the size of the job; the unit cost is then whatever the
      // order works out to per unit — an installed cost, which is what a real PO
      // against a cost-to-build line actually carries.
      const wattsCovered = builtWatts * share;
      const qty = c.wattsPerUnit === null ? 1 : Math.max(1, Math.round(wattsCovered / c.wattsPerUnit));
      const unitCost = qty === 1 ? Math.round(total) : Number((total / qty).toFixed(qty > 1000 ? 3 : 2));

      out.push({
        id: `PO-${2240 + n}`,
        item: c.item,
        costLine: line,
        vendor: c.vendor,
        qty,
        unitLabel: c.unitLabel,
        unitCost,
        total: Math.round(unitCost * qty),
        allocations,
        status: roll < 0.22 ? "in_transit" : roll < 0.34 ? "ordered" : "received",
        arrivesOutOfSequence: r() < 0.17,
      });
      n++;
    }
  }
  return out;
}

export const PURCHASE_ORDERS: PurchaseOrder[] = buildPurchaseOrders();

// ── Expenses awaiting attribution ───────────────────────────────────────────

const GL = [
  ["1450", "CIP Hard Cost"],
  ["1460", "CIP Labor"],
  ["6120", "Soft Cost Eng"],
  ["6140", "Permitting"],
  ["6210", "Legal"],
  ["6320", "Interconnection"],
];

const EXPENSE_VENDORS = [
  ["Eaton", "Switchgear deposit"],
  ["Avoca Engineering", "Structural review"],
  ["City of Rochester", "Building permit"],
  ["Unirac", "Freight surcharge"],
  ["Northeast Electric", "Labor — week 32"],
  ["Qcells", "Module progress payment"],
  ["National Grid", "Interconnection study"],
  ["Harris & Boyle LLP", "Lease review"],
  ["Chint Power", "Inverter freight"],
  ["Carlisle", "Slip sheet restock"],
];

function buildExpense(i: number): Expense {
  const [vendor, memo] = EXPENSE_VENDORS[i % EXPENSE_VENDORS.length];
  const [glAccount, glName] = GL[i % GL.length];
  const built = PROJECTS.filter((p) => p.phase === "f2_construction" || p.phase === "f3_maintenance");
  const target = built[Math.floor(r() * built.length)];

  // The feed proposes a project; below ~55% it is not worth proposing at all and
  // the row queues for a human instead.
  const conf = round(between(0.42, 0.98), 2);
  const matched = conf >= 0.55;
  const attributed = i >= 22; // the older rows have already been dealt with

  return {
    id: `E-${String(i + 1).padStart(3, "0")}`,
    date: daysAgo(Math.round(between(1, 34))),
    vendor,
    memo,
    glAccount,
    glName,
    amount: Math.round(between(2_400, 96_000)),
    suggestedProjectId: matched ? target.id : null,
    confidence: matched ? conf : null,
    attributedProjectId: attributed ? target.id : null,
  };
}

export const EXPENSES: Expense[] = Array.from({ length: 40 }, (_, i) => buildExpense(i));

// ── Bids ────────────────────────────────────────────────────────────────────

const BID_SCOPES = [
  "Electrical Labor", "Civil / Site Work", "Roof Repair & Prep", "Racking Install",
  "Fencing & Security", "Interconnection Build", "Commissioning",
];

export const BIDS: Bid[] = Array.from({ length: 7 }, (_, i) => {
  const p = PROJECTS[(i * 5) % PROJECTS.length];
  const unit: Bid["unit"] = i % 2 === 0 ? "$/W" : "$";
  const budget = unit === "$/W" ? round(between(0.14, 0.24), 3) : Math.round(between(90_000, 380_000));
  const low = unit === "$/W" ? round(budget * between(0.88, 0.99), 3) : Math.round(budget * between(0.85, 0.98));
  const high = unit === "$/W" ? round(budget * between(1.05, 1.3), 3) : Math.round(budget * between(1.04, 1.28));
  return {
    id: `B-${i + 1}`,
    scope: BID_SCOPES[i],
    projectId: p.id,
    projectLabel: p.name,
    bidders: Math.round(between(2, 5)),
    low,
    high,
    budget,
    unit,
    dueAt: daysAgo(-Math.round(between(3, 32))),
    status: (["under_review", "open", "awaiting_bidder"] as const)[i % 3],
  };
});

// ── Accounting summary (the read-only feed) ─────────────────────────────────
// TODO(open-question-4): which accounting system this reads from is undecided.
// Modelled as a read-only mock feed with no write-back.

export const AR_OUTSTANDING = 684_000;
export const AR_OVER_60D = 112_000;
export const AP_DUE_30D = 1_410_000;
export const AP_INVOICE_COUNT = 18;
export const PERIOD_LABEL = "Jul 2026";
export const PERIOD_CLOSED_AT = "2026-08-06";
