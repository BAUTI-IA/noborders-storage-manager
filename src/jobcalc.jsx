// Job Decision Calculator: brokers send jobs with the price already set, so the
// only question is take it or leave it. The operator enters four things plus the
// access conditions and gets a traffic light — often with the broker waiting on
// the phone, which is why this screen is mobile-first and recalculates live.
//
// All the math lives in ./jobCalcData.js (pure, unit-tested). This file only
// renders it, persists evaluations, and edits the settings.
// Tables: job_calc_settings, job_evaluations, zip_distances, zip_geo.
import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { tr } from "./i18n.js";
import {
  DEFAULT_SETTINGS, SETTING_FLAGS, ACCESS_TYPES, VERDICT, REASON,
  mergeSettings, evaluateJob, calibrate, calibrationPatch, crewDayRate, num,
} from "./jobCalcData.js";

// Shown in the setup banner when the tables don't exist yet.
// Keep in sync with scripts/setup-job-calc.mjs (the one-time migration).
export const JOB_CALC_SQL = `create table if not exists public.job_calc_settings (
  id smallint primary key default 1 check (id = 1),
  settings jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);
insert into public.job_calc_settings (id, settings) values (1, '{}'::jsonb) on conflict (id) do nothing;
create table if not exists public.job_evaluations (
  id bigint generated always as identity primary key,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz,
  label text,
  broker text,
  origin_zip text not null,
  dest_zip text not null,
  cu_ft numeric not null default 0,
  broker_price numeric not null default 0,
  origin_access text not null default 'direct' check (origin_access in ('direct','elevator','stairs')),
  dest_access text not null default 'direct' check (dest_access in ('direct','elevator','stairs')),
  long_carry boolean not null default false,
  shuttle boolean not null default false,
  loaded_miles numeric, deadhead_miles numeric, total_miles numeric,
  miles_manual boolean not null default false,
  handling_hours numeric, driving_hours numeric,
  truck_days numeric, truck_days_estimated numeric,
  truck_days_overridden boolean not null default false,
  hotel_nights numeric,
  variable_cost numeric, absorbed_fixed numeric,
  contribution_margin numeric, contribution_per_truck_day numeric,
  operating_margin numeric, breakeven_price numeric,
  hurdle_per_truck_day numeric, ask_price numeric,
  verdict text check (verdict in ('red','yellow','green')),
  reason text,
  decision text not null default 'pending' check (decision in ('pending','accepted','rejected')),
  settings_snapshot jsonb,
  actual_truck_days numeric, actual_hotel_nights numeric, actual_fuel numeric,
  actual_tolls numeric, actual_materials numeric, actual_extra_labor numeric,
  actual_miles numeric, actuals_at timestamptz, notes text
);
create index if not exists job_evaluations_created_idx on public.job_evaluations (created_at desc);
create table if not exists public.zip_distances (
  origin_zip text not null, dest_zip text not null, miles numeric not null,
  provider text, fetched_at timestamptz not null default now(),
  primary key (origin_zip, dest_zip)
);
create table if not exists public.zip_geo (
  zip text primary key, lat numeric not null, lng numeric not null,
  fetched_at timestamptz not null default now()
);
alter table public.job_calc_settings enable row level security;
alter table public.job_evaluations enable row level security;
alter table public.zip_distances enable row level security;
alter table public.zip_geo enable row level security;
drop policy if exists "job_calc_settings_select" on public.job_calc_settings;
create policy "job_calc_settings_select" on public.job_calc_settings
  for select to authenticated using (true);
drop policy if exists "job_calc_settings_write" on public.job_calc_settings;
create policy "job_calc_settings_write" on public.job_calc_settings
  for all to authenticated using (public.is_admin()) with check (public.is_admin());
drop policy if exists "job_evaluations_select" on public.job_evaluations;
create policy "job_evaluations_select" on public.job_evaluations
  for select to authenticated using (true);
drop policy if exists "job_evaluations_insert" on public.job_evaluations;
create policy "job_evaluations_insert" on public.job_evaluations
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "job_evaluations_update" on public.job_evaluations;
create policy "job_evaluations_update" on public.job_evaluations
  for update to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "job_evaluations_delete" on public.job_evaluations;
create policy "job_evaluations_delete" on public.job_evaluations
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "zip_distances_select" on public.zip_distances;
create policy "zip_distances_select" on public.zip_distances
  for select to authenticated using (true);
drop policy if exists "zip_geo_select" on public.zip_geo;
create policy "zip_geo_select" on public.zip_geo
  for select to authenticated using (true);
do $$ begin alter publication supabase_realtime add table public.job_evaluations; exception when others then null; end $$;`;

// ── Presentation ─────────────────────────────────────────────────────────────

