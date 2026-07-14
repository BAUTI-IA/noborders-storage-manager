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
// The account exposes the NEW api products (Fleet API → POST
// /fleetapi/v1/fleet-items/search, cursor-paginated via pageToken; items carry
// fleetItemId/name/vin but no position). The exact location route isn't
// documented publicly, so on each cold start we DISCOVER it: try every known
// shape against the first matched vehicle, remember whichever answers, and use
// it for the rest. GET ?debug=1 records every attempt (including the API's
// validation messages); GET ?list=1 returns just the fleet list (used by the
// truck form's "Verizon vehicle" dropdown).
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
  if (!r.ok) throw new Error(`HTTP ${r.status} en ${path}${text ? ` · ${text.slice(0, 200)}` : ""}`);
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

// ── Normalization helpers ────────────────────────────────────────────────────

const norm = (s) => (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");
const prefix = (s) => norm(s).split(/[-·|]/)[0].trim();
// "bt013ld-1750cf" → "bt013"; "bt003 - lees truck" → "bt003". Letters+digits code.
const codeOf = (s) => { const m = norm(s).match(/[a-z]{1,6}\s?-?\d{1,6}/); return m ? m[0].replace(/[\s-]/g, "") : null; };
const pick = (o, keys) => { for (const k of keys) { const v = o?.[k]; if (v != null && v !== "") return v; } return null; };
const pickStr = (o, keys) => { const v = pick(o, keys); return typeof v === "string" ? v : null; };

const asList = (raw) =>
  Array.isArray(raw) ? raw
  : Array.isArray(raw?.items) ? raw.items
  : Array.isArray(raw?.data) ? raw.data
  : Array.isArray(raw?.Data) ? raw.Data
  : Array.isArray(raw?.results) ? raw.results
  : Array.isArray(raw?.fleetItems) ? raw.fleetItems
  : Array.isArray(raw?.locations) ? raw.locations
  : Array.isArray(raw?.content) ? raw.content
  : Array.isArray(raw?.vehicles) ? raw.vehicles
  : [];

// A fleet item / vehicle, whatever generation of API it came from.
function normVehicle(it) {
  return {
    id: pick(it, ["fleetItemId", "id", "vehicleId", "Id", "uid"]),
    number: pick(it, ["vehicleNumber", "VehicleNumber", "number", "code", "unitNumber", "assetNumber"]),
    name: pick(it, ["name", "Name", "label", "displayName", "description"]),
    vin: pick(it, ["vin", "VIN", "vehicleIdentificationNumber"]),
    raw: it,
  };
}

// Find lat/lng (+ address/time/speed/state) wherever the payload put them.
function extractLoc(o) {
  if (!o || typeof o !== "object") return null;
  const cands = [o, o.location, o.lastKnownLocation, o.lastLocation, o.currentLocation, o.position, o.gps, o.Location, o.data, o.geolocation, o.coordinates, o.point];
  for (const c of cands) {
    if (!c || typeof c !== "object") continue;
    const lat = Number(pick(c, ["latitude", "Latitude", "lat"]));
    const lng = Number(pick(c, ["longitude", "Longitude", "lng", "lon"]));
    if (isNaN(lat) || isNaN(lng) || (lat === 0 && lng === 0)) continue;
    const addr = c.address ?? c.Address ?? o.address;
    const address = typeof addr === "string" ? addr : addr && typeof addr === "object"
      ? [pickStr(addr, ["addressLine1", "AddressLine1", "street", "line1"]), pickStr(addr, ["locality", "Locality", "city"]), pickStr(addr, ["administrativeArea", "AdministrativeArea", "state", "region"])].filter(Boolean).join(", ") || null
      : null;
    return {
      lat, lng, address,
      at: pickStr(c, ["updateUtc", "UpdateUTC", "updatedAt", "timestamp", "time", "dateTime", "lastUpdated", "recordedAt", "deviceTimestamp", "eventDateTime"]) || pickStr(o, ["updateUtc", "UpdateUTC", "updatedAt", "timestamp", "lastUpdated"]),
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

async function updateTruck(truck, loc, backfillId) {
  const payload = {
    last_lat: loc.lat,
    last_lng: loc.lng,
    last_location: loc.address || null,
    last_location_at: toIso(loc.at),
    last_status: toStatus(loc.state, loc.speed),
  };
  if (!truck.verizon_vehicle_id && backfillId) payload.verizon_vehicle_id = backfillId.toString();
  const { error } = await admin.from("trucks").update(payload).eq("id", truck.id);
  if (error) throw new Error(`${truck.name}: ${error.message}`);
}

// Match CRM trucks to Verizon vehicles: stored id/number, VIN, exact name,
// prefix ("BT001" ↔ "BT001 - HINO Leon") and code ("BT013" ↔ "BT013LD-1750CF").
function matchTrucks(trucks, vehicles) {
  const byId = new Map(), byNumber = new Map(), byVin = new Map(), byName = new Map(), byPrefix = new Map(), byCode = new Map();
  for (const v of vehicles) {
    if (v.id != null) byId.set(norm(v.id), v);
    for (const k of [v.number, v.name]) {
      if (k == null) continue;
      if (k === v.number && !byNumber.has(norm(k))) byNumber.set(norm(k), v);
      if (!byPrefix.has(prefix(k))) byPrefix.set(prefix(k), v);
      const c = codeOf(k);
      if (c && !byCode.has(c)) byCode.set(c, v);
    }
    if (v.vin) byVin.set(norm(v.vin), v);
    if (v.name) byName.set(norm(v.name), v);
  }
  const matches = [], unmatched = [];
  for (const t of trucks) {
    const vid = t.verizon_vehicle_id;
    const v =
      (vid && (byId.get(norm(vid)) || byNumber.get(norm(vid)) || byName.get(norm(vid)))) ||
      (t.vin && byVin.get(norm(t.vin))) ||
      byName.get(norm(t.name)) ||
      byNumber.get(norm(t.name)) ||
      byPrefix.get(prefix(t.name)) ||
      (codeOf(t.name) ? byCode.get(codeOf(t.name)) : null);
    if (v) matches.push({ truck: t, vehicle: v });
    else unmatched.push(t.name);
  }
  return { matches, unmatched };
}

// ── Fleet API (new generation) ───────────────────────────────────────────────

// POST /fleetapi/v1/fleet-items/search — cursor-paginated via pageToken.
async function fetchFleetApiVehicles(token, debug, bodyExtra) {
  const seen = new Set();
  const out = [];
  let pageToken = null, error = null;
  for (let page = 0; page < 20; page++) {
    let raw = null;
    const body = { ...(bodyExtra || {}), ...(pageToken ? { pageToken } : {}) };
    try {
      raw = await vz("/fleetapi/v1/fleet-items/search", token, { method: "POST", body });
    } catch (e) {
      if (pageToken) {
        // some deployments take the cursor as a query param instead
        try { raw = await vz(`/fleetapi/v1/fleet-items/search?pageToken=${encodeURIComponent(pageToken)}`, token, { method: "POST", body: bodyExtra || {} }); }
        catch { error = `Fleet API (página ${page + 1}): ${e.message}`; break; }
      } else { error = `Fleet API: ${e.message}`; break; }
    }
    const list = asList(raw);
    if (debug && page === 0 && !debug.fleetSearchSample) debug.fleetSearchSample = { keys: raw ? Object.keys(raw) : null, firstItem: list[0] || null };
    let added = 0;
    for (const it of list) {
      const v = normVehicle(it);
      const key = norm(v.id ?? v.name ?? JSON.stringify(it).slice(0, 80));
      if (seen.has(key)) continue;
      seen.add(key); out.push(v); added++;
    }
    const next = raw?.pageToken || raw?.nextPageToken || null;
    if (!next || next === pageToken || added === 0) break;
    pageToken = next;
  }
  return { list: out, error };
}

// Known shapes for "where is this vehicle now". Discovered once per cold start
// against a sample vehicle; the winner is cached and reused for the whole run.
// The fleet items carry an empty "metrics" array — telemetry (location, speed)
// likely hangs off a metrics route or a sibling API product.
const LOC_GET_TEMPLATES = [
  "/fleetapi/v1/fleet-items/{id}/metrics",
  "/fleetapi/v1/fleet-items/{id}/metrics/latest",
  "/fleetapi/v1/fleet-items/{id}?metrics=LOCATION,SPEED",
  "/fleetapi/v1/fleet-items/{id}?includeMetrics=true",
  "/fleetapi/v1/fleet-items/{id}?expand=metrics",
  "/fleetapi/v1/fleet-items/{id}/location",
  "/fleetapi/v1/fleet-items/{id}/locations/latest",
  "/fleetapi/v1/fleet-items/{id}/locations",
  "/fleetapi/v1/fleet-items/{id}/last-known-location",
  "/fleetapi/v1/fleet-items/{id}/current-location",
  "/fleetapi/v1/fleet-items/{id}/position",
  "/fleetapi/v1/fleet-items/{id}/gps",
  "/fleetapi/v1/fleet-items/{id}/status",
  "/fleetapi/v1/fleet-items/{id}",
  "/telemetryapi/v1/fleet-items/{id}/location",
  "/telemetryapi/v1/fleet-items/{id}/latest",
  "/vehicledataapi/v1/fleet-items/{id}/location",
  "/locationapi/v1/fleet-items/{id}/location",
  "/gpsapi/v1/fleet-items/{id}/location",
];
// Batch variants: one POST answering for many ids at once.
const LOC_BATCH_TEMPLATES = [
  { path: "/fleetapi/v1/fleet-items/locations/search", make: (ids) => ({ fleetItemIds: ids }) },
  { path: "/fleetapi/v1/locations/search", make: (ids) => ({ fleetItemIds: ids }) },
  { path: "/fleetapi/v1/fleet-items/metrics/search", make: (ids) => ({ fleetItemIds: ids }) },
  { path: "/fleetapi/v1/metrics/search", make: (ids) => ({ fleetItemIds: ids, metrics: ["LOCATION", "SPEED"] }) },
  { path: "/telemetryapi/v1/locations/search", make: (ids) => ({ fleetItemIds: ids }) },
];
// Body tweaks that may make /fleet-items/search embed the position directly.
const SEARCH_BODY_VARIANTS = [
  { expand: ["location"] },
  { include: ["location"] },
  { includeLocation: true },
  { metrics: ["LOCATION", "SPEED"] },
];

let cachedLocTemplate = null; // survives warm invocations

async function locByTemplate(tpl, token, id) {
  const raw = await vz(tpl.replace("{id}", encodeURIComponent(id)), token);
  return extractLoc(raw) || extractLoc(asList(raw)[0]);
}

// Try everything against one sample id; report attempts; return working template.
async function discoverLocTemplate(token, sampleId, attempts) {
  if (cachedLocTemplate) return cachedLocTemplate;
  for (const tpl of LOC_GET_TEMPLATES) {
    try {
      const raw = await vz(tpl.replace("{id}", encodeURIComponent(sampleId)), token);
      const loc = extractLoc(raw) || extractLoc(asList(raw)[0]);
      attempts?.push({
        path: tpl,
        result: loc ? "✔ ubicación encontrada"
          : raw == null ? "404/vacío"
          : `respondió sin posición · ${JSON.stringify(raw).slice(0, 160)}`,
      });
      if (loc) { cachedLocTemplate = tpl; return tpl; }
    } catch (e) {
      attempts?.push({ path: tpl, result: e.message.slice(0, 180) });
    }
  }
  return null;
}

// Batch lookup: id → loc for all matched vehicles in one/two calls.
async function batchLocations(token, ids, attempts) {
  for (const { path, make } of LOC_BATCH_TEMPLATES) {
    try {
      const raw = await vz(path, token, { method: "POST", body: make(ids) });
      const list = asList(raw);
      attempts?.push({ path, result: list.length ? `✔ ${list.length} resultados` : raw ? `keys: ${Object.keys(raw).slice(0, 10).join(",")}` : "404/vacío" });
      if (!list.length) continue;
      const map = new Map();
      for (const it of list) {
        const key = pick(it, ["fleetItemId", "id", "vehicleId"]);
        const loc = extractLoc(it);
        if (key != null && loc) map.set(norm(key), loc);
      }
      if (map.size) return map;
    } catch (e) {
      attempts?.push({ path, result: e.message.slice(0, 180) });
    }
  }
  return null;
}

// Search-body variants that may return items with the position embedded.
async function searchWithEmbeddedLoc(token, attempts) {
  for (const variant of SEARCH_BODY_VARIANTS) {
    try {
      const raw = await vz("/fleetapi/v1/fleet-items/search", token, { method: "POST", body: variant });
      const first = asList(raw)[0];
      const loc = extractLoc(first);
      attempts?.push({ path: `search+${JSON.stringify(variant)}`, result: loc ? "✔ posición embebida" : first ? "sin posición en items" : "vacío" });
      if (loc) return variant;
    } catch (e) {
      attempts?.push({ path: `search+${JSON.stringify(variant)}`, result: e.message.slice(0, 180) });
    }
  }
  return null;
}

// ── Legacy Reveal REST (/cmv + /rad) ─────────────────────────────────────────

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
  const listOnly = req.query?.list != null;
  const debug = wantDebug ? {} : null;

  try {
    const token = await getToken();
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

    // Lightweight mode for the truck form's dropdown: just the fleet list.
    if (listOnly) {
      res.status(200).json({
        ok: true, api,
        vehicles: vehicles.map(v => ({ id: v.id, number: v.number, name: v.name, vin: v.vin })),
      });
      return;
    }

    const { data: trucks, error: tErr } = await admin
      .from("trucks")
      .select("id, name, vin, verizon_vehicle_id")
      .eq("active", true);
    if (tErr) throw tErr;

    let synced = 0, noGps = 0;
    let unmatched = [];

    if (vehicles.length > 0) {
      const m = matchTrucks(trucks || [], vehicles);
      unmatched = m.unmatched;

      if (m.matches.length > 0 && api === "fleetapi") {
        const attempts = debug ? (debug.locAttempts = []) : null;
        const ids = m.matches.map(({ vehicle }) => vehicle.id).filter(v => v != null);

        // (a) direct per-item route, discovered on a sample vehicle
        const tpl = ids.length ? await discoverLocTemplate(token, ids[0], attempts) : null;
        // (b) batch route
        const batch = !tpl && ids.length ? await batchLocations(token, ids, attempts) : null;
        // (c) search body variant that embeds the position
        let embedded = null;
        if (!tpl && !batch) {
          const variant = await searchWithEmbeddedLoc(token, attempts);
          if (variant) {
            const again = await fetchFleetApiVehicles(token, null, variant);
            embedded = new Map();
            for (const v of again.list) {
              const loc = extractLoc(v.raw);
              if (v.id != null && loc) embedded.set(norm(v.id), loc);
            }
          }
        }

        for (const { truck, vehicle } of m.matches) {
          try {
            let loc = extractLoc(vehicle.raw);
            if (!loc && vehicle.id != null) {
              if (tpl) loc = await locByTemplate(tpl, token, vehicle.id).catch(() => null);
              else if (batch) loc = batch.get(norm(vehicle.id)) || null;
              else if (embedded) loc = embedded.get(norm(vehicle.id)) || null;
            }
            if (!loc) {
              const code = vehicle.number || codeOf(truck.name)?.toUpperCase() || truck.name;
              loc = await fetchLegacyLocation(token, code);
            }
            if (!loc) { noGps++; continue; }
            await updateTruck(truck, loc, vehicle.id || vehicle.number);
            synced++;
          } catch (e) { errors.push(e?.message || String(e)); }
        }
      } else {
        // Legacy fleet list: locations live in /rad by vehicle number.
        for (const { truck, vehicle } of m.matches) {
          try {
            let loc = extractLoc(vehicle.raw);
            if (!loc && vehicle.number != null) loc = await fetchLegacyLocation(token, vehicle.number);
            if (!loc) { noGps++; continue; }
            await updateTruck(truck, loc, vehicle.number || vehicle.id);
            synced++;
          } catch (e) { errors.push(e?.message || String(e)); }
        }
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
      verizonVehicles: vehicles.slice(0, 30).map(v => ({ id: v.id, number: v.number, name: v.name, vin: v.vin })),
      unmatched: unmatched.length ? unmatched : undefined,
      locRoute: cachedLocTemplate || undefined,
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
