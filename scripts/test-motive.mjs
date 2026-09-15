// Unit tests for lib/motive.mjs — auth, version discovery, pagination and
// payload mapping, all against a stubbed fetch. No network, no credentials.
//
// Motive's reference lives behind a gated portal this environment cannot reach,
// so the payloads below are the documented shapes plus the variations the code
// is written to tolerate. When a real account answers differently, `fleet=probe`
// shows the raw body and the fixture here is what gets corrected.
//
//   node scripts/test-motive.mjs
process.env.ANTHROPIC_API_KEY ||= "test-key";
process.env.MOTIVE_API_KEY = "mk-test-123";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
};

// ── fetch stub ───────────────────────────────────────────────────────────────
let calls = [];
let routes = {};           // path (with query) → { status, body } | (path) => ...

globalThis.fetch = async (url, opts = {}) => {
  const path = url.replace("https://api.gomotive.com", "");
  calls.push({ path, headers: opts.headers || {} });
  const hit = typeof routes[path] === "function" ? routes[path](path) : routes[path];
  const { status = 404, body = "" } = hit || {};
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => body,
  };
};

const reset = (r = {}) => { calls = []; routes = r; };
// Every call the module makes carries per_page/page_no, so fixtures are keyed on
// a prefix rather than on the exact query string.
const route = (map) => {
  const out = {};
  for (const [prefix, hit] of Object.entries(map)) out[prefix] = hit;
  return new Proxy(out, {
    get: (t, k) => (typeof k === "string" ? t[Object.keys(t).find((p) => k.startsWith(p)) ?? k] : t[k]),
    has: (t, k) => typeof k === "string" && Object.keys(t).some((p) => k.startsWith(p)),
  });
};

const m = await import("../lib/motive.mjs");

// ── Auth ─────────────────────────────────────────────────────────────────────
console.log("\nAuth");
reset(route({ "/v1/vehicles": { status: 200, body: '{"vehicles":[]}' } }));
await m.fetchVehicles();
check("an API key rides as X-Api-Key, not as a bearer",
  calls[0].headers["X-Api-Key"] === "mk-test-123" && !calls[0].headers.Authorization,
  JSON.stringify(calls[0].headers));
check("configured with only an API key", m.motiveConfigured() === true);

// ── Version discovery ────────────────────────────────────────────────────────
console.log("\nVersion discovery");
// Only v2 is activated on this account: v1 answers 404.
reset(route({
  "/v1/vehicle_locations": { status: 404, body: "not found" },
  "/v2/vehicle_locations": { status: 200, body: '{"vehicles":[]}' },
}));
await m.fetchVehicleLocations();
check("falls through 404 to the version that answers",
  calls.some(c => c.path.startsWith("/v1/vehicle_locations")) &&
  calls.some(c => c.path.startsWith("/v2/vehicle_locations")));
const tried = calls.length;
await m.fetchVehicleLocations();
check("the working version is remembered, not rediscovered", calls.length < tried * 2);

reset(route({ "/v1/vehicle_locations": { status: 500, body: "boom" } }));
let threw = null;
try { await m.fetchVehicleLocations(); } catch (e) { threw = e.message; }
check("a 500 stops the search instead of being read as 'wrong version'",
  threw && threw.includes("500"), threw);

reset(route({ "/v1/vehicle_locations": { status: 401, body: "bad key" } }));
threw = null;
try { await m.fetchVehicleLocations(); } catch (e) { threw = e.message; }
check("a 401 surfaces as an auth error", threw && threw.includes("401"), threw);

// ── Pagination ───────────────────────────────────────────────────────────────
console.log("\nPagination");
const page = (n) => ({ vehicles: Array.from({ length: n }, (_, i) => ({ vehicle: { id: i + 1, number: `T${i + 1}` } })) });
reset({});
routes = route({
  "/v1/vehicles": (p) => {
    const no = Number(new URLSearchParams(p.split("?")[1]).get("page_no"));
    return { status: 200, body: JSON.stringify(page(no === 1 ? 100 : 7)) };
  },
});
const paged = await m.fetchVehicles();
check("a full page is followed by the next one", paged.length === 107, String(paged.length));
check("a short page ends the walk", calls.length === 2, String(calls.length));

// ── Location mapping ─────────────────────────────────────────────────────────
console.log("\nLocation mapping");
const nested = m.mapLocation({
  id: 42, number: "BT002",
  current_location: {
    lat: 41.34, lon: -86.31, located_at: "2026-09-15T14:05:00Z",
    description: "5 mi NE of Plymouth, IN", speed: 62.4,
  },
});
check("reads lat/lon out of current_location", nested?.last_lat === 41.34 && nested?.last_lng === -86.31);
check("keeps the human description as the location", nested.last_location === "5 mi NE of Plymouth, IN");
check("road speed is moving", nested.last_status === "moving");
check("the fix keeps Motive's timestamp", nested.last_location_at === "2026-09-15T14:05:00.000Z");