const card = { background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: "16px 18px" };
const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #e5e5e5", borderRadius: 8, padding: "9px 12px", fontSize: 13, outline: "none", background: "#fff" };
const btn = (primary) => ({ padding: "8px 14px", borderRadius: 8, border: primary ? "none" : "1px solid #e5e5e5", background: primary ? "#111" : "#fff", color: primary ? "#fff" : "#444", fontSize: 13, fontWeight: 600, cursor: "pointer" });
const tabBtn = (act) => ({ fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: "10px 10px 0 0", cursor: "pointer", border: "none", borderBottom: act ? "2px solid #111" : "2px solid transparent", background: "transparent", color: act ? "#111" : "#999" });
const lbl = { fontSize: 11, fontWeight: 600, color: "#888", textTransform: "uppercase", letterSpacing: "0.05em", display: "block", marginBottom: 4 };
const grid = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(150px,1fr))", gap: 12 };

const VERDICT_STYLE = {
  [VERDICT.GREEN]: { bg: "#EAF3DE", bd: "#639922", fg: "#3B6D11" },
  [VERDICT.YELLOW]: { bg: "#FAEEDA", bd: "#EF9F27", fg: "#854F0B" },
  [VERDICT.RED]: { bg: "#FCEBEB", bd: "#E24B4A", fg: "#A32D2D" },
};

// Rounded for display — nobody negotiates in cents.
const money = (v) => (Number.isFinite(Number(v)) ? "$" + Math.round(Number(v)).toLocaleString() : "—");
const dec = (v, d = 1) => (Number.isFinite(Number(v)) ? Number(Number(v).toFixed(d)).toLocaleString() : "—");
const int = (v) => (Number.isFinite(Number(v)) ? Math.round(Number(v)).toLocaleString() : "—");

const ACCESS_LABELS = [
  { value: "direct", label: "Direct" },
  { value: "elevator", label: "Elevator" },
  { value: "stairs", label: "Stairs" },
];

// The settings editor. Grouped, English labels (the i18n checker audits every
// `label` property here), and each one carries its trust flag from jobCalcData.
const SETTING_GROUPS = [
  { section: "Crew", keys: ["driverDayRate", "helperDayRate"] },
  { section: "Operation", keys: ["fuelCostPerMile", "avgSpeedMph", "usefulHoursPerDay"] },
  { section: "Productivity", keys: ["cuFtPerHour", "longCarryUplift", "shuttleUplift"] },
  { section: "Fixed cost per truck", keys: ["insuranceMonthlyPerTruck", "maintenanceReserveMonthlyPerTruck", "depreciationMonthlyPerTruck", "overheadMonthly", "activeTrucks"] },
  { section: "Per-unit cost", keys: ["hotelPerNight", "tollPerMile", "materialsPerCuFt", "damagesReservePct", "contingencyPct"] },
  { section: "Decision", keys: ["workedDaysPerMonth", "targetMarginPct", "longDistanceThresholdMiles"] },
  { section: "Base", keys: ["baseZip"] },
];

const SETTING_LABELS = {
  driverDayRate: { label: "Driver day rate" },
  helperDayRate: { label: "Helper day rate" },
  fuelCostPerMile: { label: "Fuel cost per mile" },
  avgSpeedMph: { label: "Average speed (mph)" },
  usefulHoursPerDay: { label: "Useful hours per day" },
  cuFtPerHour: { label: "Cu ft per hour" },
  longCarryUplift: { label: "Long carry uplift" },
  shuttleUplift: { label: "Shuttle uplift" },
  insuranceMonthlyPerTruck: { label: "Insurance per month" },
  maintenanceReserveMonthlyPerTruck: { label: "Maintenance reserve per month" },
  depreciationMonthlyPerTruck: { label: "Depreciation per month" },
  overheadMonthly: { label: "Overhead per month" },
  activeTrucks: { label: "Active trucks" },
  hotelPerNight: { label: "Hotel per night" },
  tollPerMile: { label: "Tolls per mile" },
  materialsPerCuFt: { label: "Materials per cu ft" },
  damagesReservePct: { label: "Damages reserve" },
  contingencyPct: { label: "Contingency" },
  workedDaysPerMonth: { label: "Worked days per month" },
  targetMarginPct: { label: "Target margin" },
  longDistanceThresholdMiles: { label: "Long distance threshold (mi)" },
  baseZip: { label: "Base ZIP" },
};

const FLAG_STYLE = {
  pending: { bg: "#FCEBEB", fg: "#A32D2D", text: "PENDING" },
  uncalibrated: { bg: "#FAEEDA", fg: "#854F0B", text: "UNCALIBRATED" },
  unvalidated: { bg: "#FAEEDA", fg: "#854F0B", text: "UNVALIDATED" },
};

function FlagBadge({ flag }) {
  const f = FLAG_STYLE[flag];
  if (!f) return null;
  return (
    <span style={{ fontSize: 9, fontWeight: 800, padding: "2px 6px", borderRadius: 5, background: f.bg, color: f.fg, letterSpacing: "0.04em", marginLeft: 6 }}>
      {f.text}
    </span>
  );
}

