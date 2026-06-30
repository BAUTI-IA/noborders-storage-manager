// BOL (Bill of Lading) generator.
// Approach: the uploaded company PDF is the immutable background; we stamp the
// job data onto it at mapped coordinates (pdf-lib). A visual editor lets an admin
// place/adjust the field boxes once per company; generation per job is automatic.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import * as pdfjsLib from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
pdfjsLib.GlobalWorkerOptions.workerSrc = workerUrl;

// ── Job fields that can be mapped onto a template ───────────────────────────
const SOURCES = [
  { k: "customer",          l: "Client name" },
  { k: "client_phone",      l: "Client phone" },
  { k: "client_email",      l: "Client email" },
  { k: "job_number",        l: "Job / Order #" },
  { k: "pickup_address",    l: "Pickup address" },
  { k: "pickup_cityzip",    l: "Pickup city/state/zip" },
  { k: "pickup_city",       l: "Pickup city" },
  { k: "pickup_state",      l: "Pickup state" },
  { k: "pickup_zip",        l: "Pickup zip" },
  { k: "delivery_address",  l: "Delivery address" },
  { k: "delivery_cityzip",  l: "Delivery city/state/zip" },
  { k: "delivery_city",     l: "Delivery city" },
  { k: "delivery_state",    l: "Delivery state" },
  { k: "delivery_zip",      l: "Delivery zip" },
  { k: "pickup_date_from",  l: "Pickup date",          fmt: "date" },
  { k: "fadd",              l: "1st available delivery", fmt: "date" },
  { k: "delivery_date",     l: "Delivery date",        fmt: "date" },
  { k: "volume",            l: "Volume / CF" },
  { k: "price_per_cf",      l: "Price per CF",         fmt: "money" },
  { k: "fuel_surcharge_pct",l: "Fuel surcharge %",     fmt: "num" },
  { k: "estimate",          l: "Estimate / Total",     fmt: "money" },
  { k: "deposit",           l: "Deposit",              fmt: "money" },
  { k: "pickup_balance",    l: "Pickup balance",       fmt: "money" },
  { k: "delivery_balance",  l: "Delivery balance",     fmt: "money" },
  { k: "bol_balance",       l: "BOL balance",          fmt: "money" },
  { k: "broker",            l: "Broker name" },
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map(s => [s.k, s.l]));

function fmtDate(v) {
  if (!v) return "";
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(v);
}
function fmtMoney(v) {
  const n = Number(v);
  if (!isFinite(n) || v === null || v === "" || v === undefined) return "";
  return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}
