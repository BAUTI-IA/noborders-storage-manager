// Bancos — the real bank ledger. Daily bank inflows/outflows land here (from
// homebanking screenshots read by AI, or a CSV export), get categorized against
// the chart of accounts, and go through a categorize→verify double-check by two
// different people. Tabs: Bandeja (review queue) · Cuentas · Conciliación
// (cross-check vs payments/expenses — "¿cuadra o no cuadra?") · P&L.
//
// Self-contained module (same pattern as MessagesSection/BolSection): receives
// supabase + session and manages its own data + realtime. Pure math lives in
// src/bankData.js so it's unit-testable with node.
import { useState, useMemo, useEffect, useCallback } from "react";
import {
  BANK_CATEGORIES, BANK_STATUS, bankCatMeta, isTransferCat,
  EMPTY_BANK_ACCOUNT, dedupHash, signedAmount,
  parseCsv, mapBankCsv, reconcileBank, bankPnl,
} from "./bankData.js";
import { numv } from "./analyticsData.js";

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };
const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
const fieldLabel = { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4, display:"block" };
const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(v).toLocaleString(undefined, { maximumFractionDigits: 2 });
const todayISO = () => new Date().toISOString().slice(0, 10);

function StatusBadge({ status }) {
  const c = BANK_STATUS[status] || BANK_STATUS.unreviewed;
  return <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:c.bg, color:c.text, whiteSpace:"nowrap" }}>{c.l}</span>;
}
function CatChip({ category }) {
  const c = bankCatMeta(category);
  if (!c) return <span style={{ fontSize:11, color:"#bbb" }}>Sin categoría</span>;
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
const CategorySelect = ({ value, onChange, style }) => (
  <select value={value || ""} onChange={e => onChange(e.target.value)} style={{ ...inp, ...style }}>
    <option value="">— categoría —</option>
    <optgroup label="Ingresos">
      {BANK_CATEGORIES.filter(c => c.dir === "in").map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
    </optgroup>
    <optgroup label="Egresos">
      {BANK_CATEGORIES.filter(c => c.dir === "out").map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
    </optgroup>
    <optgroup label="Transferencias">
      {BANK_CATEGORIES.filter(c => c.dir === "transfer").map(c => <option key={c.v} value={c.v}>{c.icon} {c.l}</option>)}
    </optgroup>
  </select>
);

export function BancosSection({ supabase, session, profile, payments = [], expenses = [], can = () => true, Btn, Modal }) {
  const myName = profile?.full_name || session?.user?.email || "";
  const canEdit = can("bancos", "edit");
  const canCreate = can("bancos", "create");

  const [missing, setMissing] = useState(false);
  const [accounts, setAccounts] = useState([]);
  const [txns, setTxns] = useState([]);
  const [tab, setTab] = useState("bandeja");
  const [error, setError] = useState("");

  // ── Data + realtime ────────────────────────────────────────────────────────
  const loadAccounts = useCallback(async () => {
    const { data, error } = await supabase.from("bank_accounts").select("*").order("name", { ascending: true });
    if (error) { if (/does not exist|relation/i.test(error.message)) setMissing(true); return; }
    setMissing(false); setAccounts(data || []);
  }, [supabase]);
  const loadTxns = useCallback(async () => {
    const { data, error } = await supabase.from("bank_transactions").select("*").order("txn_date", { ascending: false }).order("id", { ascending: false }).limit(2000);
    if (!error) setTxns(data || []);
  }, [supabase]);

  useEffect(() => { loadAccounts(); loadTxns(); }, [loadAccounts, loadTxns]);
  useEffect(() => {
    if (missing) return;
    const ch = supabase.channel("bank-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "bank_accounts" }, () => loadAccounts())
      .on("postgres_changes", { event: "*", schema: "public", table: "bank_transactions" }, () => loadTxns())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [supabase, missing, loadAccounts, loadTxns]);

  // ── Review actions (the double-check state machine) ────────────────────────
  const stamp = { updated_by: myName, updated_at: new Date().toISOString() };
  const setCategory = async (t, category) => {
    if (!canEdit) return;
    await supabase.from("bank_transactions").update({ category, ...stamp }).eq("id", t.id);
    loadTxns();
  };
  const categorize = async (t) => {
    if (!canEdit) return;
    if (!t.category) { window.alert("Elegí una categoría antes de confirmar."); return; }
    await supabase.from("bank_transactions").update({
      status: "categorized", categorized_by: myName, categorized_at: new Date().toISOString(), ...stamp,
    }).eq("id", t.id);
    loadTxns();
  };
  const verify = async (t) => {
    if (!canEdit) return;
    // Anti-theft rule: the verifier must be a DIFFERENT person than whoever categorized.
    if (t.categorized_by && t.categorized_by === myName) {
      window.alert("Doble check: quien verifica tiene que ser una persona distinta de quien categorizó (" + t.categorized_by + ").");
      return;
    }
    await supabase.from("bank_transactions").update({
      status: "verified", verified_by: myName, verified_at: new Date().toISOString(), ...stamp,
    }).eq("id", t.id);
    loadTxns();
  };
  const reopen = async (t) => {
    if (!canEdit) return;
    await supabase.from("bank_transactions").update({ status: "categorized", verified_by: null, verified_at: null, ...stamp }).eq("id", t.id);
    loadTxns();
  };
  const setIgnored = async (t, ignored) => {
    if (!canEdit) return;
    await supabase.from("bank_transactions").update({ status: ignored ? "ignored" : "unreviewed", ...stamp }).eq("id", t.id);
    loadTxns();
  };
  const removeTxn = async (t) => {
    if (!canEdit) return;
    if (!window.confirm("¿Borrar este movimiento del ledger bancario?")) return;
    await supabase.from("bank_transactions").delete().eq("id", t.id);
    loadTxns();
  };

  if (missing) {
    return (
      <div style={{ background:"#FFF7ED", border:"1px solid #FED7AA", borderRadius:12, padding:20, fontSize:13.5, color:"#9A3412" }}>
        <b>El módulo Bancos todavía no está instalado en la base.</b>
        <div style={{ marginTop:6 }}>Corré la migración y recargá:</div>
        <pre style={{ background:"#fff", border:"1px solid #eee", borderRadius:8, padding:10, fontSize:12, marginTop:8 }}>SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-bank.mjs</pre>
      </div>
    );
  }

  const TABS = [["bandeja", "Bandeja"], ["cuentas", "Cuentas"], ["conciliacion", "Conciliación"], ["pnl", "P&L"]];
  return (
    <div>
      <div style={{ display:"flex", gap:6, marginBottom:14, flexWrap:"wrap" }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)}
            style={{ padding:"7px 14px", borderRadius:20, border:"1px solid " + (tab === v ? "#111" : "#e5e5e5"), background: tab === v ? "#111" : "#fff", color: tab === v ? "#fff" : "#555", fontSize:12.5, fontWeight:600, cursor:"pointer" }}>
            {l}{v === "bandeja" && txns.filter(t => t.status === "unreviewed").length > 0 && <span style={{ marginLeft:6, background: tab === v ? "#fff" : "#E24B4A", color: tab === v ? "#111" : "#fff", fontSize:10, fontWeight:700, borderRadius:10, padding:"1px 6px" }}>{txns.filter(t => t.status === "unreviewed").length}</span>}
          </button>
        ))}
      </div>
      {error && <div style={{ background:"#FCEBEB", color:"#A32D2D", borderRadius:8, padding:"8px 12px", fontSize:12.5, marginBottom:10 }}>{error}</div>}

      {tab === "bandeja" && (
        <InboxTab txns={txns} accounts={accounts} canEdit={canEdit} canCreate={canCreate} myName={myName}
          supabase={supabase} session={session} onReload={loadTxns} setError={setError}
          setCategory={setCategory} categorize={categorize} verify={verify} reopen={reopen} setIgnored={setIgnored} removeTxn={removeTxn}
          Btn={Btn} Modal={Modal} />
      )}
      {tab === "cuentas" && (
        <AccountsTab accounts={accounts} txns={txns} supabase={supabase} canCreate={canCreate} canEdit={canEdit} onReload={loadAccounts} Btn={Btn} Modal={Modal} />
      )}
      {tab === "conciliacion" && <ReconTab txns={txns} payments={payments} expenses={expenses} />}
      {tab === "pnl" && <PnlTab txns={txns} />}
    </div>
  );
}

// ── Tab: Bandeja (review queue + import) ─────────────────────────────────────
function InboxTab(props) {
  const { txns, accounts, canEdit, canCreate, supabase, session, onReload, setError,
    setCategory, categorize, verify, reopen, setIgnored, removeTxn, Btn, Modal } = props;
  const [fStatus, setFStatus] = useState("");
  const [fAccount, setFAccount] = useState("");
  const [fDir, setFDir] = useState("");
  const [fFrom, setFFrom] = useState("");
  const [fTo, setFTo] = useState("");
  const [fSearch, setFSearch] = useState("");
  const [showImport, setShowImport] = useState(false);

  const accName = (id) => accounts.find(a => a.id === id)?.name || "—";
  const filtered = useMemo(() => txns.filter(t => {
    if (fStatus && t.status !== fStatus) return false;
    if (fAccount && String(t.bank_account_id) !== fAccount) return false;
    if (fDir === "in" && signedAmount(t) < 0) return false;
    if (fDir === "out" && signedAmount(t) >= 0) return false;
    if (fFrom && (t.txn_date || "") < fFrom) return false;
    if (fTo && (t.txn_date || "") > fTo) return false;
    if (fSearch && !(t.raw_description || "").toLowerCase().includes(fSearch.toLowerCase())) return false;
    return true;
  }), [txns, fStatus, fAccount, fDir, fFrom, fTo, fSearch]);

  const totals = useMemo(() => {
    let tin = 0, tout = 0;
    for (const t of filtered) { const a = signedAmount(t); if (a >= 0) tin += a; else tout += a; }
    return { tin, tout };
  }, [filtered]);

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:10, marginBottom:14 }}>
        <Tile label="Sin revisar" value={txns.filter(t => t.status === "unreviewed").length} color="#92760B" />
        <Tile label="Inflows (filtro)" value={fmt$(totals.tin)} color="#3B6D11" />
        <Tile label="Outflows (filtro)" value={fmt$(totals.tout)} color="#A32D2D" />
        <Tile label="Neto (filtro)" value={fmt$(totals.tin + totals.tout)} />
      </div>

      <div style={{ display:"flex", gap:8, flexWrap:"wrap", marginBottom:12, alignItems:"center" }}>
        <select value={fStatus} onChange={e => setFStatus(e.target.value)} style={{ ...inp, width:"auto" }}>
          <option value="">Todos los estados</option>
          {Object.entries(BANK_STATUS).map(([v, c]) => <option key={v} value={v}>{c.l}</option>)}
        </select>
        <select value={fAccount} onChange={e => setFAccount(e.target.value)} style={{ ...inp, width:"auto" }}>
          <option value="">Todas las cuentas</option>
          {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
        </select>
        <select value={fDir} onChange={e => setFDir(e.target.value)} style={{ ...inp, width:"auto" }}>
          <option value="">In + Out</option><option value="in">Inflows</option><option value="out">Outflows</option>
        </select>
        <input type="date" value={fFrom} onChange={e => setFFrom(e.target.value)} style={{ ...inp, width:"auto" }} />
        <input type="date" value={fTo} onChange={e => setFTo(e.target.value)} style={{ ...inp, width:"auto" }} />
        <input placeholder="Buscar descripción…" value={fSearch} onChange={e => setFSearch(e.target.value)} style={{ ...inp, width:180 }} />
        {canCreate && <Btn onClick={() => setShowImport(true)}>⬆ Importar movimientos</Btn>}
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ borderBottom:"1px solid #f3f3f3" }}>
            {["Fecha", "Cuenta", "Descripción", "Monto", "Categoría", "Estado", "Quién", ""].map((h, i) => <th key={i} style={th}>{h}</th>)}
          </tr></thead>
          <tbody>
            {filtered.length === 0 && <tr><td colSpan={8} style={{ ...td, color:"#bbb", textAlign:"center", padding:24 }}>Sin movimientos. Importá un screenshot o CSV del banco.</td></tr>}
            {filtered.map(t => {
              const amt = signedAmount(t);
              return (
                <tr key={t.id} style={{ borderBottom:"1px solid #f7f7f7", opacity: t.status === "ignored" ? 0.5 : 1 }}>
                  <td style={{ ...td, whiteSpace:"nowrap" }}>{t.txn_date || "—"}</td>
                  <td style={{ ...td, fontSize:11.5, color:"#888" }}>{accName(t.bank_account_id)}</td>
                  <td style={{ ...td, maxWidth:280 }}>
                    <div style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={t.raw_description}>{t.raw_description || "—"}</div>
                    {t.ai_suggested_category && t.status === "unreviewed" && (
                      <div style={{ fontSize:10.5, color:"#7C3AED" }}>🤖 sugiere: {bankCatMeta(t.ai_suggested_category)?.l || t.ai_suggested_category}{t.ai_confidence != null ? ` (${Math.round(numv(t.ai_confidence) * 100)}%)` : ""}</div>
                    )}
                  </td>
                  <td style={{ ...td, fontWeight:700, whiteSpace:"nowrap", color: amt >= 0 ? "#3B6D11" : "#A32D2D" }}>{fmt$(amt)}</td>
                  <td style={{ ...td, minWidth:170 }}>
                    {t.status === "verified" || !canEdit
                      ? <CatChip category={t.category} />
                      : <CategorySelect value={t.category} onChange={v => setCategory(t, v)} style={{ fontSize:12, padding:"5px 8px" }} />}
                  </td>
                  <td style={td}><StatusBadge status={t.status} /></td>
                  <td style={{ ...td, fontSize:10.5, color:"#999", whiteSpace:"nowrap" }}>
                    {t.categorized_by && <div>✍ {t.categorized_by}</div>}
                    {t.verified_by && <div>✔ {t.verified_by}</div>}
                  </td>
                  <td style={{ ...td, whiteSpace:"nowrap" }}>
                    {canEdit && t.status === "unreviewed" && <Btn style={{ fontSize:12, padding:"4px 10px" }} onClick={() => categorize(t)}>Categorizar</Btn>}
                    {canEdit && t.status === "categorized" && <Btn style={{ fontSize:12, padding:"4px 10px" }} onClick={() => verify(t)}>✔ Verificar</Btn>}
                    {canEdit && t.status === "verified" && <Btn style={{ fontSize:12, padding:"4px 10px" }} onClick={() => reopen(t)}>Reabrir</Btn>}
                    {canEdit && t.status !== "verified" && (
                      <button onClick={() => setIgnored(t, t.status !== "ignored")} title={t.status === "ignored" ? "Restaurar" : "Ignorar"} style={{ border:"none", background:"transparent", cursor:"pointer", color:"#bbb", fontSize:13, marginLeft:4 }}>
                        {t.status === "ignored" ? "↩" : "🚫"}
                      </button>
                    )}
                    {canEdit && <button onClick={() => removeTxn(t)} title="Borrar" style={{ border:"none", background:"transparent", cursor:"pointer", color:"#ccc", fontSize:13, marginLeft:2 }}>🗑</button>}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showImport && (
        <ImportModal accounts={accounts} supabase={supabase} session={session}
          onClose={() => setShowImport(false)} onDone={() => { setShowImport(false); onReload(); }}
          setError={setError} Btn={Btn} Modal={Modal} />
      )}
    </div>
  );
}

// ── Import modal: screenshot (AI vision) or CSV ──────────────────────────────
function ImportModal({ accounts, supabase, session, onClose, onDone, setError, Btn, Modal }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || "");
  const [mode, setMode] = useState("screenshot"); // screenshot | csv
  const [busy, setBusy] = useState(false);
  const [drafts, setDrafts] = useState([]);       // extracted lines pending confirm
  const [fileRef, setFileRef] = useState("");
  // CSV column mapping
  const [csvRows, setCsvRows] = useState(null);
  const [map, setMap] = useState({ date:"", description:"", amount:"", debit:"", credit:"" });

  const readAsBase64 = (file) => new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1]);
    r.onerror = reject;
    r.readAsDataURL(file);
  });

  const onScreenshot = async (file) => {
    setBusy(true); setError("");
    try {
      // Keep the evidence: upload the screenshot to the bank-screenshots bucket.
      const path = `${Date.now()}-${file.name.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
      let publicUrl = "";
      const up = await supabase.storage.from("bank-screenshots").upload(path, file, { upsert: true });
      if (!up.error) publicUrl = supabase.storage.from("bank-screenshots").getPublicUrl(path).data.publicUrl;
      setFileRef(publicUrl || file.name);

      const b64 = await readAsBase64(file);
      const res = await fetch("/api/bank-analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ image_base64: b64, media_type: file.type || "image/jpeg" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "AI error");
      const lines = (json.lines || []).map(l => ({
        txn_date: l.date || "", raw_description: l.description || "",
        amount: l.direction === "out" ? -Math.abs(numv(l.amount)) : Math.abs(numv(l.amount)),
        direction: l.direction, category: l.category || "", ai_suggested_category: l.category || "",
        ai_confidence: l.confidence ?? null, source: "screenshot", keep: true,
      }));
      if (!lines.length) setError("La IA no encontró movimientos en la imagen. Probá con una captura más clara.");
      setDrafts(d => [...d, ...lines]);
    } catch (e) { setError(e.message || "Error leyendo el screenshot."); }
    setBusy(false);
  };

  const onCsvFile = async (file) => {
    setBusy(true); setError("");
    try {
      const text = await file.text();
      const rows = parseCsv(text);
      if (!rows.length) throw new Error("El CSV está vacío.");
      setFileRef(file.name);
      setCsvRows(rows);
      // Best-effort auto-map by common header names.
      const h = rows[0].map(x => x.toLowerCase().trim());
      const find = (...names) => { const i = h.findIndex(c => names.some(n => c.includes(n))); return i >= 0 ? rows[0][i] : ""; };
      setMap({
        date: find("date", "fecha"), description: find("desc", "detail", "detalle", "memo", "concepto"),
        amount: find("amount", "monto", "importe"), debit: find("debit", "débito", "debito", "withdrawal"), credit: find("credit", "crédito", "credito", "deposit"),
      });
    } catch (e) { setError(e.message || "Error leyendo el CSV."); }
    setBusy(false);
  };

  const applyCsvMap = async () => {
    setBusy(true); setError("");
    try {
      const mapping = { date: map.date, description: map.description };
      if (map.amount) mapping.amount = map.amount; else { mapping.debit = map.debit; mapping.credit = map.credit; }
      const parsed = mapBankCsv(csvRows, mapping, { bank_account_id: accountId || null });
      if (!parsed.length) throw new Error("No salieron movimientos con ese mapeo de columnas.");
      let lines = parsed.map(p => ({ ...p, category: "", ai_suggested_category: "", ai_confidence: null, keep: true }));
      // Batch AI category suggestion (best-effort — import works without it).
      try {
        const res = await fetch("/api/bank-analyze", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
          body: JSON.stringify({ descriptions: lines.map(l => ({ description: l.raw_description, amount: Math.abs(l.amount), direction: l.direction })) }),
        });
        const json = await res.json();
        if (res.ok) for (const s of (json.lines || [])) {
          const l = lines[s.i];
          if (l && s.category) { l.category = s.category; l.ai_suggested_category = s.category; l.ai_confidence = s.confidence ?? null; }
        }
      } catch { /* suggestions are optional */ }
      setDrafts(d => [...d, ...lines]);
      setCsvRows(null);
    } catch (e) { setError(e.message || "Error mapeando el CSV."); }
    setBusy(false);
  };

  const confirmImport = async () => {
    if (!accountId) { setError("Elegí a qué cuenta bancaria pertenece este extracto."); return; }
    const keep = drafts.filter(d => d.keep && (d.txn_date || d.raw_description));
    if (!keep.length) { setError("No hay movimientos para importar."); return; }
    setBusy(true); setError("");
    try {
      const { data: batch, error: bErr } = await supabase.from("bank_import_batches").insert({
        bank_account_id: accountId, source: mode, file_ref: fileRef || null,
        rows_extracted: drafts.length, rows_imported: keep.length,
        created_by: session?.user?.email || null,
      }).select("id").single();
      if (bErr) throw bErr;
      const rows = keep.map(d => {
        const base = {
          bank_account_id: accountId, import_batch_id: batch.id,
          txn_date: d.txn_date || null, amount: d.amount, direction: d.amount < 0 ? "out" : "in",
          raw_description: d.raw_description || null, category: d.category || null,
          ai_suggested_category: d.ai_suggested_category || null, ai_confidence: d.ai_confidence,
          status: "unreviewed", source: mode, source_ref: fileRef || null,
          created_by: session?.user?.email || null,
        };
        return { ...base, dedup_hash: dedupHash({ ...base, bank_account_id: accountId }) };
      });
      // The unique dedup index silently rejects duplicates from re-uploads.
      const { error: iErr } = await supabase.from("bank_transactions").upsert(rows, { onConflict: "dedup_hash", ignoreDuplicates: true });
      if (iErr) throw iErr;
      onDone();
    } catch (e) { setError(e.message || "Error importando."); }
    setBusy(false);
  };

  return (
    <Modal title="Importar movimientos del banco" onClose={onClose}>
      <div style={{ display:"flex", gap:10, marginBottom:12, alignItems:"flex-end", flexWrap:"wrap" }}>
        <div style={{ minWidth:200 }}>
          <Field label="Cuenta bancaria">
            <select style={inp} value={accountId} onChange={e => setAccountId(e.target.value)}>
              <option value="">— elegir —</option>
              {accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select>
          </Field>
        </div>
        <div style={{ display:"flex", gap:6, marginBottom:10 }}>
          {[["screenshot", "📸 Screenshot (IA)"], ["csv", "📄 CSV del banco"]].map(([v, l]) => (
            <button key={v} onClick={() => setMode(v)} style={{ padding:"7px 12px", borderRadius:8, border:"1px solid " + (mode === v ? "#111" : "#e5e5e5"), background: mode === v ? "#111" : "#fff", color: mode === v ? "#fff" : "#555", fontSize:12.5, fontWeight:600, cursor:"pointer" }}>{l}</button>
          ))}
        </div>
      </div>

      {mode === "screenshot" && (
        <div onClick={() => !busy && document.getElementById("bank-shot-input")?.click()}
          style={{ border:"2px dashed #ddd", borderRadius:10, padding:18, textAlign:"center", background:"#fafafa", cursor:"pointer", fontSize:12.5, color:"#888", marginBottom:12 }}>
          {busy ? "Leyendo el extracto con IA…" : "Tocá para subir capturas del homebanking (jpg/png). La IA extrae cada línea; después revisás antes de importar."}
          <input id="bank-shot-input" type="file" accept="image/*" multiple style={{ display:"none" }}
            onChange={async e => { for (const f of Array.from(e.target.files || [])) await onScreenshot(f); e.target.value = ""; }} />
        </div>
      )}

      {mode === "csv" && !csvRows && (
        <div onClick={() => !busy && document.getElementById("bank-csv-input")?.click()}
          style={{ border:"2px dashed #ddd", borderRadius:10, padding:18, textAlign:"center", background:"#fafafa", cursor:"pointer", fontSize:12.5, color:"#888", marginBottom:12 }}>
          {busy ? "Procesando…" : "Tocá para subir el CSV exportado del banco (si tu banco exporta Excel, guardalo como CSV primero)."}
          <input id="bank-csv-input" type="file" accept=".csv,text/csv" style={{ display:"none" }}
            onChange={e => { const f = e.target.files[0]; if (f) onCsvFile(f); e.target.value = ""; }} />
        </div>
      )}

      {mode === "csv" && csvRows && (
        <div style={{ background:"#F8FAFC", border:"1px solid #E2E8F0", borderRadius:10, padding:12, marginBottom:12 }}>
          <div style={{ fontSize:12.5, fontWeight:700, marginBottom:8 }}>Mapeo de columnas ({csvRows.length - 1} filas)</div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:8 }}>
            {[["date", "Fecha"], ["description", "Descripción"], ["amount", "Monto (con signo)"], ["debit", "Débito"], ["credit", "Crédito"]].map(([k, l]) => (
              <div key={k}>
                <span style={fieldLabel}>{l}</span>
                <select style={inp} value={map[k]} onChange={e => setMap(m => ({ ...m, [k]: e.target.value }))}>
                  <option value="">—</option>
                  {csvRows[0].map((h, i) => <option key={i} value={h}>{h}</option>)}
                </select>
              </div>
            ))}
          </div>
          <div style={{ fontSize:11, color:"#888", marginTop:6 }}>Usá “Monto” si el CSV trae una sola columna con signo, o “Débito”+“Crédito” si vienen separadas.</div>
          <div style={{ marginTop:10 }}><Btn onClick={applyCsvMap} disabled={busy}>{busy ? "Procesando…" : "Extraer movimientos"}</Btn></div>
        </div>
      )}

      {drafts.length > 0 && (
        <div>
          <div style={{ fontSize:12.5, fontWeight:700, margin:"6px 0" }}>Revisá antes de importar ({drafts.filter(d => d.keep).length} de {drafts.length} seleccionados)</div>
          <div style={{ maxHeight:300, overflowY:"auto", border:"1px solid #efefef", borderRadius:10 }}>
            <table style={{ width:"100%", borderCollapse:"collapse" }}>
              <thead><tr style={{ borderBottom:"1px solid #f3f3f3" }}>{["", "Fecha", "Descripción", "Monto", "Categoría (IA, editable)"].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
              <tbody>
                {drafts.map((d, i) => (
                  <tr key={i} style={{ borderBottom:"1px solid #f7f7f7", opacity: d.keep ? 1 : 0.45 }}>
                    <td style={td}><input type="checkbox" checked={!!d.keep} onChange={e => setDrafts(ds => ds.map((x, j) => j === i ? { ...x, keep: e.target.checked } : x))} /></td>
                    <td style={td}><input type="date" value={d.txn_date} onChange={e => setDrafts(ds => ds.map((x, j) => j === i ? { ...x, txn_date: e.target.value } : x))} style={{ ...inp, width:130, padding:"4px 6px", fontSize:12 }} /></td>
                    <td style={{ ...td, maxWidth:260, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }} title={d.raw_description}>{d.raw_description}</td>
                    <td style={{ ...td, fontWeight:700, color: d.amount >= 0 ? "#3B6D11" : "#A32D2D", whiteSpace:"nowrap" }}>{fmt$(d.amount)}</td>
                    <td style={{ ...td, minWidth:160 }}><CategorySelect value={d.category} onChange={v => setDrafts(ds => ds.map((x, j) => j === i ? { ...x, category: v } : x))} style={{ fontSize:12, padding:"4px 6px" }} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div style={{ display:"flex", gap:8, marginTop:12, justifyContent:"flex-end" }}>
            <Btn onClick={() => setDrafts([])}>Limpiar</Btn>
            <Btn onClick={confirmImport} disabled={busy}>{busy ? "Importando…" : `Importar ${drafts.filter(d => d.keep).length} movimientos`}</Btn>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ── Tab: Cuentas ─────────────────────────────────────────────────────────────
function AccountsTab({ accounts, txns, supabase, canCreate, canEdit, onReload, Btn, Modal }) {
  const [showModal, setShowModal] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [form, setForm] = useState(EMPTY_BANK_ACCOUNT);
  const [saving, setSaving] = useState(false);

  const balanceOf = (a) => numv(a.opening_balance) + txns.filter(t => t.bank_account_id === a.id && t.status !== "ignored").reduce((s, t) => s + signedAmount(t), 0);

  const openAdd = () => { setEditingId(null); setForm(EMPTY_BANK_ACCOUNT); setShowModal(true); };
  const openEdit = (a) => {
    setEditingId(a.id);
    setForm({ name: a.name || "", bank_name: a.bank_name || "", account_last4: a.account_last4 || "", type: a.type || "checking", currency: a.currency || "USD", opening_balance: a.opening_balance ?? "", opening_date: a.opening_date || "", notes: a.notes || "" });
    setShowModal(true);
  };
  const save = async () => {
    if (!form.name.trim()) { window.alert("La cuenta necesita un nombre."); return; }
    setSaving(true);
    const payload = { ...form, opening_balance: form.opening_balance === "" ? 0 : numv(form.opening_balance), opening_date: form.opening_date || null };
    const q = editingId ? supabase.from("bank_accounts").update(payload).eq("id", editingId) : supabase.from("bank_accounts").insert(payload);
    const { error } = await q;
    setSaving(false);
    if (error) { window.alert(error.message); return; }
    setShowModal(false); onReload();
  };
  const toggleActive = async (a) => { await supabase.from("bank_accounts").update({ active: !a.active }).eq("id", a.id); onReload(); };

  return (
    <div>
      {canCreate && <div style={{ marginBottom:12 }}><Btn onClick={openAdd}>＋ Nueva cuenta</Btn></div>}
      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse" }}>
          <thead><tr style={{ borderBottom:"1px solid #f3f3f3" }}>{["Cuenta", "Banco", "Tipo", "Saldo calculado", "Movimientos", "Activa", ""].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
          <tbody>
            {accounts.map(a => (
              <tr key={a.id} style={{ borderBottom:"1px solid #f7f7f7", opacity: a.active === false ? 0.5 : 1 }}>
                <td style={{ ...td, fontWeight:600 }}>{a.name}{a.account_last4 ? <span style={{ color:"#999", fontWeight:400 }}> ····{a.account_last4}</span> : null}</td>
                <td style={td}>{a.bank_name || "—"}</td>
                <td style={td}>{a.type || "checking"}</td>
                <td style={{ ...td, fontWeight:700 }}>{fmt$(balanceOf(a))}</td>
                <td style={td}>{txns.filter(t => t.bank_account_id === a.id).length}</td>
                <td style={td}>{a.active === false ? "No" : "Sí"}</td>
                <td style={{ ...td, whiteSpace:"nowrap" }}>
                  {canEdit && <Btn style={{ fontSize:12, padding:"4px 10px" }} onClick={() => openEdit(a)}>Editar</Btn>}
                  {canEdit && <button onClick={() => toggleActive(a)} style={{ border:"none", background:"transparent", cursor:"pointer", color:"#bbb", fontSize:12, marginLeft:6 }}>{a.active === false ? "Activar" : "Desactivar"}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize:11, color:"#999", marginTop:8 }}>Saldo calculado = saldo inicial + Σ movimientos importados (excluye ignorados). Si no coincide con el banco, faltan movimientos por importar.</div>

      {showModal && (
        <Modal title={editingId ? "Editar cuenta" : "Nueva cuenta bancaria"} onClose={() => setShowModal(false)}>
          <Field label="Nombre"><input style={inp} value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} placeholder="Chase Operativa" /></Field>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Banco"><input style={inp} value={form.bank_name} onChange={e => setForm(f => ({ ...f, bank_name: e.target.value }))} placeholder="Chase" /></Field>
            <Field label="Últimos 4"><input style={inp} value={form.account_last4} onChange={e => setForm(f => ({ ...f, account_last4: e.target.value }))} maxLength={4} /></Field>
            <Field label="Tipo">
              <select style={inp} value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))}>
                <option value="checking">Checking</option><option value="savings">Savings</option><option value="credit_card">Credit card</option>
              </select>
            </Field>
            <Field label="Moneda"><input style={inp} value={form.currency} disabled /></Field>
            <Field label="Saldo inicial"><input style={inp} type="number" value={form.opening_balance} onChange={e => setForm(f => ({ ...f, opening_balance: e.target.value }))} /></Field>
            <Field label="Fecha saldo inicial"><input style={inp} type="date" value={form.opening_date} onChange={e => setForm(f => ({ ...f, opening_date: e.target.value }))} /></Field>
          </div>
          <Field label="Notas"><input style={inp} value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} /></Field>
          <div style={{ display:"flex", justifyContent:"flex-end", gap:8, marginTop:12 }}>
            <Btn onClick={() => setShowModal(false)}>Cancelar</Btn>
            <Btn onClick={save} disabled={saving}>{saving ? "Guardando…" : "Guardar"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Tab: Conciliación ────────────────────────────────────────────────────────
function ReconTab({ txns, payments, expenses }) {
  const recon = useMemo(() => reconcileBank({ bankTxns: txns, payments, expenses }), [txns, payments, expenses]);
  const KIND_LABEL = {
    bank_no_backing: { l:"Banco sin respaldo", color:"#A32D2D", hint:"Plata que se movió en el banco y nadie registró en la operación. Investigar." },
    payment_no_bank: { l:"Cobro que no llegó al banco", color:"#C2410C", hint:"Un cobro marcado como depositado que no aparece en el extracto. ¿Dónde está?" },
    expense_no_bank: { l:"Gasto sin línea en el banco", color:"#92760B", hint:"Un gasto cargado como pagado por banco que el extracto no muestra (o falta importar ese período)." },
  };
  const groups = ["bank_no_backing", "payment_no_bank", "expense_no_bank"].map(k => ({ k, ...KIND_LABEL[k], items: recon.discrepancies.filter(d => d.kind === k) }));

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:10, marginBottom:16 }}>
        <Tile label="Movimientos matcheados" value={recon.matchedCount} color="#3B6D11" sub={`in ${fmt$(recon.balances.matchedIn)} · out ${fmt$(recon.balances.matchedOut)}`} />
        <Tile label="Discrepancias" value={recon.discrepancies.length} color={recon.discrepancies.length ? "#A32D2D" : "#3B6D11"} sub={recon.discrepancies.length ? "Los números NO dan — revisar abajo" : "Los números dan ✓"} />
        <Tile label="Transferencias internas" value={recon.transfersCount} sub="Excluidas del P&L y del cruce" />
      </div>
      <div style={{ fontSize:12, color:"#888", marginBottom:14 }}>
        💡 El cruce matchea cada línea del banco contra <b>Payments</b> (cobros depositados) y <b>Expenses</b> (gastos pagados por banco) por monto y fecha (±días). Lo que no matchea es una discrepancia para investigar con el equipo — ahí es donde aparece si falta plata.
      </div>
      {groups.map(g => (
        <div key={g.k} style={{ marginBottom:18 }}>
          <div style={{ fontSize:13, fontWeight:700, color:g.color, marginBottom:6 }}>{g.l} · {g.items.length}</div>
          <div style={{ fontSize:11, color:"#999", marginBottom:6 }}>{g.hint}</div>
          {g.items.length === 0 ? <div style={{ fontSize:12, color:"#bbb" }}>Nada acá. ✓</div> : (
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflowX:"auto" }}>
              <table style={{ width:"100%", borderCollapse:"collapse" }}>
                <thead><tr style={{ borderBottom:"1px solid #f3f3f3" }}>{["Fecha", "Detalle", "Monto"].map((h, i) => <th key={i} style={th}>{h}</th>)}</tr></thead>
                <tbody>
                  {g.items.map((d, i) => {
                    const date = d.txn?.txn_date || d.payment?.banked_date || d.payment?.received_date || d.expense?.expense_date || "—";
                    const detail = d.txn?.raw_description || (d.payment ? `Payment #${d.payment.id}${d.payment.method ? " · " + d.payment.method : ""}` : "") || (d.expense ? `${d.expense.vendor || "Expense"} #${d.expense.id}${d.expense.category ? " · " + d.expense.category : ""}` : "");
                    return (
                      <tr key={i} style={{ borderBottom:"1px solid #f7f7f7" }}>
                        <td style={{ ...td, whiteSpace:"nowrap" }}>{date}</td>
                        <td style={td}>{detail}<div style={{ fontSize:10.5, color:"#bbb" }}>{d.reason}</div></td>
                        <td style={{ ...td, fontWeight:700, whiteSpace:"nowrap", color:g.color }}>{fmt$(Math.abs(d.amount))}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}
    </div>
  );
}

