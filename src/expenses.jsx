// Expenses — gastos por driver/truck/trip/job, días trabajados y ledger de materiales.
// UI only: state, Supabase calls and handlers live in App.jsx (same split as analytics.jsx).
// Shared Btn/Modal components arrive as props to avoid a circular import with App.jsx.
import { useMemo, useState } from "react";
import { numv, monthOf, shiftMonth, monthLabel, driverCashReconciliation, materialShortages } from "./analyticsData.js";

// Form/constant definitions live here (exported) so App.jsx state and this UI share one copy.
export const EMPTY_EXPENSE = {
  expense_date:"", category:"fuel", amount:"", vendor:"", driver_id:"", truck_id:"", trip_id:"",
  job_number:"", paid_from:"bank", bank_account:"", status:"pending",
  gallons:"", odometer:"", fuel_state:"", receipt_url:"", notes:"",
};
export const EXPENSE_CATEGORIES = [
  { v:"fuel", l:"Fuel", icon:"⛽" },
  { v:"hotel", l:"Hotel / Lodging", icon:"🏨" },
  { v:"materials", l:"Materials", icon:"📦" },
  { v:"tolls", l:"Tolls", icon:"🛣️" },
  { v:"maintenance", l:"Maintenance", icon:"🔧" },
  { v:"meals", l:"Meals", icon:"🍔" },
  { v:"other", l:"Other", icon:"💵" },
];
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
export const EMPTY_MATERIAL_ITEM = { name:"", category:"", unit:"unit", unit_cost:"", active:true, notes:"" };
export const EMPTY_MATERIAL_MOVE = { item_id:"", movement_type:"issue", quantity:"", unit_cost:"", driver_id:"", trip_id:"", job_number:"", movement_date:"", notes:"" };
export const MATERIAL_MOVE_TYPES = [
  { v:"purchase", l:"Purchase (entra a stock)" },
  { v:"issue", l:"Issue (entregado al driver)" },
  { v:"return", l:"Return (devuelto por el driver)" },
  { v:"consume", l:"Consume (usado en un job)" },
  { v:"adjust", l:"Adjust (corrección de stock)" },
];

