import { useMemo, useState } from "react";
import { Btn, Card, DataTable, FilterChips, Pill, type Column, type Tone } from "../components/ui";
import { LEADS, PMS, daysSince } from "../lib/seed";
import { ASSET_LABEL, num } from "../lib/format";
import type { Lead, LeadStatus, StateCode } from "../lib/types";

const STATUS_TONE: Record<LeadStatus, Tone> = {
  new: "brand", contacted: "warn", site_qualified: "pos", converted: "muted",
};
const STATUS_LABEL: Record<LeadStatus, string> = {
  new: "New", contacted: "Contacted", site_qualified: "Site Qualified", converted: "Converted",
};

type StatusFilter = LeadStatus | "all";
type StateFilter = StateCode | "all";
type TypeFilter = Lead["assetType"] | "all";

export function Leads({ onOpenProject }: { onOpenProject: (id: string) => void }) {
  const [status, setStatus] = useState<StatusFilter>("all");
  const [state, setState] = useState<StateFilter>("all");
  const [type, setType] = useState<TypeFilter>("all");
  const [converting, setConverting] = useState<Lead | null>(null);
  const [pm, setPm] = useState(PMS[0]);

  const rows = useMemo(
    () =>
      LEADS.filter(
        (l) =>
          (status === "all" || l.status === status) &&
          (state === "all" || l.state === state) &&
          (type === "all" || l.assetType === type),
      ),
    [status, state, type],
  );

  const counts = LEADS.reduce<Record<string, number>>((a, l) => {
    a[l.status] = (a[l.status] ?? 0) + 1;
    a.all = LEADS.length;
    return a;
  }, {});

  const cols: Column<Lead>[] = [
    {
      key: "company", header: "Company / contact",
      cell: (l) => (
        <div>
          <div className="font-semibold text-ink">{l.companyName}</div>
          <div className="text-2xs text-muted">{l.contactName} · {l.contactTitle}</div>
        </div>
      ),
    },
    { key: "site", header: "Site", cell: (l) => `${l.city}, ${l.state}` },
    { key: "type", header: "Type", cell: (l) => <Pill tone="brand">{ASSET_LABEL[l.assetType]}</Pill> },
    { key: "size", header: "Est. size", num: true, cell: (l) => `${(l.estSizeKwDc / 1000).toFixed(1)} MW` },
    { key: "detail", header: "Roof / land", cell: (l) => <span className="text-muted">{l.roofOrLand}</span> },
    {
      key: "status", header: "Status",
      cell: (l) =>
        l.status === "converted" && l.convertedProjectId ? (
          <button onClick={(e) => { e.stopPropagation(); onOpenProject(l.convertedProjectId!); }}>
            <Pill tone="pos">Converted → Project</Pill>
          </button>
        ) : (
          <Pill tone={STATUS_TONE[l.status]}>{STATUS_LABEL[l.status]}</Pill>
        ),
    },
    { key: "source", header: "Source", cell: (l) => <span className="text-muted">{l.source}</span> },
    { key: "owner", header: "Owner", cell: (l) => l.owner },
    {
      key: "touch", header: "Last touch", num: true,
      cell: (l) => {
        const d = daysSince(l.lastTouchAt);
        return <span style={{ color: d > 30 ? "var(--red)" : undefined }}>{d === 0 ? "Today" : `${d}d ago`}</span>;
      },
    },
    {
      key: "act", header: "", num: true,
      cell: (l) =>
        l.status === "converted" ? null : (
          <button onClick={(e) => { e.stopPropagation(); setConverting(l); }}
            className="text-2xs font-semibold text-brand hover:underline">
            Convert
          </button>
        ),
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Leads</h1>
          <p className="mt-0.5 text-xs text-muted">
            Contact and site information · synced with HubSpot · a lead becomes a Project once it is qualified
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {/* TODO(open-question-5): one-way lead import from HubSpot; no write-back. */}
          <Btn>⟳ Sync HubSpot</Btn>
          <Btn>Import CSV</Btn>
          <Btn variant="primary">+ New lead</Btn>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-4">
        <FilterChips
          value={status} onChange={setStatus} counts={counts}
          options={[
            { id: "all", label: "All" }, { id: "new", label: "New" },
            { id: "contacted", label: "Contacted" }, { id: "site_qualified", label: "Site Qualified" },
            { id: "converted", label: "Converted" },
          ]}
        />
        <span className="h-4 w-px bg-line" />
        <FilterChips
          value={state} onChange={setState}
          options={[{ id: "all", label: "All states" }, { id: "NY", label: "NY" }, { id: "NJ", label: "NJ" }, { id: "MA", label: "MA" }]}
        />
        <span className="h-4 w-px bg-line" />
        <FilterChips
          value={type} onChange={setType}
          options={[
            { id: "all", label: "All types" }, { id: "rooftop", label: "Rooftop" },
            { id: "ground_mount", label: "Ground-mount" }, { id: "carport", label: "Carport" },
            { id: "community", label: "Community" },
          ]}
        />
      </div>

      <Card pad={false} title={`${rows.length} leads`}>
        <DataTable columns={cols} rows={rows} keyOf={(l) => l.id} empty="No leads match these filters." />
      </Card>

      {converting && (
        <div className="fixed inset-0 z-50 grid place-items-center bg-black/40 p-4" onClick={() => setConverting(null)}>
          <div className="w-full max-w-md rounded border border-line bg-card" onClick={(e) => e.stopPropagation()}>
            <header className="border-b border-line px-4 py-3">
              <h3 className="text-base font-semibold">Convert lead to project</h3>
              <p className="mt-0.5 text-2xs text-muted">{converting.companyName} · {converting.city}, {converting.state}</p>
            </header>
            <div className="space-y-3 p-4">
              <div>
                <label className="mb-1 block text-2xs font-semibold uppercase tracking-[0.06em] text-muted">
                  Assign project manager
                </label>
                <select value={pm} onChange={(e) => setPm(e.target.value)}
                  className="w-full rounded border border-line bg-card px-2 py-1.5 text-xs">
                  {PMS.map((x) => <option key={x}>{x}</option>)}
                </select>
              </div>
              <div className="rounded bg-canvas px-3 py-2.5 text-2xs text-muted">
                <div className="mb-1 font-semibold text-ink">The PM then owns six variables:</div>
                Address · Company Name · Type of Project · Site Lease $/W-DC · Site Lease Escalator ·
                Upfront Payment.
                <div className="mt-1.5">
                  Until they are supplied the project's economics run on portfolio defaults and it
                  cannot advance past F1.
                </div>
              </div>
              <div className="text-2xs text-muted">
                Estimated {num(converting.estSizeKwDc)} kW-DC · {ASSET_LABEL[converting.assetType]} ·{" "}
                {converting.roofOrLand}
              </div>
            </div>
            <footer className="flex justify-end gap-2 border-t border-line px-4 py-3">
              <Btn onClick={() => setConverting(null)}>Cancel</Btn>
              <Btn variant="primary" onClick={() => setConverting(null)}>Create project</Btn>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
