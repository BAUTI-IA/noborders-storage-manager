// Analytics — dashboard de decisiones de negocio.
// UI only: todos los números salen de analyticsData.js (módulo puro).
// Strings en español directo a propósito: así no son keys del dict I18N_ES y el
// tree-walker de idioma no toca el texto SVG que maneja Recharts.
import { useMemo, useState } from "react";
import {
  ResponsiveContainer, BarChart, Bar, LineChart, Line, AreaChart, Area,
  XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine, Cell,
} from "recharts";
import { UsMarginMap } from "./usMap.jsx";
import {
  parseCf, effCf, rangeFromPreset, previousRange, buildFilterCtx,
  computeStoragePnl, computeMetrics, computeRevenueSplit, monthlyRevenueSeries,
  arAging, occupancySeries, lengthOfStayStats, brokerProfitability, marginByState,
  cfMovedSeries, dollarsPerCfSeries, faddCompliance, statusFunnel, jobsFlowSeries,
  topN, monthLabel, monthsBetween, shiftMonth,
  computeDriverPnl, fuelOutliers, materialShortages,
} from "./analyticsData.js";

// ── Formato ──────────────────────────────────────────────────────────────────
const fmtM = (v) => (v < 0 ? "−$" : "$") + Math.abs(Math.round(v)).toLocaleString();
const fmtK = (v) => {
  const a = Math.abs(v), s = v < 0 ? "−$" : "$";
  if (a >= 1e6) return s + (a / 1e6).toFixed(1) + "M";
  if (a >= 1e4) return s + Math.round(a / 1e3) + "k";
  if (a >= 1e3) return s + (a / 1e3).toFixed(1) + "k";
  return s + Math.round(a);
};
const fmtN = (v) => Math.round(v).toLocaleString();

// ── Colores (orden categórico fijo; rojo reservado a negativo/vencido) ──────
const C = {
  azul: "#185FA5", naranja: "#C2410C", verde: "#1A8A4E", violeta: "#7C3AED",
  gris: "#bbb", rojo: "#A32D2D", ambar: "#EAB308",
};

// ── Chrome compartido de charts ──────────────────────────────────────────────
const AXIS = { tick: { fontSize: 11, fill: "#999" }, axisLine: false, tickLine: false };
const GRID = <CartesianGrid stroke="#f3f3f3" vertical={false} />;
const card = { background: "#fff", borderRadius: 12, border: "1px solid #efefef", padding: 20 };
const sub = { fontSize: 12, color: "#bbb", marginBottom: 14 };

function Title({ children, chip, right }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.06em" }}>{children}</div>
      {chip && <span style={{ fontSize: 10, fontWeight: 600, color: "#999", background: "#f4f4f4", borderRadius: 20, padding: "1px 8px" }}>{chip}</span>}
      {right && <span style={{ marginLeft: "auto" }}>{right}</span>}
    </div>
  );
}

function Empty({ children }) {
  return <p style={{ fontSize: 12, color: "#bbb", textAlign: "center", padding: "26px 0 16px" }}>{children}</p>;
}

// Tooltip custom estilo card blanca (todas las charts lo usan).
function CardTooltip({ active, payload, label, fmt = fmtM }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div style={{ background: "#fff", border: "1px solid #efefef", borderRadius: 10, padding: "9px 12px", boxShadow: "0 6px 18px rgba(0,0,0,0.08)", fontSize: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 4, color: "#333" }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ display: "flex", alignItems: "center", gap: 6, padding: "1px 0" }}>
          <span style={{ width: 10, height: 3, borderRadius: 2, background: p.color || p.fill, flexShrink: 0 }} />
          <span style={{ fontWeight: 700, color: "#333" }}>{p.value == null ? "—" : fmt(p.value)}</span>
          <span style={{ color: "#999" }}>{p.name}</span>
        </div>
      ))}
    </div>
  );
}

// Leyenda HTML (solo para charts de ≥2 series).
function LegendRow({ items }) {
  return (
    <div style={{ display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11.5, color: "#666", marginBottom: 8 }}>
      {items.map(([label, color]) => (
        <span key={label} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
          <span style={{ width: 10, height: 10, borderRadius: 3, background: color }} />{label}
        </span>
      ))}
    </div>
  );
}

