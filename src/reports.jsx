// Fleet reports built on GPS history. The point of this page is the cross-check
// between what the trucks actually did and what payroll says was paid — the two
// records are independent, so where they disagree there is something to look at.
//
// Everything per truck comes from the GPS and is solid. Anything per driver
// depends on drivers.truck_id being kept up to date, so the page says when it
// does not know who was driving instead of guessing.
import { useState, useEffect, useMemo, useCallback } from "react";
import { tr, t } from "./i18n.js";
import { truckDays, paidDays, reconcile, reportTotals } from "./reportsData.js";

// The history table, exported so App.jsx's auto-migration and the banner below
// can never drift apart. The CRM creates it by itself where Supabase exposes an
// exec_sql RPC; where it does not, somebody has to run this once.
export const TRUCK_PINGS_SQL = `create table if not exists public.truck_pings (
  id bigint generated always as identity primary key,
  truck_id bigint references public.trucks(id) on delete cascade,
  lat numeric,
  lng numeric,
  status text,
  at timestamptz,
  created_at timestamptz default now(),
  unique (truck_id, at)
);
create index if not exists truck_pings_truck_at on public.truck_pings (truck_id, at desc);
alter table public.truck_pings enable row level security;
drop policy if exists "truck_pings_all" on public.truck_pings;
create policy "truck_pings_all" on public.truck_pings for all to anon, authenticated using (true) with check (true);`;

const RANGES = [
  { key: "7", days: 7, label: "Last 7 days" },
  { key: "14", days: 14, label: "Last 14 days" },
  { key: "30", days: 30, label: "Last 30 days" },
];

const isoDaysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);
const money = (n) => "$" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
const clock = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—");

const KIND = {
  ok:               { l: "Paid and moved",   bg: "#EAF3DE", text: "#3B6D11" },
  moved_unpaid:     { l: "Moved, unpaid",    bg: "#FCEBEB", text: "#A32D2D" },
  paid_no_movement: { l: "Paid, no movement", bg: "#FAEEDA", text: "#854F0B" },
};

const card = { background: "#fff", borderRadius: 10, border: "1px solid #efefef", padding: "12px 14px" };
const th = { textAlign: "left", fontSize: 11, color: "#aaa", fontWeight: 500, padding: "8px 10px", whiteSpace: "nowrap" };
const td = { fontSize: 12.5, padding: "9px 10px", borderTop: "1px solid #f4f4f4", whiteSpace: "nowrap" };

