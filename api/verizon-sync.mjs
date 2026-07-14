// Vercel serverless: sync truck GPS positions from the Verizon Connect Reveal
// REST API into public.trucks (last_lat / last_lng / last_location / last_status).
// Called from the Live Load map ("Sync Verizon" button + auto-refresh).
//
// Env vars (Vercel → Settings → Environment Variables):
//   VERIZON_APP_ID    — App ID from the Verizon Connect Developer Portal
//   VERIZON_USERNAME  — Reveal login username (the one used at reveal login)
//   VERIZON_PASSWORD  — that user's Reveal password
//   VERIZON_BASE_URL  — optional, defaults to https://fim.api.us.fleetmatics.com
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY — already used by other functions
//
// Truck ↔ vehicle matching, in order: trucks.verizon_vehicle_id == VehicleNumber,
// then VIN, then name (against Reveal's Name or VehicleNumber, including the
// "BT001 - HINO Leon" prefix pattern). When a truck matches by VIN/name its
// verizon_vehicle_id is backfilled for next time. If the fleet list comes back
// empty (account not fully provisioned for the API), we still probe the
// per-vehicle endpoints using each truck's code.
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

async function vzGet(path, token) {
  const r = await fetch(`${BASE}${path}`, {
    headers: {
      Authorization: `Atmosphere atmosphere_app_id=${APP_ID}, Bearer ${token}`,
      Accept: "application/json",
    },
  });
  if (r.status === 404) return null; // e.g. vehicle unknown / no reported location yet
  if (r.status === 401 || r.status === 403) throw new Error("Verizon rechazó el App ID o el token (¿la app está aprobada en el Developer Portal?).");
  if (!r.ok) throw new Error(`Verizon ${path}: HTTP ${r.status}`);
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch { return null; }
}

const norm = (s) => (s || "").toString().trim().toLowerCase().replace(/\s+/g, " ");

// Reveal timestamps come as UTC but often without the trailing "Z".
function toIso(u) {
  if (!u) return new Date().toISOString();
  const s = u.toString();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : s + "Z");
  return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
}

function fmtAddress(a) {
  if (!a) return null;
  return [a.AddressLine1, a.Locality, a.AdministrativeArea].filter(Boolean).join(", ") || null;
}

// moving / stopped for the live map (idle counts as stopped, we only have 2 states).
function toStatus(displayState, speed) {
  const ds = norm(displayState);
  if (ds) {
    if (ds.includes("mov") || ds.includes("driv") || ds.includes("tow")) return "moving";
    return "stopped";
  }
  const sp = Number(speed);
  if (!isNaN(sp)) return sp > 5 ? "moving" : "stopped";
  return "unknown";
}

// Fetch location + status for a Reveal vehicle number and update the truck row.
// Returns "synced" | "no-gps" | an error string.
async function syncTruck(truck, vehicleNumber, token) {
  const num = encodeURIComponent(vehicleNumber);
  const [loc, st] = await Promise.all([
    vzGet(`/rad/v1/vehicles/${num}/location`, token),
    vzGet(`/rad/v1/vehicles/${num}/status`, token).catch(() => null),
  ]);
  if (!loc || loc.Latitude == null || loc.Longitude == null) return "no-gps";
  const payload = {
    last_lat: Number(loc.Latitude),
    last_lng: Number(loc.Longitude),
    last_location: fmtAddress(loc.Address) || fmtAddress(st?.Address) || null,
    last_location_at: toIso(loc.UpdateUTC || st?.UpdateUTC),
    last_status: toStatus(st?.DisplayState, st?.Speed ?? loc.Speed),
  };
  if (!truck.verizon_vehicle_id) payload.verizon_vehicle_id = vehicleNumber?.toString() || null;
  const { error } = await admin.from("trucks").update(payload).eq("id", truck.id);
  if (error) return `${truck.name}: ${error.message}`;
  return "synced";
}

