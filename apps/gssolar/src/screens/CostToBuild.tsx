import { Btn, Card, DataTable, KpiCard, Pill, Row, type Column, type Tone } from "../components/ui";
import {
  HARD_COST_LINES, SOFT_COST_LINES, allocatedShare, hardCostRollup, inventoryOnHand,
  openPos, portfolioTotals, rateSheetSoftTotal, rateSheetTotal, wattsDc,
} from "../lib/model";
import { BIDS, PROJECTS, PURCHASE_ORDERS, RATE_SHEET } from "../lib/seed";
import { money, moneyC, num, pctSigned, perW, shortDate } from "../lib/format";
import type { Bid, PurchaseOrder, Scenario } from "../lib/types";

const PO_TONE: Record<PurchaseOrder["status"], Tone> = {
  ordered: "brand", in_transit: "warn", received: "pos",
};
const PO_LABEL: Record<PurchaseOrder["status"], string> = {
  ordered: "Ordered", in_transit: "In transit", received: "Received",
};
const BID_TONE: Record<Bid["status"], Tone> = {
  open: "brand", under_review: "warn", awaiting_bidder: "neg",
};
const BID_LABEL: Record<Bid["status"], string> = {
  open: "Open", under_review: "Under review", awaiting_bidder: "Awaiting bidder",
};

