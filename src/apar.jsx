// AP / AR — accounts payable and accounts receivable, on one screen.
//
// The CRM already tracked every dollar; it tracked them in six different places
// (Payments, Storage Billing, Settlements, Extras, Expenses, Banks), so nobody
// could answer "how much do they owe me and how much do I owe" without adding
// up six screens by hand. This section is that sum, aged 0–30 / 31–60 / 61–90 /
// 90+ on both sides, with the net position on top.
//
// It is deliberately NOT a second ledger. Every receivable and most payables are
// derived from the tables that already own them, and the row actions either
// write to that owning table or navigate to it. The one thing this module owns
// outright is `ap_bills`: the bills the CRM never modelled — storage-unit rent,
// insurance, phone, software, loan instalments, a one-off supplier invoice.
//
// Self-contained module (same pattern as BancosSection/MessagesSection): it gets
// supabase + session, loads its own table and runs its own realtime channel. The
// math lives in src/aparData.js so it can be unit-tested with plain node
// (`npm run test:apar`).
import { useState, useMemo, useEffect, useCallback } from "react";
import {
  buildReceivables, buildPayables, buildDriverPayables, netPosition, aging,
  sumRows, overdueRows, dueBillsToGenerate, overdueBillIds, nextDueDate,
  BILL_RECURRENCES, BILL_PAID_FROM,
} from "./aparData.js";
import { numv, dedupeJobs, isPhysical } from "./analyticsData.js";
import { effectiveBanked } from "./bankShared.js";
import { paymentNet } from "./paymentAlloc.js";
import { tr, t } from "./i18n.js";

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };
const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
const fieldLabel = { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4, display:"block" };
const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

// Aging ladder labels. The dictionary can't reach an interpolated string, so
// these go through t() rather than living as JSX text.
const AGING_LABELS = () => [t("0–30 days"), t("31–60 days"), t("61–90 days"), t("90+ days")];
const AGING_COLORS = ["#639922", "#EAB308", "#EA580C", "#E24B4A"];

// Where a row came from. The badge is the honest answer to "why is this here?",
// and every source maps to the module that actually owns the number.
const SOURCE_META = {
  job:             { label:"Job",        icon:"💼", bg:"#E6F1FB", text:"#185FA5" },
  storage_billing: { label:"Storage",    icon:"🧾", bg:"#EAF3DE", text:"#3B6D11" },
  settlement:      { label:"Settlement", icon:"📑", bg:"#EDE9FE", text:"#6D28D9" },
  bill:            { label:"Bill",       icon:"📄", bg:"#FEF3C7", text:"#92760B" },
  expense:         { label:"Expense",    icon:"💸", bg:"#FDE3CF", text:"#C2410C" },
  driver:          { label:"Driver pay", icon:"🪪", bg:"#f1f1f1", text:"#555" },
};

function SourceBadge({ source }) {
  const m = SOURCE_META[source] || { label: source, icon:"•", bg:"#f1f1f1", text:"#555" };
  return <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:m.bg, color:m.text, whiteSpace:"nowrap" }}>{m.icon} {m.label}</span>;
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

// Plain divs rather than a chart library: four bars need no SVG, and text
// outside SVG is text the Spanish DOM pass can actually reach.
function AgingBar({ buckets, total, selected, onSelect }) {
  if (!total) return <div style={{ fontSize:12.5, color:"#bbb", padding:"10px 0" }}>Nothing outstanding</div>;
  return (
    <div>
      <div style={{ display:"flex", height:10, borderRadius:6, overflow:"hidden", background:"#f4f4f4" }}>
        {buckets.map((b, i) => b.amount > 0 && (
          <div key={i} title={`${b.label} · ${fmt$(b.amount)}`}
            style={{ width:`${(b.amount / total) * 100}%`, background:AGING_COLORS[i], opacity: selected == null || selected === i ? 1 : 0.3 }} />
        ))}
      </div>
      <div style={{ display:"flex", gap:6, marginTop:8, flexWrap:"wrap" }}>
        {buckets.map((b, i) => (
          <button key={i} onClick={() => onSelect(selected === i ? null : i)}
            style={{ flex:"1 1 90px", textAlign:"left", padding:"6px 9px", borderRadius:8, cursor:"pointer",
              border:"1px solid " + (selected === i ? "#111" : "#efefef"), background: selected === i ? "#fafafa" : "#fff" }}>
            <div style={{ display:"flex", alignItems:"center", gap:5 }}>
              <span style={{ width:7, height:7, borderRadius:2, background:AGING_COLORS[i], display:"inline-block" }} />
              <span style={{ fontSize:10.5, color:"#999", fontWeight:600 }}>{b.label}</span>
            </div>
            <div style={{ fontSize:14, fontWeight:700, marginTop:2 }}>{fmt$(b.amount)}</div>
            <div style={{ fontSize:10, color:"#bbb" }}>{tr(`${b.count} ${b.count === 1 ? "item" : "items"}`, `${b.count} ${b.count === 1 ? "ítem" : "ítems"}`)}</div>
          </button>
        ))}
      </div>
    </div>
  );
}

