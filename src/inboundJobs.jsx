// Incoming Jobs — the review queue for jobs that arrived by email.
//
// The daily cron (api/agent-hub.mjs → lib/inboundMail.mjs) reads the broker
// "Moving Estimate" mails, extracts them and prices them through the same
// calculator the Job Calculator uses, leaving job_evaluations rows with
// decision='pending'. This module is where a human decides.
//
// Accepting does NOT write the job from here. It pre-fills the app's own
// "+ New job" form and opens it, so saveJob() performs the write with all its
// normalization, migration guards, undo and action_log intact.
//
// Tables: job_evaluations (extended by scripts/setup-inbound-jobs.mjs)
import { useState, useEffect, useCallback, useMemo } from "react";
import { tr } from "./i18n.js";
import { evaluateJob, profitRange, mergeSettings, VERDICT } from "./jobCalcData.js";
import { estimateToJobForm, estimateToJobInput, pricingBasis, PRICING_BASIS } from "./inboundJobData.js";

const VERDICT_META = {
  [VERDICT.GREEN]: { label: "TAKE IT", bg: "#EAF3DE", bd: "#639922", fg: "#3B6D11" },
  [VERDICT.YELLOW]: { label: "CAREFUL", bg: "#FAEEDA", bd: "#EF9F27", fg: "#854F0B" },
  [VERDICT.RED]: { label: "DO NOT TAKE IT", bg: "#FCEBEB", bd: "#E24B4A", fg: "#A32D2D" },
};