export function CostToBuild({
  scenario, onOpenProject,
}: { scenario: Scenario; onOpenProject: (id: string) => void }) {
  // Only projects being built consume inventory, so they are the denominator
  // that turns dollars of purchase orders into dollars per watt.
  const built = PROJECTS.filter((p) => p.phase === "f2_construction" || p.phase === "f3_maintenance");
  const builtWatts = built.reduce((a, p) => a + wattsDc(p), 0);
  const hard = hardCostRollup(PURCHASE_ORDERS, RATE_SHEET, builtWatts);
  const t = portfolioTotals(PROJECTS, scenario);

  const maxBar = Math.max(...hard.map((h) => Math.max(h.budgetPerW, h.actualPerW)));
  const projectName = (id: string) => PROJECTS.find((p) => p.id === id)?.name ?? id;

  const poCols: Column<PurchaseOrder>[] = [
    { key: "id", header: "PO", cell: (po) => <span className="font-semibold">{po.id}</span> },
    {
      key: "item", header: "Item",
      cell: (po) => (
        <div>
          <div>{po.item}</div>
          {po.arrivesOutOfSequence && <div className="text-2xs text-warn">arriving out of sequence</div>}
        </div>
      ),
    },
    { key: "vendor", header: "Vendor", cell: (po) => po.vendor },
    { key: "qty", header: "Qty", num: true, cell: (po) => num(po.qty) },
    { key: "unit", header: "Unit", num: true, cell: (po) => (po.unitLabel === "lot" ? "lot" : `$${po.unitCost.toLocaleString()}`) },
    { key: "total", header: "Order total", num: true, cell: (po) => money(po.total) },
    {
      key: "alloc", header: "Allocated project",
      cell: (po) => {
        const sum = po.allocations.reduce((a, x) => a + x.pct, 0);
        if (sum === 0) return <Pill tone="muted">Unallocated</Pill>;
        return (
          <span className="flex flex-wrap items-center gap-1">
            {po.allocations.map((a) => (
              <button key={a.projectId} onClick={(e) => { e.stopPropagation(); onOpenProject(a.projectId); }}
                className="text-brand hover:underline">
                {projectName(a.projectId)} <Pill tone="brand">{Math.round(a.pct * 100)}%</Pill>
              </button>
            ))}
            {sum < 0.999 && <Pill tone="muted">Unallocated {Math.round((1 - sum) * 100)}%</Pill>}
          </span>
        );
      },
    },
    { key: "status", header: "Status", num: true, cell: (po) => <Pill tone={PO_TONE[po.status]}>{PO_LABEL[po.status]}</Pill> },
  ];

  const bidCols: Column<Bid>[] = [
    { key: "scope", header: "Scope", cell: (b) => <span className="font-semibold">{b.scope}</span> },
    { key: "project", header: "Project", cell: (b) => b.projectLabel },
    { key: "bidders", header: "Bidders", num: true, cell: (b) => b.bidders },
    { key: "low", header: "Low", num: true, cell: (b) => (b.unit === "$/W" ? `$${b.low.toFixed(3)}/W` : moneyC(b.low)) },
    { key: "high", header: "High", num: true, cell: (b) => (b.unit === "$/W" ? `$${b.high.toFixed(3)}/W` : moneyC(b.high)) },
    { key: "budget", header: "Budget", num: true, cell: (b) => (b.unit === "$/W" ? `$${b.budget.toFixed(3)}/W` : moneyC(b.budget)) },
    { key: "due", header: "Due", num: true, cell: (b) => shortDate(b.dueAt) },
    { key: "status", header: "Status", num: true, cell: (b) => <Pill tone={BID_TONE[b.status]}>{BID_LABEL[b.status]}</Pill> },
  ];

  const outOfSeq = PURCHASE_ORDERS.filter((p) => p.arrivesOutOfSequence && p.status !== "received").length;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <h1 className="text-xl font-semibold tracking-tight">Cost to Build</h1>
          <p className="mt-0.5 text-xs text-muted">
            Hard and soft costs · inventory tracked by order · actual costs attributed to projects as
            orders are allocated
          </p>
        </div>
        <div className="ml-auto flex gap-2">
          <Btn>Master rate sheet</Btn>
          <Btn>Bidding</Btn>
          <Btn variant="primary">+ New purchase order</Btn>
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
        <KpiCard label="Master budget rate" value={`${perW(rateSheetTotal(RATE_SHEET))}/W`}
          sub={`Rate sheet ${RATE_SHEET.version} · ${shortDate(RATE_SHEET.effectiveFrom)}`} progress={0.6} />
        <KpiCard label="Blended actual" value={`${perW(t.blendedCostPerW)}/W`}
          sub={pctSigned(t.blendedCostPerW / rateSheetTotal(RATE_SHEET) - 1) + " vs budget"}
          subTone={t.blendedCostPerW > rateSheetTotal(RATE_SHEET) ? "neg" : "pos"}
          progress={0.68} progressTone={t.blendedCostPerW > rateSheetTotal(RATE_SHEET) ? "neg" : "pos"} />
        <KpiCard label="Inventory on hand" value={moneyC(inventoryOnHand(PURCHASE_ORDERS))}
          sub={`${Math.round(allocatedShare(PURCHASE_ORDERS) * 100)}% allocated to projects`} progress={allocatedShare(PURCHASE_ORDERS)} />
        <KpiCard label="Open POs" value={String(openPos(PURCHASE_ORDERS).length)}
          sub={`${outOfSeq} arriving out of sequence`} subTone={outOfSeq > 0 ? "warn" : "muted"}
          progress={openPos(PURCHASE_ORDERS).length / PURCHASE_ORDERS.length} progressTone="warn" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[3fr_2fr]">
        <Card title="Hard costs — budget vs actual" actions={<span className="text-2xs text-muted">Portfolio · YTD</span>}>
          <div className="space-y-2.5">
            {hard.map((h) => (
              <div key={h.line} className="flex items-center gap-3">
                <span className="w-24 shrink-0 text-2xs text-muted">{h.line}</span>
                <span className="relative h-2.5 flex-1 overflow-hidden rounded-sm bg-ink/6">
                  <span className="absolute inset-y-0 left-0 rounded-sm"
                    style={{
                      width: `${Math.min(100, (h.actualPerW / maxBar) * 100)}%`,
                      background: h.tone === "under" ? "var(--green)" : h.tone === "over" ? "var(--red)" : "var(--brand)",
                    }} />
                  <span className="absolute inset-y-0 w-[2px] bg-ink/35"
                    style={{ left: `${Math.min(100, (h.budgetPerW / maxBar) * 100)}%` }} />
                </span>
                <span className="num w-16 shrink-0 text-2xs">${h.actualPerW.toFixed(3)}/W</span>
                <span className="num w-14 shrink-0 text-2xs font-semibold"
                  style={{ color: h.tone === "under" ? "var(--green)" : h.tone === "over" ? "var(--red)" : "var(--muted)" }}>
                  {pctSigned(h.variancePct)}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap gap-3 text-2xs text-muted">
            <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded-sm" style={{ background: "var(--green)" }} /> Under budget</span>
            <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded-sm" style={{ background: "var(--brand)" }} /> On budget</span>
            <span className="flex items-center gap-1"><i className="h-1.5 w-3 rounded-sm" style={{ background: "var(--red)" }} /> Over budget</span>
            <span className="flex items-center gap-1"><i className="h-2.5 w-[2px] bg-ink/35" /> Budget marker</span>
          </div>
          <div className="mt-3 rounded bg-canvas px-2.5 py-2 text-2xs text-muted">
            Actuals are the <b className="text-ink">allocated</b> share of purchase orders divided by the{" "}
            {(builtWatts / 1_000_000).toFixed(1)} MW-DC under construction or operating. Unallocated
            stock counts as inventory, not as cost.
          </div>
        </Card>

        <Card title="Soft costs">
          {SOFT_COST_LINES.map((k) => (
            <Row key={k} label={k} value={`$${RATE_SHEET.soft[k].toFixed(3)}/W`} />
          ))}
          <Row label="Total soft cost" value={`$${rateSheetSoftTotal(RATE_SHEET).toFixed(3)}/W`} strong />
          <div className="mt-3 text-2xs text-muted">
            {/* TODO(open-question-3): the master rate sheet lives here for now; it moves to
                Settings if it needs formal version control beyond {RATE_SHEET.version}. */}
            Master cost-to-build rate sheet {RATE_SHEET.version}. Hard lines total{" "}
            ${(rateSheetTotal(RATE_SHEET) - rateSheetSoftTotal(RATE_SHEET)).toFixed(3)}/W across{" "}
            {HARD_COST_LINES.length} items.
          </div>
        </Card>
      </div>

      <Card title="Inventory by order" pad={false} actions={<button className="text-2xs font-semibold text-brand">Allocate to project</button>}>
        <DataTable columns={poCols} rows={PURCHASE_ORDERS} keyOf={(po) => po.id} />
      </Card>

      <Card title="Open bids" pad={false}>
        <DataTable columns={bidCols} rows={BIDS} keyOf={(b) => b.id} />
      </Card>
    </div>
  );
}
