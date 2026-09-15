// Motive (ex KeepTruckin) REST integration — the second ELD the CRM talks to.
// Same job as lib/verizon.mjs and it writes the same columns, so a fleet split
// across both providers shows up on one map with one set of reports.
//
// Auth is one credential, not two:
//
//   MOTIVE_API_KEY
//       An API key from Motive → Admin → Settings → Developer / API Keys. Rides
//       on every call as `X-Api-Key`. This is what most fleets use.
//   MOTIVE_ACCESS_TOKEN
//       An OAuth 2.0 access token, if the account went the OAuth route instead.
//       Sent as `Authorization: Bearer`. Either credential is enough; if both
//       are set the API key wins, because it does not expire.
//
// Motive does not publish a rate limit — it answers 429 with Retry-After when it
// decides you are asking too often. The live sync is ONE call for the whole
// fleet (unlike Reveal, which is one call per vehicle), so the polling the map
// does is cheap; the 429 handling below is for the backfill, which is not.
import { admin } from "./clients.mjs";
import {
  pick, formatAddress, isoOrNow, summarizeDutyDays, sameInstant, recordPings,
} from "./eld.mjs";

const BASE = process.env.MOTIVE_API_BASE || "https://api.gomotive.com";
const API_KEY = process.env.MOTIVE_API_KEY;
const ACCESS_TOKEN = process.env.MOTIVE_ACCESS_TOKEN;

export const motiveConfigured = () => Boolean(API_KEY || ACCESS_TOKEN);

// No published floor, and one call covers the fleet. Kept in step with the
// Verizon side so the shared sync throttle has a single meaning.
export const SYNC_MIN_INTERVAL_MS = 3 * 60 * 1000;

// Motive's page size cap is 100 on the endpoints used here.
const PAGE_SIZE = 100;
// A runaway pager would burn the whole function budget in silence.
const MAX_PAGES = 50;

function authHeaders() {
  if (API_KEY) return { "X-Api-Key": API_KEY };
  return { Authorization: `Bearer ${ACCESS_TOKEN}` };
}

// An array value becomes a repeated parameter — Motive takes its id filters as
// `driver_ids[]=1&driver_ids[]=2`, which an object of unique keys cannot express.
const withQuery = (path, params = {}) => {
  const parts = [];
  for (const [k, v] of Object.entries(params)) {
    for (const one of Array.isArray(v) ? v : [v]) {
      if (one == null || one === "") continue;
      parts.push(`${k}=${encodeURIComponent(one)}`);
    }
  }
  if (!parts.length) return path;
  return path + (path.includes("?") ? "&" : "?") + parts.join("&");
};

// One request, with the 429 courtesy Motive asks for. A 429 is the only status
// retried: everything else is either data or a real error the caller must see.
async function callRaw(path, { retries = 2 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const r = await fetch(BASE + path, {
      headers: { ...authHeaders(), Accept: "application/json" },
    });
    if (r.status === 429 && attempt < retries) {
      // Retry-After is in seconds. Cap the wait: a lambda that sleeps for the
      // minute Motive asked for has nothing left to do the work with.
      const after = Number(r.headers.get("retry-after"));
      await new Promise((ok) => setTimeout(ok, Math.min(Number.isFinite(after) ? after * 1000 : 2000, 5000)));
      continue;
    }
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { ok: r.ok, status: r.status, data, text };
  }
}

// ── Endpoint discovery ───────────────────────────────────────────────────────
// Motive ships v1, v2 and v3 of the location endpoints — v3 is for vehicles on
// the Motive Vehicle Gateway, v1/v2 for everything else — and an account only
// answers on the ones its hardware and plan cover. Asking the operator which
// generation their dashcams are is a good way to get it wrong, so try the known
// shapes and remember whichever answers, exactly as the Verizon side does.

// 403/404 means "not this version"; anything else is a real failure.
const notThisVersion = (status) => status === 403 || status === 404;