// ── Tab: P&L bancario ────────────────────────────────────────────────────────
function PnlTab({ txns }) {
  const now = todayISO();
  const [from, setFrom] = useState(now.slice(0, 7) + "-01");
  const [to, setTo] = useState(now);
  const [onlyVerified, setOnlyVerified] = useState(true);
  const pnl = useMemo(() => bankPnl({ bankTxns: txns, from, to, onlyVerified }), [txns, from, to, onlyVerified]);
  const maxAbs = Math.max(1, ...pnl.categories.map(c => Math.abs(c.total)));

  return (
    <div>
      <div style={{ display:"flex", gap:8, alignItems:"center", marginBottom:14, flexWrap:"wrap" }}>
        <input type="date" value={from} onChange={e => setFrom(e.target.value)} style={{ ...inp, width:"auto" }} />
        <span style={{ color:"#bbb" }}>→</span>
        <input type="date" value={to} onChange={e => setTo(e.target.value)} style={{ ...inp, width:"auto" }} />
        <label style={{ fontSize:12.5, color:"#555", display:"flex", alignItems:"center", gap:6, marginLeft:8 }}>
          <input type="checkbox" checked={onlyVerified} onChange={e => setOnlyVerified(e.target.checked)} />
          Solo movimientos verificados
        </label>
      </div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(160px, 1fr))", gap:10, marginBottom:16 }}>
        <Tile label="Ingresos" value={fmt$(pnl.income)} color="#3B6D11" />
        <Tile label="Egresos" value={fmt$(-pnl.expense)} color="#A32D2D" />
        <Tile label="Resultado neto" value={fmt$(pnl.net)} color={pnl.net >= 0 ? "#3B6D11" : "#A32D2D"} sub={`${pnl.count} movimientos · transferencias excluidas`} />
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:14, marginBottom:16 }}>
        <div style={{ fontSize:12.5, fontWeight:700, marginBottom:10 }}>Por categoría</div>
        {pnl.categories.length === 0 && <div style={{ fontSize:12, color:"#bbb" }}>Sin movimientos en el período{onlyVerified ? " (o nada verificado todavía)" : ""}.</div>}
        {pnl.categories.map(c => (
          <div key={c.v} style={{ display:"flex", alignItems:"center", gap:10, marginBottom:6 }}>
            <div style={{ width:210, fontSize:12, whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{c.meta ? `${c.meta.icon} ${c.meta.l}` : c.v}</div>
            <div style={{ flex:1, height:14, background:"#f5f5f5", borderRadius:7, overflow:"hidden" }}>
              <div style={{ width:`${Math.abs(c.total) / maxAbs * 100}%`, height:"100%", background: c.total >= 0 ? "#639922" : "#E24B4A" }} />
            </div>
            <div style={{ width:100, textAlign:"right", fontSize:12.5, fontWeight:700, color: c.total >= 0 ? "#3B6D11" : "#A32D2D" }}>{fmt$(c.total)}</div>
          </div>
        ))}
      </div>

      {pnl.series.length > 1 && (
        <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:14 }}>
          <div style={{ fontSize:12.5, fontWeight:700, marginBottom:10 }}>Neto por mes</div>
          <div style={{ display:"flex", alignItems:"flex-end", gap:8, height:120 }}>
            {pnl.series.map(s => {
              const maxNet = Math.max(1, ...pnl.series.map(x => Math.abs(x.net)));
              return (
                <div key={s.month} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
                  <div style={{ fontSize:10, color: s.net >= 0 ? "#3B6D11" : "#A32D2D", fontWeight:700 }}>{fmt$(s.net)}</div>
                  <div style={{ width:"70%", height: Math.max(3, Math.abs(s.net) / maxNet * 80), background: s.net >= 0 ? "#639922" : "#E24B4A", borderRadius:4 }} />
                  <div style={{ fontSize:10, color:"#999" }}>{s.month}</div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
