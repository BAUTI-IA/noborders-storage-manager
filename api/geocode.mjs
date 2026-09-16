// Vercel serverless function: map data for the live-load view.
//
// Two features share one function because the Hobby plan caps the project at 12
// serverless functions and api/ is already at the limit (same reason
// api/agent-hub.mjs folds several agent features together).
//
//   GET /api/geocode?q=<address>          → address → lat/lng via OpenStreetMap
//                                           Nominatim (no key, no auth).
//   POST /api/geocode?geo=batch           → many addresses at once, served from
//                                           the public.geo_cache table, for the
//                                           live map's job pins. Returns what it
//                                           could not resolve in `pending`.
//   GET /api/geocode?fleet=status         → which ELD providers are wired up.
//   GET /api/geocode?fleet=sync           → pull live GPS from every configured
//                                           provider into public.trucks.
//   GET /api/geocode?fleet=vehicles       → the provider's vehicle roster, to fill
//                                           in trucks.verizon_vehicle_id /
//                                           trucks.motive_vehicle_id.
//   GET /api/geocode?fleet=probe&vehicle= → raw provider payload for one vehicle,
//                                           to confirm field names.
//   GET /api/geocode?fleet=hours&from=&to= → pull ELD hours into driver_hos_days.
//   GET /api/geocode?fleet=mapkey         → browser key for the Google basemap.
//   GET /api/geocode?fleet=backfill&days= → pull Reveal's GPS history (up to 30
//                                           days) into truck_pings.
//   GET /api/geocode?fleet=activity&days= → truck_pings rolled up per truck per
//                                           day. Aggregated here because a month
//                                           of fixes is ~80k rows: PostgREST caps
//                                           a response at 1000, so a browser that
//                                           asks for them directly silently gets
//                                           one truck's first morning and reports
//                                           that as the month.
//   POST /api/verizon-gps                 → Reveal's GPS webhook, pushing positions
//                                           instead of us polling. Rewritten to
//                                           ?fleet=webhook in vercel.json so it gets
//                                           a clean public URL without costing one
//                                           of the 12 functions.
//   POST /api/motive-gps                  → the same, for Motive.
//
// The CRM talks to two ELDs, and a fleet can be split across both: a truck is on
// whichever provider its link field names. Every action below takes
// `provider=verizon|motive`; the ones that write (sync, hours, backfill) default
// to running BOTH, because each only ever touches the trucks linked to it, so
// running both is the same work plus a no-op.
//
// Every fleet=* action except `status` needs the caller's Supabase JWT, because
// the sync writes to trucks through the service role.
// A month of history for one truck is a real round trip to Verizon plus a bulk
// write; the default serverless ceiling is not enough for it.
export const maxDuration = 60;

import { timingSafeEqual } from "node:crypto";
import { admin } from "../lib/clients.mjs";
import { truckDays } from "../src/reportsData.js";
import * as verizon from "../lib/verizon.mjs";
import * as motive from "../lib/motive.mjs";
import { SYNC_MIN_INTERVAL_MS } from "../lib/verizon.mjs";

// One table so an action never has to branch on the provider name by hand.
const PROVIDERS = {
  verizon: {
    configured: verizon.verizonConfigured,
    sync: verizon.syncTruckLocations,
    hours: verizon.syncDriverHours,
    backfill: verizon.backfillHistory,
    diagnose: verizon.diagnose,
    vehicles: async () => verizon.normalizeVehicles(await verizon.fetchVehicles()),
    drivers: async () => verizon.normalizeDrivers(await verizon.fetchDriverRoster()),
    probe: async (v) => {
      const raw = await verizon.fetchVehicleLocation(v);
      return { raw, mapped: verizon.mapLocation(raw), endpoints: verizon.resolvedPaths() };
    },
    webhook: verizon.applyGpsEvents,
  },
  motive: {
    configured: motive.motiveConfigured,
    sync: motive.syncTruckLocations,
    hours: motive.syncDriverHours,
    backfill: motive.backfillHistory,
    diagnose: motive.diagnose,
    vehicles: async () => motive.normalizeVehicles(await motive.fetchVehicles()),
    drivers: async () => motive.normalizeDrivers(await motive.fetchDriverRoster()),
    probe: async (v) => {
      const raw = await motive.fetchVehicleLocation(v);
      return { raw, mapped: motive.mapLocation(raw), endpoints: motive.resolvedPaths() };
    },
    webhook: motive.applyGpsEvents,
  },
};

