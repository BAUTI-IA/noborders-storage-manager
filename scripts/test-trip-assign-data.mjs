// Fixture tests for the driver → trip suggestion math (src/tripAssignData.js).
// Run: node scripts/test-trip-assign-data.mjs
import assert from "node:assert/strict";
import {
  TRIP_ACTIVE, tripUnitKey, daysApart, pickupOf, nextMove, jobOpen, wantsTruck,
  jobDriverIds, promote, handOver, driverTruck, tripLoadCf, capacity,
  jobUnits, unitState, needsTripFor, nextStopOrder, companionUnits,
  suggestTrip, truckBusyTrip, jobsAwaitingTrip, tripDriverSync,
} from "../src/tripAssignData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const TODAY = "2026-10-01";
const DRIVERS = [
  { id: 1, name: "Juan Perez", truck_id: "10" },   // linked to truck 10 by id
  { id: 2, name: "Pedro Gomez", truck_id: "T-20" }, // legacy free text → truck 20 by name
  { id: 3, name: "Ana Diaz", truck_id: "" },        // no truck: falls back to her last trip
  { id: 4, name: "Leo Ruiz", truck_id: "nope" },    // unresolvable text, no trips
];
const TRUCKS = [
  { id: 10, name: "Truck 10", capacity_cf: 2000 },
  { id: 20, name: "T-20", capacity_cf: 1000 },
  { id: 30, name: "Truck 30", plate: "ABC123", capacity_cf: 1500 },
];
const job = (o) => ({ id: o.id, job_number: o.job_number ?? `J${o.id}`, status: "scheduled", volume: "", driver_ids: [], ...o });

// ── Small helpers ────────────────────────────────────────────────────────────

t("TRIP_ACTIVE: loading and in transit only", () => {
  assert.equal(TRIP_ACTIVE("loading"), true);
  assert.equal(TRIP_ACTIVE("in_transit"), true);
  assert.equal(TRIP_ACTIVE("completed"), false);
  assert.equal(TRIP_ACTIVE("cancelled"), false);
});

t("tripUnitKey: split portions by row, others by job number", () => {
  assert.equal(tripUnitKey({ id: 5, job_number: "A-1" }), "n:a-1");
  assert.equal(tripUnitKey({ id: 6, job_number: "A-1", split_group: "g" }), "row:6");
  assert.equal(tripUnitKey({ id: 7, job_number: "" }), "id:7");
});

t("daysApart / pickupOf / jobOpen", () => {
  assert.equal(daysApart("2026-10-01", "2026-10-04"), 3);
  assert.equal(daysApart("2026-12-31", "2027-01-01"), 1);
  assert.equal(daysApart("", "2026-10-01"), null);
  assert.equal(pickupOf({ pickup_date_from: "2026-10-02", pickup_date: "2026-09-01" }), "2026-10-02");
  assert.equal(pickupOf({ pickup_date: "2026-09-01" }), "2026-09-01");
  assert.equal(jobOpen({ status: "scheduled" }), true);
  assert.equal(jobOpen({ status: "delivered" }), false);
  assert.equal(jobOpen({ status: "in_storage", date_out: "2026-09-01" }), false);
  assert.equal(jobOpen({ status: "cancelled" }), false);
});

t("nextMove: the pickup while scheduled, the delivery after that", () => {
  assert.deepEqual(nextMove({ status: "scheduled", pickup_date_from: "2026-10-02", delivery_date: "2026-10-09" }), { kind: "pickup", date: "2026-10-02" });
  assert.deepEqual(nextMove({ pickup_date: "2026-10-02" }), { kind: "pickup", date: "2026-10-02" }); // no status = scheduled
  assert.deepEqual(nextMove({ status: "in_storage", pickup_date: "2026-09-01", delivery_date: "2026-10-09" }), { kind: "delivery", date: "2026-10-09" });
  assert.deepEqual(nextMove({ status: "picked_up", pickup_date: "2026-09-01" }), { kind: "delivery", date: "" });
});

