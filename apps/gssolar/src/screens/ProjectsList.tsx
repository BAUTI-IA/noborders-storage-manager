import { useMemo, useState } from "react";
import { Btn, Card, DataTable, FilterChips, Pill, type Column, type Tone } from "../components/ui";
import { costPerW, effectiveKwDc, sizeIsProvisional, unleveredIrr, verdict, year1Noi } from "../lib/model";
import { PROJECTS } from "../lib/seed";
import { PHASE_LABEL } from "../lib/triggers";
import { ASSET_LABEL, moneyC, pct, perW } from "../lib/format";
import type { Project, Scenario, StateCode } from "../lib/types";

const PHASE_TONE: Record<Project["phase"], Tone> = {
  lead: "muted", qualified_site: "brand", f1_lease: "brand",
  f2_construction: "warn", f3_maintenance: "pos",
};

type PhaseFilter = Project["phase"] | "all";
type StateFilter = StateCode | "all";

export function ProjectsList({
  scenario, onOpenProject,
}: { scenario: Scenario; onOpenProject: (id: string) => void }) {
  const [phase, setPhase] = useState<PhaseFilter>("all");
  const [state, setState] = useState<StateFilter>("all");

  const rows = useMemo(
    () =>
      PROJECTS.filter(
        (p) => (phase === "all" || p.phase === phase) && (state === "all" || p.state === state),
      ),
    [phase, state],
  );

  const counts = PROJECTS.reduce<Record<string, number>>((a, p) => {
    a[p.phase] = (a[p.phase] ?? 0) + 1;
    a.all = PROJECTS.length;
    return a;
  }, {});

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
    {
      key: "size", header: "Size", num: true,
      cell: (p) => (
        <span>
          {(effectiveKwDc(p) / 1000).toFixed(2)} MW
          {sizeIsProvisional(p) && <span className="ml-1 text-warn">·prov</span>}
        </span>
      ),
    },
    { key: "cost", header: "$/W", num: true, cell: (p) => perW(costPerW(p, scenario.costBasis)) },
    { key: "noi", header: "Yr-1 NOI", num: true, cell: (p) => moneyC(year1Noi(p, scenario)) },
    {
      key: "irr", header: "Unlevered IRR", num: true,
      cell: (p) => {
        const v = unleveredIrr(p, scenario);
        const below = v !== null && v < scenario.benchmarkIrr;
        return <span style={{ color: below ? "var(--red)" : undefined, fontWeight: below ? 700 : 500 }}>{v !== null ? pct(v) : "—"}</span>;
      },
    },
    {
      key: "flag", header: "Flag", num: true,
      cell: (p) => {
        const v = verdict(p, scenario);
        return v === "pass" ? <Pill tone="pos">Pass</Pill> : v === "flag" ? <Pill tone="warn">?</Pill> : <Pill tone="neg">Fail</Pill>;
      },
    },
    { key: "pm", header: "PM", cell: (p) => p.pm },
    { key: "eta", header: "Energization", num: true, cell: (p) => p.milestones.energizedAt ? "Energized" : p.estEnergizationQuarter },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Projects</h1>
          <p className="mt-0.5 text-xs text-muted">
            {PROJECTS.length} projects · a project carries its Variables, its Timeline and its Cost Tab
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Btn>Export to Sheets</Btn>
          <Btn variant="primary">+ New project</Btn>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <FilterChips
          value={phase} onChange={setPhase} counts={counts}
          options={[
            { id: "all", label: "All" }, { id: "lead", label: "Lead" },
            { id: "qualified_site", label: "Qualified Site" }, { id: "f1_lease", label: "F1 · Lease" },
            { id: "f2_construction", label: "F2 · Construction" }, { id: "f3_maintenance", label: "F3 · Maintenance" },
          ]}
        />
        <span className="h-4 w-px bg-line" />
        <FilterChips
          value={state} onChange={setState}
          options={[{ id: "all", label: "All states" }, { id: "NY", label: "NY" }, { id: "NJ", label: "NJ" }, { id: "MA", label: "MA" }]}
        />
      </div>

      <Card pad={false} title={`${rows.length} projects`}>
        <DataTable columns={cols} rows={rows} keyOf={(p) => p.id} onRowClick={(p) => onOpenProject(p.id)}
          empty="No projects match these filters." />
      </Card>
    </div>
  );
}
