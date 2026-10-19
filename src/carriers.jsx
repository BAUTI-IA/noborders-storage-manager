// Carriers — jobs we hand to outside carriers (we are the broker), the
// documents they send back, and the running balance with each one
// (docs/carrier-dispatch.md).
//
// Owns: carriers, carrier_dispatches, carrier_messages, carrier_payments,
// carrier_adjustments. carriers and carrier_dispatches are loaded by App (the
// job detail card and the job balances need them); this section loads the rest.
// The dispatch@ mailbox (scripts/carrier-dispatch.gs → lib/carrierMail.mjs)
// sends what this section queues and files what carriers send back; nothing it
// reads moves money until a person approves it here.
import { useState, useMemo, useEffect, useCallback } from "react";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { tr } from "./i18n.js";
import { selectAll, dbFailed } from "./db.js";
import { effCf } from "./analyticsData.js";
import {
  num, carrierPay, estimatedPay, dispatchNet, carrierBalances, carrierKpis, insuranceStatus,
  dispatchAlerts, waNumber, buildDispatchEmail, buildDispatchWhatsApp, rateConfirmationRows,
  reviewOutcome, carrierEmails, jobKeyOf, OPEN_STATUSES, PAYMENT_METHODS,
} from "./carrierData.js";

const BUCKET = "carrier-docs";
const inp = { fontSize:13, padding:"8px 10px", borderRadius:8, border:"1px solid #e5e5e5", background:"#fff", color:"#111", width:"100%", outline:"none", boxSizing:"border-box" };
const th = { padding:"9px 10px", textAlign:"left", fontWeight:600, fontSize:10.5, color:"#aaa", textTransform:"uppercase", letterSpacing:"0.04em", whiteSpace:"nowrap" };
const td = { padding:"9px 10px", fontSize:12.5, verticalAlign:"middle" };
const fieldLabel = { fontSize:11, fontWeight:600, color:"#888", textTransform:"uppercase", letterSpacing:"0.05em", marginBottom:4, display:"block" };
const card = { background:"#fff", borderRadius:12, border:"1px solid #efefef" };
const fmt$ = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const fmtSigned = (v) => Math.round(v) === 0 ? "$0" : (v > 0 ? "+$" : "−$") + Math.abs(Math.round(v)).toLocaleString();
const rate$ = (v) => "$" + num(v).toFixed(2);
const todayISO = () => new Date().toLocaleDateString("en-CA");
const nowISO = () => new Date().toISOString();
const notDel = (r) => r && !r.deleted_at;
const shortDate = (iso) => { const s = String(iso || "").slice(0, 10); return s ? new Date(s + "T12:00:00").toLocaleDateString(undefined, { month:"short", day:"numeric" }) : ""; };

// Dispatch states as they read in the UI.
const STATUS_META = {
  sent:          { label:"Sent",           bg:"#F1F1F1", text:"#666" },
  accepted:      { label:"Accepted",       bg:"#E6F1FB", text:"#185FA5" },
  in_progress:   { label:"In progress",    bg:"#E6F1FB", text:"#185FA5" },
  docs_received: { label:"Docs to review", bg:"#EDE9FE", text:"#6D28D9" },
  verified:      { label:"Verified",       bg:"#E3F3EA", text:"#1A8A4E" },
  disputed:      { label:"Disputed",       bg:"#FCEBEB", text:"#B91C1C" },
  cancelled:     { label:"Cancelled",      bg:"#F1F1F1", text:"#999" },
};
const METHOD_LABEL = { cash:"Cash", check:"Check", money_order:"Money order", zelle:"Zelle", card:"Card", ach:"ACH", other:"Other" };

export function StatusPill({ status }) {
  const m = STATUS_META[status] || STATUS_META.sent;
  return <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:m.bg, color:m.text, whiteSpace:"nowrap" }}>{m.label}</span>;
}

function alertText(a) {
  if (a.code === "short_collect") return tr(`Collected ${fmt$(a.amount)} less than the order`, `Cobró ${fmt$(a.amount)} menos de lo que decía la orden`);
  if (a.code === "cf_variance") return tr(`Final CF ${a.pct > 0 ? "+" : ""}${a.pct}% vs estimate`, `CF final ${a.pct > 0 ? "+" : ""}${a.pct}% contra el estimado`);
  if (a.code === "not_accepted") return tr(`Not accepted after ${a.hours} h`, `Sin aceptar hace ${a.hours} h`);
  if (a.code === "docs_overdue") return tr(`No documents ${a.days} days after delivery`, `Sin documentos ${a.days} días después de la entrega`);
  return a.code;
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

function Field({ label, children, style }) {
  return <div style={{ marginBottom:10, ...style }}><span style={fieldLabel}>{label}</span>{children}</div>;
}

function Verdict({ value }) {
  const r = Math.round(value);
  if (r > 0) return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"#E3F3EA", color:"#1A8A4E", whiteSpace:"nowrap" }}>{tr(`Owes us ${fmt$(r)}`, `Te debe ${fmt$(r)}`)}</span>;
  if (r < 0) return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"#FCEBEB", color:"#B91C1C", whiteSpace:"nowrap" }}>{tr(`We owe ${fmt$(-r)}`, `Le debés ${fmt$(-r)}`)}</span>;
  return <span style={{ fontSize:11, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"#F1F1F1", color:"#777" }}>Even</span>;
}

const pillBtn = (on) => ({ padding:"7px 14px", borderRadius:20, border:"1px solid " + (on ? "#111" : "#e5e5e5"), background: on ? "#111" : "#fff", color: on ? "#fff" : "#555", fontSize:12.5, fontWeight:600, cursor:"pointer" });
const linkBtn = { background:"none", border:"none", color:"#185FA5", cursor:"pointer", padding:0, fontSize:12.5, textDecoration:"underline" };

// ── Rate confirmation PDF ────────────────────────────────────────────────────

// The standard PDF fonts only encode Latin-1: keep what they can draw.
const pdfSafe = (s) => String(s ?? "").replace(/→/g, "->").replace(/[^\x20-\x7E -ÿ]/g, "");

export async function buildRateConfirmationPdf({ dispatch, job, carrier, company = "No Borders Moving" }) {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([612, 792]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0.07, 0.07, 0.07), grey = rgb(0.45, 0.45, 0.45), line = rgb(0.85, 0.85, 0.85);
  let y = 740;
  const text = (s, x, size = 10, f = font, color = ink) => page.drawText(pdfSafe(s), { x, y, size, font: f, color });
  const wrap = (s, width, size, f = font) => {
    const words = pdfSafe(s).split(/\s+/); const out = []; let cur = "";
    for (const w of words) { const next = cur ? cur + " " + w : w; if (f.widthOfTextAtSize(next, size) > width && cur) { out.push(cur); cur = w; } else cur = next; }
    if (cur) out.push(cur); return out.length ? out : [""];
  };
  text(company, 48, 18, bold); y -= 20;
  text("RATE CONFIRMATION", 48, 11, bold, grey);
  page.drawText(pdfSafe(`Job ${job.job_number || ""}  ·  Dispatch D${dispatch.id}`), { x: 360, y: 740, size: 11, font: bold, color: ink });
  page.drawText(pdfSafe(`Date ${todayISO()}`), { x: 360, y: 722, size: 10, font, color: grey });
  y -= 34;
  text("Carrier", 48, 9, bold, grey); y -= 14;
  text([carrier?.name, carrier?.mc_number && `MC ${carrier.mc_number}`, carrier?.dot_number && `DOT ${carrier.dot_number}`].filter(Boolean).join("  ·  "), 48, 11, bold); y -= 14;
  if (carrier?.contact_name || carrierEmails(carrier).length) { text([carrier?.contact_name, carrierEmails(carrier).join(", ")].filter(Boolean).join("  ·  "), 48, 10); y -= 14; }
  y -= 12;
  for (const [k, v] of rateConfirmationRows({ dispatch, job })) {
    page.drawLine({ start: { x: 48, y: y + 12 }, end: { x: 564, y: y + 12 }, thickness: 0.6, color: line });
    text(k, 48, 10, font, grey);
    const lines = wrap(v, 360, 10.5, bold);
    for (const [i, l] of lines.entries()) { page.drawText(l, { x: 200, y: y - i * 13, size: 10.5, font: bold, color: ink }); }
    y -= 13 * lines.length + 9;
  }
  page.drawLine({ start: { x: 48, y: y + 12 }, end: { x: 564, y: y + 12 }, thickness: 0.6, color: line });
  y -= 14;
  const terms = [
    "Reply ACCEPT to the dispatch email to confirm this job.",
    "The carrier collects the amount above from the customer at delivery. The carrier keeps its rate on the final CF (plus the extras stated here) and settles the difference with No Borders Moving.",
    "When the job is delivered, reply to the dispatch email with the signed BOL (every page) and a photo of the payment. Keep the job number in the subject.",
  ];
  for (const tline of terms) { for (const l of wrap(tline, 516, 9.5)) { text(l, 48, 9.5, font, grey); y -= 13; } y -= 4; }
  y -= 30;
  page.drawLine({ start: { x: 48, y }, end: { x: 280, y }, thickness: 0.8, color: ink });
  page.drawLine({ start: { x: 330, y }, end: { x: 564, y }, thickness: 0.8, color: ink });
  y -= 12;
  text("Carrier signature", 48, 9, font, grey);
  page.drawText("Date", { x: 330, y, size: 9, font, color: grey });
  return await pdf.save();
}

