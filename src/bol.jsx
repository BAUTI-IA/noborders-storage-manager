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
// `g` groups the dropdown into <optgroup>s. Visibility (hidden keys) and
// user-defined custom fields live in the global bol_field_config row —
// resolution stays key-based, so hiding a field never breaks existing maps.
const SOURCES = [
  { k: "customer",          l: "Client name",          g: "Client" },
  { k: "client_phone",      l: "Client phone",         g: "Client" },
  { k: "client_email",      l: "Client email",         g: "Client" },
  { k: "job_number",        l: "Job / Order #",        g: "Client" },
  { k: "rep",               l: "Rep",                  g: "Client" },
  { k: "broker",            l: "Broker name",          g: "Client" },
  { k: "pickup_address",    l: "Pickup address",       g: "Route & dates" },
  { k: "pickup_cityzip",    l: "Pickup city/state/zip", g: "Route & dates" },
  { k: "pickup_city",       l: "Pickup city",          g: "Route & dates" },
  { k: "pickup_state",      l: "Pickup state",         g: "Route & dates" },
  { k: "pickup_zip",        l: "Pickup zip",           g: "Route & dates" },
  { k: "delivery_address",  l: "Delivery address",     g: "Route & dates" },
  { k: "delivery_cityzip",  l: "Delivery city/state/zip", g: "Route & dates" },
  { k: "delivery_city",     l: "Delivery city",        g: "Route & dates" },
  { k: "delivery_state",    l: "Delivery state",       g: "Route & dates" },
  { k: "delivery_zip",      l: "Delivery zip",         g: "Route & dates" },
  { k: "pickup_date_from",  l: "Pickup date",          g: "Route & dates", fmt: "date" },
  { k: "fadd",              l: "1st available delivery", g: "Route & dates", fmt: "date" },
  { k: "delivery_date",     l: "Delivery date",        g: "Route & dates", fmt: "date" },
  { k: "extra_stops",       l: "Extra stops",          g: "Route & dates" },
  { k: "volume",            l: "Volume / CF",          g: "Volume & rates" },
  { k: "price_per_cf",      l: "Price per CF",         g: "Volume & rates", fmt: "money" },
  { k: "cf_total",          l: "CF total (CF × rate)", g: "Volume & rates", fmt: "money" },
  { k: "carrier_rate_per_cf", l: "Carrier rate / CF",  g: "Volume & rates", fmt: "money" },
  { k: "fuel_surcharge_pct",l: "Fuel surcharge %",     g: "Charges & payments", fmt: "num" },
  { k: "estimate",          l: "Estimate / Total",     g: "Charges & payments", fmt: "money" },
  { k: "deposit",           l: "Deposit",              g: "Charges & payments", fmt: "money" },
  { k: "pickup_balance",    l: "Pickup balance",       g: "Charges & payments", fmt: "money" },
  { k: "delivery_balance",  l: "Delivery balance",     g: "Charges & payments", fmt: "money" },
  { k: "bol_balance",       l: "BOL balance",          g: "Charges & payments", fmt: "money" },
  { k: "bol_collected",     l: "BOL collected",        g: "Charges & payments", fmt: "money" },
  { k: "bol_payment_method",l: "Payment method",       g: "Charges & payments" },
  { k: "lot_number",        l: "Lot number",           g: "Other" },
  { k: "sticker_color",     l: "Sticker color",        g: "Other" },
  { k: "pads_received",     l: "Pads received",        g: "Other" },
  { k: "pads_returned",     l: "Pads returned",        g: "Other" },
  { k: "carrier_notes",     l: "Carrier notes",        g: "Other" },
  // ── Phase-2 editable sheet: computed totals + repeatable line slots ────────
  // These are NOT raw job columns — the live calculator fills them on an
  // "effective" job object before stamping, so the mapped boxes print the
  // edited values (extra CF, fuel $, discounts, grand total, balance…).
  { k: "fuel_amount",       l: "Fuel surcharge $",       g: "Charges & payments", fmt: "money" },
  { k: "grand_total",       l: "Grand total",            g: "Charges & payments", fmt: "money" },
  { k: "balance_due",       l: "Balance due (final)",    g: "Charges & payments", fmt: "money" },
  { k: "due_pickup",        l: "Due at pickup",          g: "Charges & payments", fmt: "money" },
  { k: "due_delivery",      l: "Due at delivery",        g: "Charges & payments", fmt: "money" },
  { k: "notes",             l: "Notes / free text",      g: "Other" },
  { k: "add_cf_1_qty",      l: "Additional CF #1 — qty",  g: "Volume & rates" },
  { k: "add_cf_1_rate",     l: "Additional CF #1 — rate", g: "Volume & rates", fmt: "money" },
  { k: "add_cf_1_amount",   l: "Additional CF #1 — $",    g: "Volume & rates", fmt: "money" },
  { k: "add_cf_2_qty",      l: "Additional CF #2 — qty",  g: "Volume & rates" },
  { k: "add_cf_2_rate",     l: "Additional CF #2 — rate", g: "Volume & rates", fmt: "money" },
  { k: "add_cf_2_amount",   l: "Additional CF #2 — $",    g: "Volume & rates", fmt: "money" },
  { k: "charge_1_label",    l: "Other charge #1 — label", g: "Charges & payments" },
  { k: "charge_1_amount",   l: "Other charge #1 — $",     g: "Charges & payments", fmt: "money" },
  { k: "charge_2_label",    l: "Other charge #2 — label", g: "Charges & payments" },
  { k: "charge_2_amount",   l: "Other charge #2 — $",     g: "Charges & payments", fmt: "money" },
  { k: "charge_3_label",    l: "Other charge #3 — label", g: "Charges & payments" },
  { k: "charge_3_amount",   l: "Other charge #3 — $",     g: "Charges & payments", fmt: "money" },
  { k: "charge_4_label",    l: "Other charge #4 — label", g: "Charges & payments" },
  { k: "charge_4_amount",   l: "Other charge #4 — $",     g: "Charges & payments", fmt: "money" },
  { k: "discount_1_label",  l: "Discount/adjust #1 — label", g: "Charges & payments" },
  { k: "discount_1_amount", l: "Discount/adjust #1 — $",  g: "Charges & payments", fmt: "money" },
  { k: "discount_2_label",  l: "Discount/adjust #2 — label", g: "Charges & payments" },
  { k: "discount_2_amount", l: "Discount/adjust #2 — $",  g: "Charges & payments", fmt: "money" },
];
const SOURCE_LABEL = Object.fromEntries(SOURCES.map(s => [s.k, s.l]));
const GROUP_ORDER = ["Client", "Route & dates", "Volume & rates", "Charges & payments", "Other"];
const EMPTY_FIELD_CONFIG = { hidden_keys: [], custom_fields: [] };

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
  // Template-defined "kind" wins (custom service sources aren't in SOURCES);
  // otherwise fall back to the SOURCES format.
  const kind = field.kind;
  if (kind === "checkbox") return raw ? "X" : ""; // tick boxes stamp an X when checked
  if (kind === "date" || (!kind && def?.fmt === "date")) return fmtDate(raw);
  if (kind === "money" || (!kind && def?.fmt === "money")) return fmtMoney(raw);
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
  const all = [];
  let anyText = false;
  for (let p = 0; p < doc.numPages; p++) {
    const page = await doc.getPage(p + 1);
    const tc = await page.getTextContent();
    const items = (tc.items || []).filter(i => i.str && i.str.trim());
    if (items.length < 12) continue;             // scanned page → skip (map by hand)
    anyText = true;
    const ps = pageSizes[p] || pageSizes[0];
    all.push(...scanPageForFields(items, ps.w, ps.h, p));
  }
  return anyText ? all : null;                    // null → whole PDF scanned → AI fallback
}

// Scan one page's text items and return the field boxes found on it.
function scanPageForFields(items, pageW, pageH, pageIndex) {
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
      id: "t" + pageIndex + "_" + fields.length + Math.random().toString(36).slice(2, 5),
      page: pageIndex, x: Math.round(c.anchorX), y: Math.round(pageH - c.baseline - c.fs * 1.15),
      w: Math.round(bw), h: Math.round(c.fs * 1.6),
      source: c.source, fontSize: 10, align: "left",
    });
  }
  return fields;
}