// KPI hero: valor grande + delta vs período anterior + sparkline.
function KpiTile({ label, value, delta, goodUp = true, spark, sparkColor = C.azul, chip }) {
  const showDelta = delta != null && isFinite(delta.pct);
  const up = showDelta && delta.pct >= 0;
  const good = showDelta && (up === goodUp);
  return (
    <div style={{ ...card, padding: "14px 16px", display: "flex", flexDirection: "column", gap: 4 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <span style={{ fontSize: 11, color: "#aaa", fontWeight: 500 }}>{label}</span>
        {chip && <span style={{ fontSize: 9.5, fontWeight: 600, color: "#999", background: "#f4f4f4", borderRadius: 20, padding: "0 7px" }}>{chip}</span>}
      </div>
      <div style={{ display: "flex", alignItems: "baseline", gap: 8, flexWrap: "wrap" }}>
        <span style={{ fontSize: 26, fontWeight: 700, color: "#111", lineHeight: 1.1 }}>{value}</span>
        {showDelta && (
          <span style={{ fontSize: 11.5, fontWeight: 700, color: good ? C.verde : C.rojo }}>
            {up ? "▲" : "▼"} {Math.abs(Math.round(delta.pct))}%
          </span>
        )}
      </div>
      {delta != null && !isFinite(delta.pct) && <span style={{ fontSize: 10.5, color: "#bbb" }}>sin período anterior</span>}
      {spark && spark.some(d => d.v) && (
        <div style={{ height: 36, marginTop: 2 }}>
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={spark} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
              <Area type="monotone" dataKey="v" stroke={sparkColor} strokeWidth={1.5} fill={sparkColor} fillOpacity={0.1} isAnimationActive={false} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}

// Hook de sort para tablas (▲▼ en el header).
function useSort(rows, initKey, initDir = "asc") {
  const [key, setKey] = useState(initKey);
  const [dir, setDir] = useState(initDir);
  const sorted = useMemo(() => {
    const out = [...rows];
    out.sort((a, b) => {
      const va = a[key], vb = b[key];
      const cmp = typeof va === "string" ? String(va).localeCompare(String(vb)) : (Number(va) || 0) - (Number(vb) || 0);
      return dir === "asc" ? cmp : -cmp;
    });
    return out;
  }, [rows, key, dir]);
  const toggle = (k) => { if (k === key) setDir(d => d === "asc" ? "desc" : "asc"); else { setKey(k); setDir("desc"); } };
  const arrow = (k) => k === key ? (dir === "asc" ? " ▲" : " ▼") : "";
  return { sorted, toggle, arrow };
}

function SortTh({ label, k, sort, align = "left" }) {
  return (
    <th onClick={() => sort.toggle(k)}
      style={{ position: "sticky", top: 0, background: "#fff", textAlign: align, padding: "6px 8px", fontSize: 10.5, color: "#999", textTransform: "uppercase", borderBottom: "1px solid #f0f0f0", cursor: "pointer", userSelect: "none", whiteSpace: "nowrap" }}>
      {label}{sort.arrow(k)}
    </th>
  );
}

const td = (extra = {}) => ({ padding: "6px 8px", borderBottom: "1px solid #f7f7f7", ...extra });

// Paginador mínimo local (mismo look que el Pager global).
function PagerLite({ page, total, pageSize, onPage, unit }) {
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const cur = Math.min(page, pages - 1);
  if (pages <= 1) return <span style={{ fontSize: 12, color: "#bbb" }}>{total} {unit}</span>;
  const btn = (dis) => ({ border: "1px solid #e5e5e5", background: dis ? "#f7f7f7" : "#fff", color: dis ? "#ccc" : "#444", borderRadius: 7, minWidth: 30, height: 28, cursor: dis ? "default" : "pointer", fontSize: 15 });
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 12, color: "#bbb" }}>{cur * pageSize + 1}–{Math.min(total, (cur + 1) * pageSize)} de {total} {unit}</span>
      <button disabled={cur <= 0} onClick={() => onPage(cur - 1)} style={btn(cur <= 0)}>←</button>
      <button disabled={cur >= pages - 1} onClick={() => onPage(cur + 1)} style={btn(cur >= pages - 1)}>→</button>
    </div>
  );
}

// Labels ES de status (inline, para que el texto dentro del SVG ya esté en español).
const STATUS_ES = {
  scheduled: "Programado", picked_up: "Recogido", in_storage: "En storage",
  out_for_delivery: "En reparto", delivered: "Entregado", cancelled: "Cancelado",
  on_hold: "En espera", redispatched: "Redespachado",
};

// ── Panel IA (movido de App.jsx; ahora recibe el resumen filtrado) ───────────
function AIPanel({ records, lang, extra }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  async function analyze() {
    setLoading(true); setResult(null);
    const active = records.filter(r => r.situation === "Open");
    const byState = active.reduce((acc, r) => { if (r.state) acc[r.state] = (acc[r.state] || 0) + 1; return acc; }, {});
    const byBrand = active.reduce((acc, r) => { if (r.brand) acc[r.brand.trim()] = (acc[r.brand.trim()] || 0) + 1; return acc; }, {});
    const withCost = active.filter(r => r.monthly_cost);
    const totalCost = withCost.reduce((s, r) => s + Number(r.monthly_cost), 0);
    const noCost = active.length - withCost.length;
    const sameState = Object.entries(byState).filter(([, v]) => v >= 3).map(([k, v]) => `${k}: ${v} storages`);
    const sameBrand = Object.entries(byBrand).filter(([, v]) => v >= 3).map(([k, v]) => `${k}: ${v} unidades`);

    const prompt = `You are an expert in US moving-company operations. Analyze this active-storage data and give me 4-6 concrete, actionable recommendations to improve efficiency and reduce costs. Be specific, direct and practical.

DATA:
- Total active storages: ${active.length}
- Total monthly cost recorded: $${totalCost.toLocaleString()} (${noCost} storages with no cost entered)
- Storages by state: ${JSON.stringify(byState)}
- Storages by company: ${JSON.stringify(byBrand)}
- States with 3+ storages: ${sameState.join(", ") || "none"}
- Companies with 3+ units: ${sameBrand.join(", ") || "none"}
${extra ? `- Current dashboard view (filtered by the operator): ${JSON.stringify(extra)}` : ""}

Format: numbered list, each recommendation in 2-3 lines max. Start directly with "1."
${lang === "es" ? "Answer in Spanish." : "Answer in English."}`;

    try {
      const res = await fetch("/api/analyze", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt })
      });
      const data = await res.json();
      if (!res.ok) setResult(data.error || (lang === "es" ? "No se pudo conectar con la IA." : "Could not connect to the AI."));
      else setResult(data.text || (lang === "es" ? "No se pudo obtener una respuesta." : "Could not get a response."));
    } catch (e) {
      setResult(lang === "es" ? "Error conectando con la IA. Intentá de nuevo." : "Error connecting to the AI. Try again.");
    }
    setLoading(false);
  }

  return (
    <div style={card}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: result ? 16 : 0 }}>
        <div>
          <Title>AI recommendations</Title>
          <div style={{ fontSize: 12, color: "#bbb" }}>Automatic analysis of your storage operation</div>
        </div>
        <button onClick={analyze} disabled={loading}
          style={{ fontSize: 13, fontWeight: 500, padding: "8px 16px", borderRadius: 8, border: "1px solid #e5e5e5", background: loading ? "#f5f5f5" : "#111", color: loading ? "#aaa" : "#fff", cursor: loading ? "not-allowed" : "pointer", flexShrink: 0, display: "flex", alignItems: "center", gap: 6 }}>
          {loading ? "Analyzing..." : "Analyze with AI"}
        </button>
      </div>
      {loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "20px 0", color: "#888", fontSize: 13 }}>
          <div style={{ width: 16, height: 16, border: "2px solid #f0f0f0", borderTop: "2px solid #111", borderRadius: "50%", animation: "spin 0.8s linear infinite", flexShrink: 0 }} />
          {lang === "es"
            ? `Analizando ${records.filter(r => r.situation === "Open").length} storages activos...`
            : `Analyzing ${records.filter(r => r.situation === "Open").length} active storages...`}
        </div>
      )}
      {result && (
        <div style={{ marginTop: 16, padding: 16, background: "#fafafa", borderRadius: 10, fontSize: 13, lineHeight: 1.7, color: "#333", whiteSpace: "pre-wrap" }}>
          {result}
        </div>
      )}
    </div>
  );
}

