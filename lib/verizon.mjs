// Verizon Connect Reveal (Fleetmatics) REST integration — feeds the live-load map.
//
// Reveal's auth is two-legged and needs BOTH credential sets on every data call;
// either one alone is always rejected:
//
//   VERIZON_REST_USER / VERIZON_REST_PASSWORD
//       The Reveal integration user Verizon issues by email after the request in
//       Reveal → Marketplace → API Integrations. Basic-auth'd against /token,
//       which hands back a bearer token valid ~20 minutes.
//   VERIZON_APP_ID
//       The app we registered ourselves on the developer portal
//       (fim.us.fleetmatics.com → Apps). Rides on every data call.
//
// Verizon asks integrators not to poll a vehicle's location more often than every
// 3–5 minutes, which is why the map polls on a timer instead of on every render.
import { admin } from "./clients.mjs";

const BASE = process.env.VERIZON_API_BASE || "https://fim.api.us.fleetmatics.com";
const USER = process.env.VERIZON_REST_USER;
const PASS = process.env.VERIZON_REST_PASSWORD;
const APP_ID = process.env.VERIZON_APP_ID;

export const verizonConfigured = () => Boolean(USER && PASS && APP_ID);

// Verizon's stated polling floor. The client honours it; the server enforces it.
export const SYNC_MIN_INTERVAL_MS = 3 * 60 * 1000;

// Tokens last ~20 minutes. Refresh at 15 so no call ever races the expiry.
const TOKEN_TTL_MS = 15 * 60 * 1000;
let cachedToken = null;
let cachedUntil = 0;

async function getToken(force = false) {
  if (!force && cachedToken && Date.now() < cachedUntil) return cachedToken;
  const basic = Buffer.from(`${USER}:${PASS}`).toString("base64");
  const r = await fetch(`${BASE}/token`, {
    headers: { Authorization: `Basic ${basic}`, Accept: "application/json" },
  });
  const body = (await r.text()).trim();
  if (!r.ok) throw new Error(`Verizon /token → ${r.status} ${body.slice(0, 200)}`);
  // The endpoint answers with the bare token, sometimes quoted, sometimes wrapped
  // in JSON depending on the tenant — accept all three rather than assume one.
  let token = body.replace(/^"|"$/g, "");
  if (body.startsWith("{")) {
    try {
      const j = JSON.parse(body);
      token = j.access_token || j.token || j.Token || token;
    } catch { /* not JSON after all; the quoted form above already applies */ }
  }
  if (!token) throw new Error("Verizon /token returned an empty token");
  cachedToken = token;
  cachedUntil = Date.now() + TOKEN_TTL_MS;
  return token;
}

async function callRaw(path) {
  // A warm lambda can hold a token that expired between calls, so a 401 buys one
  // forced refresh before the request is treated as a real failure.
  for (const forced of [false, true]) {
    const token = await getToken(forced);
    const r = await fetch(BASE + path, {
      headers: {
        Authorization: `Atmosphere atmosphere_app_id=${APP_ID}, Bearer ${token}`,
        Accept: "application/json",
      },
    });
    if (r.status === 401 && !forced) continue;
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    return { ok: r.ok, status: r.status, data, text };
  }
}

async function call(path) {
  const r = await callRaw(path);
  if (!r.ok) throw new Error(`Verizon ${path} → ${r.status} ${String(r.text).slice(0, 200)}`);
  return r.data;
}

// ── Payload mapping ──────────────────────────────────────────────────────────
// Reveal returns PascalCase, but key names differ between API versions and
// tenants. Read the first key actually present instead of betting on one, and
// use ?fleet=probe to see a real payload before tightening any of this.

const pick = (obj, ...keys) => {
  for (const k of keys) {
    const v = obj == null ? null : obj[k];
    if (v != null && v !== "") return v;
  }
  return null;
};