export default async function handler(req, res) {
  if (req.method !== "POST" && req.method !== "GET") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!APP_ID || !USER || !PASS) {
    res.status(200).json({ ok: false, notConfigured: true, error: "Faltan VERIZON_APP_ID / VERIZON_USERNAME / VERIZON_PASSWORD en Vercel." });
    return;
  }
  if (!admin) { res.status(500).json({ ok: false, error: "Falta SUPABASE_SERVICE_ROLE_KEY en el servidor." }); return; }

  try {
    const token = await getToken();

    const { data: trucks, error: tErr } = await admin
      .from("trucks")
      .select("id, name, vin, verizon_vehicle_id")
      .eq("active", true);
    if (tErr) throw tErr;

    // Full fleet as Reveal sees it.
    const raw = await vzGet("/cmv/v1/vehicles", token);
    const vehicles = Array.isArray(raw) ? raw : Array.isArray(raw?.Data) ? raw.Data : [];

    let synced = 0, noGps = 0;
    const errors = [], unmatched = [];

    if (vehicles.length === 0) {
      // Fleet list not exposed to the API (yet) — probe per-vehicle endpoints
      // with the codes we have in the CRM.
      const probed = [];
      for (const t of trucks || []) {
        const code = (t.verizon_vehicle_id || t.name || "").toString().trim();
        if (!code) { unmatched.push(t.name); continue; }
        probed.push(code);
        try {
          const r = await syncTruck(t, code, token);
          if (r === "synced") synced++;
          else if (r === "no-gps") unmatched.push(t.name);
          else errors.push(r);
        } catch (e) { errors.push(`${t.name}: ${e?.message || e}`); }
      }
      res.status(200).json({
        ok: true,
        synced,
        vehiclesInVerizon: 0,
        note: synced
          ? `La lista de flota vino vacía, pero ${synced} camión(es) respondieron probando por código.`
          : "Verizon devolvió la lista de vehículos vacía y ningún código de camión respondió — falta que Verizon habilite el acceso de la app a los datos de la cuenta.",
        probedCodes: probed,
        unmatched: unmatched.length ? unmatched : undefined,
        errors: errors.length ? errors : undefined,
      });
      return;
    }

    // Reveal names look like "BT001 - HINO Leon" or "BT002-ATW - 2013 HINO";
    // the CRM uses the short code ("BT001"), so we also index by that prefix.
    const prefix = (s) => norm(s).split(/[-·|]/)[0].trim();
    const byNumber = new Map(), byVin = new Map(), byName = new Map(), byPrefix = new Map();
    for (const v of vehicles) {
      if (v.VehicleNumber != null) {
        byNumber.set(norm(v.VehicleNumber), v);
        if (!byPrefix.has(prefix(v.VehicleNumber))) byPrefix.set(prefix(v.VehicleNumber), v);
      }
      if (v.VIN) byVin.set(norm(v.VIN), v);
      if (v.Name) {
        byName.set(norm(v.Name), v);
        if (!byPrefix.has(prefix(v.Name))) byPrefix.set(prefix(v.Name), v);
      }
    }

    const matches = [];
    for (const t of trucks || []) {
      const v =
        (t.verizon_vehicle_id && (byNumber.get(norm(t.verizon_vehicle_id)) || byName.get(norm(t.verizon_vehicle_id)))) ||
        (t.vin && byVin.get(norm(t.vin))) ||
        byName.get(norm(t.name)) ||
        byNumber.get(norm(t.name)) ||
        byPrefix.get(prefix(t.name));
      if (v) matches.push({ truck: t, vehicle: v });
      else unmatched.push(t.name);
    }

    for (const { truck, vehicle } of matches) {
      try {
        const r = await syncTruck(truck, vehicle.VehicleNumber, token);
        if (r === "synced") synced++;
        else if (r === "no-gps") noGps++;
        else errors.push(r);
      } catch (e) {
        errors.push(`${truck.name}: ${e?.message || e}`);
      }
    }

    res.status(200).json({
      ok: true,
      synced,
      matched: matches.length,
      noGps,
      vehiclesInVerizon: vehicles.length,
      // Names/numbers as Reveal reports them, to help link trucks that didn't match.
      verizonVehicles: vehicles.slice(0, 25).map(v => ({ number: v.VehicleNumber, name: v.Name, vin: v.VIN })),
      unmatched: unmatched.length ? unmatched : undefined,
      errors: errors.length ? errors : undefined,
    });
  } catch (e) {
    res.status(502).json({ ok: false, error: e?.message || "Error al sincronizar con Verizon." });
  }
}