const configuredProviders = () => Object.keys(PROVIDERS).filter((k) => PROVIDERS[k].configured());

// `provider=` names one; without it, every provider that has credentials. An
// unknown name is an error rather than a silent fall-back to the wrong ELD.
function pickProviders(req) {
  const want = (req.query?.provider || "").toString().trim().toLowerCase();
  if (!want) return { names: configuredProviders() };
  if (!PROVIDERS[want]) return { error: `Unknown provider: ${want}` };
  if (!PROVIDERS[want].configured()) return { error: `${want} is not configured on the server.` };
  return { names: [want] };
}

// Runs one action across providers and folds the results into a single object
// with the same keys the single-provider version used to return, so the browser
// can keep reading `updated` / `positions` / `days` without knowing about any of
// this. Per-provider detail stays under `providers`.
async function runAll(names, fn) {
  const NUMS = ["checked", "updated", "skipped", "pings", "days", "drivers", "linked", "trucks", "positions"];
  const out = { providers: {}, errors: [] };
  for (const name of names) {
    let one;
    try {
      one = await fn(PROVIDERS[name], name);
    } catch (e) {
      // One provider being down must not take the other's results with it.
      one = { failed: e?.message || String(e), errors: [{ provider: name, error: e?.message || String(e) }] };
    }
    out.providers[name] = one;
    for (const k of NUMS) if (typeof one[k] === "number") out[k] = (out[k] ?? 0) + one[k];
    for (const e of one.errors || []) out.errors.push({ provider: name, ...e });
  }
  return out;
}

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

// Neither provider signs anything we can verify here, so both authenticate with
// a credential we hand them when the endpoint is registered. Without one
// configured the endpoint refuses everything rather than accepting anonymous
// truck positions — there is no "open while we test it" mode.
const secretEq = (got, want) => {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(want));
  return a.length === b.length && timingSafeEqual(a, b);
};

// Reveal authenticates with the Basic credentials given to it when the endpoint
// is submitted in Reveal.
export function verizonWebhookAuthOk(req) {
  const user = process.env.VERIZON_WEBHOOK_USER;
  const pass = process.env.VERIZON_WEBHOOK_PASSWORD;
  if (!user || !pass) return false;
  return secretEq(req.headers.authorization, "Basic " + Buffer.from(`${user}:${pass}`).toString("base64"));
}

// Motive's webhook form does not always allow a custom header, so the same
// secret is accepted three ways: a bearer token, an X-Webhook-Secret header, or
// ?token= on the URL. All three are the one secret, compared in constant time.
export function motiveWebhookAuthOk(req) {
  const secret = process.env.MOTIVE_WEBHOOK_SECRET;
  if (!secret) return false;
  return secretEq(req.headers.authorization, `Bearer ${secret}`)
    || secretEq(req.headers["x-webhook-secret"], secret)
    || secretEq(req.query?.token, secret);
}

const WEBHOOK_AUTH = { verizon: verizonWebhookAuthOk, motive: motiveWebhookAuthOk };

async function gpsWebhook(req, res, provider) {
  if (!PROVIDERS[provider]) { res.status(400).json({ error: "unknown provider" }); return; }
  if (!WEBHOOK_AUTH[provider](req)) { res.status(401).json({ error: "unauthorized" }); return; }
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  if (!body) { res.status(400).json({ error: "empty or unparseable body" }); return; }
  try {
    const result = await PROVIDERS[provider].webhook(body);
    // Neither payload shape is documented publicly, so a delivery that matched
    // nothing gets logged in full — that log is how we learn the real schema.
    if (result.applied === 0) {
      console.log(`${provider} gps webhook: nothing applied`, JSON.stringify(body).slice(0, 4000));
    }
    res.status(200).json(result);
  } catch (e) {
    console.error(`${provider} gps webhook:`, e);
    // 500, not 200: a transient failure should make the provider retry.
    res.status(500).json({ error: "failed" });
  }
}