// ── PDF generation: stamp values onto the original template ─────────────────
// baseJob (optional): when re-stamping on top of an ALREADY-FILLED pdf (e.g. the
// pickup-signed copy), fields whose value didn't change vs baseJob are skipped —
// only new/changed values are printed, so nothing double-prints over the old ink.
async function generateFilledPdf(templateBytes, fields, job, brokers, baseJob = null) {
  const pdf = await PDFDocument.load(templateBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const ink = rgb(0.04, 0.13, 0.36);
  for (const f of fields) {
    if (f.kind === "signature" || f.kind === "initial" || f.kind === "sign_date") continue; // DocuSign tabs, not stamped
    const page = pages[f.page || 0];
    if (!page) continue;
    const value = resolveValue(f, job, brokers);
    const PH = page.getHeight();
    if (baseJob) {
      const old = resolveValue(f, baseJob, brokers);
      if (old === value) continue; // unchanged → already printed on the base
      // The base already shows the old value — cover it with white before
      // printing the new one, otherwise both overlap (edits at delivery).
      if (old !== "" && old != null) {
        page.drawRectangle({ x: f.x - 1, y: PH - f.y - (f.h || 16) - 1, width: (f.w || 100) + 2, height: (f.h || 16) + 2, color: rgb(1, 1, 1) });
      }
    }
    if (value === "" || value == null) continue;
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

// Stamp fill-time free-text annotations (DocuSign-style boxes the user drops
// on the generated BOL) as a second pass over already-filled bytes. Same
// top-left point convention as field_map; multi-line via explicit "\n".
async function stampAnnotations(pdfBytes, annots) {
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  const ink = rgb(0.04, 0.13, 0.36);
  for (const a of annots) {
    const page = pages[a.page || 0];
    if (!page || !String(a.text || "").trim()) continue;
    const PH = page.getHeight();
    const size = a.fontSize || 10;
    const leading = size * 1.25;
    const lines = String(a.text).split("\n");
    lines.forEach((line, i) => {
      if (!line) return;
      const tw = font.widthOfTextAtSize(line, size);
      let x = a.x;
      if (a.align === "center") x = a.x + ((a.w || 100) - tw) / 2;
      else if (a.align === "right") x = a.x + (a.w || 100) - tw;
      page.drawText(line, { x, y: PH - a.y - size - i * leading, size, font, color: ink });
    });
  }
  return await pdf.save();
}

// Cover the areas of annotations already baked into a signed base PDF with
// white, so the current annotations can be re-stamped without overlapping
// (same "cover then reprint" approach as changed fields on a signed base).
async function whiteOutAnnotations(pdfBytes, annots) {
  const pdf = await PDFDocument.load(pdfBytes);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const pages = pdf.getPages();
  for (const a of annots) {
    const page = pages[a.page || 0];
    if (!page || !String(a.text || "").trim()) continue;
    const PH = page.getHeight();
    const size = a.fontSize || 10;
    const leading = size * 1.25;
    const lines = String(a.text).split("\n");
    const textW = Math.max(...lines.map(l => font.widthOfTextAtSize(l || " ", size)));
    const boxW = a.w || 100;
    // Long lines overflow the box (no clipping at stamp time) — cover them too.
    let x0 = a.x;
    if (a.align === "center") x0 = Math.min(a.x, a.x + (boxW - textW) / 2);
    else if (a.align === "right") x0 = Math.min(a.x, a.x + boxW - textW);
    const h = Math.max(a.h || 16, size + (lines.length - 1) * leading + size * 0.3) + 2;
    page.drawRectangle({ x: x0 - 1, y: PH - a.y - h + 1, width: Math.max(boxW, textW) + 2, height: h, color: rgb(1, 1, 1) });
  }
  return await pdf.save();
}

// Drag/resize for boxes stored in PDF points (template editor + fill-time
// annotations). Returns startDrag(e, box, mode) — mode "move" | "resize".
function useBoxDrag(scale, updateBox) {
  const drag = useRef(null);
  return function startDrag(e, box, mode) {
    e.stopPropagation(); e.preventDefault();
    const d = { id: box.id, mode, startX: e.clientX, startY: e.clientY, ox: box.x, oy: box.y, ow: box.w, oh: box.h };
    drag.current = d;
    const onMove = ev => {
      if (drag.current !== d) return;
      const dx = (ev.clientX - d.startX) / scale, dy = (ev.clientY - d.startY) / scale;
      if (mode === "move") updateBox(d.id, { x: Math.round(d.ox + dx), y: Math.round(d.oy + dy) });
      else updateBox(d.id, { w: Math.max(20, Math.round(d.ow + dx)), h: Math.max(10, Math.round(d.oh + dy)) });
    };
    const onUp = () => { drag.current = null; window.removeEventListener("pointermove", onMove); window.removeEventListener("pointerup", onUp); };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };
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
  const [fieldConfig, setFieldConfig] = useState(EMPTY_FIELD_CONFIG);
  const canEdit = isAdmin || can("bol", "create") || can("bol", "edit");

  // Global field config (hidden built-ins + custom fields). Missing table/row
  // (script not run yet) just means the default: everything visible, no customs.
  const loadFieldConfig = useCallback(async () => {
    const { data } = await supabase.from("bol_field_config").select("*").eq("id", 1).maybeSingle();
    setFieldConfig(data ? { hidden_keys: data.hidden_keys || [], custom_fields: data.custom_fields || [] } : EMPTY_FIELD_CONFIG);
  }, [supabase]);
  useEffect(() => { loadFieldConfig(); }, [loadFieldConfig]);

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
    return <TemplateEditor supabase={supabase} session={session} template={editing} fieldConfig={fieldConfig} refreshConfig={loadFieldConfig}
      onClose={() => { setView("list"); setEditing(null); load(); }} />;
  }
  if (view === "generate") {
    return <GeneratePanel supabase={supabase} session={session} templates={templates.filter(t => t.status === "active")}
      jobs={jobs} brokers={brokers} initialJobNumber={genJobNumber} reopenDoc={reopenDoc} fieldConfig={fieldConfig}
      onSaved={() => {}} onClose={() => { setReopenDoc(null); setView(reopenDoc ? "documents" : "list"); }} />;
  }
  if (view === "documents") {
    return <DocumentsView supabase={supabase} session={session} canEdit={canEdit} jobs={jobs} brokers={brokers}
      onReopen={(doc) => { setReopenDoc(doc); setView("generate"); }} onClose={() => setView("list")} />;
  }

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 12, flexWrap: "wrap" }}>
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
function TemplateEditor({ supabase, session, template, fieldConfig = EMPTY_FIELD_CONFIG, refreshConfig, onClose }) {
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
  const [showFieldConfig, setShowFieldConfig] = useState(false);
  const canvasRef = useRef(null);
  const wrapRef = useRef(null);

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

  // drag / resize (coords kept in PDF points)
  const startDrag = useBoxDrag(scale, updateField);
  function onBoxPointerDown(e, f, mode) { setSelId(f.id); startDrag(e, f, mode); }

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
        <button style={smallBtn} onClick={() => setShowFieldConfig(true)}>⚙ Manage fields</button>
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
                      {["signature", "initial", "sign_date"].includes(f.kind) ? `✍ ${f.kind === "sign_date" ? "Date" : f.kind === "initial" ? "Initial" : "Sign"} (${f.stage || "pickup"})`
                        : f.source.startsWith("chk:") ? `☑ ${f.source.slice(4) || "Checkbox"}`
                        : f.source ? (f.source.startsWith("svc:") ? (f.source.slice(4) || "Service") : f.label || SOURCE_LABEL[f.source] || (f.source.startsWith("text:") ? "Text" : f.source)) : (f.label || "unmapped")}
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
                  {(() => {
                    const hidden = new Set(fieldConfig.hidden_keys);
                    const customs = fieldConfig.custom_fields || [];
                    const selVal = sel.source.startsWith("svc:") ? "__svc" : sel.source.startsWith("text:") ? "__text" : sel.source.startsWith("job:") ? "__job" : sel.source.startsWith("chk:") ? "__chk" : sel.source;
                    // Mapped to a hidden built-in or a deleted custom field: keep an
                    // option for it so the select isn't blank and the map isn't lost.
                    const known = selVal === "" || selVal.startsWith("__") || (SOURCES.some(s => s.k === selVal) && !hidden.has(selVal)) || customs.some(c => c.k === selVal);
                    return (
                      <select value={selVal} onChange={e => {
                          const v = e.target.value;
                          const custom = customs.find(c => c.k === v);
                          if (v === "__text") updateField(sel.id, { source: "text:", mode: "fixed" });
                          else if (v === "__job") updateField(sel.id, { source: "job:", mode: "variable" });
                          else if (v === "__svc") updateField(sel.id, { source: "svc:", mode: "variable", kind: "money", group: "Services", align: "right" });
                          else if (v === "__chk") updateField(sel.id, { source: "chk:", mode: "variable", kind: "checkbox", align: "center", w: 14, h: 14 });
                          else if (custom) updateField(sel.id, { source: custom.k, mode: "variable", kind: custom.fmt || "", label: custom.l, group: "Custom" });
                          else updateField(sel.id, { source: v });
                        }} style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 10px", fontSize: 13 }}>
                        <option value="">— unmapped —</option>
                        {!known && <option value={selVal}>{(SOURCE_LABEL[selVal] || sel.label || selVal) + " (hidden)"}</option>}
                        {GROUP_ORDER.map(g => {
                          const opts = SOURCES.filter(s => s.g === g && !hidden.has(s.k));
                          return opts.length ? <optgroup key={g} label={g}>{opts.map(s => <option key={s.k} value={s.k}>{s.l}</option>)}</optgroup> : null;
                        })}
                        {customs.length > 0 && (
                          <optgroup label="Custom fields">{customs.map(c => <option key={c.k} value={c.k}>{c.l}</option>)}</optgroup>
                        )}
                        <optgroup label="Special">
                          <option value="__svc">Service / charge (own name)…</option>
                          <option value="__chk">Checkbox (tick when generating)…</option>
                          <option value="__text">Fixed text…</option>
                          <option value="__job">Other job field (advanced)…</option>
                        </optgroup>
                      </select>
                    );
                  })()}
                  {sel.source.startsWith("svc:") && (
                    <input value={sel.source.slice(4)} onChange={e => updateField(sel.id, { source: "svc:" + e.target.value, label: e.target.value })} placeholder="Service name (e.g. Packing, Stairs)"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  {sel.source.startsWith("chk:") && (
                    <input value={sel.source.slice(4)} onChange={e => updateField(sel.id, { source: "chk:" + e.target.value, label: e.target.value })} placeholder="Checkbox name (e.g. Stairs — Origin)"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  {sel.source.startsWith("text:") && (
                    <input value={sel.source.slice(5)} onChange={e => updateField(sel.id, { source: "text:" + e.target.value })} placeholder="Fixed text"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  {sel.source.startsWith("job:") && (
                    <input value={sel.source.slice(4)} onChange={e => updateField(sel.id, { source: "job:" + e.target.value.trim() })} placeholder="job field name (e.g. lot_number)"
                      style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", marginBottom: 10, fontSize: 13, boxSizing: "border-box" }} />
                  )}
                  {/* Panel behaviour: fixed = stamped for everyone; variable = asked when generating */}
                  <label style={{ fontSize: 12, color: "#888" }}>On generate</label>
                  <div style={{ display: "flex", gap: 4, margin: "4px 0 10px" }}>
                    {[["fixed", "Fixed"], ["variable", "Ask (variable)"]].map(([m, t]) => {
                      const cur = sel.mode || (sel.source.startsWith("text:") ? "fixed" : "variable");
                      return <button key={m} onClick={() => updateField(sel.id, { mode: m })} style={{ flex: 1, padding: 6, borderRadius: 7, border: "1px solid #eee", cursor: "pointer", fontSize: 12, background: cur === m ? "#111" : "#fff", color: cur === m ? "#fff" : "#666" }}>{t}</button>;
                    })}
                  </div>
                  {(sel.mode || (sel.source.startsWith("text:") ? "fixed" : "variable")) === "variable" && !sel.source.startsWith("svc:") && (
                    <>
                      <label style={{ fontSize: 12, color: "#888" }}>Label (shown in the panel)</label>
                      <input value={sel.label || ""} onChange={e => updateField(sel.id, { label: e.target.value })} placeholder="optional"
                        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 10px", fontSize: 13, boxSizing: "border-box" }} />
                    </>
                  )}
                  {(sel.mode || (sel.source.startsWith("text:") ? "fixed" : "variable")) === "variable" && !sel.source.startsWith("chk:") && (
                    <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12, color: "#888" }}>Group</label>
                        <select value={sel.group || ""} onChange={e => updateField(sel.id, { group: e.target.value })} style={{ width: "100%", padding: 7, borderRadius: 8, border: "1px solid #e5e5e5", marginTop: 4, fontSize: 12 }}>
                          {["", "Client", "CF", "Services", "Totals", "Other"].map(g => <option key={g} value={g}>{g || "—"}</option>)}
                        </select>
                      </div>
                      <div style={{ flex: 1 }}>
                        <label style={{ fontSize: 12, color: "#888" }}>Type</label>
                        <select value={sel.kind || ""} onChange={e => updateField(sel.id, { kind: e.target.value })} style={{ width: "100%", padding: 7, borderRadius: 8, border: "1px solid #e5e5e5", marginTop: 4, fontSize: 12 }}>
                          {[["", "text"], ["money", "money $"], ["date", "date"], ["cf", "CF"]].map(([k, t]) => <option key={k} value={k}>{t}</option>)}
                        </select>
                      </div>
                    </div>
                  )}
                  {(sel.mode || (sel.source.startsWith("text:") ? "fixed" : "variable")) === "variable" && !["signature", "initial", "sign_date"].includes(sel.kind) && (
                    <>
                      <label style={{ fontSize: 12, color: "#888" }}>Default value (pre-filled)</label>
                      <input value={sel.default || ""} onChange={e => updateField(sel.id, { default: e.target.value })} placeholder={sel.kind === "checkbox" ? "x = pre-checked" : "e.g. 50.00"}
                        style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 10px", fontSize: 13, boxSizing: "border-box" }} />
                    </>
                  )}
                  {/* DocuSign signature placeholder (not stamped — becomes a DocuSign tab) */}
                  <label style={{ fontSize: 12, color: "#888" }}>Signature (DocuSign)</label>
                  <select value={["signature", "initial", "sign_date"].includes(sel.kind) ? sel.kind : ""} onChange={e => updateField(sel.id, { kind: e.target.value, ...(e.target.value ? { mode: "fixed", stage: sel.stage || "pickup" } : {}) })}
                    style={{ width: "100%", padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", margin: "4px 0 8px", fontSize: 13 }}>
                    <option value="">— no es firma —</option>
                    <option value="signature">Firma</option>
                    <option value="initial">Inicial</option>
                    <option value="sign_date">Fecha de firma</option>
                  </select>
                  {["signature", "initial", "sign_date"].includes(sel.kind) && (
                    <div style={{ display: "flex", gap: 4, margin: "0 0 10px" }}>
                      {[["pickup", "Pickup"], ["delivery", "Delivery"]].map(([s, t]) => (
                        <button key={s} onClick={() => updateField(sel.id, { stage: s })} style={{ flex: 1, padding: 6, borderRadius: 7, border: "1px solid #eee", cursor: "pointer", fontSize: 12, background: (sel.stage || "pickup") === s ? "#111" : "#fff", color: (sel.stage || "pickup") === s ? "#fff" : "#666" }}>{t}</button>
                      ))}
                    </div>
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
      {showFieldConfig && (
        <FieldConfigModal supabase={supabase} session={session} fieldConfig={fieldConfig}
          onClose={saved => { setShowFieldConfig(false); if (saved && refreshConfig) refreshConfig(); }} />
      )}
    </div>
  );
}

// ── Manage fields: global dropdown config (hide built-ins + custom fields) ──
function FieldConfigModal({ supabase, session, fieldConfig, onClose }) {
  const [hidden, setHidden] = useState(() => new Set(fieldConfig.hidden_keys));
  const [customs, setCustoms] = useState(() => (fieldConfig.custom_fields || []).map(c => ({ ...c })));
  const [newLabel, setNewLabel] = useState("");
  const [newFmt, setNewFmt] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  function toggle(k) { setHidden(h => { const n = new Set(h); n.has(k) ? n.delete(k) : n.add(k); return n; }); }

  function addCustom() {
    const label = newLabel.trim();
    if (!label) { setErr("Enter a name for the new field."); return; }
    let k = "custom_" + (label.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "field");
    while (SOURCES.some(s => s.k === k) || customs.some(c => c.k === k)) k += "_2";
    setCustoms(cs => [...cs, { k, l: label, fmt: newFmt }]);
    setNewLabel(""); setNewFmt(""); setErr(null);
  }

  async function save() {
    setSaving(true); setErr(null);
    const { error } = await supabase.from("bol_field_config").upsert({
      id: 1, hidden_keys: [...hidden], custom_fields: customs,
      updated_at: new Date().toISOString(), updated_by: session?.user?.email || null,
    });
    setSaving(false);
    if (error) { setErr(error.message + (error.code === "42P01" ? " — run scripts/setup-bol-fields.sql in Supabase first." : "")); return; }
    onClose(true);
  }

  return (
    <div onPointerDown={() => onClose(false)} style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,0.45)", zIndex: 60, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
      <div onPointerDown={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, width: 560, maxWidth: "100%", maxHeight: "86vh", display: "flex", flexDirection: "column", boxShadow: "0 20px 60px rgba(0,0,0,0.25)" }}>
        <div style={{ padding: "16px 18px 10px" }}>
          <div style={{ fontSize: 16, fontWeight: 700 }}>Manage fields</div>
          <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>Applies to all templates and all users.</div>
        </div>
        <div style={{ padding: "0 18px", overflowY: "auto", flex: 1 }}>
          {err && <div style={{ background: "#fef2f2", border: "1px solid #fca5a5", borderRadius: 8, padding: "8px 10px", fontSize: 12, color: "#b91c1c", marginBottom: 10 }}>{err}</div>}
          <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", margin: "6px 0 4px" }}>Built-in fields</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 8 }}>Uncheck to hide from the "Maps to" menu. Templates already using a hidden field keep printing it.</div>
          {GROUP_ORDER.map(g => (
            <div key={g} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: "#475569", margin: "4px 0" }}>{g}</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "2px 12px" }}>
                {SOURCES.filter(s => s.g === g).map(s => (
                  <label key={s.k} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer", color: hidden.has(s.k) ? "#b0b7c3" : "#333" }}>
                    <input type="checkbox" checked={!hidden.has(s.k)} onChange={() => toggle(s.k)} />{s.l}
                  </label>
                ))}
              </div>
            </div>
          ))}
          <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", margin: "14px 0 8px" }}>Custom fields</div>
          {customs.length === 0 && <div style={{ fontSize: 12, color: "#94a3b8", marginBottom: 8 }}>No custom fields yet — add one below. It shows up in the "Maps to" menu and as an input when generating a BOL.</div>}
          {customs.map(c => (
            <div key={c.k} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 0", borderBottom: "1px solid #f3f4f6", fontSize: 13 }}>
              <span style={{ flex: 1 }}>{c.l}</span>
              <span style={{ fontSize: 11, color: "#94a3b8" }}>{c.fmt === "money" ? "money $" : c.fmt === "date" ? "date" : "text"}</span>
              <button style={{ border: "none", background: "transparent", color: "#b91c1c", cursor: "pointer", fontSize: 12 }}
                onClick={() => { if (window.confirm(`Remove custom field "${c.l}"? Templates mapping it keep working.`)) setCustoms(cs => cs.filter(x => x.k !== c.k)); }}>Remove</button>
            </div>
          ))}
          <div style={{ display: "flex", gap: 8, margin: "10px 0 16px" }}>
            <input value={newLabel} onChange={e => setNewLabel(e.target.value)} onKeyDown={e => { if (e.key === "Enter") addCustom(); }}
              placeholder="New field name (e.g. PO Number)" style={{ flex: 1, padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 13 }} />
            <select value={newFmt} onChange={e => setNewFmt(e.target.value)} style={{ padding: 8, borderRadius: 8, border: "1px solid #e5e5e5", fontSize: 13 }}>
              <option value="">text</option><option value="money">money $</option><option value="date">date</option>
            </select>
            <button style={smallBtn} onClick={addCustom}>+ Add</button>
          </div>
        </div>
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 18px", borderTop: "1px solid #f3f4f6", flexWrap: "wrap" }}>
          <button style={btn(false)} onClick={() => onClose(false)}>Cancel</button>
          <button style={btn(true)} disabled={saving} onClick={save}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
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
    fuel_amount: "", deposit: job?.deposit ?? "", notes: "", balance_override: "", due_pickup: "", due_delivery: "",
  };
}

// ── Annotate mode: drop free text anywhere on the filled BOL (DocuSign-like).
// Renders baseBytes (filled, WITHOUT annotations) to a canvas; the text lives
// in draggable DOM boxes so it is never drawn twice. Coords in PDF points.
function AnnotatePreview({ pdfBytes, annots, onChange }) {
  const DISPLAY_W = 760;
  const [pageSizes, setPageSizes] = useState([]);
  const [curPage, setCurPage] = useState(0);
  const [selId, setSelId] = useState(null);
  const [editId, setEditId] = useState(null);
  const [placing, setPlacing] = useState(false); // armed by "+ Add text": next PDF click drops the box there
  const canvasRef = useRef(null);
  const page = pageSizes[curPage] || { w: 612, h: 792 };
  const scale = DISPLAY_W / page.w;

  useEffect(() => {
    let alive = true;
    (async () => {
      const s = await getPdfPageSizes(pdfBytes).catch(() => []);
      if (alive && s.length) { setPageSizes(s); setCurPage(p => Math.min(p, s.length - 1)); }
    })();
    return () => { alive = false; };
  }, [pdfBytes]);

  useEffect(() => {
    if (pdfBytes && canvasRef.current && pageSizes[curPage]) {
      renderPageToCanvas(pdfBytes, curPage, canvasRef.current, scale).catch(() => {});
    }
  }, [pdfBytes, curPage, scale, pageSizes]);

  // onChange is a state setter — functional updates keep fast drag events safe.
  function updateAnnot(id, patch) { onChange(prev => prev.map(a => a.id === id ? { ...a, ...patch } : a)); }
  function deleteAnnot(id) { onChange(prev => prev.filter(a => a.id !== id)); if (selId === id) setSelId(null); }
  const startDrag = useBoxDrag(scale, updateAnnot);

  // Double-click detection via pointerdown timing: startDrag preventDefault()s
  // the pointerdown, which suppresses the native dblclick event in Chromium.
  const lastTap = useRef({ id: null, t: 0 });
  function onBoxPointerDown(e, a) {
    const now = Date.now();
    if (lastTap.current.id === a.id && now - lastTap.current.t < 350) {
      e.stopPropagation(); e.preventDefault();
      setSelId(a.id); setEditId(a.id);
      lastTap.current = { id: null, t: 0 };
      return;
    }
    lastTap.current = { id: a.id, t: now };
    setSelId(a.id); startDrag(e, a, "move");
  }

  // Click-to-place: "+ Add text" arms placing mode; the next click on the PDF
  // drops an empty text box right there and opens it for typing. Fastest path
  // for a missing value — no template ("BOL madre") edit needed.
  function addTextAt(px, py) {
    const id = rid();
    onChange(prev => [...prev, { id, page: curPage, x: Math.max(0, Math.round(px)), y: Math.max(0, Math.round(py) - 7), w: 180, h: 20, text: "", fontSize: 10, align: "left" }]);
    setSelId(id); setEditId(id);
  }

  const sel = annots.find(a => a.id === selId);
  const pageAnnots = annots.filter(a => (a.page || 0) === curPage);

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
        <button style={{ ...smallBtn, ...(placing ? { background: "#111", color: "#fff", borderColor: "#111" } : {}) }}
          onClick={() => { setPlacing(p => !p); setSelId(null); setEditId(null); }}>
          {placing ? "Click on the PDF…" : "+ Add text"}
        </button>
        {pageSizes.length > 1 && (
          <>
            <button style={smallBtn} disabled={curPage === 0} onClick={() => { setCurPage(p => p - 1); setSelId(null); setEditId(null); }}>‹ Prev</button>
            <span style={{ fontSize: 13 }}>Page {curPage + 1} / {pageSizes.length}</span>
            <button style={smallBtn} disabled={curPage === pageSizes.length - 1} onClick={() => { setCurPage(p => p + 1); setSelId(null); setEditId(null); }}>Next ›</button>
          </>
        )}
        <span style={{ fontSize: 11, color: "#94a3b8" }}>
          {placing ? "Click anywhere on the PDF to drop the text there (click the button again to cancel)."
            : "Drag to move · drag the corner to resize · double-click to edit text."}
        </span>
      </div>
      {/* Always rendered: mounting it on select would shift the page mid-double-click. */}
      <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8, flexWrap: "wrap", background: "#f8fafc", border: "1px solid #e2e8f0", borderRadius: 8, padding: "6px 10px", minHeight: 28 }}>
        {sel ? (
          <>
            <label style={{ fontSize: 12, color: "#888" }}>Size {sel.fontSize}</label>
            <input type="range" min="6" max="24" step="0.5" value={sel.fontSize} onChange={e => updateAnnot(sel.id, { fontSize: Number(e.target.value) })} style={{ width: 110 }} />
            {["left", "center", "right"].map(a => (
              <button key={a} onClick={() => updateAnnot(sel.id, { align: a })}
                style={{ padding: "4px 9px", borderRadius: 7, border: "1px solid #eee", cursor: "pointer", fontSize: 12, background: sel.align === a ? "#111" : "#fff", color: sel.align === a ? "#fff" : "#666" }}>{a}</button>
            ))}
            <button style={smallBtn} onClick={() => setEditId(sel.id)}>✎ Edit text</button>
            <button style={{ ...smallBtn, color: "#b91c1c" }} onClick={() => deleteAnnot(sel.id)}>Delete text</button>
          </>
        ) : <span style={{ fontSize: 12, color: "#94a3b8" }}>Select a text box to style or edit it.</span>}
      </div>
      <div style={{ position: "relative", width: DISPLAY_W, maxWidth: "100%", border: "1px solid #ddd", borderRadius: 8, lineHeight: 0, overflow: "hidden", cursor: placing ? "crosshair" : "default" }}
        onPointerDown={e => {
          if (placing) {
            const rect = e.currentTarget.getBoundingClientRect();
            addTextAt((e.clientX - rect.left) / scale, (e.clientY - rect.top) / scale);
            setPlacing(false);
            return;
          }
          setSelId(null); setEditId(null);
        }}>
        <canvas ref={canvasRef} style={{ width: "100%", height: "auto", display: "block" }} />
        {pageAnnots.map(a => {
          const selected = a.id === selId;
          const editing = a.id === editId;
          return (
            <div key={a.id}
              onPointerDown={e => { if (editing) { e.stopPropagation(); return; } onBoxPointerDown(e, a); }}
              onDoubleClick={e => { e.stopPropagation(); setSelId(a.id); setEditId(a.id); }}
              style={{ position: "absolute", left: a.x * scale, top: a.y * scale, width: a.w * scale, minHeight: a.h * scale,
                border: selected ? "1.5px solid #2563eb" : "1px dashed #60a5fa", background: selected ? "rgba(37,99,235,0.06)" : "transparent",
                cursor: editing ? "text" : "move", boxSizing: "border-box", lineHeight: 1.25 }}>
              {editing ? (
                <textarea ref={el => { if (el && !el.__focused) { el.__focused = true; setTimeout(() => el.focus(), 0); } }} value={a.text}
                  onChange={e => updateAnnot(a.id, { text: e.target.value })}
                  onBlur={() => { setEditId(null); if (!String(a.text || "").trim()) deleteAnnot(a.id); }}
                  onKeyDown={e => { if (e.key === "Escape") { e.preventDefault(); e.currentTarget.blur(); } }}
                  style={{ position: "absolute", inset: 0, width: "100%", height: "100%", border: "none", outline: "none", resize: "none",
                    background: "transparent", padding: 0, margin: 0, fontFamily: "Helvetica, Arial, sans-serif",
                    fontSize: (a.fontSize || 10) * scale, lineHeight: 1.25, color: "#0A215C", textAlign: a.align || "left" }} />
              ) : (
                <div style={{ whiteSpace: "pre", overflow: "hidden", fontFamily: "Helvetica, Arial, sans-serif",
                  fontSize: (a.fontSize || 10) * scale, color: "#0A215C", textAlign: a.align || "left", width: "100%" }}>{a.text}</div>
              )}
              <div onPointerDown={e => { setSelId(a.id); startDrag(e, a, "resize"); }}
                style={{ position: "absolute", right: -4, bottom: -4, width: 10, height: 10, background: "#2563eb", border: "1px solid #fff", borderRadius: 2, cursor: "nwse-resize", display: selected && !editing ? "block" : "none" }} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function GeneratePanel({ supabase, session, templates, jobs, brokers, initialJobNumber, reopenDoc, fieldConfig = EMPTY_FIELD_CONFIG, onClose, onSaved }) {
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
  const [baseBytes, setBaseBytes] = useState(null); // filled PDF WITHOUT annotations (annotate-mode canvas)
  const [annots, setAnnots] = useState(() => reopenDoc?.annotations || []); // free-text boxes stamped on top
  const [annotMode, setAnnotMode] = useState(false);
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

  // Named service/charge fields the template defines as "variable" (DocuSign-style).
  // Deduped by source so a service that appears on 2 pages shows one input.
  const serviceFields = useMemo(() => {
    const t = templates.find(t => String(t.id) === String(tplId));
    const seen = new Set(), out = [];
    for (const x of (t?.field_map || [])) {
      if (x.mode !== "variable" || !x.source) continue;
      if (!(x.group === "Services" || String(x.source).startsWith("svc:"))) continue;
      if (seen.has(x.source)) continue;
      seen.add(x.source);
      out.push({ source: x.source, label: x.label || (x.source.startsWith("svc:") ? x.source.slice(4) : x.source), default: x.default });
    }
    return out;
  }, [templates, tplId]);

  // Custom fields (from Manage fields) the template maps — same idea as
  // serviceFields. Works off the field_map + "custom_" prefix so a custom
  // field deleted from the config keeps its input on old templates.
  const customJobFields = useMemo(() => {
    const t = templates.find(t => String(t.id) === String(tplId));
    const seen = new Set(), out = [];
    for (const x of (t?.field_map || [])) {
      if (!String(x.source || "").startsWith("custom_") || x.mode === "fixed") continue;
      if (seen.has(x.source)) continue;
      seen.add(x.source);
      const def = (fieldConfig.custom_fields || []).find(c => c.k === x.source);
      out.push({ source: x.source, label: def?.l || x.label || x.source, default: x.default });
    }
    return out;
  }, [templates, tplId, fieldConfig]);

  // Tick boxes the template defines (origin/destination, payment method…).
  // Deduped by source: the same checkbox on several pages shares one tick.
  const checkboxFields = useMemo(() => {
    const t = templates.find(t => String(t.id) === String(tplId));
    const seen = new Set(), out = [];
    for (const x of (t?.field_map || [])) {
      if (x.kind !== "checkbox" || !x.source || seen.has(x.source)) continue;
      seen.add(x.source);
      out.push({ source: x.source, label: x.label || (String(x.source).startsWith("chk:") ? x.source.slice(4) : x.source), default: x.default });
    }
    return out;
  }, [templates, tplId]);

  // Seed service/custom/checkbox fields with their template defaults
  // (without clobbering edits).
  useEffect(() => {
    if (!serviceFields.length && !customJobFields.length && !checkboxFields.length) return;
    setF(s => {
      const add = {};
      for (const sf of [...serviceFields, ...customJobFields]) if (s[sf.source] === undefined) add[sf.source] = sf.default ?? "";
      for (const cb of checkboxFields) if (s[cb.source] === undefined) add[cb.source] = !!cb.default;
      return Object.keys(add).length ? { ...s, ...add } : s;
    });
  }, [serviceFields, customJobFields, checkboxFields]); // eslint-disable-line

  // Prefill the sheet from the picked job (not when reopening a saved snapshot).
  useEffect(() => {
    if (!jobPicked || !jobId) return;
    const job = jobs.find(j => String(j.id) === String(jobId));
    if (job) { setF(sheetFromJob(job)); setExtraCf([]); setCharges([]); setDiscounts([]); }
  }, [jobId]); // eslint-disable-line

  // Load the base PDF: normally the blank company template; when reopening a
  // BOL whose pickup is already signed, the SIGNED copy is the base — the
  // pickup signature must stay visible on the document signed at delivery.
  // Annotation coordinates are template-specific, so a real template switch
  // clears them (not the initial mount — that would wipe a reopened doc's).
  const onSignedBase = !!reopenDoc?.pickup_signed_path;
  const prevTplId = useRef(null);
  useEffect(() => {
    let alive = true;
    if (prevTplId.current != null && prevTplId.current !== tplId) { setAnnots([]); setAnnotMode(false); }
    prevTplId.current = tplId;
    (async () => {
      setTplBytes(null); setBaseBytes(null);
      if (onSignedBase) {
        const { data } = await supabase.storage.from("bol-signed").download(reopenDoc.pickup_signed_path);
        if (alive && data) setTplBytes(new Uint8Array(await data.arrayBuffer()));
        return;
      }
      const tpl = templates.find(t => String(t.id) === String(tplId));
      if (!tpl?.pdf_path) return;
      const { data } = await supabase.storage.from("bol-templates").download(tpl.pdf_path);
      if (alive && data) setTplBytes(new Uint8Array(await data.arrayBuffer()));
    })();
    return () => { alive = false; };
  }, [tplId, templates, supabase, onSignedBase]); // eslint-disable-line

  // Snapshot of the values as they were when the signed version was saved —
  // used to stamp only what CHANGED on top of the signed base.
  const baseEff = useRef(null);
  useEffect(() => { if (onSignedBase && baseEff.current === null) baseEff.current = effJob; }, []); // eslint-disable-line

  // ── Live calculator ────────────────────────────────────────────────────────
  // Fuel is MANUAL (per company it varies) — we only suggest a value; the user
  // can always override. Total = CF + fuel + named services + ad-hoc charges −
  // discounts. Balance = Total − Deposit, split 50/50 pickup/delivery (editable).
  const calc = useMemo(() => {
    const baseCf = parseCfNum(f.volume);
    const rate = num(f.price_per_cf);
    const baseAmt = baseCf * rate;
    const extraAmt = extraCf.reduce((s, l) => s + num(l.qty) * num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate), 0);
    const extraCfQty = extraCf.reduce((s, l) => s + num(l.qty), 0);
    const totalCf = baseCf + extraCfQty;
    const cfSubtotal = baseAmt + extraAmt;
    const fuelPct = num(f.fuel_surcharge_pct);
    const fuelSuggest = cfSubtotal * fuelPct / 100;
    const manualFuel = f.fuel_amount !== "" && f.fuel_amount != null;
    const fuelAmt = manualFuel ? num(f.fuel_amount) : fuelSuggest;
    const servicesTotal = serviceFields.reduce((s, sf) => s + num(f[sf.source]), 0);
    const chargesTotal = charges.reduce((s, l) => s + num(l.amount), 0);
    const discountTotal = discounts.reduce((s, l) => s + Math.abs(num(l.amount)), 0);
    const grandTotal = cfSubtotal + fuelAmt + servicesTotal + chargesTotal - discountTotal;
    const deposit = num(f.deposit);
    const manualBal = f.balance_override !== "" && f.balance_override != null;
    const balanceDue = manualBal ? num(f.balance_override) : grandTotal - deposit;
    const duePickup = f.due_pickup !== "" && f.due_pickup != null ? num(f.due_pickup) : balanceDue / 2;
    const dueDelivery = f.due_delivery !== "" && f.due_delivery != null ? num(f.due_delivery) : balanceDue / 2;
    return { baseCf, rate, baseAmt, extraAmt, extraCfQty, totalCf, cfSubtotal, fuelPct, fuelSuggest, fuelAmt, servicesTotal, chargesTotal, discountTotal, grandTotal, deposit, balanceDue, duePickup, dueDelivery };
  }, [f, extraCf, charges, discounts, serviceFields]);

  // The "effective job" fed to the stamper: base job + edits + computed + slots.
  const effJob = useMemo(() => {
    const job = jobs.find(j => String(j.id) === String(jobId)) || {};
    const e = { ...job };
    for (const hf of HEADER_FIELDS) e[hf.k] = f[hf.k] ?? "";
    for (const sf of serviceFields) e[sf.source] = f[sf.source] ?? "";
    for (const cf of customJobFields) e[cf.source] = f[cf.source] ?? "";
    for (const cb of checkboxFields) e[cb.source] = !!f[cb.source];
    e.volume = f.volume; e.price_per_cf = f.price_per_cf; e.fuel_surcharge_pct = f.fuel_surcharge_pct; e.deposit = f.deposit;
    e.cf_total = calc.cfSubtotal; e.fuel_amount = calc.fuelAmt; e.grand_total = calc.grandTotal;
    e.estimate = calc.grandTotal; e.balance_due = calc.balanceDue; e.bol_balance = calc.balanceDue;
    e.due_pickup = calc.duePickup; e.due_delivery = calc.dueDelivery;
    e.notes = f.notes || "";
    extraCf.slice(0, 2).forEach((l, i) => {
      const r = num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate);
      e[`add_cf_${i + 1}_qty`] = l.qty; e[`add_cf_${i + 1}_rate`] = r || ""; e[`add_cf_${i + 1}_amount`] = num(l.qty) * r;
    });
    charges.slice(0, 4).forEach((l, i) => { e[`charge_${i + 1}_label`] = l.label || ""; e[`charge_${i + 1}_amount`] = l.amount === "" ? "" : num(l.amount); });
    discounts.slice(0, 2).forEach((l, i) => { e[`discount_${i + 1}_label`] = l.label || ""; e[`discount_${i + 1}_amount`] = l.amount === "" ? "" : -Math.abs(num(l.amount)); });
    return e;
  }, [f, extraCf, charges, discounts, calc, jobId, jobs, serviceFields, customJobFields, checkboxFields]);

  const tpl = templates.find(t => String(t.id) === String(tplId));
  const snapshot = JSON.stringify([effJob, tpl?.field_map]);

  // Debounced live preview, two stages: (A) stamp the mapped fields into
  // baseBytes — the annotate-mode canvas renders these, so annotation text is
  // never drawn twice; (B) stamp the free-text annotations on top and expose
  // the final bytes via blobUrl (preview embed, Download, Open tab).
  useEffect(() => {
    if (!tplBytes || !tpl) return;
    const h = setTimeout(async () => {
      try {
        // Signed base: cover the annotations baked into it first (effect B
        // re-stamps the current ones), then stamp only the changed fields.
        let base = tplBytes;
        if (onSignedBase && (reopenDoc?.annotations || []).length) base = await whiteOutAnnotations(base, reopenDoc.annotations);
        setBaseBytes(await generateFilledPdf(base, tpl.field_map || [], effJob, brokers, onSignedBase ? baseEff.current : null));
      } catch (e) { /* keep previous preview */ }
    }, 450);
    return () => clearTimeout(h);
  }, [tplBytes, snapshot]); // eslint-disable-line

  const annotsSnapshot = JSON.stringify(annots);
  useEffect(() => {
    if (!baseBytes) return;
    const h = setTimeout(async () => {
      try {
        const out = annots.length ? await stampAnnotations(baseBytes, annots) : baseBytes;
        const url = URL.createObjectURL(new Blob([out], { type: "application/pdf" }));
        setBlobUrl(prev => { if (prev) URL.revokeObjectURL(prev); return url; });
      } catch (e) { /* keep previous preview */ }
    }, 200);
    return () => clearTimeout(h);
  }, [baseBytes, annotsSnapshot]); // eslint-disable-line

  useEffect(() => () => { if (blobUrl) URL.revokeObjectURL(blobUrl); }, []); // eslint-disable-line

  async function save(status) {
    setError(null); setNotice(null);
    if (!tpl) { setError("Pick a template."); return; }
    if (!tplBytes) { setError("Template PDF still loading — try again."); return; }
    setSaving(true);
    try {
      let base = tplBytes;
      if (onSignedBase && (reopenDoc?.annotations || []).length) base = await whiteOutAnnotations(base, reopenDoc.annotations);
      let out = await generateFilledPdf(base, tpl.field_map || [], effJob, brokers, onSignedBase ? baseEff.current : null);
      if (annots.length) out = await stampAnnotations(out, annots);
      // Filename by job# + client for easy search (with a unique suffix so it never overwrites).
      const nice = [f.job_number, f.customer].filter(Boolean).join(" - ") || "bol";
      const safe = nice.replace(/[^a-zA-Z0-9._ -]/g, "").trim().slice(0, 60) || "bol";
      const path = `${safe} ${Date.now()}.pdf`;
      const { error: upErr } = await supabase.storage.from("bol-generated").upload(path, out, { contentType: "application/pdf", upsert: true });
      if (upErr) throw upErr;
      const line_items = [
        ...extraCf.map(l => ({ type: "cf", label: "Additional CF", qty: num(l.qty), rate: num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate), amount: num(l.qty) * num(l.rate === "" || l.rate == null ? f.price_per_cf : l.rate) })),
        ...serviceFields.filter(sf => String(f[sf.source] ?? "") !== "").map(sf => ({ type: "service", source: sf.source, label: sf.label, amount: num(f[sf.source]) })),
        ...charges.map(l => ({ type: "charge", label: l.label, amount: num(l.amount) })),
        ...discounts.map(l => ({ type: "discount", label: l.label, amount: -Math.abs(num(l.amount)) })),
      ];
      const job = jobs.find(j => String(j.id) === String(jobId));
      const { error: insErr } = await supabase.from("bol_documents").insert({
        customer: f.customer || job?.customer || null, job_id: job?.id || null, job_number: f.job_number || null,
        template_id: tpl.id, company_name: tpl.company_name,
        // _on_signed_base: this version's PDF was built ON TOP of the signed
        // pickup copy (signature visible) → delivery signs pdf_path as-is.
        values: { ...f, ...calc, ...(onSignedBase ? { _on_signed_base: true } : {}) }, line_items, annotations: annots, pdf_path: path, status,
        created_by: session?.user?.email || null,
        // A new version after the pickup was signed inherits that signature
        // (the signed pickup PDF is immutable) so it goes straight to the
        // delivery-signature step. The delivery signature is never carried:
        // it must be signed on the latest content.
        ...(reopenDoc?.pickup_signed_path ? {
          pickup_envelope_id: reopenDoc.pickup_envelope_id || null,
          pickup_signed_path: reopenDoc.pickup_signed_path,
          pickup_signed_at: reopenDoc.pickup_signed_at || null,
          sign_status: "pickup_signed",
        } : {}),
      });
      if (insErr) throw insErr;
      setNotice(status === "final"
        ? (reopenDoc?.pickup_signed_path ? "Saved as a new version — pickup signature carried over; it's ready to sign at delivery." : "Saved as final — it's in Documents.")
        : "Draft saved to Documents.");
      onSaved && onSaved();
    } catch (e) { setError(e.message); }
    setSaving(false);
  }

  const computed = [
    ["CF total", calc.cfSubtotal],
    ["Fuel $", calc.fuelAmt],
    ["Services", calc.servicesTotal],
    ["Other charges", calc.chargesTotal],
    ["Discounts", -calc.discountTotal],
    ["Grand total", calc.grandTotal],
    ["Deposit", calc.deposit],
    ["Balance due", calc.balanceDue],
    ["Due at pickup", calc.duePickup],
    ["Due at delivery", calc.dueDelivery],
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
      {reopenDoc?.pickup_signed_path && (
        <div style={{ background: "#EFF6FF", border: "1px solid #bfdbfe", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#1d4ed8", marginBottom: 12 }}>
          ✍ Este BOL ya tiene el <b>pickup firmado</b> (esa copia queda archivada tal cual). Al guardar, la nueva versión hereda esa firma y queda lista para <b>firmar el delivery</b> con los cambios incluidos.
        </div>
      )}

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

          {/* custom fields (from Manage fields, mapped by the template) */}
          {customJobFields.length > 0 && (
            <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", marginBottom: 10 }}>Custom fields</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {customJobFields.map(cf => (
                  <div key={cf.source}>
                    <label style={lbl}>{cf.label}</label>
                    <input value={f[cf.source] ?? ""} onChange={e => set(cf.source, e.target.value)} placeholder={cf.default || ""} style={inp} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* tick boxes from the template (origin/destination, payment method…) */}
          {checkboxFields.length > 0 && (
            <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", marginBottom: 10 }}>Checkboxes (from template)</div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "4px 12px" }}>
                {checkboxFields.map(cb => (
                  <label key={cb.source} style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 6, cursor: "pointer" }}>
                    <input type="checkbox" checked={!!f[cb.source]} onChange={e => set(cb.source, e.target.checked)} />{cb.label}
                  </label>
                ))}
              </div>
            </div>
          )}

          {/* charges calculator */}
          <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: 14 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#999", textTransform: "uppercase", marginBottom: 10 }}>Charges</div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 8, marginBottom: 8 }}>
              <div><label style={lbl}>Base CF</label><input value={f.volume ?? ""} onChange={e => set("volume", e.target.value)} style={inp} /></div>
              <div><label style={lbl}>Rate / CF</label><input value={f.price_per_cf ?? ""} onChange={e => set("price_per_cf", e.target.value)} style={inp} /></div>
              <div><label style={lbl}>Fuel %</label><input value={f.fuel_surcharge_pct ?? ""} onChange={e => set("fuel_surcharge_pct", e.target.value)} style={inp} /></div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 8, alignItems: "end", marginBottom: 6 }}>
              <div><label style={lbl}>Fuel $ (manual — blank = {calc.fuelPct || 0}% of CF)</label>
                <input value={f.fuel_amount ?? ""} onChange={e => set("fuel_amount", e.target.value)} placeholder={fmtMoney(calc.fuelSuggest) || "0.00"} style={inp} /></div>
              <button style={{ ...lineBtn, whiteSpace: "nowrap" }} title="Fill with % of CF" onClick={() => set("fuel_amount", calc.fuelSuggest ? calc.fuelSuggest.toFixed(2) : "")}>≈ suggest</button>
            </div>
            <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 10 }}>Base CF stays untouched — extra CF goes on its own line. Fuel is manual (Transit varies the rate).</div>

            {/* extra CF lines */}
            {extraCf.map((l, i) => (
              <div key={l.id} style={{ display: "grid", gridTemplateColumns: "1fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "end" }}>
                <div><label style={lbl}>+ Extra CF {i + 1} — qty</label><input value={l.qty} onChange={e => setExtraCf(a => a.map(x => x.id === l.id ? { ...x, qty: e.target.value } : x))} style={inp} /></div>
                <div><label style={lbl}>rate (blank = base)</label><input value={l.rate} onChange={e => setExtraCf(a => a.map(x => x.id === l.id ? { ...x, rate: e.target.value } : x))} placeholder={String(f.price_per_cf || "")} style={inp} /></div>
                <button style={delX} title="Remove" onClick={() => setExtraCf(a => a.filter(x => x.id !== l.id))}>✕</button>
              </div>
            ))}
            {/* named services from the template (DocuSign-style boxes) */}
            {serviceFields.length > 0 && (
              <div style={{ margin: "4px 0 8px" }}>
                <div style={{ fontSize: 11, fontWeight: 700, color: "#bbb", textTransform: "uppercase", margin: "6px 0 6px" }}>Services (from template)</div>
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                  {serviceFields.map(sf => (
                    <div key={sf.source}>
                      <label style={lbl}>{sf.label}{sf.default ? ` · std ${sf.default}` : ""}</label>
                      <input value={f[sf.source] ?? ""} onChange={e => set(sf.source, e.target.value)} placeholder={sf.default || "$"} style={inp} />
                    </div>
                  ))}
                </div>
              </div>
            )}
            {/* other charges (ad-hoc, if the template didn't name them) */}
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
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 8 }}>
                <div><label style={lbl}>Due pickup (override)</label><input value={f.due_pickup ?? ""} onChange={e => set("due_pickup", e.target.value)} placeholder={fmtMoney(calc.balanceDue / 2) || "0.00"} style={inp} /></div>
                <div><label style={lbl}>Due delivery (override)</label><input value={f.due_delivery ?? ""} onChange={e => set("due_delivery", e.target.value)} placeholder={fmtMoney(calc.balanceDue / 2) || "0.00"} style={inp} /></div>
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
              <div style={{ display: "flex", gap: 8, marginBottom: 8, alignItems: "center", flexWrap: "wrap" }}>
                <a href={blobUrl} download="bol.pdf" style={{ ...btn(false), textDecoration: "none" }}>⬇ Download</a>
                <a href={blobUrl} target="_blank" rel="noreferrer" style={{ ...btn(false), textDecoration: "none" }}>Open tab</a>
                <button style={btn(annotMode)} disabled={!baseBytes} onClick={() => setAnnotMode(m => !m)}>{annotMode ? "✓ Done editing" : "✎ Add text on PDF"}</button>
                <span style={{ fontSize: 12, color: "#94a3b8" }}>
                  {annotMode ? "Click + Add text, drag to place." : annots.length ? `${annots.length} text note(s) will be stamped.` : "Preview updates live as you edit."}
                </span>
              </div>
              {annotMode && baseBytes
                ? <AnnotatePreview pdfBytes={baseBytes} annots={annots} onChange={setAnnots} />
                : <object data={blobUrl} type="application/pdf" style={{ width: "100%", height: 760, border: "1px solid #ddd", borderRadius: 8 }} />}
            </>
          ) : <div style={{ border: "2px dashed #e5e5e5", borderRadius: 12, padding: 48, textAlign: "center", color: "#aaa", fontSize: 14 }}>{busy ? "Loading…" : "Pick a template and job — the live preview appears here."}</div>}
        </div>
      </div>
    </div>
  );
}