async function discover(builders, arg, rememberedIdx, remember) {
  const all = builders.map((_, i) => i);
  const order = rememberedIdx == null ? all : [rememberedIdx, ...all.filter((i) => i !== rememberedIdx)];
  let lastErr = null;
  for (const i of order) {
    const path = builders[i](arg);
    const r = await callRaw(path);
    if (r.ok) { remember(i); return r.data; }
    if (!notThisVersion(r.status)) throw new Error(`Motive ${path} → ${r.status} ${String(r.text).slice(0, 200)}`);
    lastErr = `${path} → ${r.status}`;
  }
  remember(null);
  throw new Error(`No Motive endpoint answered (last: ${lastErr}). Check that the API key's scopes cover this data in Motive → Admin → API Keys.`);
}

// Walks Motive's pagination and concatenates the rows. `rowsOf` pulls the list
// out of one page, because the wrapper key differs per endpoint.
async function discoverPaged(builders, arg, rememberedIdx, remember, extract) {
  const out = [];
  let idx = rememberedIdx;
  for (let page = 1; page <= MAX_PAGES; page++) {
    const withPage = builders.map((b) => (a) => withQuery(b(a), { per_page: PAGE_SIZE, page_no: page }));
    const data = await discover(withPage, arg, idx, (i) => { idx = i; remember(i); });
    const rows = extract(data);
    out.push(...rows);
    // Trust the row count over the reported total: `total` is sometimes the
    // count of pages and sometimes of rows, and a wrong guess either stops
    // early or loops to the cap.
    if (rows.length < PAGE_SIZE) break;
  }
  return out;
}

const LOCATIONS_PATHS = [
  () => "/v1/vehicle_locations",
  () => "/v2/vehicle_locations",
  () => "/v3/vehicle_locations",
];
const VEHICLES_PATHS = [() => "/v1/vehicles", () => "/v2/vehicles"];
// Drivers are users with the driver role. Some accounts answer on /v1/drivers.
const DRIVERS_PATHS = [
  () => "/v1/users?role=driver",
  () => "/v1/users",
  () => "/v1/drivers",
];
const HOS_PATHS = [
  (p) => withQuery("/v1/hos_logs", p),
  (p) => withQuery("/v2/hos_logs", p),
  (p) => withQuery("/v1/logs", p),
];
// History is not part of the documented location endpoints, so every shape here
// is a candidate. `fleet=probe` on a real account settles which one exists.
// Each builder takes { id, params }: two of the three carry the vehicle in the
// query, the middle one in the path.
const HISTORY_PATHS = [
  (a) => withQuery("/v1/vehicle_locations", { vehicle_id: a.id, ...a.params }),
  (a) => withQuery(`/v1/vehicles/${encodeURIComponent(a.id)}/locations`, a.params),
  (a) => withQuery("/v1/vehicle_location_history", { vehicle_id: a.id, ...a.params }),
];

let locationsIdx = null;
let vehiclesIdx = null;
let driversIdx = null;
let hosIdx = null;
let historyIdx = null;

// ── Payload mapping ──────────────────────────────────────────────────────────
// Motive is snake_case and nests the interesting part: a row from
// /v1/vehicle_locations is { vehicle: { …, current_location: { lat, lon, … } } }.
// Both wrappers are optional across versions, so unwrap defensively rather than
// indexing straight into them.

// { vehicle: {...} } → {...}. Motive wraps each row in a singular key named
// after the collection; v3 sometimes does not.
export const unwrap = (row, key) => {
  if (!row || typeof row !== "object") return null;
  const inner = row[key];
  return inner && typeof inner === "object" && !Array.isArray(inner) ? inner : row;
};

