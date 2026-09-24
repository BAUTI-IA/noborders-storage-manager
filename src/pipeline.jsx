// Pipeline — the board for work that has arrived but has not been decided yet.
//
// The CRM had no place for an opportunity: a job was either a storage_jobs row
// (already accepted) or it did not exist. This module owns that missing stage —
// reception, automatic pricing, the accept/hold/reject/offer decision, and the
// hand-off into the normal job form.
//
// Self-contained (same shape as BancosSection / JobCalcSection): it receives
// supabase + session, loads its own rows and subscribes to its own realtime.
// Every number on screen comes from job_evaluations, written by the same
// evaluateJob() the Job Calculator uses — this screen never invents one.
// Pure math lives in src/pipelineData.js so it is testable with plain node.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { tr } from "./i18n.js";
import { selectAll, dbFailed } from "./db.js";
import {
  LEAD_STATUSES, leadStatusMeta, leadSourceMeta, verdictMeta,
  mergePipelineSettings, holdDates, holdStage, holdProgress,
  rankLeads, pipelineTotals, leadScore, findDuplicate,
  leadToJobForm, isEvaluable, missingFields, isLowConfidence, num,
  DEADHEAD_ORIGINS, normalizeSenderRules, normalizeCarriers, dropReasonMeta,
} from "./pipelineData.js";

// Shown in the setup banner when the tables don't exist yet.
// Keep in sync with scripts/setup-pipeline.mjs (the one-time migration).
export const PIPELINE_SQL = `-- Run the migration instead, it is idempotent:
--   SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs
create table if not exists public.job_leads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  created_by uuid references public.profiles(id) on delete set null,
  deleted_at timestamptz,
  source text not null default 'manual' check (source in ('manual','email','whatsapp','telegram')),
  source_ref text, raw_text text, parsed jsonb,
  broker_id bigint references public.brokers(id),
  broker_job_number text, customer text,
  origin_zip text, origin_city text, origin_state text,
  dest_zip text, dest_city text, dest_state text,
  cu_ft numeric, broker_price numeric,
  fadd date, pickup_date_from date, pickup_date_to date, delivery_date date,
  job_type text check (job_type in ('full','direct','broker_delivery')),
  status text not null default 'new' check (status in
    ('new','evaluating','proposed','accepted','held','offered','rejected','expired','converted')),
  hold_started_on date, remind_at date, hold_until date, hold_reason text,
  reminder_sent_at timestamptz, escalated_at timestamptz,
  offered_to text, offered_rate numeric, offered_at timestamptz, reject_reason text,
  evaluation_id bigint references public.job_evaluations(id) on delete set null,
  job_id bigint references public.storage_jobs(id) on delete set null,
  decided_by uuid references public.profiles(id) on delete set null,
  decided_at timestamptz, notes text
);
create table if not exists public.pipeline_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.pipeline_settings (id, settings) values (1, '{}'::jsonb) on conflict (id) do nothing;`;

// Soft deletes: every module redeclares this (it is not exported from db.js).
const notDel = (r) => !r?.deleted_at;

const today = () => {
  const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};

/** This morning's midnight where the operator is, as an instant. */
const midnight = () => { const d = new Date(); d.setHours(0, 0, 0, 0); return d.toISOString(); };

// Local style tokens, same values every other module redeclares.
const inp = { fontSize: 13, padding: "8px 10px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", color: "#111", width: "100%", outline: "none" };
const th = { padding: "9px 10px", textAlign: "left", fontWeight: 700, fontSize: 10.5, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.05em", whiteSpace: "nowrap" };
const td = { padding: "9px 10px", fontSize: 12.5, verticalAlign: "middle" };
const card = { background: "#fff", borderRadius: 12, border: "1px solid #efefef", padding: "14px 16px" };
const cap = { fontSize: 10.5, fontWeight: 700, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.06em", display: "flex", alignItems: "center", gap: 8, marginBottom: 10 };
const money = (v) => (v == null || v === "" ? "—" : (num(v) < 0 ? "−$" : "$") + Math.abs(Math.round(num(v))).toLocaleString());

function Tag({ meta, children }) {
  if (!meta) return null;
  return <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: meta.bg, color: meta.text, whiteSpace: "nowrap" }}>{children || meta.l}</span>;
}

function Kv({ k, children, flag }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #f6f6f6", fontSize: 12.5, ...(flag ? { background: "#FFF7ED", marginInline: -6, paddingInline: 6, borderRadius: 5 } : null) }}>
      <span style={{ color: "#999" }}>{k}</span>
      <b style={{ fontWeight: 600, textAlign: "right" }}>{children}</b>
    </div>
  );
}

// One estimated-vs-real row. The gap is the whole point, so it is coloured only
// when it is big enough to mean something — 15% off is noise, not a lesson.
function Delta({ k, est, real, money: isMoney }) {
  if (real == null || real === "") return null;
  const e = est == null || est === "" ? null : num(est);
  const r = num(real);
  const fmt = (v) => (isMoney ? money(v) : Math.round(v * 10) / 10);
  const off = e != null && e > 0 ? (r - e) / e : null;
  const tone = off == null || Math.abs(off) < 0.15 ? "#111" : off > 0 ? "#A32D2D" : "#3B6D11";
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12, padding: "6px 0", borderBottom: "1px solid #f6f6f6", fontSize: 12.5 }}>
      <span style={{ color: "#999" }}>{k}</span>
      <span style={{ textAlign: "right" }}>
        {e != null && <span style={{ color: "#bbb" }}>{fmt(e)} → </span>}
        <b style={{ fontWeight: 600, color: tone }}>{fmt(r)}</b>
        {off != null && Math.abs(off) >= 0.15 && (
          <span style={{ color: tone, fontSize: 11, marginLeft: 5 }}>
            {off > 0 ? "+" : ""}{Math.round(off * 100)}%
          </span>
        )}
      </span>
    </div>
  );
}