// ── Documents: every saved BOL (legal backup), searchable by customer ───────
const SIGN_BADGE = {
  unsigned:        ["Generated", "#FEF3C7", "#92760B"],
  pickup_sent:     ["Pickup sent", "#E0EDFF", "#1d4ed8"],
  pickup_signed:   ["Pickup signed", "#EAF3DE", "#3B6D11"],
  delivery_sent:   ["Delivery sent", "#E0EDFF", "#1d4ed8"],
  delivery_signed: ["Delivery signed", "#EAF3DE", "#3B6D11"],
  completed:       ["Completed ✓", "#DCFCE7", "#166534"],
};

function DocumentsView({ supabase, session, canEdit, onReopen, onClose, jobs = [], brokers = [] }) {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [q, setQ] = useState("");
  const [busyId, setBusyId] = useState(null);
  const [folder, setFolder] = useState(""); // "" = all | "none" | broker id

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    const { data, error } = await supabase.from("bol_documents").select("*").order("created_at", { ascending: false }).limit(500);
    if (error) setError(error.message); else setRows(data || []);
    setLoading(false);
  }, [supabase]);
  useEffect(() => { load(); }, [load]);

  // Broker "folders": each BOL belongs to its job's broker (resolved live from
  // the jobs list, so no schema change and old documents get organized too).
  const brokerIdOf = useCallback(r => {
    const job = jobs.find(j => String(j.id) === String(r.job_id));
    return job?.broker_id != null ? String(job.broker_id) : null;
  }, [jobs]);
  const folders = useMemo(() => {
    const counts = new Map();
    let none = 0;
    for (const r of rows) { const id = brokerIdOf(r); if (id) counts.set(id, (counts.get(id) || 0) + 1); else none++; }
    const list = brokers.filter(b => counts.has(String(b.id)))
      .map(b => ({ key: String(b.id), name: b.name, count: counts.get(String(b.id)) }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { list, none };
  }, [rows, brokers, brokerIdOf]);
  const brokerName = useCallback(r => {
    const id = brokerIdOf(r);
    return id ? (brokers.find(b => String(b.id) === id)?.name || "—") : null;
  }, [brokerIdOf, brokers]);

  const filtered = useMemo(() => {
    let list = rows;
    if (folder === "none") list = list.filter(r => !brokerIdOf(r));
    else if (folder) list = list.filter(r => brokerIdOf(r) === folder);
    const s = q.trim().toLowerCase();
    return s ? list.filter(r => [r.customer, r.job_number, r.company_name, brokerName(r)].filter(Boolean).some(v => String(v).toLowerCase().includes(s))) : list;
  }, [rows, q, folder, brokerIdOf, brokerName]);

  function urlFor(r) { return r.pdf_path ? supabase.storage.from("bol-generated").getPublicUrl(r.pdf_path).data.publicUrl : null; }
  async function remove(r) {
    if (!window.confirm(`Delete this BOL for ${r.customer || "—"}? This removes the legal record.`)) return;
    await supabase.from("bol_documents").delete().eq("id", r.id);
    if (r.pdf_path) await supabase.storage.from("bol-generated").remove([r.pdf_path]);
    load();
  }

  // Send this BOL to DocuSign for the given stage and open the embedded signing view.
  // Email the DocuSign signing request to the client (remote back-office flow).
  async function sign(r, stage) {
    const email = window.prompt(`Email del cliente para firmar el ${stage} (le llega el mail de DocuSign):`, r.values?.client_email || "");
    if (email === null) return;
    if (!email.trim()) { setError("Poné el email del cliente."); return; }
    setBusyId(r.id); setError(null); setNotice(null);
    try {
      const res = await fetch("/api/docusign-send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ document_id: r.id, stage, signer_email: email.trim(), signer_name: r.customer, mode: "email" }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || "Error al enviar a DocuSign.");
      await load();
      setNotice(`📧 BOL enviado a ${email.trim()} para firmar. Cuando el cliente firme desde su mail, la copia firmada aparece acá sola.`);
    } catch (e) { setError(e.message); }
    setBusyId(null);
  }
  // Open a signed copy (private bucket → short-lived signed URL).
  async function viewSigned(path) {
    const { data, error } = await supabase.storage.from("bol-signed").createSignedUrl(path, 120);
    if (error) { setError(error.message); return; }
    window.open(data.signedUrl, "_blank", "noopener");
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
      {notice && <div style={{ background: "#EAF3DE", border: "1px solid #cfe6b4", borderRadius: 8, padding: "10px 12px", fontSize: 13, color: "#3B6D11", marginBottom: 12 }}>{notice}</div>}

      {/* Broker folders */}
      {(folders.list.length > 0 || folders.none > 0) && (
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
          {[["", `📁 All BOLs (${rows.length})`], ...folders.list.map(f => [f.key, `📁 ${f.name} (${f.count})`]), ...(folders.none ? [["none", `📁 No broker (${folders.none})`]] : [])].map(([key, label]) => (
            <button key={key || "all"} onClick={() => setFolder(key)}
              style={{ padding: "6px 12px", borderRadius: 8, border: "1px solid", borderColor: folder === key ? "#111" : "#e5e5e5", cursor: "pointer", fontSize: 12, fontWeight: folder === key ? 700 : 400, background: folder === key ? "#111" : "#fff", color: folder === key ? "#fff" : "#444" }}>{label}</button>
          ))}
        </div>
      )}

      <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 12, overflow: "hidden" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead><tr>{["Date", "Customer", "Job #", "Company", "Broker", "Signature", ""].map((h, i) =>
            <th key={i} style={{ padding: "10px 12px", fontSize: 11, fontWeight: 600, color: "#999", textTransform: "uppercase", textAlign: i === 6 ? "right" : "left", borderBottom: "1px solid #f3f3f3" }}>{h}</th>)}
          </tr></thead>
          <tbody>
            {loading ? <tr><td colSpan={7} style={{ padding: 14, fontSize: 13 }}>Loading…</td></tr>
              : filtered.length === 0 ? <tr><td colSpan={7} style={{ padding: 14, fontSize: 13, color: "#888" }}>No saved BOLs yet.</td></tr>
              : filtered.map(r => {
                const st = SIGN_BADGE[r.sign_status || "unsigned"] || SIGN_BADGE.unsigned;
                const busy = busyId === r.id;
                return (
                <tr key={r.id}>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6", whiteSpace: "nowrap" }}>{fmtDate(r.created_at) || String(r.created_at || "").slice(0, 10)}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, borderBottom: "1px solid #f6f6f6" }}>{r.customer || "—"}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{r.job_number || "—"}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{r.company_name || "—"}</td>
                  <td style={{ padding: "10px 12px", fontSize: 13, color: "#888", borderBottom: "1px solid #f6f6f6" }}>{brokerName(r) || "—"}</td>
                  <td style={{ padding: "10px 12px", borderBottom: "1px solid #f6f6f6", whiteSpace: "nowrap" }}>
                    <span style={{ fontSize: 11, fontWeight: 600, padding: "2px 8px", borderRadius: 20, background: st[1], color: st[2] }}>{st[0]}</span>
                    {r.pickup_signed_path && <button style={{ ...smallBtn, marginLeft: 6, fontSize: 11, padding: "3px 7px" }} onClick={() => viewSigned(r.pickup_signed_path)}>PU ✍</button>}
                    {r.delivery_signed_path && <button style={{ ...smallBtn, marginLeft: 4, fontSize: 11, padding: "3px 7px" }} onClick={() => viewSigned(r.delivery_signed_path)}>DEL ✍</button>}
                  </td>
                  <td style={{ padding: "10px 12px", textAlign: "right", whiteSpace: "nowrap", borderBottom: "1px solid #f6f6f6" }}>
                    {canEdit && !r.pickup_signed_path && <button style={{ ...smallBtn, marginRight: 6 }} disabled={busy} onClick={() => sign(r, "pickup")}>{busy ? "…" : "Firmar pickup"}</button>}
                    {canEdit && r.pickup_signed_path && !r.delivery_signed_path && <button style={{ ...smallBtn, marginRight: 6 }} disabled={busy} onClick={() => sign(r, "delivery")}>{busy ? "…" : "Firmar delivery"}</button>}
                    {urlFor(r) && <a href={urlFor(r)} target="_blank" rel="noreferrer" style={{ ...smallBtn, textDecoration: "none", marginRight: 6 }}>View</a>}
                    <button style={{ ...smallBtn, marginRight: 6 }} onClick={() => onReopen(r)}>Reopen</button>
                    {canEdit && <button style={{ ...smallBtn, color: "#b91c1c" }} onClick={() => remove(r)}>Delete</button>}
                  </td>
                </tr>
              );})}
          </tbody>
        </table>
      </div>
    </div>
  );
}