// Rows out of a Motive collection response, whichever way it is wrapped.
// `pairs` are [plural, singular] candidates: an endpoint that answers `users` on
// one version answers `drivers` on another. The FIRST wrapper that matches wins
// — reading every candidate and concatenating would return the same rows twice
// whenever the payload is a bare array or a generic `data` envelope.
const rowsOf = (raw, ...pairs) => {
  const singulars = pairs.map(([, s]) => s);
  const unwrapAny = (r) => {
    for (const s of singulars) {
      const inner = unwrap(r, s);
      if (inner !== r) return inner;
    }
    return r;
  };
  const list = Array.isArray(raw) ? raw
    : pairs.map(([p]) => raw?.[p]).find(Array.isArray)
    ?? (Array.isArray(raw?.data) ? raw.data : []);
  return list.map(unwrapAny).filter((r) => r && typeof r === "object");
};

// Raw Motive vehicle (or a bare location) → the trucks columns the map reads.
export function mapLocation(raw) {
  if (!raw || typeof raw !== "object") return null;
  // The coordinates live under current_location on the vehicle row, but the
  // per-vehicle and history endpoints hand back the location on its own.
  const loc = (raw.current_location && typeof raw.current_location === "object" ? raw.current_location : null)
    || (raw.location && typeof raw.location === "object" ? raw.location : null)
    || raw;
  // Number(null) is 0, so an absent coordinate would otherwise park the truck at
  // 0,0 in the Gulf of Guinea. Missing means missing.
  const latRaw = pick(loc, "lat", "latitude", "Lat", "Latitude");
  const lngRaw = pick(loc, "lon", "lng", "longitude", "Lon", "Longitude");
  if (latRaw == null || lngRaw == null) return null;
  const lat = Number(latRaw), lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const speed = Number(pick(loc, "speed", "Speed", "speed_mph", "speed_kph")) || 0;
  // `description` is already a sentence ("5 mi NE of Plymouth, IN"); city/state
  // are the fallback for the versions that send the parts instead.
  const address = pick(loc, "description", "address", "formatted_address")
    ?? formatAddress({ city: pick(loc, "city"), state: pick(loc, "state") });
  return {
    last_lat: lat,
    last_lng: lng,
    last_location: address,
    last_location_at: isoOrNow(pick(loc, "located_at", "locatedAt", "recorded_at", "timestamp", "time")),
    // The map only distinguishes moving from stopped; any road speed is moving.
    last_status: speed > 0 ? "moving" : "stopped",
  };
}

// Every id a Motive vehicle answers to. The CRM stores whichever one the
// operator picked or pasted, so the sync matches on all of them instead of
// insisting on the internal numeric id.
export const vehicleKeys = (v) => [
  pick(v, "id", "vehicle_id"),
  pick(v, "number", "vehicle_number", "name"),
].filter((x) => x != null).map(String);

