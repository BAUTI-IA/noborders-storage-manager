// Field Expenses — gastos operativos por driver/truck/trip/job y ajustes de pago.
// Lo que NO pasa por el banco (cash del driver) vive solo acá; lo que sí pasa se
// cruza contra el extracto en Bancos → Conciliación.
// UI only: state, Supabase calls and handlers live in App.jsx (same split as analytics.jsx).
// Shared Btn/Modal components arrive as props to avoid a circular import with App.jsx.
import { useMemo, useState, useEffect, useCallback } from "react";
import { tr } from "./i18n.js";
import { numv, monthOf, driverCashReconciliation, payWeekStart, addDaysISO } from "./analyticsData.js";
import { selectAll } from "./db.js";
import {
  EXPENSE_CATEGORIES, FIELD_CAT_BY_BANK, expenseCatMeta,
  mergeFieldExpenses, fieldExpenseTotals,
} from "./expensesData.js";

// Re-exported so App.jsx keeps importing the catalog from one place.
export { EXPENSE_CATEGORIES, FIELD_CAT_BY_BANK, expenseCatMeta };

// Form/constant definitions live here (exported) so App.jsx state and this UI share one copy.
export const EMPTY_EXPENSE = {
  expense_date:"", category:"fuel", amount:"", vendor:"", driver_id:"", truck_id:"", trip_id:"",
  job_number:"", paid_from:"bank", bank_account:"", status:"pending",
  gallons:"", odometer:"", fuel_state:"", receipt_url:"", notes:"",
};
export const PAID_FROM_OPTIONS = [
  { v:"bank", l:"Bank account", icon:"🏦" },
  { v:"driver_cash", l:"Cash del driver (de cobros)", icon:"💵" },
  { v:"company_card", l:"Company card", icon:"💳" },
  { v:"other", l:"Other", icon:"❔" },
];
export const EXPENSE_STATUS = {
  pending:  { l:"Pending", bg:"#FEF3C7", text:"#92760B" },
  approved: { l:"Approved", bg:"#EAF3DE", text:"#3B6D11" },
  rejected: { l:"Rejected", bg:"#FCEBEB", text:"#A32D2D" },
};
export const EMPTY_ADJUSTMENT = { driver_id:"", adj_date:"", kind:"deduction", amount:"", reason:"", job_number:"" };
export const ADJUSTMENT_KINDS = [
  { v:"deduction", l:"Descuento (fuck-up, daño, faltante…)", icon:"🔻" },
  { v:"bonus", l:"Compensación / bono", icon:"💚" },
];
export const paidFromMeta = (v) => PAID_FROM_OPTIONS.find(p => p.v === v) || PAID_FROM_OPTIONS[0];

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };
const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
const fieldLabel = { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4, display:"block" };
const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();

export function ExpenseStatusBadge({ status }) {
  const c = EXPENSE_STATUS[status] || EXPENSE_STATUS.pending;
  return <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>{c.l}</span>;
}
export function ExpenseCatChip({ category }) {
  const c = expenseCatMeta(category);
  return <span style={{ fontSize:11, fontWeight:600, whiteSpace:"nowrap" }}>{c.icon} {c.l}</span>;
}

function Tile({ label, value, color = "#111", sub }) {
  return (
    <div style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
      <div style={{ fontSize:11, color:"#aaa", fontWeight:500 }}>{label}</div>
      <div style={{ fontSize:20, fontWeight:800, color, marginTop:3 }}>{value}</div>
      {sub && <div style={{ fontSize:10.5, color:"#bbb", marginTop:2 }}>{sub}</div>}
    </div>
  );
}

function Field({ label, children }) {
  return <div style={{ marginBottom:10 }}><span style={fieldLabel}>{label}</span>{children}</div>;
}

