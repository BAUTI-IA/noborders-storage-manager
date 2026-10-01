// Driver → trip suggestions.
//
// Assigning a driver to a job decides which truck the job rides: that driver's.
// So right after a driver is assigned (job form, calendar, dispatch board) the
// dispatcher gets a proposal for Trips / Live Load — put the job on the trip the
// driver already has, or open a new trip on the truck that driver usually
// drives — and the Trips page keeps a list of the jobs that have a driver but no
// trip yet. Nothing here writes: App.jsx shows the proposal and saves only what
// the dispatcher confirms. Pure — no React, no Supabase — so it runs under plain
// node (scripts/test-trip-assign-data.mjs).
import { numv, jobKey, effCf } from "./analyticsData.js";

// A trip is active while it is loading or on the road.
export const TRIP_ACTIVE = (s) => s === "loading" || s === "in_transit";

// Trip-layer identity. Everything OUTSIDE trips groups a job by jobKey (job_number),
// so a job stays ONE job in billing/analytics/client view. But a split job has
// "portion" rows (same job_number) that must ride different trucks, so inside the
// Trips layer the assignment unit is the individual row. Non-split rows keep
// collapsing by jobKey (no regression); split portions are addressed by row id.
export const tripUnitKey = (j) => j.split_group ? "row:" + j.id : jobKey(j);

// A trip past this share of its truck is full: the same 90% line the trip
// modal paints red and the AI planner keeps under.
export const TRIP_FULL_PCT = 90;
// Other jobs of the same driver picking up within this many days of the job
// just assigned are offered (pre-ticked) to ride on the same trip.
export const COMPANION_DAYS = 3;

const sameId = (a, b) => a != null && b != null && a !== "" && b !== "" && String(a) === String(b);
const dayNum = (s) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s || "");
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) / 86400000 : null;
};
// Whole days between two YYYY-MM-DD dates, null when either is missing.
export const daysApart = (a, b) => {
  const x = dayNum(a), y = dayNum(b);
  return x == null || y == null ? null : Math.abs(x - y);
};

// Start of the job's pickup window (the legacy single date as fallback).
export const pickupOf = (j) => j?.pickup_date_from || j?.pickup_date || "";
// The job's next move and its date: the pickup while it is still scheduled,
// the delivery once it is picked up, in storage or out. `date` may be "".
export function nextMove(j) {
  const s = j?.status || "scheduled";
  return s === "scheduled" ? { kind: "pickup", date: pickupOf(j) } : { kind: "delivery", date: j?.delivery_date || "" };
}
// Still has to move: not delivered, not cancelled.
export const jobOpen = (j) => !!j && !j.date_out && j.status !== "delivered" && j.status !== "cancelled";

// A job that should be on a truck: waiting for its pickup, already picked up or
// out for delivery, or sitting in storage with a delivery booked. Paused jobs
// (on hold, redispatched) and plain storage stock are not.
export function wantsTruck(j) {
  if (!jobOpen(j)) return false;
  const s = j.status || "scheduled";
  if (s === "scheduled" || s === "picked_up" || s === "out_for_delivery") return true;
  return s === "in_storage" && !!j.delivery_date;
}

// The job's drivers in order — index 0 is the primary, the one the money
// follows. Rows from before the drivers table only carry the free-text
// `driver` field; those resolve by exact name ("Juan, Pedro").
export function jobDriverIds(j, drivers) {
  const out = [];
  const push = (v) => { const n = Number(v); if (Number.isFinite(n) && n > 0 && !out.includes(n)) out.push(n); };
  if (Array.isArray(j?.driver_ids)) j.driver_ids.forEach(push);
  if (!out.length && j?.driver && drivers?.length) {
    for (const part of String(j.driver).split(",")) {
      const nm = part.trim().toLowerCase();
      if (!nm) continue;
      const hit = drivers.filter(d => (d.name || "").trim().toLowerCase() === nm);
      if (hit.length === 1) push(hit[0].id);
    }
  }
  return out;
}
// `id` first, everyone else kept in order — the dispatcher picked which of the
// job's drivers takes the truck.
export const promote = (ids, id) => [Number(id), ...(ids || []).filter(x => !sameId(x, id))];
// `to` replaces `from` as the primary and any other drivers stay — the same
// rule as a driver handoff.
export const handOver = (ids, from, to) => [Number(to), ...(ids || []).filter(x => !sameId(x, to) && !sameId(x, from))];

