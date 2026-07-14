// Vercel serverless: sync truck GPS positions from the Verizon Connect REST APIs
// into public.trucks (last_lat / last_lng / last_location / last_status).
// Called from the Live Load map ("Sync Verizon" button + auto-refresh).
//
// Env vars (Vercel → Settings → Environment Variables):
//   VERIZON_APP_ID    — App ID from the Verizon Connect Developer Portal
//   VERIZON_USERNAME  — Reveal login username
//   VERIZON_PASSWORD  — that user's Reveal password
//   VERIZON_BASE_URL  — optional, defaults to https://fim.api.us.fleetmatics.com
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — already used by other functions
//
// The account's Developer Portal app exposes the NEW api products (Fleet API →
// POST /fleetapi/v1/fleet-items/search), so we try that first and normalize
// defensively (field names differ between accounts/versions). If that yields
// nothing we fall back to the legacy Reveal REST endpoints (/cmv, /rad), and
// finally to probing /rad per truck code. GET ?debug=1 includes raw samples.
import { createClient } from "@supabase/supabase-js";

const BASE = (process.env.VERIZON_BASE_URL || "https://fim.api.us.fleetmatics.com").replace(/\/+$/, "");
const APP_ID = process.env.VERIZON_APP_ID;
const USER = process.env.VERIZON_USERNAME;
const PASS = process.env.VERIZON_PASSWORD;

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = SUPABASE_URL && SERVICE_KEY
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// ── Verizon HTTP helpers ─────────────────────────────────────────────────────

// Reveal auth: GET /token with Basic auth returns a plain-text token (~20 min TTL).
async function getToken() {
  const r = await fetch(`${BASE}/token`, {
    headers: {
      Authorization: "Basic " + Buffer.from(`${USER}:${PASS}`).toString("base64"),
      Accept: "text/plain",
    },
  });
  if (r.status === 401 || r.status === 403) throw new Error("Verizon rechazó las credenciales (usuario/contraseña de Reveal).");
  if (!r.ok) throw new Error(`Verizon token: HTTP ${r.status}`);
  const token = (await r.text()).trim();
  if (!token) throw new Error("Verizon devolvió un token vacío.");
  return token;
}

// Generic call with the Atmosphere header. 404 → null; other errors throw with
// a snippet of the body (validation messages tell us what the API expects).
async function vz(path, token, { method = "GET", body } = {}) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      Authorization: `Atmosphere atmosphere_app_id=${APP_ID}, Bearer ${token}`,
      Accept: "application/json",
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const text = await r.text();
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}${text ? ` · ${text.slice(0, 180)}` : ""}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Normalization helpers ────────────────────────────────────────────────────

const norm = (s) => (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
const prefix = (s) => norm(s).split(/[-·|]/)[0].trim();
const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== "") return v; } return null; };
const pickStr = (o, keys) => { const v = pick(o, keys); return typeof v === "string" ? v : null; };

const asList = (raw) =>
  Array.isArray(raw) ? raw
  : Array.isArray(raw?.items) ? raw.items
  : Array.isArray(raw?.data) ? raw.data
  : Array.isArray(raw?.Data) ? raw.Data
  : Array.isArray(raw?.results) ? raw.results
  : Array.isArray(raw?.fleetItems) ? raw.fleetItems
  : Array.isArray(raw?.content) ? raw.content
  : Array.isArray(raw?.vehicles) ? raw.vehicles
  : [];

// A fleet item / vehicle, whatever generation of API it came from.
function normVehicle(it) {
  return {
    id: pick(it, ["id", "fleetItemId", "vehicleId", "Id", "uid"]),
    number: pick(it, ["vehicleNumber", "VehicleNumber", "number", "code", "unitNumber", "assetNumber"]),
    name: pick(it, ["name", "Name", "label", "displayName", "description"]),
    vin: pick(it, ["vin", "VIN", "vehicleIdentificationNumber"]),
    raw: it,
  };
}

