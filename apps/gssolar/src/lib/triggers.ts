// The trigger engine.
//
// Every alert in the product comes from here. Nothing is hand-authored: the
// dashboard renders whatever this returns, and a project's Timeline Triggers
// panel is the same list filtered to that project. That is the only way the
// alert feed can stay honest as the data moves.

import {
  costIsActual, effectiveKwDc, sizeIsProvisional, unleveredIrr, usesDefaults, verdict,
} from "./model";
import { daysSince, TODAY } from "./seed";
import type { Project, Scenario, Trigger, TriggerLevel } from "./types";

/** A VDER rate older than this is no longer trustworthy (spec §6). */
export const VDER_REFRESH_DAYS = 90;

/** How long a project may sit in a phase before it counts as stalled. */
const PHASE_SLA_DAYS: Record<string, number> = {
  qualified_site: 90,
  f1_lease: 120,
  f2_construction: 300,
};

const RANK: Record<TriggerLevel, number> = { overdue: 0, at_risk: 1, info: 2, done: 3 };

const fmtDays = (n: number) => (n === 0 ? "Today" : n === 1 ? "1d" : `${n}d`);

function phaseEnteredAt(p: Project): string | null {
  switch (p.phase) {
    case "f3_maintenance": return p.milestones.maintenanceStartAt;
    case "f2_construction": return p.milestones.constructionStartAt;
    case "f1_lease": return p.milestones.loiSignedAt;
    case "qualified_site": return p.milestones.leadConvertedAt;
    default: return p.createdAt;
  }
}

export const PHASE_LABEL: Record<Project["phase"], string> = {
  lead: "Lead",
  qualified_site: "Qualified Site",
  f1_lease: "F1 · Lease",
  f2_construction: "F2 · Construction",
  f3_maintenance: "F3 · Maintenance",
};

/**
 * Evaluate one project. Order matters only for readability — the caller sorts
 * by rank and then by how far past due each item is.
 */
