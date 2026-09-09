// Pure math for the Reports section. Split from reports.jsx so every number here
// can be checked without a browser or a database (scripts/test-reports.mjs).
//
// The guiding fact about this data: the GPS is bolted to the truck, the driver
// login is not. So everything computed per TRUCK is solid, and anything per
// DRIVER inherits whatever discipline the login has. The reports say which is
// which instead of blending them into one number nobody can trust.
import { numv, workDayPay } from "./analyticsData.js";

const HOUR_MS = 3600e3;

// Straight-line miles. Road distance is longer, so treat these as a floor.
export function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.7613; // Earth radius, miles
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(lat2 - lat1), dLng = rad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// A local calendar day, so a run that ends after midnight lands on the right one.
export const dayIn = (at, tz) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(at));

// GPS pings → one row per truck per day: when it first and last moved, how long
// it was out, and how far it went.
//
// `minSegmentMiles` exists because a parked truck's GPS still wanders a few
// metres between fixes. Without a floor, a truck that sat in the yard all
// weekend reports miles it never drove.
export function truckDays(pings, { tz = "America/New_York", minSegmentMiles = 0.15 } = {}) {
  const byKey = new Map();
  for (const p of pings || []) {
    if (!p || p.truck_id == null || !p.at) continue;
    const t = new Date(p.at).getTime();
    if (isNaN(t)) continue;
    const key = `${p.truck_id}|${dayIn(t, tz)}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push({ ...p, t, lat: numv(p.lat), lng: numv(p.lng) });
  }

  const rows = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.t - b.t);
    const [truckId, date] = key.split("|");

    let miles = 0;
    let firstMove = null, lastMove = null;
    for (let i = 1; i < list.length; i++) {
      const a = list[i - 1], b = list[i];
      const seg = haversineMiles(a.lat, a.lng, b.lat, b.lng);
      if (seg < minSegmentMiles) continue;   // parked; GPS drift, not driving
      miles += seg;
      if (firstMove == null) firstMove = a.t;
      lastMove = b.t;
    }
    // A truck reported as moving counts as active even if it barely covered
    // ground — crawling in traffic is still a working truck.
    const movingFix = list.find(p => p.status === "moving");
    if (firstMove == null && movingFix) { firstMove = movingFix.t; lastMove = movingFix.t; }

    rows.push({
      truckId: Number(truckId),
      date,
      fixes: list.length,
      miles: Math.round(miles * 10) / 10,
      firstMoveAt: firstMove == null ? null : new Date(firstMove).toISOString(),
      lastMoveAt: lastMove == null ? null : new Date(lastMove).toISOString(),
      // Time between the first and last movement — the truck's working window,
      // not hours driven. Says nothing about who was in it.
      spanHours: firstMove == null ? 0 : Math.round(((lastMove - firstMove) / HOUR_MS) * 100) / 100,
      moved: firstMove != null,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.truckId - b.truckId);
}

// What payroll says, per driver per day, from the manual work-day rows.
export function paidDays(workDays, driversById) {
  const rows = [];
  for (const w of workDays || []) {
    if (!w || !w.driver_id || !w.work_date) continue;
    const d = driversById[w.driver_id];
    rows.push({
      driverId: w.driver_id,
      driverName: d?.name || `#${w.driver_id}`,
      date: w.work_date,
      dayType: w.day_type || "full",
      hours: w.hours == null ? null : numv(w.hours),
      pay: numv(workDayPay(w, d)),
      truckId: d?.truck_id ?? null,
    });
  }
  return rows.sort((a, b) => a.date.localeCompare(b.date) || a.driverName.localeCompare(b.driverName));
}

// The cross-check. Every (truck, day) the GPS saw, lined up against whether
// anybody got paid for it — and every paid day lined up against whether the
// truck actually moved.
//
// Driver attribution comes from drivers.truck_id, the CRM's own standing
// assignment. That is exactly as reliable as keeping it up to date, which is why
// each row carries `driverKnown`.
export function reconcile({ truckDayRows, paidDayRows, trucksById, driversList }) {
  const driverByTruck = {};
  for (const d of driversList || []) if (d.truck_id) driverByTruck[d.truck_id] = d;

  const paidIndex = new Map();
  for (const p of paidDayRows || []) {
    if (p.truckId != null) paidIndex.set(`${p.truckId}|${p.date}`, p);
  }

  const out = [];
  const seenPaid = new Set();
  for (const a of truckDayRows || []) {
    if (!a.moved) continue;   // a truck that never moved raises no question
    const key = `${a.truckId}|${a.date}`;
    const paid = paidIndex.get(key) || null;
    if (paid) seenPaid.add(key);
    const driver = driverByTruck[a.truckId];
    out.push({
      kind: paid ? "ok" : "moved_unpaid",
      date: a.date,
      truckId: a.truckId,
      truckName: trucksById[a.truckId]?.name || `#${a.truckId}`,
      driverName: paid?.driverName || driver?.name || null,
      driverKnown: Boolean(paid || driver),
      miles: a.miles,
      spanHours: a.spanHours,
      firstMoveAt: a.firstMoveAt,
      lastMoveAt: a.lastMoveAt,
      paidHours: paid?.hours ?? null,
      pay: paid?.pay ?? 0,
    });
  }

  // The mirror case: somebody was paid for a day the truck never left the yard.
  for (const p of paidDayRows || []) {
    if (p.truckId == null) continue;
    const key = `${p.truckId}|${p.date}`;
    if (seenPaid.has(key)) continue;
    const activity = (truckDayRows || []).find(a => a.truckId === p.truckId && a.date === p.date);
    if (activity && activity.moved) continue;
    out.push({
      kind: "paid_no_movement",
      date: p.date,
      truckId: p.truckId,
      truckName: trucksById[p.truckId]?.name || `#${p.truckId}`,
      driverName: p.driverName,
      driverKnown: true,
      miles: activity?.miles ?? 0,
      spanHours: 0,
      firstMoveAt: null,
      lastMoveAt: null,
      paidHours: p.hours,
      pay: p.pay,
      // No history for that day is not the same as a truck that stayed put.
      noHistory: !activity,
    });
  }

  return out.sort((a, b) => b.date.localeCompare(a.date) || a.truckName.localeCompare(b.truckName));
}

// Headline numbers for the period.
export function reportTotals(rows) {
  const t = { days: rows.length, miles: 0, pay: 0, movedUnpaid: 0, paidNoMovement: 0, unknownDriver: 0 };
  for (const r of rows) {
    t.miles += numv(r.miles);
    t.pay += numv(r.pay);
    if (r.kind === "moved_unpaid") t.movedUnpaid++;
    if (r.kind === "paid_no_movement" && !r.noHistory) t.paidNoMovement++;
    if (!r.driverKnown) t.unknownDriver++;
  }
  t.miles = Math.round(t.miles * 10) / 10;
  t.pay = Math.round(t.pay * 100) / 100;
  // Cost per mile only means something once there are miles to divide by.
  t.costPerMile = t.miles > 0 ? Math.round((t.pay / t.miles) * 100) / 100 : null;
  return t;
}
