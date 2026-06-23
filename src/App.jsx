import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// Reads from Vercel env vars when present (so the test/preview deployment can
// point to a separate test database), falling back to the production project.
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://szkmktxziojzgfjkomua.supabase.co";
const SUPABASE_KEY = import.meta.env.VITE_SUPABASE_KEY || "sb_publishable_v2VNtyiQ_tTAAmEWDdHwYg_IJ-_IN-5";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// One physical storage = one row in `storages`. Jobs that pass through a unit are
// tracked as history in `storage_jobs`. Multiple jobs can be active at once.
const STORAGE_JOBS_SQL = `create table if not exists public.storage_jobs (
  id bigint generated always as identity primary key,
  storage_id bigint references public.storages(id) on delete cascade,
  job_number text,
  customer text,
  driver text,
  date_in date,
  date_out date,
  notes text,
  created_at timestamptz default now()
);
alter table public.storage_jobs enable row level security;
create policy "storage_jobs_auth_all" on public.storage_jobs
  for all to authenticated using (true) with check (true);
alter publication supabase_realtime add table public.storage_jobs;`;

const today = () => new Date().toISOString().slice(0, 10);

// A storage = a physical unit (fixed: company, location, unit, gate code, account).
// Jobs (customer, job number, driver, dates, notes) live in storage_jobs as history.
const EMPTY_FORM = {
  brand:"", state:"", zip:"", address:"", unit:"", size:"",
  gate_code:"", lock:"", email:"", account:"", phone:"", situation:"Open",
  monthly_cost:"", card_on_file:"", date_opened:""
};

const US_STATES = ["AL","AK","AZ","AR","CA","CO","CT","DE","DC","FL","GA","HI","ID","IL","IN","IA","KS","KY","LA","ME","MD","MA","MI","MN","MS","MO","MT","NE","NV","NH","NJ","NM","NY","NC","ND","OH","OK","OR","PA","RI","SC","SD","TN","TX","UT","VT","VA","WA","WV","WI","WY"];

// A job can span several locations: one storage_jobs row per location (rented
// unit via storage_id, or company warehouse via `warehouse`), sharing job_number.
const WAREHOUSES = ["Indiana", "New Jersey"];
const EMPTY_JOB = { storage_ids:[], warehouses:[], job_number:"", customer:"", driver:"", date_in:"", volume:"", notes:"" };

// Group key for a job: same job_number = same job (across locations). Blank number = standalone.
const jobKey = (j) => j.job_number && j.job_number.trim() ? `n:${j.job_number.trim().toLowerCase()}` : `id:${j.id}`;

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

const CopyButton = ({ value }) => {
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const copy = (e) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(value).then(() => {
      setCopied(true);
      clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), 1500);
    }).catch(() => {});
  };
  return (
    <button
      onClick={copy}
      title={copied ? "Copiado" : "Copiar gate code"}
      style={{ flexShrink:0, marginLeft:6, padding:0, width:18, height:18, lineHeight:"18px", border:"none", background:"none", cursor:"pointer", color:copied?"#16a34a":"#bbb", fontSize:11, opacity:0.8 }}
      onMouseEnter={e => e.currentTarget.style.opacity=1}
      onMouseLeave={e => e.currentTarget.style.opacity=0.8}>
      {copied ? "✓" : "⧉"}
    </button>
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

function AIPanel({ records }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function analyze() {
    setLoading(true); setResult(null);
    const active = records.filter(r => r.situation === "Open");
    const byState = active.reduce((acc,r)=>{ if(r.state) acc[r.state]=(acc[r.state]||0)+1; return acc; },{});
    const byBrand = active.reduce((acc,r)=>{ if(r.brand) acc[r.brand.trim()]=(acc[r.brand.trim()]||0)+1; return acc; },{});
    const withCost = active.filter(r=>r.monthly_cost);
    const totalCost = withCost.reduce((s,r)=>s+Number(r.monthly_cost),0);
    const noCost = active.length - withCost.length;
    const sameState = Object.entries(byState).filter(([,v])=>v>=3).map(([k,v])=>`${k}: ${v} storages`);
    const sameBrand = Object.entries(byBrand).filter(([,v])=>v>=3).map(([k,v])=>`${k}: ${v} unidades`);

    const prompt = `Sos un experto en operaciones de empresas de mudanzas en USA. Analiza estos datos de storages activos y dame 4-6 recomendaciones concretas y accionables para mejorar la eficiencia y reducir costos. Se especifico, directo y práctico.

DATOS:
- Total storages activos: ${active.length}
- Costo mensual total registrado: $${totalCost.toLocaleString()} (${noCost} storages sin costo cargado)
- Storages por estado: ${JSON.stringify(byState)}
- Storages por empresa: ${JSON.stringify(byBrand)}
- Estados con 3+ storages: ${sameState.join(", ") || "ninguno"}
- Empresas con 3+ unidades: ${sameBrand.join(", ") || "ninguna"}

Formato: lista numerada, cada recomendacion en 2-3 lineas max. Empieza directo con "1."`;

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "claude-sonnet-4-6",
          max_tokens: 1000,
          messages: [{ role: "user", content: prompt }]
        })
      });
      const data = await res.json();
      setResult(data.content?.[0]?.text || "No se pudo obtener respuesta.");
    } catch(e) {
      setResult("Error al conectar con la IA. Intenta de nuevo.");
    }
    setLoading(false);
  }

  return (
    <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", marginBottom: result ? 16 : 0 }}>
        <div>
          <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Recomendaciones con IA</div>
          <div style={{ fontSize:12, color:"#bbb" }}>Analisis automatico de tu operacion de storages</div>
        </div>
        <button onClick={analyze} disabled={loading}
          style={{ fontSize:13, fontWeight:500, padding:"8px 16px", borderRadius:8, border:"1px solid #e5e5e5", background: loading ? "#f5f5f5" : "#111", color: loading ? "#aaa" : "#fff", cursor: loading ? "not-allowed" : "pointer", flexShrink:0, display:"flex", alignItems:"center", gap:6 }}>
          {loading ? "Analizando..." : "Analizar con IA"}
        </button>
      </div>
      {loading && (
        <div style={{ display:"flex", alignItems:"center", gap:10, padding:"20px 0", color:"#888", fontSize:13 }}>
          <div style={{ width:16, height:16, border:"2px solid #f0f0f0", borderTop:"2px solid #111", borderRadius:"50%", animation:"spin 0.8s linear infinite", flexShrink:0 }} />
          Analizando {records.filter(r=>r.situation==="Open").length} storages activos...
        </div>
      )}
      {result && (
        <div style={{ marginTop:16, padding:"16px", background:"#fafafa", borderRadius:10, fontSize:13, lineHeight:1.7, color:"#333", whiteSpace:"pre-wrap" }}>
          {result}
        </div>
      )}
    </div>
  );
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