check("a bare location object works too",
  m.mapLocation({ lat: 1.5, lon: -2.5 })?.last_lat === 1.5);
check("no speed is stopped", m.mapLocation({ lat: 1, lon: 2 }).last_status === "stopped");
check("city and state stand in for a missing description",
  m.mapLocation({ lat: 1, lon: 2, city: "Plymouth", state: "IN" }).last_location === "Plymouth, IN");
check("a garbage timestamp falls back to now",
  !isNaN(Date.parse(m.mapLocation({ lat: 1, lon: 2, located_at: "nope" }).last_location_at)));
check("no coordinates → null, never a truck at 0,0", m.mapLocation({ speed: 10 }) === null);
check("null payload → null", m.mapLocation(null) === null);
check("a non-numeric coordinate is not a position", m.mapLocation({ lat: "N/A", lon: 2 }) === null);

// ── Vehicle roster ───────────────────────────────────────────────────────────
console.log("\nVehicle roster");
const roster = m.normalizeVehicles({
  vehicles: [
    { vehicle: { id: 9001, number: "BT002", make: "Freightliner", model: "M2", license_plate_number: "ABC123" } },
    { vehicle: { id: 9002, number: "BT003" } },
    { vehicle: { id: 9002, number: "BT003" } },     // duplicate
    { vehicle: {} },                                 // no id at all
  ],
});
check("the human vehicle number is what gets stored", roster[0].number === "BT002");
check("make and model become the label", roster[0].label === "BT002 · Freightliner M2 · ABC123", roster[0].label);
check("duplicates and junk rows are dropped", roster.length === 2, String(roster.length));
check("an unwrapped row is read too", m.normalizeVehicles([{ id: 3, number: "T9" }])[0]?.number === "T9");
check("a vehicle with no number falls back to its id",
  m.normalizeVehicles([{ id: 777 }])[0]?.number === "777");
check("garbage in → empty list, not a crash",
  m.normalizeVehicles(null).length === 0 && m.normalizeVehicles("nope").length === 0);

// A `data` envelope must not be read once per candidate wrapper.
check("a generic data envelope yields each row once",
  m.normalizeVehicles({ data: [{ id: 1, number: "A" }, { id: 2, number: "B" }] }).length === 2);

// ── Vehicle keys ─────────────────────────────────────────────────────────────
console.log("\nVehicle keys");
check("a vehicle answers to both its id and its number",
  m.vehicleKeys({ id: 9001, number: "BT002" }).join(",") === "9001,BT002");
check("a vehicle with only an id still has a key",
  m.vehicleKeys({ id: 9001 }).join(",") === "9001");
check("nothing to key on is an empty list, not [null]",
  m.vehicleKeys({ make: "Volvo" }).length === 0);

// ── Driver roster ────────────────────────────────────────────────────────────
console.log("\nDriver roster");
const drivers = m.normalizeDrivers({
  users: [
    { user: { id: 501, first_name: "Juan", last_name: "Pérez", role: "driver" } },
    { user: { id: 502, first_name: "Ana", last_name: "Gómez", role: "driver" } },
    { user: { id: 503, first_name: "Office", last_name: "Admin", role: "admin" } },
  ],
});
check("drivers keep Motive's numeric id — hos_logs takes nothing else",
  drivers[0].number === "501" && drivers[0].name === "Juan Pérez");
check("non-drivers are left out", drivers.length === 2, String(drivers.length));
check("a driver with no name is still usable",
  m.normalizeDrivers([{ id: 7, role: "driver" }])[0]?.label === "7");
check("a row with no role is kept — not every version sends one",
  m.normalizeDrivers([{ id: 8, first_name: "Sin", last_name: "Rol" }]).length === 1);
check("garbage in → empty, not a crash", m.normalizeDrivers(null).length === 0);

// ── Duty events ──────────────────────────────────────────────────────────────
console.log("\nDuty events");
// Motive serves segments, not bare change events.
const segs = m.normalizeDutyEvents({
  hos_logs: [
    { hos_log: { driver_id: 501, type: "on_duty", start_time: "2026-09-14T12:00:00Z", end_time: "2026-09-14T13:00:00Z" } },
    { hos_log: { driver_id: 501, type: "driving", start_time: "2026-09-14T13:00:00Z", end_time: "2026-09-14T17:00:00Z" } },
  ],
});
check("each segment becomes its start", segs.length === 3, JSON.stringify(segs.map(e => e.status)));
check("a contiguous hand-off gets no synthetic event",
  segs.filter(e => e.status === "off_duty").length === 1);
check("the last segment is closed at its end_time",
  segs[2].status === "off_duty" && segs[2].at === Date.parse("2026-09-14T17:00:00Z"));

