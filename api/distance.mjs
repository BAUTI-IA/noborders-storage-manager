// Vercel serverless function: real ROUTED driving miles between US ZIP codes,
// for the Job Decision Calculator. Straight-line distance is useless here — a
// 5% miles error is enough to flip the traffic light.
//
// Provider chain, cheapest first (the operation pays nothing today):
//   1. Google Distance Matrix — only if GOOGLE_MAPS_API_KEY is set. Takes ZIPs
//      directly, one call, best US routing. Opt-in, never required.
//   2. Nominatim (ZIP → lat/lng) + OSRM (routing) — both keyless and free, and
//      Nominatim is already how api/geocode.mjs works.
//
// The key, when there is one, stays server-side: the client only ever sees miles.
//
// Every leg is cached forever in public.zip_distances — routes do not change,
// and each uncached request costs either money or somebody's free quota. In
// practice the operation will only ever see a few hundred distinct ZIP pairs.
//
// GET /api/distance?origin=33125&dest=30301&base=33166
//   → { loadedMiles, deadheadMiles, totalMiles, legs: [...], provider, cached }
import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin =
  SUPABASE_URL && SERVICE_KEY
    ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
    : null;

const METERS_TO_MILES = 0.000621371;
const UA = "NoBordersMovingCRM/1.0 (job decision calculator)";

// Warm-lambda memo, so a burst of recalculations never re-queries anything.
const memoPair = new Map(); // "33125>30301" → miles
const memoGeo = new Map();  // "33125" → { lat, lng }

const normZip = (z) => (z || "").toString().trim().slice(0, 5);
const isZip = (z) => /^\d{5}$/.test(z);
const round1 = (n) => Math.round(n * 10) / 10;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Cache ────────────────────────────────────────────────────────────────────

async function cacheGet(from, to) {
  const k = `${from}>${to}`;
  if (memoPair.has(k)) return memoPair.get(k);
  if (!admin) return null;
  const { data } = await admin
    .from("zip_distances")
    .select("miles")
    .eq("origin_zip", from)
    .eq("dest_zip", to)
    .maybeSingle();
  if (data && data.miles != null) {
    memoPair.set(k, Number(data.miles));
    return Number(data.miles);
  }
  return null;
}

async function cachePut(from, to, miles, provider) {
  memoPair.set(`${from}>${to}`, miles);
  if (!admin) return;
  // Never let a cache write break the response — the miles are already computed.
  try {
    await admin
      .from("zip_distances")
      .upsert({ origin_zip: from, dest_zip: to, miles, provider }, { onConflict: "origin_zip,dest_zip" });
  } catch {
    /* ignore */
  }
}

// ── Provider 1: Google Distance Matrix (only when a key is configured) ───────

async function googleMiles(from, to, key) {
  const url =
    "https://maps.googleapis.com/maps/api/distancematrix/json" +
    `?origins=${from},US&destinations=${to},US&units=imperial&mode=driving&key=${key}`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`Google Distance Matrix responded ${r.status}`);
  const j = await r.json();
  if (j.status !== "OK") throw new Error(`Google Distance Matrix: ${j.error_message || j.status}`);
  const el = j.rows?.[0]?.elements?.[0];
  if (!el || el.status !== "OK") throw new Error(`No driving route between ${from} and ${to}`);
  return el.distance.value * METERS_TO_MILES;
}

// ── Provider 2: Nominatim + OSRM (keyless) ───────────────────────────────────

async function geocodeZip(zip) {
  if (memoGeo.has(zip)) return memoGeo.get(zip);

  if (admin) {
    const { data } = await admin.from("zip_geo").select("lat,lng").eq("zip", zip).maybeSingle();
    if (data) {
      const hit = { lat: Number(data.lat), lng: Number(data.lng) };
      memoGeo.set(zip, hit);
      return hit;
    }
  }

  const url = `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us&postalcode=${encodeURIComponent(zip)}`;
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Geocoder responded ${r.status} for ZIP ${zip}`);
  const data = await r.json();
  if (!Array.isArray(data) || !data.length) throw new Error(`ZIP ${zip} not found`);

  const hit = { lat: Number(data[0].lat), lng: Number(data[0].lon) };
  memoGeo.set(zip, hit);
  if (admin) {
    try {
      await admin.from("zip_geo").upsert({ zip, lat: hit.lat, lng: hit.lng }, { onConflict: "zip" });
    } catch {
      /* ignore */
    }
  }
  return hit;
}

async function osrmMiles(from, to) {
  const a = await geocodeZip(from);
  // Nominatim's usage policy caps us at one request per second.
  await sleep(1100);
  const b = await geocodeZip(to);

  const url = `https://router.project-osrm.org/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=false&alternatives=false`;
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`Router responded ${r.status}`);
  const j = await r.json();
  if (j.code !== "Ok" || !j.routes?.length) throw new Error(`No driving route between ${from} and ${to}`);
  return j.routes[0].distance * METERS_TO_MILES;
}

// ── One leg, cache-first ─────────────────────────────────────────────────────

async function legMiles(from, to, state) {
  if (from === to) return 0;

  const cached = await cacheGet(from, to);
  if (cached != null) {
    state.cached = state.cached && true;
    return cached;
  }
  state.cached = false;

  const key = process.env.GOOGLE_MAPS_API_KEY;
  const miles = key ? await googleMiles(from, to, key) : await osrmMiles(from, to);
  const provider = key ? "google" : "osrm";
  state.provider = provider;

  const rounded = round1(miles);
  await cachePut(from, to, rounded, provider);
  return rounded;
}

// ── Handler ──────────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  if (req.method !== "GET") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }

  // Unlike api/geocode.mjs this endpoint is gated: it burns a free-tier quota
  // (or real money once GOOGLE_MAPS_API_KEY exists) and writes to the DB with
  // the service role. Only signed-in CRM users get to spend that.
  if (admin) {
    const token = (req.headers?.authorization || "").replace(/^Bearer\s+/i, "");
    const { data, error } = token ? await admin.auth.getUser(token) : { data: null, error: true };
    if (error || !data?.user) {
      res.status(401).json({ error: "Not authorized." });
      return;
    }
  }

  const origin = normZip(req.query?.origin);
  const dest = normZip(req.query?.dest);
  const base = normZip(req.query?.base);

  if (!isZip(origin) || !isZip(dest)) {
    res.status(400).json({ error: "origin and dest must both be 5-digit ZIP codes." });
    return;
  }
  if (base && !isZip(base)) {
    res.status(400).json({ error: "base must be a 5-digit ZIP code." });
    return;
  }

  const state = { cached: true, provider: process.env.GOOGLE_MAPS_API_KEY ? "google" : "osrm" };

  try {
    const loadedMiles = await legMiles(origin, dest, state);

    // Without a base ZIP there is no deadhead to compute. Say so rather than
    // silently returning a total that pretends the truck teleports home.
    let deadheadMiles = 0;
    let deadheadKnown = false;
    if (base) {
      const out = await legMiles(base, origin, state);
      const back = await legMiles(dest, base, state);
      deadheadMiles = round1(out + back);
      deadheadKnown = true;
    }

    res.status(200).json({
      loadedMiles,
      deadheadMiles,
      totalMiles: round1(loadedMiles + deadheadMiles),
      deadheadKnown,
      provider: state.provider,
      cached: state.cached,
    });
  } catch (e) {
    // Never invent a number. The UI falls back to manual miles entry.
    res.status(502).json({ error: e?.message || "Could not compute the route." });
  }
}