const EMPTY_BILL = {
  vendor:"", category:"", description:"", amount:"", bill_date:"", due_date:"",
  recurrence:"once", paid_from:"bank", bank_account:"", notes:"",
};

export function ApArSection({
  supabase, session, profile,
  jobs = [], payments = [], jobExtras = [], billing = [], closingSheets = [],
  sheetCalcById = {}, brokers = [], expenses = [], storages = [],
  driversList = [], workDays = [], adjustments = [],
  jobOutstanding, onOpenJob, setPage,
  can = () => true, Btn, Modal,
}) {
  const myName = profile?.full_name || session?.user?.email || "";
  const canEdit = can("apar", "edit");
  const canCreate = can("apar", "create");
  const today = todayISO();

  const [missing, setMissing] = useState(false);
  const [bills, setBills] = useState([]);
  const [billsLoaded, setBillsLoaded] = useState(false);
  const [bankTxns, setBankTxns] = useState([]);
  const [bankCategories, setBankCategories] = useState([]);
  const [tab, setTab] = useState("receivable");
  const [bucketSel, setBucketSel] = useState(null);
  const [sourceSel, setSourceSel] = useState("");
  const [showBill, setShowBill] = useState(false);
  const [billForm, setBillForm] = useState(EMPTY_BILL);
  const [editingBillId, setEditingBillId] = useState(null);
  const [saving, setSaving] = useState(false);
  const [payRow, setPayRow] = useState(null);     // row awaiting a "mark paid" amount
  const [payAmount, setPayAmount] = useState("");

  // ── Data + realtime ────────────────────────────────────────────────────────
  const loadBills = useCallback(async () => {
    const { data, error } = await supabase.from("ap_bills").select("*")
      .order("due_date", { ascending: true }).order("id", { ascending: true });
    if (error) { if (/does not exist|relation/i.test(error.message)) setMissing(true); return; }
    setMissing(false);
    setBills((data || []).filter(r => !r.deleted_at));
    setBillsLoaded(true);
  }, [supabase]);

  // Bank movements are what tells an expense apart from a payable: an expense
  // recorded against the bank stops being owed the moment its statement line
  // lands. Read-only here — the Banks module owns these rows.
  const loadBankTxns = useCallback(async () => {
    const PAGE = 1000;
    const all = [];
    for (let fromIdx = 0; ; fromIdx += PAGE) {
      const { data, error } = await supabase.from("bank_transactions")
        .select("id,amount,direction,txn_date,category,status,deleted_at")
        .order("txn_date", { ascending: false }).order("id", { ascending: false })
        .range(fromIdx, fromIdx + PAGE - 1);
      if (error) return;                       // module not installed: no matching, all expenses show
      all.push(...(data || []));
      if (!data || data.length < PAGE) break;
    }
    setBankTxns(all.filter(r => !r.deleted_at));
  }, [supabase]);

  // The chart of accounts, only so transfers are excluded from the expense match
  // (a transfer out is not a supplier payment) and so the bill form can suggest
  // the same expense categories the Banks module uses.
  const loadBankCats = useCallback(async () => {
    const { data, error } = await supabase.from("bank_categories").select("name,direction,is_transfer,active")
      .order("sort", { ascending: true }).order("name", { ascending: true });
    if (!error && data) setBankCategories(data);
  }, [supabase]);

  useEffect(() => { loadBills(); loadBankTxns(); loadBankCats(); }, [loadBills, loadBankTxns, loadBankCats]);
  useEffect(() => {
    if (missing) return;
    const ch = supabase.channel("apar-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "ap_bills" }, () => loadBills())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [supabase, missing, loadBills]);

  // ── Derived lists ──────────────────────────────────────────────────────────
  const groups = useMemo(() => [...dedupeJobs(jobs).values()], [jobs]);
  const brokerName = useCallback((id) => brokers.find(b => b.id === id)?.name || "", [brokers]);

  // Cash a driver is holding but hasn't deposited. Shown beside his pay week as
  // context, never subtracted from it: that money moves the other way and
  // settles through its own flow in Expenses.
  const cashOnHandByDriver = useMemo(() => {
    const m = {};
    for (const d of driversList) {
      const nm = (d.name || "").trim();
      if (!nm) continue;
      m[d.id] = payments
        .filter(p => !p.deleted_at && p.received && isPhysical(p.method) && !effectiveBanked(p)
          && [p.cash_with_whom, p.received_by].some(v => (v || "").trim() === nm))
        .reduce((s, p) => s + paymentNet(p), 0);
    }
    return m;
  }, [driversList, payments]);

  const receivables = useMemo(() => buildReceivables({
    groups, billing, closingSheets, sheetCalcById, jobs, brokerName, jobOutstanding,
  }), [groups, billing, closingSheets, sheetCalcById, jobs, brokerName, jobOutstanding]);

  const driverPayables = useMemo(() => buildDriverPayables({
    driversList, workDays, adjustments, jobExtras, cashOnHandByDriver,
  }), [driversList, workDays, adjustments, jobExtras, cashOnHandByDriver]);

  const payables = useMemo(() => buildPayables({
    bills, expenses, bankTxns, bankCategories, closingSheets, sheetCalcById,
    driverPayables, brokerName,
  }), [bills, expenses, bankTxns, bankCategories, closingSheets, sheetCalcById, driverPayables, brokerName]);

  const position = useMemo(() => netPosition({ receivables, payables, todayISO: today }), [receivables, payables, today]);

  const rows = tab === "receivable" ? receivables : payables;
  // The labels change when the user switches language, so they key the memos —
  // AGING_LABELS() returns a fresh array on every render and could not.
  const labelKey = AGING_LABELS().join("|");
  const labels = useMemo(() => labelKey.split("|"), [labelKey]);
  const arLadder = useMemo(() => aging(receivables, today, labels), [receivables, today, labels]);
  const apLadder = useMemo(() => aging(payables, today, labels), [payables, today, labels]);
  const ladder = tab === "receivable" ? arLadder : apLadder;

  const visible = useMemo(() => {
    let out = bucketSel != null ? ladder.buckets[bucketSel].rows : rows;
    if (sourceSel) out = out.filter(r => r.source === sourceSel);
    return out;
  }, [rows, ladder, bucketSel, sourceSel]);

  const sourcesInTab = useMemo(() => [...new Set(rows.map(r => r.source))], [rows]);
  // Switching tabs clears the filters explicitly rather than through an effect
  // on `tab`: clicking an aging band on the other side's card sets the tab AND
  // the band in one go, and an effect would fire afterwards and wipe the band.
  const showTab = (v) => { setTab(v); setBucketSel(null); setSourceSel(""); };
  const showBand = (v, i) => { setTab(v); setSourceSel(""); setBucketSel(i); };

  // ── Auto-generation: rent cycles, recurring cycles, overdue sweep ──────────
  // Same shape as the storage-billing generator in App.jsx: runs once per mount
  // after the bills have loaded, and is idempotent (dueBillsToGenerate dedupes,
  // the ap_bills_autogen unique index backstops a race between two open tabs).
  const [generated, setGenerated] = useState(false);
  useEffect(() => {
    // Waiting on billsLoaded matters: with an empty `bills` the generator has
    // nothing to dedupe against and would propose every rent cycle that already
    // exists (the unique index would reject them, taking the legitimately-new
    // rows down with them).
    if (missing || generated || !billsLoaded || !session || !(canEdit || canCreate)) return;
    setGenerated(true);
    (async () => {
      let changed = false;
      if (canEdit) {
        const stale = overdueBillIds(bills, today);
        if (stale.length) {
          await supabase.from("ap_bills").update({ status:"overdue" }).in("id", stale);
          changed = true;
        }
      }
      if (canCreate) {
        // One insert per row: a duplicate that slipped past the dedupe (another
        // tab generating at the same time) is rejected by the unique index on
        // its own row instead of failing the whole batch.
        for (const b of dueBillsToGenerate({ bills, storages, todayISO: today })) {
          const { error } = await supabase.from("ap_bills").insert({ ...b, created_by: myName });
          if (!error) changed = true;
        }
      }
      if (changed) loadBills();
    })();
  }, [missing, generated, billsLoaded, canEdit, canCreate, session, bills, storages, today, supabase, myName, loadBills]);

  // ── Writes ─────────────────────────────────────────────────────────────────
  const stamp = () => ({ updated_by: myName, updated_at: new Date().toISOString() });

  const openAddBill = () => { setEditingBillId(null); setBillForm({ ...EMPTY_BILL, bill_date: today }); setShowBill(true); };
  const openEditBill = (b) => {
    setEditingBillId(b.id);
    setBillForm({
      vendor: b.vendor || "", category: b.category || "", description: b.description || "",
      amount: b.amount ?? "", bill_date: b.bill_date || "", due_date: b.due_date || "",
      recurrence: b.recurrence || "once", paid_from: b.paid_from || "bank",
      bank_account: b.bank_account || "", notes: b.notes || "",
    });
    setShowBill(true);
  };
  const saveBill = async () => {
    if (!billForm.due_date || !(numv(billForm.amount) > 0)) {
      window.alert(tr("A bill needs an amount and a due date.", "Una factura necesita monto y fecha de vencimiento."));
      return;
    }
    setSaving(true);
    const payload = {
      vendor: billForm.vendor || null,
      category: billForm.category || null,
      description: billForm.description || null,
      amount: numv(billForm.amount),
      bill_date: billForm.bill_date || null,
      due_date: billForm.due_date,
      status: billForm.due_date < today ? "overdue" : "pending",
      recurrence: billForm.recurrence || "once",
      paid_from: billForm.paid_from || "bank",
      bank_account: billForm.bank_account || null,
      notes: billForm.notes || null,
    };
    if (editingBillId) await supabase.from("ap_bills").update({ ...payload, ...stamp() }).eq("id", editingBillId);
    else await supabase.from("ap_bills").insert({ ...payload, source:"manual", created_by: myName });
    setSaving(false); setShowBill(false); setEditingBillId(null); loadBills();
  };
  const deleteBill = async (b) => {
    if (!canEdit) return;
    if (!window.confirm(tr("Delete this bill?", "¿Borrar esta factura?"))) return;
    await supabase.from("ap_bills").update({ deleted_at: new Date().toISOString(), ...stamp() }).eq("id", b.id);
    loadBills();
  };

  // Marking a bill paid closes it for its full remainder, or records a partial
  // payment and leaves the rest owed.
  const payBill = async (row, amountStr) => {
    const b = bills.find(x => x.id === row.ref.billId);
    if (!b) return;
    const pay = amountStr === "" || amountStr == null ? row.amount : numv(amountStr);
    if (pay <= 0) return;
    const paidTotal = numv(b.amount_paid) + pay;
    const done = paidTotal >= numv(b.amount) - 0.01;
    await supabase.from("ap_bills").update({
      amount_paid: Math.round(paidTotal * 100) / 100,
      status: done ? "paid" : (b.due_date && b.due_date < today ? "overdue" : "pending"),
      paid_date: done ? today : b.paid_date || null,
      ...stamp(),
    }).eq("id", b.id);
    // A settled recurring bill immediately opens its next cycle, so the calendar
    // never goes quiet on rent or insurance.
    if (done && canCreate && nextDueDate(b.due_date, b.recurrence)) {
      const [next] = dueBillsToGenerate({
        bills: [...bills.filter(x => x.id !== b.id), { ...b, status:"paid" }],
        storages: [], todayISO: today,
      });
      if (next) await supabase.from("ap_bills").insert({ ...next, created_by: myName });
    }
    setPayRow(null); setPayAmount(""); loadBills();
  };

  const markBillingPaid = async (row) => {
    await supabase.from("storage_billing").update({ status:"paid", paid_date: today }).eq("id", row.ref.billingId);
  };

  // Stamps every unpaid part of the driver's pay week at once — days, extra
  // commissions and adjustments — so the row leaves the list whole. It stamps
  // the exact ids the row was built from (ref.*Ids) rather than a date range:
  // an extra with no extra_date is bucketed by created_at, so a date filter
  // would miss it and the row would come back every reload.
  const markWeekPaid = async (row) => {
    const { workDayIds = [], adjustmentIds = [], extraIds = [] } = row.ref;
    if (!window.confirm(tr(`Mark ${row.party}'s week paid?`, `¿Marcar como pagada la semana de ${row.party}?`))) return;
    if (workDayIds.length) await supabase.from("driver_work_days").update({ paid_date: today }).in("id", workDayIds);
    if (adjustmentIds.length) await supabase.from("driver_adjustments").update({ paid_date: today }).in("id", adjustmentIds);
    if (extraIds.length) await supabase.from("job_extras").update({ commission_paid_date: today }).in("id", extraIds);
  };

  // ── Setup banner ───────────────────────────────────────────────────────────
  if (missing) {
    return (
      <div style={{ background:"#FFF7ED", border:"1px solid #FED7AA", borderRadius:12, padding:20, fontSize:13.5, color:"#9A3412" }}>
        <b>The AP / AR module is not installed in the database yet.</b>
        <div style={{ marginTop:6 }}>Run the migration and reload:</div>
        <pre style={{ background:"#fff", border:"1px solid #eee", borderRadius:8, padding:10, fontSize:12, marginTop:8 }}>SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-ap-bills.mjs</pre>
      </div>
    );
  }

  const TABS = [["receivable", "Receivable"], ["payable", "Payable"]];
  const netColor = position.net >= 0 ? "#1A8A4E" : "#E24B4A";

  return (
    <div>
      {/* Net position — the number the CRM never had. */}
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:10, marginBottom:14 }}>
        <Tile label="They owe us (AR)" value={fmt$(position.ar)} color="#1A8A4E" sub={tr(`${receivables.length} open`, `${receivables.length} abiertos`)} />
        <Tile label="We owe (AP)" value={fmt$(position.ap)} color="#E24B4A" sub={tr(`${payables.length} open`, `${payables.length} abiertos`)} />
        <Tile label="Net position" value={fmt$(position.net)} color={netColor} />
        <Tile label="AR overdue" value={fmt$(position.arOverdue)} color="#C2410C" sub={tr(`${overdueRows(receivables, today).length} past due`, `${overdueRows(receivables, today).length} vencidos`)} />
        <Tile label="AP overdue" value={fmt$(position.apOverdue)} color="#C2410C" sub={tr(`${overdueRows(payables, today).length} past due`, `${overdueRows(payables, today).length} vencidos`)} />
        <Tile label="To pay in 30 days" value={fmt$(position.apSoon)} color="#111" sub={tr(`vs ${fmt$(position.arSoon)} to collect`, `vs ${fmt$(position.arSoon)} a cobrar`)} />
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:14, flexWrap:"wrap" }}>
        <div style={{ flex:"1 1 300px", background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
          <div style={{ fontSize:11, color:"#aaa", fontWeight:600, marginBottom:8 }}>{tr(`Receivable aging · avg ${arLadder.avgDays} days`, `Aging de cobros · prom. ${arLadder.avgDays} días`)}</div>
          <AgingBar buckets={arLadder.buckets} total={arLadder.total} selected={tab === "receivable" ? bucketSel : null}
            onSelect={(i) => showBand("receivable", i)} />
        </div>
        <div style={{ flex:"1 1 300px", background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
          <div style={{ fontSize:11, color:"#aaa", fontWeight:600, marginBottom:8 }}>{tr(`Payable aging · avg ${apLadder.avgDays} days`, `Aging de pagos · prom. ${apLadder.avgDays} días`)}</div>
          <AgingBar buckets={apLadder.buckets} total={apLadder.total} selected={tab === "payable" ? bucketSel : null}
            onSelect={(i) => showBand("payable", i)} />
        </div>
      </div>

      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => showTab(v)}
            style={{ padding:"7px 14px", borderRadius:20, border:"1px solid " + (tab === v ? "#111" : "#e5e5e5"), background: tab === v ? "#111" : "#fff", color: tab === v ? "#fff" : "#555", fontSize:12.5, fontWeight:600, cursor:"pointer" }}>
            {l}
            <span style={{ marginLeft:6, fontWeight:700, opacity:0.75 }}>{fmt$(v === "receivable" ? position.ar : position.ap)}</span>
          </button>
        ))}
        <span style={{ flex:1 }} />
        {sourcesInTab.length > 1 && (
          <select value={sourceSel} onChange={e => setSourceSel(e.target.value)} style={{ ...inp, width:"auto", fontSize:12 }}>
            <option value="">All sources</option>
            {sourcesInTab.map(s => <option key={s} value={s}>{SOURCE_META[s]?.label || s}</option>)}
          </select>
        )}
        {tab === "payable" && canCreate && <Btn primary onClick={openAddBill}>+ Bill</Btn>}
      </div>

      {bucketSel != null && (
        <div style={{ fontSize:12, color:"#888", marginBottom:8 }}>
          {tr(`Showing the ${ladder.buckets[bucketSel].label} bucket only.`, `Mostrando solo el tramo ${ladder.buckets[bucketSel].label}.`)}{" "}
          <button onClick={() => setBucketSel(null)} style={{ background:"none", border:"none", color:"#185FA5", cursor:"pointer", padding:0, textDecoration:"underline", fontSize:12 }}>Clear filter</button>
        </div>
      )}

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:760 }}>
          <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}>
            <th style={th}>Source</th>
            <th style={th}>{tab === "receivable" ? "Who owes" : "Who we owe"}</th>
            <th style={th}>Reference</th>
            <th style={th}>Due</th>
            <th style={{ ...th, textAlign:"right" }}>Age</th>
            <th style={{ ...th, textAlign:"right" }}>Amount</th>
            <th style={th}></th>
          </tr></thead>
          <tbody>
            {visible.length === 0 && (
              <tr><td colSpan={7} style={{ ...td, color:"#bbb", textAlign:"center", padding:"28px 10px" }}>
                {tab === "receivable" ? "Nothing left to collect" : "Nothing left to pay"}
              </td></tr>
            )}
            {visible.map(r => {
              const days = r.dueDate ? Math.round((new Date(today + "T00:00:00") - new Date(r.dueDate + "T00:00:00")) / 86400000) : null;
              const late = days != null && days > 0;
              return (
                <tr key={r.id} style={{ borderBottom:"1px solid #f6f6f6" }}>
                  <td style={td}><SourceBadge source={r.source} /></td>
                  <td style={{ ...td, fontWeight:600 }}>{r.party || "—"}</td>
                  <td style={td}>
                    <div>{r.label || "—"}</div>
                    <RowDetail row={r} />
                  </td>
                  <td style={{ ...td, color: late ? "#C2410C" : "#666", whiteSpace:"nowrap" }}>{r.dueDate || "—"}</td>
                  <td style={{ ...td, textAlign:"right", color: late ? "#C2410C" : "#bbb", fontWeight: late ? 700 : 400, whiteSpace:"nowrap" }}>
                    {days == null ? "—" : late ? tr(`${days}d late`, `${days}d tarde`) : tr(`in ${-days}d`, `en ${-days}d`)}
                  </td>
                  <td style={{ ...td, textAlign:"right", fontWeight:700, whiteSpace:"nowrap" }}>{fmt$(r.amount)}</td>
                  <td style={{ ...td, textAlign:"right", whiteSpace:"nowrap" }}>
                    <RowActions row={r} tab={tab} can={can} Btn={Btn}
                      onOpenJob={onOpenJob} setPage={setPage}
                      onMarkBillingPaid={markBillingPaid}
                      onPayBill={(row) => { setPayRow(row); setPayAmount(String(row.amount)); }}
                      onEditBill={() => { const b = bills.find(x => x.id === r.ref.billId); if (b) openEditBill(b); }}
                      onDeleteBill={() => { const b = bills.find(x => x.id === r.ref.billId); if (b) deleteBill(b); }}
                      onMarkWeekPaid={markWeekPaid} />
                  </td>
                </tr>
              );
            })}
          </tbody>
          {visible.length > 0 && (
            <tfoot><tr style={{ borderTop:"1px solid #eee", background:"#fafafa" }}>
              <td style={{ ...td, fontWeight:700 }} colSpan={5}>Total</td>
              <td style={{ ...td, textAlign:"right", fontWeight:800 }}>{fmt$(sumRows(visible))}</td>
              <td style={td}></td>
            </tr></tfoot>
          )}
        </table>
      </div>

      <div style={{ fontSize:11.5, color:"#bbb", marginTop:10, lineHeight:1.6 }}>
        {tab === "receivable"
          ? tr("Job balances, monthly storage billing and broker settlements, read from the modules that own them. Collecting is done there.",
               "Balances de jobs, storage mensual y settlements de brokers, leídos de los módulos que los manejan. El cobro se hace ahí.")
          : tr("Bills, expenses with no matching bank movement yet, broker settlements against us and driver pay weeks. Cash a driver is holding is shown as a note, never subtracted from what he is owed.",
               "Facturas, gastos que todavía no tienen movimiento bancario que los respalde, settlements en contra y semanas de paga de drivers. El cash que tiene un driver se muestra como nota, nunca se resta de lo que se le debe.")}
      </div>

      {showBill && (
        <Modal title={editingBillId ? "Edit bill" : "New bill"} onClose={() => setShowBill(false)}
          footer={<>
            <Btn onClick={() => setShowBill(false)}>Cancel</Btn>
            <Btn primary disabled={saving} onClick={saveBill}>{saving ? "Saving…" : "Save"}</Btn>
          </>}>
          <Field label="Vendor">
            <input value={billForm.vendor} onChange={e => setBillForm(f => ({ ...f, vendor: e.target.value }))}
              placeholder="Geico, T-Mobile, CubeSmart…" style={inp} />
          </Field>
          <Field label="Category">
            <input list="apar-categories" value={billForm.category} onChange={e => setBillForm(f => ({ ...f, category: e.target.value }))}
              placeholder="Insurance, Rent, Software…" style={inp} />
            <datalist id="apar-categories">
              {bankCategories.filter(c => c.direction === "out" && c.active !== false).map(c => <option key={c.name} value={c.name} />)}
            </datalist>
          </Field>
          <Field label="Description">
            <input value={billForm.description} onChange={e => setBillForm(f => ({ ...f, description: e.target.value }))}
              placeholder="What this bill is for" style={inp} />
          </Field>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <div style={{ flex:"1 1 140px" }}>
              <Field label="Amount ($)">
                <input type="number" step="0.01" value={billForm.amount} onChange={e => setBillForm(f => ({ ...f, amount: e.target.value }))} style={inp} />
              </Field>
            </div>
            <div style={{ flex:"1 1 140px" }}>
              <Field label="Bill date">
                <input type="date" value={billForm.bill_date} onChange={e => setBillForm(f => ({ ...f, bill_date: e.target.value }))} style={inp} />
              </Field>
            </div>
            <div style={{ flex:"1 1 140px" }}>
              <Field label="Due date">
                <input type="date" value={billForm.due_date} onChange={e => setBillForm(f => ({ ...f, due_date: e.target.value }))} style={inp} />
              </Field>
            </div>
          </div>
          <div style={{ display:"flex", gap:10, flexWrap:"wrap" }}>
            <div style={{ flex:"1 1 140px" }}>
              <Field label="Repeats">
                <select value={billForm.recurrence} onChange={e => setBillForm(f => ({ ...f, recurrence: e.target.value }))} style={inp}>
                  {BILL_RECURRENCES.map(r => <option key={r} value={r}>{RECURRENCE_LABEL[r]}</option>)}
                </select>
              </Field>
            </div>
            <div style={{ flex:"1 1 140px" }}>
              <Field label="Pay from">
                <select value={billForm.paid_from} onChange={e => setBillForm(f => ({ ...f, paid_from: e.target.value }))} style={inp}>
                  {BILL_PAID_FROM.map(p => <option key={p} value={p}>{PAID_FROM_LABEL[p]}</option>)}
                </select>
              </Field>
            </div>
          </div>
          <Field label="Notes">
            <textarea value={billForm.notes} onChange={e => setBillForm(f => ({ ...f, notes: e.target.value }))} rows={2} style={{ ...inp, resize:"vertical" }} />
          </Field>
          {billForm.recurrence !== "once" && billForm.due_date && (
            <div style={{ fontSize:11.5, color:"#888" }}>
              {tr(`Once this one is paid, the next cycle opens on ${nextDueDate(billForm.due_date, billForm.recurrence)}.`,
                  `Cuando se pague ésta, el próximo ciclo vence el ${nextDueDate(billForm.due_date, billForm.recurrence)}.`)}
            </div>
          )}
        </Modal>
      )}

      {payRow && (
        <Modal title="Mark bill paid" onClose={() => setPayRow(null)}
          footer={<>
            <Btn onClick={() => setPayRow(null)}>Cancel</Btn>
            <Btn primary onClick={() => payBill(payRow, payAmount)}>Confirm payment</Btn>
          </>}>
          <div style={{ fontSize:13, marginBottom:12 }}>
            <b>{payRow.party || payRow.label}</b> · {tr(`${fmt$(payRow.amount)} outstanding`, `${fmt$(payRow.amount)} pendiente`)}
          </div>
          <Field label="Amount paid ($)">
            <input type="number" step="0.01" value={payAmount} onChange={e => setPayAmount(e.target.value)} style={inp} />
          </Field>
          <div style={{ fontSize:11.5, color:"#888" }}>
            {tr("Pay less than the balance and the remainder stays owed.", "Si pagás menos que el saldo, el resto sigue pendiente.")}
          </div>
        </Modal>
      )}
    </div>
  );
}

