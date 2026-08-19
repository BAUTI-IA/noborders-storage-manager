import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from "recharts";
import { Btn, Card, DataTable, KpiCard, Pill, ToggleGroup, type Column } from "../components/ui";
import {
  costPerW, fairMarketValue, irrBySunHours, portfolioCashFlow,
  portfolioTotals, verdict, year1Noi,
} from "../lib/model";
import { PROJECTS } from "../lib/seed";
import { staleInputs } from "../lib/triggers";
import { moneyC, num, pct, perW } from "../lib/format";
import type { Project, Scenario, SubscriberMix, SunHours } from "../lib/types";

export function FinancialProjections({
  scenario, setScenario, onOpenProject,
}: {
  scenario: Scenario;
  setScenario: <K extends keyof Scenario>(k: K, v: Scenario[K]) => void;
  onOpenProject: (id: string) => void;
}) {
  const t = portfolioTotals(PROJECTS, scenario);
  const flow = portfolioCashFlow(PROJECTS, scenario);
  const stale = staleInputs(PROJECTS);

  const chart = flow.map((r) => ({
    year: `Y${r.year}`,
    noi: Math.round(r.noi),
    revenue: Math.round(r.revenue),
  }));

  const rows = [...PROJECTS].sort((a, b) => (irrBySunHours(a, scenario)[1200] ?? 0) - (irrBySunHours(b, scenario)[1200] ?? 0));

  const irrCell = (p: Project, sh: SunHours) => {
    const v = irrBySunHours(p, scenario)[sh];
    if (v === null) return <span className="text-muted">—</span>;
    const below = v < scenario.benchmarkIrr;
    return <span style={{ color: below ? "var(--red)" : "var(--ink)", fontWeight: below ? 700 : 500 }}>{pct(v)}</span>;
  };

  const cols: Column<Project>[] = [
    {
      key: "name", header: "Project",
      cell: (p) => (
        <div>
          <div className="font-semibold text-ink">{p.name}</div>
          <div className="text-2xs text-muted">{p.city}, {p.state}</div>
        </div>
      ),
    },
    { key: "h1100", header: "1,100 hr", num: true, cell: (p) => irrCell(p, 1100) },
    { key: "h1200", header: "1,200 hr", num: true, cell: (p) => irrCell(p, 1200) },
    { key: "h1250", header: "1,250 hr", num: true, cell: (p) => irrCell(p, 1250) },
    { key: "noi", header: "Yr-1 NOI", num: true, cell: (p) => moneyC(year1Noi(p, scenario)) },
    { key: "fmv", header: "FMV", num: true, cell: (p) => moneyC(fairMarketValue(p, scenario)) },
    { key: "cost", header: "$/W cost", num: true, cell: (p) => perW(costPerW(p, scenario.costBasis)) },
    {
      key: "flag", header: "Flag", num: true,
      cell: (p) => {
        const v = verdict(p, scenario);
        return v === "pass" ? <Pill tone="pos">Pass</Pill>
          : v === "flag" ? <Pill tone="warn">?</Pill>
          : <Pill tone="neg">Fail</Pill>;
      },
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Financial Projections</h1>
          <p className="mt-0.5 text-xs text-muted">
            Portfolio model with scenario toggles · replaces the Google Sheets model
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Btn>Save scenario</Btn>
          <Btn>Compare</Btn>
          <Btn variant="primary">Export</Btn>
        </div>
      </div>

      <Card title="Scenario toggles">
        <div className="grid grid-cols-2 gap-x-6 gap-y-4 md:grid-cols-4">
          <ToggleGroup label="Sun hours" value={scenario.sunHours} options={[1100, 1200, 1250] as SunHours[]}
            onChange={(x) => setScenario("sunHours", x)} format={num} />
          <ToggleGroup label="Tax credit" value={scenario.taxCreditPct} options={[0.3, 0.4] as const}
            onChange={(x) => setScenario("taxCreditPct", x)} format={(x) => pct(x, 0)} />
          <ToggleGroup label="Cost to build basis" value={scenario.costBasis} options={["budget", "actuals"] as const}
            onChange={(x) => setScenario("costBasis", x)} format={(x) => (x === "budget" ? "Budget" : "Actuals")} />
          <ToggleGroup label="Subscriber mix" value={scenario.subscriberMix} options={["lmi", "blended", "non_lmi"] as SubscriberMix[]}
            onChange={(x) => setScenario("subscriberMix", x)}
            format={(x) => (x === "lmi" ? "LMI" : x === "blended" ? "Blended" : "Non-LMI")} />
          <ToggleGroup label="Degradation" value={scenario.degradation} options={[0.005, 0.007] as const}
            onChange={(x) => setScenario("degradation", x)} format={(x) => pct(x, 1)} />
          <ToggleGroup label="Elec. rate escalator" value={scenario.electricRateEscalator} options={[0.02, 0.025, 0.03] as const}
            onChange={(x) => setScenario("electricRateEscalator", x)} format={(x) => pct(x, 1)} />
          <ToggleGroup label="FMV multiple" value={scenario.fmvMultiple} options={[15, 17, 19] as const}
            onChange={(x) => setScenario("fmvMultiple", x)} format={(x) => `${x}x`} />
          <ToggleGroup label="Profitability benchmark" value={scenario.benchmarkIrr} options={[0.09, 0.11, 0.13] as const}
            onChange={(x) => setScenario("benchmarkIrr", x)} format={(x) => pct(x, 0)} />
        </div>
      </Card>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Portfolio Yr-1 NOI" value={moneyC(t.year1Noi)} sub={`${t.mwDc.toFixed(1)} MW-DC across ${PROJECTS.length} projects`} />
        <KpiCard label="Fair market value" value={moneyC(t.fmv)}
          sub={`${scenario.fmvMultiple}x Yr-1 NOI · ${perW(t.fmv / (t.mwDc * 1_000_000))}/W`} />
        <KpiCard label="Tax credit value" value={moneyC(t.taxCredit)} sub={`ITC @ ${pct(scenario.taxCreditPct, 0)} of FMV basis`} />
        <KpiCard label="Deals below benchmark" value={String(t.belowBenchmark)}
          sub={`${t.flagged} flagged "?" for committee`} subTone={t.belowBenchmark > 0 ? "neg" : "muted"} />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <Card title="Sensitivity — unlevered IRR by sun hours" pad={false}
          actions={<span className="text-2xs text-muted">Benchmark {pct(scenario.benchmarkIrr, 1)}</span>}>
          <div className="max-h-[420px] overflow-y-auto">
            <DataTable columns={cols} rows={rows} keyOf={(p) => p.id} onRowClick={(p) => onOpenProject(p.id)} />
          </div>
          <div className="border-t border-line px-4 py-2 text-2xs text-muted">
            Cells below the benchmark are red. <b className="text-ink">?</b> means the deal passes at
            1,200 sun hours but fails at 1,100 — a decision, not a calculation.
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="25-year cash flow — portfolio">
            <div className="h-[190px]">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={chart} margin={{ top: 4, right: 4, bottom: 0, left: -8 }}>
                  <CartesianGrid stroke="var(--line)" vertical={false} />
                  <XAxis dataKey="year" tick={{ fontSize: 9, fill: "var(--muted)" }} axisLine={false} tickLine={false} interval={4} />
                  <YAxis tick={{ fontSize: 9, fill: "var(--muted)" }} axisLine={false} tickLine={false}
                    tickFormatter={(x) => `${(x / 1_000_000).toFixed(0)}M`} />
                  <Tooltip contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
                    formatter={(x: number, k) => [moneyC(x), k === "noi" ? "NOI" : "Revenue"]} />
                  <Area type="monotone" dataKey="revenue" stroke="#B9CCF7" fill="#E6EDFD" strokeWidth={1.5} />
                  <Area type="monotone" dataKey="noi" stroke="var(--brand)" fill="rgba(54,105,255,0.18)" strokeWidth={1.5} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 text-2xs text-muted">
              Revenue escalates {pct(scenario.electricRateEscalator, 1)} · production degrades{" "}
              {pct(scenario.degradation, 1)}/yr · O&amp;M and insurance escalate 2%
            </div>
          </Card>

          <Card title="Model inputs needing refresh">
            <div className="space-y-2.5">
              {stale.map((s) => (
                <div key={s.label} className="flex gap-2.5">
                  <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{ background: s.level === "overdue" ? "var(--red)" : s.level === "at_risk" ? "var(--amber)" : "var(--brand)" }} />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium leading-snug">{s.label}</div>
                    <div className="text-2xs leading-snug text-muted">{s.detail}</div>
                  </div>
                  <span className="shrink-0 text-2xs font-medium"
                    style={{ color: s.level === "overdue" ? "var(--red)" : "var(--muted)" }}>
                    {s.dueLabel}
                  </span>
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