t("wantsTruck: live statuses, storage only with a delivery booked", () => {
  assert.equal(wantsTruck({ status: "scheduled" }), true);
  assert.equal(wantsTruck({ status: "picked_up" }), true);
  assert.equal(wantsTruck({ status: "out_for_delivery" }), true);
  assert.equal(wantsTruck({ status: "in_storage" }), false);
  assert.equal(wantsTruck({ status: "in_storage", delivery_date: "2026-10-09" }), true);
  assert.equal(wantsTruck({ status: "on_hold" }), false);
  assert.equal(wantsTruck({ status: "delivered" }), false);
});

t("jobDriverIds: ids in order, deduped; legacy names resolve exactly once", () => {
  assert.deepEqual(jobDriverIds({ driver_ids: [2, "1", 2, null] }), [2, 1]);
  assert.deepEqual(jobDriverIds({ driver_ids: [], driver: "pedro gomez, Juan Perez" }, DRIVERS), [2, 1]);
  assert.deepEqual(jobDriverIds({ driver: "Somebody Else" }, DRIVERS), []);
  // Two drivers with the same name are ambiguous → not resolved.
  assert.deepEqual(jobDriverIds({ driver: "Ana Diaz" }, [...DRIVERS, { id: 9, name: "Ana Diaz" }]), []);
  // ids win over the text field.
  assert.deepEqual(jobDriverIds({ driver_ids: [3], driver: "Juan Perez" }, DRIVERS), [3]);
});

t("promote keeps everyone; handOver drops the previous primary", () => {
  assert.deepEqual(promote([1, 2, 3], 2), [2, 1, 3]);
  assert.deepEqual(promote([1], 4), [4, 1]);
  assert.deepEqual(handOver([1, 2, 3], 1, 4), [4, 2, 3]);
  assert.deepEqual(handOver([1, 2], 1, 2), [2]);
});

// ── Driver → truck ───────────────────────────────────────────────────────────

t("driverTruck: by id, by legacy name/plate, by last trip, or nothing", () => {
  const trips = [
    { id: 1, driver_id: 3, truck_id: 20, departure_date: "2026-08-01", status: "completed" },
    { id: 2, driver_id: 3, truck_id: 30, departure_date: "2026-09-15", status: "completed" },
    { id: 3, driver_id: 3, truck_id: 10, departure_date: "2026-09-20", status: "cancelled" },
  ];
  assert.equal(driverTruck(DRIVERS[0], TRUCKS, trips).truck.id, 10);
  assert.equal(driverTruck(DRIVERS[0], TRUCKS, trips).source, "linked");
  assert.equal(driverTruck(DRIVERS[1], TRUCKS, trips).truck.id, 20);
  assert.equal(driverTruck(DRIVERS[1], TRUCKS, trips).source, "named");
  assert.equal(driverTruck({ id: 8, truck_id: "abc123" }, TRUCKS, []).truck.id, 30); // plate, any case
  // Latest non-cancelled trip wins.
  assert.deepEqual([driverTruck(DRIVERS[2], TRUCKS, trips).truck.id, driverTruck(DRIVERS[2], TRUCKS, trips).source], [30, "history"]);
  assert.deepEqual(driverTruck(DRIVERS[3], TRUCKS, trips), { truck: null, source: null });
  assert.deepEqual(driverTruck(null, TRUCKS, trips), { truck: null, source: null });
});

// ── Load / capacity ──────────────────────────────────────────────────────────

t("tripLoadCf: loading counts everything; on the road only what is aboard", () => {
  const jobs = [
    job({ id: 1, trip_id: 7, volume: "500" }),
    job({ id: 2, job_number: "J1", trip_id: 7, volume: "500" }),      // same unit as id 1 → once
    job({ id: 3, trip_id: 7, real_cf: 300, volume: "900" }),          // real CF beats the estimate
    job({ id: 4, trip_id: 7, volume: "200", status: "delivered", date_out: "2026-09-30" }),
    job({ id: 5, trip_id: 7, volume: "100", status: "in_storage" }),
    job({ id: 6, trip_id: 8, volume: "999" }),
  ];
  assert.equal(tripLoadCf({ id: 7, status: "loading" }, jobs), 500 + 300 + 200 + 100);
  assert.equal(tripLoadCf({ id: 7, status: "in_transit" }, jobs), 500 + 300);
});

