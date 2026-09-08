// Unit tests for lib/verizon.mjs — the auth handshake, endpoint discovery and
// payload mapping, all against a stubbed fetch. No network, no credentials:
// this environment cannot reach fleetmatics.com, so the parts that CAN be
// checked offline are checked here.
//
//   node scripts/test-verizon.mjs
process.env.ANTHROPIC_API_KEY ||= "test-key";
process.env.VERIZON_REST_USER = "REST_test@1302790.com";
process.env.VERIZON_REST_PASSWORD = "s3cret";
process.env.VERIZON_APP_ID = "app-123";

let failures = 0;
const check = (name, cond, extra = "") => {
  if (cond) console.log(`  ok   ${name}`);
  else { failures++; console.log(`  FAIL ${name}${extra ? " — " + extra : ""}`); }
};

// ── fetch stub ───────────────────────────────────────────────────────────────
let calls = [];
let routes = {};           // path → { status, body } | (path) => ...
let tokenHits = 0;
let tokenBody = '"tok-abc"';

globalThis.fetch = async (url, opts = {}) => {
  const path = url.replace("https://fim.api.us.fleetmatics.com", "");
  calls.push({ path, headers: opts.headers || {} });
  if (path === "/token") {
    tokenHits++;
    return { ok: true, status: 200, text: async () => tokenBody };
  }
  const hit = typeof routes[path] === "function" ? routes[path](path) : routes[path];
  const { status = 404, body = "" } = hit || {};
  return { ok: status >= 200 && status < 300, status, text: async () => body };
};

const reset = (r = {}) => { calls = []; routes = r; tokenHits = 0; };

const v = await import("../lib/verizon.mjs");

// ── Auth ─────────────────────────────────────────────────────────────────────
console.log("\nAuth");
reset({ "/cmd/v1/vehicles": { status: 200, body: "[]" } });
await v.fetchVehicles();
const tokenCall = calls.find((c) => c.path === "/token");
check("token uses Basic auth over user:password",
  tokenCall.headers.Authorization === "Basic " + Buffer.from("REST_test@1302790.com:s3cret").toString("base64"),
  tokenCall.headers.Authorization);
const dataCall = calls.find((c) => c.path !== "/token");
check("data calls carry the Atmosphere app id and bearer",
  dataCall.headers.Authorization === "Atmosphere atmosphere_app_id=app-123, Bearer tok-abc",
  dataCall.headers.Authorization);

const before = tokenHits;
await v.fetchVehicles();
check("the token is reused, not re-fetched every call", tokenHits === before);

// ── Endpoint discovery ───────────────────────────────────────────────────────
console.log("\nEndpoint discovery");
// Only the second candidate is activated on this tenant.
reset({
  "/rad/v1/vehicles/T7/location": { status: 404 },
  "/rad/v1/vehicles/T7/status": { status: 200, body: JSON.stringify({ Latitude: 33.7, Longitude: -84.4, Speed: 51 }) },
});
const found = await v.fetchVehicleLocation("T7");
check("falls through a 404 to the next API product", found?.Latitude === 33.7);
check("remembers the endpoint that answered", v.resolvedPaths().location === "/rad/v1/vehicles/{vehicle}/status");

reset({ "/rad/v1/vehicles/T8/status": { status: 200, body: JSON.stringify({ Latitude: 1, Longitude: 2 }) } });
await v.fetchVehicleLocation("T8");
check("the remembered endpoint is tried first on later calls",
  calls.filter((c) => c.path !== "/token")[0].path === "/rad/v1/vehicles/T8/status");

// A vehicle literally named "v1" used to corrupt "/rad/v1/" via string replace.
reset({
  "/rad/v1/vehicles/v1/status": { status: 200, body: JSON.stringify({ Latitude: 5, Longitude: 6 }) },
});
const odd = await v.fetchVehicleLocation("v1");
check('a vehicle number of "v1" does not corrupt the path', odd?.Latitude === 5);

// A 500 is a real failure: stop, do not keep shopping for another product.
reset({ "/rad/v1/vehicles/T9/status": { status: 500, body: "boom" } });
let threw = null;
try { await v.fetchVehicleLocation("T9"); } catch (e) { threw = e; }
check("a non-404 error stops the search", threw !== null && /500/.test(threw.message));

reset({});
threw = null;
try { await v.fetchVehicleLocation("T10"); } catch (e) { threw = e; }
check("all candidates 404 → a clear error", threw !== null && /No Verizon endpoint answered/.test(threw.message));