// ── Dispatch: job detail card + modal ────────────────────────────────────────

/** The live dispatch of a job (one per job; cancelled ones don't count). */
export function liveDispatchFor(jobNumber, dispatches) {
  const k = jobKeyOf(jobNumber);
  return (dispatches || []).find((d) => notDel(d) && d.status !== "cancelled" && jobKeyOf(d.job_number) === k) || null;
}

function DispatchModal({ supabase, session, job, repId, outstanding, carriers, Btn, Modal, onClose, onDone, logNote }) {
  const userEmail = session?.user?.email || null;
  const today = todayISO();
  const active = useMemo(() => carriers.filter((c) => notDel(c) && c.active !== false).sort((a, b) => String(a.name).localeCompare(String(b.name))), [carriers]);
  const [form, setForm] = useState(() => ({
    carrier_id: "", rate_type: "per_cf", rate_per_cf: "", flat_rate: "",
    est_cf: String(effCf(job) || ""), carrier_extras: "", expected_collect: outstanding > 0 ? String(Math.round(outstanding * 100) / 100) : "",
    email: true, whatsapp: true, notes: job.carrier_notes || "",
  }));
  const [saving, setSaving] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));
  const carrier = active.find((c) => String(c.id) === String(form.carrier_id)) || null;
  const ins = carrier ? insuranceStatus(carrier, today) : "unknown";
  const emails = carrierEmails(carrier);
  const wa = waNumber(carrier?.whatsapp);

  const pickCarrier = (id) => {
    const c = active.find((x) => String(x.id) === String(id));
    setForm((f) => ({ ...f, carrier_id: id, rate_per_cf: f.rate_per_cf || (c?.default_rate_per_cf != null ? String(c.default_rate_per_cf) : "") }));
  };
  const draft = { id: "…", rate_type: form.rate_type, rate_per_cf: form.rate_per_cf, flat_rate: form.flat_rate, est_cf: form.est_cf, carrier_extras: form.carrier_extras, expected_collect: form.expected_collect, notes: form.notes };
  const pay = estimatedPay(draft);
  const owes = num(form.expected_collect) - pay;
  const preview = carrier ? buildDispatchEmail({ dispatch: draft, job, carrier }).subject : "";

  async function confirm() {
    if (!carrier) { window.alert(tr("Choose a carrier.", "Elegí un carrier.")); return; }
    if (ins === "expired") { window.alert(tr("This carrier's insurance is expired. Update it before dispatching.", "El seguro de este carrier está vencido. Actualizalo antes de despachar.")); return; }
    if (form.rate_type === "per_cf" ? !(num(form.rate_per_cf) > 0) : !(num(form.flat_rate) > 0)) { window.alert(tr("Enter the carrier's rate.", "Cargá el rate del carrier.")); return; }
    if (!form.email && !form.whatsapp) { window.alert(tr("Choose how to send it: email, WhatsApp or both.", "Elegí cómo mandarla: mail, WhatsApp o los dos.")); return; }
    if (form.email && !emails.length) { window.alert(tr("This carrier has no email on file. Add it or send by WhatsApp only.", "Este carrier no tiene mail cargado. Cargalo o mandá sólo por WhatsApp.")); return; }
    if (form.whatsapp && !wa) { window.alert(tr("This carrier has no WhatsApp number on file. Add it or send by email only.", "Este carrier no tiene WhatsApp cargado. Cargalo o mandá sólo por mail.")); return; }
    // Open the WhatsApp tab now, inside the click: after the awaits below a
    // browser would block it as a popup.
    const waTab = form.whatsapp ? window.open("", "_blank") : null;
    setSaving(true);
    const channel = form.email && form.whatsapp ? "both" : form.email ? "email" : "whatsapp";
    const row = {
      job_number: job.job_number, job_id: repId || null, carrier_id: carrier.id, status: "sent", channel,
      rate_type: form.rate_type, rate_per_cf: form.rate_type === "per_cf" ? num(form.rate_per_cf) : null,
      flat_rate: form.rate_type === "flat" ? num(form.flat_rate) : null,
      est_cf: num(form.est_cf) || null, carrier_extras: num(form.carrier_extras), expected_collect: num(form.expected_collect),
      due_date: job.fadd || job.delivery_date || null, notes: form.notes || null,
      sent_at: form.email ? null : nowISO(), created_by: userEmail,
    };
    const ins1 = await supabase.from("carrier_dispatches").insert([row]).select("*").single();
    if (ins1.error) {
      setSaving(false); waTab?.close();
      if (ins1.error.code === "23505") { window.alert(tr("This job already has a live dispatch. Cancel it first to dispatch again.", "Este job ya tiene un despacho activo. Cancelalo antes de despachar de nuevo.")); return; }
      dbFailed(ins1, "carrier_dispatches"); return;
    }
    const d = ins1.data;
    // Rate confirmation PDF, attached to the email. A failure here does not
    // stop the dispatch: the email carries the same rows in its body.
    let ratecon = null;
    try {
      const bytes = await buildRateConfirmationPdf({ dispatch: d, job, carrier });
      const path = `ratecons/D${d.id}-${String(job.job_number || "job").replace(/[^\w.-]+/g, "_")}.pdf`;
      const up = await supabase.storage.from(BUCKET).upload(path, bytes, { contentType: "application/pdf", upsert: true });
      if (!up.error) {
        ratecon = { path, name: `RateCon_${String(job.job_number || d.id).replace(/[^\w.-]+/g, "_")}.pdf`, mime: "application/pdf" };
        await supabase.from("carrier_dispatches").update({ ratecon_path: path }).eq("id", d.id);
      }
    } catch (e) { console.warn("rate confirmation pdf:", e); }
    if (form.email) {
      const e = buildDispatchEmail({ dispatch: d, job, carrier });
      if (dbFailed(await supabase.from("carrier_messages").insert([{
        dispatch_id: d.id, carrier_id: carrier.id, direction: "out", channel: "email", status: "queued",
        to_addr: emails.join(", "), subject: e.subject, body_text: e.text, body_html: e.html,
        attachments: ratecon ? [ratecon] : [], created_by: userEmail,
      }]), "carrier_messages")) { setSaving(false); waTab?.close(); onDone(); return; }
    }
    if (form.whatsapp) {
      const text = buildDispatchWhatsApp({ dispatch: d, job });
      if (waTab) waTab.location.href = `https://wa.me/${wa}?text=${encodeURIComponent(text)}`;
      dbFailed(await supabase.from("carrier_messages").insert([{
        dispatch_id: d.id, carrier_id: carrier.id, direction: "out", channel: "whatsapp", status: "logged",
        to_addr: wa, body_text: text, sent_at: nowISO(), created_by: userEmail,
      }]), "carrier_messages", { quiet: true });
    }
    logNote?.(repId, tr(`Dispatched to ${carrier.name} (D${d.id})`, `Despachado a ${carrier.name} (D${d.id})`));
    setSaving(false);
    onDone(d);
  }

  return (
    <Modal wide title={tr(`Dispatch ${job.job_number || ""} to a carrier`, `Despachar ${job.job_number || ""} a un carrier`)} onClose={onClose}
      footer={<><Btn onClick={onClose}>Cancel</Btn><Btn primary disabled={saving} onClick={confirm}>{saving ? "Sending…" : "Dispatch and send"}</Btn></>}>
      <div style={{ display:"grid", gridTemplateColumns:"minmax(0,1.2fr) minmax(0,1fr)", gap:16 }}>
        <div>
          <Field label="Carrier">
            <select value={form.carrier_id} onChange={(e) => pickCarrier(e.target.value)} style={inp}>
              <option value="">Choose a carrier…</option>
              {active.map((c) => <option key={c.id} value={c.id}>{c.name}{c.mc_number ? ` · MC ${c.mc_number}` : ""}</option>)}
            </select>
            {carrier && ins === "expired" && <div style={{ fontSize:12, color:"#B91C1C", marginTop:4, fontWeight:600 }}>Insurance expired: this carrier can't be dispatched.</div>}
            {carrier && ins === "soon" && <div style={{ fontSize:12, color:"#C2410C", marginTop:4 }}>{tr(`Insurance expires ${shortDate(carrier.insurance_expires)}.`, `El seguro vence el ${shortDate(carrier.insurance_expires)}.`)}</div>}
            {carrier && ins === "unknown" && <div style={{ fontSize:12, color:"#C2410C", marginTop:4 }}>No insurance date on file.</div>}
          </Field>
          <Field label="Rate type">
            <div style={{ display:"flex", gap:6 }}>
              <button type="button" onClick={() => set("rate_type", "per_cf")} style={pillBtn(form.rate_type === "per_cf")}>Per CF</button>
              <button type="button" onClick={() => set("rate_type", "flat")} style={pillBtn(form.rate_type === "flat")}>Flat</button>
            </div>
          </Field>
          <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
            {form.rate_type === "per_cf"
              ? <Field label="Rate per CF"><input type="number" step="0.01" value={form.rate_per_cf} onChange={(e) => set("rate_per_cf", e.target.value)} style={inp} /></Field>
              : <Field label="Flat rate"><input type="number" step="1" value={form.flat_rate} onChange={(e) => set("flat_rate", e.target.value)} style={inp} /></Field>}
            <Field label="Estimated CF"><input type="number" value={form.est_cf} onChange={(e) => set("est_cf", e.target.value)} style={inp} /></Field>
            <Field label="Collect from customer"><input type="number" step="0.01" value={form.expected_collect} onChange={(e) => set("expected_collect", e.target.value)} style={inp} /></Field>
            <Field label="Carrier extras"><input type="number" step="1" value={form.carrier_extras} onChange={(e) => set("carrier_extras", e.target.value)} style={inp} placeholder="Shuttle, long carry…" /></Field>
          </div>
          <Field label="Send by">
            <div style={{ display:"flex", gap:14, fontSize:13 }}>
              <label style={{ display:"flex", gap:6, alignItems:"center" }}><input type="checkbox" checked={form.email} onChange={(e) => set("email", e.target.checked)} />Email</label>
              <label style={{ display:"flex", gap:6, alignItems:"center" }}><input type="checkbox" checked={form.whatsapp} onChange={(e) => set("whatsapp", e.target.checked)} />WhatsApp</label>
            </div>
          </Field>
          <Field label="Notes for the carrier"><textarea rows={2} value={form.notes} onChange={(e) => set("notes", e.target.value)} style={{ ...inp, resize:"vertical" }} /></Field>
        </div>
        <div style={{ display:"grid", gap:10, alignContent:"start" }}>
          <div style={{ ...card, background:"#FAFAFA", padding:14 }}>
            <span style={fieldLabel}>How it works out</span>
            {[
              ["Carrier's pay (estimate)", fmt$(pay)],
              ["Carrier collects", fmt$(num(form.expected_collect))],
              [owes >= 0 ? "Carrier will owe us" : "We will owe the carrier", fmt$(Math.abs(owes))],
            ].map(([k, v], i) => (
              <div key={i} style={{ display:"flex", justifyContent:"space-between", padding:"6px 0", borderBottom:"1px dashed #eee", fontSize:12.5 }}>
                <span style={{ color:"#888" }}>{k}</span><b style={{ color: i === 2 ? (owes >= 0 ? "#1A8A4E" : "#B91C1C") : "#111" }}>{v}</b>
              </div>
            ))}
            <div style={{ fontSize:11, color:"#aaa", marginTop:6 }}>Recalculated on the final CF when the documents come back.</div>
          </div>
          {carrier && form.email && (
            <div style={{ ...card, padding:14 }}>
              <span style={fieldLabel}>Email preview</span>
              <div style={{ fontSize:12.5, fontWeight:600 }}>{preview}</div>
              <div style={{ fontSize:11.5, color:"#888", marginTop:4 }}>{tr(`To: ${emails.join(", ") || "—"} · with the rate confirmation PDF`, `Para: ${emails.join(", ") || "—"} · con el rate confirmation en PDF`)}</div>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

/** "Carrier" card in the job detail (Money tab): dispatch the job, or follow its dispatch. */
export function CarrierDispatchCard({ supabase, session, can = () => true, Btn, Modal, job, repId, outstanding = 0, carriers = [], dispatches = [], missing, onChanged, onOpenCarriers, logNote, cardStyle, capStyle }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const userEmail = session?.user?.email || null;
  const d = liveDispatchFor(job.job_number, dispatches);
  const carrier = d ? carriers.find((c) => c.id === d.carrier_id) : null;
  const canCreate = can("carriers", "create"), canEdit = can("carriers", "edit");
  const cardS = cardStyle || { ...card, padding:14 };
  const capS = capStyle || fieldLabel;
  if (missing || !job.job_number) return null;

  async function setStatus(status, extra = {}) {
    setBusy(true);
    const ok = !dbFailed(await supabase.from("carrier_dispatches").update({ status, ...extra, updated_by: userEmail, updated_at: nowISO() }).eq("id", d.id), "carrier_dispatches");
    setBusy(false);
    if (ok) onChanged?.();
  }
  async function cancel() {
    if (!window.confirm(tr(`Cancel dispatch D${d.id} to ${carrier?.name || "the carrier"}? Tell the carrier yourself.`, `¿Cancelar el despacho D${d.id} a ${carrier?.name || "el carrier"}? Avisale vos al carrier.`))) return;
    await setStatus("cancelled");
    logNote?.(repId, tr(`Dispatch D${d.id} cancelled`, `Despacho D${d.id} cancelado`));
  }
  async function resend() {
    const emails = carrierEmails(carrier);
    if (!emails.length) { window.alert(tr("This carrier has no email on file.", "Este carrier no tiene mail cargado.")); return; }
    setBusy(true);
    const e = buildDispatchEmail({ dispatch: d, job, carrier });
    const att = d.ratecon_path ? [{ path: d.ratecon_path, name: `RateCon_${String(job.job_number).replace(/[^\w.-]+/g, "_")}.pdf`, mime: "application/pdf" }] : [];
    const ok = !dbFailed(await supabase.from("carrier_messages").insert([{ dispatch_id: d.id, carrier_id: carrier.id, direction: "out", channel: "email", status: "queued", to_addr: emails.join(", "), subject: e.subject, body_text: e.text, body_html: e.html, attachments: att, created_by: userEmail }]), "carrier_messages");
    setBusy(false);
    if (ok) window.alert(tr("Queued: it goes out from dispatch@ within 5 minutes.", "En cola: sale desde dispatch@ en menos de 5 minutos."));
  }
  function whatsapp() {
    const wa = waNumber(carrier?.whatsapp);
    if (!wa) { window.alert(tr("This carrier has no WhatsApp number on file.", "Este carrier no tiene WhatsApp cargado.")); return; }
    window.open(`https://wa.me/${wa}?text=${encodeURIComponent(buildDispatchWhatsApp({ dispatch: d, job }))}`, "_blank", "noopener");
  }

  const done = d && (d.status === "verified");
  return (
    <div style={cardS}>
      <div style={{ ...capS, display:"flex", justifyContent:"space-between", alignItems:"center" }}>
        <span>Carrier</span>{d && <StatusPill status={d.status} />}
      </div>
      {!d && (
        <div>
          <div style={{ fontSize:12.5, color:"#777", margin:"4px 0 10px" }}>This job hasn't been given to an outside carrier.</div>
          {canCreate && <Btn primary onClick={() => setOpen(true)}>🚛 Dispatch to carrier</Btn>}
        </div>
      )}
      {d && (
        <div style={{ fontSize:12.5 }}>
          {[
            ["Carrier", carrier?.name || "—"],
            ["Rate", d.rate_type === "flat" ? `${fmt$(num(d.flat_rate))} flat` : `${rate$(d.rate_per_cf)} / CF`],
            ["CF", done ? `${num(d.final_cf).toLocaleString()} (est. ${num(d.est_cf).toLocaleString()})` : `${num(d.est_cf).toLocaleString()} est.`],
            ["To collect", fmt$(num(d.expected_collect))],
            done ? ["Collected", `${fmt$(num(d.collected))}${d.collected_method ? ` · ${METHOD_LABEL[d.collected_method] || d.collected_method}` : ""}`] : ["Carrier's pay (estimate)", fmt$(estimatedPay(d))],
          ].map(([k, v], i) => (
            <div key={i} style={{ display:"flex", justifyContent:"space-between", gap:10, padding:"5px 0", borderBottom:"1px dashed #f0f0f0" }}>
              <span style={{ color:"#999" }}>{k}</span><b style={{ textAlign:"right" }}>{v}</b>
            </div>
          ))}
          {done && <div style={{ display:"flex", justifyContent:"space-between", padding:"6px 0" }}><span style={{ color:"#999" }}>Net</span><Verdict value={dispatchNet(d)} /></div>}
          <div style={{ fontSize:11, color:"#aaa", marginTop:6 }}>
            {[d.sent_at && tr(`Sent ${shortDate(d.sent_at)}`, `Enviado ${shortDate(d.sent_at)}`), d.accepted_at && tr(`accepted ${shortDate(d.accepted_at)}`, `aceptado ${shortDate(d.accepted_at)}`), d.verified_at && tr(`verified ${shortDate(d.verified_at)}`, `verificado ${shortDate(d.verified_at)}`)].filter(Boolean).join(" · ") || tr(`Dispatch D${d.id}`, `Despacho D${d.id}`)}
          </div>
          <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:10 }}>
            {canEdit && d.status === "sent" && <Btn disabled={busy} onClick={() => setStatus("accepted", { accepted_at: nowISO() })} style={{ padding:"5px 10px", fontSize:12 }}>Mark accepted</Btn>}
            {canEdit && ["sent", "accepted"].includes(d.status) && <Btn disabled={busy} onClick={() => setStatus("in_progress")} style={{ padding:"5px 10px", fontSize:12 }}>Mark in progress</Btn>}
            {canEdit && OPEN_STATUSES.includes(d.status) && <Btn disabled={busy} onClick={resend} style={{ padding:"5px 10px", fontSize:12 }}>Resend email</Btn>}
            {OPEN_STATUSES.includes(d.status) && <Btn onClick={whatsapp} style={{ padding:"5px 10px", fontSize:12 }}>WhatsApp</Btn>}
            {onOpenCarriers && <Btn onClick={onOpenCarriers} style={{ padding:"5px 10px", fontSize:12 }}>Open in Carriers</Btn>}
            {canEdit && OPEN_STATUSES.includes(d.status) && <Btn danger disabled={busy} onClick={cancel} style={{ padding:"5px 10px", fontSize:12 }}>Cancel</Btn>}
          </div>
        </div>
      )}
      {open && <DispatchModal supabase={supabase} session={session} job={job} repId={repId} outstanding={outstanding} carriers={carriers}
        Btn={Btn} Modal={Modal} logNote={logNote} onClose={() => setOpen(false)} onDone={() => { setOpen(false); onChanged?.(); }} />}
    </div>
  );
}

// ── The section ──────────────────────────────────────────────────────────────

const EMPTY_CARRIER = { name:"", legal_name:"", mc_number:"", dot_number:"", contact_name:"", email:"", whatsapp:"", phone:"", insurance_expires:"", default_rate_per_cf:"", payment_terms:"", notes:"", active:true };
const EMPTY_PAY = { carrier_id:"", direction:"in", amount:"", method:"zelle", paid_date:"", reference:"", notes:"" };
const EMPTY_ADJ = { carrier_id:"", dispatch_id:"", amount:"", reason:"", notes:"" };

export function CarriersSection({
  supabase, session, can = () => true, Btn, Modal,
  jobs = [], carriers = [], dispatches = [], missing = false,
  reloadCarriers, reloadDispatches, onOpenJob, onMarkJobDelivered,
}) {
  const userEmail = session?.user?.email || null;
  const canEdit = can("carriers", "edit"), canCreate = can("carriers", "create");
  const today = todayISO();
  const [messages, setMessages] = useState([]);
  const [payments, setPayments] = useState([]);
  const [adjustments, setAdjustments] = useState([]);
  const [tab, setTab] = useState("balances");
  const [carrierFilter, setCarrierFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("open");
  const [carrierForm, setCarrierForm] = useState(null);   // {…} when the modal is open
  const [payForm, setPayForm] = useState(null);
  const [adjForm, setAdjForm] = useState(null);
  const [saving, setSaving] = useState(false);

  const loadMessages = useCallback(async () => {
    const { data, error } = await selectAll(() => supabase.from("carrier_messages").select("*").in("status", ["review", "unmatched"]));
    if (!error) setMessages((data || []).filter(notDel));
  }, [supabase]);
  const loadMoney = useCallback(async () => {
    const [p, a] = await Promise.all([
      selectAll(() => supabase.from("carrier_payments").select("*")),
      selectAll(() => supabase.from("carrier_adjustments").select("*")),
    ]);
    if (!p.error) setPayments((p.data || []).filter(notDel));
    if (!a.error) setAdjustments((a.data || []).filter(notDel));
  }, [supabase]);
  useEffect(() => { if (!missing) { loadMessages(); loadMoney(); } }, [missing, loadMessages, loadMoney]);
  useEffect(() => {
    if (missing) return;
    const ch = supabase.channel("carriers-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "carrier_messages" }, () => loadMessages())
      .on("postgres_changes", { event: "*", schema: "public", table: "carrier_payments" }, () => loadMoney())
      .on("postgres_changes", { event: "*", schema: "public", table: "carrier_adjustments" }, () => loadMoney())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [supabase, missing, loadMessages, loadMoney]);

  const liveCarriers = useMemo(() => carriers.filter(notDel), [carriers]);
  const liveDispatches = useMemo(() => dispatches.filter(notDel), [dispatches]);
  const carrierById = useMemo(() => Object.fromEntries(liveCarriers.map((c) => [c.id, c])), [liveCarriers]);
  const jobByKey = useMemo(() => { const m = {}; for (const j of jobs) { const k = jobKeyOf(j.job_number); if (j.job_number && !m[k]) m[k] = j; } return m; }, [jobs]);
  const balances = useMemo(() => carrierBalances({ carriers: liveCarriers, dispatches: liveDispatches, payments, adjustments }), [liveCarriers, liveDispatches, payments, adjustments]);
  const kpis = useMemo(() => carrierKpis(balances), [balances]);
  const review = useMemo(() => messages.filter((m) => m.direction === "in" && ["review", "unmatched"].includes(m.status)).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))), [messages]);

  if (missing) {
    return (
      <div style={{ background:"#FFF7ED", border:"1px solid #FED7AA", borderRadius:12, padding:20, fontSize:13.5, color:"#9A3412" }}>
        <b>The Carriers module is not installed in the database yet.</b>
        <div style={{ marginTop:6 }}>Run the migration and reload:</div>
        <pre style={{ background:"#fff", border:"1px solid #eee", borderRadius:8, padding:10, fontSize:12, marginTop:8 }}>SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-carriers.mjs</pre>
      </div>
    );
  }

  // ── Writes ──
  async function saveCarrier() {
    const f = carrierForm;
    if (!f.name.trim()) { window.alert(tr("The carrier needs a name.", "El carrier necesita un nombre.")); return; }
    setSaving(true);
    const row = {
      name: f.name.trim(), legal_name: f.legal_name || null, mc_number: f.mc_number || null, dot_number: f.dot_number || null,
      contact_name: f.contact_name || null, email: f.email || null, whatsapp: f.whatsapp || null, phone: f.phone || null,
      insurance_expires: f.insurance_expires || null, default_rate_per_cf: f.default_rate_per_cf === "" ? null : num(f.default_rate_per_cf),
      payment_terms: f.payment_terms || null, notes: f.notes || null, active: f.active !== false,
    };
    const res = f.id
      ? await supabase.from("carriers").update({ ...row, updated_by: userEmail, updated_at: nowISO() }).eq("id", f.id)
      : await supabase.from("carriers").insert([{ ...row, created_by: userEmail }]);
    setSaving(false);
    if (dbFailed(res, "carriers")) return;
    setCarrierForm(null); reloadCarriers?.();
  }
  async function deleteCarrier(c) {
    if (liveDispatches.some((d) => d.carrier_id === c.id && OPEN_STATUSES.includes(d.status))) { window.alert(tr("This carrier has open dispatches. Deactivate it instead.", "Este carrier tiene despachos abiertos. Desactivalo en vez de borrarlo.")); return; }
    if (!window.confirm(tr(`Delete ${c.name}? It goes to the Trash.`, `¿Borrar ${c.name}? Va a la papelera.`))) return;
    if (dbFailed(await supabase.from("carriers").update({ deleted_at: nowISO(), updated_by: userEmail }).eq("id", c.id), "carriers")) return;
    reloadCarriers?.();
  }
  async function savePayment() {
    const f = payForm;
    if (!f.carrier_id || !(num(f.amount) > 0)) { window.alert(tr("Choose the carrier and the amount.", "Elegí el carrier y el monto.")); return; }
    setSaving(true);
    const res = await supabase.from("carrier_payments").insert([{ carrier_id: Number(f.carrier_id), direction: f.direction, amount: num(f.amount), method: f.method || null, paid_date: f.paid_date || today, reference: f.reference || null, notes: f.notes || null, created_by: userEmail }]);
    setSaving(false);
    if (dbFailed(res, "carrier_payments")) return;
    setPayForm(null); loadMoney();
  }
  async function saveAdjustment() {
    const f = adjForm;
    if (!f.carrier_id || !num(f.amount)) { window.alert(tr("Choose the carrier and the amount.", "Elegí el carrier y el monto.")); return; }
    setSaving(true);
    const res = await supabase.from("carrier_adjustments").insert([{ carrier_id: Number(f.carrier_id), dispatch_id: f.dispatch_id ? Number(f.dispatch_id) : null, amount: num(f.amount), reason: f.reason || null, notes: f.notes || null, created_by: userEmail }]);
    setSaving(false);
    if (dbFailed(res, "carrier_adjustments")) return;
    setAdjForm(null); loadMoney();
  }
  async function deleteMoneyRow(table, r) {
    if (!window.confirm(tr("Delete this entry? It goes to the Trash.", "¿Borrar este movimiento? Va a la papelera."))) return;
    if (dbFailed(await supabase.from(table).update({ deleted_at: nowISO(), updated_by: userEmail }).eq("id", r.id), table)) return;
    loadMoney();
  }

  const showCarrier = (id) => { setCarrierFilter(String(id)); setStatusFilter("all"); setTab("dispatches"); };
  const TABS = [["balances", "Balances"], ["dispatches", "Dispatches"], ["review", "Docs to review"], ["money", "Payments & adjustments"], ["carriers", "Carriers"]];

  return (
    <div>
      <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(150px, 1fr))", gap:10, marginBottom:14 }}>
        <Tile label="Carriers owe us" value={fmt$(kpis.owe)} color="#1A8A4E" sub="verified jobs, net of payments" />
        <Tile label="We owe carriers" value={fmt$(kpis.weOwe)} color="#B91C1C" sub="when they collected less than their pay" />
        <Tile label="Net in our favor" value={fmt$(kpis.net)} color={kpis.net >= 0 ? "#1A8A4E" : "#B91C1C"} />
        <Tile label="Jobs in progress" value={kpis.active} sub="sent, accepted, on the road" />
        <Tile label="Docs to review" value={review.length} color="#6D28D9" sub="read by the AI" />
      </div>

      <div style={{ display:"flex", gap:6, marginBottom:12, flexWrap:"wrap", alignItems:"center" }}>
        {TABS.map(([v, l]) => (
          <button key={v} onClick={() => setTab(v)} style={pillBtn(tab === v)}>
            {l}{v === "review" && review.length > 0 && <span style={{ marginLeft:6, background:"#6D28D9", color:"#fff", borderRadius:20, padding:"0 6px", fontSize:11 }}>{review.length}</span>}
          </button>
        ))}
        <span style={{ flex:1 }} />
        {tab === "money" && canCreate && <><Btn onClick={() => setAdjForm({ ...EMPTY_ADJ })}>+ Adjustment</Btn><Btn primary onClick={() => setPayForm({ ...EMPTY_PAY, paid_date: today })}>+ Payment</Btn></>}
        {tab === "carriers" && canCreate && <Btn primary onClick={() => setCarrierForm({ ...EMPTY_CARRIER })}>+ Carrier</Btn>}
      </div>

      {tab === "balances" && (
        <div style={{ ...card, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:820 }}>
            <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}>
              <th style={th}>Carrier</th><th style={{ ...th, textAlign:"right" }}>In progress</th><th style={{ ...th, textAlign:"right" }}>Verified</th>
              <th style={{ ...th, textAlign:"right" }}>To review</th><th style={{ ...th, textAlign:"right" }}>Jobs net</th><th style={{ ...th, textAlign:"right" }}>Adjustments</th>
              <th style={{ ...th, textAlign:"right" }}>Payments</th><th style={{ ...th, textAlign:"right" }}>Balance</th><th style={{ ...th, textAlign:"right" }}>Oldest</th>
            </tr></thead>
            <tbody>
              {balances.filter((b) => carrierById[b.carrierId]).sort((a, b) => Math.abs(b.balance) - Math.abs(a.balance)).map((b) => (
                <tr key={b.carrierId} onClick={() => showCarrier(b.carrierId)} style={{ borderBottom:"1px solid #f6f6f6", cursor:"pointer" }}>
                  <td style={td}><b>{carrierById[b.carrierId].name}</b>{carrierById[b.carrierId].mc_number && <div style={{ fontSize:11, color:"#aaa" }}>MC {carrierById[b.carrierId].mc_number}</div>}</td>
                  <td style={{ ...td, textAlign:"right" }}>{b.active}</td>
                  <td style={{ ...td, textAlign:"right" }}>{b.verified}</td>
                  <td style={{ ...td, textAlign:"right", color: b.review ? "#6D28D9" : "#bbb", fontWeight: b.review ? 700 : 400 }}>{b.review}</td>
                  <td style={{ ...td, textAlign:"right" }}>{fmtSigned(b.jobsNet)}</td>
                  <td style={{ ...td, textAlign:"right", color:"#888" }}>{b.adjustments ? fmtSigned(b.adjustments) : "—"}</td>
                  <td style={{ ...td, textAlign:"right", color:"#888" }}>{b.paidIn || b.paidOut ? fmtSigned(b.paidOut - b.paidIn) : "—"}</td>
                  <td style={{ ...td, textAlign:"right" }}><Verdict value={b.balance} /></td>
                  <td style={{ ...td, textAlign:"right", color:"#999" }}>{b.oldest ? shortDate(b.oldest) : "—"}</td>
                </tr>
              ))}
              {!balances.length && <tr><td colSpan={9} style={{ ...td, textAlign:"center", color:"#bbb", padding:28 }}>No carriers yet. Add them in the Carriers tab, then dispatch a job from its detail.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {tab === "dispatches" && (() => {
        const rows = liveDispatches
          .filter((d) => !carrierFilter || String(d.carrier_id) === carrierFilter)
          .filter((d) => statusFilter === "all" ? true : statusFilter === "open" ? OPEN_STATUSES.includes(d.status) : d.status === statusFilter)
          .sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")));
        return (
          <div style={card}>
            <div style={{ display:"flex", gap:8, padding:"12px 12px 0", flexWrap:"wrap" }}>
              <select value={carrierFilter} onChange={(e) => setCarrierFilter(e.target.value)} style={{ ...inp, width:"auto", fontSize:12 }}>
                <option value="">All carriers</option>
                {liveCarriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
              <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)} style={{ ...inp, width:"auto", fontSize:12 }}>
                <option value="open">Open</option>
                <option value="all">All</option>
                {Object.entries(STATUS_META).map(([k, m]) => <option key={k} value={k}>{m.label}</option>)}
              </select>
            </div>
            <div style={{ overflowX:"auto", marginTop:10 }}>
              <table style={{ width:"100%", borderCollapse:"collapse", minWidth:1040 }}>
                <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}>
                  <th style={th}>Job</th><th style={th}>Customer</th><th style={th}>Carrier</th><th style={th}>Route</th>
                  <th style={{ ...th, textAlign:"right" }}>CF</th><th style={{ ...th, textAlign:"right" }}>Rate</th><th style={{ ...th, textAlign:"right" }}>Carrier's pay</th>
                  <th style={{ ...th, textAlign:"right" }}>Collected</th><th style={{ ...th, textAlign:"right" }}>Net</th><th style={th}>Status</th>
                </tr></thead>
                <tbody>
                  {rows.map((d) => {
                    const j = jobByKey[jobKeyOf(d.job_number)] || {};
                    const done = d.status === "verified";
                    const alerts = dispatchAlerts(d, { today, now: nowISO() });
                    const route = [[j.pickup_city, j.pickup_state].filter(Boolean).join(", "), [j.delivery_city, j.delivery_state].filter(Boolean).join(", ")].filter(Boolean).join(" → ");
                    return (
                      <tr key={d.id} style={{ borderBottom:"1px solid #f6f6f6" }}>
                        <td style={td}><button onClick={() => onOpenJob?.(jobKeyOf(d.job_number))} style={{ ...linkBtn, fontFamily:"monospace", fontWeight:700, textDecoration:"none" }}>{d.job_number}</button><div style={{ fontSize:10.5, color:"#bbb" }}>D{d.id}</div></td>
                        <td style={td}>{j.customer || "—"}</td>
                        <td style={td}>{carrierById[d.carrier_id]?.name || "—"}</td>
                        <td style={{ ...td, color:"#666" }}>{route || "—"}</td>
                        <td style={{ ...td, textAlign:"right" }}>{done ? num(d.final_cf).toLocaleString() : <span style={{ color:"#aaa" }}>{num(d.est_cf).toLocaleString()} est.</span>}</td>
                        <td style={{ ...td, textAlign:"right" }}>{d.rate_type === "flat" ? fmt$(num(d.flat_rate)) : rate$(d.rate_per_cf)}</td>
                        <td style={{ ...td, textAlign:"right" }}>{done ? fmt$(carrierPay(d)) : <span style={{ color:"#aaa" }}>≈ {fmt$(estimatedPay(d))}</span>}</td>
                        <td style={{ ...td, textAlign:"right" }}>{done ? fmt$(num(d.collected)) : <span style={{ color:"#aaa" }}>{tr(`${fmt$(num(d.expected_collect))} to collect`, `${fmt$(num(d.expected_collect))} a cobrar`)}</span>}</td>
                        <td style={{ ...td, textAlign:"right", fontWeight:700, color: !done ? "#bbb" : dispatchNet(d) >= 0 ? "#1A8A4E" : "#B91C1C" }}>{done ? fmtSigned(dispatchNet(d)) : "—"}</td>
                        <td style={td}><StatusPill status={d.status} />{alerts.map((a, i) => <div key={i} style={{ fontSize:10.5, color:"#C2410C", marginTop:3 }}>{alertText(a)}</div>)}</td>
                      </tr>
                    );
                  })}
                  {!rows.length && <tr><td colSpan={10} style={{ ...td, textAlign:"center", color:"#bbb", padding:28 }}>No dispatches here.</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {tab === "review" && (
        <div style={{ display:"grid", gap:12 }}>
          {review.map((m) => <ReviewCard key={m.id} m={m} supabase={supabase} userEmail={userEmail} canEdit={canEdit} Btn={Btn}
            carrier={carrierById[m.carrier_id]} dispatches={liveDispatches.filter((d) => d.carrier_id === m.carrier_id && d.status !== "cancelled")}
            onDone={() => { loadMessages(); reloadDispatches?.(); }} onMarkJobDelivered={onMarkJobDelivered} />)}
          {!review.length && <div style={{ ...card, padding:28, textAlign:"center", color:"#bbb", fontSize:13 }}>Nothing to review. When a carrier sends back the BOL, it shows up here with what the AI read.</div>}
        </div>
      )}

      {tab === "money" && (() => {
        const rows = [
          ...payments.map((p) => ({ kind:"payment", table:"carrier_payments", r:p, date:p.paid_date, effect: p.direction === "out" ? num(p.amount) : -num(p.amount), label: p.direction === "out" ? "We paid the carrier" : "The carrier paid us", detail:[METHOD_LABEL[p.method] || p.method, p.reference, p.notes].filter(Boolean).join(" · ") })),
          ...adjustments.map((a) => ({ kind:"adj", table:"carrier_adjustments", r:a, date:a.adj_date || String(a.created_at || "").slice(0, 10), effect: num(a.amount), label:"Adjustment", detail:[a.reason, a.notes].filter(Boolean).join(" · ") })),
        ].sort((a, b) => String(b.date).localeCompare(String(a.date)));
        return (
          <div style={{ ...card, overflowX:"auto" }}>
            <table style={{ width:"100%", borderCollapse:"collapse", minWidth:760 }}>
              <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}><th style={th}>Date</th><th style={th}>Carrier</th><th style={th}>Type</th><th style={th}>Detail</th><th style={{ ...th, textAlign:"right" }}>Effect on balance</th><th style={th}></th></tr></thead>
              <tbody>
                {rows.map((x) => (
                  <tr key={x.table + x.r.id} style={{ borderBottom:"1px solid #f6f6f6" }}>
                    <td style={td}>{shortDate(x.date)}</td>
                    <td style={td}>{carrierById[x.r.carrier_id]?.name || "—"}</td>
                    <td style={td}>{x.label}</td>
                    <td style={{ ...td, color:"#666" }}>{x.detail || "—"}</td>
                    <td style={{ ...td, textAlign:"right", fontWeight:700, color: x.effect >= 0 ? "#1A8A4E" : "#B91C1C" }}>{fmtSigned(x.effect)}</td>
                    <td style={{ ...td, textAlign:"right" }}>{canEdit && <button onClick={() => deleteMoneyRow(x.table, x.r)} style={{ ...linkBtn, color:"#B91C1C" }}>Delete</button>}</td>
                  </tr>
                ))}
                {!rows.length && <tr><td colSpan={6} style={{ ...td, textAlign:"center", color:"#bbb", padding:28 }}>No payments or adjustments yet.</td></tr>}
              </tbody>
            </table>
            <div style={{ fontSize:11.5, color:"#999", padding:"10px 12px" }}>A payment from the carrier lowers what it owes us. A positive adjustment (a claim charged to the carrier) raises it.</div>
          </div>
        );
      })()}

      {tab === "carriers" && (
        <div style={{ ...card, overflowX:"auto" }}>
          <table style={{ width:"100%", borderCollapse:"collapse", minWidth:860 }}>
            <thead><tr style={{ borderBottom:"1px solid #f0f0f0" }}><th style={th}>Carrier</th><th style={th}>MC / DOT</th><th style={th}>Email</th><th style={th}>WhatsApp</th><th style={th}>Insurance</th><th style={{ ...th, textAlign:"right" }}>Default rate</th><th style={th}></th></tr></thead>
            <tbody>
              {liveCarriers.sort((a, b) => String(a.name).localeCompare(String(b.name))).map((c) => {
                const ins = insuranceStatus(c, today);
                const insColor = ins === "expired" ? "#B91C1C" : ins === "soon" ? "#C2410C" : ins === "ok" ? "#1A8A4E" : "#aaa";
                return (
                  <tr key={c.id} style={{ borderBottom:"1px solid #f6f6f6", opacity: c.active === false ? 0.5 : 1 }}>
                    <td style={td}><b>{c.name}</b>{c.contact_name && <div style={{ fontSize:11, color:"#999" }}>{c.contact_name}</div>}</td>
                    <td style={{ ...td, fontFamily:"monospace", fontSize:12 }}>{[c.mc_number && `MC ${c.mc_number}`, c.dot_number && `DOT ${c.dot_number}`].filter(Boolean).join(" · ") || "—"}</td>
                    <td style={{ ...td, color:"#666" }}>{carrierEmails(c).join(", ") || "—"}</td>
                    <td style={td}>{c.whatsapp || "—"}</td>
                    <td style={{ ...td, color: insColor, fontWeight:600 }}>{c.insurance_expires ? shortDate(c.insurance_expires) : "—"}{ins === "expired" && tr(" · expired", " · vencido")}</td>
                    <td style={{ ...td, textAlign:"right" }}>{c.default_rate_per_cf != null ? `${rate$(c.default_rate_per_cf)} / CF` : "—"}</td>
                    <td style={{ ...td, textAlign:"right", whiteSpace:"nowrap" }}>
                      {canEdit && <button onClick={() => setCarrierForm({ ...EMPTY_CARRIER, ...Object.fromEntries(Object.entries(c).map(([k, v]) => [k, v ?? ""])) })} style={linkBtn}>Edit</button>}
                      {canEdit && <button onClick={() => deleteCarrier(c)} style={{ ...linkBtn, color:"#B91C1C", marginLeft:10 }}>Delete</button>}
                    </td>
                  </tr>
                );
              })}
              {!liveCarriers.length && <tr><td colSpan={7} style={{ ...td, textAlign:"center", color:"#bbb", padding:28 }}>No carriers yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}

      {carrierForm && (
        <Modal title={carrierForm.id ? tr(`Edit ${carrierForm.name}`, `Editar ${carrierForm.name}`) : "New carrier"} onClose={() => setCarrierForm(null)}
          footer={<><Btn onClick={() => setCarrierForm(null)}>Cancel</Btn><Btn primary disabled={saving} onClick={saveCarrier}>{saving ? "Saving…" : "Save carrier"}</Btn></>}>
          {(() => { const f = carrierForm; const set = (k, v) => setCarrierForm((x) => ({ ...x, [k]: v })); return (
            <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:"0 12px" }}>
              <Field label="Name"><input value={f.name} onChange={(e) => set("name", e.target.value)} style={inp} /></Field>
              <Field label="Contact"><input value={f.contact_name} onChange={(e) => set("contact_name", e.target.value)} style={inp} /></Field>
              <Field label="MC #"><input value={f.mc_number} onChange={(e) => set("mc_number", e.target.value)} style={inp} /></Field>
              <Field label="DOT #"><input value={f.dot_number} onChange={(e) => set("dot_number", e.target.value)} style={inp} /></Field>
              <Field label="Email(s)" style={{ gridColumn:"1 / -1" }}><input value={f.email} onChange={(e) => set("email", e.target.value)} style={inp} placeholder="ops@carrier.com, dispatcher@carrier.com" />
                <div style={{ fontSize:11, color:"#aaa", marginTop:3 }}>Replies from these addresses (or their company domain) are read automatically.</div></Field>
              <Field label="WhatsApp"><input value={f.whatsapp} onChange={(e) => set("whatsapp", e.target.value)} style={inp} placeholder="(312) 555-0199" /></Field>
              <Field label="Insurance expires"><input type="date" value={String(f.insurance_expires || "").slice(0, 10)} onChange={(e) => set("insurance_expires", e.target.value)} style={inp} /></Field>
              <Field label="Default rate per CF"><input type="number" step="0.01" value={f.default_rate_per_cf} onChange={(e) => set("default_rate_per_cf", e.target.value)} style={inp} /></Field>
              <Field label="Payment terms"><input value={f.payment_terms} onChange={(e) => set("payment_terms", e.target.value)} style={inp} placeholder="Weekly" /></Field>
              <Field label="Notes" style={{ gridColumn:"1 / -1" }}><textarea rows={2} value={f.notes} onChange={(e) => set("notes", e.target.value)} style={{ ...inp, resize:"vertical" }} /></Field>
              <label style={{ display:"flex", gap:6, alignItems:"center", fontSize:13 }}><input type="checkbox" checked={f.active !== false} onChange={(e) => set("active", e.target.checked)} />Active</label>
            </div>
          ); })()}
        </Modal>
      )}

      {payForm && (
        <Modal title="Record a carrier payment" onClose={() => setPayForm(null)}
          footer={<><Btn onClick={() => setPayForm(null)}>Cancel</Btn><Btn primary disabled={saving} onClick={savePayment}>{saving ? "Saving…" : "Record payment"}</Btn></>}>
          {(() => { const f = payForm; const set = (k, v) => setPayForm((x) => ({ ...x, [k]: v })); const b = balances.find((x) => String(x.carrierId) === String(f.carrier_id)); return (
            <div>
              <Field label="Carrier"><select value={f.carrier_id} onChange={(e) => set("carrier_id", e.target.value)} style={inp}><option value="">Choose…</option>{liveCarriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Direction"><div style={{ display:"flex", gap:6 }}>
                <button type="button" onClick={() => set("direction", "in")} style={pillBtn(f.direction === "in")}>The carrier paid us</button>
                <button type="button" onClick={() => set("direction", "out")} style={pillBtn(f.direction === "out")}>We paid the carrier</button>
              </div></Field>
              <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                <Field label="Amount"><input type="number" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} style={inp} /></Field>
                <Field label="Method"><select value={f.method} onChange={(e) => set("method", e.target.value)} style={inp}>{PAYMENT_METHODS.map((m) => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}</select></Field>
                <Field label="Date"><input type="date" value={f.paid_date} onChange={(e) => set("paid_date", e.target.value)} style={inp} /></Field>
              </div>
              <Field label="Reference"><input value={f.reference} onChange={(e) => set("reference", e.target.value)} style={inp} placeholder="Zelle / ACH / check number" /></Field>
              <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} style={inp} /></Field>
              {b && <div style={{ ...card, background:"#FAFAFA", padding:12, fontSize:12.5, display:"flex", justifyContent:"space-between", gap:10, flexWrap:"wrap" }}>
                <span>Current balance <Verdict value={b.balance} /></span>
                <span>After this payment <Verdict value={b.balance + (f.direction === "out" ? num(f.amount) : -num(f.amount))} /></span>
              </div>}
            </div>
          ); })()}
        </Modal>
      )}

      {adjForm && (
        <Modal title="Record an adjustment" onClose={() => setAdjForm(null)}
          footer={<><Btn onClick={() => setAdjForm(null)}>Cancel</Btn><Btn primary disabled={saving} onClick={saveAdjustment}>{saving ? "Saving…" : "Save adjustment"}</Btn></>}>
          {(() => { const f = adjForm; const set = (k, v) => setAdjForm((x) => ({ ...x, [k]: v })); return (
            <div>
              <Field label="Carrier"><select value={f.carrier_id} onChange={(e) => set("carrier_id", e.target.value)} style={inp}><option value="">Choose…</option>{liveCarriers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field>
              <Field label="Job (optional)"><select value={f.dispatch_id} onChange={(e) => set("dispatch_id", e.target.value)} style={inp}><option value="">—</option>{liveDispatches.filter((d) => String(d.carrier_id) === String(f.carrier_id)).map((d) => <option key={d.id} value={d.id}>{`${d.job_number} · D${d.id}`}</option>)}</select></Field>
              <Field label="Amount"><input type="number" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} style={inp} />
                <div style={{ fontSize:11, color:"#aaa", marginTop:3 }}>Positive: the carrier owes us more (a claim on them). Negative: we owe them more.</div></Field>
              <Field label="Reason"><input value={f.reason} onChange={(e) => set("reason", e.target.value)} style={inp} placeholder="Claim, damage, pads, cancellation…" /></Field>
              <Field label="Notes"><input value={f.notes} onChange={(e) => set("notes", e.target.value)} style={inp} /></Field>
            </div>
          ); })()}
        </Modal>
      )}
    </div>
  );
}

// One document waiting for a person: what the AI read, next to the files.
function ReviewCard({ m, supabase, userEmail, canEdit, Btn, carrier, dispatches, onDone, onMarkJobDelivered }) {
  const x = m.extraction || {};
  const [dispatchId, setDispatchId] = useState(m.dispatch_id ? String(m.dispatch_id) : "");
  const d = dispatches.find((y) => String(y.id) === dispatchId) || null;
  const [vals, setVals] = useState(() => ({
    final_cf: String(x.final_cf || ""), collected: String(x.amount_collected || ""),
    method: (x.payment_methods || [])[0] || "", delivered_on: x.delivery_date || "",
  }));
  const [busy, setBusy] = useState(false);
  const set = (k, v) => setVals((s) => ({ ...s, [k]: v }));
  const outcome = d ? reviewOutcome(d, { final_cf: vals.final_cf || d.est_cf, collected: vals.collected }) : null;
  const preview = d ? { ...d, final_cf: num(vals.final_cf) || num(d.est_cf), collected: num(vals.collected), status: "verified" } : null;
  const alerts = preview ? dispatchAlerts(preview, { today: todayISO() }) : [];
  const conf = typeof x.confidence === "number" ? Math.round(x.confidence * 100) : null;

  async function openFile(a) {
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(a.path, 120);
    if (error || !data?.signedUrl) { window.alert(tr("Could not open the file.", "No se pudo abrir el archivo.")); return; }
    window.open(data.signedUrl, "_blank", "noopener");
  }
  async function approve() {
    if (!d) { window.alert(tr("Choose which dispatch these documents belong to.", "Elegí a qué despacho pertenecen estos documentos.")); return; }
    if (!(num(vals.collected) >= 0) || vals.collected === "") { window.alert(tr("Enter what the carrier collected (0 if nothing).", "Cargá lo que cobró el carrier (0 si no cobró nada).")); return; }
    setBusy(true);
    const at = nowISO();
    if (dbFailed(await supabase.from("carrier_dispatches").update({
      final_cf: num(vals.final_cf) || num(d.est_cf), collected: num(vals.collected), collected_method: vals.method || null,
      delivered_on: vals.delivered_on || null, status: "verified", verified_at: at, verified_by: userEmail, updated_by: userEmail, updated_at: at,
    }).eq("id", d.id), "carrier_dispatches")) { setBusy(false); return; }
    if (dbFailed(await supabase.from("carrier_messages").update({ status: "applied", dispatch_id: d.id, reviewed_by: userEmail, reviewed_at: at, updated_at: at }).eq("id", m.id), "carrier_messages")) { setBusy(false); return; }
    await onMarkJobDelivered?.(d.job_number);
    setBusy(false);
    onDone();
  }
  async function reject() {
    if (!window.confirm(tr("Discard these documents? The email stays in dispatch@.", "¿Descartar estos documentos? El mail queda en dispatch@."))) return;
    setBusy(true);
    const ok = !dbFailed(await supabase.from("carrier_messages").update({ status: "rejected", reviewed_by: userEmail, reviewed_at: nowISO() }).eq("id", m.id), "carrier_messages");
    setBusy(false);
    if (ok) onDone();
  }
  async function dispute() {
    if (!d) return;
    setBusy(true);
    const ok = !dbFailed(await supabase.from("carrier_dispatches").update({ status: "disputed", updated_by: userEmail, updated_at: nowISO() }).eq("id", d.id), "carrier_dispatches")
      && !dbFailed(await supabase.from("carrier_messages").update({ status: "applied", dispatch_id: d.id, reviewed_by: userEmail, reviewed_at: nowISO() }).eq("id", m.id), "carrier_messages");
    setBusy(false);
    if (ok) onDone();
  }

  const files = Array.isArray(m.attachments) ? m.attachments : [];
  return (
    <div style={{ ...card, padding:14, display:"grid", gridTemplateColumns:"minmax(160px, 220px) minmax(0,1fr)", gap:16 }}>
      <div style={{ display:"grid", gap:6, alignContent:"start" }}>
        <span style={fieldLabel}>Files</span>
        {files.filter((a) => a.path).map((a, i) => (
          <button key={i} onClick={() => openFile(a)} style={{ textAlign:"left", border:"1px solid #eee", borderRadius:8, padding:"7px 9px", background:"#FAFAFA", cursor:"pointer", fontSize:12, overflow:"hidden", textOverflow:"ellipsis", whiteSpace:"nowrap" }}>
            📎 {a.name}{a.readable === false ? <span style={{ color:"#C2410C" }}> · {tr("open it yourself", "abrilo a mano")}</span> : null}
          </button>
        ))}
        {files.filter((a) => a.skipped).map((a, i) => <div key={"s" + i} style={{ fontSize:11, color:"#aaa" }}>{a.name} · {tr("not kept", "no se guardó")}</div>)}
        {!files.length && <div style={{ fontSize:12, color:"#bbb" }}>No attachments</div>}
        {m.body_text && <details style={{ fontSize:12, color:"#666" }}><summary style={{ cursor:"pointer" }}>Email text</summary><div style={{ whiteSpace:"pre-wrap", marginTop:6, maxHeight:180, overflow:"auto" }}>{String(m.body_text).slice(0, 3000)}</div></details>}
      </div>
      <div style={{ display:"grid", gap:10, minWidth:0 }}>
        <div style={{ display:"flex", gap:8, alignItems:"center", flexWrap:"wrap" }}>
          <b>{carrier?.name || m.from_addr}</b>
          {conf != null && <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"#EDE9FE", color:"#6D28D9" }}>{tr(`AI ${conf}%`, `IA ${conf}%`)}</span>}
          {m.status === "unmatched" && <span style={{ fontSize:10.5, fontWeight:700, padding:"2px 9px", borderRadius:20, background:"#FDE3CF", color:"#C2410C" }}>Not matched to a dispatch</span>}
        </div>
        <div style={{ fontSize:11.5, color:"#999" }}>{[m.from_addr, m.subject && `"${m.subject}"`, shortDate(m.received_at || m.created_at)].filter(Boolean).join(" · ")}</div>
        {m.error && <div style={{ fontSize:12, color:"#C2410C" }}>{tr(`${m.error}. Fill in the numbers from the files.`, `${m.error}. Completá los números a partir de los archivos.`)}</div>}
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fit, minmax(140px, 1fr))", gap:8 }}>
          <Field label="Dispatch" style={{ marginBottom:0 }}>
            <select value={dispatchId} onChange={(e) => setDispatchId(e.target.value)} style={inp} disabled={!canEdit}>
              <option value="">Choose…</option>
              {dispatches.map((y) => <option key={y.id} value={y.id}>{`${y.job_number} · D${y.id}`}</option>)}
            </select>
          </Field>
          <Field label="Final CF" style={{ marginBottom:0 }}><input type="number" value={vals.final_cf} onChange={(e) => set("final_cf", e.target.value)} style={inp} disabled={!canEdit} />{d && <div style={{ fontSize:10.5, color:"#aaa", marginTop:2 }}>{tr(`est. ${num(d.est_cf)}`, `est. ${num(d.est_cf)}`)}</div>}</Field>
          <Field label="Collected" style={{ marginBottom:0 }}><input type="number" step="0.01" value={vals.collected} onChange={(e) => set("collected", e.target.value)} style={inp} disabled={!canEdit} />{d && <div style={{ fontSize:10.5, color:"#aaa", marginTop:2 }}>{tr(`expected ${fmt$(num(d.expected_collect))}`, `esperado ${fmt$(num(d.expected_collect))}`)}</div>}</Field>
          <Field label="Method" style={{ marginBottom:0 }}><select value={vals.method} onChange={(e) => set("method", e.target.value)} style={inp} disabled={!canEdit}><option value="">—</option>{PAYMENT_METHODS.map((k) => <option key={k} value={k}>{METHOD_LABEL[k]}</option>)}</select>{x.payment_breakdown && <div style={{ fontSize:10.5, color:"#aaa", marginTop:2 }}>{x.payment_breakdown}</div>}</Field>
          <Field label="Delivered" style={{ marginBottom:0 }}><input type="date" value={vals.delivered_on} onChange={(e) => set("delivered_on", e.target.value)} style={inp} disabled={!canEdit} />
            <div style={{ fontSize:10.5, color:"#aaa", marginTop:2 }}>{tr(`signatures: customer ${x.customer_signed ? "✓" : "✗"} · driver ${x.driver_signed ? "✓" : "✗"}`, `firmas: cliente ${x.customer_signed ? "✓" : "✗"} · driver ${x.driver_signed ? "✓" : "✗"}`)}</div></Field>
        </div>
        {alerts.map((a, i) => <div key={i} style={{ fontSize:12, fontWeight:600, borderRadius:8, padding:"6px 10px", background:"#FDE3CF", color:"#C2410C" }}>{alertText(a)}</div>)}
        {x.notes && <div style={{ fontSize:12, color:"#666" }}>{tr(`Notes read: ${x.notes}`, `Notas leídas: ${x.notes}`)}</div>}
        {outcome && (
          <div style={{ fontSize:12.5, color:"#555", borderTop:"1px dashed #eee", paddingTop:8 }}>
            {tr(`Carrier's pay ${fmt$(outcome.pay)} · collected ${fmt$(num(vals.collected))} → `, `Le corresponde ${fmt$(outcome.pay)} · cobró ${fmt$(num(vals.collected))} → `)}<Verdict value={outcome.net} />
          </div>
        )}
        {canEdit && (
          <div style={{ display:"flex", gap:8, flexWrap:"wrap" }}>
            <Btn primary disabled={busy || !d} onClick={approve} style={{ background:"#1A8A4E", borderColor:"#1A8A4E" }}>Approve</Btn>
            {d && <Btn disabled={busy} onClick={dispute}>Mark disputed</Btn>}
            <Btn danger disabled={busy} onClick={reject}>Discard</Btn>
          </div>
        )}
      </div>
    </div>
  );
}