export function projectTriggers(p: Project, s: Scenario): Trigger[] {
  const out: Trigger[] = [];
  const where = `${p.name} · ${p.city}, ${p.state}`;

  // 1. A stale rate quietly poisons every number downstream of it.
  const vderAge = daysSince(p.assumptions.vderRate.confirmedAt);
  if (vderAge > VDER_REFRESH_DAYS) {
    out.push({
      id: `${p.id}-vder`,
      level: "overdue",
      headline: `VDER rate stale — ${vderAge} days since confirmation`,
      context: `${p.assumptions.vderRate.owner} · ${where} · 90-day refresh trigger fired`,
      when: "Overdue",
      rank: RANK.overdue - vderAge / 10_000,
      projectId: p.id,
    });
  } else if (vderAge > VDER_REFRESH_DAYS - 15) {
    out.push({
      id: `${p.id}-vder-soon`,
      level: "at_risk",
      headline: `VDER rate refresh due in ${VDER_REFRESH_DAYS - vderAge} days`,
      context: `${p.assumptions.vderRate.owner} · ${where}`,
      when: fmtDays(VDER_REFRESH_DAYS - vderAge),
      rank: RANK.at_risk,
      projectId: p.id,
    });
  }

  // 2. Until Avoca confirms the size, the cost model is running on a guess.
  if (sizeIsProvisional(p) && p.phase !== "lead") {
    out.push({
      id: `${p.id}-size`,
      level: p.phase === "f2_construction" ? "overdue" : "at_risk",
      headline: "Final system size pending (Avoca)",
      context: `${where} · blocking cost model lock · running on ${effectiveKwDc(p).toLocaleString()} kW-DC provisional`,
      when: p.phase === "f2_construction" ? "Overdue" : "Pending",
      rank: p.phase === "f2_construction" ? RANK.overdue : RANK.at_risk,
      projectId: p.id,
    });
  }

  // 3. The gate into F2. A project cannot build without it.
  if (!p.utilityInterconnectionCheck && (p.phase === "f1_lease" || p.phase === "qualified_site")) {
    out.push({
      id: `${p.id}-utility`,
      level: "at_risk",
      headline: "Utility interconnection check outstanding",
      context: `${p.pm} · ${where} · required to enter F2`,
      when: "Blocking",
      rank: RANK.at_risk,
      projectId: p.id,
    });
  }

  // 4. The six PM-owned variables gate the exit from F1.
  if (usesDefaults(p) && p.phase !== "lead") {
    out.push({
      id: `${p.id}-vars`,
      level: "at_risk",
      headline: "Project manager variables incomplete",
      context: `${p.pm} · ${where} · economics are running on portfolio defaults`,
      when: "Blocking",
      rank: RANK.at_risk,
      projectId: p.id,
    });
  }

  // 5. A phase that has overrun its service level. Deals used to stall here
  //    unnoticed until somebody happened to ask.
  const sla = PHASE_SLA_DAYS[p.phase];
  const enteredAt = phaseEnteredAt(p);
  if (sla && enteredAt) {
    const age = daysSince(enteredAt);
    if (age > sla) {
      out.push({
        id: `${p.id}-stall`,
        level: "overdue",
        headline: `${PHASE_LABEL[p.phase]} open ${age} days — ${age - sla} past target`,
        context: `${p.pm} · ${where}`,
        when: "Overdue",
        rank: RANK.overdue - age / 10_000,
        projectId: p.id,
      });
    }
  }

  // 6. Profitability that depends on which sun-hour case you believe is a
  //    decision, not a calculation. Surface it rather than counting it as a pass.
  if (verdict(p, s) === "flag") {
    const irrLow = unleveredIrr(p, { ...s, sunHours: 1100 });
    out.push({
      id: `${p.id}-flag`,
      level: "info",
      headline: "Profitability flips between 1,100 and 1,200 sun hours",
      context: `${where} · ${((irrLow ?? 0) * 100).toFixed(1)}% at 1,100 vs ${(s.benchmarkIrr * 100).toFixed(0)}% benchmark`,
      when: "Review",
      rank: RANK.info,
      projectId: p.id,
    });
  }

  // 7. Still pricing off the rate sheet after the invoices started arriving.
  if (p.phase === "f2_construction" && !costIsActual(p, "actuals")) {
    out.push({
      id: `${p.id}-actuals`,
      level: "info",
      headline: "Cost to build still budgeted — no actuals posted",
      context: `${where} · under construction`,
      when: "Open",
      rank: RANK.info,
      projectId: p.id,
    });
  }

  // 8. Something that went right, so the feed is not only bad news.
  if (p.milestones.energizedAt) {
    out.push({
      id: `${p.id}-energized`,
      level: "done",
      headline: `Energized — moved to F3 Maintenance`,
      context: `${where} · ${(effectiveKwDc(p) / 1000).toFixed(2)} MW-DC`,
      when: fmtDays(daysSince(p.milestones.energizedAt)),
      rank: RANK.done + daysSince(p.milestones.energizedAt) / 10_000,
      projectId: p.id,
    });
  } else if (p.milestones.leaseExecutedAt) {
    out.push({
      id: `${p.id}-lease`,
      level: "done",
      headline: "Lease executed — F1 complete",
      context: `${where} · ${p.pm}`,
      when: fmtDays(daysSince(p.milestones.leaseExecutedAt)),
      rank: RANK.done + daysSince(p.milestones.leaseExecutedAt) / 10_000,
      projectId: p.id,
    });
  }

  return out;
}

/**
 * Every trigger across the portfolio, most urgent first — then interleaved by
 * kind within each severity.
 *
 * Sorting on urgency alone let the single loudest rule (stalled phases) fill the
 * whole visible feed, which hides the stale rate and the missing system size
 * underneath it. Round-robin across kinds keeps every rule represented while
 * preserving the severity order that matters.
 */