async function fleet(req, res, action) {
  if (action === "status") {
    const on = configuredProviders();
    // `configured` keeps its old meaning for any client that only asked whether
    // live tracking works at all; `providers` says which ones.
    res.status(200).json({
      configured: on.length > 0,
      providers: on,
      verizon: on.includes("verizon"),
      motive: on.includes("motive"),
    });
    return;
  }
  if (!(await requireUser(req, res))) return;

  if (action === "mapkey") {
    // Served to signed-in users only, never baked into the bundle: a VITE_ var
    // would ship the key in a public asset for anyone to lift. Restrict it by
    // HTTP referrer in Google Cloud as well — this is one layer, not the only one.
    res.status(200).json({ key: process.env.GOOGLE_MAPS_BROWSER_KEY || null });
    return;
  }

  if (action === "activity") {
    // Reads truck_pings, which both providers write into — no provider here.
    const days = Math.min(90, Math.max(1, parseInt(req.query?.days, 10) || 30));
    const from = new Date(Date.now() - days * 864e5).toISOString();
    const PAGE = 1000;
    const pings = [];
    for (let offset = 0; ; offset += PAGE) {
      const { data, error } = await admin.from("truck_pings")
        .select("truck_id, lat, lng, status, at")
        .gte("at", from).order("at").range(offset, offset + PAGE - 1);
      if (error) { res.status(500).json({ error: error.message }); return; }
      pings.push(...(data || []));
      if (!data || data.length < PAGE) break;
      // A runaway page loop would burn the whole function budget silently.
      if (pings.length >= 300000) break;
    }
    res.status(200).json({ days: truckDays(pings), pings: pings.length });
    return;
  }

  const { names, error: pickErr } = pickProviders(req);
  if (pickErr) { res.status(400).json({ error: pickErr }); return; }
  if (!names.length) {
    res.status(503).json({ error: "No ELD provider is configured on the server." });
    return;
  }
  // The roster and probe actions read one provider's catalogue, so they need to
  // be told which; everything else runs across all of them.
  const single = names.length === 1 ? names[0] : null;

  try {
    if (action === "sync") {
      const since = Date.now() - lastSyncAt;
      if (since < SYNC_MIN_INTERVAL_MS) {
        res.status(200).json({ throttled: true, retryInMs: SYNC_MIN_INTERVAL_MS - since });
        return;
      }
      lastSyncAt = Date.now();
      res.status(200).json(await runAll(names, (p) => p.sync()));
      return;
    }
    if (action === "diagnose") {
      // Kept as a flat list of checks, each tagged with the provider it came
      // from, because the banner that renders it just walks the array.
      const out = await runAll(names, async (p, name) =>
        ({ checks: (await p.diagnose()).map((c) => ({ ...c, provider: name })) }));
      res.status(200).json({
        checks: names.flatMap((n) => out.providers[n]?.checks
          || [{ key: "config", ok: false, provider: n, detail: out.providers[n]?.failed }]),
      });
      return;
    }
    if (action === "backfill") {
      const days = Math.min(30, Math.max(1, parseInt(req.query?.days, 10) || 30));
      // One truck per call: the whole fleet in a single request outlives the
      // function. The client walks the list and can show progress. A truck only
      // belongs to one provider, so the other one no-ops on it.
      const truckId = req.query?.truck ? parseInt(req.query.truck, 10) : null;
      res.status(200).json(await runAll(names, (p) => p.backfill({ days, truckId })));
      return;
    }
    if (action === "hours") {
      const iso = (x) => (/^\d{4}-\d{2}-\d{2}$/.test(String(x || "")) ? String(x) : null);
      // Default window: the last week, which is what the payroll comparison reads.
      const to = iso(req.query?.to) || new Date().toISOString().slice(0, 10);
      const from = iso(req.query?.from) || new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
      res.status(200).json(await runAll(names, (p) => p.hours({ from, to })));
      return;
    }
    if (action === "drivers" || action === "vehicles" || action === "probe") {
      if (!single) {
        res.status(400).json({ error: `fleet=${action} needs provider=verizon or provider=motive.` });
        return;
      }
      const p = PROVIDERS[single];
      if (action === "drivers") { res.status(200).json({ provider: single, drivers: await p.drivers() }); return; }
      // Normalised here so the browser never has to guess at either shape.
      if (action === "vehicles") { res.status(200).json({ provider: single, vehicles: await p.vehicles() }); return; }
      const vehicle = (req.query?.vehicle || "").toString().trim();
      if (!vehicle) { res.status(400).json({ error: "Falta el vehicle number." }); return; }
      res.status(200).json({ provider: single, ...(await p.probe(vehicle)) });
      return;
    }
    res.status(400).json({ error: `Unknown fleet action: ${action}` });
  } catch (e) {
    console.error("geocode fleet:", e);
    res.status(502).json({ error: e?.message || "The ELD request failed." });
  }
}

