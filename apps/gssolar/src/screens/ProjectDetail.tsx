import { Btn, Card, OwnedValue, Pill, Row, ToggleGroup, type Tone } from "../components/ui";
import {
  PORTFOLIO_DEFAULTS, costIsActual, costPerW, effectiveKwDc, fairMarketValue, fmvPerW,
  irrBySunHours, sizeIsProvisional, taxCredit, totalCostToBuild, unleveredIrr, verdict,
  wattsDc, year1Noi,
} from "../lib/model";
import { PROJECTS, daysSince } from "../lib/seed";
import { PHASE_LABEL, VDER_REFRESH_DAYS, projectTriggers } from "../lib/triggers";
import { ASSET_LABEL, longDate, money, moneyC, num, pct, perW, shortDate } from "../lib/format";
import type { Project, Scenario, SunHours } from "../lib/types";

const PHASE_TONE: Record<Project["phase"], Tone> = {
  lead: "muted", qualified_site: "brand", f1_lease: "brand",
  f2_construction: "warn", f3_maintenance: "pos",
};

/** The six milestones the whole 18-36 month process is measured against. */
function steps(p: Project) {
  return [
    { label: "Lead", at: p.milestones.leadConvertedAt, note: p.phase === "lead" ? "Qualifying" : "Converted" },
    { label: "LOI Signed", at: p.milestones.loiSignedAt, note: "Countersigned" },
    { label: "F1 · Lease", at: p.milestones.leaseExecutedAt, note: "Executed" },
    { label: "F2 · Construction", at: p.milestones.constructionStartAt, note: "Started" },
    { label: "Energization", at: p.milestones.energizedAt, note: p.milestones.energizedAt ? "Energized" : `Est. ${p.estEnergizationQuarter}` },
    { label: "F3 · Maintenance", at: p.milestones.maintenanceStartAt, note: "O&M + monitoring" },
  ];
}