// The truck a driver usually drives. drivers.truck_id is a text column: the
// Drivers form stores the truck's id there, while older rows may still hold a
// name or plate typed by hand ("T-12"). Falls back to the truck of the
// driver's latest trip. Returns { truck, source }, source being "linked" (id),
// "named" (legacy text), "history" (last trip) or null.
export function driverTruck(driver, trucks, trips) {
  if (!driver) return { truck: null, source: null };
  const list = trucks || [];
  const raw = String(driver.truck_id ?? "").trim();
  if (raw) {
    const byId = list.find(t => String(t.id) === raw);
    if (byId) return { truck: byId, source: "linked" };
    const low = raw.toLowerCase();
    const byName = list.find(t => [t.name, t.plate, t.license_plate].some(v => v && String(v).trim().toLowerCase() === low));
    if (byName) return { truck: byName, source: "named" };
  }
  const when = (t) => String(t.departure_date || t.created_at || "").slice(0, 10);
  const past = (trips || [])
    .filter(t => sameId(t.driver_id, driver.id) && t.truck_id != null && t.status !== "cancelled")
    .sort((a, b) => when(b).localeCompare(when(a)) || (Number(b.id) - Number(a.id)));
  for (const t of past) {
    const tk = list.find(x => sameId(x.id, t.truck_id));
    if (tk) return { truck: tk, source: "history" };
  }
  return { truck: null, source: null };
}

// CF a trip already carries, by the Trips page's rules: a trip still loading
// counts everything assigned to it; a trip on the road counts only what is
// aboard (delivered stops and loads dropped in storage no longer take room).
export function tripLoadCf(trip, jobs) {
  const seen = new Set();
  let total = 0, aboard = 0;
  for (const j of jobs || []) {
    if (!sameId(j.trip_id, trip?.id)) continue;
    const k = tripUnitKey(j);
    if (seen.has(k)) continue;
    seen.add(k);
    const cf = effCf(j);
    total += cf;
    if (!(j.date_out || j.status === "delivered") && j.status !== "in_storage") aboard += cf;
  }
  return trip?.status === "loading" ? total : aboard;
}

// Load-bar numbers once `addCf` more rides on a truck of `cap` CF.
export function capacity(cap, loadCf, addCf) {
  const c = numv(cap), before = numv(loadCf), after = before + numv(addCf);
  return {
    cap: c, before, after,
    pctBefore: c > 0 ? Math.round(before / c * 100) : null,
    pctAfter: c > 0 ? Math.round(after / c * 100) : null,
    full: c > 0 && after > c * TRIP_FULL_PCT / 100,
  };
}

// One job's open trip units — a split portion is its own unit, an ordinary job
// is one unit however many storage rows it spans — with the active trip each
// one is on (null when none: no trip, or a trip already closed). CF counts once
// per unit, as everywhere in the Trips layer.
export function jobUnits(rows, trips) {
  const byId = new Map((trips || []).map(t => [String(t.id), t]));
  const m = new Map();
  for (const j of rows || []) {
    if (!jobOpen(j)) continue;
    const k = tripUnitKey(j);
    if (!m.has(k)) m.set(k, { key: k, row: j, cf: effCf(j), trip: null });
    const u = m.get(k);
    const t = j.trip_id != null ? byId.get(String(j.trip_id)) : null;
    if (!u.trip && t && TRIP_ACTIVE(t.status)) u.trip = t;
  }
  return [...m.values()];
}

// Where a unit stands for a driver:
//   "own"    on an active trip of that driver — nothing to do,
//   "claim"  on an active trip with no driver — giving it the driver claims it,
//   "move"   on another driver's trip that is still loading — can change trip,
//   "locked" on another driver's trip already on the road — that is a handoff,
//            done from the trip itself, never from here,
//   "free"   on no trip.
export function unitState(u, driverId) {
  if (!u.trip) return "free";
  if (sameId(u.trip.driver_id, driverId)) return "own";
  if (u.trip.driver_id == null || u.trip.driver_id === "") return "claim";
  return u.trip.status === "loading" ? "move" : "locked";
}

// Does the job still need a trip for these drivers? True when some unit has no
// trip, sits on a trip with no driver, or is on a loading trip driven by
// somebody who is not one of the job's drivers (the driver just changed).
export function needsTripFor(rows, driverIds, trips) {
  const ids = driverIds || [];
  return jobUnits(rows, trips).some(u =>
    !u.trip || u.trip.driver_id == null || u.trip.driver_id === ""
    || (u.trip.status === "loading" && !ids.some(id => sameId(id, u.trip.driver_id))));
}