// ── Batch geocoding for the live map's job pins ──────────────────────────────
// The map asks for every scheduled job's pickup and delivery in one go. Doing
// that through ?q= one address at a time would be hopeless: Nominatim's usage
// policy allows one request per second, so a hundred jobs is a three-minute
// wait — every single time somebody opens the tab.
//
// So this reads what public.geo_cache already knows in ONE bulk query and only
// pays the one-per-second price for genuinely new addresses. That spend is
// capped per call and whatever is left comes back in `pending`, so the browser
// asks again and the map fills in progressively instead of hanging (or timing
// out) on a cold cache.

const GEO_UA = "NoBordersMovingCRM/1.0 (live-load map geocoding)";
// Nominatim's usage policy caps us at one request per second. Google's does not,
// so when a key is configured the whole cold-cache problem mostly goes away.
const GEO_THROTTLE_MS = 1100;
const googleKey = () => process.env.GOOGLE_MAPS_API_KEY || "";
// How many NEW addresses one call may look up. On Nominatim that is ~28s of
// sleeping, comfortably inside the maxDuration declared at the top; on Google
// there is no sleep, so the budget can be far larger.
const maxGeoLookups = () => (googleKey() ? 120 : 25);
// One bad address must not eat the whole budget walking its own fallback ladder,
// so a stop gets at most this many attempts before the rest of its candidates
// wait for another call.
const MAX_TRIES_PER_STOP = 2;
// A confirmed miss is worth re-trying eventually — the address may have been
// fixed since — but nowhere near every time the map opens.
const GEO_MISS_TTL_MS = 30 * 24 * 60 * 60 * 1000;
// PostgREST builds `in.(...)` into the URL, so ask in chunks it can carry.
const GEO_READ_CHUNK = 200;

const normQ = (q) => String(q || "").trim().toLowerCase().replace(/\s+/g, " ");
const geoSleep = (ms) => new Promise((r) => setTimeout(r, ms));

// When the map fills a cold cache it calls this repeatedly, so pacing only
// WITHIN a call would still let the first lookup of each call land on the heels
// of the last one of the previous. Warm lambdas share this timestamp — same
// best-effort trick as lastSyncAt above.
let lastGeoAt = 0;
async function geoPace() {
  const wait = GEO_THROTTLE_MS - (Date.now() - lastGeoAt);
  if (wait > 0) await geoSleep(wait);
  lastGeoAt = Date.now();
}