function Row({ label, value, strong, tone }) {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12, padding: "5px 0", borderBottom: "1px solid #f6f6f6" }}>
      <span style={{ fontSize: 12.5, color: strong ? "#111" : "#777", fontWeight: strong ? 700 : 500 }}>{label}</span>
      <span style={{ fontSize: strong ? 14 : 13, fontWeight: strong ? 800 : 600, color: tone || "#111", whiteSpace: "nowrap" }}>{value}</span>
    </div>
  );
}

function Collapsible({ title, defaultOpen = false, children }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div style={{ ...card, padding: "12px 16px" }}>
      <button type="button" onClick={() => setOpen((o) => !o)}
        style={{ width: "100%", display: "flex", alignItems: "center", gap: 8, background: "none", border: "none", cursor: "pointer", padding: "4px 0", textAlign: "left" }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: "#666", textTransform: "uppercase", letterSpacing: "0.07em" }}>{title}</span>
        <span style={{ flex: 1 }} />
        <span style={{ color: "#bbb", fontSize: 11, transform: open ? "rotate(90deg)" : "none", transition: "transform .15s" }}>▸</span>
      </button>
      {open && <div style={{ paddingTop: 10 }}>{children}</div>}
    </div>
  );
}

// One-line explanation of the light. The operator has to know WHY, and on red or
// yellow, what to counter-offer.
function reasonText(reason, r) {
  if (reason === REASON.NEGATIVE_CONTRIBUTION)
    return tr(
      `The price does not even cover the variable cost of ${money(r.variableCost)}.`,
      `El precio no cubre ni el costo variable de ${money(r.variableCost)}.`
    );
  if (reason === REASON.BELOW_FIXED)
    return tr(
      `${money(r.contributionPerTruckDay)} per truck-day is below the ${money(r.fixedPerWorkedDay)} of fixed cost each working day has to absorb.`,
      `${money(r.contributionPerTruckDay)} por día-camión está por debajo de los ${money(r.fixedPerWorkedDay)} de costo fijo que tiene que absorber cada día trabajado.`
    );
  if (reason === REASON.BELOW_HURDLE)
    return tr(
      `It covers its costs but falls short of the ${money(r.hurdlePerTruckDay)} per truck-day the target margin needs.`,
      `Cubre sus costos pero no llega a los ${money(r.hurdlePerTruckDay)} por día-camión que pide el margen objetivo.`
    );
  if (reason === REASON.STRESS_NEGATIVE)
    return tr(
      `Fine as planned, but one extra day plus 20% more miles turns it into a ${money(Math.abs(r.worstStress.operatingMargin))} loss.`,
      `Bien como está planeado, pero con un día más y 20% más de millas se da vuelta y pierde ${money(Math.abs(r.worstStress.operatingMargin))}.`
    );
  return tr(
    `${money(r.contributionPerTruckDay)} per truck-day, above the ${money(r.hurdlePerTruckDay)} threshold, and it holds up under stress.`,
    `${money(r.contributionPerTruckDay)} por día-camión, arriba del umbral de ${money(r.hurdlePerTruckDay)}, y aguanta los escenarios de estrés.`
  );
}

const SCENARIO_LABELS = {
  extraDay: { label: "+1 day" },
  extraMiles: { label: "+20% miles" },
  both: { label: "Both together" },
};

const EMPTY_INPUTS = {
  originZip: "", destZip: "", cuFt: "", brokerPrice: "",
  originAccess: "direct", destAccess: "direct", longCarry: false, shuttle: false,
};

const EMPTY_ACTUALS = {
  actual_truck_days: "", actual_hotel_nights: "", actual_fuel: "",
  actual_tolls: "", actual_materials: "", actual_extra_labor: "", actual_miles: "",
};

// ── Section ──────────────────────────────────────────────────────────────────

