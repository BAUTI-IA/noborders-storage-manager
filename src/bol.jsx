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
  { k: "cf_total",          l: "CF total (CF × rate)", fmt: "money" },
  { k: "carrier_rate_per_cf", l: "Carrier rate / CF",  fmt: "money" },
  { k: "fuel_surcharge_pct",l: "Fuel surcharge %",     fmt: "num" },
  { k: "estimate",          l: "Estimate / Total",     fmt: "money" },
  { k: "deposit",           l: "Deposit",              fmt: "money" },
  { k: "pickup_balance",    l: "Pickup balance",       fmt: "money" },
  { k: "delivery_balance",  l: "Delivery balance",     fmt: "money" },
  { k: "bol_balance",       l: "BOL balance",          fmt: "money" },
  { k: "bol_collected",     l: "BOL collected",        fmt: "money" },
  { k: "bol_payment_method",l: "Payment method" },
  { k: "rep",               l: "Rep" },
  { k: "lot_number",        l: "Lot number" },
  { k: "sticker_color",     l: "Sticker color" },
  { k: "extra_stops",       l: "Extra stops" },
  { k: "pads_received",     l: "Pads received" },
  { k: "pads_returned",     l: "Pads returned" },
  { k: "carrier_notes",     l: "Carrier notes" },
  { k: "broker",            l: "Broker name" },
  // ── Phase-2 editable sheet: computed totals + repeatable line slots ────────
  // These are NOT raw job columns — the live calculator fills them on an
  // "effective" job object before stamping, so the mapped boxes print the
  // edited values (extra CF, fuel $, discounts, grand total, balance…).
  { k: "fuel_amount",       l: "Fuel surcharge $",       fmt: "money" },
  { k: "grand_total",       l: "Grand total",            fmt: "money" },
  { k: "balance_due",       l: "Balance due (final)",    fmt: "money" },
  { k: "notes",             l: "Notes / free text" },
  { k: "add_cf_1_qty",      l: "Additional CF #1 — qty" },
  { k: "add_cf_1_rate",     l: "Additional CF #1 — rate", fmt: "money" },
  { k: "add_cf_1_amount",   l: "Additional CF #1 — $",    fmt: "money" },
  { k: "add_cf_2_qty",      l: "Additional CF #2 — qty" },
  { k: "add_cf_2_rate",     l: "Additional CF #2 — rate", fmt: "money" },
  { k: "add_cf_2_amount",   l: "Additional CF #2 — $",    fmt: "money" },
  { k: "charge_1_label",    l: "Other charge #1 — label" },
  { k: "charge_1_amount",   l: "Other charge #1 — $",     fmt: "money" },
  { k: "charge_2_label",    l: "Other charge #2 — label" },
  { k: "charge_2_amount",   l: "Other charge #2 — $",     fmt: "money" },
  { k: "charge_3_label",    l: "Other charge #3 — label" },
  { k: "charge_3_amount",   l: "Other charge #3 — $",     fmt: "money" },
  { k: "charge_4_label",    l: "Other charge #4 — label" },
  { k: "charge_4_amount",   l: "Other charge #4 — $",     fmt: "money" },
  { k: "discount_1_label",  l: "Discount/adjust #1 — label" },
  { k: "discount_1_amount", l: "Discount/adjust #1 — $",  fmt: "money" },
  { k: "discount_2_label",  l: "Discount/adjust #2 — label" },
  { k: "discount_2_amount", l: "Discount/adjust #2 — $",  fmt: "money" },
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
// Parse a plain number out of a possibly-formatted string ("1,800.00" → 1800).
function num(v) { const n = parseFloat(String(v == null ? "" : v).replace(/[^0-9.\-]/g, "")); return isFinite(n) ? n : 0; }
// First number found in a volume string ("400 cf" → 400) = base cubic feet.
function parseCfNum(v) { const m = String(v == null ? "" : v).match(/[\d.]+/); return m ? parseFloat(m[0]) : 0; }