const gap = m.normalizeDutyEvents({
  hos_logs: [
    { hos_log: { driver_id: 501, type: "driving", start_time: "2026-09-14T12:00:00Z", end_time: "2026-09-14T13:00:00Z" } },
    { hos_log: { driver_id: 501, type: "driving", start_time: "2026-09-14T18:00:00Z", end_time: "2026-09-14T19:00:00Z" } },
  ],
});
check("a real gap is closed so the break is not billed as driving",
  gap.length === 4 && gap[1].status === "off_duty" && gap[1].at === Date.parse("2026-09-14T13:00:00Z"),
  JSON.stringify(gap.map(e => e.status)));

check("duration stands in for a missing end_time",
  m.normalizeDutyEvents([{ driver_id: 1, type: "driving", start_time: "2026-09-14T12:00:00Z", duration: 3600 }])
    .some(e => e.status === "off_duty" && e.at === Date.parse("2026-09-14T13:00:00Z")));
check("a nested driver object is read",
  m.normalizeDutyEvents([{ driver: { id: 88 }, type: "driving", start_time: "2026-09-14T12:00:00Z" }])[0]?.driver === "88");
check("the driver we asked about fills in when the rows omit it",
  m.normalizeDutyEvents([{ type: "driving", start_time: "2026-09-14T12:00:00Z" }], "501")[0]?.driver === "501");
check("rows with no usable time are dropped",
  m.normalizeDutyEvents([{ driver_id: 1, type: "driving", start_time: "nope" }]).length === 0);
check("garbage in → empty, not a crash",
  m.normalizeDutyEvents(null).length === 0 && m.normalizeDutyEvents("nope").length === 0);

// The hours arithmetic itself is shared with the Verizon side and covered by
// scripts/test-verizon.mjs; what matters here is that Motive's spellings reach it.
const eld = await import("../lib/eld.mjs");
const day = eld.summarizeDutyDays(m.normalizeDutyEvents({
  hos_logs: [
    { hos_log: { driver_id: 501, type: "on_duty", start_time: "2026-09-14T12:00:00Z", end_time: "2026-09-14T13:00:00Z" } },
    { hos_log: { driver_id: 501, type: "driving", start_time: "2026-09-14T13:00:00Z", end_time: "2026-09-14T17:00:00Z" } },
  ],
}), { tz: "UTC", now: Date.parse("2026-09-15T00:00:00Z") });
check("Motive's snake_case statuses reach the hours arithmetic",
  day.length === 1 && day[0].hours === 5 && day[0].drivingHours === 4,
  JSON.stringify(day));

// ── Webhook events ───────────────────────────────────────────────────────────
console.log("\nWebhook events");
const one = m.normalizeGpsEvents({ vehicle: { id: 9001, number: "BT002", current_location: { lat: 41.3, lon: -86.3, speed: 62 } } });
check("a single wrapped event", one.length === 1 && one[0].keys.includes("BT002") && one[0].loc.last_status === "moving");
check("a batch under vehicles",
  m.normalizeGpsEvents({ vehicles: [{ vehicle: { id: 1, current_location: { lat: 1, lon: 2 } } }] }).length === 1);
check("drops events with no coordinates", m.normalizeGpsEvents({ vehicle: { id: 3 } }).length === 0);
check("drops events naming no vehicle", m.normalizeGpsEvents({ lat: 1, lon: 2 }).length === 0);
check("garbage in → empty, not a crash",
  m.normalizeGpsEvents(null).length === 0 && m.normalizeGpsEvents("nope").length === 0 &&
  m.normalizeGpsEvents([null, 3]).length === 0);

// ── GPS history ──────────────────────────────────────────────────────────────
console.log("\nGPS history");
check("a wrapped history", m.normalizeHistory({ vehicle_locations: [{ lat: 1, lon: 2 }, { lat: 3, lon: 4 }] }).length === 2);
check("a flat array", m.normalizeHistory([{ lat: 1, lon: 2 }]).length === 1);
check("rows with no coordinates are dropped, not stored at 0,0",
  m.normalizeHistory([{ lat: 1, lon: 2 }, { speed: 9 }]).length === 1);
check("garbage in → empty, not a crash", m.normalizeHistory(null).length === 0);

// The history route is not documented, so the spelling of the window is
// discovered the same way the version is.
reset(route({
  "/v1/vehicle_locations?vehicle_id=9001&start_date": { status: 200, body: '{"vehicle_locations":[]}' },
  "/v1/vehicle_locations?vehicle_id=9001&start_time": { status: 200, body: '{"vehicle_locations":[{"lat":1,"lon":2}]}' },
}));
const hist = await m.fetchVehicleHistory("9001", "2026-09-01T00:00:00Z", "2026-09-08T00:00:00Z");
check("an empty answer is not mistaken for the right spelling",
  hist.length === 1 && hist[0].last_lat === 1, JSON.stringify(hist));

console.log("");
if (failures) { console.log(`✗ ${failures} check(s) failed`); process.exit(1); }
console.log("all passing");
