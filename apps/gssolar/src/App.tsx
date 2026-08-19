import { useMemo, useState } from "react";
import { Dashboard } from "./screens/Dashboard";
import { Leads } from "./screens/Leads";
import { ProjectsList } from "./screens/ProjectsList";
import { ProjectDetail } from "./screens/ProjectDetail";
import { CostToBuild } from "./screens/CostToBuild";
import { Accounting } from "./screens/Accounting";
import { FinancialProjections } from "./screens/FinancialProjections";
import { PROJECTS } from "./lib/seed";
import { allTriggers } from "./lib/triggers";
import { DEFAULT_SCENARIO, type Scenario } from "./lib/types";

type Tab = "dashboard" | "sales" | "cost" | "accounting" | "projections";
type SalesTab = "leads" | "projects";

const TABS: { id: Tab; label: string }[] = [
  { id: "dashboard", label: "Dashboard" },
  { id: "sales", label: "Sales" },
  { id: "cost", label: "Cost to Build" },
  { id: "accounting", label: "Accounting" },
  { id: "projections", label: "Financial Projections" },
];

export function App() {
  const [tab, setTab] = useState<Tab>("dashboard");
  const [salesTab, setSalesTab] = useState<SalesTab>("projects");
  const [projectId, setProjectId] = useState<string | null>(null);

  // One scenario for the whole product. Changing sun hours on a project detail
  // moves the portfolio model too, because they are the same number — not two
  // copies of it. This is the governing rule of the design, in one useState.
  const [scenario, setScenario] = useState<Scenario>(DEFAULT_SCENARIO);
  const set = <K extends keyof Scenario>(k: K, v: Scenario[K]) => setScenario((s) => ({ ...s, [k]: v }));

  const triggers = useMemo(() => allTriggers(PROJECTS, scenario), [scenario]);
  const overdue = triggers.filter((t) => t.level === "overdue").length;

  const openProject = (id: string) => {
    setProjectId(id);
    setTab("sales");
    setSalesTab("projects");
  };

  return (
    <div className="min-h-screen bg-canvas">
      <header className="bg-navy">
        <div className="mx-auto flex h-12 max-w-[1600px] items-center gap-4 px-5">
          <button
            onClick={() => { setTab("dashboard"); setProjectId(null); }}
            className="flex items-center gap-2.5 text-left"
          >
            <span className="grid h-6 w-6 place-items-center rounded" style={{ background: "linear-gradient(135deg,#3669FF,#82C016)" }}>
              <span className="text-2xs font-black text-white">GS</span>
            </span>
            <span className="leading-tight">
              <span className="block text-xs font-bold text-white">G&amp;S Solar</span>
              <span className="block text-2xs uppercase tracking-[0.09em] text-white/45">Project &amp; Revenue OS</span>
            </span>
          </button>

          <div className="ml-auto flex items-center gap-3">
            <input
              placeholder="Search projects, leads, POs, vendors…"
              className="w-64 rounded border border-white/12 bg-white/8 px-2.5 py-1.5 text-xs text-white placeholder:text-white/40 focus:outline-none focus:ring-1 focus:ring-brand"
            />
            <div className="relative">
              <span className="text-base text-white/60">◔</span>
              {overdue > 0 && (
                <span className="absolute -right-1.5 -top-1 rounded-full bg-neg px-1 text-[9px] font-bold leading-[14px] text-white">
                  {overdue}
                </span>
              )}
            </div>
            <span className="grid h-6 w-6 place-items-center rounded-full bg-white/15 text-2xs font-bold text-white">AG</span>
          </div>
        </div>
      </header>

      <nav className="border-b border-line bg-card">
        <div className="mx-auto flex max-w-[1600px] items-center gap-1 px-5">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => { setTab(t.id); if (t.id !== "sales") setProjectId(null); }}
              className={`border-b-2 px-3 py-2.5 text-xs font-semibold transition-colors ${
                tab === t.id ? "border-brand text-brand" : "border-transparent text-muted hover:text-ink"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>
      </nav>

      {tab === "sales" && (
        <div className="border-b border-line bg-card">
          <div className="mx-auto flex max-w-[1600px] items-center gap-1.5 px-5 py-2">
            {(["leads", "projects"] as SalesTab[]).map((s) => (
              <button
                key={s}
                onClick={() => { setSalesTab(s); setProjectId(null); }}
                className={`rounded-full px-3 py-1 text-xs font-semibold capitalize transition-colors ${
                  salesTab === s ? "bg-brand/10 text-brand" : "text-muted hover:bg-canvas"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      )}

      <main className="mx-auto max-w-[1600px] px-5 py-5">
        {tab === "dashboard" && (
          <Dashboard scenario={scenario} triggers={triggers} onOpenProject={openProject} />
        )}
        {tab === "sales" && salesTab === "leads" && <Leads onOpenProject={openProject} />}
        {tab === "sales" && salesTab === "projects" && projectId === null && (
          <ProjectsList scenario={scenario} onOpenProject={setProjectId} />
        )}
        {tab === "sales" && salesTab === "projects" && projectId !== null && (
          <ProjectDetail
            projectId={projectId}
            scenario={scenario}
            setScenario={set}
            onBack={() => setProjectId(null)}
          />
        )}
        {tab === "cost" && <CostToBuild scenario={scenario} onOpenProject={openProject} />}
        {tab === "accounting" && <Accounting scenario={scenario} />}
        {tab === "projections" && (
          <FinancialProjections scenario={scenario} setScenario={set} onOpenProject={openProject} />
        )}
      </main>

      <footer className="mx-auto max-w-[1600px] px-5 pb-8 pt-2 text-2xs text-muted">
        G&amp;S Solar CRM — front-end prototype. Data is generated from a seed file; every economic
        figure is computed live in <code className="text-[10px]">lib/model.ts</code>, never stored.
      </footer>
    </div>
  );
}
