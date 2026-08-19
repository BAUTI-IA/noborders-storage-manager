import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from "recharts";
import { Btn, Card, DataTable, KpiCard, Pill, type Column, type Tone } from "../components/ui";
import { costPerW, effectiveKwDc, portfolioTotals, rateSheetTotal, year1Noi } from "../lib/model";
import { PROJECTS, RATE_SHEET } from "../lib/seed";
import { PHASE_LABEL, energizationForecast } from "../lib/triggers";
import { ASSET_LABEL, moneyC, num, perW } from "../lib/format";
import type { Project, Scenario, Trigger } from "../lib/types";

const PIP: Record<Trigger["level"], string> = {
  overdue: "var(--red)", at_risk: "var(--amber)", info: "var(--brand)", done: "var(--green)",
};

const PHASE_ORDER: Project["phase"][] = [
  "lead", "qualified_site", "f1_lease", "f2_construction", "f3_maintenance",
];

const PHASE_TONE: Record<Project["phase"], Tone> = {
  lead: "muted", qualified_site: "brand", f1_lease: "brand",
  f2_construction: "warn", f3_maintenance: "pos",
};

const PHASE_COLOR: Record<Project["phase"], string> = {
  lead: "#8FA6C4", qualified_site: "var(--brand)", f1_lease: "var(--brand)",
  f2_construction: "var(--amber)", f3_maintenance: "var(--green)",
};

/** Four segments, one per gate passed, so progress is legible at a glance. */
function PhaseProgress({ p }: { p: Project }) {
  const idx = PHASE_ORDER.indexOf(p.phase);
  return (
    <div className="flex justify-end gap-0.5">
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="h-1.5 w-5 rounded-sm"
          style={{ background: i < idx ? PHASE_COLOR[p.phase] : "var(--line)" }}
        />
      ))}
    </div>
  );
}