const escapeRe = (x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const alreadyMentions = (haystack, part) =>
  new RegExp(`(^|[^a-z0-9])${escapeRe(part)}([^a-z0-9]|$)`, "i").test(haystack);

function formatAddress(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  const parts = [
    pick(a, "AddressLine1", "addressLine1", "Line1", "StreetAddress"),
    pick(a, "Locality", "locality", "City", "city"),
    pick(a, "AdministrativeArea", "administrativeArea", "State", "state"),
  ].filter(Boolean).map(String);
  // Reveal often puts the whole address in AddressLine1, so blindly appending
  // the city and state gives "…Plymouth, IN 46563, USA, Plymouth, IN". Match on
  // whole words: a plain substring test would find the state "IN" inside
  // "Springfield" and drop it.
  const out = [];
  for (const part of parts) {
    if (!alreadyMentions(out.join(", "), part)) out.push(part);
  }
  return out.length ? out.join(", ") : null;
}

function isoOrNow(v) {
  if (!v) return new Date().toISOString();
  const d = new Date(v);
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// Raw Reveal location → the trucks columns the map already reads.
export function mapLocation(raw) {
  if (!raw) return null;
  // Number(null) is 0, so an absent coordinate would otherwise park the truck at
  // 0,0 in the Gulf of Guinea. Missing means missing.
  const latRaw = pick(raw, "Latitude", "latitude", "Lat", "lat");
  const lngRaw = pick(raw, "Longitude", "longitude", "Lon", "lon", "Lng", "lng");
  if (latRaw == null || lngRaw == null) return null;
  const lat = Number(latRaw), lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  const speed = Number(pick(raw, "Speed", "speed", "SpeedKilometresPerHour", "SpeedMilesPerHour")) || 0;
  return {
    last_lat: lat,
    last_lng: lng,
    last_location: formatAddress(pick(raw, "Address", "address")),
    last_location_at: isoOrNow(pick(raw, "UpdateUTC", "updateUTC", "UpdateUtc", "Timestamp", "timestamp", "DateTimeUTC")),
    // The map only distinguishes moving from stopped; any road speed is moving.
    last_status: speed > 0 ? "moving" : "stopped",
  };
}

// ── Reveal endpoints ─────────────────────────────────────────────────────────

// Reveal spreads vehicle data across separate API products, and which ones a
// tenant has activated differs per account — asking the operator to work that out
// from the developer portal is a good way to get it wrong. Try the known shapes
// instead and remember whichever one actually answers.
const LOCATION_PATHS = [
  (v) => `/rad/v1/vehicles/${v}/location`,
  (v) => `/rad/v1/vehicles/${v}/status`,
  (v) => `/cmd/v1/vehicles/${v}/location`,
];
const VEHICLES_PATHS = [() => "/cmd/v1/vehicles", () => "/rad/v1/vehicles"];

// Remembered as an index per lambda, not as a path string: a vehicle number like
// "v1" would otherwise collide with the "/rad/v1/" in the template.
let locationIdx = null;
let vehiclesIdx = null;

// 401 is an auth problem worth surfacing; 403/404 only means "not this product".
const notThisProduct = (status) => status === 403 || status === 404;

// Tries the remembered endpoint first, then the rest. Anything other than a
// 403/404 stops the search — that is a real error, not the wrong product.
async function discover(builders, arg, rememberedIdx, remember) {
  const all = builders.map((_, i) => i);
  const order = rememberedIdx == null ? all : [rememberedIdx, ...all.filter((i) => i !== rememberedIdx)];
  let lastErr = null;
  for (const i of order) {
    const path = builders[i](arg);
    const r = await callRaw(path);
    if (r.ok) { remember(i); return r.data; }
    if (!notThisProduct(r.status)) throw new Error(`Verizon ${path} → ${r.status} ${String(r.text).slice(0, 200)}`);
    lastErr = `${path} → ${r.status}`;
  }
  remember(null);
  throw new Error(`No Verizon endpoint answered (last: ${lastErr}). Check which APIs the app has access to in the developer portal.`);
}

export const fetchVehicleLocation = (vehicleNumber) =>
  discover(LOCATION_PATHS, encodeURIComponent(vehicleNumber), locationIdx, (i) => { locationIdx = i; });

// The vehicle roster, used to fill trucks.verizon_vehicle_id.
export const fetchVehicles = () =>
  discover(VEHICLES_PATHS, null, vehiclesIdx, (i) => { vehiclesIdx = i; });

// Roster → [{ number, label }] for the picker in the truck form, so nobody has to
// copy vehicle numbers out of Reveal by hand. Same tolerance as mapLocation():
// the roster comes back wrapped differently depending on the API product.
export function normalizeVehicles(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.Vehicles) ? raw.Vehicles
    : Array.isArray(raw?.vehicles) ? raw.vehicles
    : Array.isArray(raw?.Items) ? raw.Items
    : Array.isArray(raw?.items) ? raw.items
    : [];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const number = pick(row, "Number", "number", "VehicleNumber", "vehicleNumber", "Id", "id");
    if (number == null) continue;
    const key = String(number);
    if (seen.has(key)) continue;
    seen.add(key);
    const name = pick(row, "Name", "name", "DisplayName", "displayName", "Label", "Description");
    const plate = pick(row, "RegistrationNumber", "registrationNumber", "LicensePlate", "licensePlate", "Plate", "plate");
    // name/plate stay separate so the picker can lay them out; label is the flat
    // form used for searching and for the plain-text fallback.
    const extras = [name, plate].filter((x) => x && String(x) !== key).map(String);
    out.push({
      number: key,
      name: name && String(name) !== key ? String(name) : null,
      plate: plate ? String(plate) : null,
      label: [key, ...extras].join(" · "),
    });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// Which endpoints this lambda settled on — surfaced by fleet=probe for debugging.
export const resolvedPaths = () => ({
  location: locationIdx == null ? null : LOCATION_PATHS[locationIdx]("{vehicle}"),
  vehicles: vehiclesIdx == null ? null : VEHICLES_PATHS[vehiclesIdx](),
});

// ── Hours of Service (ELD) ───────────────────────────────────────────────────
// Reveal's logbook is a stream of duty-status changes, not a daily total: each
// event says "from this instant, the driver is DRIVING / ON / OFF / SB". Real
// hours come from walking consecutive events, which is also what turns into
// clock-in and clock-out.

// The fleet's home timezone decides where one work day ends and the next starts.
const TZ = process.env.VERIZON_TZ || "America/New_York";

const DUTY = { D: "driving", ON: "onDuty", OFF: "off", SB: "sleeper" };

// ELD statuses arrive spelled a dozen ways across exports and API versions.
export function dutyCode(raw) {
  const v = String(raw ?? "").trim().toUpperCase().replace(/[\s-]+/g, "_");
  if (!v) return null;
  if (v === "D" || v.startsWith("DRIV")) return "D";
  if (v === "SB" || v.includes("SLEEP")) return "SB";
  if (v === "OFF" || v.startsWith("OFF")) return "OFF";
  if (v === "ON" || v.startsWith("ON_DUTY") || v.startsWith("ONDUTY") || v.includes("NOT_DRIVING")) return "ON";
  return null;
}

// Minutes between the wall clock in `tz` and the real instant.
function tzOffsetMs(ms, tz) {
  const dtf = new Intl.DateTimeFormat("en-US", { timeZone: tz, hour12: false,
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const p = Object.fromEntries(dtf.formatToParts(new Date(ms)).map(x => [x.type, x.value]));
  return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - ms;
}

export const localDay = (ms, tz = TZ) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit" })
    .format(new Date(ms));

// The instant the local day containing `ms` ends. The offset is re-read at the
// estimate so the two DST days a year land on the right hour instead of an hour off.
function endOfLocalDay(ms, tz = TZ) {
  const day = localDay(ms, tz);
  const midnightWall = Date.parse(`${day}T00:00:00Z`) + 24 * 3600e3;
  let guess = midnightWall - tzOffsetMs(ms, tz);
  guess = midnightWall - tzOffsetMs(guess, tz);
  return guess;
}

// Duty events → one row per driver per local day. Segments that run past midnight
// are split, so an overnight run counts its hours on the day it actually drove
// them instead of dumping all of them on the day it started.
export function summarizeDutyDays(events, { tz = TZ, now = Date.now() } = {}) {
  const byDriver = new Map();
  for (const e of events || []) {
    if (!e || e.at == null || !e.driver) continue;
    if (!byDriver.has(e.driver)) byDriver.set(e.driver, []);
    byDriver.get(e.driver).push(e);
  }

  const rows = [];
  for (const [driver, list] of byDriver) {
    list.sort((a, b) => a.at - b.at);
    const days = new Map();
    const dayOf = (d) => {
      if (!days.has(d)) days.set(d, { driver, date: d, drivingMs: 0, onDutyMs: 0, firstOn: null, lastOff: null });
      return days.get(d);
    };

    for (let i = 0; i < list.length; i++) {
      const ev = list[i];
      const code = dutyCode(ev.status);
      if (!code) continue;
      // The last event runs to the end of its own day or to now, whichever is
      // sooner: an open shift must not bill hours that have not happened yet.
      const next = list[i + 1]?.at ?? Math.min(now, endOfLocalDay(ev.at, tz));
      if (next <= ev.at) continue;

      if (code === "D" || code === "ON") {
        const d0 = dayOf(localDay(ev.at, tz));
        if (d0.firstOn == null || ev.at < d0.firstOn) d0.firstOn = ev.at;
      } else {
        const d0 = dayOf(localDay(ev.at, tz));
        if (d0.lastOff == null || ev.at > d0.lastOff) d0.lastOff = ev.at;
      }
      if (code === "OFF" || code === "SB") continue;   // no hours to bank

      let cursor = ev.at;
      while (cursor < next) {
        const boundary = Math.min(endOfLocalDay(cursor, tz), next);
        const slice = boundary - cursor;
        const bucket = dayOf(localDay(cursor, tz));
        bucket.onDutyMs += slice;
        if (code === "D") bucket.drivingMs += slice;
        cursor = boundary;
      }
    }

    for (const d of days.values()) {
      const hrs = (ms) => Math.round((ms / 3600e3) * 100) / 100;
      rows.push({
        driver: d.driver,
        date: d.date,
        hours: hrs(d.onDutyMs),
        drivingHours: hrs(d.drivingMs),
        // Clock in / clock out as the operation reads them: first minute on duty,
        // last minute before going off.
        clockIn: d.firstOn == null ? null : new Date(d.firstOn).toISOString(),
        clockOut: d.lastOff == null ? null : new Date(d.lastOff).toISOString(),
      });
    }
  }
  return rows.filter(r => r.hours > 0 || r.clockIn).sort((a, b) => a.date.localeCompare(b.date) || String(a.driver).localeCompare(String(b.driver)));
}

// Reveal serves the logbook from its own API product, and the path differs by
// account, so the same discovery used for locations applies here.
// Reveal calls this product different things depending on the docs you read —
// Logbook, Hours of Service, Driver Activity — so cast a wide net. The status
// code is what matters: 404 means the path is wrong, 403 means the product
// exists but this app has no access to it, which is a request away.
const LOGBOOK_PATHS = [
  (q) => `/hos/v1/logs${q}`,
  (q) => `/hos/v1/driverlogs${q}`,
  (q) => `/hos/v1/driverstatus${q}`,
  (q) => `/dra/v1/driverstatus${q}`,
  (q) => `/dra/v1/driveractivity${q}`,
  (q) => `/rad/v1/drivers/logs${q}`,
  (q) => `/rad/v1/driveractivity${q}`,
  (q) => `/drv/v1/logs${q}`,
];
let logbookIdx = null;

// `from`/`to` are ISO dates (YYYY-MM-DD).
export function fetchDutyEvents(from, to) {
  const p = new URLSearchParams();
  if (from) p.set("startDate", from);
  if (to) p.set("endDate", to);
  const q = p.toString() ? `?${p}` : "";
  return discover(LOGBOOK_PATHS, q, logbookIdx, (i) => { logbookIdx = i; });
}

// Raw logbook → the { driver, status, at } events summarizeDutyDays walks.
export function normalizeDutyEvents(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.Logs) ? raw.Logs
    : Array.isArray(raw?.logs) ? raw.logs
    : Array.isArray(raw?.Events) ? raw.Events
    : Array.isArray(raw?.events) ? raw.events
    : Array.isArray(raw?.Items) ? raw.Items
    : Array.isArray(raw?.items) ? raw.items
    : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const driver = pick(row, "DriverNumber", "driverNumber", "DriverId", "driverId", "Driver", "driver")
      ?? pick(row.Driver || row.driver || {}, "Number", "number", "Id", "id");
    const status = pick(row, "DutyStatus", "dutyStatus", "Status", "status", "EventType", "eventType");
    const when = pick(row, "StartUTC", "startUTC", "StartTime", "startTime", "EventUTC", "Timestamp", "timestamp", "DateTimeUTC", "UpdateUTC");
    if (driver == null || status == null || when == null) continue;
    const at = new Date(when).getTime();
    if (isNaN(at)) continue;
    // A driver object can carry a nested name; the number is what links to us.
    out.push({ driver: String(typeof driver === "object" ? (driver.Number ?? driver.Id ?? "") : driver), status, at });
  }
  return out.filter(e => e.driver);
}

// Pulls the logbook and writes one row per driver per day into driver_hos_days.
// Never touches driver_work_days: that is the payroll the office keys in, and
// these numbers exist precisely to be compared against it.
export async function syncDriverHours({ from, to } = {}) {
  if (!verizonConfigured()) throw new Error("Verizon credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");

  const { data: drivers, error } = await admin.from("drivers").select("*");
  if (error) throw new Error(`drivers read failed: ${error.message}`);
  const byVz = new Map();
  for (const d of drivers || []) {
    if (!d.deleted_at && d.verizon_driver_id) byVz.set(String(d.verizon_driver_id), d.id);
  }
  const result = { linked: byVz.size, days: 0, unmatched: 0, from, to };
  if (!byVz.size) return result;

  const rows = summarizeDutyDays(normalizeDutyEvents(await fetchDutyEvents(from, to)));
  const payload = [];
  for (const r of rows) {
    const driverId = byVz.get(String(r.driver));
    if (!driverId) { result.unmatched++; continue; }
    payload.push({
      driver_id: driverId, work_date: r.date,
      hours: r.hours, driving_hours: r.drivingHours,
      clock_in: r.clockIn, clock_out: r.clockOut,
      synced_at: new Date().toISOString(),
    });
  }
  if (payload.length) {
    const { error: upErr } = await admin.from("driver_hos_days").upsert(payload, { onConflict: "driver_id,work_date" });
    if (upErr) throw new Error(`driver_hos_days upsert failed: ${upErr.message}`);
    result.days = payload.length;
  }
  return result;
}

// ── GPS webhooks ─────────────────────────────────────────────────────────────
// Reveal pushes positions instead of us polling for them. The exact payload sits
// behind the gated portal, so read whatever is there and let the endpoint log
// anything unrecognised rather than guessing a schema and dropping real events.

export function normalizeGpsEvents(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.Events) ? raw.Events
    : Array.isArray(raw?.events) ? raw.events
    : Array.isArray(raw?.Items) ? raw.Items
    : Array.isArray(raw?.items) ? raw.items
    : raw && typeof raw === "object" ? [raw] : [];
  const out = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    // The vehicle is either on the event or nested under a Vehicle object.
    const number = pick(row, "VehicleNumber", "vehicleNumber", "Number", "number")
      ?? pick(row.Vehicle || row.vehicle || {}, "Number", "number", "VehicleNumber");
    const loc = mapLocation(row);
    if (number == null || !loc) continue;
    out.push({ number: String(number), loc });
  }
  return out;
}

