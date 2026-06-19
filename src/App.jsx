import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = "https://szkmktxziojzgfjkomua.supabase.co";
const SUPABASE_KEY = "sb_publishable_v2VNtyiQ_tTAAmEWDdHwYg_IJ-_IN-5";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

const EMPTY_FORM = {
  customer:"", driver:"", brand:"", state:"", address:"", unit:"", size:"",
  gate_code:"", lock:"", email:"", account:"", situation:"Open",
  monthly_cost:"", card_on_file:"", date_opened:"", job_number:"", notes:""
};

const sitColor = {
  Open:  { bg:"#EAF3DE", text:"#3B6D11", dot:"#639922" },
  Close: { bg:"#FCEBEB", text:"#A32D2D", dot:"#E24B4A" },
  Empty: { bg:"#FAEEDA", text:"#854F0B", dot:"#EF9F27" },
};

const Badge = ({ situation }) => {
  const c = sitColor[situation] || sitColor.Open;
  const label = situation === "Close" ? "Cerrado" : situation === "Empty" ? "Vacio" : "Activo";
  return (
    <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:500, padding:"3px 9px", borderRadius:20, background:c.bg, color:c.text }}>
      <span style={{ width:6, height:6, borderRadius:"50%", background:c.dot, flexShrink:0 }} />
      {label}
    </span>
  );
};

const DetailRow = ({ label, value }) => {
  if (!value) return null;
  return (
    <div style={{ display:"flex", gap:8, padding:"7px 0", borderBottom:"1px solid #f0f0f0", fontSize:13 }}>
      <span style={{ color:"#888", minWidth:150, flexShrink:0 }}>{label}</span>
      <span style={{ fontWeight:500, wordBreak:"break-all" }}>{value}</span>
    </div>
  );
};

const SectionLabel = ({ children }) => (
  <div style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em", margin:"14px 0 6px" }}>{children}</div>
);

const Field = ({ label, children, full }) => (
  <div style={{ gridColumn: full ? "1/-1" : undefined, display:"flex", flexDirection:"column", gap:4 }}>
    <label style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</label>
    {children}
  </div>
);

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };

function Btn({ onClick, primary, danger, disabled, children, style }) {
  return (
    <button onClick={onClick} disabled={disabled} style={{ fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:8, border: danger ? "1px solid #fca5a5" : "1px solid #e5e5e5", background: primary ? "#111" : danger ? "#fef2f2" : "#fff", color: primary ? "#fff" : danger ? "#b91c1c" : "#111", cursor: disabled ? "not-allowed" : "pointer", opacity: disabled ? 0.5 : 1, display:"inline-flex", alignItems:"center", gap:6, ...style }}>
      {children}
    </button>
  );
}

function Modal({ title, onClose, children, footer }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,0.4)", zIndex:50, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}
      onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div style={{ background:"#fff", borderRadius:14, width:"100%", maxWidth:600, maxHeight:"90vh", overflowY:"auto", boxShadow:"0 8px 40px rgba(0,0,0,0.15)" }}>
        <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", padding:"18px 20px 14px", borderBottom:"1px solid #f0f0f0" }}>
          <span style={{ fontWeight:600, fontSize:15 }}>{title}</span>
          <button onClick={onClose} style={{ background:"none", border:"none", fontSize:20, cursor:"pointer", color:"#aaa", lineHeight:1 }}>x</button>
        </div>
        <div style={{ padding:"16px 20px" }}>{children}</div>
        {footer && <div style={{ padding:"12px 20px 16px", borderTop:"1px solid #f0f0f0", display:"flex", justifyContent:"flex-end", gap:8 }}>{footer}</div>}
      </div>
    </div>
  );
}