export function Dashboard({
  scenario, triggers, onOpenProject,
}: { scenario: Scenario; triggers: Trigger[]; onOpenProject: (id: string) => void }) {
  const t = portfolioTotals(PROJECTS, scenario);

  const underConstruction = PROJECTS.filter((p) => p.phase === "f2_construction");
  const ucMw = underConstruction.reduce((a, p) => a + effectiveKwDc(p), 0) / 1000;
  const pipelineMw = PROJECTS.filter((p) => p.phase !== "f3_maintenance")
    .reduce((a, p) => a + effectiveKwDc(p), 0) / 1000;

  const byPhase = PHASE_ORDER.map((phase) => {
    const rows = PROJECTS.filter((p) => p.phase === phase);
    return {
      phase,
      count: rows.length,
      mw: rows.reduce((a, p) => a + effectiveKwDc(p), 0) / 1000,
    };
  });
  const maxPhaseMw = Math.max(...byPhase.map((b) => b.mw), 1);
  const forecast = energizationForecast(PROJECTS);
  const totalMw = PROJECTS.reduce((a, p) => a + effectiveKwDc(p), 0) / 1000;
  const budgetRate = rateSheetTotal(RATE_SHEET);
  const passing = PROJECTS.length - t.belowBenchmark - t.flagged;

  // Anything with an overdue or at-risk trigger, worst first.
  const attentionIds = new Set(
    triggers.filter((x) => x.level === "overdue" || x.level === "at_risk").map((x) => x.projectId),
  );
  const attention = PROJECTS.filter((p) => attentionIds.has(p.id)).slice(0, 8);

  const cols: Column<Project>[] = [
    {
      key: "name", header: "Project",
      cell: (p) => (
        <div>
          <div className="font-semibold text-ink">{p.name}</div>
          <div className="text-2xs text-muted">{ASSET_LABEL[p.assetType]} · {p.city}, {p.state}</div>
        </div>
      ),
    },
    { key: "phase", header: "Phase", cell: (p) => <Pill tone={PHASE_TONE[p.phase]}>{PHASE_LABEL[p.phase]}</Pill> },
    { key: "size", header: "Size", num: true, cell: (p) => `${(effectiveKwDc(p) / 1000).toFixed(2)} MW` },
    { key: "cost", header: "$/W", num: true, cell: (p) => perW(costPerW(p, scenario.costBasis)) },
    { key: "noi", header: "Yr-1 NOI", num: true, cell: (p) => moneyC(year1Noi(p, scenario)) },
    {
      key: "trigger", header: "Next trigger",
      cell: (p) => {
        const first = triggers.find((x) => x.projectId === p.id && x.level !== "done");
        if (!first) return <span className="text-muted">—</span>;
        return (
          <span className="flex items-center gap-1.5">
            <span className="h-1.5 w-1.5 rounded-full" style={{ background: PIP[first.level] }} />
            <span className="truncate">{first.headline}</span>
          </span>
        );
      },
    },
    { key: "pm", header: "PM", cell: (p) => p.pm },
    { key: "progress", header: "Progress", num: true, cell: (p) => <PhaseProgress p={p} /> },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Good morning, Alec</h1>
          <p className="mt-0.5 text-xs text-muted">
            Portfolio summary · {PROJECTS.length} active projects across NY, NJ and MA ·
            scenario {num(scenario.sunHours)} sun hours, {(scenario.benchmarkIrr * 100).toFixed(0)}% benchmark
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Btn>This quarter</Btn>
          <Btn>All regions</Btn>
          <Btn variant="primary">+ New lead</Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard
          label="Pipeline MW-DC" value={pipelineMw.toFixed(1)}
          sub={`${((pipelineMw / totalMw) * 100).toFixed(0)}% of ${totalMw.toFixed(0)} MW-DC total`}
          progress={pipelineMw / totalMw}
        />
        <KpiCard
          label="Under construction" value={ucMw.toFixed(1)}
          sub={`${underConstruction.length} projects in F2`} progress={ucMw / pipelineMw} progressTone="warn"
        />
        <KpiCard
          label="Projected Year-1 NOI" value={moneyC(t.year1Noi)}
          sub={`FMV ${moneyC(t.fmv)} at ${scenario.fmvMultiple}x`}
          progress={passing / PROJECTS.length} progressTone="pos"
        />
        <KpiCard
          label="Blended cost to build" value={`${perW(t.blendedCostPerW)}/W`}
          sub={`${t.belowBenchmark} below benchmark · ${t.flagged} flagged`}
          subTone={t.belowBenchmark > 0 ? "neg" : "muted"}
          progress={Math.min(1, t.blendedCostPerW / budgetRate)}
          progressTone={t.blendedCostPerW > budgetRate ? "neg" : "pos"}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <Card title="Alerts &amp; Triggers" actions={<span className="text-2xs text-muted">{triggers.length} total</span>}>
          <div className="space-y-2.5">
            {triggers.slice(0, 9).map((tr) => (
              <button
                key={tr.id}
                onClick={() => tr.projectId && onOpenProject(tr.projectId)}
                className="flex w-full gap-2.5 rounded px-1 py-1 text-left hover:bg-canvas"
              >
                <span className="mt-1 h-1.5 w-1.5 shrink-0 rounded-full" style={{ background: PIP[tr.level] }} />
                <span className="min-w-0 flex-1">
                  <span className="block text-xs font-medium leading-snug">{tr.headline}</span>
                  <span className="block truncate text-2xs text-muted">{tr.context}</span>
                </span>
                <span
                  className="shrink-0 text-2xs font-medium"
                  style={{ color: tr.level === "overdue" ? "var(--red)" : "var(--muted)" }}
                >
                  {tr.when}
                </span>
              </button>
            ))}
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Portfolio by phase">
            <div className="space-y-2">
              {byPhase.map((b) => (
                <div key={b.phase} className="flex items-center gap-2.5">
                  <span className="w-28 shrink-0 text-2xs text-muted">{PHASE_LABEL[b.phase]}</span>
                  <span className="relative h-4 flex-1 overflow-hidden rounded-sm bg-ink/5">
                    <span
                      className="absolute inset-y-0 left-0 flex items-center rounded-sm px-1.5 text-[10px] font-bold text-white"
                      style={{ width: `${Math.max(8, (b.mw / maxPhaseMw) * 100)}%`, background: PHASE_COLOR[b.phase] }}
                    >
                      {b.count}
                    </span>
                  </span>
                  <span className="num w-16 shrink-0 text-2xs">{b.mw.toFixed(1)} MW</span>
                </div>
              ))}
            </div>
            <div className="mt-2.5 flex gap-3 text-2xs text-muted">
              <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--brand)" }} /> Development</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--amber)" }} /> Construction</span>
              <span className="flex items-center gap-1"><i className="h-1.5 w-1.5 rounded-full" style={{ background: "var(--green)" }} /> Operating</span>
            </div>
          </Card>

          <Card title="Energization forecast (MW-DC)">
            <div className="h-[130px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={forecast} margin={{ top: 4, right: 4, bottom: 0, left: -22 }}>
                  <XAxis dataKey="quarter" tick={{ fontSize: 9, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "var(--muted)" }} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, borderRadius: 8, border: "1px solid var(--line)" }}
                    formatter={(x) => [`${x} MW-DC`, "Energizing"]}
                  />
                  <Bar dataKey="mw" radius={[2, 2, 0, 0]}>
                    {forecast.map((f, i) => (
                      <Cell key={i} fill={f.forecast ? "#B9CCF7" : "var(--brand)"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <div className="mt-1 text-2xs text-muted">Shaded quarters are forecast.</div>
          </Card>
        </div>
      </div>

      <Card title="Projects needing attention" pad={false} actions={<span className="text-2xs text-muted">{attentionIds.size} flagged</span>}>
        <DataTable columns={cols} rows={attention} keyOf={(p) => p.id} onRowClick={(p) => onOpenProject(p.id)} />
      </Card>
    </div>
  );
}