// Writes a webhook delivery onto the trucks it names. Returns counts so the
// endpoint can log a delivery that matched nothing.
export async function applyGpsEvents(raw) {
  if (!admin) throw new Error("Supabase service role is not configured");
  const events = normalizeGpsEvents(raw);
  const result = { events: events.length, applied: 0, unmatched: 0 };

  // One write per vehicle, keeping the newest fix: a batch can carry several
  // events for the same truck and the last one written must not be the oldest.
  const latest = new Map();
  for (const e of events) {
    const prev = latest.get(e.number);
    if (!prev || e.loc.last_location_at >= prev.last_location_at) latest.set(e.number, e.loc);
  }

  const fresh = [];
  for (const [number, loc] of latest) {
    const { data, error } = await admin.from("trucks")
      .update(loc).eq("verizon_vehicle_id", number).select("id, last_location_at");
    if (error) throw new Error(`trucks update failed: ${error.message}`);
    if (data && data.length) {
      result.applied += data.length;
      for (const row of data) {
        fresh.push({ truck_id: row.id, lat: loc.last_lat, lng: loc.last_lng, status: loc.last_status, at: loc.last_location_at });
      }
    } else result.unmatched++;   // a vehicle nobody linked to a truck yet
  }
  await recordPings(fresh);
  result.pings = fresh.length;
  return result;
}