// Resolve the printable value for a field source given a job.
function resolveValue(field, job, brokers) {
  const src = field.source || "";
  if (!src) return "";
  if (src.startsWith("text:")) return src.slice(5);
  if (src === "pickup_cityzip")  return [job.pickup_city, [job.pickup_state, job.pickup_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (src === "delivery_cityzip") return [job.delivery_city, [job.delivery_state, job.delivery_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (src === "broker") { const b = brokers.find(b => String(b.id) === String(job.broker_id)); return b ? b.name : ""; }
  const def = SOURCES.find(s => s.k === src);
  const raw = job[src];
  if (def?.fmt === "date") return fmtDate(raw);
  if (def?.fmt === "money") return fmtMoney(raw);
  return raw == null ? "" : String(raw);
}

// ── PDF generation: stamp values onto the original template ─────────────────
async function generateFilledPdf(templateBytes, fields, job, brokers) {
  const pdf = await PDFDocument.load(templateBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const ink = rgb(0.04, 0.13, 0.36);
  for (const f of fields) {
    const page = pages[f.page || 0];
    if (!page) continue;
    const value = resolveValue(f, job, brokers);
    if (value === "" || value == null) continue;
    const PH = page.getHeight();
    const pad = 2;
    const maxW = Math.max(8, (f.w || 100) - pad * 2);
    let size = f.fontSize || 10;
    let text = String(value);
    while (size > 6 && font.widthOfTextAtSize(text, size) > maxW) size -= 0.5;
    let tw = font.widthOfTextAtSize(text, size);
    if (tw > maxW) { while (text.length > 1 && font.widthOfTextAtSize(text + "…", size) > maxW) text = text.slice(0, -1); text += "…"; tw = font.widthOfTextAtSize(text, size); }
    // vertical center inside the box (box stored top-left in PDF points)
    const centerFromBottom = PH - (f.y + (f.h || 16) / 2);
    const baseline = centerFromBottom - size * 0.34;
    let x = f.x + pad;
    if (f.align === "center") x = f.x + ((f.w || 100) - tw) / 2;
    else if (f.align === "right") x = f.x + (f.w || 100) - pad - tw;
    page.drawText(text, { x, y: baseline, size, font, color: ink });
  }
  return await pdf.save();
}

// Render one PDF page to a data URL with pdf.js (used by editor + preview).
async function renderPageToCanvas(pdfBytes, pageIndex, canvas, scale) {
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await doc.getPage(pageIndex + 1);
  const viewport = page.getViewport({ scale });
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext("2d");
  await page.render({ canvasContext: ctx, viewport }).promise;
  return { width: viewport.width, height: viewport.height };
}
async function getPdfPageSizes(pdfBytes) {
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const sizes = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const vp = (await doc.getPage(i)).getViewport({ scale: 1 });
    sizes.push({ w: vp.width, h: vp.height });
  }
  return sizes;
}

const btn = (primary) => ({ padding: "8px 14px", borderRadius: 8, border: primary ? "none" : "1px solid #e5e5e5", background: primary ? "#111" : "#fff", color: primary ? "#fff" : "#333", fontSize: 13, fontWeight: 600, cursor: "pointer" });
const smallBtn = { padding: "5px 10px", borderRadius: 7, border: "1px solid #eee", background: "#fff", cursor: "pointer", fontSize: 12 };

export function BolSection({ supabase, session, jobs = [], brokers = [], can = () => true, isAdmin = false, initialJobNumber = null, onConsumed }) {
  const [view, setView] = useState(initialJobNumber != null ? "generate" : "list"); // list | editor | generate
  const [genJobNumber] = useState(initialJobNumber);  // captured once
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);  // template being edited
  const canEdit = isAdmin || can("bol", "create") || can("bol", "edit");

  // Clear the parent's pre-select once we've consumed it, so a later sidebar
  // visit opens the list instead of jumping back into generate.
  useEffect(() => { if (initialJobNumber != null && onConsumed) onConsumed(); }, []); // eslint-disable-line

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error } = await supabase.from("bol_templates").select("*").order("company_name");
    if (error) setError(error.message); else setTemplates(data || []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  async function removeTemplate(t) {
    if (!window.confirm(`Delete template "${t.company_name}"?`)) return;
    await supabase.from("bol_templates").delete().eq("id", t.id);
    if (t.pdf_path) await supabase.storage.from("bol-templates").remove([t.pdf_path]);
    load();
  }

  if (view === "editor") {
    return <TemplateEditor supabase={supabase} session={session} template={editing}
      onClose={() => { setView("list"); setEditing(null); load(); }} />;
  }
  if (view === "generate") {
    return <GeneratePanel supabase={supabase} templates={templates.filter(t => t.status === "active")}
      jobs={jobs} brokers={brokers} initialJobNumber={genJobNumber} onClose={() => setView("list")} />;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        <button style={btn(false)} onClick={() => setView("generate")}>Generate BOL</button>
        {canEdit && <button style={btn(true)} onClick={() => { setEditing(null); setView("editor"); }}>+ New template</button>}
      </div>
      {error && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Company", "Fields", "Status", ""].map((h, i) =>
            <th key={i} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", textAlign: i === 3 ? "right" : "left", borderBottom: "1px solid #f3f3f3" }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={4} style={{ padding: 14, fontSize: 13 }}>Loading…</td></tr>
              : templates.length === 0 ? <tr><td colSpan={4} style={{ padding: 14, fontSize: 13, color: "#888" }}>No templates yet. Add one to start.</td></tr>
              : templates.map(t => (
                <tr key={t.id}>
                  <td style={{ padding: "10px 12px", fontSize: 13, borderBottom: "1px solid #f6f6f6" }}>{t.company_name}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{(t.field_map || []).length}</td>
                  <td style={{ padding: "10px 12px", borderBottom: "1px solid #f6f6f6" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: t.status === "active" ? "#EAF3DE" : "#FEF3C7", color: t.status === "active" ? "#3B6D11" : "#92760B" }}>{t.status}</span>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap", borderBottom: "1px solid #f6f6f6" }}>
                    {canEdit && <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => { setEditing(t); setView("editor"); }}>Edit</button>}
                    {canEdit && <button style={{ ...smallBtn, color: "#b91c1c" }} onClick={() => removeTemplate(t)}>Delete</button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Visual template editor ──────────────────────────────────────────────────
function TemplateEditor({ supabase, session, template, onClose }) {
  const [companyName, setCompanyName] = useState(template?.company_name || "");
  const [pdfBytes, setPdfBytes] = useState(null);      // Uint8Array of the template
  const [pdfPath, setPdfPath] = useState(template?.pdf_path || null);
  const [pageSizes, setPageSizes] = useState([]);      // [{w,h}] in points
  const [curPage, setCurPage] = useState(0);
  const [fields, setFields] = useState(template?.field_map || []);
  const [selId, setSelId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState(null);
  const [aiBusy, setAiBusy] = useState(false);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);
  const drag = useRef(null);

  const DISPLAY_W = 820;
  const scale = pageSizes[curPage] ? DISPLAY_W / pageSizes[curPage].w : 1;

  // Load existing template PDF from storage when editing.
  useEffect(() => {
    (async () => {
      if (template?.pdf_path) {
        const { data } = await supabase.storage.from("bol-templates").download(template.pdf_path);
        if (data) { const buf = new Uint8Array(await data.arrayBuffer()); setPdfBytes(buf); setPageSizes(await getPdfPageSizes(buf)); }
      }
    })();
  }, [template, supabase]);

  // (Re)render current page whenever bytes/page/scale change.
  useEffect(() => {
    if (pdfBytes && canvasRef.current && pageSizes[curPage]) {
      renderPageToCanvas(pdfBytes, curPage, canvasRef.current, scale).catch(() => {});
    }
  }, [pdfBytes, curPage, scale, pageSizes]);

  async function onUpload(file) {
    if (!file) return;
    const buf = new Uint8Array(await file.arrayBuffer());
    setPdfBytes(buf);
    setPageSizes(await getPdfPageSizes(buf));
    setCurPage(0);
    setPdfPath(null); // will upload fresh on save
  }

  function addField() {
    const ps = pageSizes[curPage] || { w: 600, h: 800 };
    const id = "f" + Math.random().toString(36).slice(2, 8);
    const nf = { id, page: curPage, x: ps.w * 0.25, y: ps.h * 0.25, w: 160, h: 18, source: "", fontSize: 10, align: "left" };
    setFields(f => [...f, nf]); setSelId(id);
  }
  function updateField(id, patch) { setFields(fs => fs.map(f => f.id === id ? { ...f, ...patch } : f)); }
  function deleteField(id) { setFields(fs => fs.filter(f => f.id !== id)); if (selId === id) setSelId(null); }

  // drag / resize handlers (coords kept in PDF points)
  function onBoxPointerDown(e, f, mode) {
    e.stopPropagation(); e.preventDefault();
    setSelId(f.id);
    const rect = wrapRef.current.getBoundingClientRect();
    drag.current = { id: f.id, mode, startX: e.clientX, startY: e.clientY, ox: f.x, oy: f.y, ow: f.w, oh: f.h, rect };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }
  function onMove(e) {
    const d = drag.current; if (!d) return;
    const dx = (e.clientX - d.startX) / scale, dy = (e.clientY - d.startY) / scale;
    if (d.mode === "move") updateField(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
    else updateField(d.id, { w: Math.max(20, Math.round(d.ow + dx)), h: Math.max(10, Math.round(d.oh + dy)) });
  }
  function onUp() { drag.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); }

  async function runAutoDetect() {
    if (!pdfBytes) return;
    setAiBusy(true); setMsg(null);
    try {
      // Render page 1 to a JPEG and send that — tiny payload (vs the multi-MB PDF
      // that blows Vercel's body limit) and Claude does bounding boxes well on images.
      const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
      const pg = await doc.getPage(1);
      const base = pg.getViewport({ scale: 1 });
      const rscale = 1200 / base.width;
      const vp = pg.getViewport({ scale: rscale });
      const cnv = document.createElement("canvas");
      cnv.width = vp.width; cnv.height = vp.height;
      await pg.render({ canvasContext: cnv.getContext("2d"), viewport: vp }).promise;
      const b64 = cnv.toDataURL("image/jpeg", 0.82).split(",")[1];
      const res = await fetch("/api/bol-analyze", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ image_base64: b64, pages: [pageSizes[0]] }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "AI error");
      const detected = (json.fields || []).map((d, i) => ({
        id: "a" + i + Math.random().toString(36).slice(2, 5),
        page: d.page || 0, x: d.x, y: d.y, w: d.w || 150, h: d.h || 18,
        source: d.source || "", fontSize: 10, align: d.align || "left",
      }));
      if (detected.length) { setFields(detected); setMsg(`AI placed ${detected.length} fields — review & drag to adjust.`); }
      else setMsg("AI didn't detect fields; add them manually.");
    } catch (e) { setMsg("Auto-detect failed: " + e.message + " (you can map manually)."); }
    setAiBusy(false);
  }

  async function save(status) {
    if (!companyName.trim()) { setMsg("Enter a company name."); return; }
    if (!pdfBytes && !pdfPath) { setMsg("Upload a template PDF."); return; }
    setBusy(true); setMsg(null);
    try {
      let path = pdfPath;
      if (pdfBytes && !pdfPath) {
        path = `tpl-${Date.now()}.pdf`;
        const { error: upErr } = await supabase.storage.from("bol-templates").upload(path, pdfBytes, { contentType: "application/pdf", upsert: true });
        if (upErr) throw upErr;
        setPdfPath(path);
      }
      const row = { company_name: companyName.trim(), pdf_path: path, page_count: pageSizes.length || template?.page_count || 1, field_map: fields, status, created_by: session?.user?.email || null };
      let err;
      if (template?.id) ({ error: err } = await supabase.from("bol_templates").update(row).eq("id", template.id));
      else ({ error: err } = await supabase.from("bol_templates").insert(row));
      if (err) throw err;
      onClose();
    } catch (e) { setMsg(e.message); }
    setBusy(false);
  }

  const sel = fields.find(f => f.id === selId);
  const pageFields = fields.filter(f => (f.page || 0) === curPage);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        <button style={smallBtn} onClick={onClose}>← Back</button>
        <input value={companyName} onChange={e => setCompanyName(e.target.value)} placeholder="Company name (e.g. Transit Moving)"
          style={{ fontSize: 14, padding: "8px 12px", borderRadius: 8, border: "1px solid #e5e5e5", minWidth: 260 }} />
        {!pdfBytes && !pdfPath && (
          <label style={{ ...btn(false), display: "inline-block" }}>
            Upload template PDF<input type="file" accept="application/pdf" style={{ display: "none" }} onChange={e => onUpload(e.target.files[0])} />
          </label>
        )}
        {(pdfBytes || pdfPath) && <button style={smallBtn} onClick={addField}>+ Add field</button>}
        {pdfBytes && <button style={smallBtn} disabled={aiBusy} onClick={runAutoDetect}>{aiBusy ? "Detecting…" : "✨ Auto-detect (AI)"}</button>}
        <span style={{ flex: 1 }} />
        <button style={btn(false)} disabled={busy} onClick={() => save("draft")}>Save draft</button>
        <button style={btn(true)} disabled={busy} onClick={() => save("active")}>{busy ? "Saving…" : "Save & activate"}</button>
      </div>
      {msg && <div style={{ background: "#FFF6E8", border: "1px solid #F4DDB0", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#854F0B", marginBottom: 12 }}>{msg}</div>}

      {(pdfBytes || pdfPath) && pageSizes.length > 0 && (
        <div style={{ display: "flex", gap: 16, alignItems: "flex-start" }}>
          {/* canvas + overlay */}
          <div>
            {pageSizes.length > 1 && (
              <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                <button style={smallBtn} disabled={curPage === 0} onClick={() => setCurPage(p => p - 1)}>‹ Prev</button>
                <span style={{ fontSize: 13 }}>Page {curPage + 1} / {pageSizes.length}</span>
                <button style={smallBtn} disabled={curPage === pageSizes.length - 1} onClick={() => setCurPage(p => p + 1)}>Next ›</button>
              </div>
            )}
            <div ref={wrapRef} style={{ position: "relative", width: DISPLAY_W, border: "1px solid #ddd", lineHeight: 0 }} onPointerDown={() => setSelId(null)}>
              <canvas ref={canvasRef} style={{ width: DISPLAY_W, height: "auto", display: "block" }} />
              {pageFields.map(f => {
                const selected = f.id === selId;
                return (
                  <div key={f.id} onPointerDown={e => onBoxPointerDown(e, f, "move")}
                    style={{ position: "absolute", left: f.x * scale, top: f.y * scale, width: f.w * scale, height: f.h * scale,
                      border: `1.5px solid ${selected ? "#2563eb" : "#e2762b"}`, background: selected ? "rgba(37,99,235,0.12)" : "rgba(226,118,43,0.10)",
                      cursor: "move", boxSizing: "border-box", fontSize: 9, color: "#333", overflow: "hidden", whiteSpace: "nowrap" }}>
                    <span style={{ background: selected ? "#2563eb" : "#e2762b", color: "#fff", fontSize: 8, padding: "0 3px", lineHeight: "12px", display: "inline-block" }}>
                      {f.source ? (SOURCE_LABEL[f.source] || (f.source.startsWith("text:") ? "Text" : f.source)) : "unmapped"}
                    </span>
                    <div onPointerDown={e => onBoxPointerDown(e, f, "resize")}
                      style={{ position: "absolute", right: -4, bottom: -4, width: 10, height: 10, background: "#2563eb", border: "1px solid #fff", borderRadius: 2, cursor: "nwse-resize", display: selected ? "block" : "none" }} />
                  </div>
                );
              })}
            </div>
          </div>

          {/* side panel for selected field */}
          <div style={{ width: 250, flexShrink: 0 }}>
            <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 10, padding: 14 }}>
              {!sel ? <div style={{ fontSize: 13, color: "#888" }}>Select a field box to map it, or click <b>+ Add field</b>. Drag boxes to position; drag the blue corner to resize.</div> : (
                <>
                  <div style={{ fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", marginBottom: 8 }}>Field</div>
                  <label style={{ fontSize: 12, color: "#888" }}>Maps to</label>
                  <select value={sel.source.startsWith("text:") ? "__text" : sel.source} onChange={e => {
                      if (e.target.value === "__text") updateField(sel.id, { source: "text:" });
                      else updateField(sel.id, { source: e.target.value });
                    }} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 10px", fontSize: 13 }}>
                    <option value="">— unmapped —</option>
                    {SOURCES.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}
                    <option value="__text">Fixed text…</option>
                  </select>
                  {sel.source.startsWith("text:") && (
                    <input value={sel.source.slice(5)} onChange={e => updateField(sel.id, { source: "text:" + e.target.value })} placeholder="Fixed text"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  <label style={{ fontSize: 12, color: "#888" }}>Align</label>
                  <div style={{ display: "flex", gap: 4, margin: "4px 0 10px" }}>
                    {["left", "center", "right"].map(a => (
                      <button key={a} onClick={() => updateField(sel.id, { align: a })} style={{ flex: 1, padding: 6, borderRadius: 7, border: "1px solid #eee", cursor: "pointer", fontSize: 12, background: sel.align === a ? "#111" : "#fff", color: sel.align === a ? "#fff" : "#666" }}>{a}</button>
                    ))}
                  </div>
                  <label style={{ fontSize: 12, color: "#888" }}>Max font size: {sel.fontSize}</label>
                  <input type="range" min="6" max="16" step="0.5" value={sel.fontSize} onChange={e => updateField(sel.id, { fontSize: Number(e.target.value) })} style={{ width: "100%", margin: "4px 0 10px" }} />
                  <button style={{ ...smallBtn, color: "#b91c1c", width: "100%" }} onClick={() => deleteField(sel.id)}>Delete field</button>
                </>
              )}
            </div>
            <div style={{ fontSize: 11, color: "#aaa", marginTop: 8 }}>{fields.length} field(s) total</div>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Generate a BOL for a job ────────────────────────────────────────────────
function GeneratePanel({ supabase, templates, jobs, brokers, initialJobNumber, onClose }) {
  const preJob = initialJobNumber ? jobs.find(j => String(j.job_number) === String(initialJobNumber)) : null;
  const [tplId, setTplId] = useState(templates[0]?.id || "");
  const [jobQuery, setJobQuery] = useState(preJob ? String(preJob.job_number || "") : "");
  const [jobId, setJobId] = useState(preJob ? String(preJob.id) : "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);

  const jobMatches = useMemo(() => {
    const q = jobQuery.trim().toLowerCase();
    const list = q ? jobs.filter(j => [j.job_number, j.customer].filter(Boolean).some(v => String(v).toLowerCase().includes(q))) : jobs;
    return list.slice(0, 50);
  }, [jobQuery, jobs]);

  async function generate() {
    setError(null);
    const tpl = templates.find(t => String(t.id) === String(tplId));
    const job = jobs.find(j => String(j.id) === String(jobId));
    if (!tpl) { setError("Pick a template."); return; }
    if (!job) { setError("Pick a job."); return; }
    if (!tpl.pdf_path) { setError("That template has no PDF."); return; }
    setBusy(true);
    try {
      const { data, error: dErr } = await supabase.storage.from("bol-templates").download(tpl.pdf_path);
      if (dErr) throw dErr;
      const bytes = new Uint8Array(await data.arrayBuffer());
      const out = await generateFilledPdf(bytes, tpl.field_map || [], job, brokers);
      const blob = new Blob([out], { type: "application/pdf" });
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      setBlobUrl(URL.createObjectURL(blob));
    } catch (e) { setError(e.message); }
    setBusy(false);
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button style={smallBtn} onClick={onClose}>← Back</button>
        <h3 style={{ margin: 0, fontSize: 16 }}>Generate BOL</h3>
      </div>
      {error && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        <div style={{ width: 320, flexShrink: 0, background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 16 }}>
          <label style={{ fontSize: 12, fontWeight: 600, color: "#888" }}>Company template</label>
          <select value={tplId} onChange={e => setTplId(e.target.value)} style={{ width: "100%", padding: 9, borderRadius: 8, border: "1px solid #e5e5e5", margin: "5px 0 14px", fontSize: 13 }}>
            <option value="">— select —</option>
            {templates.map(t => <option key={t.id} value={t.id}>{t.company_name}</option>)}
          </select>
          {templates.length === 0 && <div style={{ fontSize: 12, color: "#b91c1c", marginBottom: 12 }}>No active templates. Create and activate one first.</div>}
          <label style={{ fontSize: 12, fontWeight: 600, color: "#888" }}>Job</label>
          <input value={jobQuery} onChange={e => setJobQuery(e.target.value)} placeholder="Search job # or client"
            style={{ width: "100%", padding: 9, borderRadius: 8, border: "1px solid #e5e5e5", margin: "5px 0", fontSize: 13, boxSizing: "border-box" }} />
          <select value={jobId} onChange={e => setJobId(e.target.value)} size={8} style={{ width: "100%", borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 13, padding: 4 }}>
            {jobMatches.map(j => <option key={j.id} value={j.id}>{(j.job_number || "—") + " · " + (j.customer || "")}</option>)}
          </select>
          <button style={{ ...btn(true), width: "100%", marginTop: 14 }} disabled={busy} onClick={generate}>{busy ? "Generating…" : "Generate"}</button>
        </div>
        <div style={{ flex: 1, minWidth: 360 }}>
          {blobUrl ? (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 8 }}>
                <a href={blobUrl} download="bol.pdf" style={{ ...btn(true), textDecoration: "none" }}>⬇ Download PDF</a>
                <a href={blobUrl} target="_blank" rel="noreferrer" style={{ ...btn(false), textDecoration: "none" }}>Open in new tab</a>
              </div>
              <object data={blobUrl} type="application/pdf" style={{ width: "100%", height: 720, border: "1px solid #ddd", borderRadius: 8 }} />
            </>
          ) : <div style={{ border: "2px dashed #e5e5e5", borderRadius: 12, padding: 48, textAlign: "center", color: "#aaa", fontSize: 14 }}>The generated BOL preview will appear here.</div>}
        </div>
      </div>
    </div>
  );
}