// Roster → [{ number, name, plate, label }], the same shape the truck picker
// already renders for Verizon. `number` is what lands in trucks.motive_vehicle_id:
// Motive's human vehicle number when it has one, so the field stays readable.
export function normalizeVehicles(raw) {
  const rows = rowsOf(raw, ["vehicles", "vehicle"]);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    const id = pick(row, "id", "vehicle_id");
    const number = pick(row, "number", "vehicle_number", "name");
    const key = String(number ?? id ?? "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const make = pick(row, "make"), model = pick(row, "model");
    const name = [make, model].filter(Boolean).join(" ") || null;
    const plate = pick(row, "license_plate_number", "license_plate", "licensePlateNumber");
    const extras = [name, plate].filter((x) => x && String(x) !== key).map(String);
    out.push({
      number: key,
      name: name && name !== key ? name : null,
      plate: plate ? String(plate) : null,
      label: [key, ...extras].join(" · "),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// Driver roster. Unlike vehicles this keeps Motive's numeric id as the stored
// value: /v1/hos_logs filters on driver_ids and takes nothing else.
export function normalizeDrivers(raw) {
  const rows = rowsOf(raw, ["users", "user"], ["drivers", "driver"]);
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    // /v1/users answers for the whole company; only drivers have a logbook.
    const role = String(pick(row, "role", "user_role") ?? "").toLowerCase();
    if (role && !role.includes("driver")) continue;
    const id = pick(row, "id", "driver_id", "user_id");
    if (id == null) continue;
    const key = String(id);
    if (seen.has(key)) continue;
    seen.add(key);
    const first = pick(row, "first_name", "firstName");
    const last = pick(row, "last_name", "lastName");
    const full = pick(row, "name", "full_name", "username")
      ?? ([first, last].filter(Boolean).join(" ") || null);
    const name = full && String(full).trim() && String(full) !== key ? String(full).trim() : null;
    out.push({ number: key, name, label: name ? `${key} · ${name}` : key });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// ── Fetching ─────────────────────────────────────────────────────────────────

// Every vehicle and its current position, in one call for the whole fleet.
export const fetchVehicleLocations = () =>
  discoverPaged(LOCATIONS_PATHS, null, locationsIdx, (i) => { locationsIdx = i; },
    (d) => rowsOf(d, ["vehicles", "vehicle"]));

// One vehicle's position, for fleet=probe. Motive filters the fleet call rather
// than exposing a per-vehicle route on every version.
export async function fetchVehicleLocation(vehicleId) {
  const builders = LOCATIONS_PATHS.map((b) => (v) => withQuery(b(), { vehicle_id: v }));
  const raw = await discover(builders, vehicleId, locationsIdx, (i) => { locationsIdx = i; });
  const rows = rowsOf(raw, ["vehicles", "vehicle"]);
  // A filter Motive ignored would hand back the whole fleet; find the asked-for
  // vehicle rather than trusting that the first row is it.
  return rows.find((r) => vehicleKeys(r).includes(String(vehicleId))) ?? rows[0] ?? null;
}

export const fetchVehicles = () =>
  discoverPaged(VEHICLES_PATHS, null, vehiclesIdx, (i) => { vehiclesIdx = i; },
    (d) => rowsOf(d, ["vehicles", "vehicle"]));

export const fetchDriverRoster = () =>
  discoverPaged(DRIVERS_PATHS, null, driversIdx, (i) => { driversIdx = i; },
    (d) => rowsOf(d, ["users", "user"], ["drivers", "driver"]));

// Which endpoints this lambda settled on — surfaced by fleet=probe for debugging.
export const resolvedPaths = () => ({
  locations: locationsIdx == null ? null : LOCATIONS_PATHS[locationsIdx](),
  vehicles: vehiclesIdx == null ? null : VEHICLES_PATHS[vehiclesIdx](),
  drivers: driversIdx == null ? null : DRIVERS_PATHS[driversIdx](),
});

// ── Hours of Service ─────────────────────────────────────────────────────────
// Motive serves the logbook as duty segments — start_time, end_time, type —
// rather than as bare change events. summarizeDutyDays walks events, so each
// segment becomes its start; where a segment ends with a gap before the next one
// begins, a synthetic OFF closes it so the gap is not billed as on-duty time.

export function normalizeDutyEvents(raw, defaultDriver = null) {
  const rows = rowsOf(raw, ["hos_logs", "hos_log"], ["logs", "log"]);
  const byDriver = new Map();
  for (const row of rows) {
    const driverRaw = pick(row, "driver_id", "driverId")
      ?? pick(row.driver || row.user || {}, "id", "driver_id")
      ?? defaultDriver;
    const status = pick(row, "type", "duty_status", "dutyStatus", "status", "event_type");
    const start = pick(row, "start_time", "startTime", "start_at", "time", "logged_at");
    if (driverRaw == null || status == null || start == null) continue;
    const at = new Date(start).getTime();
    if (isNaN(at)) continue;
    const driver = String(typeof driverRaw === "object" ? (driverRaw.id ?? "") : driverRaw);
    if (!driver) continue;
    const endRaw = pick(row, "end_time", "endTime", "end_at");
    let end = endRaw == null ? null : new Date(endRaw).getTime();
    if (end == null) {
      // No end_time on this version: derive it from the duration, which Motive
      // reports in seconds.
      const dur = Number(pick(row, "duration", "duration_sec", "seconds"));
      if (Number.isFinite(dur) && dur > 0) end = at + dur * 1000;
    }
    if (end != null && (isNaN(end) || end <= at)) end = null;
    if (!byDriver.has(driver)) byDriver.set(driver, []);
    byDriver.get(driver).push({ driver, status, at, end });
  }

  const out = [];
  for (const list of byDriver.values()) {
    list.sort((a, b) => a.at - b.at);
    for (let i = 0; i < list.length; i++) {
      const seg = list[i];
      out.push({ driver: seg.driver, status: seg.status, at: seg.at });
      const next = list[i + 1]?.at;
      // Only close a real gap. Where the next segment starts exactly where this
      // one ended, the stream is already contiguous and a synthetic event would
      // be noise; where it starts earlier, the segments overlap and the next one
      // wins on its own.
      if (seg.end != null && (next == null || next > seg.end)) {
        out.push({ driver: seg.driver, status: "off_duty", at: seg.end });
      }
    }
  }
  return out;
}

// Past this many ids the filter is longer than the URL Motive will accept, so
// the whole company comes back and the caller drops what is not its own. The
// filter is still worth sending for a normal fleet: it is far less data.
const MAX_ID_FILTER = 25;

export function fetchHosLogs({ from, to, driverIds = [] } = {}) {
  const params = {
    start_date: from, end_date: to,
    ...(driverIds.length && driverIds.length <= MAX_ID_FILTER ? { "driver_ids[]": driverIds } : {}),
  };
  return discoverPaged(HOS_PATHS, params, hosIdx, (i) => { hosIdx = i; },
    (d) => rowsOf(d, ["hos_logs", "hos_log"], ["logs", "log"]));
}

// Pulls the logbook and writes one row per driver per day into driver_hos_days.
// Never touches driver_work_days: that is the payroll the office keys in, and
// these numbers exist precisely to be compared against it.
export async function syncDriverHours({ from, to } = {}) {
  if (!motiveConfigured()) throw new Error("Motive credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");

  const { data: drivers, error } = await admin.from("drivers").select("*");
  if (error) throw new Error(`drivers read failed: ${error.message}`);
  const linked = (drivers || []).filter((d) => !d.deleted_at && d.motive_driver_id);
  const result = { provider: "motive", linked: linked.length, days: 0, drivers: 0, errors: [], from, to };
  if (!linked.length) return result;

  // The stored value should be Motive's numeric driver id, but an operator can
  // paste a driver number or a name. Resolve anything that is not already an id
  // against the roster instead of quietly reading nobody's hours.
  const byKey = new Map();
  try {
    for (const d of normalizeDrivers(await fetchDriverRoster())) {
      byKey.set(d.number, d.number);
      if (d.name) byKey.set(d.name.toLowerCase(), d.number);
    }
  } catch (e) {
    // A roster Motive will not serve is not fatal: the stored ids may be right
    // already. Say so, and carry on with them as given.
    result.errors.push({ driver: "roster", error: e?.message || String(e) });
  }

  const toDriverId = new Map();   // Motive driver id → CRM driver id
  for (const d of linked) {
    const raw = String(d.motive_driver_id);
    const resolved = byKey.get(raw) ?? byKey.get(raw.toLowerCase()) ?? raw;
    toDriverId.set(String(resolved), d.id);
  }

  // One call for the whole company, then split per driver — the opposite of the
  // Verizon side, where the logbook is only served one driver at a time.
  let events;
  try {
    events = normalizeDutyEvents(await fetchHosLogs({ from, to, driverIds: [...toDriverId.keys()] }));
  } catch (e) {
    result.errors.push({ driver: "hos_logs", error: e?.message || String(e) });
    return result;
  }

  const mine = events.filter((e) => toDriverId.has(e.driver));
  const payload = [];
  const seenDrivers = new Set();
  for (const r of summarizeDutyDays(mine)) {
    seenDrivers.add(r.driver);
    payload.push({
      driver_id: toDriverId.get(r.driver), work_date: r.date,
      hours: r.hours, driving_hours: r.drivingHours,
      clock_in: r.clockIn, clock_out: r.clockOut,
      synced_at: new Date().toISOString(),
    });
  }
  result.drivers = seenDrivers.size;

  if (payload.length) {
    const { error: upErr } = await admin.from("driver_hos_days").upsert(payload, { onConflict: "driver_id,work_date" });
    if (upErr) throw new Error(`driver_hos_days upsert failed: ${upErr.message}`);
    result.days = payload.length;
  }
  return result;
}

// ── Sync ─────────────────────────────────────────────────────────────────────

// Index of trucks by every Motive id they could be linked through.
async function linkedTrucks() {
  // select("*") on purpose: trucks predates the soft-delete convention and may
  // not have deleted_at, which would make a column-level filter throw.
  const { data, error } = await admin.from("trucks").select("*");
  if (error) throw new Error(`trucks read failed: ${error.message}`);
  const rows = (data || []).filter((t) => !t.deleted_at && t.motive_vehicle_id);
  const byKey = new Map();
  for (const t of rows) byKey.set(String(t.motive_vehicle_id), t);
  return { rows, byKey };
}

// Pulls every mapped truck's current position in a single fleet-wide call and
// writes it onto the trucks row the live-load map already renders.
export async function syncTruckLocations() {
  if (!motiveConfigured()) throw new Error("Motive credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");

  const { rows, byKey } = await linkedTrucks();
  const result = { provider: "motive", checked: rows.length, updated: 0, skipped: 0, errors: [] };
  if (!rows.length) return result;

  const vehicles = await fetchVehicleLocations();
  const fresh = [];
  const matched = new Set();

  for (const v of vehicles) {
    const truck = vehicleKeys(v).map((k) => byKey.get(k)).find(Boolean);
    if (!truck || matched.has(truck.id)) continue;
    matched.add(truck.id);
    const loc = mapLocation(v);
    if (!loc) { result.skipped++; continue; }
    const { error } = await admin.from("trucks").update(loc).eq("id", truck.id);
    if (error) { result.errors.push({ truck: truck.name || truck.id, error: error.message }); continue; }
    result.updated++;
    if (!sameInstant(truck.last_location_at, loc.last_location_at)) {
      fresh.push({ truck_id: truck.id, lat: loc.last_lat, lng: loc.last_lng, status: loc.last_status, at: loc.last_location_at });
    }
  }

  // A truck linked to a vehicle the fleet call never mentioned is not an error
  // the map can act on, but it is exactly the silent failure the Verizon side
  // learned to name: a VIN pasted where the vehicle number goes looks identical
  // to a broken API from the outside.
  for (const t of rows) {
    if (!matched.has(t.id)) {
      result.errors.push({ truck: t.name || t.id, error: `Motive does not list a vehicle ${t.motive_vehicle_id}` });
    }
  }

  const rec = await recordPings(fresh);
  result.pings = rec.written;
  if (rec.error) result.pingsError = rec.error;
  return result;
}

// ── GPS history (backfill) ───────────────────────────────────────────────────

// Only the spelling of the window differs between the candidates; the vehicle is
// placed by the path builder above.
const HISTORY_QUERIES = [
  (f, t) => ({ start_date: f, end_date: t }),
  (f, t) => ({ start_time: f, end_time: t }),
  (f, t) => ({ from: f, to: t }),
];
let historyQueryIdx = null;

export function normalizeHistory(raw) {
  const rows = rowsOf(raw, ["vehicle_locations", "vehicle_location"], ["locations", "location"], ["vehicles", "vehicle"]);
  const out = [];
  for (const row of rows) {
    const loc = mapLocation(row);
    if (loc) out.push(loc);
  }
  return out;
}

// Tries each query spelling against the discovered route until one answers with
// something that parses into positions.
export async function fetchVehicleHistory(vehicleId, fromISO, toISO) {
  const order = historyQueryIdx == null
    ? HISTORY_QUERIES.map((_, i) => i)
    : [historyQueryIdx, ...HISTORY_QUERIES.map((_, i) => i).filter((i) => i !== historyQueryIdx)];
  let lastErr = null;
  for (const qi of order) {
    const params = HISTORY_QUERIES[qi](fromISO, toISO);
    try {
      const raw = await discover(HISTORY_PATHS, { id: vehicleId, params },
        historyIdx, (i) => { historyIdx = i; });
      const rows = normalizeHistory(raw);
      // An empty answer is not proof the spelling is wrong — but a spelling that
      // never returns anything for any vehicle is, so only lock in on real data.
      if (rows.length) { historyQueryIdx = qi; return rows; }
      lastErr = "empty";
    } catch (e) {
      lastErr = e?.message || String(e);
    }
  }
  if (lastErr && lastErr !== "empty") throw new Error(lastErr);
  return [];
}

// Pulls each linked truck's recent history into truck_pings. Safe to re-run:
// truck_pings is keyed on (truck_id, at), so overlapping windows collapse.
export async function backfillHistory({ days = 30, truckId = null } = {}) {
  if (!motiveConfigured()) throw new Error("Motive credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");
  const { rows } = await linkedTrucks();
  // Called per truck so one request never has to outlive the function timeout.
  const mapped = truckId == null ? rows : rows.filter((t) => t.id === truckId);
  const result = { provider: "motive", trucks: mapped.length, positions: 0, days, errors: [], names: mapped.map((t) => t.name) };

  // A month in one ask times out on a busy truck, so walk it in weeks: smaller
  // requests, and one bad week no longer costs the other three.
  const CHUNK_DAYS = 7;
  for (const truck of mapped) {
    for (let start = days; start > 0; start -= CHUNK_DAYS) {
      const cFrom = new Date(Date.now() - start * 864e5).toISOString();
      const cTo = new Date(Date.now() - Math.max(0, start - CHUNK_DAYS) * 864e5).toISOString();
      try {
        const positions = await fetchVehicleHistory(truck.motive_vehicle_id, cFrom, cTo);
        const pings = positions.map((r) => ({
          truck_id: truck.id, lat: r.last_lat, lng: r.last_lng,
          status: r.last_status, at: r.last_location_at,
        }));
        const rec = await recordPings(pings);
        result.positions += rec.written;
        if (rec.error) {
          // The table is the problem, not this truck: stop instead of repeating
          // the same failure eight times over.
          result.errors.push({ truck: truck.name || truck.id, error: `could not store: ${rec.error}` });
          return result;
        }
      } catch (e) {
        result.errors.push({
          truck: truck.name || truck.id,
          error: `${cFrom.slice(0, 10)}..${cTo.slice(0, 10)}: ${e?.message || String(e)}`,
        });
      }
    }
  }
  return result;
}

// ── Webhooks ─────────────────────────────────────────────────────────────────
// Motive can push a position instead of the CRM asking every five minutes. The
// payload shape sits behind the gated developer portal, so read whatever is
// there and let the endpoint log anything unrecognised rather than guessing a
// schema and dropping real events.

export function normalizeGpsEvents(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.vehicles) ? raw.vehicles
    : Array.isArray(raw?.events) ? raw.events
    : Array.isArray(raw?.data) ? raw.data
    : raw && typeof raw === "object" ? [raw] : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // A webhook body wraps the vehicle the same way the REST rows do, and some
    // event types nest it one deeper under the action payload.
    const v = unwrap(unwrap(row, "vehicle"), "vehicle");
    const keys = vehicleKeys(v);
    const loc = mapLocation(v);
    if (!keys.length || !loc) continue;
    out.push({ keys, loc });
  }
  return out;
}

// Writes a webhook delivery onto the trucks it names. Returns counts so the
// endpoint can log a delivery that matched nothing.
export async function applyGpsEvents(raw) {
  if (!admin) throw new Error("Supabase service role is not configured");
  const events = normalizeGpsEvents(raw);
  const result = { provider: "motive", events: events.length, applied: 0, unmatched: 0 };
  if (!events.length) return result;

  const { byKey } = await linkedTrucks();

  // One write per truck, keeping the newest fix: a batch can carry several
  // events for the same truck and the last one written must not be the oldest.
  const latest = new Map();
  for (const e of events) {
    const truck = e.keys.map((k) => byKey.get(k)).find(Boolean);
    if (!truck) { result.unmatched++; continue; }
    const prev = latest.get(truck.id);
    if (!prev || e.loc.last_location_at >= prev.loc.last_location_at) latest.set(truck.id, { truck, loc: e.loc });
  }

  const fresh = [];
  for (const [id, { loc }] of latest) {
    const { error } = await admin.from("trucks").update(loc).eq("id", id);
    if (error) throw new Error(`trucks update failed: ${error.message}`);
    result.applied++;
    fresh.push({ truck_id: id, lat: loc.last_lat, lng: loc.last_lng, status: loc.last_status, at: loc.last_location_at });
  }
  const rec = await recordPings(fresh);
  result.pings = rec.written;
  if (rec.error) result.pingsError = rec.error;
  return result;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Which Motive data this API key can actually reach. The portal knows, but
// reading it means a person clicking through a gated site; the server holds the
// credential and can reach Motive, so it asks directly instead.

export async function diagnose() {
  const checks = [];
  if (!motiveConfigured()) {
    return [{ key: "config", ok: false, detail: "MOTIVE_API_KEY (or MOTIVE_ACCESS_TOKEN) is not set" }];
  }

  // The vehicle roster doubles as the auth check: it is the cheapest call that
  // needs a working credential.
  try {
    const vehicles = normalizeVehicles(await fetchVehicles());
    checks.push({ key: "auth", ok: true });
    checks.push({ key: "vehicles", ok: true, path: resolvedPaths().vehicles, count: vehicles.length });
  } catch (e) {
    const detail = e?.message || String(e);
    checks.push({ key: "auth", ok: !/401|403/.test(detail), detail });
    if (/401|403/.test(detail)) return checks;   // nothing else can pass
    checks.push({ key: "vehicles", ok: false, detail });
  }

  try {
    const rows = await fetchVehicleLocations();
    const withFix = rows.filter((r) => mapLocation(r)).length;
    checks.push({
      key: "location", ok: withFix > 0, path: resolvedPaths().locations, count: withFix,
      // A product that answers but whose fields we cannot read is its own problem.
      detail: rows.length && !withFix
        ? "responded, but no coordinates could be read from the payload"
        : undefined,
    });
  } catch (e) {
    checks.push({ key: "location", ok: false, detail: e?.message || String(e) });
  }

  try {
    const drivers = normalizeDrivers(await fetchDriverRoster());
    checks.push({ key: "drivers", ok: drivers.length > 0, path: resolvedPaths().drivers, count: drivers.length });
  } catch (e) {
    checks.push({ key: "drivers", ok: false, detail: e?.message || String(e) });
  }

  // The logbook check needs a driver that is actually linked.
  const { data: drvRows } = await admin.from("drivers").select("*");
  const linked = (drvRows || []).find((d) => !d.deleted_at && d.motive_driver_id);
  if (!linked) {
    checks.push({
      key: "logbook", ok: false,
      detail: "no driver has a Motive driver id yet, so there is nobody to ask about",
    });
    return checks;
  }
  try {
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
    const events = normalizeDutyEvents(await fetchHosLogs({ from, to, driverIds: [String(linked.motive_driver_id)] }));
    checks.push({
      key: "logbook", ok: true, count: events.length,
      detail: events.length === 0
        ? `responded for ${linked.name || linked.motive_driver_id}, but no duty events came back`
        : undefined,
    });
  } catch (e) {
    checks.push({ key: "logbook", ok: false, detail: e?.message || String(e) });
  }

  return checks;
}