// ── Diagnostics ──────────────────────────────────────────────────────────────
// Which Reveal products this account actually has. The developer portal knows,
// but reading it means a person clicking through a gated site; the server holds
// credentials and can reach Verizon, so it asks directly instead.

async function probeProduct(builders, arg) {
  const tried = [];
  for (const build of builders) {
    const path = build(arg);
    try {
      const r = await callRaw(path);
      tried.push(`${path} → ${r.status}`);
      if (r.ok) return { ok: true, path, tried, data: r.data };
    } catch (e) {
      tried.push(`${path} → ${e?.message || "error"}`);
    }
  }
  return { ok: false, tried };
}

export async function diagnose() {
  const checks = [];
  if (!verizonConfigured()) {
    return [{ key: "config", ok: false, detail: "VERIZON_REST_USER / _PASSWORD / _APP_ID are not all set" }];
  }

  // Force a fresh token: a cached one would hide a credential that just broke.
  try {
    await getToken(true);
    checks.push({ key: "auth", ok: true });
  } catch (e) {
    checks.push({ key: "auth", ok: false, detail: e?.message });
    return checks;   // nothing else can pass if the handshake fails
  }

  const veh = await probeProduct(VEHICLES_PATHS, null);
  const fleet = veh.ok ? normalizeVehicles(veh.data) : [];
  checks.push({ key: "vehicles", ok: veh.ok, path: veh.path, tried: veh.tried, count: fleet.length });

  if (fleet.length) {
    const loc = await probeProduct(LOCATION_PATHS, encodeURIComponent(fleet[0].number));
    const mapped = loc.ok ? mapLocation(loc.data) : null;
    checks.push({
      key: "location", ok: loc.ok && !!mapped, path: loc.path, tried: loc.tried,
      // A product that answers but whose fields we cannot read is its own problem.
      detail: loc.ok && !mapped ? "responded, but no coordinates could be read from the payload" : undefined,
    });
  } else {
    checks.push({ key: "location", ok: false, detail: "no vehicle to test with" });
  }

  const to = new Date().toISOString().slice(0, 10);
  const from = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
  const log = await probeProduct(LOGBOOK_PATHS, `?startDate=${from}&endDate=${to}`);
  const events = log.ok ? normalizeDutyEvents(log.data).length : 0;
  checks.push({
    key: "logbook", ok: log.ok, path: log.path, tried: log.tried, count: events,
    detail: log.ok && events === 0 ? "responded, but no duty events in the last 7 days" : undefined,
  });

  return checks;
}