function Stepper({ p }: { p: Project }) {
  const s = steps(p);
  const currentIdx = s.findIndex((x) => x.at === null);
  return (
    <div className="flex items-start">
      {s.map((step, i) => {
        const done = step.at !== null;
        const current = i === currentIdx;
        const colour = done ? "var(--green)" : current ? "var(--brand)" : "var(--line)";
        return (
          <div key={step.label} className="relative flex min-w-0 flex-1 flex-col items-center">
            {i > 0 && (
              <span
                className="absolute right-1/2 top-[7px] h-[2px] w-full"
                style={{ background: done || current ? "var(--green)" : "var(--line)" }}
              />
            )}
            <span
              className="relative z-10 h-4 w-4 rounded-full border-[3px] bg-card"
              style={{ borderColor: colour }}
            />
            <div className="mt-1.5 px-1 text-center">
              <div className={`text-2xs font-semibold ${current ? "text-brand" : done ? "text-ink" : "text-muted"}`}>
                {step.label}
              </div>
              <div className="text-[10px] text-muted">
                {done ? shortDate(step.at) : step.note}
                {current && step.at === null && i > 0 && s[i - 1].at
                  ? ` · ${daysSince(s[i - 1].at!)}d open`
                  : ""}
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

export function ProjectDetail({
  projectId, scenario, setScenario, onBack,
}: {
  projectId: string;
  scenario: Scenario;
  setScenario: <K extends keyof Scenario>(k: K, v: Scenario[K]) => void;
  onBack: () => void;
}) {
  const p = PROJECTS.find((x) => x.id === projectId);
  if (!p) return <div className="text-xs text-muted">Project not found.</div>;

  const kw = effectiveKwDc(p);
  const noi = year1Noi(p, scenario);
  const fmv = fairMarketValue(p, scenario);
  const irrs = irrBySunHours(p, scenario);
  const irr = unleveredIrr(p, scenario);
  const v = verdict(p, scenario);
  const triggers = projectTriggers(p, scenario);
  const vderAge = daysSince(p.assumptions.vderRate.confirmedAt);
  const vderStale = vderAge > VDER_REFRESH_DAYS;
  const usingActuals = costIsActual(p, scenario.costBasis);

  const verdictTone: Tone = v === "pass" ? "pos" : v === "flag" ? "warn" : "neg";
  const verdictText =
    v === "pass" ? `Pass — clears ${pct(scenario.benchmarkIrr, 0)} at 1,100 hr`
    : v === "flag" ? `? — passes at 1,200 but fails at 1,100`
    : `Below benchmark at every sun-hour case`;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="text-xl font-semibold tracking-tight">{p.name}</h1>
            <Pill tone={PHASE_TONE[p.phase]}>{PHASE_LABEL[p.phase]}</Pill>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            {ASSET_LABEL[p.assetType]} · {p.city}, {p.state} · PM {p.pm} · Created {longDate(p.createdAt)}
            {p.leadId && <> · from lead {p.leadId}</>}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Btn onClick={onBack}>◀ All projects</Btn>
          <Btn>Export</Btn>
          <Btn variant="primary">Advance phase</Btn>
        </div>
      </div>

      <Card><Stepper p={p} /></Card>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        {/* ── Group A + B: what the project manager owns ───────────────────── */}
        <Card title="Solar Variables — Project Manager" actions={<button className="text-2xs font-semibold text-brand">Edit · Version history</button>}>
          <OwnedValue label="Address" value={p.address} owner="PM owned" />
          <OwnedValue label="Company Name" value={p.companyName} owner="PM owned" />
          <OwnedValue label="Type of Project" value={ASSET_LABEL[p.assetType]} owner="PM owned" />
          <OwnedValue
            label="Site Lease $/W-DC"
            value={p.siteLeasePerWDc !== null ? `$${p.siteLeasePerWDc.toFixed(3)}` : `$${PORTFOLIO_DEFAULTS.siteLeasePerWDc.toFixed(3)}`}
            owner={p.siteLeasePerWDc !== null ? "PM owned" : "Portfolio default"}
            tone={p.siteLeasePerWDc === null ? "warn" : undefined}
            flag={p.siteLeasePerWDc === null ? <Pill tone="warn">ASSUMED</Pill> : undefined}
          />
          <OwnedValue
            label="Site Lease Escalator"
            value={pct(p.siteLeaseEscalator ?? PORTFOLIO_DEFAULTS.siteLeaseEscalator)}
            owner={p.siteLeaseEscalator !== null ? "PM owned" : "Portfolio default"}
            tone={p.siteLeaseEscalator === null ? "warn" : undefined}
          />
          <OwnedValue
            label="Upfront Payment"
            value={money(p.upfrontPayment ?? PORTFOLIO_DEFAULTS.upfrontPayment)}
            owner={p.upfrontPayment !== null ? "PM owned" : "Portfolio default"}
            tone={p.upfrontPayment === null ? "warn" : undefined}
          />

          <div className="mt-4 mb-1.5 text-2xs font-bold uppercase tracking-[0.07em] text-muted">
            System size — three confirmations
          </div>
          <OwnedValue
            label="Helioscope"
            value={`${num(p.sizes.helioscopeKwDc.value)} kW`}
            owner={p.sizes.helioscopeKwDc.owner}
            meta={shortDate(p.sizes.helioscopeKwDc.confirmedAt)}
          />
          <OwnedValue
            label="Structural / panel claw"
            value={p.sizes.structuralKwDc ? `${num(p.sizes.structuralKwDc.value)} kW` : "—"}
            owner={p.sizes.structuralKwDc?.owner ?? "Not started"}
            meta={p.sizes.structuralKwDc ? shortDate(p.sizes.structuralKwDc.confirmedAt) : undefined}
          />
          <OwnedValue
            label="Final system size"
            value={p.sizes.finalKwDc ? `${num(p.sizes.finalKwDc.value)} kW` : "Pending"}
            owner={p.sizes.finalKwDc?.owner ?? "Avoca (external)"}
            meta={p.sizes.finalKwDc ? shortDate(p.sizes.finalKwDc.confirmedAt) : "locks the cost model"}
            tone={p.sizes.finalKwDc ? "pos" : "warn"}
            flag={sizeIsProvisional(p) ? <Pill tone="warn">PENDING</Pill> : undefined}
          />
          <div className="mt-2 rounded bg-canvas px-2.5 py-2 text-2xs text-muted">
            Every calculation on this page uses <b className="text-ink">{num(kw)} kW-DC</b>
            {sizeIsProvisional(p) ? " — provisional, pending Avoca." : " — final."}
          </div>
        </Card>

        {/* ── Group C: the model assumptions, live ─────────────────────────── */}
        <Card title="Solar Variables — Model">
          <div className="space-y-3 pb-3">
            <ToggleGroup
              label="Sun hours"
              value={scenario.sunHours}
              options={[1100, 1200, 1250] as SunHours[]}
              onChange={(x) => setScenario("sunHours", x)}
              format={(x) => num(x)}
            />
            <ToggleGroup
              label="Tax credit"
              value={scenario.taxCreditPct}
              options={[0.3, 0.4] as const}
              onChange={(x) => setScenario("taxCreditPct", x)}
              format={(x) => pct(x, 0)}
            />
            <ToggleGroup
              label="FMV multiple"
              value={scenario.fmvMultiple}
              options={[15, 17, 19] as const}
              onChange={(x) => setScenario("fmvMultiple", x)}
              format={(x) => `${x}x`}
            />
            <ToggleGroup
              label="Profitability benchmark"
              value={scenario.benchmarkIrr}
              options={[0.09, 0.11, 0.13] as const}
              onChange={(x) => setScenario("benchmarkIrr", x)}
              format={(x) => pct(x, 0)}
            />
          </div>

          <OwnedValue
            label="VDER rate"
            value={`$${p.assumptions.vderRate.value.toFixed(4)}`}
            owner={p.assumptions.vderRate.owner}
            meta={`${vderAge}d since confirmation · ${VDER_REFRESH_DAYS}-day refresh`}
            tone={vderStale ? "neg" : undefined}
            flag={vderStale ? <Pill tone="neg">{vderAge}d</Pill> : undefined}
          />
          <OwnedValue label="Degradation" value={pct(scenario.degradation, 2)} owner="Scenario" meta="per year" />
          <OwnedValue label="Electric rate escalator" value={pct(scenario.electricRateEscalator)} owner="Scenario" />
          <OwnedValue
            label="NYSERDA incentive"
            value={`$${p.assumptions.nyserdaIncentivePerW.value.toFixed(3)}/W`}
            owner={p.assumptions.nyserdaIncentivePerW.owner}
            meta={`block · ${shortDate(p.assumptions.nyserdaIncentivePerW.confirmedAt)}`}
          />
          <OwnedValue
            label="Subscriber discount"
            value={`${pct(p.assumptions.subscriberDiscountLmi, 1)} / ${pct(p.assumptions.subscriberDiscountNonLmi, 1)}`}
            owner="LMI / non-LMI"
            meta={`mix ${pct(p.assumptions.lmiSharePct, 0)} LMI · scenario: ${scenario.subscriberMix.replace("_", "-")}`}
          />
          <OwnedValue label="Subscription mgmt fee" value={`$${p.assumptions.subscriptionMgmtFeePerKwh.toFixed(3)}/kWh`} owner="Contracted" />
          <OwnedValue label="O&M" value={`$${p.assumptions.omPerKwDc.toFixed(2)}/kW-DC`} owner="escalator 2%" />
          <OwnedValue label="Insurance" value={`$${p.assumptions.insurancePerKwDc.toFixed(2)}/kW-DC`} owner="escalator 2%" />
          <OwnedValue
            label="Cost to build rate"
            value={`${perW(costPerW(p, scenario.costBasis))}/W`}
            owner={usingActuals ? "Actuals from AP" : "Master rate sheet v4"}
            meta={usingActuals ? `budget was ${perW(p.assumptions.costToBuildBudgetPerW)}/W` : "no actuals posted yet"}
            tone={usingActuals ? "pos" : undefined}
            flag={usingActuals ? undefined : <Pill tone="muted">BUDGET</Pill>}
          />
        </Card>

        {/* ── Derived: never stored, always computed ───────────────────────── */}
        <div className="space-y-4">
          <Card title="Deal Economics">
            <Row label="Year-1 NOI" value={money(noi)} />
            <Row label={`Fair Market Value (${scenario.fmvMultiple}x)`} value={money(fmv)} />
            <Row label="FMV per watt" value={`${perW(fmvPerW(p, scenario))}/W`} />
            <Row label="ITC basis (FMV x size)" value={money(fmv)} />
            <Row label={`Tax credit @ ${pct(scenario.taxCreditPct, 0)}`} value={money(taxCredit(p, scenario))} />
            <Row label="Total cost to build" value={money(totalCostToBuild(p, scenario))} />
            <Row label="Unlevered IRR" value={irr !== null ? pct(irr) : "—"} strong tone={verdictTone} />
            <div className="mt-2 rounded px-2.5 py-2 text-2xs" style={{ background: "var(--bg)" }}>
              <div className="font-semibold" style={{ color: v === "pass" ? "var(--green)" : v === "flag" ? "var(--amber)" : "var(--red)" }}>
                {verdictText}
              </div>
              <div className="mt-1 flex gap-3 text-muted">
                {([1100, 1200, 1250] as SunHours[]).map((sh) => (
                  <span key={sh} className="tabular-nums">
                    {num(sh)} hr:{" "}
                    <b style={{ color: (irrs[sh] ?? 0) < scenario.benchmarkIrr ? "var(--red)" : "var(--ink)" }}>
                      {irrs[sh] !== null ? pct(irrs[sh]!) : "—"}
                    </b>
                  </span>
                ))}
              </div>
            </div>
          </Card>

          <Card title="Timeline Triggers">
            {triggers.length === 0 && <div className="py-3 text-center text-xs text-muted">Nothing outstanding.</div>}
            <div className="space-y-2.5">
              {triggers.map((t) => (
                <div key={t.id} className="flex gap-2.5">
                  <span
                    className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: `var(--${t.level === "overdue" ? "red" : t.level === "at_risk" ? "amber" : t.level === "done" ? "green" : "brand"})` }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium leading-snug">{t.headline}</div>
                    <div className="text-2xs leading-snug text-muted">{t.context}</div>
                  </div>
                  <span className="shrink-0 text-2xs text-muted">{t.when}</span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Cost Tab — this project">
            {/* TODO(open-question-2): the per-project cost tab and the portfolio
                Cost to Build screen are the same records under two views. */}
            <Row label="System size" value={`${(kw / 1000).toFixed(2)} MW-DC`} />
            <Row label="Cost basis" value={usingActuals ? "Actuals (AP)" : "Budget (rate sheet v4)"} />
            <Row label="Rate" value={`${perW(costPerW(p, scenario.costBasis))}/W`} />
            <Row label="Total" value={moneyC(totalCostToBuild(p, scenario))} strong />
            <div className="mt-1.5 text-2xs text-muted">
              {wattsDc(p).toLocaleString()} W-DC at the rate above. Actuals arrive from Accounting as
              invoices are attributed to this project.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