const RECURRENCE_LABEL = { once: "One-off", monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };
const PAID_FROM_LABEL = { bank: "Bank", company_card: "Company card", cash: "Cash", other: "Other" };

// The second line under the reference: whatever makes the row self-explanatory
// without opening its own module.
function RowDetail({ row }) {
  const s = { fontSize:11, color:"#aaa", marginTop:2 };
  const m = row.meta || {};
  if (row.source === "job") return <div style={s}>{[m.status && t(statusLabel(m.status)), m.driver].filter(Boolean).join(" · ")}</div>;
  if (row.source === "storage_billing") return <div style={s}>{m.periodStart} → {m.periodEnd}</div>;
  if (row.source === "expense") return <div style={s}>{[m.jobNumber, m.status && t(expenseStatusLabel(m.status))].filter(Boolean).join(" · ")}</div>;
  if (row.source === "bill") {
    const bits = [m.category];
    if (m.partial) bits.push(tr(`${fmt$(m.amountPaid)} of ${fmt$(m.amountTotal)} paid`, `${fmt$(m.amountPaid)} de ${fmt$(m.amountTotal)} pagado`));
    if (m.recurrence && m.recurrence !== "once") bits.push(t(RECURRENCE_LABEL[m.recurrence]));
    if (m.billSource === "storage_rent") bits.push(t("Auto from Storage"));
    return <div style={s}>{bits.filter(Boolean).join(" · ")}</div>;
  }
  if (row.source === "driver") {
    const bits = [];
    if (m.days) bits.push(tr(`${m.days} ${m.days === 1 ? "day" : "days"} · ${fmt$(m.labor)}`,
                             `${m.days} ${m.days === 1 ? "día" : "días"} · ${fmt$(m.labor)}`));
    if (m.commissions) bits.push(tr(`commissions ${fmt$(m.commissions)}`, `comisiones ${fmt$(m.commissions)}`));
    if (m.bonuses) bits.push(tr(`bonus ${fmt$(m.bonuses)}`, `bono ${fmt$(m.bonuses)}`));
    if (m.deductions) bits.push(tr(`deductions −${fmt$(m.deductions)}`, `deducciones −${fmt$(m.deductions)}`));
    return (
      <div style={s}>
        {bits.join(" · ")}
        {m.cashOnHand > 0 && (
          <div style={{ color:"#C2410C" }}>
            {tr(`Holds ${fmt$(m.cashOnHand)} in cash — settle it in Expenses`, `Tiene ${fmt$(m.cashOnHand)} en cash — se rinde en Expenses`)}
          </div>
        )}
      </div>
    );
  }
  return null;
}