// Next free stop number on a trip: after every job stop and custom stop it has.
export function nextStopOrder(tripId, jobs, customStops) {
  let max = 0, n = 0;
  const seen = new Set();
  for (const j of jobs || []) {
    if (!sameId(j.trip_id, tripId)) continue;
    const k = tripUnitKey(j);
    if (!seen.has(k)) { seen.add(k); n++; }
    max = Math.max(max, numv(j.trip_stop_order));
  }
  for (const s of customStops || []) {
    if (!sameId(s.trip_id, tripId)) continue;
    n++;
    max = Math.max(max, numv(s.stop_order));
  }
  return Math.max(max, n) + 1;
}

// Rows grouped by job (jobKey), in load order.
function byJobKey(jobs) {
  const m = new Map();
  for (const j of jobs || []) {
    const k = jobKey(j);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(j);
  }
  return m;
}
// The row that carries the job-level fields: a non-split row if any.
const repRow = (rows) => rows.find(r => !r.split_group) || rows[0];

// Other jobs of this driver (as primary) that should be on a truck and have no
// trip, nearest next move first. Those moving within `days` of `date` (the
// next move of the job being placed) come back `near` — the popup pre-ticks
// them to ride along.
export function companionUnits({ driverId, excludeJobKey, date, jobs, trips, drivers, days = COMPANION_DAYS }) {
  const out = [];
  for (const [k, rows] of byJobKey(jobs)) {
    if (k === excludeJobKey) continue;
    if (!sameId(jobDriverIds(repRow(rows), drivers)[0], driverId)) continue;
    for (const u of jobUnits(rows, trips)) {
      if (u.trip || !wantsTruck(u.row)) continue;
      const move = nextMove(u.row);
      const d = daysApart(date, move.date);
      out.push({ ...u, move, days: d, near: d != null && d <= days });
    }
  }
  out.sort((a, b) => (Number(b.near) - Number(a.near))
    || ((a.days ?? 1e9) - (b.days ?? 1e9))
    || String(a.row.job_number || "").localeCompare(String(b.row.job_number || "")));
  return out;
}

// Everything the suggestion popup shows for one job and the driver who will
// take it. `options` are the trips the job can ride, best first:
//   • active trips with no driver that already carry this job (claim them),
//   • the trips this driver already has — loading before on the road, then the
//     departure closest to the job's next move (pickup, or delivery once
//     picked up),
//   • a new trip on the driver's usual truck, leaving on that date (today if
//     it is already past or unknown).
// Each option says which of the job's units it would place (`placeKeys`) and
// what its truck carries now. Units on another driver's trip that is already
// on the road never move from here; they come back in `locked`.
export function suggestTrip({ rows, driverId, jobs, trips, trucks, drivers, today }) {
  const driver = (drivers || []).find(d => sameId(d.id, driverId)) || null;
  const units = jobUnits(rows, trips);
  const rep = repRow(rows || []) || {};
  const move = nextMove(rep);
  const when = move.date;
  const states = new Map(units.map(u => [u.key, unitState(u, driverId)]));
  const truckOf = (id) => (trucks || []).find(t => sameId(t.id, id)) || null;
  // What an option would put on its trip: units with no trip, or on a trip that
  // is still loading. A unit already aboard a truck on the road stays there.
  const placeable = (tripId) => units.filter(u => {
    const s = states.get(u.key);
    if (s === "own" || s === "locked") return false;
    if (u.trip && tripId != null && sameId(u.trip.id, tripId)) return false;
    return !u.trip || u.trip.status === "loading";
  });
  const option = (o) => {
    const place = placeable(o.trip?.id);
    return { ...o, placeKeys: place.map(u => u.key), placeCf: place.reduce((s, u) => s + u.cf, 0) };
  };

  const claimTrips = [];
  for (const u of units) {
    if (states.get(u.key) === "claim" && !claimTrips.some(t => sameId(t.id, u.trip.id))) claimTrips.push(u.trip);
  }
  const near = (t) => daysApart(t.departure_date, when) ?? 1e9;
  const ownTrips = (trips || [])
    .filter(t => sameId(t.driver_id, driverId) && TRIP_ACTIVE(t.status))
    .sort((a, b) => ((a.status === "loading" ? 0 : 1) - (b.status === "loading" ? 0 : 1)) || (near(a) - near(b)) || (Number(a.id) - Number(b.id)));

  const options = [
    ...claimTrips.map(t => option({ key: "trip:" + t.id, kind: "existing", claim: true, trip: t, truck: truckOf(t.truck_id), loadCf: tripLoadCf(t, jobs) })),
    ...ownTrips.map(t => option({ key: "trip:" + t.id, kind: "existing", claim: false, trip: t, truck: truckOf(t.truck_id), loadCf: tripLoadCf(t, jobs) })),
  ];
  const { truck, source } = driverTruck(driver, trucks, trips);
  options.push(option({
    key: "new", kind: "new", claim: false, trip: null, truck, truckSource: source, loadCf: 0,
    departure: when && today && when >= today ? when : (today || when || ""),
  }));

  const done = units.filter(u => states.get(u.key) === "own");
  const locked = units.filter(u => states.get(u.key) === "locked");
  const pending = units.filter(u => { const s = states.get(u.key); return s !== "own" && s !== "locked"; });
  const companions = driver ? companionUnits({ driverId, excludeJobKey: rows?.length ? jobKey(rows[0]) : null, date: when, jobs, trips, drivers }) : [];
  return { driver, units, move, options, done, locked, pending, companions };
}

