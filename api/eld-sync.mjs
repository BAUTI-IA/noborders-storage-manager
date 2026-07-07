// Vercel serverless function: pull the latest GPS position of every vehicle
// from the fleet's ELD providers (Verizon Connect Reveal and/or Motive) and
// write it into public.trucks (last_lat/last_lng/last_location/last_status).
// Supabase Realtime then pushes the update to every open CRM tab, so the
// Trips / Live Load map refreshes by itself.
//
// Called two ways:
//   - Cron (GitHub Actions): POST /api/eld-sync with header x-eld-sync-key
//     (or ?key=) matching ELD_SYNC_KEY.
//   - CRM "Sync ELD" button: POST with the user's Supabase JWT as Bearer token;
//     any active profile may trigger a sync.
//
// Required env (configure in Vercel project settings):
//   SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL (or VITE_SUPABASE_URL)
//   ELD_SYNC_KEY                 - shared secret for the cron caller
// Verizon Connect Reveal (optional — skipped if unset):
//   VERIZON_REVEAL_USERNAME, VERIZON_REVEAL_PASSWORD, VERIZON_REVEAL_APP_ID
//   VERIZON_REVEAL_BASE_URL      - default https://fim.api.us.fleetmatics.com
// Motive (optional — skipped if unset):
//   MOTIVE_API_KEY               - Admin → API Keys in the Motive dashboard
//   MOTIVE_BASE_URL              - default https://api.gomotive.com
//
// Truck ↔ vehicle matching (set in the CRM's truck form, "ELD / GPS" section):
//   trucks.verizon_vehicle_id ↔ Reveal Vehicle Number
//   trucks.motive_vehicle_id  ↔ Motive vehicle id or number
//   fallback: trucks.vin      ↔ Motive vehicle VIN
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SYNC_KEY = process.env.ELD_SYNC_KEY || "";

const VZ_USER = process.env.VERIZON_REVEAL_USERNAME || "";
const VZ_PASS = process.env.VERIZON_REVEAL_PASSWORD || "";
const VZ_APP_ID = process.env.VERIZON_REVEAL_APP_ID || "";
const VZ_BASE = (process.env.VERIZON_REVEAL_BASE_URL || "https://fim.api.us.fleetmatics.com").replace(/\/+$/, "");

const MOTIVE_KEY = process.env.MOTIVE_API_KEY || "";
const MOTIVE_BASE = (process.env.MOTIVE_BASE_URL || "https://api.gomotive.com").replace(/\/+$/, "");

const admin = SERVICE_KEY && SUPABASE_URL
  ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const norm = (s) => (s == null ? "" : String(s).trim().toLowerCase());
const isNum = (n) => typeof n === "number" && isFinite(n);