// ── Payload mapping ──────────────────────────────────────────────────────────
console.log("\nPayload mapping");
const pascal = v.mapLocation({
  Latitude: 40.71, Longitude: -74.01, Speed: 45,
  UpdateUTC: "2026-09-08T12:00:00Z",
  Address: { AddressLine1: "5050 N 13th St", Locality: "Terre Haute", AdministrativeArea: "IN" },
});
check("reads PascalCase", pascal.last_lat === 40.71 && pascal.last_lng === -74.01);
check("joins the address", pascal.last_location === "5050 N 13th St, Terre Haute, IN");
check("speed > 0 is moving", pascal.last_status === "moving");
check("keeps Verizon's own timestamp", pascal.last_location_at === "2026-09-08T12:00:00.000Z");

check("reads camelCase too", v.mapLocation({ latitude: 1.5, longitude: -2.5 })?.last_lat === 1.5);
check("no speed is stopped", v.mapLocation({ Latitude: 1, Longitude: 2 }).last_status === "stopped");
check("a plain-string address survives", v.mapLocation({ Latitude: 1, Longitude: 2, Address: "Atlanta, GA" }).last_location === "Atlanta, GA");
check("a garbage timestamp falls back to now", !isNaN(Date.parse(v.mapLocation({ Latitude: 1, Longitude: 2, UpdateUTC: "nope" }).last_location_at)));
// Reveal repeats the city and state that AddressLine1 already carries.
const dup = v.mapLocation({
  Latitude: 41.3, Longitude: -86.3,
  Address: { AddressLine1: "11350 9A Rd, Plymouth, IN 46563, USA", Locality: "Plymouth", AdministrativeArea: "IN" },
});
check("does not repeat a city and state already in the street line",
  dup.last_location === "11350 9A Rd, Plymouth, IN 46563, USA", dup.last_location);
// "IN" lives inside "Springfield" — a substring test would wrongly drop the state.
const spring = v.mapLocation({
  Latitude: 1, Longitude: 2,
  Address: { AddressLine1: "742 Evergreen Terrace", Locality: "Springfield", AdministrativeArea: "IN" },
});
check("keeps a state whose letters hide inside the city name",
  spring.last_location === "742 Evergreen Terrace, Springfield, IN", spring.last_location);

check("no coordinates → null, never a truck at 0,0", v.mapLocation({ Speed: 10 }) === null);
check("null payload → null", v.mapLocation(null) === null);

// ── Vehicle roster ───────────────────────────────────────────────────────────
console.log("\nVehicle roster");
const roster = v.normalizeVehicles([
  { Number: "T-14", Name: "Box 26", RegistrationNumber: "ABC-1234" },
  { Number: "T-2", Name: "Box 26" },
  { Number: "T-14", Name: "duplicate" },
  { Name: "no number at all" },
  null,
]);
check("skips rows with no vehicle number and drops duplicates", roster.length === 2, JSON.stringify(roster));
check("labels with name and plate", roster.find((r) => r.number === "T-14").label === "T-14 · Box 26 · ABC-1234");
check("sorts naturally (T-2 before T-14)", roster[0].number === "T-2");
check("reads a wrapped roster", v.normalizeVehicles({ Vehicles: [{ number: "9" }] })[0]?.number === "9");
check("a label never repeats the number", v.normalizeVehicles([{ Number: "T-1", Name: "T-1" }])[0].label === "T-1");
check("garbage in → empty list, not a crash", v.normalizeVehicles(null).length === 0 && v.normalizeVehicles("nope").length === 0);

// ── GPS webhook payloads ─────────────────────────────────────────────────────
console.log("\nGPS webhook payloads");
const one = v.normalizeGpsEvents({ VehicleNumber: "BT002", Latitude: 41.3, Longitude: -86.3, Speed: 62 });
check("a single event object", one.length === 1 && one[0].number === "BT002" && one[0].loc.last_status === "moving");
check("an array of events", v.normalizeGpsEvents([
  { Number: "BT001", Latitude: 1, Longitude: 2 },
  { Number: "BT002", Latitude: 3, Longitude: 4 },
]).length === 2);
check("a vehicle nested under Vehicle", v.normalizeGpsEvents({ Vehicle: { Number: "BT009" }, Latitude: 5, Longitude: 6 })[0]?.number === "BT009");
check("a wrapped batch", v.normalizeGpsEvents({ Events: [{ Number: "BT003", Latitude: 7, Longitude: 8 }] }).length === 1);
check("drops events with no coordinates", v.normalizeGpsEvents({ Number: "BT004", Speed: 10 }).length === 0);
check("drops events naming no vehicle", v.normalizeGpsEvents({ Latitude: 1, Longitude: 2 }).length === 0);
check("garbage in → empty, not a crash",
  v.normalizeGpsEvents(null).length === 0 && v.normalizeGpsEvents("nope").length === 0 && v.normalizeGpsEvents([null, 3]).length === 0);
check("a numeric vehicle number becomes a string", v.normalizeGpsEvents({ Number: 77, Latitude: 1, Longitude: 2 })[0].number === "77");

console.log(failures ? `\n${failures} failure(s)\n` : "\nall passing\n");
process.exit(failures ? 1 : 0);