// Find lat/lng (+ address/time/speed/state) wherever the payload put them.
function extractLoc(o) {
  if (!o || typeof o !== "object") return null;
  const cands = [o, o.location, o.lastKnownLocation, o.lastLocation, o.currentLocation, o.position, o.gps, o.Location, o.data];
  for (const c of cands) {
    if (!c || typeof c !== "object") continue;
    const lat = Number(pick(c, ["latitude", "Latitude", "lat"]));
    const lng = Number(pick(c, ["longitude", "Longitude", "lng", "lon"]));
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;
    const addr = c.address ?? c.Address;
    const address = typeof addr === "string" ? addr : addr && typeof addr === "object"
      ? [pickStr(addr, ["addressLine1", "AddressLine1", "street", "line1"]), pickStr(addr, ["locality", "Locality", "city"]), pickStr(addr, ["administrativeArea", "AdministrativeArea", "state", "region"])].filter(Boolean).join(", ") || null
      : null;
    return {
      lat, lng, address,
      at: pickStr(c, ["updateUtc", "UpdateUTC", "updatedAt", "timestamp", "time", "dateTime", "lastUpdated", "recordedAt"]) || pickStr(o, ["updateUtc", "UpdateUTC", "updatedAt", "timestamp", "lastUpdated"]),
      speed: pick(c, ["speed", "Speed"]) ?? pick(o, ["speed", "Speed"]),
      state: pickStr(c, ["displayState", "DisplayState", "movementStatus", "state", "status"]) || pickStr(o, ["displayState", "DisplayState", "movementStatus", "state", "status"]),
    };
  }
  return null;
}

