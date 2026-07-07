// Vercel serverless function: geocode a free-text address to lat/lng using the
// OpenStreetMap Nominatim service (no API key). Kept server-side to set a proper
// User-Agent (Nominatim policy) and avoid browser CORS. Used by the live-load map
// to place a truck's manual / last-known position.
// Requires a valid Supabase session so the deployment can't be used as an open
// geocoding relay (which would burn Nominatim's rate limit under our identity).
import { requireUser, rateLimitOk } from "../lib/auth.mjs";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (!rateLimitOk(res, `geocode:${user.id}`, 120, 60 * 1000)) return;
  const q = (req.query?.q || "").toString().trim().slice(0, 300);
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