export function JobCalcSection({ supabase, session, profile, can = () => true, isAdmin = false, Btn, Modal }) {
  const [tab, setTab] = useState("evaluate");
  const [missing, setMissing] = useState(false);
  const [sqlCopied, setSqlCopied] = useState(false);
  const [loading, setLoading] = useState(true);

  const [saved, setSaved] = useState(null);       // raw settings row from the DB
  const [draft, setDraft] = useState(null);       // settings being edited
  const [savingSettings, setSavingSettings] = useState(false);

  const [inputs, setInputs] = useState(EMPTY_INPUTS);
  const [truckDaysOverride, setTruckDaysOverride] = useState("");

  const [miles, setMiles] = useState({ loading: false, error: null, loadedMiles: null, deadheadMiles: 0, deadheadKnown: false, manual: false });
  const [rows, setRows] = useState([]);
  const [savingEval, setSavingEval] = useState(false);
  const [actualsFor, setActualsFor] = useState(null);   // evaluation row being closed out
  const [actuals, setActuals] = useState(EMPTY_ACTUALS);
  const [err, setErr] = useState(null);

  const settings = useMemo(() => mergeSettings(saved), [saved]);
  const canEditSettings = isAdmin;

  const isMissingErr = (error) => error && (error.code === "42P01" || /job_calc|job_evaluations/.test(error.message || ""));

  const load = useCallback(async () => {
    const { data: s, error } = await supabase.from("job_calc_settings").select("settings").eq("id", 1).maybeSingle();
    if (isMissingErr(error)) { setMissing(true); setLoading(false); return; }
    setMissing(false);
    setSaved(s?.settings || {});
    const { data: e } = await supabase.from("job_evaluations").select("*").is("deleted_at", null).order("created_at", { ascending: false }).limit(300);
    setRows(e || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => { load(); }, [load]);

  useEffect(() => {
    if (missing) return;
    const channel = supabase.channel("jobcalc-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_evaluations" }, () => load())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [supabase, missing, load]);

  // ── Distance lookup ────────────────────────────────────────────────────────
  // Debounced so typing a ZIP does not fire five requests. Manual entry wins:
  // once the operator types the miles by hand we stop overwriting them.
  const reqSeq = useRef(0);
  const originZip = inputs.originZip.trim();
  const destZip = inputs.destZip.trim();
  const baseZip = (settings.baseZip || "").trim();

  useEffect(() => {
    if (miles.manual) return;
    if (!/^\d{5}$/.test(originZip) || !/^\d{5}$/.test(destZip)) {
      setMiles((m) => ({ ...m, loading: false, error: null, loadedMiles: null, deadheadMiles: 0, deadheadKnown: false }));
      return;
    }
    const seq = ++reqSeq.current;
    setMiles((m) => ({ ...m, loading: true, error: null }));
    const timer = setTimeout(async () => {
      try {
        const token = session?.access_token || "";
        const qs = new URLSearchParams({ origin: originZip, dest: destZip, ...(baseZip ? { base: baseZip } : {}) });
        const res = await fetch(`/api/distance?${qs}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
        const body = await res.json();
        if (seq !== reqSeq.current) return;
        if (!res.ok) throw new Error(body?.error || `HTTP ${res.status}`);
        setMiles({ loading: false, error: null, loadedMiles: body.loadedMiles, deadheadMiles: body.deadheadMiles, deadheadKnown: body.deadheadKnown, manual: false });
      } catch (e) {
        if (seq !== reqSeq.current) return;
        // Never invent a distance — surface the failure and let them type it in.
        setMiles((m) => ({ ...m, loading: false, error: e?.message || "Could not compute the route." }));
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [originZip, destZip, baseZip, miles.manual, session]);

  // ── Live evaluation ────────────────────────────────────────────────────────
  const hasMiles = miles.loadedMiles != null;
  const result = useMemo(
    () => evaluateJob(inputs, settings, { loadedMiles: miles.loadedMiles || 0, deadheadMiles: miles.deadheadMiles || 0 }, { truckDaysOverride }),
    [inputs, settings, miles.loadedMiles, miles.deadheadMiles, truckDaysOverride]
  );

  const ready = hasMiles && num(inputs.cuFt) > 0 && num(inputs.brokerPrice) > 0;
  const u = (k) => (v) => setInputs((p) => ({ ...p, [k]: v }));
  const pendingKeys = Object.keys(SETTING_FLAGS).filter((k) => SETTING_FLAGS[k] === "pending" && k !== "baseZip");

  // ── Persistence ────────────────────────────────────────────────────────────

  async function saveSettings() {
    setSavingSettings(true); setErr(null);
    const { error } = await supabase.from("job_calc_settings")
      .update({ settings: draft, updated_at: new Date().toISOString(), updated_by: session.user.id })
      .eq("id", 1);
    setSavingSettings(false);
    if (error) { setErr(error.message); return; }
    setSaved(draft); setDraft(null);
  }

  async function saveEvaluation(decision) {
    setSavingEval(true); setErr(null);
    const r = result;
    const { error } = await supabase.from("job_evaluations").insert({
      created_by: session.user.id,
      origin_zip: originZip, dest_zip: destZip,
      cu_ft: num(inputs.cuFt), broker_price: num(inputs.brokerPrice),
      origin_access: inputs.originAccess, dest_access: inputs.destAccess,
      long_carry: inputs.longCarry, shuttle: inputs.shuttle,
      loaded_miles: r.loadedMiles, deadhead_miles: r.deadheadMiles, total_miles: r.totalMiles,
      miles_manual: miles.manual,
      handling_hours: r.handlingHours, driving_hours: r.drivingHours,
      truck_days: r.truckDays, truck_days_estimated: r.truckDaysEstimated,
      truck_days_overridden: r.truckDaysOverridden, hotel_nights: r.hotelNights,
      variable_cost: r.variableCost, absorbed_fixed: r.absorbedFixed,
      contribution_margin: r.contributionMargin, contribution_per_truck_day: r.contributionPerTruckDay,
      operating_margin: r.operatingMargin, breakeven_price: r.breakevenPrice,
      hurdle_per_truck_day: r.hurdlePerTruckDay, ask_price: r.askPrice,
      verdict: r.verdict, reason: r.reason, decision,
      settings_snapshot: settings,
    });
    setSavingEval(false);
    if (error) { setErr(error.message); return; }
    load();
  }

  async function saveActuals() {
    const patch = { actuals_at: new Date().toISOString() };
    for (const k of Object.keys(EMPTY_ACTUALS)) patch[k] = actuals[k] === "" ? null : num(actuals[k]);
    const { error } = await supabase.from("job_evaluations").update(patch).eq("id", actualsFor.id);
    if (error) { setErr(error.message); return; }
    setActualsFor(null); setActuals(EMPTY_ACTUALS); load();
  }

  async function softDelete(id) {
    await supabase.from("job_evaluations").update({ deleted_at: new Date().toISOString() }).eq("id", id);
    load();
  }

  const cal = useMemo(() => calibrate(rows), [rows]);

  // ── Missing-tables banner ──────────────────────────────────────────────────
  if (missing) return (
    <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#854F0B" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>One-time setup needed</div>
      <div>The job calculator needs its tables created once. Run this SQL in Supabase (SQL Editor), or run <code>node scripts/setup-job-calc.mjs</code>.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => { navigator.clipboard?.writeText(JOB_CALC_SQL).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          {sqlCopied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={load} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — retry
        </button>
      </div>
    </div>
  );

  if (loading) return <div style={{ color: "#999", fontSize: 13 }}>Loading…</div>;

  const vs = VERDICT_STYLE[result.verdict];

  return (
    <div style={{ maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #eee", marginBottom: 14, flexWrap: "wrap" }}>
        <button style={tabBtn(tab === "evaluate")} onClick={() => setTab("evaluate")}>Evaluate</button>
        <button style={tabBtn(tab === "history")} onClick={() => setTab("history")}>History</button>
        <button style={tabBtn(tab === "calibration")} onClick={() => setTab("calibration")}>Calibration</button>
      </div>

      {err && <div style={{ background: "#FCEBEB", border: "1px solid #E24B4A", color: "#A32D2D", borderRadius: 9, padding: "9px 12px", fontSize: 12.5, marginBottom: 12 }}>{err}</div>}

      {/* ── EVALUATE ─────────────────────────────────────────────────────── */}
      {tab === "evaluate" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>

          {/* 1. Inputs — above the fold, no scrolling */}
          <div style={card}>
            <div style={grid}>
              <div>
                <label style={lbl}>Origin ZIP</label>
                <input style={inp} value={inputs.originZip} inputMode="numeric" placeholder="33125"
                  onChange={(e) => { u("originZip")(e.target.value); setMiles((m) => ({ ...m, manual: false })); }} />
              </div>
              <div>
                <label style={lbl}>Destination ZIP</label>
                <input style={inp} value={inputs.destZip} inputMode="numeric" placeholder="30301"
                  onChange={(e) => { u("destZip")(e.target.value); setMiles((m) => ({ ...m, manual: false })); }} />
              </div>
              <div>
                <label style={lbl}>Cu ft</label>
                <input style={inp} value={inputs.cuFt} inputMode="decimal" placeholder="1200" onChange={(e) => u("cuFt")(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Broker price</label>
                <input style={inp} value={inputs.brokerPrice} inputMode="decimal" placeholder="4800" onChange={(e) => u("brokerPrice")(e.target.value)} />
              </div>
              <div>
                <label style={lbl}>Origin access</label>
                <select style={inp} value={inputs.originAccess} onChange={(e) => u("originAccess")(e.target.value)}>
                  {ACCESS_LABELS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
              <div>
                <label style={lbl}>Destination access</label>
                <select style={inp} value={inputs.destAccess} onChange={(e) => u("destAccess")(e.target.value)}>
                  {ACCESS_LABELS.map((a) => <option key={a.value} value={a.value}>{a.label}</option>)}
                </select>
              </div>
            </div>
            <div style={{ display: "flex", gap: 18, marginTop: 12, flexWrap: "wrap" }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={inputs.longCarry} onChange={(e) => u("longCarry")(e.target.checked)} /> Long carry
              </label>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, cursor: "pointer" }}>
                <input type="checkbox" checked={inputs.shuttle} onChange={(e) => u("shuttle")(e.target.checked)} /> Shuttle
              </label>
            </div>
          </div>

          {/* Distance status: loading, failure + manual fallback, missing base ZIP */}
          {miles.loading && <div style={{ fontSize: 12.5, color: "#999" }}>Looking up the route…</div>}
          {miles.error && (
            <div style={{ background: "#FCEBEB", border: "1px solid #E24B4A", borderRadius: 9, padding: "10px 12px", fontSize: 12.5, color: "#A32D2D" }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>Could not get the distance</div>
              <div style={{ marginBottom: 8 }}>{miles.error}</div>
              <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <span>Enter the miles by hand:</span>
                <input style={{ ...inp, width: 110 }} inputMode="decimal" placeholder="Loaded"
                  onChange={(e) => setMiles((m) => ({ ...m, manual: true, error: null, loadedMiles: num(e.target.value) }))} />
              </div>
            </div>
          )}
          {!baseZip && (
            <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 9, padding: "9px 12px", fontSize: 12.5, color: "#854F0B" }}>
              No base ZIP set in the settings, so deadhead miles are counted as zero and every cost below is understated.
            </div>
          )}

          {/* 2. Traffic light — the first thing anyone looks at */}
          <div style={{ background: vs.bg, border: `2px solid ${vs.bd}`, borderRadius: 14, padding: "18px 20px", opacity: ready ? 1 : 0.45 }}>
            <div style={{ fontSize: 32, fontWeight: 900, color: vs.fg, letterSpacing: "-0.02em", lineHeight: 1.1 }}>
              {result.verdict === VERDICT.GREEN ? "TAKE IT" : result.verdict === VERDICT.YELLOW ? "CAREFUL" : "DO NOT TAKE IT"}
            </div>
            <div style={{ fontSize: 13, color: vs.fg, marginTop: 7, lineHeight: 1.45 }}>
              {ready ? reasonText(result.reason, result) : tr("Enter the ZIPs, the volume and the broker price.", "Cargá los ZIP, el volumen y el precio del broker.")}
            </div>
          </div>

          {/* 3. The headline metric, next to the threshold it has to beat */}
          <div style={{ ...card, display: "flex", gap: 14, flexWrap: "wrap" }}>
            <div style={{ flex: "1 1 150px" }}>
              <div style={lbl}>Contribution per truck-day</div>
              <div style={{ fontSize: 26, fontWeight: 800, letterSpacing: "-0.02em" }}>{money(result.contributionPerTruckDay)}</div>
            </div>
            <div style={{ flex: "1 1 150px" }}>
              <div style={lbl}>Threshold to beat</div>
              <div style={{ fontSize: 26, fontWeight: 800, color: "#999", letterSpacing: "-0.02em" }}>{money(result.hurdlePerTruckDay)}</div>
              <div style={{ fontSize: 11, color: "#aaa", marginTop: 2 }}>Fixed floor {money(result.fixedPerWorkedDay)}</div>
            </div>
          </div>

          {/* 4. Ask price — what to counter-offer. Loudest when the light is not green. */}
          {result.verdict !== VERDICT.GREEN && (
            <div style={{ ...card, background: "#111", border: "none" }}>
              <div style={{ ...lbl, color: "#888" }}>Ask the broker for</div>
              <div style={{ fontSize: 30, fontWeight: 900, color: "#fff", letterSpacing: "-0.02em" }}>{money(result.askPrice)}</div>
              <div style={{ fontSize: 12, color: "#999", marginTop: 4 }}>
                {tr(
                  `${money(result.askPrice - num(inputs.brokerPrice))} above what they are offering. Break-even is ${money(result.breakevenPrice)}.`,
                  `${money(result.askPrice - num(inputs.brokerPrice))} más de lo que están ofreciendo. El punto de equilibrio es ${money(result.breakevenPrice)}.`
                )}
              </div>
            </div>
          )}

          {/* 5. What the app worked out on its own */}
          <Collapsible title="Estimate" defaultOpen>
            <Row label="Loaded miles" value={int(result.loadedMiles)} />
            <Row label="Deadhead miles" value={int(result.deadheadMiles)} />
            <Row label="Total miles" value={int(result.totalMiles)} strong />
            <Row label="Handling hours" value={dec(result.handlingHours)} />
            <Row label="Driving hours" value={dec(result.drivingHours)} />
            <Row label="Hotel nights" value={int(result.hotelNights)} />
            <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, flexWrap: "wrap" }}>
              <label style={lbl}>Truck-days</label>
              <input style={{ ...inp, width: 90 }} inputMode="decimal" value={truckDaysOverride}
                placeholder={String(result.truckDaysEstimated)} onChange={(e) => setTruckDaysOverride(e.target.value)} />
              {result.truckDaysOverridden && (
                <button style={btn(false)} onClick={() => setTruckDaysOverride("")}>Reset to {result.truckDaysEstimated}</button>
              )}
              <span style={{ fontSize: 11.5, color: "#aaa" }}>Override it if you know this job is unusual.</span>
            </div>
          </Collapsible>

          {/* 6. The money */}
          <Collapsible title="Cost breakdown" defaultOpen>
            <Row label="Crew" value={money(result.crew)} />
            <Row label="Fuel" value={money(result.fuel)} />
            <Row label="Hotel" value={money(result.hotel)} />
            <Row label="Tolls" value={money(result.tolls)} />
            <Row label="Materials" value={money(result.materials)} />
            <Row label="Damages reserve" value={money(result.damages)} />
            <Row label="Contingency" value={money(result.contingency)} />
            <Row label="Variable cost" value={money(result.variableCost)} strong />
            <Row label="Absorbed fixed cost" value={money(result.absorbedFixed)} />
            <Row label="Contribution margin" value={money(result.contributionMargin)} />
            <Row label="Operating margin" value={money(result.operatingMargin)} strong
              tone={result.operatingMargin < 0 ? "#A32D2D" : "#3B6D11"} />
            <Row label="Break-even price" value={money(result.breakevenPrice)} />
            {pendingKeys.length > 0 && (
              <div style={{ fontSize: 11.5, color: "#854F0B", background: "#FAEEDA", borderRadius: 8, padding: "8px 10px", marginTop: 10, lineHeight: 1.45 }}>
                {tr(
                  `${pendingKeys.length} cost parameters are still at zero because nobody has measured them yet, so the real cost is higher than this.`,
                  `${pendingKeys.length} parámetros de costo siguen en cero porque nadie los midió todavía, así que el costo real es más alto que este.`
                )}
              </div>
            )}
          </Collapsible>

          {/* 7. Stress */}
          <Collapsible title="Stress scenarios">
            {result.stress.map((s) => (
              <Row key={s.id} label={SCENARIO_LABELS[s.id].label} value={money(s.operatingMargin)}
                tone={s.operatingMargin < 0 ? "#A32D2D" : "#3B6D11"} />
            ))}
            <div style={{ fontSize: 11.5, color: "#aaa", marginTop: 8, lineHeight: 1.45 }}>
              Operating margin if the job runs longer or longer-distance than estimated.
            </div>
          </Collapsible>

          {ready && can("jobcalc", "create") && (
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <Btn primary disabled={savingEval} onClick={() => saveEvaluation("accepted")}>Save as accepted</Btn>
              <Btn disabled={savingEval} onClick={() => saveEvaluation("rejected")}>Save as rejected</Btn>
            </div>
          )}

          {/* 8. Settings, collapsed at the end */}
          <Collapsible title="Settings">
            {!canEditSettings && <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>Only an admin can change these.</div>}
            {SETTING_GROUPS.map((g) => (
              <div key={g.section} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 10.5, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>{g.section}</div>
                <div style={grid}>
                  {g.keys.map((k) => (
                    <div key={k}>
                      <label style={lbl}>
                        {SETTING_LABELS[k].label}
                        <FlagBadge flag={SETTING_FLAGS[k]} />
                      </label>
                      <input style={inp} disabled={!canEditSettings}
                        value={(draft ?? settings)[k] ?? ""}
                        inputMode={k === "baseZip" ? "numeric" : "decimal"}
                        onChange={(e) => setDraft({ ...(draft ?? settings), [k]: k === "baseZip" ? e.target.value : num(e.target.value) })} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
            <div style={{ marginBottom: 14 }}>
              <div style={{ fontSize: 10.5, fontWeight: 700, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.07em", marginBottom: 7 }}>
                Access multipliers <FlagBadge flag="uncalibrated" />
              </div>
              <div style={grid}>
                {ACCESS_TYPES.map((a) => (
                  <div key={a}>
                    <label style={lbl}>{ACCESS_LABELS.find((x) => x.value === a).label}</label>
                    <input style={inp} disabled={!canEditSettings} inputMode="decimal"
                      value={(draft ?? settings).accessMultiplier[a] ?? ""}
                      onChange={(e) => {
                        const base = draft ?? settings;
                        setDraft({ ...base, accessMultiplier: { ...base.accessMultiplier, [a]: num(e.target.value) } });
                      }} />
                  </div>
                ))}
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "#854F0B", background: "#FAEEDA", borderRadius: 8, padding: "9px 11px", lineHeight: 1.45, marginBottom: 12 }}>
              Anything flagged above is an assumption, not a measurement. The traffic light is only as good as these numbers — the Calibration tab replaces them with what really happened.
            </div>
            <div style={{ fontSize: 12, color: "#777", marginBottom: 10 }}>
              {tr(`Crew day rate: ${money(crewDayRate(draft ?? settings))} (driver + helper).`,
                  `Costo de tripulación por día: ${money(crewDayRate(draft ?? settings))} (driver + helper).`)}
            </div>
            {canEditSettings && draft && (
              <div style={{ display: "flex", gap: 8 }}>
                <Btn primary disabled={savingSettings} onClick={saveSettings}>Save settings</Btn>
                <Btn onClick={() => setDraft(null)}>Discard</Btn>
              </div>
            )}
          </Collapsible>
        </div>
      )}

      {/* ── HISTORY ──────────────────────────────────────────────────────── */}
      {tab === "history" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {rows.length === 0 && <div style={{ ...card, color: "#999", fontSize: 13 }}>No jobs evaluated yet.</div>}
          {rows.map((r) => {
            const st = VERDICT_STYLE[r.verdict] || VERDICT_STYLE[VERDICT.YELLOW];
            return (
              <div key={r.id} style={card}>
                <div style={{ display: "flex", justifyContent: "space-between", gap: 10, flexWrap: "wrap", alignItems: "center" }}>
                  <div>
                    <div style={{ fontWeight: 700, fontSize: 14 }}>{r.origin_zip} → {r.dest_zip}</div>
                    <div style={{ fontSize: 12, color: "#999", marginTop: 2 }}>
                      {int(r.cu_ft)} cu ft · {money(r.broker_price)} · {dec(r.truck_days)} truck-days
                    </div>
                  </div>
                  <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: st.bg, color: st.fg }}>
                    {money(r.contribution_per_truck_day)} / day
                  </span>
                </div>
                <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
                  <Btn onClick={() => { setActualsFor(r); setActuals(EMPTY_ACTUALS); }}>
                    {r.actuals_at ? "Edit actuals" : "Record actuals"}
                  </Btn>
                  {(r.created_by === session.user.id || isAdmin) && <Btn danger onClick={() => softDelete(r.id)}>Delete</Btn>}
                </div>
                {r.actuals_at && (
                  <div style={{ fontSize: 12, color: "#777", marginTop: 8 }}>
                    {tr(`Actual: ${dec(r.actual_truck_days)} truck-days vs ${dec(r.truck_days)} estimated.`,
                        `Real: ${dec(r.actual_truck_days)} días-camión contra ${dec(r.truck_days)} estimados.`)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* ── CALIBRATION ──────────────────────────────────────────────────── */}
      {tab === "calibration" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={card}>
            <div style={{ fontSize: 13, color: "#777", lineHeight: 1.5 }}>
              {tr(`Derived from ${cal.sampleSize} executed jobs. Each parameter shows how many jobs it rests on — two jobs is a rumour, not a measurement.`,
                  `Derivado de ${cal.sampleSize} trabajos ejecutados. Cada parámetro muestra sobre cuántos trabajos se apoya — dos trabajos es un rumor, no una medición.`)}
            </div>
          </div>
          <div style={card}>
            <Row label="Cu ft per hour" value={cal.cuFtPerHour ? `${dec(cal.cuFtPerHour)} (${cal.cuFtPerHourSamples})` : "—"} />
            {ACCESS_TYPES.map((a) => (
              <Row key={a} label={ACCESS_LABELS.find((x) => x.value === a).label}
                value={cal.accessMultiplier[a] ? `${dec(cal.accessMultiplier[a], 2)} (${cal.accessSamples[a]})` : "—"} />
            ))}
            <Row label="Fuel cost per mile" value={cal.fuelCostPerMile ? `${dec(cal.fuelCostPerMile, 2)} (${cal.fuelSamples})` : "—"} />
            <Row label="Tolls per mile" value={cal.tollPerMile != null ? `${dec(cal.tollPerMile, 2)} (${cal.tollSamples})` : "—"} />
            <Row label="Materials per cu ft" value={cal.materialsPerCuFt != null ? `${dec(cal.materialsPerCuFt, 2)} (${cal.materialSamples})` : "—"} />
            <Row label="Average day deviation" value={cal.dayDeviation != null ? `${dec(cal.dayDeviation, 2)} days` : "—"} strong />
          </div>
          {canEditSettings && cal.sampleSize > 0 && (
            <Btn primary onClick={async () => {
              const patch = { ...settings, ...calibrationPatch(cal, settings) };
              setDraft(patch);
              const { error } = await supabase.from("job_calc_settings")
                .update({ settings: patch, updated_at: new Date().toISOString(), updated_by: session.user.id }).eq("id", 1);
              if (error) { setErr(error.message); return; }
              setSaved(patch); setDraft(null); setTab("evaluate");
            }}>Apply these to the settings</Btn>
          )}
        </div>
      )}

      {/* Actuals modal — what really happened, which is what feeds calibration */}
      {actualsFor && (
        <Modal title={tr("What actually happened", "Qué pasó realmente")} onClose={() => setActualsFor(null)}
          footer={<><Btn onClick={() => setActualsFor(null)}>Cancel</Btn><Btn primary onClick={saveActuals}>Save</Btn></>}>
          <div style={grid}>
            <div><label style={lbl}>Actual truck-days</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_truck_days} onChange={(e) => setActuals((a) => ({ ...a, actual_truck_days: e.target.value }))} /></div>
            <div><label style={lbl}>Actual hotel nights</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_hotel_nights} onChange={(e) => setActuals((a) => ({ ...a, actual_hotel_nights: e.target.value }))} /></div>
            <div><label style={lbl}>Actual miles</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_miles} onChange={(e) => setActuals((a) => ({ ...a, actual_miles: e.target.value }))} /></div>
            <div><label style={lbl}>Fuel actually paid</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_fuel} onChange={(e) => setActuals((a) => ({ ...a, actual_fuel: e.target.value }))} /></div>
            <div><label style={lbl}>Tolls actually paid</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_tolls} onChange={(e) => setActuals((a) => ({ ...a, actual_tolls: e.target.value }))} /></div>
            <div><label style={lbl}>Materials actually used</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_materials} onChange={(e) => setActuals((a) => ({ ...a, actual_materials: e.target.value }))} /></div>
            <div><label style={lbl}>Extra labor hired</label>
              <input style={inp} inputMode="decimal" value={actuals.actual_extra_labor} onChange={(e) => setActuals((a) => ({ ...a, actual_extra_labor: e.target.value }))} /></div>
          </div>
          <div style={{ fontSize: 11.5, color: "#999", marginTop: 12, lineHeight: 1.45 }}>
            Actual miles should come off the ELD, not off the estimate.
          </div>
        </Modal>
      )}
    </div>
  );
}