// Reveal timestamps come as UTC but often without the trailing "Z".
function toIso(u) {
  if (!u) return new Date().toISOString();
  const s = u.toString();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

// moving / stopped for the live map (idle counts as stopped, we only have 2 states).
function toStatus(displayState, speed) {
  const ds = norm(displayState);
  if (ds && ds !== "[object object]") {
    if (ds.includes("mov") || ds.includes("driv") || ds.includes("tow")) return "moving";
    return "stopped";
  }
  const sp = Number(speed);
  if (!isNaN(sp)) return sp > 5 ? "moving" : "stopped";
  return "unknown";
}

async function updateTruck(truck, loc, backfillNumber) {
  const payload = {
    last_lat: loc.lat,
    last_lng: loc.lng,
    last_location: loc.address || null,
    last_location_at: toIso(loc.at),
    last_status: toStatus(loc.state, loc.speed),
  };
  if (!truck.verizon_vehicle_id && backfillNumber) payload.verizon_vehicle_id = backfillNumber.toString();
  const { error } = await admin.from("trucks").update(payload).eq("id", truck.id);
  if (error) throw new Error(`${truck.name}: ${error.message}`);
}

// Match CRM trucks to Verizon vehicles: vehicle #, VIN, exact name, then the
// "BT001" prefix of names like "BT001 - HINO Leon".
function matchTrucks(trucks, vehicles) {
  const byNumber = new Map(), byVin = new Map(), byName = new Map(), byPrefix = new Map();
  for (const v of vehicles) {
    if (v.number != null) {
      byNumber.set(norm(v.number), v);
      if (!byPrefix.has(prefix(v.number))) byPrefix.set(prefix(v.number), v);
    }
    if (v.vin) byVin.set(norm(v.vin), v);
    if (v.name) {
      byName.set(norm(v.name), v);
      if (!byPrefix.has(prefix(v.name))) byPrefix.set(prefix(v.name), v);
    }
  }
  const matches = [], unmatched = [];
  for (const t of trucks) {
    const v =
      (t.verizon_vehicle_id && (byNumber.get(norm(t.verizon_vehicle_id)) || byName.get(norm(t.verizon_vehicle_id)))) ||
      (t.vin && byVin.get(norm(t.vin))) ||
      byName.get(norm(t.name)) ||
      byNumber.get(norm(t.name)) ||
      byPrefix.get(prefix(t.name));
    if (v) matches.push({ truck: t, vehicle: v });
    else unmatched.push(t.name);
  }
  return { matches, unmatched };
}

// ── Strategies ───────────────────────────────────────────────────────────────

// New-generation Fleet API: POST /fleetapi/v1/fleet-items/search.
async function fetchFleetApiVehicles(token, debug) {
  const attempts = [
    { body: {} },
    { body: { pagination: { pageSize: 200 } } },
    { body: { page: 1, pageSize: 200 } },
  ];
  let lastErr = null;
  for (const a of attempts) {
    try {
      const raw = await vz("/fleetapi/v1/fleet-items/search", token, { method: "POST", body: a.body });
      const list = asList(raw);
      if (debug) debug.fleetSearchSample = Array.isArray(raw) ? raw.slice(0, 1) : raw && { ...raw, items: asList(raw).slice(0, 1) };
      if (list.length) return { list: list.map(normVehicle), error: null };
      lastErr = null; // 200 but empty — remember that it worked
    } catch (e) {
      lastErr = `Fleet API: ${e.message}`;
      if (!/HTTP 400/.test(e.message)) break; // only retry alternative bodies on validation errors
    }
  }
  return { list: [], error: lastErr };
}

// Location for a fleet item on the new API (embedded already handled by caller).
async function fetchFleetApiLocation(token, id) {
  for (const p of [`/fleetapi/v1/fleet-items/${encodeURIComponent(id)}/location`, `/fleetapi/v1/fleet-items/${encodeURIComponent(id)}/locations/latest`]) {
    try {
      const raw = await vz(p, token);
      const loc = extractLoc(raw) || extractLoc(asList(raw)[0]);
      if (loc) return loc;
    } catch { /* try next shape */ }
  }
  return null;
}

// Legacy Reveal REST: /cmv/v1/vehicles + /rad/v1/vehicles/{n}/location|status.
async function fetchLegacyVehicles(token) {
  try {
    const raw = await vz("/cmv/v1/vehicles", token);
    return { list: asList(raw).map(normVehicle), error: null };
  } catch (e) {
    return { list: [], error: `API clásica: ${e.message}` };
  }
}

async function fetchLegacyLocation(token, number) {
  const num = encodeURIComponent(number);
  const [loc, st] = await Promise.all([
    vz(`/rad/v1/vehicles/${num}/location`, token).catch(() => null),
    vz(`/rad/v1/vehicles/${num}/status`, token).catch(() => null),
  ]);
  const l = extractLoc(loc);
  if (!l) return null;
  const s = extractLoc(st);
  return { ...l, state: l.state || s?.state || (st && pickStr(st, ["DisplayState", "displayState"])), speed: l.speed ?? st?.Speed };
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!APP_ID || !USER || !PASS) {
    res.status(200).json({ ok: false, notConfigured: true, error: "Faltan VERIZON_APP_ID / VERIZON_USERNAME / VERIZON_PASSWORD en Vercel." });
    return;
  }
  if (!admin) { res.status(500).json({ ok: false, error: "Falta SUPABASE_SERVICE_ROLE_KEY en el servidor." }); return; }

  const wantDebug = req.query?.debug != null;
  const debug = wantDebug ? {} : null;

  try {
    const token = await getToken();

    const { data: trucks, error: tErr } = await admin
      .from("trucks")
      .select("id, name, vin, verizon_vehicle_id")
      .eq("active", true);
    if (tErr) throw tErr;

    const errors = [];

    // 1) New Fleet API, 2) legacy fleet list.
    let api = "fleetapi";
    let { list: vehicles, error: fErr } = await fetchFleetApiVehicles(token, debug);
    if (fErr) errors.push(fErr);
    if (vehicles.length === 0) {
      api = "legacy";
      const legacy = await fetchLegacyVehicles(token);
      if (legacy.error) errors.push(legacy.error);
      vehicles = legacy.list;
    }

    let synced = 0, noGps = 0;
    let unmatched = [];

    if (vehicles.length > 0) {
      const m = matchTrucks(trucks || [], vehicles);
      unmatched = m.unmatched;
      for (const { truck, vehicle } of m.matches) {
        try {
          // Many list payloads embed the last known position — use it if present.
          let loc = extractLoc(vehicle.raw);
          if (!loc) {
            loc = api === "fleetapi"
              ? (vehicle.id != null ? await fetchFleetApiLocation(token, vehicle.id) : null) ||
                (vehicle.number != null ? await fetchLegacyLocation(token, vehicle.number) : null)
              : (vehicle.number != null ? await fetchLegacyLocation(token, vehicle.number) : null);
          }
          if (!loc) { noGps++; continue; }
          await updateTruck(truck, loc, vehicle.number || vehicle.name);
          synced++;
        } catch (e) { errors.push(e?.message || String(e)); }
      }
    } else {
      // 3) No fleet list from either API — probe legacy per-vehicle endpoints
      // with the codes we have in the CRM.
      api = "probe";
      for (const t of trucks || []) {
        const code = (t.verizon_vehicle_id || t.name || "").toString().trim();
        if (!code) { unmatched.push(t.name); continue; }
        try {
          const loc = await fetchLegacyLocation(token, code);
          if (!loc) { unmatched.push(t.name); continue; }
          await updateTruck(t, loc, code);
          synced++;
        } catch (e) { errors.push(`${t.name}: ${e?.message || e}`); }
      }
    }

    res.status(200).json({
      ok: true,
      api,
      synced,
      noGps: noGps || undefined,
      vehiclesInVerizon: vehicles.length,
      verizonVehicles: vehicles.slice(0, 25).map(v => ({ id: v.id, number: v.number, name: v.name, vin: v.vin })),
      unmatched: unmatched.length ? unmatched : undefined,
      note: vehicles.length === 0
        ? "Ninguna API devolvió vehículos — falta que Verizon termine de habilitar el acceso de la app a los datos de la cuenta."
        : undefined,
      errors: errors.length ? errors : undefined,
      debug: debug || undefined,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e?.message || "Error al sincronizar con Verizon." });
  }
}