const jobBadgeStyle = (delivered) => ({
  display:"inline-flex", alignItems:"center", gap:5, fontSize:10, fontWeight:600,
  padding:"2px 8px", borderRadius:20, flexShrink:0,
  background: delivered ? "#f1f1f1" : "#EAF3DE",
  color: delivered ? "#888" : "#3B6D11",
});

function JobCard({ job, onDeliver }) {
  const delivered = !!job.date_out;
  return (
    <div style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
      <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom: (job.customer||job.driver||job.notes) ? 6 : 0 }}>
        <span style={jobBadgeStyle(delivered)}>
          <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
          {delivered ? "Delivered" : "Active"}
        </span>
        <span style={{ fontFamily:"monospace", fontSize:12, fontWeight:600 }}>{job.job_number || "—"}</span>
        <span style={{ flex:1 }} />
        {!delivered && (
          <Btn onClick={() => onDeliver(job)} style={{ padding:"4px 10px", fontSize:12 }}>Marcar entregado</Btn>
        )}
      </div>
      <div style={{ fontSize:12, color:"#666", display:"flex", flexWrap:"wrap", gap:"2px 12px" }}>
        {job.customer && <span>Cliente: <strong style={{ color:"#333" }}>{job.customer}</strong></span>}
        {job.driver && <span>Driver: <strong style={{ color:"#333" }}>{job.driver}</strong></span>}
        {job.date_in && <span>In: {job.date_in}</span>}
        {job.date_out && <span>Out: {job.date_out}</span>}
      </div>
      {job.notes && <div style={{ fontSize:12, color:"#888", marginTop:4 }}>{job.notes}</div>}
    </div>
  );
}