// Drag/click receipt upload box (same UX as the payments photo box).
function ReceiptBox({ url, onFile, uploading, onView }) {
  const isPdf = (url || "").toLowerCase().includes(".pdf");
  return (
    <div>
      <span style={fieldLabel}>Receipt (foto / PDF)</span>
      <div onClick={() => document.getElementById("expense-receipt-input")?.click()}
        style={{ border:"2px dashed #ddd", borderRadius:10, padding: url ? "8px" : "14px", textAlign:"center", background:"#fafafa", cursor:"pointer", fontSize:12, color:"#888" }}>
        {uploading ? "Uploading…" : url ? (
          <div style={{ display:"flex", alignItems:"center", gap:10, justifyContent:"center" }}>
            {isPdf ? <span style={{ fontSize:28 }}>📄</span> : <img src={url} alt="" style={{ maxHeight:56, maxWidth:90, borderRadius:6, objectFit:"cover" }} onClick={e => { e.stopPropagation(); onView(url); }} />}
            <span style={{ color:"#185FA5" }}>Replace file</span>
          </div>
        ) : "Tap to upload receipt (jpg, png, heic, pdf)"}
      </div>
      <input id="expense-receipt-input" type="file" accept="image/*,.heic,application/pdf" style={{ display:"none" }}
        onChange={e => { const f = e.target.files[0]; if (f) onFile(f); e.target.value = ""; }} />
    </div>
  );
}