export const expenseCatMeta = (v) => EXPENSE_CATEGORIES.find(c => c.v === v) || EXPENSE_CATEGORIES[EXPENSE_CATEGORIES.length - 1];
export const paidFromMeta = (v) => PAID_FROM_OPTIONS.find(p => p.v === v) || PAID_FROM_OPTIONS[0];
const moveTypeLabel = (v) => MATERIAL_MOVE_TYPES.find(t => t.v === v)?.l || v;

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
        {uploading ? "Subiendo…" : url ? (
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
    payAccounts, payments, paymentsMissing, workDays, materialItems, materialMovements,
    can, today,
    form, setForm, showModal, setShowModal, editingId, saving, uploading,
    onEdit, onSave, onDelete, onSetStatus, onSettle, onUploadReceipt,
    onToggleWorkDay,
    materialItemForm, setMaterialItemForm, showMaterialItemModal, setShowMaterialItemModal,
    editingMaterialItemId, materialSaving,
    onAddMaterialItem, onEditMaterialItem, onSaveMaterialItem, onDeleteMaterialItem,
    materialMoveForm, setMaterialMoveForm, showMaterialMoveModal, setShowMaterialMoveModal,
    onAddMaterialMove, onSaveMaterialMove, onDeleteMaterialMove,
    setPayPhotoView, Btn, Modal,
  } = props;

  const [tab, setTab] = useState("gastos");
  const [fDriver, setFDriver] = useState("");
  const [fCategory, setFCategory] = useState("");
  const [fPaidFrom, setFPaidFrom] = useState("");
  const [fStatus, setFStatus] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fSearch, setFSearch] = useState("");
  const [wdMonth, setWdMonth] = useState(monthOf(today()));

  const canEdit = can("expenses", "edit");
  const canCreate = can("expenses", "create");

  const driverById = useMemo(() => Object.fromEntries(driversList.map(d => [d.id, d])), [driversList]);
  const truckById = useMemo(() => Object.fromEntries(trucksList.map(t => [t.id, t])), [trucksList]);
  const tripById = useMemo(() => Object.fromEntries(trips.map(t => [t.id, t])), [trips]);
  const jobNumbers = useMemo(() => [...new Set(jobs.map(j => (j.job_number || "").trim()).filter(Boolean))].sort(), [jobs]);
  const activeDrivers = useMemo(() => driversList.filter(d => d.active !== false), [driversList]);

  const filtered = useMemo(() => expenses.filter(e => {
    if (fDriver && String(e.driver_id) !== String(fDriver)) return false;
    if (fCategory && e.category !== fCategory) return false;
    if (fPaidFrom && e.paid_from !== fPaidFrom) return false;
    if (fStatus && (e.status || "pending") !== fStatus) return false;
    const d = e.expense_date || (e.created_at || "").slice(0, 10);
    if (fFrom && d < fFrom) return false;
    if (fTo && d > fTo) return false;
    if (fSearch) {
      const q = fSearch.toLowerCase();
      const hay = [e.vendor, e.notes, e.job_number, driverById[e.driver_id]?.name].filter(Boolean).join(" ").toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  }), [expenses, fDriver, fCategory, fPaidFrom, fStatus, fFrom, fTo, fSearch, driverById]);

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

  const shortages = useMemo(() => materialShortages({ items: materialItems, movements: materialMovements }), [materialItems, materialMovements]);

  // ── Work-day grid data ──
  const wdDays = useMemo(() => {
    const [y, m] = wdMonth.split("-").map(Number);
    const n = new Date(y, m, 0).getDate();
    return Array.from({ length: n }, (_, i) => `${wdMonth}-${String(i + 1).padStart(2, "0")}`);
  }, [wdMonth]);
  const wdByDriverDate = useMemo(() => {
    const m = {};
    for (const w of workDays) m[w.driver_id + "|" + w.work_date] = w;
    return m;
  }, [workDays]);

  const setF = (patch) => setForm(f => ({ ...f, ...patch }));

  return (
    <>
      {missing && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>Para Expenses (gastos + días trabajados + materiales), corré el SQL de setup una vez en Supabase.</span>
          <button onClick={onShowSetup} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>View SQL</button>
        </div>
      )}

      <div style={{ display:"inline-flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14, flexWrap:"wrap" }}>
        {[["gastos","💸 Gastos"],["dias","📆 Días trabajados"],["materiales","📦 Materiales"]].map(([v, l]) => (
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
            <Tile label="Gastos en el filtro" value={filtered.length} sub={fmt$(filtered.reduce((s, e) => s + ((e.status || "pending") !== "rejected" ? numv(e.amount) : 0), 0))} />
          </div>

          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap", alignItems:"center" }}>
            <input style={{ ...inp, width:"auto", minWidth:200, flex:1, maxWidth:300 }} value={fSearch} onChange={e => setFSearch(e.target.value)} placeholder="🔎 Vendor, job #, notas…" />
            <select value={fDriver} onChange={e => setFDriver(e.target.value)} style={{ ...inp, width:"auto", minWidth:140 }}>
              <option value="">Todos los drivers</option>
              {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
            </select>
            <select value={fCategory} onChange={e => setFCategory(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
              <option value="">Todas las categorías</option>
              {EXPENSE_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
            </select>
            <select value={fPaidFrom} onChange={e => setFPaidFrom(e.target.value)} style={{ ...inp, width:"auto", minWidth:130 }}>
              <option value="">Toda fuente de pago</option>
              {PAID_FROM_OPTIONS.map(p => <option key={p.v} value={p.v}>{p.icon} {p.l}</option>)}
            </select>
            <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ ...inp, width:"auto", minWidth:110 }}>
              <option value="">Todo estado</option>
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
                  {["Fecha","Categoría","Vendor","Monto","Driver","Fuente","Links","Recibo","Estado",""].map((h, i) => <th key={i} style={th}>{h}</th>)}
                </tr></thead>
                <tbody>
                  {filtered.length === 0 ? (
                    <tr><td colSpan={10} style={{ padding:"40px", textAlign:"center", color:"#bbb" }}>No hay gastos en este filtro. Cargá uno con “+ Expense”.</td></tr>
                  ) : filtered.map(e => {
                    const pf = paidFromMeta(e.paid_from);
                    const trip = e.trip_id ? tripById[e.trip_id] : null;
                    return (
                      <tr key={e.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>{e.expense_date || (e.created_at || "").slice(0, 10) || "—"}</td>
                        <td style={td}><ExpenseCatChip category={e.category} />{e.category === "fuel" && numv(e.gallons) > 0 && <span style={{ fontSize:10.5, color:"#888" }}> · {numv(e.gallons)} gal{numv(e.amount) > 0 ? ` · $${(numv(e.amount) / numv(e.gallons)).toFixed(2)}/gal` : ""}</span>}</td>
                        <td style={td}>{e.vendor || "—"}</td>
                        <td style={{ ...td, fontWeight:700, whiteSpace:"nowrap" }}>{fmt$(numv(e.amount))}</td>
                        <td style={td}>{e.driver_id ? (driverById[e.driver_id]?.name || `#${e.driver_id}`) : "—"}</td>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>
                          {pf.icon} <span style={{ fontSize:11.5 }}>{e.paid_from === "bank" ? (e.bank_account || pf.l) : pf.l}</span>
                          {e.paid_from === "driver_cash" && (e.settled
                            ? <span style={{ fontSize:10, fontWeight:700, color:"#185FA5", marginLeft:5 }}>rendido {e.settled_date || ""}</span>
                            : <span style={{ fontSize:10, fontWeight:700, color:"#C2410C", marginLeft:5 }}>sin rendir</span>)}
                        </td>
                        <td style={{ ...td, fontSize:11.5, color:"#666", whiteSpace:"nowrap" }}>
                          {[trip && (trip.trip_number || `trip #${trip.id}`), e.job_number, e.truck_id && (truckById[e.truck_id]?.name || `truck #${e.truck_id}`)].filter(Boolean).join(" · ") || "—"}
                        </td>
                        <td style={td}>
                          {e.receipt_url ? (
                            (e.receipt_url || "").toLowerCase().includes(".pdf")
                              ? <a href={e.receipt_url} target="_blank" rel="noreferrer" style={{ fontSize:16, textDecoration:"none" }}>📄</a>
                              : <img src={e.receipt_url} alt="recibo" onClick={() => setPayPhotoView(e.receipt_url)} style={{ height:28, width:40, objectFit:"cover", borderRadius:4, cursor:"pointer", border:"1px solid #eee" }} />
                          ) : <span style={{ color:"#ddd" }}>—</span>}
                        </td>
                        <td style={td}><ExpenseStatusBadge status={e.status || "pending"} /></td>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>
                          {canEdit && (e.status || "pending") === "pending" && (
                            <>
                              <button onClick={() => onSetStatus(e, "approved")} title="Aprobar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:15 }}>✅</button>
                              <button onClick={() => onSetStatus(e, "rejected")} title="Rechazar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:15 }}>❌</button>
                            </>
                          )}
                          {canEdit && e.paid_from === "driver_cash" && e.status === "approved" && !e.settled && (
                            <button onClick={() => onSettle(e)} title="Marcar rendido (el driver entregó el resto del cash)" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>🤝</button>
                          )}
                          {canEdit && <button onClick={() => onEdit(e)} title="Editar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>✏️</button>}
                          {canEdit && <button onClick={() => onDelete(e)} title="Borrar" style={{ background:"none", border:"none", cursor:"pointer", fontSize:14 }}>🗑️</button>}
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

      {/* ── Tab: Días trabajados ── */}
      {tab === "dias" && !missing && (
        <>
          <div style={{ display:"flex", alignItems:"center", gap:10, marginBottom:12 }}>
            <Btn onClick={() => setWdMonth(shiftMonth(wdMonth, -1))}>←</Btn>
            <span style={{ fontWeight:700, fontSize:14, minWidth:80, textAlign:"center" }}>{monthLabel(wdMonth)}</span>
            <Btn onClick={() => setWdMonth(shiftMonth(wdMonth, 1))}>→</Btn>
            <span style={{ fontSize:12, color:"#999" }}>Click en un día para marcar/desmarcar. La tarifa se congela al marcar (cambiar el daily rate no reescribe historia).</span>
          </div>
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
            <div style={{ overflowX:"auto" }}>
              <table style={{ borderCollapse:"collapse", fontSize:12 }}>
                <thead><tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  <th style={{ ...th, position:"sticky", left:0, background:"#fafafa", zIndex:1 }}>Driver</th>
                  {wdDays.map(d => <th key={d} style={{ ...th, padding:"9px 4px", textAlign:"center" }}>{Number(d.slice(8))}</th>)}
                  <th style={{ ...th, textAlign:"right" }}>Días</th>
                  <th style={{ ...th, textAlign:"right" }}>Costo</th>
                </tr></thead>
                <tbody>
                  {activeDrivers.length === 0 ? (
                    <tr><td colSpan={wdDays.length + 3} style={{ padding:"30px", textAlign:"center", color:"#bbb" }}>No hay drivers activos.</td></tr>
                  ) : activeDrivers.map(d => {
                    const rows = wdDays.map(day => wdByDriverDate[d.id + "|" + day]);
                    const worked = rows.filter(Boolean);
                    const cost = worked.reduce((s, w) => s + (w.rate != null ? numv(w.rate) : numv(d.daily_rate)), 0);
                    return (
                      <tr key={d.id} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ ...td, fontWeight:600, whiteSpace:"nowrap", position:"sticky", left:0, background:"#fff", zIndex:1 }}>
                          {d.name}
                          <div style={{ fontSize:10, color: d.daily_rate ? "#999" : "#E24B4A", fontWeight:500 }}>{d.daily_rate ? `$${Number(d.daily_rate).toLocaleString()}/día` : "sin daily rate"}</div>
                        </td>
                        {wdDays.map((day, i) => {
                          const w = rows[i];
                          return (
                            <td key={day} style={{ padding:2, textAlign:"center" }}>
                              <button onClick={() => canEdit && onToggleWorkDay(d, day)} disabled={!canEdit}
                                title={w ? `Trabajó · $${numv(w.rate != null ? w.rate : d.daily_rate).toLocaleString()}` : "No trabajó"}
                                style={{ width:22, height:22, borderRadius:5, border:"1px solid " + (w ? "#639922" : "#eee"), background: w ? "#EAF3DE" : "#fff", cursor: canEdit ? "pointer" : "default", fontSize:10, color: w ? "#3B6D11" : "#ddd", fontWeight:700 }}>
                                {w ? "✓" : ""}
                              </button>
                            </td>
                          );
                        })}
                        <td style={{ ...td, textAlign:"right", fontWeight:700 }}>{worked.length}</td>
                        <td style={{ ...td, textAlign:"right", fontWeight:700, whiteSpace:"nowrap" }}>{fmt$(cost)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {/* ── Tab: Materiales ── */}
      {tab === "materiales" && !missing && (
        <>
          <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
            {canCreate && <Btn primary onClick={() => onAddMaterialMove()}>+ Movimiento</Btn>}
            {canCreate && <Btn onClick={onAddMaterialItem}>+ Material</Btn>}
          </div>

          {/* En mano por driver (faltantes potenciales) */}
          <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:16, marginBottom:14 }}>
            <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 }}>En mano por driver (entregado − devuelto − consumido)</div>
            {shortages.filter(s => s.onHand !== 0).length === 0 ? (
              <div style={{ fontSize:12.5, color:"#bbb" }}>Nadie tiene materiales pendientes de devolver.</div>
            ) : (
              <div style={{ overflowX:"auto" }}>
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12.5 }}>
                  <thead><tr style={{ borderBottom:"1px solid #efefef" }}>{["Driver","Material","Entregado","Devuelto","Consumido","En mano","Valor"].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {shortages.filter(s => s.onHand !== 0).map((s, i) => (
                      <tr key={i} style={{ borderBottom:"1px solid #fafafa" }}>
                        <td style={{ ...td, fontWeight:600 }}>{driverById[s.driverId]?.name || `#${s.driverId}`}</td>
                        <td style={td}>{s.itemName}</td>
                        <td style={td}>{s.issued}</td>
                        <td style={td}>{s.returned}</td>
                        <td style={td}>{s.consumed}</td>
                        <td style={{ ...td, fontWeight:800, color: s.onHand > 0 ? "#E24B4A" : "#185FA5" }}>{s.onHand} {s.unit}</td>
                        <td style={{ ...td, fontWeight:600, whiteSpace:"nowrap" }}>{fmt$(s.value)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(340px,1fr))", gap:14 }}>
            {/* Catálogo */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:16 }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 }}>Catálogo</div>
              {materialItems.length === 0 ? <div style={{ fontSize:12.5, color:"#bbb" }}>Sin materiales. Agregá pads, boxes, shrink wrap…</div> : (
                <table style={{ width:"100%", borderCollapse:"collapse", fontSize:12.5 }}>
                  <thead><tr style={{ borderBottom:"1px solid #efefef" }}>{["Material","Unidad","Costo",""].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
                  <tbody>
                    {materialItems.map(it => (
                      <tr key={it.id} style={{ borderBottom:"1px solid #fafafa", opacity: it.active === false ? 0.5 : 1 }}>
                        <td style={{ ...td, fontWeight:600 }}>{it.name}{it.category ? <span style={{ fontSize:10.5, color:"#999" }}> · {it.category}</span> : null}</td>
                        <td style={td}>{it.unit || "unit"}</td>
                        <td style={td}>{it.unit_cost != null ? `$${Number(it.unit_cost).toLocaleString()}` : "—"}</td>
                        <td style={{ ...td, whiteSpace:"nowrap", textAlign:"right" }}>
                          {canEdit && <button onClick={() => onEditMaterialItem(it)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13 }}>✏️</button>}
                          {canEdit && <button onClick={() => onDeleteMaterialItem(it)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:13 }}>🗑️</button>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Movimientos */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:16 }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:8 }}>Últimos movimientos</div>
              {materialMovements.length === 0 ? <div style={{ fontSize:12.5, color:"#bbb" }}>Sin movimientos todavía.</div> : (
                <div style={{ maxHeight:420, overflowY:"auto" }}>
                  {materialMovements.slice(0, 100).map(mv => {
                    const it = materialItems.find(i => i.id === mv.item_id);
                    return (
                      <div key={mv.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"6px 0", borderBottom:"1px solid #f4f4f4", fontSize:12, flexWrap:"wrap" }}>
                        <span style={{ color:"#888", whiteSpace:"nowrap" }}>{mv.movement_date || (mv.created_at || "").slice(0, 10)}</span>
                        <b>{it?.name || `#${mv.item_id}`}</b>
                        <span>{moveTypeLabel(mv.movement_type)}</span>
                        <b>× {numv(mv.quantity)}</b>
                        {mv.driver_id && <span style={{ color:"#185FA5" }}>{driverById[mv.driver_id]?.name || `#${mv.driver_id}`}</span>}
                        {mv.job_number && <span style={{ fontFamily:"monospace", color:"#666" }}>{mv.job_number}</span>}
                        <span style={{ flex:1 }} />
                        {canEdit && <button onClick={() => onDeleteMaterialMove(mv)} style={{ background:"none", border:"none", cursor:"pointer", fontSize:12 }}>🗑️</button>}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Modal: gasto ── */}
      {showModal && (
        <Modal title={editingId ? "Edit expense" : "Nuevo gasto"} onClose={() => setShowModal(false)}
          footer={<><Btn onClick={() => setShowModal(false)}>Cancel</Btn><Btn primary disabled={saving || uploading} onClick={onSave}>{saving ? "Saving…" : "Save expense"}</Btn></>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
            <Field label="Fecha"><input type="date" style={inp} value={form.expense_date} onChange={e => setF({ expense_date: e.target.value })} /></Field>
            <Field label="Categoría">
              <select style={inp} value={form.category} onChange={e => setF({ category: e.target.value })}>
                {EXPENSE_CATEGORIES.map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
              </select>
            </Field>
            <Field label="Monto ($)"><input type="number" min="0" step="0.01" style={inp} value={form.amount} onChange={e => setF({ amount: e.target.value })} placeholder="0.00" /></Field>
            <Field label="Vendor / lugar"><input style={inp} value={form.vendor} onChange={e => setF({ vendor: e.target.value })} placeholder="Pilot, Home Depot, Motel 6…" /></Field>
            <Field label="Driver">
              <select style={inp} value={form.driver_id} onChange={e => setF({ driver_id: e.target.value })}>
                <option value="">(sin driver)</option>
                {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Truck">
              <select style={inp} value={form.truck_id} onChange={e => setF({ truck_id: e.target.value })}>
                <option value="">(sin truck)</option>
                {trucksList.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </Field>
            <Field label="Trip">
              <select style={inp} value={form.trip_id} onChange={e => setF({ trip_id: e.target.value })}>
                <option value="">(sin trip)</option>
                {trips.map(t => <option key={t.id} value={t.id}>{t.trip_number || `#${t.id}`}</option>)}
              </select>
            </Field>
            <Field label="Job #">
              <input style={inp} list="expense-jobs-list" value={form.job_number} onChange={e => setF({ job_number: e.target.value })} placeholder="(opcional)" />
              <datalist id="expense-jobs-list">{jobNumbers.map(n => <option key={n} value={n} />)}</datalist>
            </Field>
            <Field label="Pagado con">
              <select style={inp} value={form.paid_from} onChange={e => setF({ paid_from: e.target.value })}>
                {PAID_FROM_OPTIONS.map(p => <option key={p.v} value={p.v}>{p.icon} {p.l}</option>)}
              </select>
            </Field>
            {form.paid_from === "bank" && (
              <Field label="Cuenta">
                <select style={inp} value={form.bank_account} onChange={e => setF({ bank_account: e.target.value })}>
                  <option value="">(elegir cuenta)</option>
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
              💵 Este gasto sale del cash que el driver cobró de clientes: al aprobarlo, baja lo que ese driver debería entregar.
              {cashHint && (
                <div style={{ marginTop:4, fontWeight:600 }}>
                  Tiene en mano {fmt$(cashHint.held)} − gastos sin rendir {fmt$(cashHint.approvedCashExpenses)} = debería entregar <span style={{ color: cashHint.expectedOnHand < 0 ? "#E24B4A" : "#3B6D11" }}>{fmt$(cashHint.expectedOnHand)}</span>
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
                <div style={{ gridColumn:"1 / -1", fontSize:11.5, color:"#888", paddingBottom:8 }}>≈ ${(numv(form.amount) / numv(form.gallons)).toFixed(2)}/galón</div>
              )}
            </div>
          )}

          <ReceiptBox url={form.receipt_url} onFile={onUploadReceipt} uploading={uploading} onView={setPayPhotoView} />

          <div style={{ marginTop:10 }}>
            <Field label="Notas"><textarea style={{ ...inp, minHeight:52, resize:"vertical" }} value={form.notes} onChange={e => setF({ notes: e.target.value })} /></Field>
          </div>
        </Modal>
      )}

      {/* ── Modal: material (catálogo) ── */}
      {showMaterialItemModal && (
        <Modal title={editingMaterialItemId ? "Edit material" : "Nuevo material"} onClose={() => setShowMaterialItemModal(false)}
          footer={<><Btn onClick={() => setShowMaterialItemModal(false)}>Cancel</Btn><Btn primary disabled={materialSaving} onClick={onSaveMaterialItem}>{materialSaving ? "Saving…" : "Save"}</Btn></>}>
          <Field label="Nombre"><input style={inp} value={materialItemForm.name} onChange={e => setMaterialItemForm(f => ({ ...f, name: e.target.value }))} placeholder="Moving pads, shrink wrap, boxes M…" /></Field>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:"0 14px" }}>
            <Field label="Categoría"><input style={inp} value={materialItemForm.category} onChange={e => setMaterialItemForm(f => ({ ...f, category: e.target.value }))} placeholder="packing, protección…" /></Field>
            <Field label="Unidad"><input style={inp} value={materialItemForm.unit} onChange={e => setMaterialItemForm(f => ({ ...f, unit: e.target.value }))} placeholder="unit, roll, box…" /></Field>
            <Field label="Costo unitario ($)"><input type="number" min="0" step="0.01" style={inp} value={materialItemForm.unit_cost} onChange={e => setMaterialItemForm(f => ({ ...f, unit_cost: e.target.value }))} /></Field>
          </div>
          <Field label="Notas"><input style={inp} value={materialItemForm.notes} onChange={e => setMaterialItemForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <label style={{ display:"flex", alignItems:"center", gap:7, fontSize:13, cursor:"pointer" }}>
            <input type="checkbox" checked={!!materialItemForm.active} onChange={e => setMaterialItemForm(f => ({ ...f, active: e.target.checked }))} /> Activo
          </label>
        </Modal>
      )}

      {/* ── Modal: movimiento de material ── */}
      {showMaterialMoveModal && (
        <Modal title="Movimiento de material" onClose={() => setShowMaterialMoveModal(false)}
          footer={<><Btn onClick={() => setShowMaterialMoveModal(false)}>Cancel</Btn><Btn primary disabled={materialSaving} onClick={onSaveMaterialMove}>{materialSaving ? "Saving…" : "Save"}</Btn></>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 14px" }}>
            <Field label="Material">
              <select style={inp} value={materialMoveForm.item_id} onChange={e => setMaterialMoveForm(f => ({ ...f, item_id: e.target.value }))}>
                <option value="">(elegir)</option>
                {materialItems.filter(i => i.active !== false).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </Field>
            <Field label="Tipo">
              <select style={inp} value={materialMoveForm.movement_type} onChange={e => setMaterialMoveForm(f => ({ ...f, movement_type: e.target.value }))}>
                {MATERIAL_MOVE_TYPES.map(t => <option key={t.v} value={t.v}>{t.l}</option>)}
              </select>
            </Field>
            <Field label="Cantidad"><input type="number" step="0.01" style={inp} value={materialMoveForm.quantity} onChange={e => setMaterialMoveForm(f => ({ ...f, quantity: e.target.value }))} /></Field>
            <Field label="Fecha"><input type="date" style={inp} value={materialMoveForm.movement_date} onChange={e => setMaterialMoveForm(f => ({ ...f, movement_date: e.target.value }))} /></Field>
            <Field label="Driver">
              <select style={inp} value={materialMoveForm.driver_id} onChange={e => setMaterialMoveForm(f => ({ ...f, driver_id: e.target.value }))}>
                <option value="">(sin driver)</option>
                {driversList.map(d => <option key={d.id} value={d.id}>{d.name}</option>)}
              </select>
            </Field>
            <Field label="Trip">
              <select style={inp} value={materialMoveForm.trip_id} onChange={e => setMaterialMoveForm(f => ({ ...f, trip_id: e.target.value }))}>
                <option value="">(sin trip)</option>
                {trips.map(t => <option key={t.id} value={t.id}>{t.trip_number || `#${t.id}`}</option>)}
              </select>
            </Field>
            <Field label="Job #">
              <input style={inp} list="expense-jobs-list" value={materialMoveForm.job_number} onChange={e => setMaterialMoveForm(f => ({ ...f, job_number: e.target.value }))} placeholder="(para consume)" />
            </Field>
            <Field label="Costo unitario ($, opcional)"><input type="number" min="0" step="0.01" style={inp} value={materialMoveForm.unit_cost} onChange={e => setMaterialMoveForm(f => ({ ...f, unit_cost: e.target.value }))} placeholder="usa el del catálogo" /></Field>
          </div>
          <Field label="Notas"><input style={inp} value={materialMoveForm.notes} onChange={e => setMaterialMoveForm(f => ({ ...f, notes: e.target.value }))} /></Field>
        </Modal>
      )}
    </>
  );
}