// Resolve the printable value for a field source given a job.
function resolveValue(field, job, brokers) {
  const src = field.source || "";
  if (!src) return "";
  if (src.startsWith("text:")) return src.slice(5);
  if (src.startsWith("job:")) { const v = job[src.slice(4)]; return v == null ? "" : String(v); }
  if (src === "pickup_cityzip")  return job.pickup_cityzip != null && job.pickup_cityzip !== "" ? String(job.pickup_cityzip)
    : [job.pickup_city, [job.pickup_state, job.pickup_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (src === "delivery_cityzip") return job.delivery_cityzip != null && job.delivery_cityzip !== "" ? String(job.delivery_cityzip)
    : [job.delivery_city, [job.delivery_state, job.delivery_zip].filter(Boolean).join(" ")].filter(Boolean).join(", ");
  if (src === "broker") { const b = brokers.find(b => String(b.id) === String(job.broker_id)); return b ? b.name : ""; }
  if (src === "cf_total") {  // CF subtotal — explicit from the editable sheet, else CF × price
    if (job.cf_total != null && job.cf_total !== "") return fmtMoney(job.cf_total);
    const m = String(job.volume || "").match(/[\d.]+/);
    const cf = m ? parseFloat(m[0]) : NaN, rate = Number(job.price_per_cf);
    return (isFinite(cf) && isFinite(rate) && cf && rate) ? fmtMoney(cf * rate) : "";
  }
  const def = SOURCES.find(s => s.k === src);
  const raw = job[src];
  if (def?.fmt === "date") return fmtDate(raw);
  if (def?.fmt === "money") return fmtMoney(raw);
  return raw == null ? "" : String(raw);
}

// ── Text-layer auto-detect (accurate for digital PDFs) ─────────────────────
// Reads the real position of each label from the PDF text layer and drops a
// field box right next to it — exact, instant, free. Returns null when the page
// has no usable text (scanned), so the caller can fall back to AI vision.
// `dollar:true` rules place the value in the "$" column on the same row
// (charges/totals); the rest place it right after the label.
const TEXT_RULES = [
  { re: /^name\b/,                    side: true, left: "customer",        right: "customer",         col: true },
  { re: /^shipper name\b/,            src: "customer",        col: true },
  { re: /^consignee name\b/,          src: "customer",        col: true },
  { re: /^address\b/,                 side: true, left: "pickup_address",  right: "delivery_address", col: true },
  { re: /city\s*\/\s*state\s*\/\s*zip/, side: true, left: "pickup_cityzip", right: "delivery_cityzip", col: true },
  { re: /^phone\b/,                   side: true, left: "client_phone",    right: "",                 w: 120 },
  { re: /order\s*(no|#)/,            src: "job_number",      w: 80 },
  { re: /^job\s*#/,                   src: "job_number",      w: 80 },
  { re: /^pickup date/,               src: "pickup_date_from", w: 80 },
  { re: /agreed p\/?u date/,          src: "pickup_date_from", w: 80 },
  { re: /^date available for delivery/, src: "fadd",          w: 80 },
  { re: /^first avail/,               src: "fadd",            w: 80 },
  // charges → value in the "$" column
  { re: /^total estimated charges/,   src: "estimate",            dollar: true },
  { re: /grand total/,                src: "grand_total",         dollar: true },
  { re: /^partial payment/,           src: "deposit",             dollar: true },
  { re: /prepaid deposit/,            src: "deposit",             dollar: true },
  { re: /^balance due/,               src: "balance_due",         dollar: true },
  { re: /new balance/,                src: "balance_due",         dollar: true },
  { re: /^fuel surcharge/,            src: "fuel_amount",         dollar: true },
  { re: /price adjust/,               src: "discount_1_amount",   dollar: true },
];

async function detectFieldsFromText(pdfBytes, pageSizes) {
  const doc = await pdfjsLib.getDocument({ data: pdfBytes.slice(0) }).promise;
  const page = await doc.getPage(1);
  const tc = await page.getTextContent();
  const items = (tc.items || []).filter(i => i.str && i.str.trim());
  if (items.length < 12) return null;            // scanned / no real text layer
  const { w: pageW, h: pageH } = pageSizes[0];
  const mid = pageW / 2;
  const dollars = items.filter(i => i.str.trim() === "$").map(i => ({ x: i.transform[4], y: i.transform[5] }));
  const cands = [];
  for (const it of items) {
    const x = it.transform[4], baseline = it.transform[5];
    const fs = Math.abs(it.transform[3]) || 9;
    const w = it.width || fs * it.str.length * 0.5;
    const text = it.str.trim().toLowerCase().replace(/\s+/g, " ");
    if (text.length > 40) continue;              // skip legal paragraphs
    for (const r of TEXT_RULES) {
      if (!r.re.test(text)) continue;
      let source = r.src;
      if (r.side) source = x < mid ? r.left : r.right;
      if (!source) break;
      if (r.dollar) {
        // nearest "$" to the right on the same row → value sits just after it
        const d = dollars.filter(dd => Math.abs(dd.y - baseline) < 5 && dd.x > x + w - 2).sort((a, b) => a.x - b.x)[0];
        if (!d) break;
        cands.push({ source, anchorX: d.x + 7, baseline: d.y, fs: 9, side: x < mid ? "L" : "R", w: 75 });
      } else {
        cands.push({ source, anchorX: x + w + 6, baseline, fs, side: x < mid ? "L" : "R", col: r.col, w: r.w });
      }
      break;
    }
  }
  // CUBIC FEET "Base:" line → volume + price per CF (one text item holds the blanks)
  const cuft = items.filter(i => /cu\.ft\. @ \$/.test(i.str))
    .map(i => ({ x: i.transform[4], y: i.transform[5], fs: Math.abs(i.transform[3]) || 9 }))
    .sort((a, b) => b.y - a.y)[0];
  if (cuft) {
    cands.push({ source: "volume",       anchorX: cuft.x + 4,   baseline: cuft.y, fs: cuft.fs, side: "R", w: 46 });
    cands.push({ source: "price_per_cf", anchorX: cuft.x + 108, baseline: cuft.y, fs: cuft.fs, side: "R", w: 44 });
    // CF total amount goes in the "$" column at the end of that row
    const cd = dollars.filter(dd => Math.abs(dd.y - cuft.y) < 5 && dd.x > cuft.x + 90).sort((a, b) => a.x - b.x)[0];
    if (cd) cands.push({ source: "cf_total", anchorX: cd.x + 7, baseline: cd.y, fs: 9, side: "R", w: 75 });
  }
  // topmost match wins per (source+side) — keeps both origin & destination boxes
  // for shared sources (e.g. customer name, total) while dropping stray duplicates.
  cands.sort((a, b) => b.baseline - a.baseline);
  const used = new Set(), fields = [];
  for (const c of cands) {
    const key = c.source + "|" + c.side;
    if (used.has(key)) continue;
    used.add(key);
    let bw;
    if (c.col) bw = (c.side === "L" ? mid - 6 : pageW - 12) - c.anchorX;
    else bw = c.w || 90;
    bw = Math.max(40, Math.min(bw, pageW - 12 - c.anchorX));
    fields.push({
      id: "t" + fields.length + Math.random().toString(36).slice(2, 5),
      page: 0, x: Math.round(c.anchorX), y: Math.round(pageH - c.baseline - c.fs * 1.15),
      w: Math.round(bw), h: Math.round(c.fs * 1.6),
      source: c.source, fontSize: 10, align: "left",
    });
  }
  return fields;
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
  const [view, setView] = useState(initialJobNumber != null ? "generate" : "list"); // list | editor | generate | documents
  const [genJobNumber] = useState(initialJobNumber);  // captured once
  const [templates, setTemplates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);  // template being edited
  const [reopenDoc, setReopenDoc] = useState(null);  // saved BOL loaded back into the sheet
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
    return <GeneratePanel supabase={supabase} session={session} templates={templates.filter(t => t.status === "active")}
      jobs={jobs} brokers={brokers} initialJobNumber={genJobNumber} reopenDoc={reopenDoc}
      onSaved={() => {}} onClose={() => { setReopenDoc(null); setView(reopenDoc ? "documents" : "list"); }} />;
  }
  if (view === "documents") {
    return <DocumentsView supabase={supabase} canEdit={canEdit}
      onReopen={(doc) => { setReopenDoc(doc); setView("generate"); }} onClose={() => setView("list")} />;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12 }}>
        <button style={btn(false)} onClick={() => setView("documents")}>Documents</button>
        <button style={btn(false)} onClick={() => { setReopenDoc(null); setView("generate"); }}>Generate BOL</button>
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
      // 1) Try the PDF text layer first — exact label-anchored boxes for digital PDFs.
      const textFields = await detectFieldsFromText(pdfBytes, pageSizes);
      if (textFields && textFields.length) {
        setFields(textFields);
        setMsg(`Detected ${textFields.length} fields from the PDF text — review & drag to fine-tune.`);
        setAiBusy(false);
        return;
      }
      // 2) Scanned PDF (no text): fall back to AI vision on a page-1 image.
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
                  <select value={sel.source.startsWith("text:") ? "__text" : sel.source.startsWith("job:") ? "__job" : sel.source} onChange={e => {
                      if (e.target.value === "__text") updateField(sel.id, { source: "text:" });
                      else if (e.target.value === "__job") updateField(sel.id, { source: "job:" });
                      else updateField(sel.id, { source: e.target.value });
                    }} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 10px", fontSize: 13 }}>
                    <option value="">— unmapped —</option>
                    {SOURCES.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}
                    <option value="__text">Fixed text…</option>
                    <option value="__job">Other job field (advanced)…</option>
                  </select>
                  {sel.source.startsWith("text:") && (
                    <input value={sel.source.slice(5)} onChange={e => updateField(sel.id, { source: "text:" + e.target.value })} placeholder="Fixed text"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  {sel.source.startsWith("job:") && (
                    <input value={sel.source.slice(4)} onChange={e => updateField(sel.id, { source: "job:" + e.target.value.trim() })} placeholder="job field name (e.g. lot_number)"
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

// ── Editable generation sheet: live calculation + preview + save ────────────
const inp = { width: "100%", padding: "7px 9px", borderRadius: 7, border: "1px solid #e5e5e5", fontSize: 13, boxSizing: "border-box" };
const lbl = { fontSize: 11, fontWeight: 600, color: "#888", display: "block", marginBottom: 3 };
const HEADER_FIELDS = [
  { k: "customer",         l: "Client name" },
  { k: "job_number",       l: "Job / Order #" },
  { k: "pickup_address",   l: "Pickup address" },
  { k: "pickup_cityzip",   l: "Pickup city/state/zip" },
  { k: "delivery_address", l: "Delivery address" },
  { k: "delivery_cityzip", l: "Delivery city/state/zip" },
  { k: "pickup_date_from", l: "Pickup date" },
  { k: "fadd",             l: "1st available delivery" },
  { k: "delivery_date",    l: "Delivery date" },
];
const rid = () => "l" + Math.random().toString(36).slice(2, 8);

function sheetFromJob(job) {
  return {
    customer: job?.customer || "", job_number: job?.job_number || "",
    pickup_address: job?.pickup_address || "",
    pickup_cityzip: [job?.pickup_city, [job?.pickup_state, job?.pickup_zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    delivery_address: job?.delivery_address || "",
    delivery_cityzip: [job?.delivery_city, [job?.delivery_state, job?.delivery_zip].filter(Boolean).join(" ")].filter(Boolean).join(", "),
    pickup_date_from: job?.pickup_date_from || "", fadd: job?.fadd || "", delivery_date: job?.delivery_date || "",
    volume: job?.volume || "", price_per_cf: job?.price_per_cf ?? "", fuel_surcharge_pct: job?.fuel_surcharge_pct ?? "",
    deposit: job?.deposit ?? "", notes: "", balance_override: "",
  };
}

function GeneratePanel({ supabase, session, templates, jobs, brokers, initialJobNumber, reopenDoc, onClose, onSaved }) {
  const preJob = initialJobNumber ? jobs.find(j => String(j.job_number) === String(initialJobNumber)) : null;
  const [tplId, setTplId] = useState(reopenDoc?.template_id ? String(reopenDoc.template_id) : (templates[0]?.id || ""));
  const [jobQuery, setJobQuery] = useState(preJob ? String(preJob.job_number || "") : "");
  const [jobId, setJobId] = useState(reopenDoc?.job_id ? String(reopenDoc.job_id) : (preJob ? String(preJob.id) : ""));
  const [f, setF] = useState(() => reopenDoc ? { ...sheetFromJob(null), ...(reopenDoc.values || {}) } : sheetFromJob(preJob));
  const [extraCf, setExtraCf] = useState(() => (reopenDoc?.line_items || []).filter(l => l.type === "cf").map(l => ({ id: rid(), qty: l.qty ?? "", rate: l.rate ?? "" })));
  const [charges, setCharges] = useState(() => (reopenDoc?.line_items || []).filter(l => l.type === "charge").map(l => ({ id: rid(), label: l.label ?? "", amount: l.amount ?? "" })));
  const [discounts, setDiscounts] = useState(() => (reopenDoc?.line_items || []).filter(l => l.type === "discount").map(l => ({ id: rid(), label: l.label ?? "", amount: Math.abs(num(l.amount)) || "" })));
  const [tplBytes, setTplBytes] = useState(null);
  const [blobUrl, setBlobUrl] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const jobPicked = !reopenDoc; // when reopening a saved BOL we keep its snapshot even if job list changes

  const set = (k, v) => setF(s => ({ ...s, [k]: v }));

  const jobMatches = useMemo(() => {
    const q = jobQuery.trim().toLowerCase();
    const list = q ? jobs.filter(j => [j.job_number, j.customer].filter(Boolean).some(v => String(v).toLowerCase().includes(q))) : jobs;
    return list.slice(0, 50);
  }, [jobQuery, jobs]);

  // Prefill the sheet from the picked job (not when reopening a saved snapshot).
  useEffect(() => {
    if (!jobPicked || !jobId) return;
    const job = jobs.find(j => String(j.id) === String(jobId));
    if (job) { setF(sheetFromJob(job)); setExtraCf([]); setCharges([]); setDiscounts([]); }
  }, [jobId]); // eslint-disable-line

  // Load the template PDF bytes whenever the template changes.
  useEffect(() => {
    let alive = true;
    (async () => {
      setTplBytes(null);
      const tpl = templates.find(t => String(t.id) === String(tplId));
      if (!tpl?.pdf_path) return;
      const { data } = await supabase.storage.from("bol-templates").download(tpl.pdf_path);
      if (alive && data) setTplBytes(new Uint8Array(await data.arrayBuffer()));
    })();
    return () => { alive = false; };
  }, [tplId, templates, supabase]);

  // ── Live calculator (same math as the CRM: CF×rate, fuel = subtotal×%) ──────
  const calc = useMemo(() => {
    const baseCf = parseCfNum(f.volume);
    const rate = num(f.price_per_cf);
    const baseAmt = baseCf * rate;
    const extraAmt = extraCf.reduce((s, l) => s + num(l.qty) * num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate), 0);
    const extraCfQty = extraCf.reduce((s, l) => s + num(l.qty), 0);
    const totalCf = baseCf + extraCfQty;
    const cfSubtotal = baseAmt + extraAmt;
    const fuelPct = num(f.fuel_surcharge_pct);
    const fuelAmt = cfSubtotal * fuelPct / 100;
    const chargesTotal = charges.reduce((s, l) => s + num(l.amount), 0);
    const discountTotal = discounts.reduce((s, l) => s + Math.abs(num(l.amount)), 0);
    const grandTotal = cfSubtotal + fuelAmt + chargesTotal - discountTotal;
    const deposit = num(f.deposit);
    const manualBal = f.balance_override !== "" && f.balance_override != null;
    const balanceDue = manualBal ? num(f.balance_override) : grandTotal - deposit;
    return { baseCf, rate, baseAmt, extraAmt, extraCfQty, totalCf, cfSubtotal, fuelPct, fuelAmt, chargesTotal, discountTotal, grandTotal, deposit, balanceDue };
  }, [f, extraCf, charges, discounts]);

  // The "effective job" fed to the stamper: base job + edits + computed + slots.
  const effJob = useMemo(() => {
    const job = jobs.find(j => String(j.id) === String(jobId)) || {};
    const e = { ...job };
    for (const hf of HEADER_FIELDS) e[hf.k] = f[hf.k] ?? "";
    e.volume = f.volume; e.price_per_cf = f.price_per_cf; e.fuel_surcharge_pct = f.fuel_surcharge_pct; e.deposit = f.deposit;
    e.cf_total = calc.cfSubtotal; e.fuel_amount = calc.fuelAmt; e.grand_total = calc.grandTotal;
    e.estimate = calc.grandTotal; e.balance_due = calc.balanceDue; e.bol_balance = calc.balanceDue;
    e.notes = f.notes || "";
    extraCf.slice(0, 2).forEach((l, i) => {
      const r = num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate);
      e[`add_cf_${i + 1}_qty`] = l.qty; e[`add_cf_${i + 1}_rate`] = r || ""; e[`add_cf_${i + 1}_amount`] = num(l.qty) * r;
    });
    charges.slice(0, 4).forEach((l, i) => { e[`charge_${i + 1}_label`] = l.label || ""; e[`charge_${i + 1}_amount`] = l.amount === "" ? "" : num(l.amount); });
    discounts.slice(0, 2).forEach((l, i) => { e[`discount_${i + 1}_label`] = l.label || ""; e[`discount_${i + 1}_amount`] = l.amount === "" ? "" : -Math.abs(num(l.amount)); });
    return e;
  }, [f, extraCf, charges, discounts, calc, jobId, jobs]);

  const tpl = templates.find(t => String(t.id) === String(tplId));
  const snapshot = JSON.stringify([effJob, tpl?.field_map]);

  // Debounced live preview: re-stamp shortly after any edit settles.
  useEffect(() => {
    if (!tplBytes || !tpl) return;
    const h = setTimeout(async () => {
      try {
        const out = await generateFilledPdf(tplBytes, tpl.field_map || [], effJob, brokers);
        const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
        setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch (e) { /* keep previous preview */ }
    }, 450);
    return () => clearTimeout(h);
  }, [tplBytes, snapshot]); // eslint-disable-line

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, []); // eslint-disable-line

  async function save(status) {
    setError(null); setNotice(null);
    if (!tpl) { setError("Pick a template."); return; }
    if (!tplBytes) { setError("Template PDF still loading — try again."); return; }
    setSaving(true);
    try {
      const out = await generateFilledPdf(tplBytes, tpl.field_map || [], effJob, brokers);
      const safe = String(f.job_number || f.customer || "bol").replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 40);
      const path = `${safe}-${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage.from("bol-generated").upload(path, out, { contentType: "application/pdf", upsert: true });
      if (upErr) throw upErr;
      const line_items = [
        ...extraCf.map(l => ({ type: "cf", label: "Additional CF", qty: num(l.qty), rate: num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate), amount: num(l.qty) * num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate) })),
        ...charges.map(l => ({ type: "charge", label: l.label, amount: num(l.amount) })),
        ...discounts.map(l => ({ type: "discount", label: l.label, amount: -Math.abs(num(l.amount)) })),
      ];
      const job = jobs.find(j => String(j.id) === String(jobId));
      const { error: insErr } = await supabase.from("bol_documents").insert({
        customer: f.customer || job?.customer || null, job_id: job?.id || null, job_number: f.job_number || null,
        template_id: tpl.id, company_name: tpl.company_name,
        values: { ...f, ...calc }, line_items, pdf_path: path, status,
        created_by: session?.user?.email || null,
      });
      if (insErr) throw insErr;
      setNotice(status === "final" ? "Saved as final — it's in Documents." : "Draft saved to Documents.");
      onSaved && onSaved();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const computed = [
    ["CF total", calc.cfSubtotal], ["Fuel $ (" + (calc.fuelPct || 0) + "%)", calc.fuelAmt],
    ["Other charges", calc.chargesTotal], ["Discounts", -calc.discountTotal],
    ["Grand total", calc.grandTotal], ["Deposit", calc.deposit], ["Balance due", calc.balanceDue],
  ];
  const lineBtn = { padding: "4px 9px", borderRadius: 6, border: "1px dashed #cbd5e1", background: "#f8fafc", cursor: "pointer", fontSize: 12, color: "#334155" };
  const delX = { border: "none", background: "transparent", color: "#b91c1c", cursor: "pointer", fontSize: 15, lineHeight: 1, padding: "0 4px" };

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button style={smallBtn} onClick={onClose}>← Back</button>
        <h3 style={{ margin: 0, fontSize: 16 }}>{reopenDoc ? "Edit BOL" : "Generate BOL"}</h3>
        <span style={{ flex: 1 }} />
        <button style={btn(false)} disabled={saving} onClick={() => save("draft")}>Save draft</button>
        <button style={btn(true)} disabled={saving} onClick={() => save("final")}>{saving ? "Saving…" : "Save as final"}</button>
      </div>
      {error && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      {notice && <div style={{ background: "#EAF3DE", border: "1px solid #cfe6b4", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#3B6D11", marginBottom: 12 }}>{notice}</div>}

      <div style={{ display: "flex", gap: 16, flexWrap: "wrap", alignItems: "flex-start" }}>
        {/* ── LEFT: editable sheet ─────────────────────────────────────────── */}
        <div style={{ width: 380, flexShrink: 0, display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
            <label style={lbl}>Company template</label>
            <select value={tplId} onChange={e => setTplId(e.target.value)} style={{ ...inp, marginBottom: 10 }}>
              <option value="">— select —</option>
              {templates.map(t => <option key={t.id} value={t.id}>{t.company_name}</option>)}
            </select>
            {templates.length === 0 && <div style={{ fontSize: 12, color: "#b91c1c", marginBottom: 8 }}>No active templates. Create and activate one first.</div>}
            {!reopenDoc && (<>
              <label style={lbl}>Job (loads its data — all editable below)</label>
              <input value={jobQuery} onChange={e => setJobQuery(e.target.value)} placeholder="Search job # or client" style={{ ...inp, marginBottom: 6 }} />
              <select value={jobId} onChange={e => setJobId(e.target.value)} size={5} style={{ ...inp, padding: 4 }}>
                {jobMatches.map(j => <option key={j.id} value={j.id}>{(j.job_number || "—") + " · " + (j.customer || "")}</option>)}
              </select>
            </>)}
          </div>

          {/* client & route */}
          <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", marginBottom: 10 }}>Client & route</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
              {HEADER_FIELDS.map(hf => (
                <div key={hf.k} style={{ gridColumn: hf.k.includes("address") || hf.k === "customer" ? "1 / -1" : "auto" }}>
                  <label style={lbl}>{hf.l}</label>
                  <input value={f[hf.k] ?? ""} onChange={e => set(hf.k, e.target.value)} style={inp} />
                </div>
              ))}
            </div>
          </div>

          {/* charges calculator */}
          <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", marginBottom: 10 }}>Charges</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 4 }}>
              <div><label style={lbl}>Base CF</label><input value={f.volume ?? ""} onChange={e => set("volume", e.target.value)} style={inp} /></div>
              <div><label style={lbl}>Rate / CF</label><input value={f.price_per_cf ?? ""} onChange={e => set("price_per_cf", e.target.value)} style={inp} /></div>
              <div><label style={lbl}>Fuel %</label><input value={f.fuel_surcharge_pct ?? ""} onChange={e => set("fuel_surcharge_pct", e.target.value)} style={inp} /></div>
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>Base CF stays untouched — extra CF goes on its own line.</div>

            {/* extra CF lines */}
            {extraCf.map((l, i) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
                <div><label style={lbl}>+ Extra CF {i + 1} — qty</label><input value={l.qty} onChange={e => setExtraCf(a => a.map(x => x.id === l.id ? { ...x, qty: e.target.value } : x))} style={inp} /></div>
                <div><label style={lbl}>rate (blank = base)</label><input value={l.rate} onChange={e => setExtraCf(a => a.map(x => x.id === l.id ? { ...x, rate: e.target.value } : x))} placeholder={String(f.price_per_cf || "")} style={inp} /></div>
                <button style={delX} title="Remove" onClick={() => setExtraCf(a => a.filter(x => x.id !== l.id))}>✕</button>
              </div>
            ))}
            {/* other charges */}
            {charges.map((l, i) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
                <div><label style={lbl}>Charge {i + 1}</label><input value={l.label} onChange={e => setCharges(a => a.map(x => x.id === l.id ? { ...x, label: e.target.value } : x))} placeholder="e.g. packing, stairs" style={inp} /></div>
                <div><label style={lbl}>amount $</label><input value={l.amount} onChange={e => setCharges(a => a.map(x => x.id === l.id ? { ...x, amount: e.target.value } : x))} style={inp} /></div>
                <button style={delX} title="Remove" onClick={() => setCharges(a => a.filter(x => x.id !== l.id))}>✕</button>
              </div>
            ))}
            {/* discounts */}
            {discounts.map((l, i) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1.4fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
                <div><label style={lbl}>Discount/adjust {i + 1}</label><input value={l.label} onChange={e => setDiscounts(a => a.map(x => x.id === l.id ? { ...x, label: e.target.value } : x))} placeholder="e.g. broker adjustment" style={inp} /></div>
                <div><label style={lbl}>amount $</label><input value={l.amount} onChange={e => setDiscounts(a => a.map(x => x.id === l.id ? { ...x, amount: e.target.value } : x))} style={inp} /></div>
                <button style={delX} title="Remove" onClick={() => setDiscounts(a => a.filter(x => x.id !== l.id))}>✕</button>
              </div>
            ))}

            <div style={{ display: "flex", gap: 6, flexWrap: "wrap", margin: "8px 0 12px" }}>
              <button style={lineBtn} onClick={() => setExtraCf(a => [...a, { id: rid(), qty: "", rate: "" }])}>+ Extra CF</button>
              <button style={lineBtn} onClick={() => setCharges(a => [...a, { id: rid(), label: "", amount: "" }])}>+ Charge</button>
              <button style={lineBtn} onClick={() => setDiscounts(a => [...a, { id: rid(), label: "", amount: "" }])}>+ Discount</button>
            </div>

            {/* live computed totals */}
            <div style={{ background: "#f8fafc", borderRadius: 8, padding: "8px 10px" }}>
              {computed.map(([k, v]) => (
                <div key={k} style={{ display: "flex", justifyContent: "space-between", fontSize: 13, padding: "3px 0", fontWeight: k === "Grand total" || k === "Balance due" ? 700 : 400, color: k === "Balance due" ? "#0f172a" : "#475569", borderTop: k === "Grand total" ? "1px solid #e2e8f0" : "none", marginTop: k === "Grand total" ? 4 : 0, paddingTop: k === "Grand total" ? 7 : 3 }}>
                  <span>{k}</span><span>$ {fmtMoney(v) || "0.00"}</span>
                </div>
              ))}
              <div style={{ marginTop: 8 }}>
                <label style={lbl}>Manual balance override (optional)</label>
                <input value={f.balance_override ?? ""} onChange={e => set("balance_override", e.target.value)} placeholder="blank = grand total − deposit" style={inp} />
              </div>
            </div>
          </div>

          {/* notes */}
          <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
            <label style={lbl}>Notes / free text (stamped where mapped)</label>
            <textarea value={f.notes ?? ""} onChange={e => set("notes", e.target.value)} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
          </div>
        </div>

        {/* ── RIGHT: live preview ──────────────────────────────────────────── */}
        <div style={{ flex: 1, minWidth: 360, position: "sticky", top: 12 }}>
          {blobUrl ? (
            <>
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center" }}>
                <a href={blobUrl} download="bol.pdf" style={{ ...btn(false), textDecoration: "none" }}>⬇ Download</a>
                <a href={blobUrl} target="_blank" rel="noreferrer" style={{ ...btn(false), textDecoration: "none" }}>Open tab</a>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>Preview updates live as you edit.</span>
              </div>
              <object data={blobUrl} type="application/pdf" style={{ width: "100%", height: 760, border: "1px solid #ddd", borderRadius: 8 }} />
            </>
          ) : <div style={{ border: "2px dashed #e5e5e5", borderRadius: 12, padding: 48, textAlign: "center", color: "#aaa", fontSize: 14 }}>{busy ? "Loading…" : "Pick a template and job — the live preview appears here."}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Documents: every saved BOL (legal backup), searchable by customer ───────
function DocumentsView({ supabase, canEdit, onReopen, onClose }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [q, setQ] = useState("");

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error } = await supabase.from("bol_documents").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) setError(error.message); else setRows(data || []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? rows.filter(r => [r.customer, r.job_number, r.company_name].filter(Boolean).some(v => String(v).toLowerCase().includes(s))) : rows;
  }, [rows, q]);

  function urlFor(r) { return r.pdf_path ? supabase.storage.from("bol-generated").getPublicUrl(r.pdf_path).data.publicUrl : null; }
  async function remove(r) {
    if (!window.confirm(`Delete this BOL for ${r.customer || "—"}? This removes the legal record.`)) return;
    await supabase.from("bol_documents").delete().eq("id", r.id);
    if (r.pdf_path) await supabase.storage.from("bol-generated").remove([r.pdf_path]);
    load();
  }

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 14 }}>
        <button style={smallBtn} onClick={onClose}>← Back</button>
        <h3 style={{ margin: 0, fontSize: 16 }}>Documents</h3>
        <span style={{ flex: 1 }} />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Search customer, job #, company"
          style={{ ...inp, width: 280 }} />
      </div>
      {error && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#b91c1c", marginBottom: 12 }}>{error}</div>}
      <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Date", "Customer", "Job #", "Company", "Status", ""].map((h, i) =>
            <th key={i} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", textAlign: i === 5 ? "right" : "left", borderBottom: "1px solid #f3f3f3" }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={6} style={{ padding: 14, fontSize: 13 }}>Loading…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={6} style={{ padding: 14, fontSize: 13, color: "#888" }}>No saved BOLs yet.</td></tr>
              : filtered.map(r => (
                <tr key={r.id}>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6", whiteSpace: "nowrap" }}>{fmtDate(r.created_at) || String(r.created_at || "").slice(0, 10)}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, borderBottom: "1px solid #f6f6f6" }}>{r.customer || "—"}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{r.job_number || "—"}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{r.company_name || "—"}</td>
                  <td style={{ padding: "10px 12px", borderBottom: "1px solid #f6f6f6" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: r.status === "final" ? "#EAF3DE" : "#FEF3C7", color: r.status === "final" ? "#3B6D11" : "#92760B" }}>{r.status}</span>
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap", borderBottom: "1px solid #f6f6f6" }}>
                    {urlFor(r) && <a href={urlFor(r)} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: "none", marginRight: 6 }}>View</a>}
                    <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => onReopen(r)}>Reopen</button>
                    {canEdit && <button style={{ ...smallBtn, color: "#b91c1c" }} onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