// ── Verizon Connect Reveal ──
// Two-step auth: GET /token with Basic user:pass returns a short-lived token,
// then every call carries "Atmosphere atmosphere_app_id=<id>, Bearer <token>".
async function fetchVerizonVehicles() {
  const basic = Buffer.from(`${VZ_USER}:${VZ_PASS}`).toString("base64");
  const tokRes = await fetch(`${VZ_BASE}/token`, {
    headers: { Authorization: `Basic ${basic}`, Accept: "text/plain" },
  });
  if (!tokRes.ok) throw new Error(`Reveal /token respondió ${tokRes.status} — revisá VERIZON_REVEAL_USERNAME/PASSWORD.`);
  const token = (await tokRes.text()).trim().replace(/^"+|"+$/g, "");
  if (!token) throw new Error("Reveal /token devolvió un token vacío.");

  const r = await fetch(`${VZ_BASE}/rad/v1/vehicles/locations`, {
    headers: {
      Accept: "application/json",
      Authorization: `Atmosphere atmosphere_app_id=${VZ_APP_ID}, Bearer ${token}`,
    },
  });
  if (!r.ok) throw new Error(`Reveal /rad/v1/vehicles/locations respondió ${r.status} — revisá VERIZON_REVEAL_APP_ID y que el usuario API tenga acceso REST.`);
  const data = await r.json();
  const rows = Array.isArray(data) ? data : (data?.Data || data?.data || []);

  return rows.map((v) => {
    const addr = v.Address || {};
    const label = [addr.AddressLine1, addr.Locality, addr.AdministrativeArea]
      .filter(Boolean).join(", ") || v.Address?.FormattedAddress || null;
    const speed = Number(v.Speed ?? v.CurrentSpeed ?? NaN);
    const state = norm(v.DisplayState || v.DeviceStatus || "");
    return {
      provider: "verizon",
      key: norm(v.VehicleNumber ?? v.Number ?? v.vehicleNumber),
      name: v.VehicleName || v.Name || v.VehicleNumber || "?",
      lat: Number(v.Latitude ?? v.latitude),
      lng: Number(v.Longitude ?? v.longitude),
      at: v.UpdateUTC || v.UpdateUtc || v.LocationTimestamp || null,
      label,
      moving: /driv|mov|tow/.test(state) || (isFinite(speed) && speed > 3),
    };
  }).filter((v) => v.key && isNum(v.lat) && isNum(v.lng));
}

// ── Motive (ex KeepTruckin) ──
// Single API key, paginated listing of every vehicle with its last known fix.
async function fetchMotiveVehicles() {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const r = await fetch(`${MOTIVE_BASE}/v1/vehicle_locations?per_page=100&page_no=${page}`, {
      headers: { "X-Api-Key": MOTIVE_KEY, Accept: "application/json" },
    });
    if (!r.ok) throw new Error(`Motive /v1/vehicle_locations respondió ${r.status} — revisá MOTIVE_API_KEY.`);
    const data = await r.json();
    const rows = data?.vehicles || [];
    for (const row of rows) {
      const v = row.vehicle || row;
      const loc = v.current_location || {};
      const speed = Number(loc.speed ?? NaN);
      out.push({
        provider: "motive",
        id: norm(v.id),
        number: norm(v.number),
        vin: norm(v.vin),
        name: v.number || v.vin || String(v.id),
        lat: Number(loc.lat ?? loc.latitude),
        lng: Number(loc.lon ?? loc.lng ?? loc.longitude),
        at: loc.located_at || null,
        label: loc.description || null,
        moving: norm(loc.type).includes("moving") || (isFinite(speed) && speed > 3),
      });
    }
    const pg = data?.pagination;
    if (!rows.length || !pg || (pg.page_no * pg.per_page) >= (pg.total ?? 0)) break;
  }
  return out.filter((v) => isNum(v.lat) && isNum(v.lng));
}