export function ReportsSection({ supabase, session }) {
  const [rangeKey, setRangeKey] = useState("7");
  const [loading, setLoading] = useState(true);
  const [missing, setMissing] = useState(false);   // truck_pings not created yet
  const [pings, setPings] = useState([]);
  const [workDays, setWorkDays] = useState([]);
  const [trucks, setTrucks] = useState([]);
  const [drivers, setDrivers] = useState([]);
  const [kindFilter, setKindFilter] = useState("all");
  const [backfill, setBackfill] = useState(null);   // null | {busy} | result | {error}
  const [sqlCopied, setSqlCopied] = useState(false);

  const days = RANGES.find(r => r.key === rangeKey)?.days ?? 7;
  const from = isoDaysAgo(days);

  const load = useCallback(async () => {
    setLoading(true);
    const [p, w, tk, dr] = await Promise.all([
      supabase.from("truck_pings").select("truck_id, lat, lng, status, at").gte("at", from + "T00:00:00Z").order("at"),
      supabase.from("driver_work_days").select("*").gte("work_date", from),
      supabase.from("trucks").select("*"),
      supabase.from("drivers").select("*"),
    ]);
    // The history table is created on first load of the live map; until then
    // this page has nothing to stand on and says so rather than showing zeros.
    setMissing(Boolean(p.error));
    setPings(p.data || []);
    setWorkDays((w.data || []).filter(r => !r.deleted_at));
    setTrucks((tk.data || []).filter(r => !r.deleted_at));
    setDrivers((dr.data || []).filter(r => !r.deleted_at));
    setLoading(false);
  }, [supabase, from]);

  useEffect(() => { load(); }, [load]);

  // Reveal keeps 30 days of location history, so the reports do not have to wait
  // weeks for truck_pings to fill up on its own.
  //
  // One request per truck: a month for the whole fleet in a single call outlives
  // the serverless timeout, and a failure there would lose every truck at once.
  // Walking them also means the page can show where it is instead of hanging.
  const runBackfill = useCallback(async () => {
    const linked = trucks.filter(t => t.verizon_vehicle_id);
    if (!linked.length) { setBackfill({ error: tr("No truck is linked to a Verizon vehicle yet.", "Ningún truck está vinculado a un vehículo de Verizon todavía.") }); return; }
    const totals = { positions: 0, trucks: 0, errors: [] };
    for (let i = 0; i < linked.length; i++) {
      const tk = linked[i];
      setBackfill({ busy: true, done: i, total: linked.length, current: tk.name });
      try {
        const r = await fetch(`/api/geocode?fleet=backfill&days=30&truck=${tk.id}`, {
          headers: { Authorization: "Bearer " + session.access_token },
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d?.error || "failed");
        totals.positions += d.positions || 0;
        totals.trucks += 1;
        // A truck that failed on Verizon's side reports itself; keep going.
        if (d.errors?.length) totals.errors.push(...d.errors);
      } catch (e) {
        totals.errors.push({ truck: tk.name, error: e?.message || "failed" });
      }
    }
    setBackfill(totals);
    await load();
  }, [session, load, trucks]);

  const { rows, totals, trucksById } = useMemo(() => {
    const byId = Object.fromEntries(trucks.map(x => [x.id, x]));
    const driversById = Object.fromEntries(drivers.map(x => [x.id, x]));
    const activity = truckDays(pings);
    const paid = paidDays(workDays, driversById);
    const rec = reconcile({ truckDayRows: activity, paidDayRows: paid, trucksById: byId, driversList: drivers });
    return { rows: rec, totals: reportTotals(rec), trucksById: byId };
  }, [pings, workDays, trucks, drivers]);

  const visible = kindFilter === "all" ? rows : rows.filter(r => r.kind === kindFilter);
  const counts = {
    all: rows.length,
    moved_unpaid: rows.filter(r => r.kind === "moved_unpaid").length,
    paid_no_movement: rows.filter(r => r.kind === "paid_no_movement" && !r.noHistory).length,
  };

  return (
    <div>
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 14 }}>
        {RANGES.map(r => (
          <button key={r.key} onClick={() => setRangeKey(r.key)}
            style={{ fontSize: 12.5, padding: "6px 14px", borderRadius: 7, cursor: "pointer", border: "none",
              background: rangeKey === r.key ? "#111" : "#f5f5f5", color: rangeKey === r.key ? "#fff" : "#888",
              fontWeight: rangeKey === r.key ? 600 : 400 }}>{r.label}</button>
        ))}
        <button onClick={runBackfill} disabled={backfill?.busy}
          style={{ marginLeft: "auto", fontSize: 12, color: "#185FA5", background: "none", border: "none", cursor: backfill?.busy ? "default" : "pointer", textDecoration: "underline" }}>
          {backfill?.busy
            ? tr(`Bringing history… ${backfill.done}/${backfill.total} · ${backfill.current}`,
                 `Trayendo historial… ${backfill.done}/${backfill.total} · ${backfill.current}`)
            : t("Bring 30 days from Verizon")}
        </button>
        <button onClick={load} style={{ fontSize: 12, color: "#185FA5", background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>
          {loading ? t("Loading...") : t("Refresh")}
        </button>
      </div>

      {backfill && !backfill.busy && (
        <div style={{ ...card, marginBottom: 12, fontSize: 12.5,
          background: backfill.error ? "#FCEBEB" : "#EAF3DE",
          borderColor: backfill.error ? "#f0c9c9" : "#d5e6bd",
          color: backfill.error ? "#A32D2D" : "#3B6D11" }}>
          {backfill.error
            ? tr(`Could not bring history: ${backfill.error}`, `No se pudo traer el historial: ${backfill.error}`)
            : tr(`${backfill.positions} position(s) brought in for ${backfill.trucks} truck(s).`,
                 `${backfill.positions} posición(es) traídas para ${backfill.trucks} truck(s).`)}
          {backfill.errors?.length > 0 && (
            <div style={{ fontSize: 11.5, marginTop: 4, color: "#A32D2D" }}>
              {backfill.errors.map(e => `${e.truck}: ${e.error}`).join(" · ")}
            </div>
          )}
        </div>
      )}
      {missing ? (
        <div style={{ ...card, background: "#FAEEDA", border: "1px solid #EF9F27", color: "#854F0B", fontSize: 13 }}>
          <div style={{ fontWeight: 600, marginBottom: 6 }}>The GPS history table does not exist yet.</div>
          <div style={{ lineHeight: 1.5, marginBottom: 8 }}>
            The CRM creates it by itself where Supabase allows it. Here it could not, so run this once in the Supabase SQL editor — nothing else is needed afterwards.
          </div>
          <pre style={{ background: "#fff", border: "1px solid #e8d3a8", borderRadius: 8, padding: "10px 12px",
            fontSize: 10.5, color: "#5b4410", overflowX: "auto", margin: 0, lineHeight: 1.45 }}>{TRUCK_PINGS_SQL}</pre>
          <button onClick={() => { navigator.clipboard?.writeText(TRUCK_PINGS_SQL); setSqlCopied(true); }}
            style={{ marginTop: 8, background: "#854F0B", border: "none", color: "#fff", fontWeight: 600,
              borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
            {sqlCopied ? t("Copied") : t("Copy SQL")}
          </button>
        </div>
      ) : (<>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 10, marginBottom: 14 }}>
          {[
            { l: "Miles driven", v: totals.miles.toLocaleString(), c: "#185FA5" },
            { l: "Labor paid", v: money(totals.pay), c: "#1A8A4E" },
            { l: "Labor per mile", v: totals.costPerMile == null ? "—" : "$" + totals.costPerMile.toFixed(2), c: "#7C3AED" },
            { l: "Moved, unpaid", v: totals.movedUnpaid, c: totals.movedUnpaid ? "#A32D2D" : "#aaa" },
            { l: "Paid, no movement", v: totals.paidNoMovement, c: totals.paidNoMovement ? "#854F0B" : "#aaa" },
          ].map(m => (
            <div key={m.l} style={card}>
              <div style={{ fontSize: 11, color: "#aaa", fontWeight: 500 }}>{m.l}</div>
              <div style={{ fontSize: 20, fontWeight: 800, color: m.c, marginTop: 3 }}>{m.v}</div>
            </div>
          ))}
        </div>

        <div style={{ fontSize: 11.5, color: "#999", marginBottom: 12, lineHeight: 1.5 }}>
          Miles are straight-line between GPS fixes, so the real road distance is higher. Hours here are the window between a truck's first and last movement, not hours driven — driver hours need the ELD, which is not connected yet.
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
          {[["all", `${tr("All", "Todos")} (${counts.all})`],
            ["moved_unpaid", `${tr("Moved, unpaid", "Se movió, sin pagar")} (${counts.moved_unpaid})`],
            ["paid_no_movement", `${tr("Paid, no movement", "Pagado, sin movimiento")} (${counts.paid_no_movement})`]].map(([v, l]) => (
            <button key={v} onClick={() => setKindFilter(v)}
              style={{ fontSize: 11.5, padding: "4px 10px", borderRadius: 20, cursor: "pointer", border: "1px solid",
                borderColor: kindFilter === v ? "#111" : "#e5e5e5", background: kindFilter === v ? "#111" : "#fff",
                color: kindFilter === v ? "#fff" : "#666", fontWeight: kindFilter === v ? 600 : 500 }}>{l}</button>
          ))}
        </div>

        <div style={{ background: "#fff", borderRadius: 10, border: "1px solid #efefef", overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead><tr>
              {["Date", "Truck", "Driver", "First move", "Last move", "Window", "Miles", "Paid", "Status"].map(h => <th key={h} style={th}>{h}</th>)}
            </tr></thead>
            <tbody>
              {visible.length === 0 ? (
                <tr><td colSpan={9} style={{ ...td, textAlign: "center", color: "#bbb", padding: "28px 10px" }}>
                  {loading ? t("Loading...") : t("Nothing in this period yet.")}
                </td></tr>
              ) : visible.map((r, i) => {
                const k = KIND[r.kind] || KIND.ok;
                return (
                  <tr key={`${r.truckId}|${r.date}|${i}`}>
                    <td style={td}>{r.date}</td>
                    <td style={{ ...td, fontWeight: 700 }}>{r.truckName}</td>
                    <td style={{ ...td, color: r.driverKnown ? "#111" : "#bbb" }}>
                      {r.driverName || tr("not assigned", "sin asignar")}
                    </td>
                    <td style={td}>{clock(r.firstMoveAt)}</td>
                    <td style={td}>{clock(r.lastMoveAt)}</td>
                    <td style={td}>{r.spanHours ? `${r.spanHours} h` : "—"}</td>
                    <td style={td}>{r.miles ? r.miles.toLocaleString() : "—"}</td>
                    <td style={td}>{r.pay ? money(r.pay) : "—"}</td>
                    <td style={td}>
                      <span style={{ fontSize: 10.5, fontWeight: 700, borderRadius: 20, padding: "2px 8px", background: k.bg, color: k.text }}>{k.l}</span>
                      {r.noHistory && <span style={{ fontSize: 10.5, color: "#bbb", marginLeft: 6 }}>{tr("no GPS history", "sin historial GPS")}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </>)}
    </div>
  );
}