// ── GPS history (backfill) ───────────────────────────────────────────────────
// Documented in the portal as GET /vehicles/{vehiclenumber}/status/history, in
// the same Real-time Aggregated Data suite as the live status call — so it hangs
// off the same base. Up to 30 days, which is what makes the reports useful on day
// one instead of after weeks of collecting.
const HISTORY_PATHS = [
  (a) => `/rad/v1/vehicles/${a.v}/status/history${a.q}`,
  (a) => `/rad/v1/vehicles/${a.v}/history${a.q}`,
];
let historyIdx = null;

// The portal documents the route but the parameter spelling is behind the
// operation detail, so try the shapes Reveal uses and keep the one that answers.
const HISTORY_QUERIES = [
  (f, t) => `?startdatetimeutc=${f}&enddatetimeutc=${t}`,
  (f, t) => `?startDate=${f.slice(0, 10)}&endDate=${t.slice(0, 10)}`,
  (f, t) => `?from=${f}&to=${t}`,
  () => "",
];
let historyQueryIdx = null;

// Raw history → the same shape truck_pings stores.
export function normalizeHistory(raw) {
  const rows = Array.isArray(raw) ? raw
    : Array.isArray(raw?.History) ? raw.History
    : Array.isArray(raw?.history) ? raw.history
    : Array.isArray(raw?.Items) ? raw.Items
    : Array.isArray(raw?.items) ? raw.items
    : [];
  const out = [];
  for (const row of rows) {
    const loc = mapLocation(row);
    if (loc) out.push(loc);
  }
  return out;
}