// The active trip a truck is already on (any driver but `exceptDriverId`'s).
export function truckBusyTrip(truckId, trips, exceptDriverId) {
  if (truckId == null || truckId === "") return null;
  return (trips || []).find(t => sameId(t.truck_id, truckId) && TRIP_ACTIVE(t.status) && !sameId(t.driver_id, exceptDriverId)) || null;
}

// The Trips page list: every job with a driver whose units should be on a
// truck but still need a trip (no trip yet, or on a trip that has no driver),
// soonest next move first, undated last. `dismissed` holds the `sig`s the
// dispatcher put aside ("jobKey|driver ids"): assigning different drivers
// brings the job back.
export function jobsAwaitingTrip({ jobs, trips, drivers, dismissed }) {
  const out = [];
  for (const [key, rows] of byJobKey(jobs)) {
    const rep = repRow(rows);
    const driverIds = jobDriverIds(rep, drivers);
    if (!driverIds.length) continue;
    const units = jobUnits(rows, trips).filter(u => wantsTruck(u.row) && (!u.trip || u.trip.driver_id == null || u.trip.driver_id === ""));
    if (!units.length) continue;
    const sig = key + "|" + driverIds.join(",");
    if (dismissed && dismissed.has(sig)) continue;
    out.push({ key, rows, rep, driverIds, units, sig, move: nextMove(rep) });
  }
  out.sort((a, b) => (a.move.date || "9999").localeCompare(b.move.date || "9999") || String(a.rep.job_number || "").localeCompare(String(b.rep.job_number || "")));
  return out;
}

// Keeping a trip and its jobs on the same driver once the trip has one. For
// each open unit on the trip:
//   "fill"    nobody assigned yet → the trip driver,
//   "promote" the trip driver is one of the job's drivers but not the first
//             → moved to the front (money defaults follow who drives). Only
//             for the units in `promoteKeys` (null = all): which of a job's
//             drivers is the main one is the dispatcher's call, so it changes
//             when the job joins the trip or the trip changes hands — never
//             on an unrelated save,
//   "follow"  the job was the previous trip driver's → hands over to the new
//             one, like a driver handoff (the caller asks first),
// and jobs handed to a third driver on purpose are left alone.
// `units` = [{ key, rows }]; returns [{ key, rows, before, after, kind }].
export function tripDriverSync({ units, toDriverId, fromDriverId, drivers, promoteKeys = null }) {
  const out = [];
  if (toDriverId == null || toDriverId === "") return out;
  for (const { key, rows } of units || []) {
    const open = (rows || []).filter(jobOpen);
    if (!open.length) continue;
    const r = repRow(open);
    const cur = jobDriverIds(r, drivers);
    if (sameId(cur[0], toDriverId)) continue;
    if (!cur.length) {
      // A free-text driver nobody could resolve stays as typed.
      if (!String(r.driver || "").trim()) out.push({ key, rows: open, before: cur, after: [Number(toDriverId)], kind: "fill" });
    } else if (cur.some(x => sameId(x, toDriverId))) {
      if (!promoteKeys || promoteKeys.has(key)) out.push({ key, rows: open, before: cur, after: promote(cur, toDriverId), kind: "promote" });
    } else if (fromDriverId != null && fromDriverId !== "" && sameId(cur[0], fromDriverId)) {
      out.push({ key, rows: open, before: cur, after: handOver(cur, fromDriverId, toDriverId), kind: "follow" });
    }
  }
  return out;
}