t("capacity: percentages and the 90% full line", () => {
  assert.deepEqual(capacity(1000, 600, 200), { cap: 1000, before: 600, after: 800, pctBefore: 60, pctAfter: 80, full: false });
  assert.equal(capacity(1000, 600, 301).full, true);
  assert.equal(capacity(1000, 600, 300).full, false); // exactly 90% is still fine
  assert.deepEqual(capacity(0, 100, 50), { cap: 0, before: 100, after: 150, pctBefore: null, pctAfter: null, full: false });
});

// ── Units ────────────────────────────────────────────────────────────────────

t("jobUnits: one unit per job, split portions apart, active trip from any row", () => {
  const trips = [{ id: 7, status: "loading", driver_id: 1 }, { id: 8, status: "completed", driver_id: 1 }];
  const rows = [
    job({ id: 1, job_number: "A", volume: "400" }),                     // newer storage row, no trip
    job({ id: 2, job_number: "A", volume: "400", trip_id: 7 }),         // same unit, on trip 7
    job({ id: 3, job_number: "A", split_group: "g", real_cf: 150, trip_id: 8 }), // portion on a closed trip
    job({ id: 4, job_number: "A", split_group: "g", real_cf: 50, status: "delivered", date_out: "2026-09-01" }),
  ];
  const u = jobUnits(rows, trips);
  assert.equal(u.length, 2);
  assert.equal(u[0].key, "n:a"); assert.equal(u[0].cf, 400); assert.equal(u[0].trip.id, 7);
  assert.equal(u[1].key, "row:3"); assert.equal(u[1].cf, 150); assert.equal(u[1].trip, null); // closed trip = no trip
});

t("unitState / needsTripFor", () => {
  const free = { trip: null };
  const own = { trip: { id: 1, driver_id: 1, status: "loading" } };
  const noDrv = { trip: { id: 2, driver_id: null, status: "loading" } };
  const otherLoading = { trip: { id: 3, driver_id: 2, status: "loading" } };
  const otherRoad = { trip: { id: 4, driver_id: 2, status: "in_transit" } };
  assert.deepEqual([free, own, noDrv, otherLoading, otherRoad].map(u => unitState(u, 1)), ["free", "own", "claim", "move", "locked"]);

  const trips = [{ id: 1, driver_id: 1, status: "loading" }, { id: 3, driver_id: 2, status: "loading" }, { id: 4, driver_id: 2, status: "in_transit" }];
  assert.equal(needsTripFor([job({ id: 1 })], [1], trips), true);                    // no trip
  assert.equal(needsTripFor([job({ id: 1, trip_id: 1 })], [1], trips), false);       // on own trip
  assert.equal(needsTripFor([job({ id: 1, trip_id: 3 })], [1], trips), true);        // loading trip of a driver no longer on the job
  assert.equal(needsTripFor([job({ id: 1, trip_id: 3 })], [1, 2], trips), false);    // …unless that driver is still on it
  assert.equal(needsTripFor([job({ id: 1, trip_id: 4 })], [1], trips), false);       // on the road: a handoff, not a suggestion
  assert.equal(needsTripFor([job({ id: 1, status: "delivered", date_out: "x" })], [1], trips), false);
});

t("nextStopOrder: after the highest job or custom stop", () => {
  const jobs = [job({ id: 1, trip_id: 7, trip_stop_order: 1 }), job({ id: 2, trip_id: 7, trip_stop_order: 4 }), job({ id: 3, trip_id: 8, trip_stop_order: 9 })];
  assert.equal(nextStopOrder(7, jobs, [{ trip_id: 7, stop_order: 2 }]), 5);
  assert.equal(nextStopOrder(7, jobs, [{ trip_id: 7, stop_order: 6 }]), 7);
  assert.equal(nextStopOrder(9, jobs, []), 1);
  // Unnumbered stops still count, so nothing lands on top of them.
  assert.equal(nextStopOrder(7, [job({ id: 1, trip_id: 7 }), job({ id: 2, trip_id: 7 })], []), 3);
});

// ── Companions ───────────────────────────────────────────────────────────────