// ═════════════════════════════════════════════════════════════════════════════
export function AnalyticsPage({
  records, jobs, brokers, driversList, payments, jobExtras,
  sit, urgentPayments, faddStats, brokerShareMissing, paymentsMissing, lang,
  expenses = [], workDays = [], adjustments = [], materialItems = [], materialMovements = [], expensesMissing = false,
}) {
  const [todayISO] = useState(() => new Date().toISOString().slice(0, 10));
  const [preset, setPreset] = useState("6m");
  const [stateF, setStateF] = useState("");
  const [brokerF, setBrokerF] = useState("");
  const [tab, setTab] = useState("resumen");

  // ── Filtro global ──
  const range = useMemo(() => rangeFromPreset(preset, todayISO), [preset, todayISO]);
  const ctx = useMemo(
    () => buildFilterCtx({ records, jobs, jobExtras, payments, range, stateF, brokerF }),
    [records, jobs, jobExtras, payments, range, stateF, brokerF]
  );
  const prevCtx = useMemo(() => {
    const pr = previousRange(range);
    if (!pr) return null;
    return buildFilterCtx({ records, jobs, jobExtras, payments, range: pr, stateF, brokerF });
  }, [records, jobs, jobExtras, payments, range, stateF, brokerF]);

  // ── Snapshots (el rango de fechas NO aplica; el filtro de estado sí) ──
  const pnlAll = useMemo(() => computeStoragePnl(records, jobs, sit), [records, jobs, sit]);
  const pnl = useMemo(() => {
    if (!stateF) return pnlAll;
    const rows = pnlAll.rows.filter(r => r.state === stateF);
    const totals = rows.reduce((t, r) => ({ pay: t.pay + r.pay, income: t.income + r.income }), { pay: 0, income: 0 });
    return { rows, totals, missingCost: rows.filter(r => !r.hasCost).length };
  }, [pnlAll, stateF]);
  const metrics = useMemo(() => computeMetrics(ctx.records, jobs, pnl), [ctx.records, jobs, pnl]);
  const aging = useMemo(() => arAging(ctx.segGroups, todayISO), [ctx.segGroups, todayISO]);
  const byState = useMemo(() => marginByState(pnlAll.rows), [pnlAll]);

  // ── Series del período ──
  const revSeries = useMemo(() => monthlyRevenueSeries(ctx, paymentsMissing), [ctx, paymentsMissing]);
  const prevRevSeries = useMemo(() => prevCtx ? monthlyRevenueSeries(prevCtx, paymentsMissing) : null, [prevCtx, paymentsMissing]);
  const split = useMemo(
    () => computeRevenueSplit(jobs, jobExtras, ctx.keyByRowId, ctx.groupByKey, new Set(ctx.groups.map(g => g.key))),
    [jobs, jobExtras, ctx]
  );
  const prevSplit = useMemo(
    () => prevCtx ? computeRevenueSplit(jobs, jobExtras, prevCtx.keyByRowId, prevCtx.groupByKey, new Set(prevCtx.groups.map(g => g.key))) : null,
    [jobs, jobExtras, prevCtx]
  );
  const flow = useMemo(() => jobsFlowSeries(ctx), [ctx]);
  const cfSeries = useMemo(() => cfMovedSeries(ctx), [ctx]);
  const perCf = useMemo(() => dollarsPerCfSeries(ctx), [ctx]);
  const occup = useMemo(() => {
    const from = shiftMonth(range.toMonth, -11);
    return occupancySeries(ctx.records, ctx.allGroups, monthsBetween(from, range.toMonth));
  }, [ctx, range.toMonth]);
  const stay = useMemo(() => lengthOfStayStats(ctx.groups), [ctx]);
  const brokerRank = useMemo(() => brokerProfitability(ctx, brokers), [ctx, brokers]);
  const fadd = useMemo(() => faddCompliance(ctx), [ctx]);
  const funnel = useMemo(() => statusFunnel(ctx.groups).map(s => ({ ...s, l: STATUS_ES[s.v] || s.l })), [ctx]);

  // KPIs con delta
  const collected = useMemo(() => revSeries.reduce((s, r) => s + r.collected, 0), [revSeries]);
  const prevCollected = useMemo(() => prevRevSeries ? prevRevSeries.reduce((s, r) => s + r.collected, 0) : null, [prevRevSeries]);
  const delta = (cur, prev) => prev == null ? null : { pct: prev === 0 ? (cur === 0 ? 0 : Infinity) : (cur - prev) / prev * 100 };
  const cfTotal = useMemo(() => cfSeries.reduce((s, r) => s + r.cf, 0), [cfSeries]);
  const prevCfTotal = useMemo(() => prevCtx ? cfMovedSeries(prevCtx).reduce((s, r) => s + r.cf, 0) : null, [prevCtx]);
  const jobsNew = ctx.groups.length;
  const prevJobsNew = prevCtx ? prevCtx.groups.length : null;

  // Drivers (delivered en el período)
  const driverById = useMemo(() => { const m = {}; for (const d of driversList) m[d.id] = d; return m; }, [driversList]);
  const topDrivers = useMemo(() => {
    const counts = {};
    for (const g of ctx.groups) {
      if (!g.anyOut) continue;
      const ids = Array.isArray(g.rep.driver_ids) ? g.rep.driver_ids : [];
      let names = ids.map(id => driverById[id]?.name).filter(Boolean);
      if (!names.length) names = (g.rep.driver || "").split(",").map(s => s.trim()).filter(Boolean);
      for (const n of names) {
        const c = (counts[n] = counts[n] || { label: n, jobs: 0, cf: 0 });
        c.jobs += 1; c.cf += effCf(g.rep);
      }
    }
    return topN(Object.values(counts).sort((a, b) => b.jobs - a.jobs), 7, "jobs");
  }, [ctx, driverById]);

  // Alertas accionables
  const negUnits = pnl.rows.filter(r => r.margin < 0 && r.hasCost);
  const ar60 = aging.buckets[2].amount + aging.buckets[3].amount;
  const ar60n = aging.buckets[2].count + aging.buckets[3].count;
  const alerts = [
    negUnits.length > 0 && { icon: "🔻", color: C.rojo, text: `${negUnits.length} unidad${negUnits.length > 1 ? "es" : ""} con margen negativo (${fmtM(negUnits.reduce((s, r) => s + r.margin, 0))}/mes)`, go: "storage" },
    metrics.vacantCost > 0 && { icon: "📦", color: C.naranja, text: `Unidades vacías cuestan ${fmtM(metrics.vacantCost)}/mes`, go: "storage" },
    ar60 > 0 && { icon: "💸", color: C.rojo, text: `${fmtM(ar60)} sin cobrar hace más de 60 días (${ar60n} jobs)`, go: "revenue" },
    faddStats.overdue > 0 && { icon: "⏰", color: C.rojo, text: `${faddStats.overdue} job${faddStats.overdue > 1 ? "s" : ""} con FADD vencido`, go: "operacion" },
    urgentPayments > 0 && { icon: "⚠️", color: C.naranja, text: `${urgentPayments} pago${urgentPayments > 1 ? "s" : ""} de storage vence${urgentPayments > 1 ? "n" : ""} en ≤5 días`, go: null },
    metrics.missingCost > 0 && { icon: "✏️", color: "#854F0B", text: `${metrics.missingCost} unidades sin costo mensual cargado — los totales están incompletos`, go: "storage" },
  ].filter(Boolean);

  // Estados / brokers para filtros
  const stateOpts = useMemo(() => [...new Set(records.map(r => r.state).filter(Boolean))].sort(), [records]);
  const brokerOpts = useMemo(() => [...brokers].sort((a, b) => String(a.name).localeCompare(String(b.name))), [brokers]);

  // Resumen filtrado para el prompt de la IA
  const aiExtra = useMemo(() => ({
    period: preset, state: stateF || "all", broker: brokerF ? (brokerOpts.find(b => String(b.id) === String(brokerF))?.name || brokerF) : "all",
    collectedInPeriod: Math.round(collected),
    netRevenueInPeriod: Math.round(split.net),
    storageMarginPerMonth: metrics.storageMargin,
    vacantCostPerMonth: metrics.vacantCost,
    arOutstanding: Math.round(aging.total), arOver60: Math.round(ar60), dsoDays: aging.dso,
    worstUnits: pnl.rows.slice(0, 5).map(r => ({ name: r.name, marginPerMonth: Math.round(r.margin) })),
    topBrokersByNet: brokerRank.slice(0, 3).map(b => ({ name: b.name, net: Math.round(b.net), jobs: b.jobs })),
    bottomBrokersByNet: brokerRank.slice(-2).map(b => ({ name: b.name, net: Math.round(b.net), jobs: b.jobs })),
    faddOnTimePct: fadd.onTimePct,
  }), [preset, stateF, brokerF, collected, split.net, metrics, aging, ar60, pnl, brokerRank, fadd, brokerOpts]);

  // ── UI helpers ──
  const pill = (act) => ({
    fontSize: 12.5, fontWeight: 600, padding: "6px 13px", borderRadius: 20, cursor: "pointer",
    border: "1px solid " + (act ? "#111" : "#e5e5e5"), background: act ? "#111" : "#fff", color: act ? "#fff" : "#555",
  });
  const sel = { fontSize: 12.5, padding: "6px 10px", borderRadius: 8, border: "1px solid #e5e5e5", background: "#fff", color: "#333" };
  const tabBtn = (act) => ({
    fontSize: 13, fontWeight: 600, padding: "8px 16px", borderRadius: "10px 10px 0 0", cursor: "pointer",
    border: "none", borderBottom: act ? "2px solid #111" : "2px solid transparent", background: "transparent", color: act ? "#111" : "#999",
  });
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 };

  const PRESETS = [["mes", "Este mes"], ["3m", "3M"], ["6m", "6M"], ["12m", "12M"], ["ytd", "YTD"], ["todo", "Todo"]];
  const TABS = [["resumen", "Resumen"], ["storage", "Rentabilidad Storage"], ["revenue", "Revenue & Cashflow"], ["operacion", "Brokers & Operación"], ["drivers", "Driver P&L"]];

  return (
    <div>
      {/* ── Filter bar ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap", marginBottom: 10 }}>
        {PRESETS.map(([v, l]) => <button key={v} style={pill(preset === v)} onClick={() => setPreset(v)}>{l}</button>)}
        <span style={{ width: 1, height: 22, background: "#eee", margin: "0 4px" }} />
        <select style={sel} value={stateF} onChange={e => setStateF(e.target.value)}>
          <option value="">Todos los estados</option>
          {stateOpts.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
        <select style={sel} value={brokerF} onChange={e => setBrokerF(e.target.value)}>
          <option value="">Todos los brokers</option>
          {brokerOpts.map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
        </select>
        {(stateF || brokerF) && (
          <button style={{ ...sel, cursor: "pointer", color: C.rojo, fontWeight: 600 }} onClick={() => { setStateF(""); setBrokerF(""); }}>✕ limpiar</button>
        )}
      </div>

      {/* ── Tabs ── */}
      <div style={{ display: "flex", gap: 4, borderBottom: "1px solid #eee", marginBottom: 14, flexWrap: "wrap" }}>
        {TABS.map(([v, l]) => <button key={v} style={tabBtn(tab === v)} onClick={() => setTab(v)}>{l}</button>)}
      </div>

      {/* ═══════════ TAB RESUMEN ═══════════ */}
      {tab === "resumen" && (
        <>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 14 }}>
            <KpiTile label="Cobrado en el período" value={fmtK(collected)} delta={delta(collected, prevCollected)}
              spark={revSeries.map(r => ({ v: r.collected }))} sparkColor={C.verde} />
            <KpiTile label="Revenue neto (después de brokers)" value={fmtK(split.net)} delta={delta(split.net, prevSplit ? prevSplit.net : null)}
              spark={ctx.months.map(m => ({ v: split.series[m]?.gross ? split.series[m].gross - split.series[m].broker : 0 }))} sparkColor={C.verde} />
            <KpiTile label="Jobs nuevos" value={fmtN(jobsNew)} delta={delta(jobsNew, prevJobsNew)}
              spark={flow.map(r => ({ v: r.nuevos }))} />
            <KpiTile label="CF movidos" value={fmtN(cfTotal)} delta={delta(cfTotal, prevCfTotal)}
              spark={cfSeries.map(r => ({ v: r.cf }))} />
            <KpiTile label="Margen storage /mes" value={fmtM(metrics.storageMargin)} chip="hoy" />
            <KpiTile label="Por cobrar (AR)" value={fmtK(aging.total)} chip="hoy" />
          </div>

          <div style={grid2}>
            <div style={card}>
              <Title>Alertas</Title>
              <div style={sub}>Dónde estás perdiendo plata hoy</div>
              {alerts.length === 0 && <Empty>Sin alertas — todo en orden ✓</Empty>}
              {alerts.map((a, i) => (
                <div key={i} onClick={() => a.go && setTab(a.go)}
                  style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 10px", borderRadius: 8, marginBottom: 6, background: "#fafafa", cursor: a.go ? "pointer" : "default", fontSize: 12.5 }}>
                  <span>{a.icon}</span>
                  <span style={{ flex: 1, color: "#333" }}>{a.text}</span>
                  {a.go && <span style={{ color: "#bbb", fontSize: 14 }}>→</span>}
                </div>
              ))}
            </div>

            <div style={card}>
              <Title>Cobrado por mes</Title>
              <div style={sub}>{paymentsMissing ? "Aproximado desde los jobs (sin tabla de pagos)" : "Pagos netos de descuento: recibidos vs pendientes"}</div>
              <LegendRow items={[["Cobrado", C.verde], ["Pendiente", C.ambar]]} />
              <div style={{ height: 210 }}>
                <ResponsiveContainer>
                  <BarChart data={revSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    {GRID}
                    <XAxis dataKey="label" {...AXIS} />
                    <YAxis {...AXIS} tickFormatter={fmtK} width={52} />
                    <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="collected" name="Cobrado" stackId="a" fill={C.verde} stroke="#fff" strokeWidth={1} maxBarSize={24} />
                    <Bar dataKey="pending" name="Pendiente" stackId="a" fill={C.ambar} stroke="#fff" strokeWidth={1} maxBarSize={24} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <div style={grid2}>
            <div style={card}>
              <Title>Jobs nuevos vs entregados</Title>
              <div style={sub}>Flujo de la operación por mes</div>
              <LegendRow items={[["Nuevos", C.azul], ["Entregados", C.gris]]} />
              <div style={{ height: 210 }}>
                <ResponsiveContainer>
                  <BarChart data={flow} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    {GRID}
                    <XAxis dataKey="label" {...AXIS} />
                    <YAxis {...AXIS} allowDecimals={false} width={30} />
                    <Tooltip content={<CardTooltip fmt={fmtN} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="nuevos" name="Nuevos" fill={C.azul} maxBarSize={18} radius={[4, 4, 0, 0]} />
                    <Bar dataKey="entregados" name="Entregados" fill={C.gris} maxBarSize={18} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={card}>
              <Title>Ocupación de unidades</Title>
              <div style={sub}>Unidades con carga adentro vs unidades alquiladas (últimos 12 meses; excluye cerradas)</div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 8 }}>
                <span style={{ fontSize: 24, fontWeight: 700 }}>{pnl.rows.length ? Math.round(pnl.rows.filter(r => r.occupied).length / pnl.rows.length * 100) : 0}%</span>
                <span style={{ fontSize: 12, color: "#999" }}>{pnl.rows.filter(r => r.occupied).length} de {pnl.rows.length} unidades ocupadas hoy</span>
              </div>
              <div style={{ height: 170 }}>
                <ResponsiveContainer>
                  <LineChart data={occup} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    {GRID}
                    <XAxis dataKey="label" {...AXIS} />
                    <YAxis {...AXIS} width={38} tickFormatter={v => v + "%"} domain={[0, 100]} />
                    <Tooltip content={<CardTooltip fmt={v => v + "%"} />} />
                    <Line type="monotone" dataKey="pct" name="Ocupación" stroke={C.azul} strokeWidth={2} dot={false} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>

          <AIPanel records={records} lang={lang} extra={aiExtra} />
        </>
      )}

      {/* ═══════════ TAB RENTABILIDAD STORAGE ═══════════ */}
      {tab === "storage" && (
        <StorageTab pnl={pnl} byState={byState} metrics={metrics} stateF={stateF} setStateF={setStateF} occup={occup} />
      )}

      {/* ═══════════ TAB REVENUE & CASHFLOW ═══════════ */}
      {tab === "revenue" && (
        <RevenueTab split={split} ctx={ctx} aging={aging} collected={collected} revSeries={revSeries}
          perCf={perCf} stay={stay} brokerShareMissing={brokerShareMissing} paymentsMissing={paymentsMissing} />
      )}

      {/* ═══════════ TAB BROKERS & OPERACIÓN ═══════════ */}
      {tab === "operacion" && (
        <OperacionTab brokerRank={brokerRank} brokerF={brokerF} setBrokerF={setBrokerF}
          fadd={fadd} cfSeries={cfSeries} topDrivers={topDrivers} funnel={funnel} brokerShareMissing={brokerShareMissing} />
      )}

      {/* ═══════════ TAB DRIVER P&L ═══════════ */}
      {tab === "drivers" && (
        <DriversTab ctx={ctx} range={range} driversList={driversList} expenses={expenses}
          workDays={workDays} adjustments={adjustments} materialItems={materialItems} materialMovements={materialMovements}
          expensesMissing={expensesMissing} />
      )}
    </div>
  );
}