export function ExpensesPage(props) {
  const {
    missing, onShowSetup, expenses, driversList, trucksList, trips, jobs,
    payAccounts, payments, paymentsMissing, adjustments,
    can, today,
    form, setForm, showModal, setShowModal, editingId, saving, uploading,
    onEdit, onSave, onDelete, onSetStatus, onSettle, onUploadReceipt,
    adjForm, setAdjForm, showAdjModal, setShowAdjModal, adjSaving,
    onAddAdjustment, onSaveAdjustment, onDeleteAdjustment,
    setPayPhotoView, Btn, Modal, supabase,
  } = props;

  const [tab, setTab] = useState("gastos");
  const [fDriver, setFDriver] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fPaidFrom, setFPaidFrom] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fSearch, setFSearch] = useState("");
  const [fSource, setFSource] = useState("");
  const [weekStart, setWeekStart] = useState(() => payWeekStart(today())); // Wednesday that opens the pay week

  // Field costs that came off the statement. Fetched here rather than in
  // App.jsx so the whole app doesn't pay for it — this page is the only reader,
  // and it only mounts when somebody opens it. Outflows only; the merge drops
  // the ones that are not field categories.
  const [bankTxns, setBankTxns] = useState([]);
  const [bankCats, setBankCats] = useState([]);
  const [bankLoading, setBankLoading] = useState(true);
  const loadBank = useCallback(async () => {
    if (!supabase) { setBankLoading(false); return; }
    setBankLoading(true);
    const [{ data: txns }, { data: cats }] = await Promise.all([
      selectAll(() => supabase.from("bank_transactions").select("*").eq("direction", "out")
        .in("category", Object.keys(FIELD_CAT_BY_BANK))
        .order("txn_date", { ascending: false }).order("id", { ascending: false }), { tiebreak: null }),
      supabase.from("bank_categories").select("*"),
    ]);
    setBankTxns(txns || []);
    setBankCats(cats || []);
    setBankLoading(false);
  }, [supabase]);
  useEffect(() => { loadBank(); }, [loadBank]);

  const canEdit = can("expenses", "edit");
  const canCreate = can("expenses", "create");

  const driverById = useMemo(() => Object.fromEntries(driversList.map(d => [d.id, d])), [driversList]);
  const truckById = useMemo(() => Object.fromEntries(trucksList.map(t => [t.id, t])), [trucksList]);
  const tripById = useMemo(() => Object.fromEntries(trips.map(t => [t.id, t])), [trips]);
  const jobNumbers = useMemo(() => [...new Set(jobs.map(j => (j.job_number || "").trim()).filter(Boolean))].sort(), [jobs]);
  const activeDrivers = useMemo(() => driversList.filter(d => d.active !== false), [driversList]);

  // Every field cost in one list: what was typed here plus the statement lines
  // nobody typed. A bank-paid expense and its statement line are one cost and
  // collapse into a single row — see mergeFieldExpenses.
  const merged = useMemo(
    () => mergeFieldExpenses({ expenses, bankTxns, categories: bankCats }),
    [expenses, bankTxns, bankCats]);

  const filtered = useMemo(() => merged.filter(r => {
    if (fSource && r.source !== fSource) return false;
    if (fDriver && String(r.driverId) !== String(fDriver)) return false;
    if (fCategory && r.category !== fCategory) return false;
    if (fPaidFrom && r.paidFrom !== fPaidFrom) return false;
    if (fStatus && r.status !== fStatus) return false;
    if (fFrom && r.date < fFrom) return false;
    if (fTo && r.date > fTo) return false;
    if (fSearch) {
      const q = fSearch.toLowerCase();
      const hay = [r.vendor, r.notes, r.jobNumber, driverById[r.driverId]?.name].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [merged, fSource, fDriver, fCategory, fPaidFrom, fStatus, fFrom, fTo, fSearch, driverById]);

  const totals = useMemo(() => fieldExpenseTotals(filtered), [filtered]);

  // Tiles: current-month spend (approved), pending approvals, unsettled driver cash.
  const tiles = useMemo(() => {
    const curMonth = monthOf(today());
    let monthTotal = 0, pendingCount = 0, pendingTotal = 0, unsettledCash = 0;
    const byCat = {};
    for (const e of expenses) {
      const amt = numv(e.amount);
      const st = e.status || "pending";
      if (st === "pending") { pendingCount += 1; pendingTotal += amt; }
      if (st !== "approved") continue;
      if (monthOf(e.expense_date || (e.created_at || "").slice(0, 10)) === curMonth) {
        monthTotal += amt;
        byCat[e.category || "other"] = (byCat[e.category || "other"] || 0) + amt;
      }
      if (e.paid_from === "driver_cash" && !e.settled) unsettledCash += amt;
    }
    const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
    return { monthTotal, pendingCount, pendingTotal, unsettledCash, topCat };
  }, [expenses, today]);

  // Cash-on-hand hint inside the modal when paying from driver cash.
  const cashHint = useMemo(() => {
    if (paymentsMissing || form.paid_from !== "driver_cash" || !form.driver_id) return null;
    const d = driverById[Number(form.driver_id)];
    if (!d) return null;
    return driverCashReconciliation({ payments, expenses, driverName: d.name, driverId: d.id });
  }, [paymentsMissing, form.paid_from, form.driver_id, driverById, payments, expenses]);

  // Adjustments are filed against the pay week (Wed → Tue), same as driver pay.
  const weekEnd = addDaysISO(weekStart, 6);
  const weekAdjustments = useMemo(
    () => adjustments.filter(a => { const d = a.adj_date || (a.created_at || "").slice(0, 10); return d >= weekStart && d <= weekEnd; }),
    [adjustments, weekStart, weekEnd]
  );
  const DOW_ES = ["Dom", "Lun", "Mar", "Mié", "Jue", "Vie", "Sáb"];
  const dayHeader = (iso) => `${DOW_ES[new Date(iso + "T00:00:00").getDay()]} ${Number(iso.slice(8))}`;
  const fmtShort = (iso) => iso ? `${Number(iso.slice(8))}/${Number(iso.slice(5, 7))}` : "";

  const setF = (patch) => setForm(f => ({ ...f, ...patch }));

  return (
    <>
      <datalist id="expense-jobs-list">{jobNumbers.map(n => <option key={n} value={n} />)}</datalist>
      {missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>For Field Expenses, run the setup SQL once in Supabase.</span>
          <button onClick={onShowSetup} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
        </div>
      )}

      <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14, flexWrap:"wrap" }}>
        {[["gastos","💸 Expenses"],["ajustes","⚖️ Driver adjustments"]].map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={{ fontSize:13, padding:"6px 13px", borderRadius:7, cursor:"pointer", border:"none", background: tab===v?"#fff":"none", color: tab===v?"#111":"#888", fontWeight: tab===v?600:400, boxShadow: tab===v?"0 1px 4px rgba(0,0,0,0.08)":"none" }}>{l}</button>
        ))}
      </div>

      {/* ── Tab: Gastos ── */}
      {tab === "gastos" && !missing && (
        <>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))", gap:10, marginBottom:16 }}>
            <Tile label="Gastado este mes (aprobado)" value={fmt$(tiles.monthTotal)} sub={tiles.topCat ? `Top: ${expenseCatMeta(tiles.topCat[0]).icon} ${expenseCatMeta(tiles.topCat[0]).l} ${fmt$(tiles.topCat[1])}` : null} />
            <Tile label="Pendientes de aprobar" value={tiles.pendingCount} color={tiles.pendingCount > 0 ? "#C2410C" : "#1A8A4E"} sub={tiles.pendingCount > 0 ? fmt$(tiles.pendingTotal) : null} />
            <Tile label="Cash de drivers sin rendir" value={fmt$(tiles.unsettledCash)} color={tiles.unsettledCash > 0 ? "#E24B4A" : "#1A8A4E"} sub="gastos aprobados pagados con cash de cobros, sin settle" />
            <Tile label="In this filter" value={fmt$(totals.total)} sub={`${totals.count} · ${fmt$(totals.manual)} ${tr("loaded here", "cargados acá")} · ${fmt$(totals.fromBank)} ${tr("from the bank", "del banco")}`} />
            <Tile label="Unattributed" value={fmt$(totals.unattributed)} color={totals.unattributed > 0 ? "#C2410C" : "#1A8A4E"} sub={`${totals.unattributedCount} ${tr("with no driver, truck, trip or job", "sin driver, truck, trip ni job")}`} />
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap", alignItems:"center" }}>
            <input style={{ ...inp, width:"auto", minWidth:200, flex:1, maxWidth:300 }} value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="🔎 Vendor, job #, notes…" />
            <select value={fDriver} onChange={e => setFDriver(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
              <option value="">All drivers</option>
              {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={fCategory} onChange={e => setFCategory(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
              <option value="">All categories</option>
              {EXPENSE_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
            </select>
            <select value={fSource} onChange={e => setFSource(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
              <option value="">Loaded anywhere</option>
              <option value="manual">✍️ Loaded here</option>
              <option value="bank">🏦 From the bank</option>
            </select>
            <select value={fPaidFrom} onChange={e => setFPaidFrom(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
              <option value="">All payment sources</option>
              {PAID_FROM_OPTIONS.map(p => <option key={p.v} value={p.v}>{p.icon} {p.l}</option>)}
            </select>
            <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ ...inp, width:"auto", minWidth:110 }}>
              <option value="">All statuses</option>
              {Object.entries(EXPENSE_STATUS).map(([v, c]) => <option key={v} value={v}>{c.l}</option>)}
            </select>
            <input style={{ ...inp, width:"auto" }} type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} title="Desde" />
            <span style={{ fontSize:12, color:"#bbb" }}>→</span>
            <input style={{ ...inp, width:"auto" }} type="date" value={fTo} onChange={e => setFTo(e.target.value)} title="Hasta" />
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
                <thead><tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Fecha","Category","Vendor","Monto","Driver","Fuente","Links","Recibo","Estado",""].map((h, i) => <th key={i} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={10} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>
                      {bankLoading ? "Loading…" : "No field expenses in this filter. Add one with “+ Expense”."}
                    </td></tr>
                  ) : filtered.map(r => {
                    const e = r.raw;
                    const fromBank = r.source === "bank";
                    const pf = paidFromMeta(r.paidFrom);
                    const trip = r.tripId ? tripById[r.tripId] : null;
                    return (
                      <tr key={r.key} style={{ borderBottom:"1px solid #fafafa", background: fromBank ? "#fcfdff" : undefined }}>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>{r.date || "—"}</td>
                        <td style={td}>
                          <ExpenseCatChip category={r.category} />
                          {!fromBank && r.category === "fuel" && numv(e.gallons) > 0 && <span style={{ fontSize:10.5, color:"#888" }}> · {numv(e.gallons)} gal{r.amount > 0 ? ` · $${(r.amount / numv(e.gallons)).toFixed(2)}/gal` : ""}</span>}
                          {fromBank && <div style={{ fontSize:10, color:"#aaa" }}>{r.bankCategory}</div>}
                        </td>
                        <td style={td}>{r.vendor || "—"}</td>
                        <td style={{ ...td, fontWeight:700, whiteSpace:"nowrap" }}>{fmt$(r.amount)}</td>
                        <td style={td}>{r.driverId ? (driverById[r.driverId]?.name || `#${r.driverId}`) : <span style={{ color:"#ddd" }}>—</span>}</td>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>
                          {fromBank ? (
                            <span style={{ fontSize:11.5, color:"#185FA5", fontWeight:600 }}>🏦 From the bank</span>
                          ) : (
                            <>
                              {pf.icon} <span style={{ fontSize:11.5 }}>{r.paidFrom === "bank" ? (e.bank_account || pf.l) : pf.l}</span>
                              {r.reconciled && <span title="Matched to a statement line" style={{ fontSize:10, fontWeight:700, color:"#3B6D11", marginLeft:5 }}>✓ in bank</span>}
                              {r.paidFrom === "driver_cash" && (e.settled
                                ? <span style={{ fontSize:10, fontWeight:700, color:"#185FA5", marginLeft:5 }}>rendido {e.settled_date || ""}</span>
                                : <span style={{ fontSize:10, fontWeight:700, color:"#C2410C", marginLeft:5 }}>unsettled</span>)}
                            </>
                          )}
                        </td>
                        <td style={{ ...td, fontSize:11.5, color:"#666", whiteSpace:"nowrap" }}>
                          {[trip && (trip.trip_number || `trip #${trip.id}`), r.jobNumber, r.truckId && (truckById[r.truckId]?.name || `truck #${r.truckId}`)].filter(Boolean).join(" · ")
                            || (fromBank ? <span style={{ color:"#C2410C", fontSize:11 }}>unattributed</span> : "—")}
                        </td>
                        <td style={td}>
                          {!fromBank && e.receipt_url ? (
                            (e.receipt_url || "").toLowerCase().includes(".pdf")
                              ? <a href={e.receipt_url} target="_blank" rel="noreferrer" style={{ fontSize:16, textDecoration:"none" }}>📄</a>
                              : <img src={e.receipt_url} alt="recibo" onClick={() => setPayPhotoView(e.receipt_url)} style={{ height:28, width:40, objectFit:"cover", borderRadius:4, cursor:"pointer", border:"1px solid #eee" }} />
                          ) : <span style={{ color:"#ddd" }}>—</span>}
                        </td>
                        <td style={td}>{fromBank
                          ? <span style={{ fontSize:10.5, color:"#888" }}>{r.status}</span>
                          : <ExpenseStatusBadge status={r.status} />}</td>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>
                          {fromBank ? (
                            <span style={{ fontSize:10.5, color:"#bbb" }}>edit in Banks</span>
                          ) : (
                            <>
                              {canEdit && r.status === "pending" && (
                                <>
                                  <button onClick={() => onSetStatus(e, "approved")} title="Aprobar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:15 }}>✅</button>
                                  <button onClick={() => onSetStatus(e, "rejected")} title="Rechazar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:15 }}>❌</button>
                                </>
                              )}
                              {canEdit && r.paidFrom === "driver_cash" && r.status === "approved" && !e.settled && (
                                <button onClick={() => onSettle(e)} title="Mark settled (the driver handed over the rest of the cash)" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>🤝</button>
                              )}
                              {canEdit && <button onClick={() => onEdit(e)} title="Editar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>✏️</button>}
                              {canEdit && <button onClick={() => onDelete(e)} title="Borrar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>🗑️</button>}
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Tab: Semana de pago (miércoles → martes) ── */}
      {/* ── Tab: Driver adjustments ── */}
      {tab === "ajustes" && !missing && (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12, flexWrap:"wrap" }}>
            <Btn onClick={() => setWeekStart(addDaysISO(weekStart, -7))}>←</Btn>
            <span style={{ fontWeight:700, fontSize:14, textAlign:"center" }}>Wed {fmtShort(weekStart)} → Tue {fmtShort(weekEnd)}</span>
            <Btn onClick={() => setWeekStart(addDaysISO(weekStart, 7))}>→</Btn>
            {weekStart !== payWeekStart(today()) && <Btn onClick={() => setWeekStart(payWeekStart(today()))}>Hoy</Btn>}
            {canCreate && <Btn onClick={() => onAddAdjustment()} style={{ marginLeft:"auto" }}>+ Adjustment (fuck-up / bonus)</Btn>}
          </div>
          <div style={{ fontSize:11.5, color:"#999", marginBottom:10 }}>
            Deductions and compensations for the week. They feed the driver P&L in Analytics and what is owed to each driver in AP / AR.
          </div>

          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:16 }}>
            {weekAdjustments.length === 0 ? <div style={{ fontSize:12.5, color:"#bbb" }}>No adjustments this week.</div> : weekAdjustments.map(a => {
              const k = ADJUSTMENT_KINDS.find(x => x.v === a.kind) || ADJUSTMENT_KINDS[0];
              return (
                <div key={a.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid #f4f4f4", fontSize:12.5, flexWrap:"wrap" }}>
                  <span>{k.icon}</span>
                  <span style={{ color:"#888", whiteSpace:"nowrap" }}>{a.adj_date || (a.created_at || "").slice(0, 10)}</span>
                  <b>{driverById[a.driver_id]?.name || `#${a.driver_id}`}</b>
                  <span style={{ color:"#666" }}>{a.reason || k.l}</span>
                  {a.job_number && <span style={{ fontFamily:"monospace", color:"#666" }}>{a.job_number}</span>}
                  <span style={{ flex:1 }} />
                  <b style={{ color: a.kind === "bonus" ? "#1A8A4E" : "#E24B4A" }}>{a.kind === "bonus" ? "+" : "−"}{fmt$(numv(a.amount))}</b>
                  {canEdit && <button onClick={() => onDeleteAdjustment(a)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:12 }}>🗑️</button>}
                </div>
              );
            })}
          </div>
        </>
      )}

      {/* ── Modal: gasto ── */}
      {showModal && (
        <Modal title={editingId ? "Edit expense" : "New expense"} onClose={() => setShowModal(false)}
          footer={<><Btn onClick={() => setShowModal(false)}>Cancel</Btn><Btn primary disabled={saving || uploading} onClick={onSave}>{saving ? "Saving…" : "Save expense"}</Btn></>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
            <Field label="Fecha"><input type="date" style={inp} value={form.expense_date} onChange={e => setF({ expense_date: e.target.value })} /></Field>
            <Field label="Category">
              <select style={inp} value={form.category} onChange={e => setF({ category: e.target.value })}>
                {EXPENSE_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
              </select>
            </Field>
            <Field label="Monto ($)"><input type="number" min="0" step="0.01" style={inp} value={form.amount} onChange={e => setF({ amount: e.target.value })} placeholder="0.00" /></Field>
            <Field label="Vendor / lugar"><input style={inp} value={form.vendor} onChange={e => setF({ vendor: e.target.value })} placeholder="Pilot, Home Depot, Motel 6…" /></Field>
            <Field label="Driver">
              <select style={inp} value={form.driver_id} onChange={e => setF({ driver_id: e.target.value })}>
                <option value="">(no driver)</option>
                {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Truck">
              <select style={inp} value={form.truck_id} onChange={e => setF({ truck_id: e.target.value })}>
                <option value="">(no truck)</option>
                {trucksList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Trip">
              <select style={inp} value={form.trip_id} onChange={e => setF({ trip_id: e.target.value })}>
                <option value="">(no trip)</option>
                {trips.map(t => <option key={t.id} value={t.id}>{t.trip_number || `#${t.id}`}</option>)}
              </select>
            </Field>
            <Field label="Job #">
              <input style={inp} list="expense-jobs-list" value={form.job_number} onChange={e => setF({ job_number: e.target.value })} placeholder="(optional)" />
            </Field>
            <Field label="Pagado con">
              <select style={inp} value={form.paid_from} onChange={e => setF({ paid_from: e.target.value })}>
                {PAID_FROM_OPTIONS.map(p => <option key={p.v} value={p.v}>{p.icon} {p.l}</option>)}
              </select>
            </Field>
            {form.paid_from === "bank" && (
              <Field label="Cuenta">
                <select style={inp} value={form.bank_account} onChange={e => setF({ bank_account: e.target.value })}>
                  <option value="">(choose account)</option>
                  {payAccounts.map(a => <option key={a.id} value={a.name}>{a.name}</option>)}
                </select>
              </Field>
            )}
            {canEdit && (
              <Field label="Estado">
                <select style={inp} value={form.status} onChange={e => setF({ status: e.target.value })}>
                  {Object.entries(EXPENSE_STATUS).map(([v, c]) => <option key={v} value={v}>{c.l}</option>)}
                </select>
              </Field>
            )}
          </div>

          {form.paid_from === "driver_cash" && (
            <div style={{ background:"#FFF6E8", border:"1px solid #F4DDB0", borderRadius:10, padding:"9px 12px", fontSize:12, color:"#854F0B", marginBottom:10 }}>
              💵 This expense comes out of the cash the driver collected from clients: approving it lowers what that driver should hand over.
              {cashHint && (
                <div style={{ marginTop:4, fontWeight:600 }}>
                  Holds {fmt$(cashHint.held)} − unsettled expenses {fmt$(cashHint.approvedCashExpenses)} = should hand over <span style={{ color: cashHint.expectedOnHand < 0 ? "#E24B4A" : "#3B6D11" }}>{fmt$(cashHint.expectedOnHand)}</span>
                </div>
              )}
            </div>
          )}

          {form.category === "fuel" && (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0 14px", background:"#fafafa", borderRadius:10, padding:"10px 12px 2px", marginBottom:10 }}>
              <Field label="Galones"><input type="number" min="0" step="0.01" style={inp} value={form.gallons} onChange={e => setF({ gallons: e.target.value })} /></Field>
              <Field label="Odómetro (mi)"><input type="number" min="0" style={inp} value={form.odometer} onChange={e => setF({ odometer: e.target.value })} /></Field>
              <Field label="Estado (IFTA)"><input style={inp} maxLength={2} value={form.fuel_state} onChange={e => setF({ fuel_state: e.target.value.toUpperCase() })} placeholder="FL" /></Field>
              {numv(form.gallons) > 0 && numv(form.amount) > 0 && (
                <div style={{ gridColumn:"1 / -1", fontSize:11.5, color:"#888", paddingBottom:8 }}>≈ ${(numv(form.amount) / numv(form.gallons)).toFixed(2)}/gallon</div>
              )}
            </div>
          )}

          <ReceiptBox url={form.receipt_url} onFile={onUploadReceipt} uploading={uploading} onView={setPayPhotoView} />

          <div style={{ marginTop:10 }}>
            <Field label="Notas"><textarea style={{ ...inp, minHeight:52, resize:"vertical" }} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {/* ── Modal: ajuste de pago (fuck-up / compensación) ── */}
      {showAdjModal && (
        <Modal title="Driver pay adjustment" onClose={() => setShowAdjModal(false)}
          footer={<><Btn onClick={() => setShowAdjModal(false)}>Cancel</Btn><Btn primary disabled={adjSaving} onClick={onSaveAdjustment}>{adjSaving ? "Saving…" : "Save"}</Btn></>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
            <Field label="Driver">
              <select style={inp} value={adjForm.driver_id} onChange={e => setAdjForm(f => ({ ...f, driver_id: e.target.value }))}>
                <option value="">(choose)</option>
                {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Fecha"><input type="date" style={inp} value={adjForm.adj_date} onChange={e => setAdjForm(f => ({ ...f, adj_date: e.target.value }))} /></Field>
            <Field label="Tipo">
              <select style={inp} value={adjForm.kind} onChange={e => setAdjForm(f => ({ ...f, kind: e.target.value }))}>
                {ADJUSTMENT_KINDS.map(k => <option key={k.v} value={k.v}>{k.icon} {k.l}</option>)}
              </select>
            </Field>
            <Field label="Monto ($, positivo)"><input type="number" min="0" step="0.01" style={inp} value={adjForm.amount} onChange={e => setAdjForm(f => ({ ...f, amount: e.target.value }))} /></Field>
            <Field label="Job # (opcional)">
              <input style={inp} list="expense-jobs-list" value={adjForm.job_number} onChange={e => setAdjForm(f => ({ ...f, job_number: e.target.value }))} />
            </Field>
          </div>
          <Field label="Motivo"><input style={inp} value={adjForm.reason} onChange={e => setAdjForm(f => ({ ...f, reason: e.target.value }))} placeholder="Broke a client's mirror, was late to the pickup, bonus for a long trip…" /></Field>
          <div style={{ background:"#fafafa", borderRadius:10, padding:"8px 12px", fontSize:11.5, color:"#888" }}>
            The deduction lowers the week's pay (and the driver cost in the P&L); the compensation raises it.
          </div>
        </Modal>
      )}

    </>
  );
}