t("companionUnits: same primary driver, no trip, nearest pickup first", () => {
  const trips = [{ id: 7, driver_id: 1, status: "loading" }];
  const jobs = [
    job({ id: 1, job_number: "ANCHOR", driver_ids: [1], pickup_date: "2026-10-05" }),
    job({ id: 2, job_number: "NEAR", driver_ids: [1], pickup_date_from: "2026-10-07", volume: "100" }),
    job({ id: 3, job_number: "FAR", driver_ids: [1], pickup_date: "2026-10-30" }),
    job({ id: 4, job_number: "UNDATED", driver_ids: [1] }),
    job({ id: 5, job_number: "SECOND", driver_ids: [2, 1], pickup_date: "2026-10-05" }), // not primary
    job({ id: 6, job_number: "ONTRIP", driver_ids: [1], pickup_date: "2026-10-05", trip_id: 7 }),
    job({ id: 7, job_number: "HOLD", driver_ids: [1], pickup_date: "2026-10-05", status: "on_hold" }),
    job({ id: 8, job_number: "STOCK", driver_ids: [1], pickup_date: "2026-10-05", status: "in_storage" }),
  ];
  const c = companionUnits({ driverId: 1, excludeJobKey: "n:anchor", date: "2026-10-05", jobs, trips, drivers: DRIVERS });
  assert.deepEqual(c.map(x => x.row.job_number), ["NEAR", "FAR", "UNDATED"]);
  assert.deepEqual(c.map(x => x.near), [true, false, false]);
  assert.equal(c[0].days, 2); assert.equal(c[0].cf, 100);
});

// ── The suggestion ───────────────────────────────────────────────────────────

