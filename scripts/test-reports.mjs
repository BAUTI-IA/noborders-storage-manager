// Unit tests for src/reportsData.js — the arithmetic behind the Reports
// section, checked without a browser or a database.
//
//   node scripts/test-reports.mjs
import {
  haversineMiles, truckDays, paidDays, reconcile, reportTotals,
} from "../src/reportsData.js";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
};
const T = (iso) => new Date(iso).toISOString();

// September 2026 puts America/New_York on EDT (UTC-4).
console.log("\nDistance");
// Atlanta → Nashville is about 214 straight-line miles.
const atlNas = haversineMiles(33.749, -84.388, 36.163, -86.781);
check("a known distance comes out right", Math.abs(atlNas - 214) < 4, atlNas.toFixed(1));
check("no distance between a point and itself", haversineMiles(33.7, -84.4, 33.7, -84.4) === 0);

console.log("\nTruck days");
// Out at 08:00 EDT, back at 17:00 EDT, roughly Atlanta → Athens → back.
const day = truckDays([
  { truck_id: 1, lat: 33.749, lng: -84.388, status: "stopped", at: T("2026-09-08T11:00:00Z") },
  { truck_id: 1, lat: 33.749, lng: -84.388, status: "moving",  at: T("2026-09-08T12:00:00Z") },
  { truck_id: 1, lat: 33.960, lng: -83.378, status: "moving",  at: T("2026-09-08T14:00:00Z") },
  { truck_id: 1, lat: 33.749, lng: -84.388, status: "stopped", at: T("2026-09-08T21:00:00Z") },
]);
check("one row for the truck's day", day.length === 1 && day[0].date === "2026-09-08", JSON.stringify(day));
check("the round trip adds up both ways", day[0].miles > 110 && day[0].miles < 130, String(day[0].miles));
check("first movement is when it actually left", day[0].firstMoveAt === "2026-09-08T12:00:00.000Z");
check("last movement is when it got back", day[0].lastMoveAt === "2026-09-08T21:00:00.000Z");
check("the working window is first to last", day[0].spanHours === 9);
check("it moved", day[0].moved === true);

// A truck parked all day: the GPS wanders a few metres between fixes.
const parked = truckDays([
  { truck_id: 2, lat: 33.74900, lng: -84.38800, status: "stopped", at: T("2026-09-08T12:00:00Z") },
  { truck_id: 2, lat: 33.74902, lng: -84.38803, status: "stopped", at: T("2026-09-08T15:00:00Z") },
  { truck_id: 2, lat: 33.74899, lng: -84.38798, status: "stopped", at: T("2026-09-08T18:00:00Z") },
]);
check("GPS drift is not mileage", parked[0].miles === 0, String(parked[0].miles));
check("a parked truck did not move", parked[0].moved === false && parked[0].spanHours === 0);

// 22:00 EDT to 01:00 EDT — the fixes belong to the days they happened on.
const overnight = truckDays([
  { truck_id: 3, lat: 33.749, lng: -84.388, status: "moving", at: T("2026-09-09T02:00:00Z") },
  { truck_id: 3, lat: 33.960, lng: -83.378, status: "moving", at: T("2026-09-09T05:00:00Z") },
]);
check("an overnight run splits by local day", overnight.length === 2 &&
  overnight[0].date === "2026-09-08" && overnight[1].date === "2026-09-09", JSON.stringify(overnight.map(r => r.date)));

check("no pings → no rows, not a crash", truckDays([]).length === 0 && truckDays(null).length === 0);
check("rows with no timestamp are ignored", truckDays([{ truck_id: 1, lat: 1, lng: 2 }]).length === 0);

console.log("\nPayroll rows");
const drivers = [{ id: 10, name: "Pedro", truck_id: 1, daily_rate: 250 }, { id: 11, name: "Ana", truck_id: 2, hourly_rate: 20 }];
const driversById = Object.fromEntries(drivers.map(d => [d.id, d]));
const paid = paidDays([
  { driver_id: 10, work_date: "2026-09-08", day_type: "full" },
  { driver_id: 11, work_date: "2026-09-08", day_type: "hourly", hours: 6 },
], driversById);
check("a full day pays the daily rate", paid.find(p => p.driverName === "Pedro").pay === 250);
check("an hourly day pays hours by rate", paid.find(p => p.driverName === "Ana").pay === 120);
check("the row carries the driver's truck", paid.find(p => p.driverName === "Pedro").truckId === 1);

console.log("\nReconciliation");
const trucksById = { 1: { id: 1, name: "BT002" }, 2: { id: 2, name: "BT003" } };
const rec = reconcile({
  truckDayRows: [
    { truckId: 1, date: "2026-09-08", miles: 120, spanHours: 9, moved: true, firstMoveAt: null, lastMoveAt: null },
    { truckId: 2, date: "2026-09-08", miles: 0, spanHours: 0, moved: false, firstMoveAt: null, lastMoveAt: null },
    { truckId: 1, date: "2026-09-07", miles: 80, spanHours: 6, moved: true, firstMoveAt: null, lastMoveAt: null },
  ],
  paidDayRows: paid.concat([{ driverId: 10, driverName: "Pedro", date: "2026-09-05", pay: 250, hours: null, truckId: 1 }]),
  trucksById, driversList: drivers,
});
const on8 = rec.find(r => r.date === "2026-09-08" && r.truckId === 1);
check("a moved day that was paid is fine", on8.kind === "ok" && on8.pay === 250);
const on7 = rec.find(r => r.date === "2026-09-07");
check("a truck that moved with nobody paid is flagged", on7.kind === "moved_unpaid" && on7.pay === 0);
const ana = rec.find(r => r.truckId === 2 && r.date === "2026-09-08");
check("a paid day with the truck parked is flagged", ana.kind === "paid_no_movement" && ana.noHistory !== true);
const sep5 = rec.find(r => r.date === "2026-09-05");
check("a paid day with no history at all says so, it is not an accusation",
  sep5.kind === "paid_no_movement" && sep5.noHistory === true);

console.log("\nTotals");
const tot = reportTotals(rec);
check("miles add up across the period", tot.miles === 200, String(tot.miles));
check("one day moved unpaid", tot.movedUnpaid === 1);
check("one paid day without movement, the no-history one excluded", tot.paidNoMovement === 1);
check("cost per mile divides pay by miles", tot.costPerMile === Math.round((tot.pay / 200) * 100) / 100);
check("no miles → no cost per mile instead of a division by zero",
  reportTotals([{ kind: "ok", miles: 0, pay: 100, driverKnown: true }]).costPerMile === null);

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