// ── Tab 5: Driver P&L ─────────────────────────────────────────────────────────
// Cuánto trae vs cuánto cuesta cada driver: revenue atribuido (jobs compartidos
// se dividen en partes iguales) contra días trabajados × rate + gastos aprobados
// + comisiones de extras. Señales anti-robo: outliers de fuel y materiales en mano.
function DriversTab({ ctx, range, driversList, expenses, workDays, adjustments, materialItems, materialMovements, expensesMissing }) {
  const pnl = useMemo(
    () => computeDriverPnl({ driversList, groups: ctx.groups, jobExtras: ctx.extras, expenses, workDays, adjustments, range }),
    [driversList, ctx, expenses, workDays, adjustments, range]
  );
  const fuel = useMemo(() => {
    const inR = (e) => { const m = (e.expense_date || "").slice(0, 7); return !!m && (!range.fromMonth || (m >= range.fromMonth && m <= range.toMonth)); };
    return fuelOutliers({ expenses: expenses.filter(inR) });
  }, [expenses, range]);
  const shortages = useMemo(
    () => materialShortages({ items: materialItems, movements: materialMovements }).filter(s => s.onHand > 0),
    [materialItems, materialMovements]
  );
  const driverName = (id) => driversList.find(d => d.id === id)?.name || (id ? `#${id}` : "—");
  const { rows, totals } = pnl;
  const chartData = rows.map(r => ({
    label: r.name.split(" ")[0],
    Revenue: Math.round(r.revenue),
    "Días × rate": Math.round(r.laborCost),
    Gastos: Math.round(r.expensesTotal),
    Comisiones: Math.round(r.commissions),
  }));

  if (expensesMissing) return <Empty>Falta correr el setup de Expenses (SQL) para ver el P&L por driver.</Empty>;
  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 14 }}>
        <KpiTile label="Revenue atribuido a drivers" value={fmtK(totals.revenue)} />
        <KpiTile label="Costo total (días + gastos + comisiones)" value={fmtK(totals.totalCost)} />
        <KpiTile label="Neto" value={fmtK(totals.net)} />
        <KpiTile label="Cash de drivers en gastos sin rendir" value={fmtK(expenses.filter(e => e.paid_from === "driver_cash" && e.status === "approved" && !e.settled).reduce((s, e) => s + (Number(e.amount) || 0), 0))} chip="hoy" />
      </div>

      <div style={grid2Static}>
        <div style={card}>
          <Title>P&L por driver</Title>
          <div style={sub}>Revenue de jobs compartidos dividido en partes iguales entre drivers — aproximado. Solo gastos aprobados.</div>
          {rows.length === 0 ? <Empty>Sin actividad de drivers en el período.</Empty> : (
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                <thead><tr style={{ borderBottom: "1px solid #efefef" }}>
                  {["Driver", "Jobs", "Revenue", "Días", "Días × rate", "Gastos", "Comisiones", "Ajustes", "Neto", "Margen"].map((h, i) => (
                    <th key={i} style={{ padding: "8px 8px", textAlign: i === 0 ? "left" : "right", fontWeight: 600, fontSize: 10.5, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.04em", whiteSpace: "nowrap" }}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {rows.map(r => (
                    <tr key={r.driverId} style={{ borderBottom: "1px solid #fafafa" }}>
                      <td style={{ padding: "8px", fontWeight: 600 }}>{r.name}{r.pendingTotal > 0 && <span title="gastos pendientes de aprobar" style={{ fontSize: 10, color: "#C2410C", marginLeft: 5 }}>+{fmtK(r.pendingTotal)} pend.</span>}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.jobsCount}</td>
                      <td style={{ padding: "8px", textAlign: "right", fontWeight: 600 }}>{fmtM(r.revenue)}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{r.workedDays}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(r.laborCost)}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(r.expensesTotal)}</td>
                      <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(r.commissions)}</td>
                      <td style={{ padding: "8px", textAlign: "right", color: r.adjustmentsNet > 0 ? C.rojo : r.adjustmentsNet < 0 ? C.verde : "#888" }} title="bonos − descuentos por fuck-ups">{r.adjustmentsNet !== 0 ? fmtM(r.adjustmentsNet) : "—"}</td>
                      <td style={{ padding: "8px", textAlign: "right", fontWeight: 700, color: r.net >= 0 ? C.verde : C.rojo }}>{fmtM(r.net)}</td>
                      <td style={{ padding: "8px", textAlign: "right", color: "#888" }}>{r.margin == null ? "—" : Math.round(r.margin * 100) + "%"}</td>
                    </tr>
                  ))}
                  <tr style={{ borderTop: "2px solid #eee", fontWeight: 700 }}>
                    <td style={{ padding: "8px" }}>Total</td>
                    <td />
                    <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(totals.revenue)}</td>
                    <td />
                    <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(totals.laborCost)}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(totals.expensesTotal)}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>{fmtM(totals.commissions)}</td>
                    <td style={{ padding: "8px", textAlign: "right" }}>{totals.adjustmentsNet !== 0 ? fmtM(totals.adjustmentsNet) : "—"}</td>
                    <td style={{ padding: "8px", textAlign: "right", color: totals.net >= 0 ? C.verde : C.rojo }}>{fmtM(totals.net)}</td>
                    <td />
                  </tr>
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div style={card}>
          <Title>Revenue vs costo por driver</Title>
          <div style={sub}>El costo se apila: días × rate + gastos + comisiones</div>
          <LegendRow items={[["Revenue", C.verde], ["Días × rate", C.azul], ["Gastos", C.naranja], ["Comisiones", C.violeta]]} />
          <div style={{ height: 250 }}>
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                {GRID}
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} tickFormatter={fmtK} width={52} />
                <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                <Bar dataKey="Revenue" fill={C.verde} maxBarSize={22} radius={[4, 4, 0, 0]} />
                <Bar dataKey="Días × rate" stackId="c" fill={C.azul} maxBarSize={22} stroke="#fff" strokeWidth={1} />
                <Bar dataKey="Gastos" stackId="c" fill={C.naranja} maxBarSize={22} stroke="#fff" strokeWidth={1} />
                <Bar dataKey="Comisiones" stackId="c" fill={C.violeta} maxBarSize={22} stroke="#fff" strokeWidth={1} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div style={grid2Static}>
        <div style={card}>
          <Title chip={fuel.medianPpg ? `mediana $${fuel.medianPpg.toFixed(2)}/gal` : null}>Señales de fuel</Title>
          <div style={sub}>Cargas con precio/galón fuera de rango (&gt;1.5× o &lt;0.5× la mediana) — posible robo o carga mal registrada</div>
          {fuel.fillsWithGallons === 0 ? <Empty>Cargá galones en los gastos de fuel para activar esta señal.</Empty>
            : fuel.outliers.length === 0 ? <Empty>Sin outliers de precio/galón ✓</Empty>
            : fuel.outliers.map(o => (
              <div key={o.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "7px 10px", borderRadius: 8, background: "#FCEBEB", marginBottom: 6, fontSize: 12.5 }}>
                <span>⛽</span>
                <span style={{ flex: 1 }}>{o.expense_date || "—"} · {driverName(o.driver_id)}</span>
                <b style={{ color: C.rojo }}>${o.ppg.toFixed(2)}/gal</b>
                <span style={{ color: "#888" }}>({fmtM(o.amount)} / {o.gallons} gal)</span>
              </div>
            ))}
          {fuel.costPerMile.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#aaa", textTransform: "uppercase", letterSpacing: "0.06em", margin: "12px 0 6px" }}>$/milla entre cargas (odómetro)</div>
              {fuel.costPerMile.slice(0, 6).map((c, i) => (
                <div key={i} style={{ display: "flex", gap: 8, fontSize: 12, color: "#555", padding: "3px 0" }}>
                  <span style={{ flex: 1 }}>Truck #{c.truckId} · {c.from || "?"} → {c.to || "?"}</span>
                  <b>${c.perMile.toFixed(2)}/mi</b>
                  <span style={{ color: "#999" }}>({Math.round(c.miles)} mi)</span>
                </div>
              ))}
            </>
          )}
        </div>

        <div style={card}>
          <Title>Materiales sin devolver</Title>
          <div style={sub}>Entregado − devuelto − consumido por driver: lo que falta rendir (valor al costo)</div>
          {shortages.length === 0 ? <Empty>Nadie debe materiales ✓</Empty> : shortages.map((s, i) => (
            <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 8, background: "#fafafa", marginBottom: 5, fontSize: 12.5 }}>
              <span>📦</span>
              <span style={{ fontWeight: 600 }}>{driverName(s.driverId)}</span>
              <span style={{ flex: 1, color: "#666" }}>{s.itemName}</span>
              <b style={{ color: C.rojo }}>{s.onHand} {s.unit}</b>
              <span style={{ color: "#888" }}>{fmtM(s.value)}</span>
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
const grid2Static = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 };