t("suggestTrip: the driver's loading trip comes first, with its load", () => {
  const trips = [
    { id: 7, trip_number: "TRIP-007", driver_id: 1, truck_id: 10, status: "in_transit", departure_date: "2026-09-28" },
    { id: 8, trip_number: "TRIP-008", driver_id: 1, truck_id: 10, status: "loading", departure_date: "2026-10-20" },
    { id: 9, trip_number: "TRIP-009", driver_id: 1, truck_id: 10, status: "loading", departure_date: "2026-10-04" },
  ];
  const jobs = [
    job({ id: 1, job_number: "A", driver_ids: [1], volume: "300", pickup_date: "2026-10-05" }),
    job({ id: 2, job_number: "B", driver_ids: [1], volume: "1000", trip_id: 9 }),
    job({ id: 3, job_number: "C", driver_ids: [1], volume: "250", pickup_date: "2026-10-06" }),
  ];
  const s = suggestTrip({ rows: [jobs[0]], driverId: 1, jobs, trips, trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.equal(s.driver.name, "Juan Perez");
  // Loading trips before the one on the road; closest departure to the pickup first.
  assert.deepEqual(s.options.map(o => o.key), ["trip:9", "trip:8", "trip:7", "new"]);
  assert.equal(s.options[0].loadCf, 1000);
  assert.equal(s.options[0].truck.id, 10);
  assert.deepEqual(s.options[0].placeKeys, ["n:a"]);
  assert.equal(s.options[0].placeCf, 300);
  assert.equal(s.pending.length, 1);
  assert.deepEqual(s.companions.map(c => c.row.job_number), ["C"]);
  assert.equal(s.companions[0].near, true);
});

t("suggestTrip: no trips yet → a new trip on the driver's truck, leaving on the pickup", () => {
  const jobs = [job({ id: 1, job_number: "A", driver_ids: [2], volume: "300", pickup_date: "2026-10-05" })];
  const s = suggestTrip({ rows: jobs, driverId: 2, jobs, trips: [], trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.equal(s.options.length, 1);
  const o = s.options[0];
  assert.equal(o.kind, "new");
  assert.equal(o.truck.id, 20);
  assert.equal(o.truckSource, "named");
  assert.equal(o.departure, "2026-10-05");
  assert.deepEqual(o.placeKeys, ["n:a"]);
  // A pickup already past leaves today.
  const late = suggestTrip({ rows: [{ ...jobs[0], pickup_date: "2026-09-20" }], driverId: 2, jobs, trips: [], trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.equal(late.options[0].departure, TODAY);
  // No pickup at all → today too.
  const none = suggestTrip({ rows: [{ ...jobs[0], pickup_date: "" }], driverId: 2, jobs, trips: [], trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.equal(none.options[0].departure, TODAY);
});

t("suggestTrip: a job in storage leaves on its delivery date", () => {
  const jobs = [
    job({ id: 1, job_number: "A", driver_ids: [1], status: "in_storage", pickup_date: "2026-09-01", delivery_date: "2026-10-12", volume: "300" }),
    job({ id: 2, job_number: "B", driver_ids: [1], status: "in_storage", pickup_date: "2026-09-02", delivery_date: "2026-10-13" }),
    job({ id: 3, job_number: "C", driver_ids: [1], status: "scheduled", pickup_date: "2026-10-12" }),
  ];
  const s = suggestTrip({ rows: [jobs[0]], driverId: 1, jobs, trips: [], trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.deepEqual(s.move, { kind: "delivery", date: "2026-10-12" });
  assert.equal(s.options[0].departure, "2026-10-12");
  // Companions line up on their own next move: B delivers the day after, C picks up the same day.
  assert.deepEqual(s.companions.map(c => [c.row.job_number, c.move.kind, c.days]), [["C", "pickup", 0], ["B", "delivery", 1]]);
});

t("suggestTrip: a driverless trip already carrying the job is claimed first", () => {
  const trips = [
    { id: 5, trip_number: "TRIP-005", driver_id: null, truck_id: 30, status: "loading" },
    { id: 6, trip_number: "TRIP-006", driver_id: 1, truck_id: 10, status: "loading" },
  ];
  const jobs = [
    job({ id: 1, job_number: "A", driver_ids: [1], volume: "300", trip_id: 5 }),
    job({ id: 2, job_number: "A", split_group: "g", driver_ids: [1], real_cf: 100 }),   // a free portion
  ];
  const s = suggestTrip({ rows: jobs, driverId: 1, jobs, trips, trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.deepEqual(s.options.map(o => [o.key, o.claim]), [["trip:5", true], ["trip:6", false], ["new", false]]);
  // Claiming trip 5 only has to place the free portion; trip 6 would take both.
  assert.deepEqual(s.options[0].placeKeys, ["row:2"]);
  assert.deepEqual(s.options[1].placeKeys.sort(), ["n:a", "row:2"]);
});

t("suggestTrip: units on another driver's trip — loading moves, on the road stays", () => {
  const trips = [
    { id: 3, driver_id: 2, truck_id: 20, status: "loading" },
    { id: 4, driver_id: 2, truck_id: 20, status: "in_transit" },
  ];
  const rows = [
    job({ id: 1, job_number: "A", split_group: "g", driver_ids: [1], real_cf: 100, trip_id: 3 }),
    job({ id: 2, job_number: "A", split_group: "g", driver_ids: [1], real_cf: 200, trip_id: 4 }),
  ];
  const s = suggestTrip({ rows, driverId: 1, jobs: rows, trips, trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.deepEqual(s.locked.map(u => u.key), ["row:2"]);
  assert.deepEqual(s.pending.map(u => u.key), ["row:1"]);
  assert.deepEqual(s.options.map(o => o.key), ["new"]);
  assert.deepEqual(s.options[0].placeKeys, ["row:1"]);
});

t("suggestTrip: already on the driver's trip → nothing pending", () => {
  const trips = [{ id: 6, driver_id: 1, truck_id: 10, status: "loading" }];
  const rows = [job({ id: 1, job_number: "A", driver_ids: [1], trip_id: 6 })];
  const s = suggestTrip({ rows, driverId: 1, jobs: rows, trips, trucks: TRUCKS, drivers: DRIVERS, today: TODAY });
  assert.equal(s.pending.length, 0);
  assert.deepEqual(s.done.map(u => u.key), ["n:a"]);
  assert.deepEqual(s.options[0].placeKeys, []);
});

t("truckBusyTrip: the active trip another driver has on that truck", () => {
  const trips = [
    { id: 1, truck_id: 10, driver_id: 2, status: "in_transit" },
    { id: 2, truck_id: 20, driver_id: 1, status: "loading" },
    { id: 3, truck_id: 30, driver_id: 2, status: "completed" },
  ];
  assert.equal(truckBusyTrip(10, trips, 1).id, 1);
  assert.equal(truckBusyTrip(20, trips, 1), null); // the driver's own trip
  assert.equal(truckBusyTrip(30, trips, 1), null); // finished
  assert.equal(truckBusyTrip("", trips, 1), null);
});

// ── The Trips page list ──────────────────────────────────────────────────────

t("jobsAwaitingTrip: jobs with a driver and no trip, earliest pickup first", () => {
  const trips = [{ id: 5, driver_id: null, status: "loading" }, { id: 6, driver_id: 1, status: "loading" }];
  const jobs = [
    job({ id: 1, job_number: "LATE", driver_ids: [1], pickup_date: "2026-10-09" }),
    job({ id: 2, job_number: "SOON", driver_ids: [2, 1], pickup_date: "2026-10-02" }),
    job({ id: 3, job_number: "NODRIVER", pickup_date: "2026-10-01" }),
    job({ id: 4, job_number: "PLACED", driver_ids: [1], trip_id: 6 }),
    job({ id: 5, job_number: "DRIVERLESS", driver_ids: [1], trip_id: 5, pickup_date: "2026-10-03" }),
    job({ id: 6, job_number: "STOCK", driver_ids: [1], status: "in_storage" }),
    job({ id: 7, job_number: "LEGACY", driver: "Ana Diaz", pickup_date: "2026-10-04" }),
  ];
  const q = jobsAwaitingTrip({ jobs, trips, drivers: DRIVERS });
  assert.deepEqual(q.map(x => x.rep.job_number), ["SOON", "DRIVERLESS", "LEGACY", "LATE"]);
  assert.deepEqual(q[0].driverIds, [2, 1]);
  assert.equal(q[0].sig, "n:soon|2,1");
  assert.deepEqual(q[2].driverIds, [3]);
  const q2 = jobsAwaitingTrip({ jobs, trips, drivers: DRIVERS, dismissed: new Set(["n:soon|2,1"]) });
  assert.deepEqual(q2.map(x => x.rep.job_number), ["DRIVERLESS", "LEGACY", "LATE"]);
  // A different driver set brings it back.
  const q3 = jobsAwaitingTrip({ jobs, trips, drivers: DRIVERS, dismissed: new Set(["n:soon|1"]) });
  assert.equal(q3[0].rep.job_number, "SOON");
});

// ── Trip ↔ job driver sync ───────────────────────────────────────────────────

t("tripDriverSync: fill, promote, follow — third drivers and loose text stay", () => {
  const units = [
    { key: "n:empty", rows: [job({ id: 1, job_number: "EMPTY" })] },
    { key: "n:second", rows: [job({ id: 2, job_number: "SECOND", driver_ids: [2, 4] })] },
    { key: "n:prev", rows: [job({ id: 3, job_number: "PREV", driver_ids: [1, 3] })] },
    { key: "n:third", rows: [job({ id: 4, job_number: "THIRD", driver_ids: [3] })] },
    { key: "n:text", rows: [job({ id: 5, job_number: "TEXT", driver: "Somebody" })] },
    { key: "n:mine", rows: [job({ id: 6, job_number: "MINE", driver_ids: [4] })] },
    { key: "n:done", rows: [job({ id: 7, job_number: "DONE", status: "delivered", date_out: "2026-09-01" })] },
  ];
  const s = tripDriverSync({ units, toDriverId: 4, fromDriverId: 1, drivers: DRIVERS });
  assert.deepEqual(s.map(x => [x.key, x.kind, x.after]), [
    ["n:empty", "fill", [4]],
    ["n:second", "promote", [4, 2]],
    ["n:prev", "follow", [4, 3]],
  ]);
  // No previous trip driver → nothing to follow.
  assert.deepEqual(tripDriverSync({ units, toDriverId: 4, fromDriverId: null, drivers: DRIVERS }).map(x => x.kind), ["fill", "promote"]);
  // Promotions only where the caller allows them (a job that just joined the trip).
  assert.deepEqual(tripDriverSync({ units, toDriverId: 4, fromDriverId: null, drivers: DRIVERS, promoteKeys: new Set() }).map(x => x.kind), ["fill"]);
  assert.deepEqual(tripDriverSync({ units, toDriverId: 4, fromDriverId: null, drivers: DRIVERS, promoteKeys: new Set(["n:second"]) }).map(x => x.kind), ["fill", "promote"]);
  assert.deepEqual(tripDriverSync({ units, toDriverId: "", fromDriverId: 1, drivers: DRIVERS }), []);
});
