// Broker desk — the side where WE are the carrier: brokers (Allied, Atlas…)
// give us jobs, mostly by WhatsApp or a phone call, and settle them later with
// a closing sheet (docs/broker-settlements.md).
//
//   BrokerJobQuickAdd      a broker job in one short form; paste the WhatsApp
//                          message or a screenshot and the AI pre-fills it.
//   SettlementFromDocModal the broker's closing sheet (PDF/photo) read by the
//                          AI, matched to our jobs and compared side by side
//                          before a sheet is created.
//   BrokerPaymentModal     a payment from (or to) a broker spread over its open
//                          sheets, oldest first; paid-off sheets close by themselves.
//   BrokerStatementModal   the running balance with one broker, printable.
//
// The readers only pre-fill (api/trip-suggestions.mjs → lib/brokerDocs.mjs);
// every save is a person's click. Settlement math stays in src/appData.js
// (sheetCalc) and the ledger in lib/brokerSettle.mjs.
import { useState, useMemo } from "react";
import { tr, getI18nLang } from "./i18n.js";
import { dbFailed } from "./db.js";
import { numv, jobKey, parseCf } from "./analyticsData.js";
import { matchBrokerName, matchSheetLines } from "./brokerDocsData.js";
import { openSheetsFor, allocatePayment, sheetsToSettle, brokerStatement, brokerLedger } from "./brokerSettleData.js";