// Tries each query spelling against the discovered route until one answers with
// something that parses into positions.
export async function fetchVehicleHistory(vehicleNumber, fromISO, toISO) {
  const v = encodeURIComponent(vehicleNumber);
  const order = historyQueryIdx == null
    ? HISTORY_QUERIES.map((_, i) => i)
    : [historyQueryIdx, ...HISTORY_QUERIES.map((_, i) => i).filter(i => i !== historyQueryIdx)];
  let lastErr = null;
  for (const qi of order) {
    const q = HISTORY_QUERIES[qi](fromISO, toISO);
    try {
      const raw = await discover(HISTORY_PATHS, { v, q }, historyIdx, (i) => { historyIdx = i; });
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
export async function backfillHistory({ days = 30 } = {}) {
  if (!verizonConfigured()) throw new Error("Verizon credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");
  const { data, error } = await admin.from("trucks").select("*");
  if (error) throw new Error(`trucks read failed: ${error.message}`);
  const mapped = (data || []).filter(t => !t.deleted_at && t.verizon_vehicle_id);

  const to = new Date().toISOString();
  const from = new Date(Date.now() - days * 864e5).toISOString();
  const result = { trucks: mapped.length, positions: 0, days, errors: [] };

  for (const truck of mapped) {
    try {
      const rows = await fetchVehicleHistory(truck.verizon_vehicle_id, from, to);
      const pings = rows.map(r => ({
        truck_id: truck.id, lat: r.last_lat, lng: r.last_lng,
        status: r.last_status, at: r.last_location_at,
      }));
      // One truck at a time: a month of fixes for the whole fleet in a single
      // statement is a large write and a timeout takes everything with it.
      await recordPings(pings);
      result.positions += pings.length;
    } catch (e) {
      result.errors.push({ truck: truck.name || truck.id, error: e?.message || String(e) });
    }
  }
  return result;
}

// ── Position history ─────────────────────────────────────────────────────────

// Two timestamps for the same instant, whatever shape Postgres handed back.
export const sameInstant = (a, b) => {
  if (!a || !b) return false;
  const x = new Date(a).getTime(), y = new Date(b).getTime();
  return !isNaN(x) && !isNaN(y) && x === y;
};

// One row per distinct fix. Verizon repeats the last known position between
// updates, so writing every poll would store the same parked truck 288 times a
// day and drown the real movement in it.
async function recordPings(rows) {
  if (!rows.length) return;
  try {
    // Ignores rows that collide with (truck_id, at) — a re-sync of a fix we have.
    await admin.from("truck_pings").upsert(rows, { onConflict: "truck_id,at", ignoreDuplicates: true });
  } catch (e) {
    // History is worth having but never worth failing a sync over.
    console.error("truck_pings:", e?.message || e);
  }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

// Pulls the current position of every truck mapped to a Reveal vehicle and
// writes it onto the trucks row the live-load map already renders.
export async function syncTruckLocations() {
  if (!verizonConfigured()) throw new Error("Verizon credentials are not configured");
  if (!admin) throw new Error("Supabase service role is not configured");

  // select("*") on purpose: trucks predates the soft-delete convention and may
  // not have deleted_at, which would make a column-level filter throw.
  const { data, error } = await admin.from("trucks").select("*");
  if (error) throw new Error(`trucks read failed: ${error.message}`);

  const mapped = (data || []).filter((t) => !t.deleted_at && t.verizon_vehicle_id);
  const result = { checked: mapped.length, updated: 0, skipped: 0, errors: [] };
  if (!mapped.length) return result;
  const fresh = [];   // positions we had not seen before, for truck_pings

  // Small fleet, but keep a lid on concurrency so one sync can't burst the API.
  const queue = [...mapped];
  const worker = async () => {
    while (queue.length) {
      const truck = queue.shift();
      try {
        const loc = mapLocation(await fetchVehicleLocation(truck.verizon_vehicle_id));
        if (!loc) { result.skipped++; continue; }
        const { error: uErr } = await admin.from("trucks").update(loc).eq("id", truck.id);
        if (uErr) throw new Error(uErr.message);
        result.updated++;
        if (!sameInstant(truck.last_location_at, loc.last_location_at)) {
          fresh.push({ truck_id: truck.id, lat: loc.last_lat, lng: loc.last_lng, status: loc.last_status, at: loc.last_location_at });
        }
      } catch (e) {
        result.errors.push({ truck: truck.name || truck.id, error: e?.message || String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, mapped.length) }, worker));
  await recordPings(fresh);
  result.pings = fresh.length;
  return result;
}