// Resolves one query. Returns null when the geocoder looked and found nothing (a
// real miss, worth caching); THROWS when the request itself failed, so a network
// blip never gets written down as "this address does not exist".
async function geocodeOne(q) {
  const key = googleKey();
  if (key) {
    const url = "https://maps.googleapis.com/maps/api/geocode/json?address=" + encodeURIComponent(q)
      + "&components=country:US|country:CA&key=" + encodeURIComponent(key);
    const r = await fetch(url, { headers: { Accept: "application/json" } });
    if (!r.ok) throw new Error(`Geocoder responded ${r.status}`);
    const d = await r.json();
    if (d.status === "ZERO_RESULTS") return null;
    // OVER_QUERY_LIMIT / REQUEST_DENIED are our problem, not the address's —
    // throw so they stay uncached and the caller retries.
    if (d.status !== "OK" || !d.results?.length) throw new Error(`Geocoder said ${d.status || "no status"}`);
    const hit = d.results[0];
    return { lat: Number(hit.geometry.location.lat), lng: Number(hit.geometry.location.lng), label: hit.formatted_address || q };
  }
  const url = "https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=us,ca&q=" + encodeURIComponent(q);
  const r = await fetch(url, { headers: { "User-Agent": GEO_UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`Geocoder responded ${r.status}`);
  const data = await r.json();
  if (!Array.isArray(data) || !data.length) return null;
  return { lat: Number(data[0].lat), lng: Number(data[0].lon), label: data[0].display_name || q };
}

async function geoBatch(req, res) {
  if (!(await requireUser(req, res))) return;
  if (!admin) { res.status(500).json({ error: "Geocoding cache unavailable (no service role configured)." }); return; }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch { body = null; } }
  const raw = Array.isArray(body?.stops) ? body.stops : null;
  if (!raw) { res.status(400).json({ error: "body must be { stops: [{ key, candidates }] }" }); return; }

  // Each stop carries its candidates most-specific-first (geoCandidates() in the
  // app): full address → city+state+zip → zip+state → city+state → state.
  const stops = [];
  const all = new Set();
  for (const s of raw.slice(0, 2000)) {
    const key = String(s?.key || "");
    const cands = (Array.isArray(s?.candidates) ? s.candidates : []).map(normQ).filter(Boolean);
    if (!key || !cands.length) continue;
    stops.push({ key, cands });
    for (const c of cands) all.add(c);
  }

  const known = new Map();   // normalised query → cache row
  const list = [...all];
  for (let i = 0; i < list.length; i += GEO_READ_CHUNK) {
    const { data, error } = await admin.from("geo_cache")
      .select("q,lat,lng,label,fetched_at").in("q", list.slice(i, i + GEO_READ_CHUNK));
    if (error) { res.status(500).json({ error: error.message }); return; }
    for (const r of (data || [])) known.set(r.q, r);
  }

  // A miss old enough to be worth another look counts as "not cached".
  const usable = (r) => r && (r.lat != null || Date.now() - new Date(r.fetched_at || 0).getTime() <= GEO_MISS_TTL_MS);

  const resolved = {};
  const pending = [];
  const budget = maxGeoLookups();
  const throttled = !googleKey();
  let spent = 0;

  for (const w of stops) {
    let out = null;      // stays null when every candidate is a confirmed miss
    let stalled = false; // ran out of budget, or the geocoder is failing
    let tries = 0;       // network attempts spent on THIS stop
    for (let i = 0; i < w.cands.length; i++) {
      const q = w.cands[i];
      const cached = known.get(q);
      if (usable(cached)) {
        if (cached.lat == null) continue;                       // known miss → try the next candidate
        out = { lat: Number(cached.lat), lng: Number(cached.lng), label: cached.label || "", approx: i > 0 };
        break;
      }
      // Out of global budget, or this one stop has had its fair share.
      if (spent >= budget || tries >= MAX_TRIES_PER_STOP) { stalled = true; break; }
      if (throttled) await geoPace();
      spent++; tries++;
      let hit;
      try {
        hit = await geocodeOne(q);
      } catch {
        // Transport/HTTP failure: leave it uncached and let the client retry.
        stalled = true;
        break;
      }
      const row = { q, lat: hit ? hit.lat : null, lng: hit ? hit.lng : null, label: hit ? hit.label : null, fetched_at: new Date().toISOString() };
      known.set(q, row);
      // Cached before the loop moves on, misses included, so the next call for
      // this address costs nothing.
      const { error } = await admin.from("geo_cache").upsert(row, { onConflict: "q" });
      if (error) console.error("geo_cache upsert:", error.message);
      if (hit) { out = { lat: hit.lat, lng: hit.lng, label: hit.label, approx: i > 0 }; break; }
    }
    if (out) resolved[w.key] = out;
    else if (stalled) pending.push(w.key);
    else resolved[w.key] = null;      // genuinely unlocatable — don't ask again
  }

  res.status(200).json({ resolved, pending, lookups: spent });
}

export default async function handler(req, res) {
  const action = (req.query?.fleet || "").toString().trim();
  if (action === "webhook") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    // vercel.json pins the provider on each public URL; Verizon's predates the
    // parameter and its rewrite does not send one.
    return gpsWebhook(req, res, (req.query?.provider || "verizon").toString().trim().toLowerCase());
  }
  // Ahead of the GET-only guard below: the batch geocoder POSTs its stop list,
  // which is far too big to hang off the query string.
  if ((req.query?.geo || "").toString().trim() === "batch") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    return geoBatch(req, res);
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