const card = { background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: "16px 18px" };
const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #e5e5e5", borderRadius: 8, padding: "8px 10px", fontSize: 13, outline: "none", background: "#fff" };
const btn = (primary) => ({ padding: "8px 14px", borderRadius: 8, border: primary ? "none" : "1px solid #e5e5e5", background: primary ? "#111" : "#fff", color: primary ? "#fff" : "#444", fontSize: 13, fontWeight: 600, cursor: "pointer" });
const chip = (bg, color) => ({ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: bg, color });
const lbl = { fontSize: 10.5, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.04em", fontWeight: 600, marginBottom: 2 };
const warn = (bg, bd, fg) => ({ marginTop: 10, background: bg, border: `1px solid ${bd}`, borderRadius: 8, padding: "8px 10px", fontSize: 12.5, color: fg });

const money = (n) => (n == null || !isFinite(n) ? "—" : (n < 0 ? "-$" : "$") + Math.abs(Math.round(n)).toLocaleString("en-US"));
const pct = (n) => (n == null || !isFinite(n) ? "—" : Math.round(n * 100) + "%");
const fmtDate = (ts) => (ts ? new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" }) : "—");

const isMissingErr = (error) =>
  !!error && (error.code === "42703" || error.code === "PGRST204" || /source|gmail_message_id/i.test(error.message || ""));

// Re-price one queued row from whatever the operator has typed into its card.
// Exported so scripts/test-inbound-render.mjs can exercise it directly: this is
// the only non-trivial logic in the module, and it must agree with the Job
// Calculator because it calls the very same evaluateJob.
export function priceRow(row, edit = {}, settings = {}) {
  const p = row.parsed || {};
  const parsed = {
    ...p,
    volume_cf: edit.cuFt != null && edit.cuFt !== "" ? Number(edit.cuFt) : p.volume_cf,
    pickup_zip: row.origin_zip,
    delivery_zip: row.dest_zip,
  };
  const carrierRatePerCf = edit.carrierRate != null && edit.carrierRate !== "" ? Number(edit.carrierRate) : row.carrier_rate_per_cf;
  const basis = pricingBasis(parsed, { carrierRatePerCf });
  const input = estimateToJobInput(parsed, { carrierRatePerCf });

  const loadedMiles = edit.miles?.loadedMiles ?? row.loaded_miles;
  const deadheadMiles = edit.miles?.deadheadMiles ?? row.deadhead_miles;
  const hasMiles = loadedMiles != null;

  let result = null, range = null;
  if (hasMiles && input.cuFt > 0 && input.brokerPrice > 0) {
    result = evaluateJob(input, settings, {
      loadedMiles: Number(loadedMiles) || 0,
      deadheadMiles: Number(deadheadMiles) || 0,
    });
    try {
      range = profitRange(input, settings, {
        loadedMiles: Number(loadedMiles) || 0,
        // Only the round-trip total was stored; split it evenly so the range's
        // one-way scenario stays meaningful until the card looks the legs up.
        deadheadOutMiles: edit.miles?.deadheadOutMiles ?? (Number(deadheadMiles) || 0) / 2,
        deadheadBackMiles: edit.miles?.deadheadBackMiles ?? (Number(deadheadMiles) || 0) / 2,
      });
    } catch { range = null; }
  }
  return {
    row, parsed, basis, result, range, hasMiles, loadedMiles, deadheadMiles, carrierRatePerCf,
    validation: p._validation || { ok: true, blocking: [], missing: [] },
    issues: p._issues || [],
  };
}

// One queued job. Presentational: every mutation goes back out through a
// callback, which is what makes it renderable in isolation by the smoke test.
export function InboundJobCard({
  x, canEdit = true, edit = {}, busy = false, mailOpen = false, showRejected = false,
  onEdit = () => {}, onToggleMail = () => {}, onFetchMiles = () => {},
  onAccept = () => {}, onReject = () => {}, onReopen = () => {},
}) {
  const r = x.row;
  const vm = x.result ? VERDICT_META[x.result.verdict] : null;

  return (
    <div style={{ ...card, borderColor: vm ? vm.bd : "#efefef" }}>
      {/* header */}
      <div style={{ display: "flex", alignItems: "flex-start", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: 1, minWidth: 220 }}>
          <div style={{ fontSize: 15, fontWeight: 700, color: "#111" }}>
            {r.job_number || tr("No job number", "Sin job number")}{r.customer ? ` · ${r.customer}` : ""}
          </div>
          <div style={{ fontSize: 12.5, color: "#888", marginTop: 2 }}>
            {r.broker || tr("Unknown broker", "Broker desconocido")} · {fmtDate(r.received_at)}
            {r.pickup_date_from ? ` · ${tr("pickup", "pickup")} ${r.pickup_date_from}` : ""}
          </div>
        </div>
        <div style={{ textAlign: "right" }}>
          {vm ? (
            <>
              <span style={chip(vm.bg, vm.fg)}>{vm.label}</span>
              <div style={{ fontSize: 20, fontWeight: 900, color: "#111", marginTop: 6, letterSpacing: "-0.02em" }}>
                {x.range ? `${money(x.range.low.operatingMargin)} – ${money(x.range.high.operatingMargin)}` : money(x.result.operatingMargin)}
              </div>
              <div style={{ fontSize: 12, color: "#888", fontWeight: 600 }}>
                {x.range ? `${pct(x.range.low.marginPct)} – ${pct(x.range.high.marginPct)}` : pct(x.result.totalRevenue ? x.result.operatingMargin / x.result.totalRevenue : null)}
              </div>
            </>
          ) : (
            <span style={chip("#f3f3f3", "#888")}>Not priced yet</span>
          )}
        </div>
      </div>

      {/* warnings */}
      {!x.validation.ok && (
        <div style={warn("#FCEBEB", "#E24B4A", "#A32D2D")}>
          <strong>Cannot be priced yet.</strong> {tr("Missing: ", "Falta: ")}{x.validation.blocking.join(", ")}
        </div>
      )}
      {x.issues.length > 0 && (
        <div style={warn("#FAEEDA", "#EF9F27", "#854F0B")}>
          <strong>Check these against the email.</strong>{" "}
          {x.issues.map((i) => tr(
            `${i.field}: read "${i.source}", extracted "${i.model}"`,
            `${i.field}: en el mail dice "${i.source}", se extrajo "${i.model}"`
          )).join(" · ")}
        </div>
      )}
      {x.basis.basis === PRICING_BASIS.CUSTOMER_TOTAL && (
        <div style={warn("#FAEEDA", "#EF9F27", "#854F0B")}>
          <strong>Priced on the customer total, not on what the broker pays us.</strong>{" "}
          Enter the carrier rate below to see the real profit.
        </div>
      )}

      {/* numbers */}
      <div style={{ marginTop: 12, display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: 12 }}>
        <div>
          <div style={lbl}>Volume CF</div>
          <input style={inp} disabled={!canEdit} value={edit.cuFt ?? r.cu_ft ?? ""}
            onChange={(ev) => onEdit({ cuFt: ev.target.value })} />
        </div>
        <div>
          <div style={lbl}>Carrier rate $/CF</div>
          <input style={inp} disabled={!canEdit} placeholder={tr("what they pay us", "lo que nos pagan")}
            value={edit.carrierRate ?? r.carrier_rate_per_cf ?? ""}
            onChange={(ev) => onEdit({ carrierRate: ev.target.value })} />
        </div>
        <div>
          <div style={lbl}>Route</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111", padding: "8px 0" }}>
            {r.origin_zip || "?"} → {r.dest_zip || "?"}
          </div>
        </div>
        <div>
          <div style={lbl}>Miles</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111", padding: "8px 0" }}>
            {x.hasMiles ? Math.round(Number(x.loadedMiles) + Number(x.deadheadMiles || 0)) : (
              <button onClick={onFetchMiles} disabled={busy || !r.origin_zip || !r.dest_zip}
                style={{ ...btn(false), padding: "4px 10px", fontSize: 12 }}>
                {busy ? "Looking up..." : "Look up"}
              </button>
            )}
          </div>
        </div>
        <div>
          <div style={lbl}>Customer pays</div>
          <div style={{ fontSize: 13, fontWeight: 600, color: "#111", padding: "8px 0" }}>{money(r.estimate)}</div>
        </div>
      </div>

      {/* actions */}
      <div style={{ marginTop: 14, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        {!showRejected ? (
          <>
            <button onClick={onAccept} disabled={!canEdit} style={btn(true)}>Accept — open the job form</button>
            <button onClick={onReject} disabled={!canEdit || busy} style={btn(false)}>Reject</button>
          </>
        ) : (
          <button onClick={onReopen} disabled={!canEdit || busy} style={btn(false)}>Move back to pending</button>
        )}
        <button onClick={onToggleMail} style={{ ...btn(false), border: "none", color: "#888" }}>
          {mailOpen ? "Hide the email" : "Read the email"}
        </button>
        {x.result && (
          <span style={{ fontSize: 12, color: "#888", marginLeft: "auto" }}>
            {tr(
              `${x.result.truckDays} truck-days · ask ${money(x.result.askPrice)}`,
              `${x.result.truckDays} truck-days · pedir ${money(x.result.askPrice)}`
            )}
          </span>
        )}
      </div>

      {mailOpen && (
        <pre style={{ marginTop: 12, background: "#fafafa", border: "1px solid #eee", borderRadius: 8, padding: 12, fontSize: 11.5, lineHeight: 1.5, maxHeight: 340, overflow: "auto", whiteSpace: "pre-wrap" }}>
          {r.raw_body || r.parsed?._subject || tr("The email body was not stored.", "El cuerpo del mail no quedó guardado.")}
        </pre>
      )}
    </div>
  );
}

export function InboundJobsSection({ supabase, session, profile, isAdmin = false, brokers = [], onPrefillJob }) {
  const [missing, setMissing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [rows, setRows] = useState([]);
  const [settings, setSettings] = useState({});
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState(null);
  const [edits, setEdits] = useState({});      // row id → { carrierRate, cuFt, miles }
  const [openMail, setOpenMail] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [showRejected, setShowRejected] = useState(false);

  const canEdit = isAdmin || !!profile?.permissions?.jobcalc?.edit;

  const load = useCallback(async () => {
    const { data, error } = await supabase
      .from("job_evaluations")
      .select("*")
      .eq("source", "gmail")
      .is("deleted_at", null)
      .order("received_at", { ascending: false })
      .limit(200);
    if (error) { if (isMissingErr(error)) setMissing(true); setLoading(false); return; }
    setMissing(false);
    setRows(data || []);
    setLoading(false);
  }, [supabase]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { data } = await supabase.from("job_calc_settings").select("settings").eq("id", 1).maybeSingle();
      if (!cancelled) setSettings(mergeSettings(data?.settings || {}));
      await load();
    })();
    return () => { cancelled = true; };
  }, [supabase, load]);

  useEffect(() => {
    const channel = supabase
      .channel("inbound-jobs-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "job_evaluations" }, () => load())
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, [supabase, load]);

  const priced = useMemo(() => rows.map((r) => priceRow(r, edits[r.id] || {}, settings)), [rows, edits, settings]);

  // Best first: the point of the queue is that the money decides the order.
  const visible = useMemo(() => {
    const wanted = showRejected ? "rejected" : "pending";
    return priced
      .filter((x) => (x.row.decision || "pending") === wanted)
      .sort((a, b) => {
        const av = a.result?.operatingMargin, bv = b.result?.operatingMargin;
        if (av == null && bv == null) return 0;
        if (av == null) return 1;   // unpriced sinks to the bottom
        if (bv == null) return -1;
        return bv - av;
      });
  }, [priced, showRejected]);

  const pendingCount = priced.filter((x) => (x.row.decision || "pending") === "pending").length;
  const rejectedCount = priced.filter((x) => x.row.decision === "rejected").length;

  async function syncNow() {
    setSyncing(true); setSyncMsg(null);
    try {
      const res = await fetch("/api/agent-hub", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
        body: JSON.stringify({ action: "inbound_sync" }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        if (body?.setup) setMissing(true);
        setSyncMsg({ bad: true, text: body?.error || `HTTP ${res.status}` });
      } else {
        setSyncMsg({
          bad: false,
          text: tr(
            `Scanned ${body.scanned}, imported ${body.created}, already known ${body.skipped}.`,
            `Revisados ${body.scanned}, importados ${body.created}, ya conocidos ${body.skipped}.`
          ),
        });
        await load();
      }
    } catch (e) {
      setSyncMsg({ bad: true, text: e?.message || "sync failed" });
    }
    setSyncing(false);
  }

  // Look the distance up now, from the browser, where there is a real user
  // token. Same endpoint and same cache the Job Calculator uses.
  async function fetchMiles(x) {
    const r = x.row;
    if (!r.origin_zip || !r.dest_zip) return;
    setBusyId(r.id);
    try {
      const qs = new URLSearchParams({ origin: r.origin_zip, dest: r.dest_zip, ...(settings.baseZip ? { base: settings.baseZip } : {}) });
      const res = await fetch(`/api/distance?${qs}`, { headers: { Authorization: "Bearer " + session.access_token } });
      const b = await res.json();
      if (res.ok) {
        setEdits((prev) => ({ ...prev, [r.id]: { ...(prev[r.id] || {}), miles: {
          loadedMiles: b.loadedMiles, deadheadMiles: b.deadheadMiles,
          deadheadOutMiles: b.deadheadOutMiles, deadheadBackMiles: b.deadheadBackMiles,
        } } }));
      }
    } catch { /* the card just stays unpriced */ }
    setBusyId(null);
  }

  function accept(x) {
    const patch = estimateToJobForm(x.parsed, { brokers });
    // Carry the operator's own corrections into the form.
    if (x.carrierRatePerCf != null && x.carrierRatePerCf !== "") patch.carrier_rate_per_cf = String(x.carrierRatePerCf);
    onPrefillJob && onPrefillJob(patch, x.row.id);
  }

  async function reject(x) {
    if (!window.confirm(tr("Reject this job? It stays in the history for calibration.", "¿Rechazar este job? Queda en el historial para calibración."))) return;
    setBusyId(x.row.id);
    const { error } = await supabase.from("job_evaluations").update({ decision: "rejected" }).eq("id", x.row.id).select("id");
    setBusyId(null);
    if (error) { window.alert(error.message); return; }
    load();
  }

  async function reopen(x) {
    setBusyId(x.row.id);
    await supabase.from("job_evaluations").update({ decision: "pending" }).eq("id", x.row.id).select("id");
    setBusyId(null);
    load();
  }

  // ── Missing-columns banner ─────────────────────────────────────────────────
  if (missing) return (
    <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#854F0B" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>One-time setup needed</div>
      <div>Incoming Jobs needs a one-time migration on the job evaluations table. Run it and reload:</div>
      <pre style={{ background: "#fff", border: "1px solid #EF9F27", borderRadius: 7, padding: "8px 10px", marginTop: 8, fontSize: 12, overflowX: "auto" }}>SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-inbound-jobs.mjs</pre>
      <button onClick={load} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12, marginTop: 8 }}>
        I ran it — retry
      </button>
    </div>
  );

  return (
    <div style={{ maxWidth: 980 }}>
      {/* ── Toolbar ── */}
      <div style={{ ...card, marginBottom: 12, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <button onClick={() => setShowRejected(false)} style={{ ...btn(!showRejected), padding: "6px 12px" }}>
          Pending {pendingCount}
        </button>
        <button onClick={() => setShowRejected(true)} style={{ ...btn(showRejected), padding: "6px 12px" }}>
          Rejected {rejectedCount}
        </button>
        <div style={{ flex: 1 }} />
        {syncMsg && <span style={{ fontSize: 12.5, color: syncMsg.bad ? "#A32D2D" : "#3B6D11" }}>{syncMsg.text}</span>}
        <button onClick={syncNow} disabled={syncing} style={{ ...btn(true), opacity: syncing ? 0.6 : 1 }}>
          {syncing ? "Checking the mailbox..." : "Check for new jobs"}
        </button>
      </div>

      {/* ── List ── */}
      {loading ? (
        <div style={{ ...card, color: "#999", fontSize: 13 }}>Loading...</div>
      ) : visible.length === 0 ? (
        <div style={{ ...card, textAlign: "center", padding: "36px 18px" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📥</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{showRejected ? "Nothing rejected yet" : "No jobs waiting"}</div>
          <div style={{ fontSize: 12.5, color: "#999", marginTop: 4 }}>Estimates that arrive by email show up here already priced.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map((x) => (
            <InboundJobCard
              key={x.row.id}
              x={x}
              canEdit={canEdit}
              edit={edits[x.row.id] || {}}
              busy={busyId === x.row.id}
              mailOpen={openMail === x.row.id}
              showRejected={showRejected}
              onEdit={(patch) => setEdits((p) => ({ ...p, [x.row.id]: { ...(p[x.row.id] || {}), ...patch } }))}
              onToggleMail={() => setOpenMail(openMail === x.row.id ? null : x.row.id)}
              onFetchMiles={() => fetchMiles(x)}
              onAccept={() => accept(x)}
              onReject={() => reject(x)}
              onReopen={() => reopen(x)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