// ── Tab 2: Rentabilidad Storage ──────────────────────────────────────────────
function StorageTab({ pnl, byState, metrics, stateF, setStateF, occup }) {
  const [q, setQ] = useState("");
  const [pg, setPg] = useState(0);
  const [expanded, setExpanded] = useState(null);
  const margin = pnl.totals.income - pnl.totals.pay;

  const brandRows = useMemo(() => {
    const by = {};
    for (const r of pnl.rows) {
      const b = (by[r.brand] = by[r.brand] || { label: r.brand, margin: 0, pay: 0, income: 0, units: 0 });
      b.margin += r.margin; b.pay += r.pay; b.income += r.income; b.units += 1;
    }
    return Object.values(by).sort((a, b) => a.margin - b.margin).slice(0, 9);
  }, [pnl]);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? pnl.rows.filter(r => r.name.toLowerCase().includes(s)) : pnl.rows;
  }, [pnl, q]);
  const sort = useSort(filtered, "margin", "asc");
  const PAGE = 15;
  const pageRows = sort.sorted.slice(pg * PAGE, (pg + 1) * PAGE);
  const vacant = pnl.rows.filter(r => !r.occupied).sort((a, b) => b.pay - a.pay);
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 };

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 14 }}>
        <KpiTile label="Pagás por storages" value={fmtM(pnl.totals.pay) + "/mes"} chip="hoy" />
        <KpiTile label="Cobrás por storage" value={fmtM(pnl.totals.income) + "/mes"} chip="hoy" />
        <KpiTile label="Margen" value={fmtM(margin) + "/mes"} chip="hoy" />
        <KpiTile label="Costo de vacantes" value={fmtM(metrics.vacantCost) + "/mes"} chip="hoy" />
      </div>

      {metrics.missingCost > 0 && (
        <div style={{ background: "#FFF6E8", border: "1px solid #F4DDB0", borderRadius: 8, padding: "8px 12px", fontSize: 13, color: "#854F0B", marginBottom: 14 }}>
          ⚠ {metrics.missingCost} unidad{metrics.missingCost === 1 ? "" : "es"} sin costo mensual cargado — el total que pagás está incompleto. Abrí cada storage y cargá su <b>Monthly cost</b>.
        </div>
      )}

      <div style={grid2}>
        <div style={card}>
          <Title chip="hoy">Margen por estado</Title>
          <div style={sub}>Rojo pierde plata, verde gana. Click en un estado para filtrar todo el dashboard.</div>
          <UsMarginMap stats={byState} selected={stateF} onSelect={setStateF} />
        </div>

        <div style={card}>
          <Title chip="hoy">Margen por empresa</Title>
          <div style={sub}>Con qué cadenas de storage ganás o perdés (peor primero)</div>
          {brandRows.length === 0 ? <Empty>Sin datos de costo</Empty> : (
            <div style={{ height: Math.max(180, brandRows.length * 34) }}>
              <ResponsiveContainer>
                <BarChart data={brandRows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                  <XAxis type="number" {...AXIS} tickFormatter={fmtK} />
                  <YAxis type="category" dataKey="label" {...AXIS} width={120} />
                  <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <ReferenceLine x={0} stroke="#ddd" />
                  <Bar dataKey="margin" name="Margen /mes" maxBarSize={18} radius={[0, 4, 4, 0]}>
                    {brandRows.map((r, i) => <Cell key={i} fill={r.margin < 0 ? C.rojo : C.verde} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div style={grid2}>
        <div style={card}>
          <Title chip="hoy">Costo mensual por empresa</Title>
          <div style={sub}>Cuánto le pagás a cada cadena de storages</div>
          {(() => {
            const rows = topN(
              Object.values(pnl.rows.reduce((acc, r) => { if (!r.pay) return acc; const b = (acc[r.brand] = acc[r.brand] || { label: r.brand, pay: 0 }); b.pay += r.pay; return acc; }, {}))
                .sort((a, b) => b.pay - a.pay),
              7, "pay");
            if (!rows.length) return <Empty>Cargá costos para ver este gráfico</Empty>;
            return (
              <div style={{ height: Math.max(160, rows.length * 34) }}>
                <ResponsiveContainer>
                  <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickFormatter={fmtK} />
                    <YAxis type="category" dataKey="label" {...AXIS} width={120} />
                    <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="pay" name="Pagás /mes" maxBarSize={18} radius={[0, 4, 4, 0]}>
                      {rows.map((r, i) => <Cell key={i} fill={r.isOther ? C.gris : C.naranja} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            );
          })()}
        </div>

        <div style={card}>
          <Title chip="hoy">Sangría de vacantes</Title>
          <div style={sub}>Unidades alquiladas sin carga adentro — plata que sale sin entrar nada</div>
          {vacant.length === 0 ? <Empty>Sin unidades vacías ✓</Empty> : (
            <>
              <div style={{ fontSize: 24, fontWeight: 700, color: C.rojo, marginBottom: 10 }}>
                {fmtM(vacant.reduce((s, r) => s + r.pay, 0))}<span style={{ fontSize: 13, color: "#999", fontWeight: 500 }}>/mes en {vacant.length} unidades</span>
              </div>
              <div style={{ maxHeight: 220, overflowY: "auto" }}>
                {vacant.map(r => (
                  <div key={r.id} style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, padding: "5px 0", borderBottom: "1px solid #f7f7f7" }}>
                    <span style={{ color: "#333" }}>{r.name}</span>
                    <span style={{ color: C.rojo, fontWeight: 600 }}>{r.hasCost ? fmtM(r.pay) + "/mes" : "sin costo ⚠"}</span>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
      </div>

      <div style={{ ...card, marginBottom: 14 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
          <Title chip="hoy">Storage P&L — costo real vs ingreso</Title>
          <input value={q} onChange={e => { setQ(e.target.value); setPg(0); }} placeholder="Buscar unidad..."
            style={{ marginLeft: "auto", fontSize: 12.5, padding: "6px 10px", borderRadius: 8, border: "1px solid #e5e5e5", width: 180 }} />
        </div>
        <div style={sub}>Cada unidad alquilada (aunque esté vacía) contra lo que cobrás por mes. Si un job ocupa varias unidades, su tarifa se prorratea. Click en una fila para ver sus jobs.</div>
        <div style={{ maxHeight: 420, overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
            <thead>
              <tr>
                <SortTh label="Storage" k="name" sort={sort} />
                <SortTh label="Estado" k="occupied" sort={sort} />
                <SortTh label="Pagás /mes" k="pay" sort={sort} align="right" />
                <SortTh label="Cobrás /mes" k="income" sort={sort} align="right" />
                <SortTh label="Margen /mes" k="margin" sort={sort} align="right" />
              </tr>
            </thead>
            <tbody>
              {pageRows.map(r => (
                <RowPnl key={r.id} r={r} expanded={expanded === r.id} onToggle={() => setExpanded(expanded === r.id ? null : r.id)} />
              ))}
            </tbody>
            <tfoot>
              <tr>
                <td style={{ padding: 8, fontWeight: 700, borderTop: "2px solid #eee" }}>Total ({pnl.rows.length} unidades)</td>
                <td style={{ borderTop: "2px solid #eee" }} />
                <td style={{ padding: 8, textAlign: "right", fontWeight: 700, color: C.naranja, borderTop: "2px solid #eee" }}>{fmtM(pnl.totals.pay)}</td>
                <td style={{ padding: 8, textAlign: "right", fontWeight: 700, color: C.verde, borderTop: "2px solid #eee" }}>{fmtM(pnl.totals.income)}</td>
                <td style={{ padding: 8, textAlign: "right", fontWeight: 700, color: margin < 0 ? C.rojo : C.verde, borderTop: "2px solid #eee" }}>{fmtM(margin)}</td>
              </tr>
            </tfoot>
          </table>
        </div>
        <div style={{ marginTop: 8 }}>
          <PagerLite page={pg} total={sort.sorted.length} pageSize={15} onPage={setPg} unit="unidades" />
        </div>
      </div>
    </>
  );
}

function RowPnl({ r, expanded, onToggle }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: "pointer", background: expanded ? "#fafafa" : "transparent" }}>
        <td style={td({ fontWeight: 500 })}>{r.name}</td>
        <td style={td()}>
          <span style={{ fontSize: 10.5, fontWeight: 600, padding: "1px 7px", borderRadius: 20, background: r.occupied ? "#EAF3DE" : "#FEF3C7", color: r.occupied ? "#3B6D11" : "#92760B" }}>
            {r.occupied ? "Ocupada" : "Vacía"}
          </span>
        </td>
        <td style={td({ textAlign: "right", color: C.naranja })}>{r.hasCost ? fmtM(r.pay) : <span style={{ color: "#b45309", fontWeight: 600 }}>sin costo ⚠</span>}</td>
        <td style={td({ textAlign: "right", color: C.verde })}>{fmtM(r.income)}</td>
        <td style={td({ textAlign: "right", fontWeight: 700, color: r.margin < 0 ? C.rojo : C.verde })}>{fmtM(r.margin)}</td>
      </tr>
      {expanded && (
        <tr>
          <td colSpan={5} style={{ padding: "4px 8px 10px 20px", background: "#fafafa", borderBottom: "1px solid #f0f0f0" }}>
            {r.jobs.length === 0 ? (
              <span style={{ fontSize: 12, color: "#999" }}>Sin jobs activos en esta unidad.</span>
            ) : r.jobs.map(j => (
              <div key={j.id} style={{ display: "flex", gap: 12, fontSize: 12, padding: "2px 0", color: "#555", flexWrap: "wrap" }}>
                <span style={{ fontWeight: 600 }}>#{j.job_number || "s/n"}</span>
                <span>{j.customer || "—"}</span>
                <span style={{ color: "#999" }}>{j.volume ? parseCf(j.volume).toLocaleString() + " CF" : ""}</span>
                <span style={{ color: j.billing_active ? C.verde : "#999" }}>
                  {j.client_monthly_rate ? fmtM(Number(j.client_monthly_rate)) + "/mes" + (j.billing_active ? "" : " (billing inactivo)") : "sin tarifa mensual"}
                </span>
              </div>
            ))}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Tab 3: Revenue & Cashflow ────────────────────────────────────────────────
function RevenueTab({ split, ctx, aging, collected, revSeries, perCf, stay, brokerShareMissing, paymentsMissing }) {
  const [bucketSel, setBucketSel] = useState(null);
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 };
  const pendingTotal = revSeries.reduce((s, r) => s + r.pending, 0);
  const pctCobrado = (collected + pendingTotal) > 0 ? Math.round(collected / (collected + pendingTotal) * 100) : null;

  const splitData = ctx.months.map(m => {
    const s = split.series[m] || { gross: 0, broker: 0 };
    return { month: m, label: monthLabel(m), net: Math.round(s.gross - s.broker), broker: Math.round(s.broker) };
  });
  const AGING_COLORS = ["#F6D5D5", "#EBA3A3", "#D96C6C", "#A32D2D"];
  const agingData = aging.buckets.map((b, i) => ({ ...b, fill: AGING_COLORS[i] }));
  const selBucket = bucketSel != null ? aging.buckets[bucketSel] : null;

  return (
    <>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(170px,1fr))", gap: 10, marginBottom: 14 }}>
        <KpiTile label="Cobrado en el período" value={fmtK(collected)} />
        <KpiTile label="% cobrado (vs pendiente)" value={pctCobrado == null ? "—" : pctCobrado + "%"} />
        <KpiTile label="Por cobrar total (AR)" value={fmtK(aging.total)} chip="hoy" />
        <KpiTile label="DSO — días promedio de deuda" value={aging.dso + " días"} chip="hoy" />
      </div>

      <div style={grid2}>
        <div style={card}>
          <Title>Revenue neto vs broker share por mes</Title>
          <div style={sub}>{brokerShareMissing ? "Columnas de broker share no configuradas en la base — solo bruto." : "Lo que queda en la empresa (verde) + lo que retienen los brokers (naranja) = bruto"}</div>
          <LegendRow items={[["Neto empresa", C.verde], ["Broker share", C.naranja]]} />
          <div style={{ height: 220 }}>
            <ResponsiveContainer>
              <BarChart data={splitData} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                {GRID}
                <XAxis dataKey="label" {...AXIS} />
                <YAxis {...AXIS} tickFormatter={fmtK} width={52} />
                <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                <Bar dataKey="net" name="Neto empresa" stackId="a" fill={C.verde} stroke="#fff" strokeWidth={1} maxBarSize={24} />
                <Bar dataKey="broker" name="Broker share" stackId="a" fill={C.naranja} stroke="#fff" strokeWidth={1} maxBarSize={24} radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 12, color: "#666", marginTop: 8, flexWrap: "wrap" }}>
            <span>Bruto: <b>{fmtM(split.gross)}</b></span>
            <span>Brokers: <b style={{ color: C.naranja }}>{fmtM(split.broker)}</b></span>
            <span>Neto: <b style={{ color: C.verde }}>{fmtM(split.net)}</b></span>
          </div>
        </div>

        <div style={card}>
          <Title chip="hoy">Antigüedad de deuda (AR aging)</Title>
          <div style={sub}>Saldos BOL sin cobrar en jobs ya entregados. Click en una barra para ver quién debe.</div>
          {aging.total === 0 ? <Empty>Nada pendiente de cobro ✓</Empty> : (
            <>
              <div style={{ height: 150 }}>
                <ResponsiveContainer>
                  <BarChart data={agingData} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickFormatter={fmtK} />
                    <YAxis type="category" dataKey="label" {...AXIS} width={80} />
                    <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="amount" name="Sin cobrar" maxBarSize={20} radius={[0, 4, 4, 0]} onClick={(_, i) => setBucketSel(bucketSel === i ? null : i)} style={{ cursor: "pointer" }}>
                      {agingData.map((b, i) => <Cell key={i} fill={b.fill} opacity={bucketSel == null || bucketSel === i ? 1 : 0.35} />)}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {selBucket && (
                <div style={{ marginTop: 10, maxHeight: 180, overflowY: "auto" }}>
                  <div style={{ fontSize: 11.5, fontWeight: 700, color: "#666", marginBottom: 4 }}>{selBucket.label} — {fmtM(selBucket.amount)} en {selBucket.count} jobs</div>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
                    <tbody>
                      {selBucket.jobs.map(j => (
                        <tr key={j.key}>
                          <td style={td({ fontWeight: 600 })}>#{j.job_number || "s/n"}</td>
                          <td style={td()}>{j.customer || "—"}</td>
                          <td style={td({ textAlign: "right", color: C.rojo, fontWeight: 600 })}>{fmtM(j.owed)}</td>
                          <td style={td({ textAlign: "right", color: "#999" })}>{j.days} días</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      </div>

      <div style={grid2}>
        <div style={card}>
          <Title>Economía por pie cúbico ($/CF)</Title>
          <div style={sub}>Lo que cobrás por CF movido cada mes{perCf.avgCarrierRate ? " — la línea punteada es tu costo carrier promedio" : ""}</div>
          {perCf.series.every(s => s.value == null) ? <Empty>Sin datos de volumen y cobro en el período</Empty> : (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <LineChart data={perCf.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  {GRID}
                  <XAxis dataKey="label" {...AXIS} />
                  <YAxis {...AXIS} width={48} tickFormatter={v => "$" + v} />
                  <Tooltip content={<CardTooltip fmt={v => "$" + v + "/CF"} />} />
                  {perCf.avgCarrierRate && <ReferenceLine y={perCf.avgCarrierRate} stroke={C.naranja} strokeDasharray="4 3" label={{ value: "costo carrier $" + perCf.avgCarrierRate, position: "insideTopRight", fontSize: 10, fill: C.naranja }} />}
                  <Line type="monotone" dataKey="value" name="$/CF cobrado" stroke={C.azul} strokeWidth={2} connectNulls dot={{ r: 3, strokeWidth: 2, stroke: "#fff" }} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div style={card}>
          <Title>Estadía en storage</Title>
          <div style={sub}>Cuántos días queda la carga adentro (jobs entregados del período)</div>
          {stay.n === 0 ? <Empty>Sin jobs entregados con fechas completas</Empty> : (
            <>
              <div style={{ display: "flex", gap: 20, marginBottom: 10 }}>
                <div><div style={{ fontSize: 24, fontWeight: 700 }}>{stay.avg}</div><div style={{ fontSize: 11, color: "#999" }}>días promedio</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 700 }}>{stay.median}</div><div style={{ fontSize: 11, color: "#999" }}>mediana</div></div>
                <div><div style={{ fontSize: 24, fontWeight: 700 }}>{stay.n}</div><div style={{ fontSize: 11, color: "#999" }}>jobs</div></div>
              </div>
              <div style={{ height: 150 }}>
                <ResponsiveContainer>
                  <BarChart data={stay.buckets} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                    {GRID}
                    <XAxis dataKey="label" {...AXIS} />
                    <YAxis {...AXIS} allowDecimals={false} width={26} />
                    <Tooltip content={<CardTooltip fmt={fmtN} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="count" name="Jobs" fill={C.azul} maxBarSize={24} radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>
      </div>
      {paymentsMissing && (
        <div style={{ background: "#FFF6E8", border: "1px solid #F4DDB0", borderRadius: 8, padding: "8px 12px", fontSize: 12.5, color: "#854F0B", marginBottom: 14 }}>
          ⚠ La tabla de pagos no está configurada — "Cobrado" se aproxima desde los campos del job.
        </div>
      )}
    </>
  );
}

// ── Tab 4: Brokers & Operación ───────────────────────────────────────────────
function OperacionTab({ brokerRank, brokerF, setBrokerF, fadd, cfSeries, topDrivers, funnel, brokerShareMissing }) {
  const sort = useSort(brokerRank, "net", "desc");
  const grid2 = { display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(340px,1fr))", gap: 14, marginBottom: 14 };
  const barData = topN(brokerRank, 7, "net", "name");

  return (
    <>
      <div style={grid2}>
        <div style={{ ...card, gridColumn: "1 / -1" }}>
          <Title>Ranking de brokers — con quién conviene trabajar</Title>
          <div style={sub}>{brokerShareMissing ? "Columnas de broker share no configuradas — el neto asume share 0." : "Neto = lo cobrado en sus jobs menos lo que retienen. Click en una barra para filtrar todo el dashboard."}</div>
          {brokerRank.length === 0 ? <Empty>Sin jobs de brokers en el período</Empty> : (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(320px,1fr))", gap: 18 }}>
              <div style={{ height: Math.max(180, barData.length * 36) }}>
                <ResponsiveContainer>
                  <BarChart data={barData} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                    <XAxis type="number" {...AXIS} tickFormatter={fmtK} />
                    <YAxis type="category" dataKey="name" {...AXIS} width={130} />
                    <Tooltip content={<CardTooltip />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                    <Bar dataKey="net" name="Neto empresa" maxBarSize={18} radius={[0, 4, 4, 0]}
                      onClick={(d) => d && d.id != null && setBrokerF(String(brokerF) === String(d.id) ? "" : String(d.id))} style={{ cursor: "pointer" }}>
                      {barData.map((b, i) => (
                        <Cell key={i} fill={b.isOther ? C.gris : C.naranja}
                          opacity={!brokerF || String(b.id) === String(brokerF) ? 1 : 0.3} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div style={{ maxHeight: 300, overflowY: "auto" }}>
                <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12.5 }}>
                  <thead>
                    <tr>
                      <SortTh label="Broker" k="name" sort={sort} />
                      <SortTh label="Jobs" k="jobs" sort={sort} align="right" />
                      <SortTh label="Bruto" k="gross" sort={sort} align="right" />
                      <SortTh label="Share" k="share" sort={sort} align="right" />
                      <SortTh label="Neto" k="net" sort={sort} align="right" />
                      <SortTh label="$/job" k="perJob" sort={sort} align="right" />
                      <SortTh label="$/CF" k="perCf" sort={sort} align="right" />
                    </tr>
                  </thead>
                  <tbody>
                    {sort.sorted.map(b => (
                      <tr key={b.id} style={{ background: String(b.id) === String(brokerF) ? "#f5f9ff" : "transparent" }}>
                        <td style={td({ fontWeight: 500 })}>{b.name}</td>
                        <td style={td({ textAlign: "right" })}>{b.jobs}</td>
                        <td style={td({ textAlign: "right" })}>{fmtM(b.gross)}</td>
                        <td style={td({ textAlign: "right", color: C.naranja })}>{fmtM(b.share)}</td>
                        <td style={td({ textAlign: "right", fontWeight: 700, color: b.net < 0 ? C.rojo : C.verde })}>{fmtM(b.net)}</td>
                        <td style={td({ textAlign: "right", color: "#666" })}>{fmtM(b.perJob)}</td>
                        <td style={td({ textAlign: "right", color: "#666" })}>{b.perCf ? (b.perCf < 0 ? "−$" : "$") + Math.abs(b.perCf).toFixed(2) : "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>

      <div style={grid2}>
        <div style={card}>
          <Title>Cumplimiento FADD</Title>
          <div style={sub}>% de jobs entregados en o antes de su primera fecha disponible</div>
          {fadd.total === 0 ? <Empty>Sin jobs entregados con FADD en el período</Empty> : (
            <>
              <div style={{ display: "flex", gap: 20, marginBottom: 8 }}>
                <div><div style={{ fontSize: 24, fontWeight: 700, color: fadd.onTimePct >= 80 ? C.verde : fadd.onTimePct >= 50 ? "#92760B" : C.rojo }}>{fadd.onTimePct}%</div><div style={{ fontSize: 11, color: "#999" }}>a tiempo ({fadd.onTime}/{fadd.total})</div></div>
                {fadd.late > 0 && <div><div style={{ fontSize: 24, fontWeight: 700 }}>{fadd.avgDaysLate}</div><div style={{ fontSize: 11, color: "#999" }}>días de atraso promedio</div></div>}
              </div>
              <div style={{ height: 160 }}>
                <ResponsiveContainer>
                  <LineChart data={fadd.series} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                    {GRID}
                    <XAxis dataKey="label" {...AXIS} />
                    <YAxis {...AXIS} width={38} tickFormatter={v => v + "%"} domain={[0, 100]} />
                    <Tooltip content={<CardTooltip fmt={v => v + "%"} />} />
                    <Line type="monotone" dataKey="pct" name="% a tiempo" stroke={C.azul} strokeWidth={2} connectNulls dot={{ r: 3, strokeWidth: 2, stroke: "#fff" }} />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </>
          )}
        </div>

        <div style={card}>
          <Title>CF movidos por mes</Title>
          <div style={sub}>Volumen total (pies cúbicos) por mes</div>
          {cfSeries.every(r => !r.cf) ? <Empty>Sin datos de volumen</Empty> : (
            <div style={{ height: 200 }}>
              <ResponsiveContainer>
                <BarChart data={cfSeries} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                  {GRID}
                  <XAxis dataKey="label" {...AXIS} />
                  <YAxis {...AXIS} tickFormatter={fmtN} width={52} />
                  <Tooltip content={<CardTooltip fmt={v => fmtN(v) + " CF"} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="cf" name="CF" fill={C.azul} maxBarSize={24} radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>

      <div style={grid2}>
        <div style={card}>
          <Title>Top drivers</Title>
          <div style={sub}>Por jobs entregados en el período</div>
          {topDrivers.length === 0 ? <Empty>Sin entregas en el período</Empty> : (
            <div style={{ height: Math.max(150, topDrivers.length * 34) }}>
              <ResponsiveContainer>
                <BarChart data={topDrivers} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                  <XAxis type="number" {...AXIS} allowDecimals={false} />
                  <YAxis type="category" dataKey="label" {...AXIS} width={120} />
                  <Tooltip content={<CardTooltip fmt={fmtN} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="jobs" name="Jobs entregados" maxBarSize={18} radius={[0, 4, 4, 0]}>
                    {topDrivers.map((r, i) => <Cell key={i} fill={r.isOther ? C.gris : C.violeta} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>

        <div style={card}>
          <Title>Jobs por status</Title>
          <div style={sub}>Dónde está parada la operación (jobs del período)</div>
          {funnel.length === 0 ? <Empty>Sin jobs en el período</Empty> : (
            <div style={{ height: Math.max(150, funnel.length * 32) }}>
              <ResponsiveContainer>
                <BarChart data={funnel} layout="vertical" margin={{ top: 0, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke="#f3f3f3" horizontal={false} />
                  <XAxis type="number" {...AXIS} allowDecimals={false} />
                  <YAxis type="category" dataKey="l" {...AXIS} width={110} />
                  <Tooltip content={<CardTooltip fmt={fmtN} />} cursor={{ fill: "rgba(0,0,0,0.03)" }} />
                  <Bar dataKey="count" name="Jobs" maxBarSize={16} radius={[0, 4, 4, 0]}>
                    {funnel.map((s, i) => <Cell key={i} fill={s.dot} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
      </div>
    </>
  );
}