const statusLabel = (v) => ({
  scheduled:"Scheduled", picked_up:"Picked up", in_storage:"In storage",
  out_for_delivery:"Out for delivery", delivered:"Delivered", cancelled:"Cancelled",
  on_hold:"On hold", redispatched:"Redispatched",
}[v] || v);
const expenseStatusLabel = (v) => ({ pending:"Pending", approved:"Approved", rejected:"Rejected" }[v] || v);

// Every action either writes to the table that owns the row or navigates to the
// module that does — the permission checked is that module's, not this one's.
function RowActions({ row, tab, can, Btn, onOpenJob, setPage, onMarkBillingPaid, onPayBill, onEditBill, onDeleteBill, onMarkWeekPaid }) {
  const mini = { padding:"4px 10px", fontSize:11.5 };
  if (tab === "receivable") {
    if (row.source === "job") return <Btn style={mini} onClick={() => onOpenJob?.(row.ref.jobKey)}>Open job</Btn>;
    if (row.source === "storage_billing") return (
      <Btn style={mini} disabled={!can("billing", "edit")} onClick={() => onMarkBillingPaid(row)}>Mark paid</Btn>
    );
    if (row.source === "settlement") return <Btn style={mini} onClick={() => setPage?.("settlements")}>Open sheet</Btn>;
    return null;
  }
  if (row.source === "bill") return (
    <span style={{ display:"inline-flex", gap:6 }}>
      <Btn style={mini} disabled={!can("apar", "edit")} onClick={() => onPayBill(row)}>Mark paid</Btn>
      <Btn style={mini} disabled={!can("apar", "edit")} onClick={onEditBill}>Edit</Btn>
      <Btn style={mini} danger disabled={!can("apar", "edit")} onClick={onDeleteBill}>Delete</Btn>
    </span>
  );
  if (row.source === "expense") return <Btn style={mini} onClick={() => setPage?.("expenses")}>Open expense</Btn>;
  if (row.source === "settlement") return <Btn style={mini} onClick={() => setPage?.("settlements")}>Open sheet</Btn>;
  if (row.source === "driver") return (
    // Stamping the week writes to driver_work_days, driver_adjustments and
    // job_extras — tables the Expenses and Extras sections own, so those are the
    // permissions this asks for.
    <Btn style={mini} disabled={!(can("expenses", "edit") && can("extras", "edit"))} onClick={() => onMarkWeekPaid(row)}>Mark week paid</Btn>
  );
  return null;
}