export function allTriggers(projects: Project[], s: Scenario): Trigger[] {
  const all = projects.flatMap((p) => projectTriggers(p, s)).sort((a, b) => a.rank - b.rank);

  const byLevel = new Map<TriggerLevel, Map<string, Trigger[]>>();
  for (const t of all) {
    const kind = t.id.slice(t.id.indexOf("-") + 1);
    const kinds = byLevel.get(t.level) ?? new Map<string, Trigger[]>();
    kinds.set(kind, [...(kinds.get(kind) ?? []), t]);
    byLevel.set(t.level, kinds);
  }

  const out: Trigger[] = [];
  for (const level of ["overdue", "at_risk", "info", "done"] as TriggerLevel[]) {
    const kinds = byLevel.get(level);
    if (!kinds) continue;
    const queues = [...kinds.values()];
    for (let i = 0; queues.some((q) => q.length > i); i++) {
      for (const q of queues) if (q[i]) out.push(q[i]);
    }
  }
  return out;
}

export const overdueCount = (ts: Trigger[]) => ts.filter((t) => t.level === "overdue").length;

// ── Model inputs needing refresh ────────────────────────────────────────────

export interface StaleInput {
  label: string;
  detail: string;
  owner: string;
  ageDays: number;
  dueLabel: string;
  level: TriggerLevel;
}

/**
 * The portfolio-level view of the same staleness rules: which shared assumption
 * is rotting, who owns it, and how late it is.
 */
export function staleInputs(projects: Project[]): StaleInput[] {
  const worstVder = projects
    .map((p) => ({ p, age: daysSince(p.assumptions.vderRate.confirmedAt) }))
    .sort((a, b) => b.age - a.age)[0];

  const staleVderCount = projects.filter(
    (p) => daysSince(p.assumptions.vderRate.confirmedAt) > VDER_REFRESH_DAYS,
  ).length;

  const worstIncentive = projects
    .map((p) => ({ p, age: daysSince(p.assumptions.nyserdaIncentivePerW.confirmedAt) }))
    .sort((a, b) => b.age - a.age)[0];

  const out: StaleInput[] = [
    {
      label: "VDER rate",
      detail: `${worstVder.p.assumptions.vderRate.owner} · ${worstVder.age} days since confirmation · affects ${staleVderCount} project${staleVderCount === 1 ? "" : "s"}`,
      owner: worstVder.p.assumptions.vderRate.owner,
      ageDays: worstVder.age,
      dueLabel: worstVder.age > VDER_REFRESH_DAYS ? "Overdue" : `${VDER_REFRESH_DAYS - worstVder.age}d`,
      level: worstVder.age > VDER_REFRESH_DAYS ? "overdue" : "at_risk",
    },
    {
      label: "NYSERDA incentive block",
      detail: `${worstIncentive.p.assumptions.nyserdaIncentivePerW.owner} · block step-down expected next quarter`,
      owner: worstIncentive.p.assumptions.nyserdaIncentivePerW.owner,
      ageDays: worstIncentive.age,
      dueLabel: "30d",
      level: "at_risk",
    },
    {
      label: "Master cost to build rate sheet",
      detail: "v4 · next refresh from AP actuals",
      owner: "Kevin Doyle",
      ageDays: daysSince("2026-07-01"),
      dueLabel: "Sep 1",
      level: "info",
    },
  ];
  return out;
}

/** Quarterly energization forecast for the dashboard chart. */
export function energizationForecast(projects: Project[]): { quarter: string; mw: number; forecast: boolean }[] {
  const byQuarter = new Map<string, number>();
  for (const p of projects) {
    const q = p.milestones.energizedAt
      ? quarterOf(p.milestones.energizedAt)
      : p.estEnergizationQuarter;
    byQuarter.set(q, (byQuarter.get(q) ?? 0) + effectiveKwDc(p) / 1000);
  }
  const nowQ = quarterOf(TODAY.toISOString().slice(0, 10));
  return [...byQuarter.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([quarter, mw]) => ({ quarter, mw: Number(mw.toFixed(2)), forecast: quarter > nowQ }));
}

function quarterOf(iso: string): string {
  const d = new Date(iso + (iso.length === 10 ? "T12:00:00Z" : ""));
  return `${d.getUTCFullYear()}-Q${Math.floor(d.getUTCMonth() / 3) + 1}`;
}
