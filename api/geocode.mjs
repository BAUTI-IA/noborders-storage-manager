// Vercel serverless function: map data for the live-load view.
//
// Two features share one function because the Hobby plan caps the project at 12
// serverless functions and api/ is already at the limit (same reason
// api/agent-hub.mjs folds several agent features together).
//
//   GET /api/geocode?q=<address>          → address → lat/lng via OpenStreetMap
//                                           Nominatim (no key, no auth).
//   GET /api/geocode?fleet=status         → whether Verizon Connect is wired up.
//   GET /api/geocode?fleet=sync           → pull live GPS from Verizon Connect
//                                           Reveal into public.trucks.
//   GET /api/geocode?fleet=vehicles       → Reveal's vehicle roster, to fill in
//                                           trucks.verizon_vehicle_id.
//   GET /api/geocode?fleet=probe&vehicle= → raw Reveal payload for one vehicle,
//                                           to confirm field names.
//   POST /api/verizon-gps                 → Reveal's GPS webhook, pushing positions
//                                           instead of us polling. Rewritten to
//                                           ?fleet=webhook in vercel.json so it gets
//                                           a clean public URL without costing one
//                                           of the 12 functions.
//
// Every fleet=* action except `status` needs the caller's Supabase JWT, because
// the sync writes to trucks through the service role.
import { timingSafeEqual } from "node:crypto";
import { admin } from "../lib/clients.mjs";
import {
  verizonConfigured, syncTruckLocations, fetchVehicles, fetchVehicleLocation,
  mapLocation, normalizeVehicles, resolvedPaths, applyGpsEvents, SYNC_MIN_INTERVAL_MS,
} from "../lib/verizon.mjs";

// Best-effort throttle: warm lambdas share it, cold ones start fresh, and the
// map throttles on its side too. Belt and braces against Verizon's 3–5 min floor.
let lastSyncAt = 0;

async function requireUser(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token || !admin) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  const { data: { user } = {}, error } = await admin.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: "unauthorized" });
    return null;
  }
  return user;
}

// Reveal signs nothing: it authenticates with the Basic credentials given to it
// when the endpoint is submitted in Reveal. Without a configured pair the
// endpoint refuses everything rather than accepting anonymous truck positions.
function webhookAuthOk(req) {
  const user = process.env.VERIZON_WEBHOOK_USER;
  const pass = process.env.VERIZON_WEBHOOK_PASSWORD;
  if (!user || !pass) return false;
  const got = Buffer.from(String(req.headers.authorization || ""));
  const want = Buffer.from("Basic " + Buffer.from(`${user}:${pass}`).toString("base64"));
  return got.length === want.length && timingSafeEqual(got, want);
}

async function gpsWebhook(req, res) {
  if (!webhookAuthOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) { res.status(400).json({ error: "empty or unparseable body" }); return; }
  try {
    const result = await applyGpsEvents(body);
    // The payload shape is not documented publicly, so a delivery that matched
    // nothing gets logged in full — that log is how we learn the real schema.
    if (result.applied === 0) {
      console.log("verizon gps webhook: nothing applied", JSON.stringify(body).slice(0, 4000));
    }
    res.status(200).json(result);
  } catch (e) {
    console.error("verizon gps webhook:", e);
    // 500, not 200: a transient failure should make Reveal retry the delivery.
    res.status(500).json({ error: "failed" });
  }
}

async function fleet(req, res, action) {
  if (action === "status") {
    res.status(200).json({ configured: verizonConfigured() });
    return;
  }
  if (!(await requireUser(req, res))) return;
  if (!verizonConfigured()) {
    res.status(503).json({ error: "Verizon Connect is not configured on the server." });
    return;
  }

  try {
    if (action === "sync") {
      const since = Date.now() - lastSyncAt;
      if (since < SYNC_MIN_INTERVAL_MS) {
        res.status(200).json({ throttled: true, retryInMs: SYNC_MIN_INTERVAL_MS - since });
        return;
      }
      lastSyncAt = Date.now();
      res.status(200).json(await syncTruckLocations());
      return;
    }
    if (action === "vehicles") {
      const raw = await fetchVehicles();
      // Normalised here so the browser never has to guess at Reveal's shapes.
      res.status(200).json({ vehicles: normalizeVehicles(raw) });
      return;
    }
    if (action === "probe") {
      const vehicle = (req.query?.vehicle || "").toString().trim();
      if (!vehicle) { res.status(400).json({ error: "Falta el vehicle number." }); return; }
      const raw = await fetchVehicleLocation(vehicle);
      res.status(200).json({ raw, mapped: mapLocation(raw), endpoints: resolvedPaths() });
      return;
    }
    res.status(400).json({ error: `Unknown fleet action: ${action}` });
  } catch (e) {
    console.error("geocode fleet:", e);
    res.status(502).json({ error: e?.message || "Verizon Connect request failed." });
  }
}

export default async function handler(req, res) {
  const action = (req.query?.fleet || "").toString().trim();
  if (action === "webhook") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    return gpsWebhook(req, res);
  }
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (action) return fleet(req, res, action);

  const q = (req.query?.q || "").toString().trim();
  if (!q) {
    res.status(400).json({ error: "Falta la dirección (q)." });
    return;
  }
  try {
    const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us,ca&q=" + encodeURIComponent(q);
    const r = await fetch(url, {
      headers: {
        // Nominatim requires an identifying User-Agent.
        "User-Agent": "NoBordersMovingCRM/1.0 (live-load map geocoding)",
        "Accept": "application/json",
      },
    });
    if (!r.ok) {
      res.status(502).json({ error: `Geocoder respondió ${r.status}` });
      return;
    }
    const data = await r.json();
    if (!Array.isArray(data) || data.length === 0) {
      res.status(404).json({ error: "No se encontró esa dirección." });
      return;
    }
    const hit = data[0];
    res.status(200).json({
      lat: Number(hit.lat),
      lng: Number(hit.lon),
      label: hit.display_name || q,
    });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error al geocodificar." });
  }
}
