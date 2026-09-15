// Vercel serverless function: map data for the live-load view.
//
// Two features share one function because the Hobby plan caps the project at 12
// serverless functions and api/ is already at the limit (same reason
// api/agent-hub.mjs folds several agent features together).
//
//   GET /api/geocode?q=<address>          → address → lat/lng via OpenStreetMap
//                                           Nominatim (no key, no auth).
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

export default async function handler(req, res) {
  const action = (req.query?.fleet || "").toString().trim();
  if (action === "webhook") {
    if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
    // vercel.json pins the provider on each public URL; Verizon's predates the
    // parameter and its rewrite does not send one.
    return gpsWebhook(req, res, (req.query?.provider || "verizon").toString().trim().toLowerCase());
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