async function authorize(req) {
  // Cron path: shared secret in header (preferred) or query string.
  const key = req.headers["x-eld-sync-key"] || req.query?.key || "";
  if (SYNC_KEY && key && key === SYNC_KEY) return { ok: true, via: "cron" };

  // UI path: any active CRM profile, verified server-side from its JWT.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) return { ok: false, error: "No autorizado." };
  const { data: { user } = {}, error } = await admin.auth.getUser(token);
  if (error || !user) return { ok: false, error: "No autorizado." };
  const { data: me } = await admin.from("profiles").select("active").eq("id", user.id).single();
  if (!me || me.active === false) return { ok: false, error: "Perfil inactivo." };
  return { ok: true, via: "user" };
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!admin) {
    res.status(500).json({ error: "Falta configurar SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." });
    return;
  }
  const auth = await authorize(req);
  if (!auth.ok) { res.status(401).json({ error: auth.error }); return; }

  const hasVerizon = !!(VZ_USER && VZ_PASS && VZ_APP_ID);
  const hasMotive = !!MOTIVE_KEY;
  if (!hasVerizon && !hasMotive) {
    res.status(500).json({ error: "Ningún ELD configurado. Cargá las variables de Verizon (VERIZON_REVEAL_*) y/o Motive (MOTIVE_API_KEY) en Vercel." });
    return;
  }

  // Fetch both providers in parallel; one failing must not block the other.
  const providers = {};
  const [vzRes, mvRes] = await Promise.allSettled([
    hasVerizon ? fetchVerizonVehicles() : Promise.resolve([]),
    hasMotive ? fetchMotiveVehicles() : Promise.resolve([]),
  ]);
  const vzVehicles = vzRes.status === "fulfilled" ? vzRes.value : [];
  const mvVehicles = mvRes.status === "fulfilled" ? mvRes.value : [];
  providers.verizon = !hasVerizon ? "skipped" : vzRes.status === "fulfilled" ? `ok (${vzVehicles.length} vehicles)` : `error: ${vzRes.reason?.message || vzRes.reason}`;
  providers.motive = !hasMotive ? "skipped" : mvRes.status === "fulfilled" ? `ok (${mvVehicles.length} vehicles)` : `error: ${mvRes.reason?.message || mvRes.reason}`;

  const { data: trucks, error: tErr } = await admin
    .from("trucks")
    .select("id,name,vin,verizon_vehicle_id,motive_vehicle_id,last_location_at");
  if (tErr) {
    // motive_vehicle_id may not exist yet on older databases.
    res.status(500).json({ error: `No pude leer trucks: ${tErr.message}. Si falta la columna motive_vehicle_id, corré el setup SQL del CRM.`, providers });
    return;
  }

  const vzByNumber = new Map(vzVehicles.map((v) => [v.key, v]));
  const mvById = new Map(mvVehicles.map((v) => [v.id, v]));
  const mvByNumber = new Map(mvVehicles.map((v) => [v.number, v]).filter(([k]) => k));
  const mvByVin = new Map(mvVehicles.map((v) => [v.vin, v]).filter(([k]) => k));

  const matchedKeys = new Set();
  const results = [];
  let updated = 0;

  for (const t of trucks || []) {
    const candidates = [];
    if (t.verizon_vehicle_id) {
      const v = vzByNumber.get(norm(t.verizon_vehicle_id));
      if (v) candidates.push(v);
    }
    if (t.motive_vehicle_id) {
      const v = mvById.get(norm(t.motive_vehicle_id)) || mvByNumber.get(norm(t.motive_vehicle_id));
      if (v) candidates.push(v);
    } else if (t.vin) {
      const v = mvByVin.get(norm(t.vin));
      if (v) candidates.push(v);
    }
    if (!candidates.length) continue;

    // If a truck is linked to both providers, keep the freshest fix.
    const best = candidates.sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0))[0];
    candidates.forEach((c) => matchedKeys.add(`${c.provider}:${c.key || c.id}`));

    const payload = {
      last_lat: best.lat,
      last_lng: best.lng,
      last_location: best.label,
      last_location_at: best.at || new Date().toISOString(),
      last_status: best.moving ? "moving" : "stopped",
      eld_source: best.provider,
    };
    const { error } = await admin.from("trucks").update(payload).eq("id", t.id);
    if (error) {
      results.push({ id: t.id, name: t.name, error: error.message });
    } else {
      updated++;
      results.push({ id: t.id, name: t.name, source: best.provider, at: payload.last_location_at, status: payload.last_status });
    }
  }

  // Vehicles the providers reported that no CRM truck is linked to — surfaced
  // so the operator knows what's left to link in the truck form.
  const unmatched = {
    verizon: vzVehicles.filter((v) => !matchedKeys.has(`verizon:${v.key}`)).map((v) => v.name),
    motive: mvVehicles.filter((v) => !matchedKeys.has(`motive:${v.id}`)).map((v) => v.name),
  };

  res.status(200).json({ ok: true, updated, providers, trucks: results, unmatched });
}