// A short list of short strings, edited as chips. Used for the broker domains
// and the partner carriers — both are lists people add to one at a time and
// occasionally remove from, which a textarea handles badly.
function ListEditor({ items, onChange, placeholder, normalize, hint }) {
  const [draft, setDraft] = useState("");
  // One paste can hold several: "allied.com, atlas.com" should not become one
  // nonsense entry.
  const add = () => {
    const parts = draft.split(/[,;\s]+/).filter(Boolean);
    if (!parts.length) return;
    const next = normalize([...items, ...parts]);
    setDraft("");
    if (next.length !== items.length || next.some((v, i) => v !== items[i])) onChange(next);
  };
  return (
    <div>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: items.length ? 8 : 0 }}>
        {items.map((v) => (
          <span key={v} style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "#f5f5f5", border: "1px solid #ececec", borderRadius: 20, padding: "3px 6px 3px 11px", fontSize: 12.5 }}>
            {v}
            <button type="button" onClick={() => onChange(items.filter((x) => x !== v))} title="Remove"
              style={{ background: "none", border: "none", cursor: "pointer", color: "#aaa", fontWeight: 700, fontSize: 14, lineHeight: 1, padding: "0 2px" }}>×</button>
          </span>
        ))}
      </div>
      <div style={{ display: "flex", gap: 6 }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === ",") { e.preventDefault(); add(); } }}
          onBlur={add} placeholder={placeholder} style={{ ...inp, flex: 1 }} />
        <button type="button" onClick={add} disabled={!draft.trim()}
          style={{ padding: "8px 14px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", color: "#444", fontSize: 12.5, fontWeight: 600, cursor: draft.trim() ? "pointer" : "default", opacity: draft.trim() ? 1 : 0.5 }}>Add</button>
      </div>
      {hint && <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 6 }}>{hint}</div>}
    </div>
  );
}

// One labelled number input. The caps and the two hold days are all this shape.
// Only digits get through, and mergePipelineSettings() applies the floors on
// save, so there is nothing to validate here.
function NumField({ label, value, onChange, hint }) {
  return (
    <label style={{ fontSize: 12, color: "#666", display: "block" }}>
      {label}
      <input value={value} inputMode="numeric"
        onChange={(e) => onChange(e.target.value.replace(/[^\d]/g, ""))}
        style={{ ...inp, marginTop: 4, width: 120 }} />
      {hint && <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 4, fontWeight: 400 }}>{hint}</div>}
    </label>
  );
}