const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none" };
const th = { padding:"8px 8px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"7px 8px", fontSize:12.5, verticalAlign:"middle" };
const fieldLabel = { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4, display:"block" };
const card = { background:"#fff", borderRadius:12, border:"1px solid #efefef" };
const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
const todayISO = () => new Date().toLocaleDateString("en-CA");
const pillBtn = (on) => ({ padding:"7px 14px", borderRadius:20, border:"1px solid " + (on ? "#111" : "#e5e5e5"), background: on ? "#111" : "#fff", color: on ? "#fff" : "#555", fontSize:12.5, fontWeight:600, cursor:"pointer" });
const METHODS = [["ach", "ACH"], ["check", "Check"], ["zelle", "Zelle"], ["wire", "Wire"], ["cash", "Cash"], ["other", "Other"]];

function Field({ label, children, style }) {
  return <div style={{ marginBottom:10, ...style }}><span style={fieldLabel}>{label}</span>{children}</div>;
}

// Calls a read-only reader action on /api/trip-suggestions with the user's session.
async function readerCall(session, body) {
  const res = await fetch("/api/trip-suggestions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session?.access_token || ""}` },
    body: JSON.stringify({ ...body, lang: getI18nLang() }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

// A pasted or picked image as { media_type, data (base64), preview }.
function readImage(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => { const url = String(r.result || ""); resolve({ media_type: file.type, data: url.replace(/^data:[^,]*,/, ""), preview: url }); };
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

// ── 1. A broker job from WhatsApp or a call ──────────────────────────────────

export const EMPTY_BROKER_JOB = {
  broker_id:"", job_number:"", customer:"", client_phone:"",
  pickup_city:"", pickup_state:"", pickup_zip:"",
  delivery_address:"", delivery_city:"", delivery_state:"", delivery_zip:"",
  fadd:"", delivery_date:"", cf:"", bol_balance:"", carrier_rate_per_cf:"", pads_received:"", notes:"",
};

export function BrokerJobQuickAdd({ session, brokers = [], Btn, Modal, onClose, onSave }) {
  const [form, setForm] = useState({ ...EMPTY_BROKER_JOB });
  const [text, setText] = useState("");
  const [image, setImage] = useState(null);
  const [reading, setReading] = useState(false);
  const [readNote, setReadNote] = useState("");
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const live = useMemo(() => brokers.filter((b) => !b.deleted_at).sort((a, b) => String(a.name).localeCompare(String(b.name))), [brokers]);
  const fee = numv(form.cf) * numv(form.carrier_rate_per_cf);

  const pickBroker = (id) => {
    const b = live.find((x) => String(x.id) === String(id));
    setForm((f) => ({ ...f, broker_id: id, carrier_rate_per_cf: f.carrier_rate_per_cf || (b?.default_rate_per_cf != null ? String(b.default_rate_per_cf) : "") }));
  };
  async function takeImage(file) {
    if (!file || !/^image\/(jpeg|png|webp|gif)$/.test(file.type)) { window.alert(tr("Use a JPG, PNG or WebP screenshot.", "Usá una captura JPG, PNG o WebP.")); return; }
    if (file.size > 3 * 1024 * 1024) { window.alert(tr("The screenshot is too large (3 MB max).", "La captura es muy grande (máximo 3 MB).")); return; }
    setImage(await readImage(file));
  }
  function onPaste(e) {
    const item = [...(e.clipboardData?.items || [])].find((i) => i.type.startsWith("image/"));
    if (item) { e.preventDefault(); takeImage(item.getAsFile()); }
  }
  async function read() {
    if (!text.trim() && !image) { window.alert(tr("Paste the message or a screenshot first.", "Pegá primero el mensaje o una captura.")); return; }
    setReading(true); setReadNote("");
    try {
      const { fields: x } = await readerCall(session, { action: "broker_job_extract", text, image: image ? { media_type: image.media_type, data: image.data } : null });
      const b = matchBrokerName(x.broker_name, live);
      setForm((f) => ({
        ...f,
        broker_id: b ? String(b.id) : f.broker_id,
        job_number: x.broker_job_number || f.job_number, customer: x.customer || f.customer, client_phone: x.client_phone || f.client_phone,
        pickup_city: x.pickup_city || f.pickup_city, pickup_state: x.pickup_state || f.pickup_state, pickup_zip: x.pickup_zip || f.pickup_zip,
        delivery_address: x.delivery_address || f.delivery_address, delivery_city: x.delivery_city || f.delivery_city,
        delivery_state: x.delivery_state || f.delivery_state, delivery_zip: x.delivery_zip || f.delivery_zip,
        fadd: x.fadd || f.fadd, delivery_date: x.delivery_date || f.delivery_date,
        cf: x.cf ? String(x.cf) : f.cf, bol_balance: x.bol_balance ? String(x.bol_balance) : f.bol_balance,
        carrier_rate_per_cf: x.rate_per_cf ? String(x.rate_per_cf) : (f.carrier_rate_per_cf || (b?.default_rate_per_cf != null ? String(b.default_rate_per_cf) : "")),
        pads_received: x.pads ? String(x.pads) : f.pads_received, notes: x.notes || f.notes,
      }));
      const missing = [!b && x.broker_name && tr(`broker "${x.broker_name}" is not in the list`, `el broker "${x.broker_name}" no está en la lista`), x.low_confidence?.length && tr(`check: ${x.low_confidence.join(", ")}`, `revisá: ${x.low_confidence.join(", ")}`)].filter(Boolean);
      setReadNote(missing.length ? missing.join(" · ") : tr("Read. Check the fields and save.", "Listo. Revisá los campos y guardá."));
    } catch (e) {
      setReadNote(tr(`Could not read it: ${e.message}`, `No se pudo leer: ${e.message}`));
    }
    setReading(false);
  }
  async function save() {
    if (!form.broker_id) { window.alert(tr("Choose the broker.", "Elegí el broker.")); return; }
    if (!form.job_number && !form.customer) { window.alert(tr("Fill in at least the job number or the customer.", "Completá al menos el número de job o el cliente.")); return; }
    setSaving(true);
    const ok = await onSave(form);
    setSaving(false);
    if (ok) onClose();
  }

  return (
    <Modal wide title="New broker job" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving} onClick={save}>{saving ? "Saving…" : "Save job"}</Btn></>}>
      <div style={{ ...card, background:"#FAFAFA", padding:12, marginBottom:14 }} onPaste={onPaste}>
        <span style={fieldLabel}>Paste the WhatsApp message or a screenshot</span>
        <div style={{ display:"grid", gridTemplateColumns: image ? "minmax(0,1fr) 120px" : "1fr", gap:10 }}>
          <textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} style={{ ...inp, resize:"vertical" }}
            placeholder="Paste the broker's message here, or paste a screenshot (Ctrl+V). For a phone call, type your notes." />
          {image && (
            <div style={{ position:"relative" }}>
              <img src={image.preview} alt="" style={{ width:"100%", maxHeight:110, objectFit:"cover", borderRadius:8, border:"1px solid #eee" }} />
              <button onClick={() => setImage(null)} title="Remove" style={{ position:"absolute", top:4, right:4, background:"#fff", border:"1px solid #ddd", borderRadius:20, cursor:"pointer", fontSize:11 }}>x</button>
            </div>
          )}
        </div>
        <div style={{ display:"flex", gap:8, alignItems:"center", marginTop:8, flexWrap:"wrap" }}>
          <Btn primary disabled={reading} onClick={read}>{reading ? "Reading…" : "✨ Read and fill in"}</Btn>
          <label style={{ fontSize:12.5, color:"#185FA5", cursor:"pointer" }}>
            <input type="file" accept="image/jpeg,image/png,image/webp,image/gif" style={{ display:"none" }} onChange={(e) => takeImage(e.target.files?.[0])} />
            Attach a screenshot
          </label>
          {readNote && <span style={{ fontSize:12, color:"#666" }}>{readNote}</span>}
        </div>
      </div>

      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(180px, 1fr))", gap:"0 12px" }}>
        <Field label="Broker"><select value={form.broker_id} onChange={(e) => pickBroker(e.target.value)} style={inp}><option value="">Choose…</option>{live.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Broker's job #"><input value={form.job_number} onChange={(e) => set("job_number", e.target.value)} style={inp} /></Field>
        <Field label="Customer"><input value={form.customer} onChange={(e) => set("customer", e.target.value)} style={inp} /></Field>
        <Field label="Customer phone"><input value={form.client_phone} onChange={(e) => set("client_phone", e.target.value)} style={inp} /></Field>
        <Field label="From (city, state)"><div style={{ display:"flex", gap:6 }}><input value={form.pickup_city} onChange={(e) => set("pickup_city", e.target.value)} style={inp} placeholder="City" /><input value={form.pickup_state} onChange={(e) => set("pickup_state", e.target.value)} style={{ ...inp, width:60 }} placeholder="ST" /></div></Field>
        <Field label="Delivery address"><input value={form.delivery_address} onChange={(e) => set("delivery_address", e.target.value)} style={inp} /></Field>
        <Field label="Delivery city, state, ZIP"><div style={{ display:"flex", gap:6 }}><input value={form.delivery_city} onChange={(e) => set("delivery_city", e.target.value)} style={inp} placeholder="City" /><input value={form.delivery_state} onChange={(e) => set("delivery_state", e.target.value)} style={{ ...inp, width:60 }} placeholder="ST" /><input value={form.delivery_zip} onChange={(e) => set("delivery_zip", e.target.value)} style={{ ...inp, width:80 }} placeholder="ZIP" /></div></Field>
        <Field label="FADD"><input type="date" value={form.fadd} onChange={(e) => set("fadd", e.target.value)} style={inp} /></Field>
        <Field label="Delivery date"><input type="date" value={form.delivery_date} onChange={(e) => set("delivery_date", e.target.value)} style={inp} /></Field>
        <Field label="CF"><input type="number" value={form.cf} onChange={(e) => set("cf", e.target.value)} style={inp} /></Field>
        <Field label="BOL balance (collect)"><input type="number" step="0.01" value={form.bol_balance} onChange={(e) => set("bol_balance", e.target.value)} style={inp} /></Field>
        <Field label="Our rate per CF"><input type="number" step="0.01" value={form.carrier_rate_per_cf} onChange={(e) => set("carrier_rate_per_cf", e.target.value)} style={inp} /></Field>
        <Field label="Pads received"><input type="number" value={form.pads_received} onChange={(e) => set("pads_received", e.target.value)} style={inp} /></Field>
        <Field label="Notes for the driver" style={{ gridColumn:"1 / -1" }}><textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} style={{ ...inp, resize:"vertical" }} /></Field>
      </div>
      {fee > 0 && <div style={{ fontSize:12.5, color:"#555" }}>{tr(`Carrier fee: ${numv(form.cf).toLocaleString()} CF × $${numv(form.carrier_rate_per_cf).toFixed(2)} = ${fmt$(fee)}`, `Carrier fee: ${numv(form.cf).toLocaleString()} CF × $${numv(form.carrier_rate_per_cf).toFixed(2)} = ${fmt$(fee)}`)}</div>}
    </Modal>
  );
}

// ── 2. A closing sheet from the broker's paper ───────────────────────────────

export function SettlementFromDocModal({ supabase, session, brokers = [], jobs = [], closingSheets = [], jobCollectedFor, Btn, Modal, onClose, onCreated }) {
  const [file, setFile] = useState(null);
  const [path, setPath] = useState("");
  const [reading, setReading] = useState(false);
  const [err, setErr] = useState("");
  const [sheet, setSheet] = useState(null);           // what the AI read
  const [head, setHead] = useState(null);             // editable sheet header
  const [lines, setLines] = useState([]);             // [{ line, key, use: "sheet"|"crm" }]
  const [saving, setSaving] = useState(false);
  const live = useMemo(() => brokers.filter((b) => !b.deleted_at), [brokers]);

  // One row per job (split jobs share a key), with what the CRM has today.
  const jobGroups = useMemo(() => {
    const m = new Map();
    for (const j of jobs) {
      if (j.deleted_at) continue;
      const k = jobKey(j);
      if (!m.has(k)) m.set(k, { key: k, job_number: j.job_number, customer: j.customer, broker_id: j.broker_id, closing_sheet_id: j.closing_sheet_id, rows: [] });
      m.get(k).rows.push(j);
    }
    return [...m.values()];
  }, [jobs]);
  const byKey = useMemo(() => Object.fromEntries(jobGroups.map((g) => [g.key, g])), [jobGroups]);
  const brokerJobs = (bid) => jobGroups.filter((g) => !bid || String(g.broker_id) === String(bid));
  const crmOf = (g) => {
    const r = g.rows.find((x) => !x.split_group) || g.rows[0];
    return { cf: parseCf(r.volume), rate: numv(r.carrier_rate_per_cf), bol: numv(r.bol_balance), collected: jobCollectedFor ? jobCollectedFor(r) : numv(r.bol_collected) };
  };

  async function upload(f) {
    if (!f) return;
    if (!/^(application\/pdf|image\/(jpeg|png|webp|gif))$/.test(f.type)) { setErr(tr("Upload a PDF or a photo (JPG, PNG).", "Subí un PDF o una foto (JPG, PNG).")); return; }
    setErr(""); setFile(f); setReading(true);
    const ext = (f.name.split(".").pop() || "pdf").toLowerCase().replace(/[^a-z0-9]/g, "");
    const p = `sheets/cs-${Date.now()}.${ext}`;
    const up = await supabase.storage.from("settlement-docs").upload(p, f, { contentType: f.type, upsert: true });
    if (up.error) { setReading(false); setErr(tr(`Upload failed: ${up.error.message}`, `No se pudo subir: ${up.error.message}`)); return; }
    setPath(p);
    try {
      const { sheet: s } = await readerCall(session, { action: "settlement_extract", path: p });
      const b = matchBrokerName(s.broker_name, live);
      const bid = b ? String(b.id) : "";
      setSheet(s);
      setHead({ broker_id: bid, closing_sheet_number: s.closing_sheet_number, load_date: s.load_date || todayISO(),
        trip_cost: String(s.trip_cost || ""), labor_charges: String(s.labor_charges || ""), other_fees: String(s.other_fees || ""),
        other_fees_description: s.other_fees_description, charge_per_pad: s.charge_per_pad ? String(s.charge_per_pad) : "", notes: s.notes });
      setLines(matchSheetLines(s.lines, brokerJobs(bid).filter((g) => !g.closing_sheet_id)).map((x) => ({ ...x, use: "sheet" })));
      if (!s.is_closing_sheet) setErr(tr("This does not look like a closing sheet. Check the file.", "Esto no parece una closing sheet. Revisá el archivo."));
    } catch (e) {
      setErr(tr(`Could not read it: ${e.message}`, `No se pudo leer: ${e.message}`));
    }
    setReading(false);
  }
  const rematch = (bid) => {
    setHead((h) => ({ ...h, broker_id: bid }));
    if (sheet) setLines(matchSheetLines(sheet.lines, brokerJobs(bid).filter((g) => !g.closing_sheet_id)).map((x) => ({ ...x, use: "sheet" })));
  };
  const setLine = (i, patch) => setLines((ls) => ls.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  async function create() {
    if (!head.broker_id) { window.alert(tr("Choose the broker.", "Elegí el broker.")); return; }
    const linked = lines.filter((l) => l.key);
    if (!linked.length && !window.confirm(tr("No line is linked to a job. Create the sheet anyway?", "Ninguna línea está vinculada a un job. ¿Crear la sheet igual?"))) return;
    setSaving(true);
    const ins = await supabase.from("closing_sheets").insert([{
      closing_sheet_number: head.closing_sheet_number || null, broker_id: Number(head.broker_id), load_date: head.load_date || todayISO(), status: "open",
      trip_cost: numv(head.trip_cost), labor_charges: numv(head.labor_charges), other_fees: numv(head.other_fees),
      other_fees_description: head.other_fees_description || null, charge_per_pad: head.charge_per_pad === "" ? 7 : numv(head.charge_per_pad),
      notes: head.notes || null, document_path: path || null,
    }]).select("id").single();
    if (ins.error) { setSaving(false); dbFailed(ins, "closing_sheets"); return; }
    const sheetId = ins.data.id;
    for (const l of linked) {
      const g = byKey[l.key]; if (!g) continue;
      const patch = { closing_sheet_id: sheetId };
      // "Use the sheet's numbers": the broker's CF, rate and BOL balance replace ours.
      if (l.use === "sheet") {
        if (l.line.cf) patch.volume = String(l.line.cf);
        if (l.line.rate_per_cf) patch.carrier_rate_per_cf = l.line.rate_per_cf;
        if (l.line.bol_balance) patch.bol_balance = l.line.bol_balance;
        if (l.line.pads_received) patch.pads_received = l.line.pads_received;
        if (l.line.pads_returned) patch.pads_returned = l.line.pads_returned;
      }
      if (dbFailed(await supabase.from("storage_jobs").update(patch).in("id", g.rows.map((r) => r.id)), "storage_jobs")) { setSaving(false); return; }
    }
    setSaving(false);
    onCreated(sheetId);
  }

  const diff = (a, b) => Math.abs(numv(a) - numv(b)) > 0.5;
  return (
    <Modal wide title="Closing sheet from the broker's document" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn>{head && <Btn primary disabled={saving} onClick={create}>{saving ? "Creating…" : "Create closing sheet"}</Btn>}</>}>
      {!head && (
        <div style={{ ...card, background:"#FAFAFA", padding:20, textAlign:"center" }}>
          <div style={{ fontSize:13.5, marginBottom:10 }}>Upload the closing sheet the broker sent (PDF or photo). The AI reads it and matches each line to your jobs; nothing is saved until you confirm.</div>
          <label style={{ display:"inline-block", background:"#111", color:"#fff", borderRadius:8, padding:"9px 16px", fontWeight:600, fontSize:13, cursor:"pointer", opacity: reading ? 0.6 : 1 }}>
            <input type="file" accept="application/pdf,image/jpeg,image/png,image/webp" style={{ display:"none" }} disabled={reading} onChange={(e) => upload(e.target.files?.[0])} />
            {reading ? "Reading…" : "Choose file"}
          </label>
          {file && <div style={{ fontSize:12, color:"#888", marginTop:8 }}>{file.name}</div>}
        </div>
      )}
      {err && <div style={{ fontSize:12.5, color:"#C2410C", margin:"10px 0" }}>{err}</div>}
      {head && (
        <div>
          <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:"0 12px" }}>
            <Field label="Broker"><select value={head.broker_id} onChange={(e) => rematch(e.target.value)} style={inp}><option value="">Choose…</option>{live.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select>
              {sheet?.broker_name && !head.broker_id && <div style={{ fontSize:11, color:"#C2410C", marginTop:3 }}>{tr(`The sheet says "${sheet.broker_name}".`, `La sheet dice "${sheet.broker_name}".`)}</div>}</Field>
            <Field label="CS #"><input value={head.closing_sheet_number} onChange={(e) => setHead({ ...head, closing_sheet_number: e.target.value })} style={inp} /></Field>
            <Field label="Load date"><input type="date" value={head.load_date} onChange={(e) => setHead({ ...head, load_date: e.target.value })} style={inp} /></Field>
            <Field label="Trip cost"><input type="number" value={head.trip_cost} onChange={(e) => setHead({ ...head, trip_cost: e.target.value })} style={inp} /></Field>
            <Field label="Labor"><input type="number" value={head.labor_charges} onChange={(e) => setHead({ ...head, labor_charges: e.target.value })} style={inp} /></Field>
            <Field label="Other fees"><input type="number" value={head.other_fees} onChange={(e) => setHead({ ...head, other_fees: e.target.value })} style={inp} /></Field>
            <Field label="Charge per pad"><input type="number" value={head.charge_per_pad} onChange={(e) => setHead({ ...head, charge_per_pad: e.target.value })} style={inp} placeholder="7" /></Field>
          </div>
          <div style={{ ...card, overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", minWidth:900 }}>
              <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}>
                <th style={th}>On the sheet</th><th style={th}>Our job</th><th style={{ ...th, textAlign:"right" }}>CF</th><th style={{ ...th, textAlign:"right" }}>Rate</th>
                <th style={{ ...th, textAlign:"right" }}>BOL balance</th><th style={{ ...th, textAlign:"right" }}>Collected</th><th style={th}>Keep</th>
              </tr></thead>
              <tbody>
                {lines.map((l, i) => {
                  const g = l.key ? byKey[l.key] : null;
                  const crm = g ? crmOf(g) : null;
                  const cell = (sheetV, crmV, money) => (
                    <div style={{ textAlign:"right" }}>
                      <div style={{ fontWeight:700, color: crm && diff(sheetV, crmV) ? "#C2410C" : "#111" }}>{money ? fmt$(numv(sheetV)) : numv(sheetV).toLocaleString()}</div>
                      {crm && <div style={{ fontSize:10.5, color:"#aaa" }}>{tr(`CRM ${money ? fmt$(numv(crmV)) : numv(crmV).toLocaleString()}`, `CRM ${money ? fmt$(numv(crmV)) : numv(crmV).toLocaleString()}`)}</div>}
                    </div>
                  );
                  const candidates = brokerJobs(head.broker_id).filter((x) => !x.closing_sheet_id || x.key === l.key);
                  return (
                    <tr key={i} style={{ borderBottom:"1px solid #f6f6f6" }}>
                      <td style={td}><b style={{ fontFamily:"monospace" }}>{l.line.job_number || "—"}</b><div style={{ fontSize:11, color:"#888" }}>{l.line.customer}</div></td>
                      <td style={td}>
                        <select value={l.key || ""} onChange={(e) => setLine(i, { key: e.target.value || null, method: "manual" })} style={{ ...inp, fontSize:12, padding:"5px 8px" }}>
                          <option value="">— not linked —</option>
                          {candidates.map((x) => <option key={x.key} value={x.key}>{x.job_number || "?"} · {x.customer || ""}</option>)}
                        </select>
                        {l.method && l.method !== "manual" && <div style={{ fontSize:10.5, color:"#1A8A4E", marginTop:2 }}>{l.method === "job_number" ? tr("matched by job #", "vinculado por job #") : tr("matched by name", "vinculado por nombre")}</div>}
                      </td>
                      <td style={td}>{cell(l.line.cf, crm?.cf)}</td>
                      <td style={td}>{cell(l.line.rate_per_cf, crm?.rate, true)}</td>
                      <td style={td}>{cell(l.line.bol_balance, crm?.bol, true)}</td>
                      <td style={td}>{cell(l.line.bol_collected, crm?.collected, true)}</td>
                      <td style={td}>{g && (
                        <select value={l.use} onChange={(e) => setLine(i, { use: e.target.value })} style={{ ...inp, fontSize:12, padding:"5px 8px" }}>
                          <option value="sheet">Sheet's numbers</option>
                          <option value="crm">Our numbers</option>
                        </select>
                      )}</td>
                    </tr>
                  );
                })}
                {!lines.length && <tr><td colSpan={7} style={{ ...td, textAlign:"center", color:"#bbb", padding:20 }}>No shipment lines were read.</td></tr>}
              </tbody>
            </table>
          </div>
          <div style={{ fontSize:11.5, color:"#999", marginTop:8 }}>Numbers in orange differ from what the CRM has. "Sheet's numbers" copies the broker's CF, rate and BOL balance onto the job. What was collected always comes from your payments.</div>
          {sheet?.total_due_carrier !== 0 && sheet?.total_due_carrier != null && <div style={{ fontSize:12.5, marginTop:8 }}>{tr(`Bottom line on the sheet: ${fmt$(sheet.total_due_carrier)} to us. Compare it with the net once the sheet is created.`, `Total de la sheet: ${fmt$(sheet.total_due_carrier)} a favor nuestro. Comparalo con el neto cuando se cree la sheet.`)}</div>}
        </div>
      )}
    </Modal>
  );
}

// ── 3. A broker payment, spread over its sheets ──────────────────────────────

export function BrokerPaymentModal({ supabase, session, brokers = [], closingSheets = [], sheetCalcById = {}, brokerPayments = [], initialBrokerId = "", Btn, Modal, onClose, onSaved }) {
  const userEmail = session?.user?.email || null;
  const [f, setF] = useState({ broker_id: initialBrokerId ? String(initialBrokerId) : "", direction: "in", amount: "", method: "ach", paid_date: todayISO(), reference: "", notes: "" });
  const [alloc, setAlloc] = useState({});   // sheetId → amount (string)
  const [saving, setSaving] = useState(false);
  const ctx = { sheets: closingSheets, calcById: sheetCalcById, payments: brokerPayments };
  const open = useMemo(() => (f.broker_id ? openSheetsFor(Number(f.broker_id), ctx) : []), [f.broker_id, closingSheets, sheetCalcById, brokerPayments]); // eslint-disable-line react-hooks/exhaustive-deps
  const side = open.filter((s) => (f.direction === "out" ? s.remaining < 0 : s.remaining > 0));
  const propose = (amount, dir, list) => {
    const { allocations } = allocatePayment(amount, list, dir);
    setAlloc(Object.fromEntries(allocations.map((a) => [a.sheet_id, String(a.amount)])));
  };
  const set = (k, v) => {
    const next = { ...f, [k]: v };
    setF(next);
    if (k === "amount" || k === "direction" || k === "broker_id") {
      const list = next.broker_id ? openSheetsFor(Number(next.broker_id), ctx) : [];
      propose(next.amount, next.direction, list);
    }
  };
  const assigned = Object.values(alloc).reduce((s, v) => s + numv(v), 0);
  const left = Math.round((numv(f.amount) - assigned) * 100) / 100;
  const ledger = f.broker_id ? brokerLedger(ctx).find((r) => String(r.brokerId) === String(f.broker_id)) : null;

  async function save() {
    if (!f.broker_id || !(numv(f.amount) > 0)) { window.alert(tr("Choose the broker and the amount.", "Elegí el broker y el monto.")); return; }
    if (left < -0.01) { window.alert(tr("The sheets add up to more than the payment.", "Lo asignado a las sheets supera el pago.")); return; }
    setSaving(true);
    const allocations = Object.entries(alloc).filter(([, v]) => numv(v) > 0).map(([id, v]) => ({ sheet_id: Number(id), amount: Math.round(numv(v) * 100) / 100 }));
    const ins = await supabase.from("broker_payments").insert([{ broker_id: Number(f.broker_id), direction: f.direction, amount: numv(f.amount), method: f.method || null, paid_date: f.paid_date || todayISO(), reference: f.reference || null, notes: f.notes || null, allocations, created_by: userEmail }]).select("*").single();
    if (ins.error) { setSaving(false); dbFailed(ins, "broker_payments"); return; }
    // Sheets this payment paid off close by themselves; the legacy columns get the payment too.
    const all = [...brokerPayments, ins.data];
    const done = new Set(sheetsToSettle({ sheets: closingSheets, calcById: sheetCalcById, payments: all }));
    for (const a of allocations) {
      const patch = { broker_payment_received: true, broker_payment_date: f.paid_date || todayISO(), broker_payment_amount: a.amount };
      if (done.has(a.sheet_id)) patch.status = "settled";
      if (dbFailed(await supabase.from("closing_sheets").update(patch).eq("id", a.sheet_id), "closing_sheets", { quiet: true })) { /* the payment is saved either way */ }
    }
    setSaving(false);
    onSaved(done.size);
  }

  return (
    <Modal wide title="Record a broker payment" onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving} onClick={save}>{saving ? "Saving…" : "Record payment"}</Btn></>}>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(170px, 1fr))", gap:"0 12px" }}>
        <Field label="Broker"><select value={f.broker_id} onChange={(e) => set("broker_id", e.target.value)} style={inp}><option value="">Choose…</option>{brokers.filter((b) => !b.deleted_at).map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}</select></Field>
        <Field label="Amount"><input type="number" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} style={inp} /></Field>
        <Field label="Method"><select value={f.method} onChange={(e) => set("method", e.target.value)} style={inp}>{METHODS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></Field>
        <Field label="Date"><input type="date" value={f.paid_date} onChange={(e) => set("paid_date", e.target.value)} style={inp} /></Field>
        <Field label="Reference"><input value={f.reference} onChange={(e) => set("reference", e.target.value)} style={inp} placeholder="ACH / check number" /></Field>
      </div>
      <Field label="Direction">
        <div style={{ display:"flex", gap:6, flexWrap:"wrap" }}>
          <button type="button" onClick={() => set("direction", "in")} style={pillBtn(f.direction === "in")}>The broker paid us</button>
          <button type="button" onClick={() => set("direction", "out")} style={pillBtn(f.direction === "out")}>We paid the broker</button>
        </div>
      </Field>
      {f.broker_id && (
        <div style={{ ...card, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:560 }}>
            <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}><th style={th}>Sheet</th><th style={th}>Load date</th><th style={{ ...th, textAlign:"right" }}>Net</th><th style={{ ...th, textAlign:"right" }}>Already paid</th><th style={{ ...th, textAlign:"right" }}>Open</th><th style={{ ...th, textAlign:"right" }}>This payment</th></tr></thead>
            <tbody>
              {side.map((s) => (
                <tr key={s.id} style={{ borderBottom:"1px solid #f6f6f6" }}>
                  <td style={td}><b>{s.closing_sheet_number || `#${s.id}`}</b>{s.status === "disputed" && <span style={{ fontSize:10.5, color:"#B91C1C", marginLeft:6 }}>disputed</span>}</td>
                  <td style={td}>{s.load_date || "—"}</td>
                  <td style={{ ...td, textAlign:"right" }}>{fmt$(s.net)}</td>
                  <td style={{ ...td, textAlign:"right", color:"#888" }}>{s.allocated ? fmt$(s.allocated) : "—"}</td>
                  <td style={{ ...td, textAlign:"right", fontWeight:700 }}>{fmt$(Math.abs(s.remaining))}</td>
                  <td style={{ ...td, textAlign:"right", width:130 }}><input type="number" step="0.01" value={alloc[s.id] || ""} onChange={(e) => setAlloc((a) => ({ ...a, [s.id]: e.target.value }))} style={{ ...inp, padding:"5px 8px", textAlign:"right" }} /></td>
                </tr>
              ))}
              {!side.length && <tr><td colSpan={6} style={{ ...td, textAlign:"center", color:"#bbb", padding:16 }}>{f.direction === "out" ? "No open sheets where we owe this broker." : "No open sheets where this broker owes us."}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {f.broker_id && (
        <div style={{ display:"flex", justifyContent:"space-between", gap:10, flexWrap:"wrap", fontSize:12.5, marginTop:10 }}>
          <span>{left > 0.01 ? tr(`${fmt$(left)} stays on account (credit)`, `${fmt$(left)} queda a cuenta (crédito)`) : left < -0.01 ? <b style={{ color:"#B91C1C" }}>{tr(`Over-assigned by ${fmt$(-left)}`, `Asignaste ${fmt$(-left)} de más`)}</b> : tr("Fully assigned", "Todo asignado")}</span>
          {ledger && <span>{tr(`Balance now: ${fmt$(ledger.balance)}`, `Saldo ahora: ${fmt$(ledger.balance)}`)}</span>}
        </div>
      )}
      <Field label="Notes" style={{ marginTop:10 }}><input value={f.notes} onChange={(e) => set("notes", e.target.value)} style={inp} /></Field>
    </Modal>
  );
}

// ── 4. Statement of account ──────────────────────────────────────────────────

export function BrokerStatementModal({ broker, closingSheets = [], sheetCalcById = {}, brokerPayments = [], Btn, Modal, onClose, onPay }) {
  const st = useMemo(() => brokerStatement(broker.id, { sheets: closingSheets, calcById: sheetCalcById, payments: brokerPayments }), [broker.id, closingSheets, sheetCalcById, brokerPayments]);
  function print() {
    const m = (n) => (n < 0 ? "-$" : "$") + Math.abs(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
    const rows = st.lines.map((l) => `<tr><td>${l.date || ""}</td><td>${l.kind === "sheet" ? "Closing sheet " + l.label : (l.direction === "out" ? "Payment to broker" : "Payment from broker") + (l.label ? " · " + l.label : "")}</td><td style="text-align:right">${m(l.amount)}</td><td style="text-align:right">${m(l.balance)}</td></tr>`).join("");
    const html = `<html><head><meta charset="utf-8"><title>Statement ${broker.name}</title><style>body{font-family:system-ui,sans-serif;padding:30px;color:#111}h1{font-size:20px}table{width:100%;border-collapse:collapse;font-size:12px;margin:12px 0}th,td{border:1px solid #ddd;padding:6px 8px;text-align:left}th{background:#f5f5f5}</style></head>
      <body><h1>Statement of account · ${broker.name}</h1><div>No Borders Moving · ${todayISO()}</div>
      <table><thead><tr><th>Date</th><th>Item</th><th style="text-align:right">Amount</th><th style="text-align:right">Balance</th></tr></thead><tbody>${rows}</tbody></table>
      <div style="font-size:16px;font-weight:700;text-align:right">${st.balance >= 0 ? "Balance owed to No Borders Moving: " + m(st.balance) : "Balance owed by No Borders Moving: " + m(-st.balance)}</div></body></html>`;
    const w = window.open("", "_blank");
    if (w) { w.document.write(html); w.document.close(); w.focus(); setTimeout(() => w.print(), 300); }
  }
  return (
    <Modal wide title={tr(`Statement · ${broker.name}`, `Estado de cuenta · ${broker.name}`)} onClose={onClose}
      footer={<><Btn onClick={print}>PDF</Btn>{onPay && <Btn primary onClick={onPay}>Record payment</Btn>}</>}>
      <div style={{ ...card, overflowX:"auto" }}>
        <table style={{ width:"100%", borderCollapse:"collapse", minWidth:560 }}>
          <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}><th style={th}>Date</th><th style={th}>Item</th><th style={{ ...th, textAlign:"right" }}>Amount</th><th style={{ ...th, textAlign:"right" }}>Balance</th></tr></thead>
          <tbody>
            {st.lines.map((l, i) => (
              <tr key={i} style={{ borderBottom:"1px solid #f6f6f6" }}>
                <td style={td}>{l.date || "—"}</td>
                <td style={td}>{l.kind === "sheet" ? tr(`Closing sheet ${l.label}`, `Closing sheet ${l.label}`) : (l.direction === "out" ? tr("Payment to the broker", "Pago al broker") : tr("Payment from the broker", "Pago del broker")) + (l.label ? ` · ${l.label}` : "")}{l.kind === "sheet" && l.status !== "open" && <span style={{ fontSize:10.5, color:"#888", marginLeft:6 }}>{l.status}</span>}</td>
                <td style={{ ...td, textAlign:"right", color: l.amount >= 0 ? "#111" : "#1A8A4E" }}>{fmt$(l.amount)}</td>
                <td style={{ ...td, textAlign:"right", fontWeight:700 }}>{fmt$(l.balance)}</td>
              </tr>
            ))}
            {!st.lines.length && <tr><td colSpan={4} style={{ ...td, textAlign:"center", color:"#bbb", padding:20 }}>No open sheets or payments for this broker.</td></tr>}
          </tbody>
        </table>
      </div>
      <div style={{ textAlign:"right", fontSize:15, fontWeight:800, marginTop:10, color: st.balance >= 0 ? "#1A8A4E" : "#B91C1C" }}>
        {st.balance >= 0 ? tr(`${broker.name} owes us ${fmt$(st.balance)}`, `${broker.name} nos debe ${fmt$(st.balance)}`) : tr(`We owe ${broker.name} ${fmt$(-st.balance)}`, `Le debemos a ${broker.name} ${fmt$(-st.balance)}`)}
      </div>
    </Modal>
  );
}