function parsePastedMessages(text) {
  const blocks = text.split(/\n(?=Storage para:|storage para:)/i).filter(b => b.trim());
  if (!blocks.length) blocks.push(text);
  return blocks.map(block => {
    const get = (patterns) => { for (const p of patterns) { const m = block.match(p); if (m) return (m[1] || "").trim(); } return ""; };
    const driver = get([/storage para:\s*(.+)/i]);
    const brand = get([/^([A-Z][^\n]+(?:storage|store|smart|space|life|extra|haul)[^\n]*)/im]);
    const unit = get([/unit\s*(?:number|#)?[:\s]+([^\n]+)/i]);
    const address = get([/address[:\s]+([^\n]+)/i]);
    const state = (address.match(/,\s*([A-Z]{2})\s*\d{5}/) || [])[1] || "";
    const size = get([/size[:\s]+([^\n]+)/i]);
    const gate_code = get([/gate\s*code[:\s]+([^\n/]+)/i]);
    const lock = get([/use\s+([^\n]+?)\s+to\s+unlock/i]);
    const email = get([/email[:\s]+([^\n]+)/i]);
    const account = get([/account\s*#?[:\s]+([^\n]+)/i]);
    const rawDate = get([/date[:\s]+([^\n]+)/i]);
    let date_opened = "";
    if (rawDate) { const p = rawDate.match(/(\d{1,2})\/(\d{1,2})\/(\d{2,4})/); if (p) { const y = p[3].length === 2 ? "20" + p[3] : p[3]; date_opened = `${y}-${p[1].padStart(2,"0")}-${p[2].padStart(2,"0")}`; } }
    const jobLine = get([/jobs?[:\s]+(.+)/i]);
    const job_number = (jobLine.match(/([A-Z]{1,2}\d{6,})/i) || [])[1] || "";
    const notes = jobLine.replace(job_number, "").trim() || null;
    return { customer:null, driver, brand:brand||null, state, address:address||null, unit:unit||null, size:size||null, gate_code:gate_code||null, lock:lock||null, email:email||null, account:account||null, situation:"Open", monthly_cost:null, card_on_file:null, date_opened:date_opened||null, job_number:job_number||null, notes };
  }).filter(r => r.driver || r.unit || r.address);
}

function parseWhatsAppExport(rawText) {
  rawText = rawText.replace(/\u200e/g, "").replace(/\r/g, "");
  const lineRe = /^\[?(\d{1,2}\/\d{1,2}\/\d{2,4}),\s*(\d{1,2}:\d{2}(?::\d{2})?\s?[ap]?\.?m?\.?)\]?\s*-?\s*([^:]{1,60}?):\s*([\s\S]*)$/i;
  const lines = rawText.split("\n");
  const entries = [];
  let current = null;
  for (const line of lines) {
    const m = line.match(lineRe);
    if (m) { if (current) entries.push(current); current = { date: m[1], sender: m[3].trim(), text: m[4] }; }
    else if (current) current.text += "\n" + line;
  }
  if (current) entries.push(current);
  const blocks = [];
  let block = null;
  const isNoise = t => /omitted|encrypted|created group|added you|changed the subject|security code|end-to-end/i.test(t);
  for (const e of entries) {
    if (isNoise(e.text)) continue;
    if (!block || block.sender !== e.sender) { if (block) blocks.push(block); block = { sender: e.sender, date: e.date, lines: [e.text] }; }
    else block.lines.push(e.text);
  }
  if (block) blocks.push(block);
  return blocks.filter(b => /storage|unit|gate code|address/i.test(b.lines.join("\n")))
    .map(b => parsePastedMessages(b.lines.join("\n"))[0] || null).filter(Boolean);
}

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);
  const [error, setError] = useState(null);

  async function handleSubmit() {
    setLoading(true); setError(null); setMessage(null);
    if (isSignUp) {
      const { error } = await supabase.auth.signUp({ email, password });
      if (error) setError(error.message);
      else setMessage("Cuenta creada. Revisa tu email para confirmar.");
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password });
      if (error) setError("Email o contrasena incorrectos.");
    }
    setLoading(false);
  }

  const inp2 = { fontSize:14, padding:"10px 14px", borderRadius:8, border:"1px solid #e5e5e5", width:"100%", outline:"none", marginBottom:10, boxSizing:"border-box" };

  return (
    <div style={{ minHeight:"100vh", background:"#fafafa", display:"flex", alignItems:"center", justifyContent:"center", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ background:"#fff", borderRadius:16, border:"1px solid #efefef", padding:"36px 32px", width:"100%", maxWidth:380, boxShadow:"0 4px 24px rgba(0,0,0,0.06)" }}>
        <div style={{ marginBottom:24 }}>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:4 }}>No Borders Moving and Storage</div>
          <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>Storage Manager</h1>
          <p style={{ fontSize:13, color:"#888", marginTop:6 }}>{isSignUp ? "Crea tu cuenta para acceder" : "Inicia sesion para continuar"}</p>
        </div>
        {error && <div style={{ background:"#fef2f2", border:"1px solid #fca5a5", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#b91c1c", marginBottom:12 }}>{error}</div>}
        {message && <div style={{ background:"#f0fdf4", border:"1px solid #86efac", borderRadius:8, padding:"10px 12px", fontSize:13, color:"#166534", marginBottom:12 }}>{message}</div>}
        <input style={inp2} type="email" placeholder="Email" value={email} onChange={e => setEmail(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        <input style={{ ...inp2, marginBottom:16 }} type="password" placeholder="Contrasena" value={password} onChange={e => setPassword(e.target.value)} onKeyDown={e => e.key === "Enter" && handleSubmit()} />
        <button onClick={handleSubmit} disabled={loading || !email || !password}
          style={{ width:"100%", padding:"11px", borderRadius:8, border:"none", background:"#111", color:"#fff", fontSize:14, fontWeight:600, cursor: loading ? "not-allowed" : "pointer", opacity: loading ? 0.7 : 1, marginBottom:14 }}>
          {loading ? "Cargando..." : isSignUp ? "Crear cuenta" : "Iniciar sesion"}
        </button>
        <p style={{ textAlign:"center", fontSize:13, color:"#888", margin:0 }}>
          {isSignUp ? "Ya tenes cuenta? " : "No tenes cuenta? "}
          <span onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }} style={{ color:"#111", fontWeight:600, cursor:"pointer", textDecoration:"underline" }}>
            {isSignUp ? "Inicia sesion" : "Registrate"}
          </span>
        </p>
      </div>
    </div>
  );
}

export default function App() {
  const [session, setSession] = useState(undefined);
  const [records, setRecords] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [liveIndicator, setLiveIndicator] = useState(false);
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("");
  const [sortBy, setSortBy] = useState("date-desc");
  const [detailId, setDetailId] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showImport, setShowImport] = useState(false);
  const [importTab, setImportTab] = useState("paste");
  const [pasteText, setPasteText] = useState("");
  const [pending, setPending] = useState([]);
  const [excluded, setExcluded] = useState({});
  const [zipStatus, setZipStatus] = useState("");
  const [zipName, setZipName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const fileRef = useRef();

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => setSession(session));
    const { data: { subscription } } = supabase.auth.onAuthStateChange((_event, session) => setSession(session));
    return () => subscription.unsubscribe();
  }, []);

  const loadData = useCallback(async () => {
    const { data, error } = await supabase.from("storages").select("*").order("date_opened", { ascending: false });
    if (error) { setError(error.message); setLoading(false); return; }
    setRecords(data || []);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!session) return;
    loadData();
    const channel = supabase.channel("storages-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storages" }, (payload) => {
        setLiveIndicator(true);
        setTimeout(() => setLiveIndicator(false), 2000);
        if (payload.eventType === "INSERT") setRecords(r => [payload.new, ...r]);
        if (payload.eventType === "UPDATE") setRecords(r => r.map(x => x.id === payload.new.id ? payload.new : x));
        if (payload.eventType === "DELETE") setRecords(r => r.filter(x => x.id !== payload.old.id));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, loadData]);

  const drivers = useMemo(() => [...new Set(records.map(r => r.driver).filter(Boolean))].sort(), [records]);

  const filtered = useMemo(() => {
    let data = records.filter(r => {
      if (tab === "Open" && r.situation !== "Open") return false;
      if (tab === "Close" && r.situation !== "Close") return false;
      if (tab === "Empty" && r.situation !== "Empty") return false;
      if (driverFilter && r.driver !== driverFilter) return false;
      if (search) {
        const hay = [r.driver, r.brand, r.state, r.address, r.unit, r.customer, r.job_number, r.notes].join(" ").toLowerCase();
        if (!hay.includes(search.toLowerCase())) return false;
      }
      return true;
    });
    data.sort((a, b) => {
      if (sortBy === "date-desc") return (b.date_opened || "") > (a.date_opened || "") ? 1 : -1;
      if (sortBy === "date-asc")  return (a.date_opened || "") > (b.date_opened || "") ? 1 : -1;
      if (sortBy === "driver") return (a.driver || "").localeCompare(b.driver || "");
      if (sortBy === "state")  return (a.state || "").localeCompare(b.state || "");
      return 0;
    });
    return data;
  }, [records, tab, search, driverFilter, sortBy]);

  const metrics = useMemo(() => {
    const active = records.filter(r => r.situation === "Open");
    const withCost = active.filter(r => r.monthly_cost && Number(r.monthly_cost) > 0);
    const totalCost = withCost.reduce((sum, r) => sum + Number(r.monthly_cost), 0);
    const missingCost = active.length - withCost.length;
    return {
      total: records.length,
      active: active.length,
      closed: records.filter(r => r.situation === "Close").length,
      empty:  records.filter(r => r.situation === "Empty").length,
      states: new Set(records.map(r => r.state).filter(Boolean)).size,
      totalCost,
      missingCost,
    };
  }, [records]);

  const detail = records.find(r => r.id === detailId);

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setShowAdd(true); }
  function openEdit(r) {
    setForm({ customer:r.customer||"", driver:r.driver||"", brand:r.brand||"", state:r.state||"", address:r.address||"", unit:r.unit||"", size:r.size||"", gate_code:r.gate_code||"", lock:r.lock||"", email:r.email||"", account:r.account||"", situation:r.situation||"Open", monthly_cost:r.monthly_cost||"", card_on_file:r.card_on_file||"", date_opened:r.date_opened||"", job_number:r.job_number||"", notes:r.notes||"" });
    setEditId(r.id); setShowAdd(true);
  }

  async function saveForm() {
    setSaving(true);
    const payload = { customer:form.customer||null, driver:form.driver||null, brand:form.brand||null, state:form.state||null, address:form.address||null, unit:form.unit||null, size:form.size||null, gate_code:form.gate_code||null, lock:form.lock||null, email:form.email||null, account:form.account||null, situation:form.situation, monthly_cost:form.monthly_cost ? parseFloat(form.monthly_cost) : null, card_on_file:form.card_on_file||null, date_opened:form.date_opened||null, job_number:form.job_number||null, notes:form.notes||null };
    if (editId) { await supabase.from("storages").update(payload).eq("id", editId); }
    else { await supabase.from("storages").insert([payload]); }
    setSaving(false); setShowAdd(false);
  }

  async function deleteRecord(id) {
    if (!window.confirm("Eliminar este storage?")) return;
    await supabase.from("storages").delete().eq("id", id);
    setDetailId(null);
  }

  function openImportModal() { setShowImport(true); setImportTab("paste"); setPasteText(""); setPending([]); setExcluded({}); setZipStatus(""); setZipName(""); }
  function previewPaste() { setPending(parsePastedMessages(pasteText)); setExcluded({}); }

  async function handleZip(file) {
    if (!file) return;
    setZipName(file.name); setZipStatus("Leyendo ZIP...");
    try {
      const { default: JSZip } = await import("https://cdn.jsdelivr.net/npm/jszip@3.10.1/+esm");
      const zip = await JSZip.loadAsync(file);
      let chatFile = Object.keys(zip.files).find(n => /chat.*\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) chatFile = Object.keys(zip.files).find(n => /\.txt$/i.test(n) && !zip.files[n].dir);
      if (!chatFile) { setZipStatus("No se encontro un archivo .txt dentro del ZIP."); return; }
      const text = await zip.files[chatFile].async("string");
      const parsed = parseWhatsAppExport(text);
      if (!parsed.length) { setZipStatus("No se detectaron mensajes con datos de storage."); return; }
      setPending(parsed); setExcluded({});
      setZipStatus(`${parsed.length} storage(s) detectados en "${chatFile}".`);
    } catch (err) { setZipStatus("Error: " + err.message); }
  }

  async function confirmImport() {
    const toAdd = pending.filter((_, i) => !excluded[i]);
    if (!toAdd.length) return;
    setSaving(true);
    await supabase.from("storages").insert(toAdd);
    setSaving(false); setShowImport(false);
  }

  const tabStyle = (t) => ({ fontSize:13, fontWeight: tab === t ? 600 : 400, padding:"8px 16px", cursor:"pointer", border:"none", background:"none", color: tab === t ? "#111" : "#999", borderBottom: tab === t ? "2px solid #111" : "2px solid transparent" });
  const impTabStyle = (t) => ({ flex:1, fontSize:13, padding:"8px", borderRadius:7, cursor:"pointer", border:"none", background: importTab === t ? "#fff" : "none", color: importTab === t ? "#111" : "#888", fontWeight: importTab === t ? 600 : 400, boxShadow: importTab === t ? "0 1px 4px rgba(0,0,0,0.08)" : "none" });

  if (session === undefined) return null;
  if (!session) return <LoginScreen />;

  if (loading) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#888", fontFamily:"system-ui,sans-serif" }}>
      <div style={{ width:32, height:32, border:"3px solid #f0f0f0", borderTop:"3px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite" }} />
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
      <span style={{ fontSize:14 }}>Cargando storages...</span>
    </div>
  );

  if (error) return (
    <div style={{ display:"flex", alignItems:"center", justifyContent:"center", height:"100vh", flexDirection:"column", gap:12, color:"#b91c1c", fontFamily:"system-ui,sans-serif", padding:24 }}>
      <span style={{ fontSize:15, fontWeight:600 }}>Error de conexion</span>
      <span style={{ fontSize:13, color:"#888" }}>{error}</span>
      <button onClick={loadData} style={{ padding:"8px 16px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", cursor:"pointer", fontSize:13 }}>Reintentar</button>
    </div>
  );

  return (
    <div style={{ fontFamily:"system-ui,-apple-system,sans-serif", color:"#111", padding:"20px 24px 40px", minHeight:"100vh", background:"#fafafa" }}>
      <div style={{ display:"flex", alignItems:"center", gap:12, marginBottom:20, flexWrap:"wrap" }}>
        <div style={{ flex:1 }}>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", letterSpacing:"0.08em", textTransform:"uppercase", marginBottom:2 }}>No Borders Moving and Storage</div>
          <div style={{ display:"flex", alignItems:"center", gap:10 }}>
            <h1 style={{ fontSize:22, fontWeight:700, margin:0, letterSpacing:"-0.02em" }}>Storage Manager</h1>
            <span style={{ display:"inline-flex", alignItems:"center", gap:5, fontSize:11, fontWeight:600, padding:"3px 8px", borderRadius:20, background: liveIndicator ? "#EAF3DE" : "#f5f5f5", color: liveIndicator ? "#3B6D11" : "#aaa", transition:"all .3s" }}>
              <span style={{ width:6, height:6, borderRadius:"50%", background: liveIndicator ? "#639922" : "#ccc", transition:"all .3s" }} />
              {liveIndicator ? "Actualizado" : "Live"}
            </span>
          </div>
        </div>
        <div style={{ display:"flex", gap:8 }}>
          <Btn onClick={() => setShowAnalytics(a => !a)}>{showAnalytics ? "Ocultar graficos" : "Ver graficos"}</Btn>
          <Btn onClick={openImportModal}>Importar WhatsApp</Btn>
          <Btn primary onClick={openAdd}>+ Nuevo storage</Btn>
          <Btn onClick={() => supabase.auth.signOut()} style={{ color:"#888", fontSize:12 }}>Salir</Btn>
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom: metrics.missingCost > 0 ? 10 : 20 }}>
        {[
          { label:"Total storages", value:metrics.total, color:"#111" },
          { label:"Activos", value:metrics.active, color:"#3B6D11" },
          { label:"Cerrados", value:metrics.closed, color:"#A32D2D" },
          { label:"Vacios", value:metrics.empty, color:"#854F0B" },
          { label:"Costo mensual", value:"$"+metrics.totalCost.toLocaleString(), color:"#185FA5" },
          { label:"Estados USA", value:metrics.states, color:"#888" },
        ].map(m => (
          <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
            <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color:m.color }}>{m.value}</div>
          </div>
        ))}
      </div>
      {metrics.missingCost > 0 && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:8 }}>
          <span>Warning:</span>
          <span><strong>{metrics.missingCost} storage(s) activo(s)</strong> sin costo cargado — el total puede estar incompleto.</span>
        </div>
      )}

      {/* ANALYTICS */}
      {showAnalytics && (
        <div style={{ marginBottom:20 }}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14, marginBottom:14 }}>
            
            {/* Storages por estado */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px" }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:12 }}>Storages por estado</div>
              {Object.entries(records.filter(r=>r.situation==="Open").reduce((acc,r)=>{ if(r.state){acc[r.state]=(acc[r.state]||0)+1;} return acc; },{})).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([state,count]) => {
                const max = Math.max(...Object.values(records.filter(r=>r.situation==="Open").reduce((acc,r)=>{ if(r.state){acc[r.state]=(acc[r.state]||0)+1;} return acc; },{})));
                return (
                  <div key={state} style={{ marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                      <span style={{ fontWeight:500 }}>{state}</span>
                      <span style={{ color:"#888" }}>{count}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:4, height:6 }}>
                      <div style={{ background:"#3B6D11", borderRadius:4, height:6, width:`${(count/max)*100}%`, transition:"width .3s" }} />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* Costo por driver */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px" }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:12 }}>Costo mensual por driver</div>
              {Object.entries(records.filter(r=>r.situation==="Open" && r.monthly_cost).reduce((acc,r)=>{ if(r.driver){acc[r.driver]=(acc[r.driver]||0)+Number(r.monthly_cost);} return acc; },{})).sort((a,b)=>b[1]-a[1]).slice(0,8).map(([driver,cost]) => {
                const max = Math.max(...Object.values(records.filter(r=>r.situation==="Open" && r.monthly_cost).reduce((acc,r)=>{ if(r.driver){acc[r.driver]=(acc[r.driver]||0)+Number(r.monthly_cost);} return acc; },{})));
                return (
                  <div key={driver} style={{ marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                      <span style={{ fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:120 }}>{driver}</span>
                      <span style={{ color:"#888", flexShrink:0 }}>${Number(cost).toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:4, height:6 }}>
                      <div style={{ background:"#185FA5", borderRadius:4, height:6, width:`${(cost/max)*100}%`, transition:"width .3s" }} />
                    </div>
                  </div>
                );
              })}
              {records.filter(r=>r.situation==="Open" && r.monthly_cost).length === 0 && <p style={{ fontSize:12, color:"#bbb", textAlign:"center", marginTop:20 }}>Sin costos cargados aun</p>}
            </div>

            {/* Storages abiertos por mes */}
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"16px" }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:12 }}>Aperturas por mes</div>
              {(() => {
                const byMonth = records.reduce((acc,r)=>{ if(r.date_opened){ const m=r.date_opened.slice(0,7); acc[m]=(acc[m]||0)+1; } return acc; },{});
                const sorted = Object.entries(byMonth).sort((a,b)=>a[0]>b[0]?1:-1).slice(-8);
                const max = Math.max(...sorted.map(s=>s[1]));
                return sorted.map(([month,count]) => (
                  <div key={month} style={{ marginBottom:8 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:3 }}>
                      <span style={{ fontWeight:500 }}>{month}</span>
                      <span style={{ color:"#888" }}>{count}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:4, height:6 }}>
                      <div style={{ background:"#854F0B", borderRadius:4, height:6, width:`${(count/max)*100}%`, transition:"width .3s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>
        </div>
      )}

            <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14 }}>
        {[["all","Todos"],["Open","Activos"],["Close","Cerrados"],["Empty","Vacios"]].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{l}</button>
        ))}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar driver, brand, estado, job..." style={{ ...inp, flex:1, minWidth:180 }} />
        <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
          <option value="">Todos los drivers</option>
          {drivers.map(d => <option key={d} value={d}>{d}</option>)}
        </select>
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inp, minWidth:150 }}>
          <option value="date-desc">Mas reciente</option>
          <option value="date-asc">Mas antiguo</option>
          <option value="driver">Driver A-Z</option>
          <option value="state">Estado A-Z</option>
        </select>
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, tableLayout:"fixed" }}>
            <colgroup>
              <col style={{width:100}}/><col style={{width:110}}/><col style={{width:110}}/>
              <col style={{width:110}}/><col style={{width:55}}/><col style={{width:65}}/>
              <col style={{width:105}}/><col style={{width:75}}/>
            </colgroup>
            <thead>
              <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                {["Job #","Cliente","Driver","Brand","Estado","Unidad","Gate Code","Situacion"].map(h => (
                  <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.length === 0 ? (
                <tr><td colSpan={8} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin resultados</td></tr>
              ) : filtered.map(r => (
                <tr key={r.id} onClick={() => setDetailId(r.id)}
                  style={{ borderBottom:"1px solid #fafafa", cursor:"pointer" }}
                  onMouseEnter={e => e.currentTarget.style.background="#fafafa"}
                  onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                  <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12, fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.job_number||"—"}</td>
                  <td style={{ padding:"10px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.customer||"—"}</td>
                  <td style={{ padding:"10px 12px", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.driver||"—"}</td>
                  <td style={{ padding:"10px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.brand||"—"}</td>
                  <td style={{ padding:"10px 12px" }}>{r.state||"—"}</td>
                  <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.unit||"—"}</td>
                  <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:11, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.gate_code||"—"}</td>
                  <td style={{ padding:"10px 12px" }}><Badge situation={r.situation} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>
          {filtered.length} de {records.length} storages
        </div>
      </div>

      {detail && (
        <Modal title={`${detail.driver||"Storage"} — ${detail.state||""}`} onClose={() => setDetailId(null)}
          footer={<>
            <Btn danger onClick={() => deleteRecord(detail.id)}>Eliminar</Btn>
            <Btn onClick={() => { setDetailId(null); openEdit(detail); }}>Editar</Btn>
            <Btn primary onClick={() => setDetailId(null)}>Cerrar</Btn>
          </>}>
          <div style={{ marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
            <Badge situation={detail.situation} />
            {detail.customer && <span style={{ fontSize:13, color:"#888" }}>Cliente: <strong>{detail.customer}</strong></span>}
          </div>
          <SectionLabel>Storage</SectionLabel>
          <DetailRow label="Brand" value={detail.brand} />
          <DetailRow label="Direccion" value={detail.address} />
          <DetailRow label="Estado" value={detail.state} />
          <DetailRow label="Unidad" value={detail.unit} />
          <DetailRow label="Tamano" value={detail.size} />
          <DetailRow label="Gate Code" value={detail.gate_code} />
          <DetailRow label="Lock / Combo" value={detail.lock} />
          <SectionLabel>Cuenta</SectionLabel>
          <DetailRow label="Email" value={detail.email} />
          <DetailRow label="Account #" value={detail.account} />
          <DetailRow label="Tarjeta" value={detail.card_on_file} />
          <DetailRow label="Costo mensual" value={detail.monthly_cost ? "$" + detail.monthly_cost : null} />
          <DetailRow label="Fecha apertura" value={detail.date_opened} />
          <SectionLabel>Job</SectionLabel>
          <DetailRow label="Job Number" value={detail.job_number} />
          <DetailRow label="Notas" value={detail.notes} />
        </Modal>
      )}

      {showAdd && (
        <Modal title={editId ? "Editar storage" : "Nuevo storage"} onClose={() => setShowAdd(false)}
          footer={<>
            <Btn onClick={() => setShowAdd(false)}>Cancelar</Btn>
            <Btn primary disabled={saving} onClick={saveForm}>{saving ? "Guardando..." : "Guardar"}</Btn>
          </>}>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Customer"><input style={inp} value={form.customer} onChange={e => setForm(f => ({...f, customer:e.target.value}))} placeholder="Nombre del cliente" /></Field>
            <Field label="Driver"><input style={inp} value={form.driver} onChange={e => setForm(f => ({...f, driver:e.target.value}))} placeholder="Driver" /></Field>
            <Field label="Brand"><input style={inp} value={form.brand} onChange={e => setForm(f => ({...f, brand:e.target.value}))} placeholder="CubeSmart, Public Storage..." /></Field>
            <Field label="Estado"><input style={inp} value={form.state} onChange={e => setForm(f => ({...f, state:e.target.value}))} placeholder="TN" /></Field>
            <Field label="Direccion" full><input style={inp} value={form.address} onChange={e => setForm(f => ({...f, address:e.target.value}))} placeholder="1870 West Ave, Crossville, TN 38555" /></Field>
            <Field label="Unidad #"><input style={inp} value={form.unit} onChange={e => setForm(f => ({...f, unit:e.target.value}))} placeholder="G13" /></Field>
            <Field label="Tamano"><input style={inp} value={form.size} onChange={e => setForm(f => ({...f, size:e.target.value}))} placeholder="10x10" /></Field>
            <Field label="Gate Code"><input style={inp} value={form.gate_code} onChange={e => setForm(f => ({...f, gate_code:e.target.value}))} placeholder="*130438#" /></Field>
            <Field label="Lock / Combo"><input style={inp} value={form.lock} onChange={e => setForm(f => ({...f, lock:e.target.value}))} placeholder="use 8141 to unlock..." /></Field>
            <Field label="Email"><input style={inp} value={form.email} onChange={e => setForm(f => ({...f, email:e.target.value}))} placeholder="service@..." /></Field>
            <Field label="Account #"><input style={inp} value={form.account} onChange={e => setForm(f => ({...f, account:e.target.value}))} placeholder="NONE" /></Field>
            <Field label="Situacion">
              <select style={inp} value={form.situation} onChange={e => setForm(f => ({...f, situation:e.target.value}))}>
                <option value="Open">Open</option>
                <option value="Close">Close</option>
                <option value="Empty">Empty</option>
              </select>
            </Field>
            <Field label="Costo mensual ($)"><input style={inp} type="number" value={form.monthly_cost} onChange={e => setForm(f => ({...f, monthly_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Tarjeta"><input style={inp} value={form.card_on_file} onChange={e => setForm(f => ({...f, card_on_file:e.target.value}))} placeholder="Visa ****1234" /></Field>
            <Field label="Fecha apertura"><input style={inp} type="date" value={form.date_opened} onChange={e => setForm(f => ({...f, date_opened:e.target.value}))} /></Field>
            <Field label="Job Number"><input style={inp} value={form.job_number} onChange={e => setForm(f => ({...f, job_number:e.target.value}))} placeholder="B8417142" /></Field>
            <Field label="Notas" full><input style={inp} value={form.notes} onChange={e => setForm(f => ({...f, notes:e.target.value}))} placeholder="Notas adicionales" /></Field>
          </div>
        </Modal>
      )}

      {showImport && (
        <Modal title="Importar desde WhatsApp" onClose={() => setShowImport(false)}
          footer={<>
            <Btn onClick={() => setShowImport(false)}>Cancelar</Btn>
            {importTab === "paste" && <Btn onClick={previewPaste}>Previsualizar</Btn>}
            <Btn primary disabled={saving || !pending.filter((_,i) => !excluded[i]).length} onClick={confirmImport}>
              {saving ? "Importando..." : `Importar (${pending.filter((_,i) => !excluded[i]).length})`}
            </Btn>
          </>}>
          <div style={{ display:"flex", gap:4, background:"#f5f5f5", borderRadius:10, padding:3, marginBottom:14 }}>
            <button onClick={() => { setImportTab("paste"); setPending([]); }} style={impTabStyle("paste")}>Pegar texto</button>
            <button onClick={() => { setImportTab("zip"); setPending([]); }} style={impTabStyle("zip")}>Subir ZIP del chat</button>
          </div>
          {importTab === "paste" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Pega uno o varios mensajes del grupo de WhatsApp.</p>
              <textarea value={pasteText} onChange={e => setPasteText(e.target.value)}
                placeholder={"Storage para: Elvin Medina\nGo Store It!\nsize: 10x10\nAddress: 1870 West Avenue, Crossville, TN\nUnit Number: G13\nGate Code: 130438"}
                style={{ ...inp, fontFamily:"monospace", fontSize:12, resize:"vertical", minHeight:120, display:"block", marginBottom:8 }} />
            </>
          )}
          {importTab === "zip" && (
            <>
              <p style={{ fontSize:13, color:"#888", marginBottom:10 }}>Subi el .zip exportado del chat de WhatsApp. Se procesa en tu navegador.</p>
              <div onDragOver={e => { e.preventDefault(); setIsDragging(true); }} onDragLeave={() => setIsDragging(false)}
                onDrop={e => { e.preventDefault(); setIsDragging(false); const f = e.dataTransfer.files[0]; if (f) handleZip(f); }}
                onClick={() => fileRef.current.click()}
                style={{ border:`2px dashed ${isDragging ? "#378ADD" : "#ddd"}`, borderRadius:10, padding:"28px 16px", textAlign:"center", cursor:"pointer", background: isDragging ? "#E6F1FB" : "#fafafa", transition:"all .15s" }}>
                <div style={{ fontSize:28, marginBottom:8 }}>zip</div>
                <p style={{ fontSize:13, color:"#888" }}>Hace clic o arrastra el archivo .zip aca</p>
                {zipName && <p style={{ fontSize:13, fontWeight:600, color:"#111", marginTop:6 }}>{zipName}</p>}
              </div>
              <input ref={fileRef} type="file" accept=".zip" style={{ display:"none" }} onChange={e => handleZip(e.target.files[0])} />
              {zipStatus && <p style={{ fontSize:12, color: zipStatus.includes("Error")||zipStatus.includes("No se") ? "#b91c1c" : "#3B6D11", marginTop:8 }}>{zipStatus}</p>}
            </>
          )}
          {pending.length > 0 && (
            <div style={{ marginTop:14 }}>
              <div style={{ fontSize:12, fontWeight:600, color:"#3B6D11", marginBottom:8 }}>{pending.length} storage(s) detectados:</div>
              <div style={{ maxHeight:260, overflowY:"auto", display:"flex", flexDirection:"column", gap:6 }}>
                {pending.map((r, i) => (
                  <label key={i} style={{ display:"flex", alignItems:"flex-start", gap:8, fontSize:12, background: excluded[i] ? "#fafafa" : "#f0fdf4", borderRadius:8, padding:"8px 10px", cursor:"pointer", border:"1px solid", borderColor: excluded[i] ? "#efefef" : "#bbf7d0" }}>
                    <input type="checkbox" checked={!excluded[i]} onChange={e => setExcluded(ex => ({...ex, [i]: !e.target.checked}))} style={{ marginTop:1 }} />
                    <div>
                      <span style={{ fontWeight:600 }}>{r.driver||"Sin nombre"}</span>
                      <span style={{ color:"#666" }}> · {r.brand||"?"} · Unidad {r.unit||"?"}</span>
                      {r.address && <div style={{ color:"#888", marginTop:2 }}>{r.address}</div>}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          )}
        </Modal>
      )}
    </div>
  );
}