function JobHistory({ storageId, jobs, dbReady, onSetup, onChange }) {
  const EMPTY = { job_number:"", customer:"", driver:"", date_in:"", notes:"" };
  const [form, setForm] = useState(EMPTY);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);
  const [showDelivered, setShowDelivered] = useState(false);

  const active = jobs.filter(j => !j.date_out);
  const delivered = jobs.filter(j => j.date_out);

  async function addJob() {
    if (!form.job_number && !form.customer && !form.driver) { setErr("Completá al menos job, cliente o driver."); return; }
    setSaving(true); setErr(null);
    const payload = {
      storage_id: storageId,
      job_number: form.job_number || null,
      customer: form.customer || null,
      driver: form.driver || null,
      date_in: form.date_in || today(),
      notes: form.notes || null,
    };
    const { error } = await supabase.from("storage_jobs").insert([payload]);
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setForm(EMPTY);
    onChange && onChange();
  }

  async function deliver(job) {
    const { error } = await supabase.from("storage_jobs").update({ date_out: today() }).eq("id", job.id);
    if (error) { setErr(error.message); return; }
    onChange && onChange();
  }

  if (!dbReady) {
    return (
      <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"12px 14px", fontSize:13, color:"#854F0B" }}>
        El historial de jobs necesita una configuración inicial de la base de datos.
        {onSetup && <button onClick={onSetup} style={{ marginLeft:8, background:"none", border:"none", color:"#854F0B", fontWeight:600, textDecoration:"underline", cursor:"pointer", fontSize:13 }}>Ver cómo activarlo</button>}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:"flex", flexDirection:"column", gap:8, marginBottom:14 }}>
        {active.length === 0 && delivered.length === 0 && (
          <div style={{ fontSize:13, color:"#bbb", padding:"6px 0" }}>Todavía no hay jobs en esta unidad.</div>
        )}
        {active.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}

        {delivered.length > 0 && (
          <div>
            <button onClick={() => setShowDelivered(s => !s)}
              style={{ background:"none", border:"none", cursor:"pointer", color:"#888", fontSize:12, fontWeight:600, padding:"4px 0", display:"flex", alignItems:"center", gap:6 }}>
              <span style={{ display:"inline-block", transform: showDelivered ? "rotate(90deg)" : "none", transition:"transform .15s" }}>▸</span>
              {delivered.length} entregado{delivered.length === 1 ? "" : "s"}
            </button>
            {showDelivered && (
              <div style={{ display:"flex", flexDirection:"column", gap:8, marginTop:8 }}>
                {delivered.map(j => <JobCard key={j.id} job={j} onDeliver={deliver} />)}
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ background:"#fafafa", border:"1px solid #f0f0f0", borderRadius:10, padding:"12px" }}>
        <div style={{ fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:10 }}>Agregar job</div>
        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:8 }}>
          <Field label="Job #"><input style={inp} value={form.job_number} onChange={e => setForm(f => ({...f, job_number:e.target.value}))} placeholder="B8417142" /></Field>
          <Field label="Date in"><input style={inp} type="date" value={form.date_in} onChange={e => setForm(f => ({...f, date_in:e.target.value}))} /></Field>
          <Field label="Cliente"><input style={inp} value={form.customer} onChange={e => setForm(f => ({...f, customer:e.target.value}))} placeholder="Nombre del cliente" /></Field>
          <Field label="Driver"><input style={inp} value={form.driver} onChange={e => setForm(f => ({...f, driver:e.target.value}))} placeholder="Driver" /></Field>
          <Field label="Notas" full><input style={inp} value={form.notes} onChange={e => setForm(f => ({...f, notes:e.target.value}))} placeholder="Notas del job" /></Field>
        </div>
        {err && <div style={{ fontSize:12, color:"#b91c1c", marginTop:8 }}>{err}</div>}
        <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
          <Btn primary disabled={saving} onClick={addJob}>{saving ? "Agregando..." : "+ Agregar job"}</Btn>
        </div>
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
  const [tab, setTab] = useState("active");
  const [search, setSearch] = useState("");
  const [driverFilter, setDriverFilter] = useState("");
  const [sortBy, setSortBy] = useState("date-desc");
  const [detailId, setDetailId] = useState(null);
  const [jobDetailKey, setJobDetailKey] = useState(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editId, setEditId] = useState(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showAddJob, setShowAddJob] = useState(false);
  const [jobForm, setJobForm] = useState(EMPTY_JOB);
  const [jobSaving, setJobSaving] = useState(false);
  const [jobErr, setJobErr] = useState(null);
  const [showImport, setShowImport] = useState(false);
  const [importTab, setImportTab] = useState("paste");
  const [pasteText, setPasteText] = useState("");
  const [pending, setPending] = useState([]);
  const [excluded, setExcluded] = useState({});
  const [zipStatus, setZipStatus] = useState("");
  const [zipName, setZipName] = useState("");
  const [isDragging, setIsDragging] = useState(false);
  const [showAnalytics, setShowAnalytics] = useState(false);
  const [jobs, setJobs] = useState([]);
  const [dbReady, setDbReady] = useState(false);
  const [dbSetupNeeded, setDbSetupNeeded] = useState(false);
  const [showSetup, setShowSetup] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
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

  const loadJobs = useCallback(async () => {
    const { data, error } = await supabase.from("storage_jobs").select("*").order("created_at", { ascending: false });
    if (!error) setJobs(data || []);
  }, []);

  // Ensure storage_jobs exists. With a publishable (anon) key DDL isn't possible
  // via REST, so we probe the table and, if missing, best-effort create it through
  // an exec_sql-style RPC. If neither works, surface a one-time setup banner.
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("storage_jobs").select("id").limit(1);
      if (cancelled) return;
      if (!error) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: STORAGE_JOBS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) { setDbReady(true); setDbSetupNeeded(false); loadJobs(); }
      else { setDbReady(false); setDbSetupNeeded(true); }
    })();
    return () => { cancelled = true; };
  }, [session, loadJobs]);

  useEffect(() => {
    if (!session || !dbReady) return;
    const channel = supabase.channel("storage-jobs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "storage_jobs" }, () => loadJobs())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [session, dbReady, loadJobs]);

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

  const storageById = useMemo(() => {
    const m = {};
    for (const r of records) m[r.id] = r;
    return m;
  }, [records]);

  const drivers = useMemo(() => [...new Set(jobs.map(j => j.driver).filter(Boolean))].sort(), [jobs]);
  const brands = useMemo(() => [...new Set(records.map(r => r.brand).filter(Boolean))].sort(), [records]);

  const activeJobsByStorage = useMemo(() => {
    const m = {};
    for (const j of jobs) if (!j.date_out && j.storage_id) m[j.storage_id] = (m[j.storage_id] || 0) + 1;
    return m;
  }, [jobs]);

  // Derived situation: Close is manual; otherwise Open if it has active jobs, else Empty.
  const sit = useCallback(
    (r) => r.situation === "Close" ? "Close" : ((activeJobsByStorage[r.id] || 0) > 0 ? "Open" : "Empty"),
    [activeJobsByStorage]
  );

  // Job-first view: jobs grouped by job number (a job may span several locations).
  // You search a job number and instantly see all the places WHERE it is.
  const jobGroups = useMemo(() => {
    const q = search.trim().toLowerCase();
    const wh = tab.startsWith("wh:") ? tab.slice(3) : null;
    const parts = jobs
      .filter(j => {
        if (wh) return !j.date_out && j.warehouse === wh;          // active jobs in this warehouse
        if (tab === "delivered") return j.date_out;
        return !j.date_out;                                        // "active" (includes warehouse jobs)
      })
      .map(j => ({ ...j, storage: storageById[j.storage_id] || null }))
      .filter(j => {
        if (driverFilter && j.driver !== driverFilter) return false;
        if (q) {
          const s = j.storage || {};
          const hay = [j.job_number, j.customer, j.driver, j.notes, j.warehouse, s.brand, s.state, s.address, s.unit, s.gate_code].join(" ").toLowerCase();
          if (!hay.includes(q)) return false;
        }
        return true;
      });
    const map = new Map();
    for (const p of parts) {
      const key = jobKey(p);
      if (!map.has(key)) map.set(key, { key, job_number:p.job_number, customer:p.customer, driver:p.driver, date_in:p.date_in, date_out:p.date_out, volume:p.volume, notes:p.notes, parts:[] });
      map.get(key).parts.push(p);
    }
    const arr = [...map.values()];
    arr.sort((a, b) => {
      const ad = a.date_in || "", bd = b.date_in || "";
      if (sortBy === "date-asc") return ad > bd ? 1 : -1;
      if (sortBy === "customer") return (a.customer || "").localeCompare(b.customer || "");
      if (sortBy === "driver") return (a.driver || "").localeCompare(b.driver || "");
      return bd > ad ? 1 : -1;
    });
    return arr;
  }, [jobs, storageById, tab, search, driverFilter, sortBy]);

  // Units view: manage the physical lockers themselves.
  const unitRows = useMemo(() => {
    const q = search.trim().toLowerCase();
    const data = records.filter(r => {
      if (!q) return true;
      const hay = [r.brand, r.state, r.zip, r.address, r.unit, r.gate_code].join(" ").toLowerCase();
      return hay.includes(q);
    });
    data.sort((a, b) => {
      if (sortBy === "date-asc") return (a.date_opened || "") > (b.date_opened || "") ? 1 : -1;
      if (sortBy === "customer" || sortBy === "driver") return (a.brand || "").localeCompare(b.brand || "");
      return (b.date_opened || "") > (a.date_opened || "") ? 1 : -1;
    });
    return data;
  }, [records, search, sortBy]);

  const metrics = useMemo(() => {
    const activeParts = jobs.filter(j => !j.date_out);
    const deliveredParts = jobs.filter(j => j.date_out);
    const occupied = new Set(activeParts.map(j => j.storage_id));
    const withCost = records.filter(r => occupied.has(r.id) && r.monthly_cost && Number(r.monthly_cost) > 0);
    const totalCost = withCost.reduce((sum, r) => sum + Number(r.monthly_cost), 0);
    return {
      activeJobs: new Set(activeParts.map(jobKey)).size,
      deliveredJobs: new Set(deliveredParts.map(jobKey)).size,
      units: records.length,
      occupied: occupied.size,
      states: new Set(records.map(r => r.state).filter(Boolean)).size,
      totalCost,
    };
  }, [jobs, records]);

  const detail = records.find(r => r.id === detailId);

  // All parts (units) of the job currently open in the job-detail modal.
  const jobDetail = useMemo(() => {
    if (!jobDetailKey) return null;
    const parts = jobs.filter(j => jobKey(j) === jobDetailKey).map(j => ({ ...j, storage: storageById[j.storage_id] || null }));
    if (!parts.length) return null;
    const f = parts[0];
    return { key:jobDetailKey, job_number:f.job_number, customer:f.customer, driver:f.driver, date_in:f.date_in, volume:f.volume, notes:f.notes, parts };
  }, [jobDetailKey, jobs, storageById]);

  function openAdd() { setForm(EMPTY_FORM); setEditId(null); setShowAdd(true); }
  function openEdit(r) {
    setForm({ brand:r.brand||"", state:r.state||"", zip:r.zip||"", address:r.address||"", unit:r.unit||"", size:r.size||"", gate_code:r.gate_code||"", lock:r.lock||"", email:r.email||"", account:r.account||"", phone:r.phone||"", situation:r.situation==="Close"?"Close":"Open", monthly_cost:r.monthly_cost||"", card_on_file:r.card_on_file||"", date_opened:r.date_opened||"" });
    setEditId(r.id); setShowAdd(true);
  }

  async function saveForm() {
    setSaving(true);
    const payload = { brand:form.brand||null, state:form.state||null, zip:form.zip||null, address:form.address||null, unit:form.unit||null, size:form.size||null, gate_code:form.gate_code||null, lock:form.lock||null, email:form.email||null, account:form.account||null, phone:form.phone||null, situation:form.situation, monthly_cost:form.monthly_cost ? parseFloat(form.monthly_cost) : null, card_on_file:form.card_on_file||null, date_opened:form.date_opened||null };
    if (editId) { await supabase.from("storages").update(payload).eq("id", editId); }
    else { await supabase.from("storages").insert([payload]); }
    setSaving(false); setShowAdd(false);
  }

  function openAddJob(storageId) { setJobForm({ ...EMPTY_JOB, storage_ids: storageId ? [storageId] : [] }); setJobErr(null); setShowAddJob(true); }
  function toggleJobUnit(id) {
    setJobForm(f => ({ ...f, storage_ids: f.storage_ids.includes(id) ? f.storage_ids.filter(x => x !== id) : [...f.storage_ids, id] }));
  }
  function toggleJobWarehouse(name) {
    setJobForm(f => ({ ...f, warehouses: f.warehouses.includes(name) ? f.warehouses.filter(x => x !== name) : [...f.warehouses, name] }));
  }
  async function saveJob() {
    if (!jobForm.storage_ids.length && !jobForm.warehouses.length) { setJobErr("Elegí dónde está guardado (unidad o warehouse)."); return; }
    if (!jobForm.job_number && !jobForm.customer && !jobForm.driver) { setJobErr("Completá al menos job, cliente o driver."); return; }
    setJobSaving(true); setJobErr(null);
    const base = {
      job_number: jobForm.job_number || null,
      customer: jobForm.customer || null,
      driver: jobForm.driver || null,
      date_in: jobForm.date_in || today(),
      volume: jobForm.volume || null,
      notes: jobForm.notes || null,
    };
    const rows = [
      ...jobForm.storage_ids.map(sid => ({ ...base, storage_id: sid, warehouse: null })),
      ...jobForm.warehouses.map(w => ({ ...base, storage_id: null, warehouse: w })),
    ];
    const { error } = await supabase.from("storage_jobs").insert(rows);
    setJobSaving(false);
    if (error) { setJobErr(error.message); return; }
    setShowAddJob(false);
    loadJobs();
  }

  // Mark every part of a job (all its units) as delivered.
  async function deliverJobs(ids) {
    if (!ids || !ids.length) return;
    await supabase.from("storage_jobs").update({ date_out: today() }).in("id", ids);
    loadJobs();
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
        <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
          <Btn onClick={() => setShowAnalytics(a => !a)}>{showAnalytics ? "Ocultar graficos" : "📊 Analytics"}</Btn>
          <Btn onClick={openImportModal}>Importar WhatsApp</Btn>
          <Btn onClick={openAdd}>+ Unidad</Btn>
          <Btn primary disabled={!dbReady} onClick={() => openAddJob("")}>+ Nuevo job</Btn>
          <Btn onClick={() => supabase.auth.signOut()} style={{ color:"#888", fontSize:12 }}>Salir</Btn>
        </div>
      </div>

      {dbSetupNeeded && (
        <div style={{ background:"#FAEEDA", border:"1px solid #EF9F27", borderRadius:10, padding:"10px 14px", marginBottom:16, fontSize:13, color:"#854F0B", display:"flex", alignItems:"center", gap:10, flexWrap:"wrap" }}>
          <span>El historial de jobs por unidad necesita crear la tabla <strong>storage_jobs</strong> una sola vez.</span>
          <button onClick={() => setShowSetup(true)} style={{ background:"#854F0B", border:"none", color:"#fff", fontWeight:600, borderRadius:7, padding:"5px 12px", cursor:"pointer", fontSize:12 }}>Ver instrucciones</button>
        </div>
      )}

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))", gap:10, marginBottom:20 }}>
        {[
          { label:"Jobs activos", value:metrics.activeJobs, color:"#3B6D11" },
          { label:"Entregados", value:metrics.deliveredJobs, color:"#888" },
          { label:"Unidades", value:metrics.units, color:"#111" },
          { label:"Unidades ocupadas", value:metrics.occupied, color:"#185FA5" },
          { label:"Costo mensual", value:"$"+metrics.totalCost.toLocaleString(), color:"#185FA5" },
          { label:"Estados USA", value:metrics.states, color:"#888" },
        ].map(m => (
          <div key={m.label} style={{ background:"#fff", borderRadius:10, border:"1px solid #efefef", padding:"12px 14px" }}>
            <div style={{ fontSize:11, color:"#aaa", fontWeight:500, marginBottom:4 }}>{m.label}</div>
            <div style={{ fontSize:22, fontWeight:700, color:m.color }}>{m.value}</div>
          </div>
        ))}
      </div>

      {/* ANALYTICS */}
      {showAnalytics && (
        <div style={{ marginBottom:20 }}>

          {/* Fila 1: Aperturas vs Cierres + Costo por mes */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Aperturas vs cierres por mes</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Evolucion mensual de tu operacion</div>
              {(() => {
                const monthNames = {"01":"Ene","02":"Feb","03":"Mar","04":"Abr","05":"May","06":"Jun","07":"Jul","08":"Ago","09":"Sep","10":"Oct","11":"Nov","12":"Dic"};
                const opens = records.reduce((acc,r)=>{ if(r.date_opened){ const m=r.date_opened.slice(0,7); acc[m]=(acc[m]||0)+1; } return acc; },{});
                const months = Object.keys(opens).sort().slice(-8);
                const maxVal = Math.max(...months.map(m=>opens[m]||0), 1);
                return months.map(month => {
                  const [year, m] = month.split("-");
                  const label = `${monthNames[m]} ${year.slice(2)}`;
                  const openCount = opens[month]||0;
                  return (
                    <div key={month} style={{ marginBottom:10 }}>
                      <div style={{ display:"flex", justifyContent:"space-between", fontSize:12, marginBottom:4 }}>
                        <span style={{ fontWeight:500 }}>{label}</span>
                        <span style={{ color:"#3B6D11" }}>+{openCount} abiertos</span>
                      </div>
                      <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                        <div style={{ background:"#3B6D11", borderRadius:6, height:8, width:`${(openCount/maxVal)*100}%`, transition:"width .4s" }} />
                      </div>
                    </div>
                  );
                });
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Gasto mensual por empresa</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Cuanto le pagas a cada cadena de storages</div>
              {(() => {
                const byBrand = records.filter(r=>sit(r)==="Open" && r.monthly_cost && r.brand).reduce((acc,r)=>{ const b=r.brand.trim(); acc[b]=(acc[b]||0)+Number(r.monthly_cost); return acc; },{});
                const sorted = Object.entries(byBrand).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if(!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Carga costos para ver este grafico</p>;
                return sorted.map(([brand,cost]) => (
                  <div key={brand} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap", maxWidth:"65%" }}>{brand}</span>
                      <span style={{ fontSize:13, color:"#888", flexShrink:0 }}>${Number(cost).toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#A32D2D", borderRadius:6, height:8, width:`${(cost/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Fila 2: Storages por estado + Costo por estado */}
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:14, marginBottom:14 }}>
            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Storages activos por estado</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Donde tenes mas exposicion operativa</div>
              {(() => {
                const byState = records.filter(r=>sit(r)==="Open").reduce((acc,r)=>{ if(r.state){acc[r.state]=(acc[r.state]||0)+1;} return acc; },{});
                const sorted = Object.entries(byState).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                return sorted.map(([state,count]) => (
                  <div key={state} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500 }}>{state}</span>
                      <span style={{ fontSize:13, color:"#888" }}>{count}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#3B6D11", borderRadius:6, height:8, width:`${(count/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>

            <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", padding:"20px" }}>
              <div style={{ fontSize:11, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.06em", marginBottom:4 }}>Costo mensual por estado</div>
              <div style={{ fontSize:12, color:"#bbb", marginBottom:16 }}>Donde gastas mas dinero en storages</div>
              {(() => {
                const byCost = records.filter(r=>sit(r)==="Open" && r.monthly_cost && r.state).reduce((acc,r)=>{ acc[r.state]=(acc[r.state]||0)+Number(r.monthly_cost); return acc; },{});
                const sorted = Object.entries(byCost).sort((a,b)=>b[1]-a[1]).slice(0,10);
                const max = sorted[0]?.[1] || 1;
                if(!sorted.length) return <p style={{fontSize:12,color:"#bbb",textAlign:"center",marginTop:20}}>Carga costos para ver este grafico</p>;
                return sorted.map(([state,cost]) => (
                  <div key={state} style={{ marginBottom:12 }}>
                    <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:5 }}>
                      <span style={{ fontSize:13, fontWeight:500 }}>{state}</span>
                      <span style={{ fontSize:13, color:"#888" }}>${Number(cost).toLocaleString()}</span>
                    </div>
                    <div style={{ background:"#f5f5f5", borderRadius:6, height:8 }}>
                      <div style={{ background:"#185FA5", borderRadius:6, height:8, width:`${(cost/max)*100}%`, transition:"width .4s" }} />
                    </div>
                  </div>
                ));
              })()}
            </div>
          </div>

          {/* Panel IA */}
          <AIPanel records={records} />

        </div>
      )}

      <datalist id="drivers-list">{drivers.map(d => <option key={d} value={d} />)}</datalist>
      <datalist id="brands-list">{brands.map(b => <option key={b} value={b} />)}</datalist>
      <datalist id="states-list">{US_STATES.map(s => <option key={s} value={s} />)}</datalist>

      <div style={{ display:"flex", borderBottom:"1px solid #efefef", marginBottom:14, flexWrap:"wrap" }}>
        {[["active","Jobs activos"],["delivered","Entregados"],["units","Unidades"],
          ...WAREHOUSES.map(w => [`wh:${w}`, `Warehouse ${w}`])].map(([t,l]) => (
          <button key={t} onClick={() => setTab(t)} style={tabStyle(t)}>{l}</button>
        ))}
      </div>

      <div style={{ display:"flex", gap:8, marginBottom:14, flexWrap:"wrap" }}>
        <input value={search} onChange={e => setSearch(e.target.value)}
          placeholder={tab === "units" ? "Buscar empresa, ubicación, unidad..." : "Buscar por job #, cliente, driver, ubicación..."}
          style={{ ...inp, flex:1, minWidth:180 }} />
        {tab !== "units" && (
          <select value={driverFilter} onChange={e => setDriverFilter(e.target.value)} style={{ ...inp, minWidth:150 }}>
            <option value="">Todos los drivers</option>
            {drivers.map(d => <option key={d} value={d}>{d}</option>)}
          </select>
        )}
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inp, minWidth:150 }}>
          <option value="date-desc">Mas reciente</option>
          <option value="date-asc">Mas antiguo</option>
          <option value="customer">Cliente A-Z</option>
          <option value="driver">Driver A-Z</option>
        </select>
      </div>

      <div style={{ background:"#fff", borderRadius:12, border:"1px solid #efefef", overflow:"hidden" }}>
        <div style={{ overflowX:"auto" }}>
          {tab === "units" ? (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13, tableLayout:"fixed" }}>
              <colgroup>
                <col style={{width:120}}/><col style={{width:55}}/><col style={{width:70}}/><col style={{width:150}}/>
                <col style={{width:65}}/><col style={{width:110}}/><col style={{width:75}}/><col style={{width:80}}/>
              </colgroup>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Empresa","Estado","Zip","Direccion","Unidad","Gate Code","Jobs activos","Situacion"].map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap", overflow:"hidden", textOverflow:"ellipsis" }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {unitRows.length === 0 ? (
                  <tr><td colSpan={8} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>Sin unidades</td></tr>
                ) : unitRows.map(r => {
                  const n = activeJobsByStorage[r.id] || 0;
                  return (
                    <tr key={r.id} onClick={() => setDetailId(r.id)}
                      style={{ borderBottom:"1px solid #fafafa", cursor:"pointer" }}
                      onMouseEnter={e => e.currentTarget.style.background="#fafafa"}
                      onMouseLeave={e => e.currentTarget.style.background="transparent"}>
                      <td style={{ padding:"10px 12px", fontWeight:600, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.brand||"—"}</td>
                      <td style={{ padding:"10px 12px" }}>{r.state||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.zip||"—"}</td>
                      <td style={{ padding:"10px 12px", overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.address||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:12 }}>{r.unit||"—"}</td>
                      <td style={{ padding:"10px 12px", fontFamily:"monospace", fontSize:11 }}>
                        <span style={{ display:"inline-flex", alignItems:"center", maxWidth:"100%" }}>
                          <span style={{ overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>{r.gate_code||"—"}</span>
                          {r.gate_code && <CopyButton value={r.gate_code} />}
                        </span>
                      </td>
                      <td style={{ padding:"10px 12px" }}>
                        <span style={{ display:"inline-flex", alignItems:"center", justifyContent:"center", minWidth:22, height:22, padding:"0 7px", borderRadius:11, fontSize:12, fontWeight:600, background: n>0?"#EAF3DE":"#f5f5f5", color: n>0?"#3B6D11":"#bbb" }}>{n}</span>
                      </td>
                      <td style={{ padding:"10px 12px" }}><Badge situation={sit(r)} /></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table style={{ width:"100%", borderCollapse:"collapse", fontSize:13 }}>
              <thead>
                <tr style={{ background:"#fafafa", borderBottom:"1px solid #efefef" }}>
                  {["Job #","Cliente","Volumen","Empresa","Ubicación","Driver", tab==="delivered"?"Entregado":""].filter(Boolean).map(h => (
                    <th key={h} style={{ padding:"10px 12px", textAlign:"left", fontWeight:600, fontSize:11, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", whiteSpace:"nowrap" }}>{h}</th>
                  ))}
                  {tab !== "delivered" && <th style={{ width:150 }} />}
                </tr>
              </thead>
              <tbody>
                {jobGroups.length === 0 ? (
                  <tr><td colSpan={7} style={{ padding:"48px", textAlign:"center", color:"#bbb", fontSize:14 }}>{tab==="delivered" ? "Sin jobs entregados" : "Sin jobs activos. Cargá uno con \"+ Nuevo job\"."}</td></tr>
                ) : jobGroups.map(g => {
                  const empresas = [...new Set(g.parts.map(p => p.storage?.brand).filter(Boolean))];
                  const locs = [...new Set(g.parts.map(p => p.warehouse ? `Warehouse ${p.warehouse}` : p.storage?.address).filter(Boolean))];
                  return (
                  <tr key={g.key} style={{ borderBottom:"1px solid #fafafa", verticalAlign:"top" }}>
                    <td style={{ padding:"12px", whiteSpace:"nowrap" }}>
                      <button onClick={() => setJobDetailKey(g.key)}
                        style={{ fontFamily:"monospace", fontSize:12, fontWeight:600, color:"#185FA5", background:"none", border:"none", padding:0, cursor:"pointer", textDecoration:"underline" }}>
                        {g.job_number || "(ver)"}
                      </button>
                    </td>
                    <td style={{ padding:"12px" }}>{g.customer||"—"}</td>
                    <td style={{ padding:"12px" }}>{g.volume||"—"}</td>
                    <td style={{ padding:"12px", fontWeight:500 }}>{empresas.length ? empresas.join(", ") : "—"}</td>
                    <td style={{ padding:"12px", fontSize:12, color:"#555" }}>
                      {locs.length ? locs.map((a, i) => <div key={i} style={{ marginBottom: i < locs.length-1 ? 3 : 0 }}>{a}</div>) : "—"}
                    </td>
                    <td style={{ padding:"12px" }}>{g.driver||"—"}</td>
                    {tab === "delivered" ? (
                      <td style={{ padding:"12px", fontSize:12, color:"#888", whiteSpace:"nowrap" }}>{g.parts.map(p => p.date_out).filter(Boolean)[0] || "—"}</td>
                    ) : (
                      <td style={{ padding:"12px", textAlign:"right" }}>
                        <Btn onClick={() => deliverJobs(g.parts.map(p => p.id))} style={{ padding:"5px 10px", fontSize:12 }}>Marcar entregado</Btn>
                      </td>
                    )}
                  </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div style={{ padding:"10px 14px", borderTop:"1px solid #fafafa", fontSize:12, color:"#bbb" }}>
          {tab === "units" ? `${unitRows.length} de ${records.length} unidades` : `${jobGroups.length} job(s)`}
        </div>
      </div>

      {jobDetail && (
        <Modal title={`Job ${jobDetail.job_number || ""}`.trim()} onClose={() => setJobDetailKey(null)}
          footer={<>
            {jobDetail.parts.some(p => !p.date_out) && (
              <Btn onClick={() => deliverJobs(jobDetail.parts.filter(p => !p.date_out).map(p => p.id))}>Marcar todo entregado</Btn>
            )}
            <Btn primary onClick={() => setJobDetailKey(null)}>Cerrar</Btn>
          </>}>
          <SectionLabel>Datos del job</SectionLabel>
          <DetailRow label="Cliente" value={jobDetail.customer} />
          <DetailRow label="Driver (quién lo dejó)" value={jobDetail.driver} />
          <DetailRow label="Volumen" value={jobDetail.volume} />
          <DetailRow label="Fecha de entrada" value={jobDetail.date_in} />
          <DetailRow label="Notas" value={jobDetail.notes} />

          <SectionLabel>{jobDetail.parts.length === 1 ? "Dónde está guardado" : `Dónde está guardado (${jobDetail.parts.length})`}</SectionLabel>
          <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
            {jobDetail.parts.map(p => {
              const s = p.storage || {};
              const delivered = !!p.date_out;
              const isWh = !!p.warehouse;
              return (
                <div key={p.id} style={{ border:"1px solid #f0f0f0", borderRadius:10, padding:"10px 12px", background: delivered ? "#fafafa" : "#fff" }}>
                  <div style={{ display:"flex", alignItems:"center", gap:8, marginBottom:6 }}>
                    <span style={jobBadgeStyle(delivered)}>
                      <span style={{ width:6, height:6, borderRadius:"50%", background: delivered ? "#bbb" : "#639922" }} />
                      {delivered ? "Entregado" : "Activo"}
                    </span>
                    <strong style={{ fontSize:13 }}>{isWh ? `🏭 Warehouse ${p.warehouse}` : (s.brand || "Unidad")}</strong>
                    <span style={{ flex:1 }} />
                    {!delivered && <Btn onClick={() => deliverJobs([p.id])} style={{ padding:"4px 10px", fontSize:12 }}>Marcar entregado</Btn>}
                  </div>
                  <div style={{ fontSize:13, color:"#444", display:"flex", flexDirection:"column", gap:3 }}>
                    {isWh ? (
                      <div>📍 Warehouse propio — {p.warehouse}</div>
                    ) : (
                      <>
                        {s.address && <div>📍 {s.address}</div>}
                        <div>Unidad: <strong style={{ fontFamily:"monospace" }}>{s.unit || "—"}</strong></div>
                        {s.gate_code && (
                          <div style={{ display:"inline-flex", alignItems:"center" }}>Gate code: <span style={{ fontFamily:"monospace", marginLeft:4 }}>{s.gate_code}</span><CopyButton value={s.gate_code} /></div>
                        )}
                      </>
                    )}
                    <div style={{ color:"#888" }}>In: {p.date_in || "—"}{delivered ? ` · Out: ${p.date_out}` : ""}</div>
                  </div>
                  {!isWh && (
                    <div style={{ marginTop:6 }}>
                      <span onClick={() => { setJobDetailKey(null); setDetailId(p.storage_id); }}
                        style={{ fontSize:12, color:"#185FA5", cursor:"pointer", textDecoration:"underline" }}>Ver unidad completa →</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        </Modal>
      )}

      {detail && (
        <Modal title={`${detail.brand||"Unidad"}${detail.unit ? " — "+detail.unit : ""}${detail.state ? " · "+detail.state : ""}`} onClose={() => setDetailId(null)}
          footer={<>
            <Btn danger onClick={() => deleteRecord(detail.id)}>Eliminar</Btn>
            <Btn onClick={() => { setDetailId(null); openEdit(detail); }}>Editar unidad</Btn>
            <Btn primary onClick={() => openAddJob(detail.id)}>+ Agregar job</Btn>
          </>}>
          <div style={{ marginBottom:10, display:"flex", alignItems:"center", gap:10 }}>
            <Badge situation={sit(detail)} />
            <span style={{ fontSize:13, color:"#888" }}>{activeJobsByStorage[detail.id] || 0} job(s) activo(s)</span>
          </div>
          <SectionLabel>Unidad</SectionLabel>
          <DetailRow label="Empresa" value={detail.brand} />
          <DetailRow label="Direccion" value={detail.address} />
          <DetailRow label="Estado" value={detail.state} />
          <DetailRow label="Zip code" value={detail.zip} />
          <DetailRow label="Unidad" value={detail.unit} />
          <DetailRow label="Tamano" value={detail.size} />
          <DetailRow label="Gate Code" value={detail.gate_code} />
          <DetailRow label="Lock / Combo" value={detail.lock} />
          <SectionLabel>Cuenta</SectionLabel>
          <DetailRow label="Email" value={detail.email} />
          <DetailRow label="Account #" value={detail.account} />
          <DetailRow label="Teléfono" value={detail.phone} />
          <DetailRow label="Tarjeta" value={detail.card_on_file} />
          <DetailRow label="Costo mensual" value={detail.monthly_cost ? "$" + detail.monthly_cost : null} />
          <DetailRow label="Fecha de alquiler" value={detail.date_opened} />

          <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", margin:"16px 0 8px" }}>
            <span style={{ fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.07em" }}>Job History</span>
            <span style={{ fontSize:11, color:"#bbb" }}>{activeJobsByStorage[detail.id] || 0} activo(s)</span>
          </div>
          <JobHistory
            storageId={detail.id}
            jobs={jobs.filter(j => j.storage_id === detail.id)}
            dbReady={dbReady}
            onSetup={() => setShowSetup(true)}
            onChange={loadJobs}
          />
        </Modal>
      )}

      {showAdd && (
        <Modal title={editId ? "Editar unidad" : "Nueva unidad"} onClose={() => setShowAdd(false)}
          footer={<>
            <Btn onClick={() => setShowAdd(false)}>Cancelar</Btn>
            <Btn primary disabled={saving} onClick={saveForm}>{saving ? "Guardando..." : "Guardar"}</Btn>
          </>}>
          <p style={{ fontSize:12, color:"#999", margin:"0 0 12px" }}>Datos fijos de la unidad. Los clientes y jobs se cargan aparte en el historial.</p>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            <Field label="Empresa"><input style={inp} list="brands-list" value={form.brand} onChange={e => setForm(f => ({...f, brand:e.target.value}))} placeholder="Elegí o escribí (CubeSmart...)" /></Field>
            <Field label="Estado"><input style={inp} list="states-list" value={form.state} onChange={e => setForm(f => ({...f, state:e.target.value.toUpperCase()}))} placeholder="TN" /></Field>
            <Field label="Zip code"><input style={inp} value={form.zip} onChange={e => setForm(f => ({...f, zip:e.target.value}))} placeholder="38555" /></Field>
            <Field label="Direccion" full><input style={inp} value={form.address} onChange={e => setForm(f => ({...f, address:e.target.value}))} placeholder="1870 West Ave, Crossville, TN 38555" /></Field>
            <Field label="Unidad #"><input style={inp} value={form.unit} onChange={e => setForm(f => ({...f, unit:e.target.value}))} placeholder="G13" /></Field>
            <Field label="Tamano"><input style={inp} value={form.size} onChange={e => setForm(f => ({...f, size:e.target.value}))} placeholder="10x10" /></Field>
            <Field label="Gate Code"><input style={inp} value={form.gate_code} onChange={e => setForm(f => ({...f, gate_code:e.target.value}))} placeholder="*130438#" /></Field>
            <Field label="Lock / Combo"><input style={inp} value={form.lock} onChange={e => setForm(f => ({...f, lock:e.target.value}))} placeholder="use 8141 to unlock..." /></Field>
            <Field label="Email"><input style={inp} value={form.email} onChange={e => setForm(f => ({...f, email:e.target.value}))} placeholder="service@..." /></Field>
            <Field label="Account #"><input style={inp} value={form.account} onChange={e => setForm(f => ({...f, account:e.target.value}))} placeholder="NONE" /></Field>
            <Field label="Teléfono"><input style={inp} value={form.phone} onChange={e => setForm(f => ({...f, phone:e.target.value}))} placeholder="(931) 555-0199" /></Field>
            <Field label="Estado de la unidad">
              <select style={inp} value={form.situation} onChange={e => setForm(f => ({...f, situation:e.target.value}))}>
                <option value="Open">Activa (automático según jobs)</option>
                <option value="Close">Cerrada</option>
              </select>
            </Field>
            <Field label="Costo mensual ($)"><input style={inp} type="number" value={form.monthly_cost} onChange={e => setForm(f => ({...f, monthly_cost:e.target.value}))} placeholder="0" /></Field>
            <Field label="Tarjeta"><input style={inp} value={form.card_on_file} onChange={e => setForm(f => ({...f, card_on_file:e.target.value}))} placeholder="Visa ****1234" /></Field>
            <Field label="Fecha de alquiler"><input style={inp} type="date" value={form.date_opened} onChange={e => setForm(f => ({...f, date_opened:e.target.value}))} /></Field>
          </div>
        </Modal>
      )}

      {showAddJob && (
        <Modal title="Nuevo job" onClose={() => setShowAddJob(false)}
          footer={<>
            <Btn onClick={() => setShowAddJob(false)}>Cancelar</Btn>
            <Btn primary disabled={jobSaving} onClick={saveJob}>{jobSaving ? "Guardando..." : "Guardar job"}</Btn>
          </>}>
          <Field label={`Dónde se guarda — podés elegir varias${(jobForm.storage_ids.length + jobForm.warehouses.length) ? ` (${jobForm.storage_ids.length + jobForm.warehouses.length})` : ""}`} full>
            <div style={{ border:"1px solid #e5e5e5", borderRadius:8, maxHeight:200, overflowY:"auto", background:"#fff" }}>
              <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Warehouses propios</div>
              {WAREHOUSES.map(w => {
                const checked = jobForm.warehouses.includes(w);
                return (
                  <label key={w} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleJobWarehouse(w)} />
                    <span>🏭 Warehouse {w}</span>
                  </label>
                );
              })}
              <div style={{ padding:"6px 10px", fontSize:10, fontWeight:600, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.05em", background:"#fafafa" }}>Unidades alquiladas</div>
              {records.length === 0 ? (
                <div style={{ padding:"10px 12px", fontSize:12, color:"#bbb" }}>No hay unidades cargadas todavía.</div>
              ) : records.map(r => {
                const checked = jobForm.storage_ids.includes(r.id);
                return (
                  <label key={r.id} style={{ display:"flex", alignItems:"center", gap:8, padding:"7px 10px", fontSize:13, cursor:"pointer", borderBottom:"1px solid #f5f5f5", background: checked ? "#f0fdf4" : "#fff" }}>
                    <input type="checkbox" checked={checked} onChange={() => toggleJobUnit(r.id)} />
                    <span>{[r.brand, r.unit && `Unidad ${r.unit}`, r.state].filter(Boolean).join(" · ") || `Unidad #${r.id}`}</span>
                  </label>
                );
              })}
            </div>
          </Field>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10, marginTop:10 }}>
            <Field label="Job #"><input style={inp} value={jobForm.job_number} onChange={e => setJobForm(f => ({...f, job_number:e.target.value}))} placeholder="B8417142" /></Field>
            <Field label="Date in"><input style={inp} type="date" value={jobForm.date_in} onChange={e => setJobForm(f => ({...f, date_in:e.target.value}))} /></Field>
            <Field label="Cliente"><input style={inp} value={jobForm.customer} onChange={e => setJobForm(f => ({...f, customer:e.target.value}))} placeholder="Nombre del cliente" /></Field>
            <Field label="Driver (quién lo dejó)"><input style={inp} list="drivers-list" value={jobForm.driver} onChange={e => setJobForm(f => ({...f, driver:e.target.value}))} placeholder="Elegí o escribí un driver" /></Field>
            <Field label="Volumen"><input style={inp} value={jobForm.volume} onChange={e => setJobForm(f => ({...f, volume:e.target.value}))} placeholder="ej: 1200 cu ft / 5 pallets" /></Field>
            <Field label="Notas"><input style={inp} value={jobForm.notes} onChange={e => setJobForm(f => ({...f, notes:e.target.value}))} placeholder="Notas del job" /></Field>
          </div>
          {jobErr && <div style={{ fontSize:12, color:"#b91c1c", marginTop:10 }}>{jobErr}</div>}
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

      {showSetup && (
        <Modal title="Activar historial de jobs" onClose={() => setShowSetup(false)}
          footer={<Btn primary onClick={() => setShowSetup(false)}>Listo</Btn>}>
          <p style={{ fontSize:13, color:"#555", lineHeight:1.6, marginTop:0 }}>
            La app intenta crear la tabla <strong>storage_jobs</strong> automáticamente, pero la clave pública no
            permite crear tablas. Ejecutá este SQL <strong>una sola vez</strong> en el SQL Editor de Supabase
            (o pedíselo a quien administre la base). Después recargá: el historial de jobs se activa solo.
          </p>
          <pre style={{ background:"#0f172a", color:"#e2e8f0", borderRadius:10, padding:"14px", fontSize:11.5, lineHeight:1.5, overflowX:"auto", whiteSpace:"pre" }}>{STORAGE_JOBS_SQL}</pre>
          <div style={{ display:"flex", justifyContent:"flex-end", marginTop:10 }}>
            <Btn onClick={() => {
              navigator.clipboard?.writeText(STORAGE_JOBS_SQL).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }).catch(() => {});
            }}>{sqlCopied ? "✓ Copiado" : "Copiar SQL"}</Btn>
          </div>
        </Modal>
      )}
    </div>
  );
}
