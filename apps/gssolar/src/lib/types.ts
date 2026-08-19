// Domain types for the G&S Solar Project & Revenue OS.
//
// Governing rule from the spec: a number is entered once, by the person who owns
// it. So every record below stores INPUTS only. Year-1 NOI, fair market value,
// the tax credit and IRR are never stored — they are derived in lib/model.ts and
// every screen reads them from there.

export type StateCode = "NY" | "NJ" | "MA";

export type AssetType = "rooftop" | "ground_mount" | "carport" | "community";

/** The gates a project passes through. A project lives here for 18-36 months. */
export type Phase =
  | "lead"
  | "qualified_site"
  | "f1_lease"
  | "f2_construction"
  | "f3_maintenance";

export type LeadStatus = "new" | "contacted" | "site_qualified" | "converted";

export type LeadSource =
  | "HubSpot form"
  | "Referral"
  | "Outbound"
  | "NYSERDA event"
  | "Partner";

/** A value someone owns, with the date they last confirmed it. */
export interface Owned<T> {
  value: T;
  owner: string;
  confirmedAt: string; // ISO date
}

/**
 * System size is confirmed three times by three parties. All three are retained:
 * the final one locks the cost model, and until it lands the project is flagged.
 */
export interface SystemSizes {
  helioscopeKwDc: Owned<number>;
  structuralKwDc: Owned<number> | null;
  finalKwDc: Owned<number> | null; // Avoca, external
}

/** Per-project inputs. Anything absent falls back to the portfolio defaults. */
export interface ProjectAssumptions {
  vderRate: Owned<number>; // $/kWh — value stack; 90-day refresh trigger
  nyserdaIncentivePerW: Owned<number>; // $/W, block step-downs
  subscriberDiscountLmi: number; // fraction, e.g. 0.10
  subscriberDiscountNonLmi: number; // fraction, e.g. 0.075
  subscriptionMgmtFeePerKwh: number; // $/kWh
  omPerKwDc: number; // $/kW-DC/yr
  insurancePerKwDc: number; // $/kW-DC/yr
  costToBuildBudgetPerW: number; // $/W from the master rate sheet
  costToBuildActualPerW: number | null; // $/W from accounting, once it exists
  lmiSharePct: number; // 0..1 — this project's subscriber mix
}

export interface Project {
  id: string;
  name: string;
  companyName: string;
  address: string;
  city: string;
  state: StateCode;
  assetType: AssetType;
  pm: string;
  createdAt: string;

  phase: Phase;
  /** Milestone dates. Null means "not reached yet". */
  milestones: {
    leadConvertedAt: string | null;
    loiSignedAt: string | null;
    leaseExecutedAt: string | null;
    constructionStartAt: string | null;
    energizedAt: string | null;
    maintenanceStartAt: string | null;
  };
  /** Estimated energization, used for the forecast chart. ISO "YYYY-Qn". */
  estEnergizationQuarter: string;
  /** Required to enter F2. */
  utilityInterconnectionCheck: boolean;

  sizes: SystemSizes;

  // Group A — Project Manager owned, required to advance past F1.
  siteLeasePerWDc: number | null;
  siteLeaseEscalator: number | null;
  upfrontPayment: number | null;

  assumptions: ProjectAssumptions;
  roofOrLand: string;
  leadId: string | null; // converted leads stay linked for history
}

export interface Lead {
  id: string;
  companyName: string;
  contactName: string;
  contactTitle: string;
  city: string;
  state: StateCode;
  assetType: AssetType;
  estSizeKwDc: number;
  roofOrLand: string;
  status: LeadStatus;
  source: LeadSource;
  owner: string;
  lastTouchAt: string;
  convertedProjectId: string | null;
}

export type PoStatus = "ordered" | "in_transit" | "received";

export interface PoAllocation {
  projectId: string;
  pct: number; // 0..1 of the order's value
}

export interface PurchaseOrder {
  id: string; // "PO-2261"
  item: string;
  costLine: HardCostLine;
  vendor: string;
  qty: number;
  unitLabel: string;
  unitCost: number;
  total: number;
  allocations: PoAllocation[]; // may sum to < 1: the remainder is unallocated
  status: PoStatus;
  arrivesOutOfSequence: boolean;
}

/** Fixed hard-cost taxonomy — these eight lines are the rate sheet. */
export type HardCostLine =
  | "Wiring"
  | "Switchgear"
  | "Inverters"
  | "Modules"
  | "Electric Labor"
  | "Racking"
  | "Block"
  | "Slip Sheets";

export type SoftCostLine =
  | "Engineering & Design"
  | "Permitting & AHJ"
  | "Interconnection Fees"
  | "Legal (LOI/Lease)"
  | "Project Management"
  | "Commissioning & Testing"
  | "Contingency";

/** Versioned master cost-to-build rate sheet: budget $/W per line. */
export interface RateSheet {
  version: string;
  effectiveFrom: string;
  hard: Record<HardCostLine, number>;
  soft: Record<SoftCostLine, number>;
}

export interface Expense {
  id: string;
  date: string;
  vendor: string;
  memo: string;
  glAccount: string;
  glName: string;
  amount: number;
  /** Null when the feed cannot match it — those queue for a human. */
  suggestedProjectId: string | null;
  confidence: number | null; // 0..1
  attributedProjectId: string | null;
}

export type BidStatus = "open" | "under_review" | "awaiting_bidder";

export interface Bid {
  id: string;
  scope: string;
  projectId: string | null;
  projectLabel: string;
  bidders: number;
  low: number;
  high: number;
  budget: number;
  unit: "$/W" | "$";
  dueAt: string;
  status: BidStatus;
}

// ── Scenario toggles ────────────────────────────────────────────────────────
// These drive Financial Projections and the live recalculation on project detail.

export type SunHours = 1100 | 1200 | 1250;
export type SubscriberMix = "lmi" | "blended" | "non_lmi";
export type CostBasis = "budget" | "actuals";

export interface Scenario {
  sunHours: SunHours;
  taxCreditPct: 0.3 | 0.4;
  costBasis: CostBasis;
  subscriberMix: SubscriberMix;
  degradation: 0.005 | 0.007;
  electricRateEscalator: 0.02 | 0.025 | 0.03;
  fmvMultiple: 15 | 17 | 19;
  benchmarkIrr: 0.09 | 0.11 | 0.13;
}

export const DEFAULT_SCENARIO: Scenario = {
  sunHours: 1200,
  taxCreditPct: 0.3,
  costBasis: "actuals",
  subscriberMix: "blended",
  degradation: 0.005,
  electricRateEscalator: 0.025,
  fmvMultiple: 17,
  benchmarkIrr: 0.11,
};

// ── Triggers ────────────────────────────────────────────────────────────────

export type TriggerLevel = "overdue" | "at_risk" | "info" | "done";

export interface Trigger {
  id: string;
  level: TriggerLevel;
  headline: string;
  /** Names the owner and the projects affected. */
  context: string;
  /** Relative time shown on the right of the row, e.g. "Overdue", "5d". */
  when: string;
  /** Sort key: lower comes first. */
  rank: number;
  projectId: string | null;
}