export function PipelineSection({ supabase, session, profile, can = () => true, isAdmin = false, Btn, Modal, onConvertLead }) {
  const canCreate = can("pipeline", "create") || isAdmin;
  const canEdit = can("pipeline", "edit") || isAdmin;

  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [leads, setLeads] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [settings, setSettings] = useState(mergePipelineSettings(null));
  const [err, setErr] = useState("");

  const [tab, setTab] = useState("all");
  const [q, setQ] = useState("");
  const [detailId, setDetailId] = useState(null);
  const [alertOpen, setAlertOpen] = useState(true);

  const [showNew, setShowNew] = useState(false);
  const [newText, setNewText] = useState("");
  const [busy, setBusy] = useState(false);

  const [rank, setRank] = useState(null);       // { ranked, notes } | { error }
  const [rankOpen, setRankOpen] = useState(false);
  const [decide, setDecide] = useState(null);   // { kind, lead, reason, to, rate }

  // Emails the webhook refused today. A rejected sender gets a flat 202 so the
  // endpoint tells the internet nothing, which would also hide a real broker
  // who is not on the allowlist yet — this is where that becomes visible.
  const [drops, setDrops] = useState([]);
  const [dropsOpen, setDropsOpen] = useState(false);

  const [setupOpen, setSetupOpen] = useState(false);
  const [draft, setDraft] = useState(null);     // the settings being edited
  const [saving, setSaving] = useState(false);

  const td0 = today();
  const seq = useRef(0);

  // ── Load ───────────────────────────────────────────────────────────────────
  const load = useCallback(async () => {
    const mine = ++seq.current;
    const { data, error } = await selectAll(
      () => supabase.from("job_leads").select("*").is("deleted_at", null).order("created_at", { ascending: false }),
      { tiebreak: null }
    );
    if (error) {
      if (error.code === "42P01" || /job_leads|pipeline_settings/.test(error.message || "")) { setMissing(true); setLoading(false); return; }
      setErr(error.message); setLoading(false); return;
    }
    if (mine !== seq.current) return;
    setMissing(false);

    // Attach each lead's pricing run. One query for the whole board.
    const evalIds = [...new Set((data || []).map((l) => l.evaluation_id).filter((x) => x != null))];
    let byEval = new Map();
    if (evalIds.length) {
      const { data: evs } = await supabase.from("job_evaluations").select("*").in("id", evalIds);
      byEval = new Map((evs || []).map((e) => [e.id, e]));
    }
    setLeads((data || []).filter(notDel).map((l) => ({ ...l, evaluation: byEval.get(l.evaluation_id) || null })));

    const [{ data: bk }, { data: st }, { data: dr }] = await Promise.all([
      supabase.from("brokers").select("id, name").is("deleted_at", null).order("name"),
      supabase.from("pipeline_settings").select("settings").eq("id", 1).maybeSingle(),
      // Local midnight, sent as an instant: "today" has to mean the operator's
      // today, not UTC's. action_log predates this module and may be missing on
      // an old install, so a failure here must not take the board down with it.
      supabase.from("action_log").select("id, created_at, label, after")
        .eq("entity", "job_leads").eq("action", "dropped")
        .gte("created_at", midnight())
        .order("created_at", { ascending: false }).limit(50),
    ]);
    setBrokers(bk || []);
    setSettings(mergePipelineSettings(st?.settings));
    setDrops(dr || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (missing) return;
    const ch = supabase.channel("pipeline-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_leads" }, () => load())
      .subscribe();
    return () => supabase.removeChannel(ch);
  }, [supabase, missing, load]);

  // ── Derived ────────────────────────────────────────────────────────────────
  const brokerName = useCallback((id) => brokers.find((b) => String(b.id) === String(id))?.name || "", [brokers]);
  const totals = useMemo(() => pipelineTotals(leads, td0), [leads, td0]);

  const ranked = useMemo(() => rankLeads(leads), [leads]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return ranked.filter((l) => {
      if (tab === "open" && !["new", "evaluating", "proposed", "held", "expired"].includes(l.status)) return false;
      if (tab !== "all" && tab !== "open" && l.status !== tab) return false;
      if (!needle) return true;
      return [l.broker_job_number, l.customer, brokerName(l.broker_id), l.origin_zip, l.dest_zip, l.origin_city, l.dest_city]
        .some((v) => String(v || "").toLowerCase().includes(needle));
    });
  }, [ranked, tab, q, brokerName]);

  const urgent = useMemo(
    () => leads.filter((l) => ["due", "expired"].includes(holdStage(l, td0))),
    [leads, td0]
  );
  const detail = useMemo(() => leads.find((l) => l.id === detailId) || null, [leads, detailId]);

  // ── Server calls ───────────────────────────────────────────────────────────
  const callApi = useCallback(async (payload) => {
    const res = await fetch("/api/trip-suggestions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer " + (session?.access_token || "") },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || tr("The server could not be reached.", "No se pudo conectar con el servidor."));
    return data;
  }, [session]);

  async function createFromText() {
    if (!newText.trim() || busy) return;
    setBusy(true); setErr("");
    try {
      const { lead } = await callApi({ action: "lead_extract", text: newText.trim() });
      const dup = findDuplicate(lead, leads);
      if (dup) {
        setErr(tr(
          `Heads up: this looks like the same job as lead #${dup.id} (${dup.broker_job_number || dup.customer || "no number"}). Review both before deciding.`,
          `Ojo: esto parece el mismo job que el lead #${dup.id} (${dup.broker_job_number || dup.customer || "sin número"}). Revisá los dos antes de decidir.`));
      }
      setShowNew(false); setNewText(""); setDetailId(lead.id);
      await load();
    } catch (e) { setErr(e.message); }
    setBusy(false);
  }

  // The settings row is a jsonb singleton, so a save merges onto whatever is
  // stored rather than replacing it: a key this build does not know about (one
  // added by a newer deploy, or by hand in SQL) must survive being saved from
  // an older screen.
  async function saveSettings() {
    if (saving) return;
    setSaving(true); setErr("");
    const { data: cur, error: readErr } = await supabase
      .from("pipeline_settings").select("settings").eq("id", 1).maybeSingle();
    if (readErr) { setErr(readErr.message); setSaving(false); return; }

    const clean = mergePipelineSettings(draft);
    const next = { ...(cur?.settings || {}), ...clean };
    if (dbFailed(await supabase.from("pipeline_settings")
      .update({ settings: next, updated_at: new Date().toISOString(), updated_by: session?.user?.id || null })
      .eq("id", 1), "pipeline_settings")) {
      setErr(tr("The settings could not be saved.", "No se pudieron guardar los settings."));
      setSaving(false); return;
    }
    setSettings(mergePipelineSettings(next));
    setSaving(false); setSetupOpen(false); setDraft(null);
  }

  async function evaluateNow(lead) {
    if (busy) return;
    setBusy(true); setErr("");
    try { await callApi({ action: "lead_evaluate", lead_id: lead.id }); await load(); }
    catch (e) { setErr(e.message); }
    setBusy(false);
  }

  async function analyzeBatch() {
    if (busy) return;
    setBusy(true); setErr(""); setRank(null); setRankOpen(true);
    try {
      const priced = leads
        .filter((l) => ["new", "proposed", "held"].includes(l.status) && l.evaluation)
        .map((l) => ({
          id: l.id, broker_name: brokerName(l.broker_id), broker_job_number: l.broker_job_number,
          customer: l.customer, origin_city: l.origin_city, dest_city: l.dest_city,
          origin_zip: l.origin_zip, dest_zip: l.dest_zip, cu_ft: l.cu_ft, broker_price: l.broker_price,
          fadd: l.fadd,
          contribution_per_truck_day: l.evaluation.contribution_per_truck_day,
          hurdle_per_truck_day: l.evaluation.hurdle_per_truck_day,
          truck_days: l.evaluation.truck_days, ask_price: l.evaluation.ask_price,
          verdict: l.evaluation.verdict,
          nearest_truck_miles: l.parsed?.nearest_truck?.straight_miles ?? null,
        }));
      const { data: free } = await supabase.from("trucks").select("id").is("deleted_at", null).is("trip_id", null).limit(50);
      const out = await callApi({ action: "lead_rank", leads: priced, trucks_free: (free || []).length || priced.length, lang: document.documentElement.lang === "es" ? "es" : "en" });
      setRank(out);
    } catch (e) { setRank({ error: e.message }); }
    setBusy(false);
  }

  // ── Decisions ──────────────────────────────────────────────────────────────
  const stamp = () => ({ decided_by: session?.user?.id || null, decided_at: new Date().toISOString() });

  async function putOnHold(lead) {
    if (!canEdit) return;
    const d = holdDates(td0, settings);
    if (dbFailed(await supabase.from("job_leads").update({ status: "held", ...d, reminder_sent_at: null, ...stamp() }).eq("id", lead.id), "job_leads")) return;
    load();
  }

  async function reject(lead, reason) {
    if (!canEdit) return;
    if (dbFailed(await supabase.from("job_leads").update({ status: "rejected", reject_reason: reason || null, ...stamp() }).eq("id", lead.id), "job_leads")) return;
    setDecide(null); setDetailId(null); load();
  }

  async function offer(lead, to, rate) {
    if (!canEdit) return;
    const patch = { status: "offered", offered_to: to || null, offered_rate: rate === "" ? null : num(rate), offered_at: new Date().toISOString(), ...stamp() };
    if (dbFailed(await supabase.from("job_leads").update(patch).eq("id", lead.id), "job_leads")) return;
    // The offer message, pre-built the way the CRM already does driver manifests.
    const msg = tr(
      `Job available: ${lead.cu_ft || "?"} cf, ${lead.origin_city || lead.origin_zip || "?"} to ${lead.dest_city || lead.dest_zip || "?"}${lead.fadd ? `, FADD ${lead.fadd}` : ""}. Offering ${money(rate)}. Interested?`,
      `Job disponible: ${lead.cu_ft || "?"} cf, de ${lead.origin_city || lead.origin_zip || "?"} a ${lead.dest_city || lead.dest_zip || "?"}${lead.fadd ? `, FADD ${lead.fadd}` : ""}. Ofrezco ${money(rate)}. ¿Te interesa?`);
    window.open("https://wa.me/?text=" + encodeURIComponent(msg), "_blank", "noopener");
    setDecide(null); load();
  }

  function accept(lead) {
    if (!canEdit) return;
    if (typeof onConvertLead !== "function") {
      window.alert(tr("Converting a lead into a job is not available here.", "Convertir un lead en job no está disponible acá."));
      return;
    }
    // The AI never writes: this only pre-fills the job modal that already
    // exists, and saveJob() does its per-location fan-out exactly as always.
    onConvertLead(lead, leadToJobForm(lead, {}));
    setDetailId(null);
  }

  // ── Setup banner ───────────────────────────────────────────────────────────
  if (missing) {
    return (
      <div style={{ background: "#FFF7ED", border: "1px solid #FED7AA", borderRadius: 12, padding: 20, fontSize: 13.5, color: "#9A3412" }}>
        <b>The Pipeline module is not installed in the database yet.</b>
        <div style={{ marginTop: 6 }}>Run the migration once and reload:</div>
        <pre style={{ background: "#fff", border: "1px solid #eee", borderRadius: 8, padding: 10, fontSize: 12, marginTop: 8, overflowX: "auto" }}>
SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-pipeline.mjs</pre>
      </div>
    );
  }

  const tiles = [
    ["New", totals.new, tr("not priced yet", "sin evaluar"), null],
    ["Evaluated", totals.evaluated, tr("waiting on a decision", "esperando decisión"), null],
    ["On hold", totals.held, tr("clock running", "con el reloj corriendo"), "#854D0E"],
    ["Expiring", totals.expiring, tr("due today or overdue", "vencen hoy o ya vencieron"), "#A32D2D"],
    ["Offered", totals.offered, tr("handed to a carrier", "pasados a un carrier"), null],
    ["Converted", totals.converted, money(totals.convertedValue), "#3B6D11"],
  ];

  const TABS = [["all", "All"], ["open", "Open"], ["new", "New"], ["proposed", "Evaluated"],
    ["held", "On hold"], ["offered", "Offered"], ["rejected", "Rejected"], ["converted", "Converted"]];

  return (
    <div>
      {/* Action bar */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 14, alignItems: "center" }}>
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search a lead"
          style={{ ...inp, width: 220 }} />
        <div style={{ marginLeft: "auto", display: "flex", gap: 8, flexWrap: "wrap" }}>
          {isAdmin && <Btn onClick={() => { setDraft({ ...settings }); setSetupOpen(true); }}>⚙ Settings</Btn>}
          <Btn disabled={busy} onClick={analyzeBatch}>✨ Analyze batch</Btn>
          {canCreate && <Btn primary disabled={busy} onClick={() => { setNewText(""); setShowNew(true); }}>+ New lead</Btn>}
        </div>
      </div>

      {err && (
        <div style={{ background: "#FCEBEB", color: "#A32D2D", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, marginBottom: 10, display: "flex", gap: 10 }}>
          <span style={{ flex: 1 }}>{err}</span>
          <button onClick={() => setErr("")} style={{ background: "none", border: "none", color: "#C08585", cursor: "pointer", fontWeight: 700 }}>×</button>
        </div>
      )}

      {/* Metrics */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 10, marginBottom: 14 }}>
        {tiles.map(([label, n, sub, color]) => (
          <div key={label} style={{ ...card, padding: "12px 14px" }}>
            <div style={cap}>{label}</div>
            <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em", lineHeight: 1, color: color || "#111" }}>{n}</div>
            <div style={{ fontSize: 11, color: "#bbb", marginTop: 4 }}>{sub}</div>
          </div>
        ))}
      </div>

      {/* The clock's red banner */}
      {alertOpen && urgent.length > 0 && (
        <div style={{ background: "#FCEBEB", border: "1px solid #F3C9C9", color: "#A32D2D", borderRadius: 10, padding: "10px 14px", fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <span>{tr(`⚠️ ${urgent.length} lead(s) reach their decision date`, `⚠️ ${urgent.length} lead(s) llegan a su fecha de decisión`)}</span>
          {urgent.slice(0, 6).map((l) => (
            <button key={l.id} onClick={() => setDetailId(l.id)}
              style={{ background: "#fff", border: "1px solid #F3C9C9", borderRadius: 20, padding: "2px 9px", fontSize: 11.5, color: "#A32D2D", cursor: "pointer", fontWeight: 600 }}>
              {[brokerName(l.broker_id), l.broker_job_number || l.customer].filter(Boolean).join(" · ") || `#${l.id}`}
            </button>
          ))}
          <button onClick={() => setAlertOpen(false)} style={{ marginLeft: "auto", background: "none", border: "none", color: "#C08585", cursor: "pointer", fontWeight: 700 }}>×</button>
        </div>
      )}

      {/* Emails the webhook refused today */}
      {drops.length > 0 && (
        <div style={{ background: "#FFF7ED", border: "1px solid #FED7AA", color: "#9A3412", borderRadius: 10, padding: "10px 14px", fontSize: 12.5, display: "flex", alignItems: "center", gap: 10, marginBottom: 14, flexWrap: "wrap" }}>
          <span style={{ fontWeight: 600 }}>
            {tr(`${drops.length} incoming email(s) were dropped today`, `Hoy se descartaron ${drops.length} mail(s) entrantes`)}
          </span>
          <button onClick={() => setDropsOpen(true)}
            style={{ background: "#fff", border: "1px solid #FED7AA", borderRadius: 20, padding: "2px 11px", fontSize: 11.5, color: "#9A3412", cursor: "pointer", fontWeight: 600 }}>
            See why
          </button>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
        {TABS.map(([v, l]) => {
          const n = v === "all" ? leads.length
            : v === "open" ? leads.filter((x) => ["new", "evaluating", "proposed", "held", "expired"].includes(x.status)).length
            : leads.filter((x) => x.status === v).length;
          const on = tab === v;
          return (
            <button key={v} onClick={() => setTab(v)}
              style={{ padding: "7px 14px", borderRadius: 20, border: "1px solid " + (on ? "#111" : "#e5e5e5"), background: on ? "#111" : "#fff", color: on ? "#fff" : "#555", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
              {l} <span style={{ opacity: 0.55 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {/* The board */}
      <div style={{ ...card, padding: 0, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", minWidth: 900 }}>
            <thead>
              <tr style={{ background: "#fafafa", borderBottom: "1px solid #efefef" }}>
                <th style={{ ...th, width: 30 }}></th>
                <th style={{ ...th, width: 28 }}>Src</th>
                <th style={th}>Broker · Job #</th>
                <th style={th}>Client</th>
                <th style={th}>Route</th>
                <th style={{ ...th, textAlign: "right" }}>CF</th>
                <th style={{ ...th, textAlign: "right" }}>Price</th>
                <th style={{ ...th, textAlign: "right" }}>$ / truck-day</th>
                <th style={th}>Clock</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={10} style={{ ...td, color: "#bbb", padding: 20 }}>Loading…</td></tr>}
              {!loading && shown.length === 0 && (
                <tr><td colSpan={10} style={{ ...td, color: "#bbb", padding: 20 }}>No leads here yet. Paste a broker's email with “+ New lead”.</td></tr>
              )}
              {shown.map((l) => {
                const ev = l.evaluation;
                const vm = verdictMeta(ev?.verdict);
                const st = holdStage(l, td0);
                const prog = holdProgress(l, td0);
                const score = leadScore(l);
                const sm = leadStatusMeta(l.status);
                const why = ev?.reason
                  ? tr(`${ev.truck_days} truck-days · break-even ${money(ev.breakeven_price)} · ask ${money(ev.ask_price)}`,
                       `${ev.truck_days} días-camión · break-even ${money(ev.breakeven_price)} · pedir ${money(ev.ask_price)}`)
                  : isEvaluable(l)
                    ? tr("Not priced yet — open it and press Price it now.",
                         "Sin evaluar — abrilo y tocá Price it now.")
                    : tr("Not priced yet — complete both ZIPs, the volume and the price.",
                         "Sin evaluar — completá los dos ZIPs, el volumen y el precio.");
                const near = l.parsed?.nearest_truck;
                return (
                  <tr key={l.id} style={{ borderTop: "1px solid #efefef" }}>
                    <td style={{ ...td, paddingTop: 11 }}>
                      {vm
                        ? <span title={vm.l} style={{ width: 10, height: 10, borderRadius: "50%", display: "inline-block", background: vm.dot }} />
                        : <Tag meta={sm} />}
                    </td>
                    <td style={{ ...td, paddingTop: 11 }} title={leadSourceMeta(l.source).l}>{leadSourceMeta(l.source).icon}</td>
                    <td style={{ ...td, paddingTop: 11 }}>
                      <button onClick={() => setDetailId(l.id)} style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit", textAlign: "left" }}>
                        <b>{brokerName(l.broker_id) || tr("No broker", "Sin broker")}</b>
                        <span style={{ color: "#aaa" }}> · {l.broker_job_number || `#${l.id}`}</span>
                      </button>
                      <div style={{ fontSize: 11.5, color: "#aaa", marginTop: 2 }}>
                        {why}{near ? tr(` · ${near.truck_name} ~${near.straight_miles} mi away`, ` · ${near.truck_name} a ~${near.straight_miles} mi`) : ""}
                      </div>
                    </td>
                    <td style={{ ...td, paddingTop: 11 }}>{l.customer || "—"}</td>
                    <td style={{ ...td, paddingTop: 11, color: "#aaa" }}>{(l.origin_zip || "?") + " → " + (l.dest_zip || "?")}</td>
                    <td style={{ ...td, paddingTop: 11, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{l.cu_ft ? Math.round(num(l.cu_ft)).toLocaleString() : "—"}</td>
                    <td style={{ ...td, paddingTop: 11, textAlign: "right", fontVariantNumeric: "tabular-nums" }}>{money(l.broker_price)}</td>
                    <td style={{ ...td, paddingTop: 11, textAlign: "right", fontWeight: 700, fontVariantNumeric: "tabular-nums", color: score == null ? "#ccc" : score < 0 ? "#A32D2D" : score < num(ev?.hurdle_per_truck_day) ? "#854D0E" : "#3B6D11" }}>
                      {score == null ? "—" : money(score)}
                    </td>
                    <td style={{ ...td, paddingTop: 11 }}>
                      {prog ? (
                        <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600, color: st === "expired" ? "#A32D2D" : "#854D0E" }}>
                          <span style={{ width: 44, height: 5, borderRadius: 3, background: "#f0f0f0", overflow: "hidden", display: "inline-block" }}>
                            <span style={{ display: "block", height: "100%", width: prog.pct + "%", background: st === "expired" ? "#E24B4A" : "#FACC15" }} />
                          </span>
                          {prog.day} / {prog.total}
                        </span>
                      ) : <span style={{ color: "#ccc" }}>—</span>}
                    </td>
                    <td style={{ ...td, paddingTop: 11, textAlign: "right", whiteSpace: "nowrap" }}>
                      {canEdit && ["new", "proposed", "held", "expired"].includes(l.status) && (
                        <>
                          <Btn primary style={{ padding: "6px 11px", fontSize: 12 }} onClick={() => accept(l)}>Accept</Btn>{" "}
                          {l.status !== "held" && <Btn style={{ padding: "6px 11px", fontSize: 12 }} onClick={() => putOnHold(l)}>Hold</Btn>}
                        </>
                      )}
                      {l.status === "converted" && l.job_id && <span style={{ color: "#aaa", fontSize: 11.5 }}>Job created</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── New lead: paste the email ── */}
      {showNew && (
        <Modal title="New lead" onClose={() => setShowNew(false)}
          footer={<>
            <Btn onClick={() => setShowNew(false)}>Cancel</Btn>
            <Btn primary disabled={busy || !newText.trim()} onClick={createFromText}>
              {busy ? "Reading…" : "✨ Read it and create the lead"}
            </Btn>
          </>}>
          <div style={{ fontSize: 12.5, color: "#666", marginBottom: 8 }}>
            Paste the broker's email or message. The fields are extracted for you to check before anything is decided.
          </div>
          <textarea value={newText} onChange={(e) => setNewText(e.target.value)} rows={10}
            placeholder="From: dispatch@broker.com&#10;820 cu ft, pickup 7/25-7/26 Miami FL 33125, delivery Atlanta GA 30301, FADD 8/1, $3,200"
            style={{ ...inp, minHeight: 170, fontFamily: "ui-monospace,Menlo,monospace", fontSize: 12.5, lineHeight: 1.6, resize: "vertical" }} />
          <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 8 }}>
            The message is read as data. Any instruction written inside it is ignored.
          </div>
        </Modal>
      )}

      {/* ── Batch ranking ── */}
      {rankOpen && (
        <Modal wide title="What the AI would take" onClose={() => setRankOpen(false)}
          footer={<Btn onClick={() => setRankOpen(false)}>Close</Btn>}>
          {!rank && <div style={{ color: "#999", fontSize: 13 }}>Thinking…</div>}
          {rank?.error && <div style={{ background: "#FCEBEB", color: "#A32D2D", borderRadius: 8, padding: "8px 12px", fontSize: 12.5 }}>{rank.error}</div>}
          {rank?.ranked?.length === 0 && !rank.error && (
            <div style={{ color: "#999", fontSize: 13 }}>No priced leads to rank yet.</div>
          )}
          {rank?.ranked?.map((r, i) => {
            const l = leads.find((x) => x.id === r.lead_id);
            return (
              <div key={r.lead_id} style={{ display: "flex", gap: 12, padding: "12px 0", borderTop: i ? "1px solid #f4f4f4" : "none" }}>
                <div style={{ fontSize: 15, fontWeight: 800, color: "#ccc", width: 18 }}>{i + 1}</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 13, fontWeight: 600, display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                    <button onClick={() => { setRankOpen(false); setDetailId(r.lead_id); }}
                      style={{ background: "none", border: "none", padding: 0, cursor: "pointer", font: "inherit" }}>
                      {[brokerName(l?.broker_id), l?.broker_job_number, l?.customer].filter(Boolean).join(" · ") || `#${r.lead_id}`}
                    </button>
                    <Tag meta={r.take ? { bg: "#EAF3DE", text: "#3B6D11", l: "TAKE" } : { bg: "#FEF9C3", text: "#854D0E", l: "PASS" }} />
                    <span style={{ color: "#aaa", fontWeight: 400, fontVariantNumeric: "tabular-nums" }}>
                      {r.per_truck_day == null ? "" : tr(`${money(r.per_truck_day)} / truck-day`, `${money(r.per_truck_day)} / día-camión`)}
                    </span>
                  </div>
                  <div style={{ fontSize: 11.5, color: "#999", marginTop: 3 }}>{r.reason}</div>
                </div>
              </div>
            );
          })}
          {rank?.notes && <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 14, paddingTop: 12, borderTop: "1px solid #f4f4f4" }}>{rank.notes}</div>}
          <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 10 }}>
            The AI orders and explains. The numbers are recomputed on the server. Nothing is written until you press Accept.
          </div>
        </Modal>
      )}

      {/* ── Lead detail ── */}
      {detail && (
        <Modal wide onClose={() => setDetailId(null)}
          header={<span>{[brokerName(detail.broker_id), detail.broker_job_number, detail.customer].filter(Boolean).join(" · ") || tr(`Lead #${detail.id}`, `Lead #${detail.id}`)}</span>}
          footer={canEdit ? <>
            <Btn danger onClick={() => setDecide({ kind: "reject", lead: detail, reason: "" })}>✕ Reject</Btn>
            <Btn onClick={() => setDecide({ kind: "offer", lead: detail, to: settings.carriers?.[0] || "", rate: "" })}>↗ Offer to carrier</Btn>
            {detail.status !== "held" && <Btn onClick={() => putOnHold(detail)}>⏸ Hold</Btn>}
            <Btn primary onClick={() => accept(detail)}>✓ Accept — create job</Btn>
          </> : null}>
          <LeadDetail lead={detail} brokerName={brokerName(detail.broker_id)} onEvaluate={() => evaluateNow(detail)} busy={busy} td0={td0} />
        </Modal>
      )}

      {/* ── Dropped emails ── */}
      {dropsOpen && (
        <Modal wide title="Emails dropped today" onClose={() => setDropsOpen(false)}
          footer={<>
            {isAdmin && <Btn onClick={() => { setDropsOpen(false); setDraft({ ...settings }); setSetupOpen(true); }}>⚙ Open settings</Btn>}
            <Btn onClick={() => setDropsOpen(false)}>Close</Btn>
          </>}>
          <div style={{ fontSize: 12.5, color: "#666", marginBottom: 10 }}>
            The webhook answers the same way to everyone, so a stranger cannot learn which domains we accept. That means a real broker who is not on the allowlist yet would disappear silently — these are those messages.
          </div>
          {drops.map((d, i) => {
            const meta = dropReasonMeta(d.after?.reason);
            return (
              <div key={d.id} style={{ padding: "10px 0", borderTop: i ? "1px solid #f4f4f4" : "none" }}>
                <div style={{ display: "flex", gap: 10, alignItems: "baseline", flexWrap: "wrap" }}>
                  <span style={{ color: "#aaa", fontSize: 11.5, whiteSpace: "nowrap" }}>{String(d.created_at).slice(11, 16)}</span>
                  <b style={{ fontSize: 12.5, fontWeight: 600 }}>{d.after?.from || tr("(no sender)", "(sin remitente)")}</b>
                  <Tag meta={{ bg: "#FFF7ED", text: "#9A3412", l: meta.l }} />
                </div>
                {d.after?.subject && <div style={{ fontSize: 12, color: "#777", marginTop: 3 }}>{d.after.subject}</div>}
                <div style={{ fontSize: 11.5, color: "#bbb", marginTop: 3 }}>{meta.hint}</div>
              </div>
            );
          })}
        </Modal>
      )}

      {/* ── Settings ── */}
      {setupOpen && draft && (
        <Modal title="Pipeline settings" onClose={() => setSetupOpen(false)}
          footer={<>
            <Btn onClick={() => setSetupOpen(false)}>Cancel</Btn>
            <Btn primary disabled={saving} onClick={saveSettings}>{saving ? "Saving…" : "Save"}</Btn>
          </>}>
          <div style={{ display: "grid", gap: 18 }}>
            <div>
              <div style={cap}>The hold clock</div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <NumField label="Remind after (days)" value={String(draft.holdReminderDays)}
                  onChange={(v) => setDraft({ ...draft, holdReminderDays: v })}
                  hint={tr("Day the reminder goes out.", "Día en que sale el recordatorio.")} />
                <NumField label="Decide within (days)" value={String(draft.holdDecisionDays)}
                  onChange={(v) => setDraft({ ...draft, holdDecisionDays: v })}
                  hint={tr("Day the lead expires.", "Día en que el lead vence.")} />
              </div>
            </div>

            <div>
              <div style={cap}>Who may send us leads</div>
              <label style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13, marginBottom: 10, cursor: "pointer" }}>
                <input type="checkbox" checked={!!draft.acceptAllSenders} style={{ marginTop: 2 }}
                  onChange={(e) => setDraft({ ...draft, acceptAllSenders: e.target.checked })} />
                <span>
                  <b>Every email becomes a lead</b>
                  <span style={{ display: "block", fontSize: 11.5, color: "#888", marginTop: 2 }}>
                    Any sender is accepted; emails that are not a job offer (newsletters, receipts, notices) are still discarded. Use it only when the forwarder reads a mailbox you trust — the secret is then the only gate.
                  </span>
                </span>
              </label>
              <ListEditor items={draft.allowedEmailDomains} normalize={normalizeSenderRules}
                onChange={(v) => setDraft({ ...draft, allowedEmailDomains: v })}
                placeholder="allied.com"
                hint={tr(
                  "A domain lets the whole company in, subdomains included. A full address lets in that one mailbox and nobody else — use it for anyone who writes from a personal account. Email from anyone else is discarded, and an empty list accepts nobody.",
                  "Un dominio deja entrar a toda la empresa, subdominios incluidos. Una dirección entera deja entrar sólo a esa casilla y a nadie más — usala para quien escribe desde una cuenta personal. El mail de cualquier otro se descarta, y la lista vacía no acepta a nadie.")} />
              <div style={{ fontSize: 11.5, color: "#B45309", marginTop: 6 }}>
                {tr("A public domain like gmail.com is refused on purpose — it would be the whole internet. Write the person's full address instead.",
                    "Un dominio público como gmail.com se rechaza a propósito — sería internet entero. Poné la dirección completa de la persona.")}
              </div>
            </div>

            <div>
              <div style={cap}>Partner carriers</div>
              <ListEditor items={draft.carriers} normalize={normalizeCarriers}
                onChange={(v) => setDraft({ ...draft, carriers: v })}
                placeholder="Carrier name"
                hint={tr("Offered to these when we pass on a job.", "A estos se les ofrece cuando dejamos pasar un job.")} />
            </div>

            <div>
              <div style={cap}>Inbound limits</div>
              <div style={{ display: "flex", gap: 18, flexWrap: "wrap" }}>
                <NumField label="Per sender, per day" value={String(draft.maxLeadsPerSenderPerDay)}
                  onChange={(v) => setDraft({ ...draft, maxLeadsPerSenderPerDay: v })}
                  hint={tr("One busy broker cannot crowd out the rest.", "Un broker movido no puede tapar al resto.")} />
                <NumField label="All senders, per day" value={String(draft.maxLeadsPerDay)}
                  onChange={(v) => setDraft({ ...draft, maxLeadsPerDay: v })}
                  hint={tr("Backstop. Never lower than the one on the left.", "Tope de seguridad. Nunca menor al de la izquierda.")} />
              </div>
            </div>
          </div>
        </Modal>
      )}

      {/* ── Reject / Offer ── */}
      {decide?.kind === "reject" && (
        <Modal title="Reject this lead" onClose={() => setDecide(null)}
          footer={<>
            <Btn onClick={() => setDecide(null)}>Cancel</Btn>
            <Btn danger disabled={!decide.reason.trim()} onClick={() => reject(decide.lead, decide.reason.trim())}>Reject</Btn>
          </>}>
          <div style={{ fontSize: 12.5, color: "#666", marginBottom: 8 }}>
            Why are we passing on it? This is what lets Analytics show how much work we turned down, and which broker only sends bad jobs.
          </div>
          <input value={decide.reason} onChange={(e) => setDecide({ ...decide, reason: e.target.value })}
            placeholder="Price below our hurdle" style={inp} />
        </Modal>
      )}

      {decide?.kind === "offer" && (
        <Modal title="Offer to a carrier" onClose={() => setDecide(null)}
          footer={<>
            <Btn onClick={() => setDecide(null)}>Cancel</Btn>
            <Btn primary disabled={!decide.to.trim()} onClick={() => offer(decide.lead, decide.to.trim(), decide.rate)}>Offer and open WhatsApp</Btn>
          </>}>
          <div style={{ display: "grid", gap: 10 }}>
            <label style={{ fontSize: 12, color: "#666" }}>Carrier
              <input value={decide.to} onChange={(e) => setDecide({ ...decide, to: e.target.value })}
                list="pipeline-carriers" placeholder="Carrier name" style={{ ...inp, marginTop: 4 }} />
              <datalist id="pipeline-carriers">
                {(settings.carriers || []).map((c) => <option key={c} value={c} />)}
              </datalist>
            </label>
            <label style={{ fontSize: 12, color: "#666" }}>Rate offered
              <input value={decide.rate} onChange={(e) => setDecide({ ...decide, rate: e.target.value })}
                inputMode="decimal" placeholder="2100" style={{ ...inp, marginTop: 4 }} />
            </label>
            <div style={{ fontSize: 11.5, color: "#bbb" }}>
              The WhatsApp message is built for you — you only pick the contact and send.
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

// ── Lead detail: what the AI read, and what the cost model says ──────────────
function LeadDetail({ lead, brokerName, onEvaluate, busy, td0 }) {
  const ev = lead.evaluation;
  const vm = verdictMeta(ev?.verdict);
  const gaps = missingFields(lead);
  const near = lead.parsed?.nearest_truck;
  const st = holdStage(lead, td0);
  const prog = holdProgress(lead, td0);
  const f = (k, v) => (v == null || v === "" ? "—" : v);

  return (
    <div>
      {vm && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 14px", borderRadius: 10, background: vm.bg, color: vm.text, fontWeight: 700, fontSize: 14, marginBottom: 12 }}>
          <span style={{ width: 14, height: 14, borderRadius: "50%", background: vm.dot }} />
          <span>{vm.l}</span>
          <span style={{ marginLeft: "auto", fontSize: 20, fontWeight: 800 }}>
            {money(ev.contribution_per_truck_day)}
            <span style={{ fontSize: 12, fontWeight: 600 }}> {tr("/ truck-day", "/ día-camión")}</span>
          </span>
        </div>
      )}

      {prog && (
        <div style={{ background: st === "expired" ? "#FCEBEB" : "#FEF9C3", color: st === "expired" ? "#A32D2D" : "#854D0E", borderRadius: 10, padding: "9px 13px", fontSize: 12.5, fontWeight: 600, marginBottom: 12 }}>
          {tr(`On hold · day ${prog.day} of ${prog.total} · decide by ${lead.hold_until}`,
              `En hold · día ${prog.day} de ${prog.total} · decidir antes del ${lead.hold_until}`)}
          {lead.reminder_sent_at ? tr(" · reminder sent", " · recordatorio enviado") : ""}
        </div>
      )}

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(260px,1fr))", gap: 12 }}>
        <div style={card}>
          <div style={cap}>What the AI read
            <span style={{ marginLeft: "auto", fontWeight: 500, letterSpacing: 0, textTransform: "none", fontSize: 11, color: "#bbb" }}>
              {leadSourceMeta(lead.source).l}
            </span>
          </div>
          <Kv k={tr("Broker", "Broker")}>{f("broker", brokerName)}</Kv>
          {lead.parsed?.sender && <Kv k={tr("Sent by", "Lo mandó")}>{lead.parsed.sender}</Kv>}
          <Kv k={tr("Client", "Cliente")} flag={isLowConfidence(lead, "customer")}>{f("c", lead.customer)}</Kv>
          <Kv k={tr("Origin", "Origen")} flag={isLowConfidence(lead, "origin_zip")}>
            {[lead.origin_city, lead.origin_state, lead.origin_zip].filter(Boolean).join(" · ") || "—"}
          </Kv>
          <Kv k={tr("Destination", "Destino")} flag={isLowConfidence(lead, "dest_zip")}>
            {[lead.dest_city, lead.dest_state, lead.dest_zip].filter(Boolean).join(" · ") || "—"}
          </Kv>
          <Kv k={tr("Volume", "Volumen")} flag={isLowConfidence(lead, "cu_ft")}>{lead.cu_ft ? Math.round(num(lead.cu_ft)).toLocaleString() + " cf" : "—"}</Kv>
          <Kv k={tr("Broker price", "Precio del broker")} flag={isLowConfidence(lead, "broker_price")}>{money(lead.broker_price)}</Kv>
          <Kv k="FADD" flag={isLowConfidence(lead, "fadd")}>{f("fadd", lead.fadd)}</Kv>
          <Kv k={tr("Pickup", "Pickup")}>{[lead.pickup_date_from, lead.pickup_date_to].filter(Boolean).join(" → ") || "—"}</Kv>
          <Kv k={tr("Job type", "Tipo de job")} flag={isLowConfidence(lead, "job_type")}>{f("t", lead.job_type)}</Kv>
          {gaps.length > 0 && (
            <div style={{ fontSize: 11, color: "#B45309", marginTop: 9 }}>
              {tr(`${gaps.length} field(s) still empty — complete them in the job form when you accept.`,
                  `Quedan ${gaps.length} campo(s) vacíos — completalos en el formulario del job al aceptar.`)}
            </div>
          )}
          <div style={{ fontSize: 11, color: "#bbb", marginTop: 6 }}>
            Anything highlighted was guessed, not read. Check it.
          </div>
        </div>

        <div style={card}>
          <div style={cap}>The numbers
            <span style={{ marginLeft: "auto", fontWeight: 500, letterSpacing: 0, textTransform: "none", fontSize: 11, color: "#bbb" }}>Job Calculator</span>
          </div>
          {!ev && (
            <div>
              <div style={{ fontSize: 12.5, color: "#999", marginBottom: 10 }}>
                {isEvaluable(lead)
                  ? tr("Not priced yet.", "Todavía sin evaluar.")
                  : tr("Both ZIPs, the volume and the price are needed before this can be priced.",
                       "Hacen falta los dos ZIPs, el volumen y el precio para poder evaluarlo.")}
              </div>
              <button onClick={onEvaluate} disabled={busy || !isEvaluable(lead)}
                style={{ fontSize: 13, fontWeight: 500, padding: "8px 16px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", color: "#111", cursor: busy || !isEvaluable(lead) ? "not-allowed" : "pointer", opacity: busy || !isEvaluable(lead) ? 0.5 : 1 }}>
                {busy ? "Pricing…" : "Price it now"}
              </button>
            </div>
          )}
          {ev && <>
            <Kv k={tr("Break-even", "Break-even")}>{money(ev.breakeven_price)}</Kv>
            <Kv k={tr("Broker price", "Precio del broker")}>{money(ev.broker_price)}</Kv>
            <Kv k={tr("Contribution", "Contribución")}>{money(ev.contribution_margin)}</Kv>
            <Kv k={tr("Per truck-day", "Por día-camión")}>{money(ev.contribution_per_truck_day)}</Kv>
            <Kv k={tr("Hurdle", "Hurdle")}>{money(ev.hurdle_per_truck_day)}</Kv>
            <Kv k={tr("Ask price", "Precio a pedir")}>{money(ev.ask_price)}</Kv>
            <Kv k={tr("Truck-days", "Días-camión")}>
              {tr(`${ev.truck_days} · ${ev.drivers} driver + ${ev.helpers} helper`,
                  `${ev.truck_days} · ${ev.drivers} driver + ${ev.helpers} helper`)}
            </Kv>
            <Kv k={tr("Miles", "Millas")}>
              {tr(`${Math.round(num(ev.loaded_miles)).toLocaleString()} loaded + ${Math.round(num(ev.deadhead_miles)).toLocaleString()} empty`,
                  `${Math.round(num(ev.loaded_miles)).toLocaleString()} cargadas + ${Math.round(num(ev.deadhead_miles)).toLocaleString()} vacías`)}
            </Kv>
            {/* Where the empty miles were measured from changes the verdict, so
                the screen says it instead of leaving the operator to assume. */}
            <Kv k={tr("Empty miles from", "Millas vacías desde")}>
              {lead.parsed?.deadhead_from === DEADHEAD_ORIGINS.truck
                ? tr(`🚛 ${near?.truck_name || "the closest truck"}${lead.parsed?.deadhead_zip ? ` · ${lead.parsed.deadhead_zip}` : ""}`,
                     `🚛 ${near?.truck_name || "el camión más cerca"}${lead.parsed?.deadhead_zip ? ` · ${lead.parsed.deadhead_zip}` : ""}`)
                : lead.parsed?.deadhead_from === DEADHEAD_ORIGINS.base
                ? tr(`the base${lead.parsed?.deadhead_zip ? ` · ${lead.parsed.deadhead_zip}` : ""}`,
                     `la base${lead.parsed?.deadhead_zip ? ` · ${lead.parsed.deadhead_zip}` : ""}`)
                : tr("not measured", "sin medir")}
            </Kv>
            {near && <Kv k={tr("Closest truck", "Camión más cerca")}>
              {tr(`🚛 ${near.truck_name} · ${near.location || "unknown"} · ~${near.straight_miles} mi`,
                  `🚛 ${near.truck_name} · ${near.location || "sin ubicación"} · ~${near.straight_miles} mi`)}
            </Kv>}
          </>}
        </div>
      </div>

      {/* Estimated against what it really cost. This is the payoff of the loop:
          until the actuals came back automatically the cost model could only
          age, because nobody was ever going to type them in by hand. */}
      {ev?.actuals_at && (
        <div style={{ ...card, marginTop: 12 }}>
          <div style={cap}>Estimated vs real
            <span style={{ marginLeft: "auto", fontWeight: 500, letterSpacing: 0, textTransform: "none", fontSize: 11, color: "#bbb" }}>
              {ev.actuals_source === "eld"
                ? tr("from the truck's GPS", "del GPS del camión")
                : tr("from payroll", "de la nómina")}
            </span>
          </div>
          <Delta k={tr("Truck-days", "Días-camión")} est={ev.truck_days} real={ev.actual_truck_days} />
          <Delta k={tr("Miles", "Millas")} est={ev.total_miles} real={ev.actual_miles} />
          <Delta k={tr("Fuel", "Combustible")} est={null} real={ev.actual_fuel} money />
          <Delta k={tr("Tolls", "Peajes")} est={null} real={ev.actual_tolls} money />
          <Delta k={tr("Hotel nights", "Noches de hotel")} est={ev.hotel_nights} real={ev.actual_hotel_nights} />
          {ev.actuals_shared && (
            <div style={{ fontSize: 11, color: "#854D0E", background: "#FEF9C3", borderRadius: 6, padding: "7px 9px", marginTop: 9 }}>
              {tr("This job shared its trip, so these are its share of it. The cost model does not learn from a shared run — it was priced as if the truck were all its own.",
                  "Este job compartió el viaje, así que esto es su parte. El modelo de costos no aprende de un viaje compartido — se coteó como si tuviera el camión para él solo.")}
            </div>
          )}
        </div>
      )}

      {lead.raw_text && (
        <details style={{ ...card, marginTop: 12 }}>
          <summary style={{ ...cap, marginBottom: 0, cursor: "pointer" }}>Original message</summary>
          <pre style={{ background: "#fafafa", border: "1px solid #f0f0f0", borderRadius: 10, padding: 12, fontSize: 12, lineHeight: 1.65, color: "#888", whiteSpace: "pre-wrap", marginTop: 10, maxHeight: 260, overflowY: "auto" }}>
            {lead.raw_text}
          </pre>
        </details>
      )}
    </div>
  );
}
