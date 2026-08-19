import { useState } from "react";
import { Btn, Card, DataTable, KpiCard, Pill, Row, type Column } from "../components/ui";
import {
  actualsByProject, allocatedPoValueByProject, cashFlows, effectiveKwDc, totalCostToBuild,
  unattributed, unattributedValue,
} from "../lib/model";
import {
  AP_DUE_30D, AP_INVOICE_COUNT, AR_OUTSTANDING, AR_OVER_60D, EXPENSES,
  PERIOD_CLOSED_AT, PERIOD_LABEL, PROJECTS, PURCHASE_ORDERS,
} from "../lib/seed";
import { money, moneyC, pctSigned, shortDate } from "../lib/format";
import type { Expense, Scenario } from "../lib/types";

export function Accounting({ scenario }: { scenario: Scenario }) {
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const queue = unattributed(EXPENSES);
  const byProject = actualsByProject(EXPENSES);
  const name = (id: string) => PROJECTS.find((p) => p.id === id)?.name ?? id;

  const toggle = (id: string) =>
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const cols: Column<Expense>[] = [
    {
      key: "sel", header: "", width: "28px",
      cell: (e) => (
        <input type="checkbox" checked={selected.has(e.id)} onChange={() => toggle(e.id)}
          className="h-3 w-3 accent-[color:var(--brand)]" />
      ),
    },
    { key: "date", header: "Date", cell: (e) => shortDate(e.date) },
    { key: "vendor", header: "Vendor", cell: (e) => <span className="font-semibold">{e.vendor}</span> },
    { key: "memo", header: "Memo", cell: (e) => e.memo },
    { key: "gl", header: "GL account", cell: (e) => <span className="text-muted">{e.glAccount} · {e.glName}</span> },
    { key: "amount", header: "Amount", num: true, cell: (e) => money(e.amount) },
    {
      key: "suggested", header: "Suggested project",
      cell: (e) =>
        e.suggestedProjectId === null ? (
          <Pill tone="muted">No match</Pill>
        ) : (
          <Pill tone={e.confidence! >= 0.85 ? "brand" : "warn"}>
            {name(e.suggestedProjectId)} · {Math.round(e.confidence! * 100)}%
          </Pill>
        ),
    },
  ];

  // Actuals vs budget. A project's actual cost is the allocated share of its
  // purchase orders PLUS the invoices attributed to it — comparing the expense
  // feed alone against a whole project budget would show every project 97% under.
  const poValue = allocatedPoValueByProject(PURCHASE_ORDERS);
  const variance = [...poValue.entries()]
    .map(([id, committed]) => {
      const p = PROJECTS.find((x) => x.id === id)!;
      const actual = committed + (byProject.get(id) ?? 0);
      const budget = totalCostToBuild(p, { ...scenario, costBasis: "budget" });
      return { p, actual, budget, pct: budget > 0 ? actual / budget - 1 : 0 };
    })
    .sort((a, b) => b.actual - a.actual)
    .slice(0, 6);
  const maxVar = Math.max(...variance.map((v) => Math.max(v.actual, v.budget)), 1);

  // Operating NOI month-to-date, derived from the operating fleet's year-1 model.
  const operating = PROJECTS.filter((p) => p.phase === "f3_maintenance");
  const monthly = operating.reduce(
    (acc, p) => {
      const y1 = cashFlows(p, scenario)[0];
      acc.revenue += (y1.revenue - y1.mgmtFee) / 12;
      acc.lease += y1.siteLease / 12;
      acc.om += y1.om / 12;
      acc.insurance += y1.insurance / 12;
      return acc;
    },
    { revenue: 0, lease: 0, om: 0, insurance: 0 },
  );
  const noiMtd = monthly.revenue - monthly.lease - monthly.om - monthly.insurance;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Accounting</h1>
          <p className="mt-0.5 text-xs text-muted">
            Data collection layer · AP/AR feeds actuals back into Cost to Build and Financial Projections
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          {/* TODO(open-question-4): read-only mock feed; no write-back to the ledger. */}
          <Btn>⟳ Sync QuickBooks</Btn>
          <Btn>Chart of accounts</Btn>
          <Btn variant="primary">Close period</Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="AR outstanding" value={moneyC(AR_OUTSTANDING)}
          sub={`${moneyC(AR_OVER_60D)} over 60 days`} subTone="neg" progress={0.55} />
        <KpiCard label="AP due 30d" value={moneyC(AP_DUE_30D)} sub={`${AP_INVOICE_COUNT} invoices`} progress={0.78} progressTone="warn" />
        <KpiCard label="Unattributed expenses" value={String(queue.length)}
          sub={`${moneyC(unattributedValue(EXPENSES))} needs a project code`} subTone="warn"
          progress={queue.length / EXPENSES.length} progressTone="warn" />
        <KpiCard label="Period status" value={PERIOD_LABEL}
          sub={`Reconciled · closed ${shortDate(PERIOD_CLOSED_AT)}`} subTone="pos" progress={1} progressTone="pos" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <Card
          title="Expenses awaiting project attribution"
          pad={false}
          actions={
            <button className="text-2xs font-semibold text-brand disabled:text-muted" disabled={selected.size === 0}>
              Bulk assign{selected.size > 0 ? ` (${selected.size})` : ""}
            </button>
          }
        >
          <DataTable columns={cols} rows={queue.slice(0, 12)} keyOf={(e) => e.id} />
          <div className="border-t border-line px-4 py-2 text-2xs text-muted">
            The feed proposes a project and a confidence. Anything it cannot match shows{" "}
            <b className="text-ink">No match</b> and queues for a human — that is the row that used to
            be reconstructed from memory at the end of the job.
          </div>
        </Card>

        <div className="space-y-4">
          <Card title="Actuals vs budget by project">
            <div className="space-y-2.5">
              {variance.map((v) => (
                <div key={v.p.id} className="flex items-center gap-3">
                  <span className="w-28 shrink-0 truncate text-2xs text-muted">{v.p.name}</span>
                  <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-ink/6">
                    <span className="absolute inset-y-0 left-0 rounded-sm"
                      style={{
                        width: `${(v.actual / maxVar) * 100}%`,
                        background: v.pct > 0.02 ? "var(--red)" : v.pct < -0.02 ? "var(--green)" : "var(--brand)",
                      }} />
                    <span className="absolute inset-y-0 w-[2px] bg-ink/35" style={{ left: `${(v.budget / maxVar) * 100}%` }} />
                  </span>
                  <span className="num w-14 shrink-0 text-2xs font-semibold"
                    style={{ color: v.pct > 0.02 ? "var(--red)" : v.pct < -0.02 ? "var(--green)" : "var(--muted)" }}>
                    {pctSigned(v.pct)}
                  </span>
                </div>
              ))}
            </div>
          </Card>

          <Card title="Revenue recognition">
            <Row label="Subscription revenue MTD" value={money(monthly.revenue)} />
            <Row label="Site lease payments out" value={`-${money(monthly.lease)}`} tone="neg" />
            <Row label="O&M expense MTD" value={`-${money(monthly.om)}`} tone="neg" />
            <Row label="Insurance MTD" value={`-${money(monthly.insurance)}`} tone="neg" />
            <Row label="Operating NOI MTD" value={money(noiMtd)} strong tone="pos" />
            <div className="mt-2 text-2xs text-muted">
              {operating.length} operating projects ·{" "}
              {(operating.reduce((a, p) => a + effectiveKwDc(p), 0) / 1000).toFixed(1)} MW-DC.
              Derived from the same year-1 model the projections use, divided by twelve.
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
