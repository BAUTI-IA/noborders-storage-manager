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

function formatAddress(a) {
  if (!a) return null;
  if (typeof a === "string") return a;
  const parts = [
    pick(a, "AddressLine1", "addressLine1", "Line1", "StreetAddress"),
    pick(a, "Locality", "locality", "City", "city"),
    pick(a, "AdministrativeArea", "administrativeArea", "State", "state"),
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
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
    // "T-14 · Freightliner · ABC-1234" — whatever of that the roster actually has.
    const extras = [name, plate].filter((x) => x && String(x) !== key).map(String);
    out.push({ number: key, label: [key, ...extras].join(" · ") });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label, undefined, { numeric: true }));
}

// Which endpoints this lambda settled on — surfaced by fleet=probe for debugging.
export const resolvedPaths = () => ({
  location: locationIdx == null ? null : LOCATION_PATHS[locationIdx]("{vehicle}"),
  vehicles: vehiclesIdx == null ? null : VEHICLES_PATHS[vehiclesIdx](),
});

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
      } catch (e) {
        result.errors.push({ truck: truck.name || truck.id, error: e?.message || String(e) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, mapped.length) }, worker));
  return result;
}
