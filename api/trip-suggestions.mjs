// Vercel serverless function: ask Claude to group available jobs into truck
// trips (and top-ups of trips still loading). The frontend sends a compact JSON
// snapshot of candidate jobs + free trucks + loading trips; Claude returns strict
// JSON suggestions which are validated and re-computed server-side before being
// shown to the dispatcher. Nothing is written to the database here.
//
// It also hosts the Pipeline's three read/price actions (lead_extract,
// lead_evaluate, lead_rank), because api/ sits at the Hobby plan's 12-function
// cap — same reason api/geocode.mjs multiplexes. A request with no `action`
// behaves exactly as before, so the existing dispatcher caller is untouched.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";
import {
  createLeadFromText, evaluateLead, rankLeadBatch, pipelineSettings, jobCalcSettings,
} from "../lib/leads.mjs";
import { evaluateJob, crewCostPerDay } from "../src/jobCalcData.js";

export const maxDuration = 300; // planning calls can run 1-2 min; Hobby + Fluid Compute allows up to 300s

const client = new Anthropic(); // ANTHROPIC_API_KEY from env
const admin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

const MAX_JOBS = 150;
const MAX_TRUCKS = 30;
const MAX_LOADING_TRIPS = 30;

// Structured-outputs schema: every object closed, every field required
// (constraints like minimum/maxLength are not supported).
const SUGGESTIONS_SCHEMA = {
  type: "object",
  properties: {
    new_trips: {
      type: "array",
      items: {
        type: "object",
        properties: {
          truck_id: { type: "integer" },
          job_keys: { type: "array", items: { type: "string" }, description: "Job keys in delivery stop order" },
          driver_id: { type: "integer", description: "Driver to send, from the provided list. 0 when none fits." },
          helpers: { type: "integer", description: "Helpers to send besides the driver, 1 or 2" },
          reasoning: { type: "string", description: "1-2 sentences for the dispatcher, in the requested output language" },
        },
        required: ["truck_id", "job_keys", "driver_id", "helpers", "reasoning"],
        additionalProperties: false,
      },
    },
    trip_additions: {
      type: "array",
      items: {
        type: "object",
        properties: {
          trip_id: { type: "integer" },
          job_keys: { type: "array", items: { type: "string" }, description: "Job keys to append, in delivery stop order" },
          reasoning: { type: "string", description: "1-2 sentences for the dispatcher, in the requested output language" },
        },
        required: ["trip_id", "job_keys", "reasoning"],
        additionalProperties: false,
      },
    },
    unassigned: {
      type: "array",
      items: {
        type: "object",
        properties: {
          job_key: { type: "string" },
          reason: { type: "string", description: "Short reason, in the requested output language" },
        },
        required: ["job_key", "reason"],
        additionalProperties: false,
      },
    },
    notes: { type: "string", description: "General remarks in the requested output language (or empty string)" },
  },
  required: ["new_trips", "trip_additions", "unassigned", "notes"],
  additionalProperties: false,
};

function buildPrompt({ today, jobs, trucks, loadingTrips, drivers, truncated, lang }) {
  return [
    "You are a dispatch planner for a US interstate moving company. Group the candidate jobs below into truck trips.",
    "",
    "Each job's \"origin\" field is its LOAD POINT — where the truck must physically pick the load up before delivering:",
    "- \"Customer pickup at: <address>\" — the load is still at the customer's own address.",
    "- \"Storage unit ... at: <address>\" — the load sits in a rented storage unit at that address.",
    "- \"Warehouse Indiana\" / \"Warehouse New Jersey\" — the load sits in one of the company's own warehouses.",
    "A trip must first collect every job at its load point and then run the delivery stops, so BOTH ends matter.",
    "",
    "Rules, in priority order:",
    "1. Each job goes on at most ONE suggestion (new trip or addition). Only use the truck ids, trip ids and job keys provided — never invent them.",
    "2. Capacity: a new trip's total volume_cf must fit the truck's capacity_cf; for an addition, current_cf plus the added jobs must fit the trip's capacity_cf. Target <= 90% occupancy, never exceed 100%.",
    "3. Group jobs whose deliveries are in the same or neighboring states, or along one plausible driving corridor. Reason from city/state/zip — no exact distances needed. For additions, the added jobs must be compatible with the trip's existing stops.",
    "4. Load points must also be compatible: prefer grouping jobs that load at the same warehouse / storage area or at pickups near each other or along the delivery corridor. Do NOT group jobs whose load points force a large detour (e.g. a pickup in Florida on a trip that otherwise loads in Indiana and delivers in New York). If a load point's location is unknown, you may still group the job by delivery but say so in the reasoning.",
    `5. Prioritize urgency: jobs with an older FADD (first available delivery date, relative to TODAY) should ship first.`,
    "6. Order job_keys as delivery stops in a sensible geographic sequence (for additions, they are appended after the existing stops).",
    "7. Prefer fewer, fuller trips over many half-empty ones, but never exceed capacity.",
    "8. Jobs that don't fit any good trip (no delivery address, oversized for every truck, geographic outlier by delivery OR by load point) go in \"unassigned\" with a short reason.",
    "9. A job with split:true is ONE portion of a larger job already divided across trucks (same job_number, its own volume_cf). Treat each portion as an independent load, but never put two portions that share a job_number on the SAME truck — the point of the split is to spread them across different trucks.",
    "10. WHERE THE TRUCK IS NOW matters. Each free truck carries `location` and `miles_to_first_pickup` when its GPS has reported. Prefer the truck already near the trip's load points; say so in the reasoning. A truck with no position is still usable — just do not claim it is close.",
    "11. Pick the CREW for each new trip: `driver_id` from the drivers list (0 if none is suitable) and `helpers` (1 normally, 2 for a big or stair-heavy load — a bigger crew costs more per day but finishes in fewer). Prefer a driver who is not already out and whose day rate suits the job's size. Never invent a driver id.",
    "",
    lang === "es"
      ? "Write \"reasoning\", \"reason\" and \"notes\" in Spanish, addressed to the dispatcher."
      : "Write \"reasoning\", \"reason\" and \"notes\" in English, addressed to the dispatcher.",
    truncated ? "Note: the candidate job list was truncated to the most urgent jobs; mention this in notes." : "",
    "",
    `TODAY: ${today}`,
    `FREE TRUCKS (available for new trips): ${JSON.stringify(trucks)}`,
    `LOADING TRIPS (accepting additions): ${JSON.stringify(loadingTrips)}`,
    drivers?.length ? `AVAILABLE DRIVERS: ${JSON.stringify(drivers)}` : "",
    `CANDIDATE JOBS: ${JSON.stringify(jobs)}`,
  ].filter(Boolean).join("\n");
}

// ── Trip economics, computed here and never asked of the model ───────────────
//
// The dispatcher's four missing questions — where is the truck, who goes, how
// many days, what does the trip leave — are arithmetic, so they are arithmetic
// here. Distances chain the stops through the zip_geo cache (straight line with
// a road factor); they are an estimate and the UI says so, but they come off
// real coordinates rather than the model's imagination.
const ROAD_FACTOR = 1.25;
const milesBetween = (a, b) => {
  const R = 3958.8, rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat), dLng = rad(b.lng - a.lng);
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
};

async function zipPoints(zips) {
  const want = [...new Set((zips || []).filter((z) => /^\d{5}$/.test(z)))];
  if (!want.length || !admin) return new Map();
  const { data } = await admin.from("zip_geo").select("zip, lat, lng").in("zip", want);
  return new Map((data || []).map((r) => [r.zip, { lat: Number(r.lat), lng: Number(r.lng) }]));
}

/** Chain a truck's position through its delivery stops. null when unmeasurable. */
function routeMiles(start, stopZips, pts) {
  const chain = [];
  if (start && Number.isFinite(start.lat) && Number.isFinite(start.lng)) chain.push(start);
  for (const z of stopZips) { const p = pts.get(z); if (p) chain.push(p); }
  if (chain.length < 2) return null;
  let m = 0;
  for (let i = 1; i < chain.length; i++) m += milesBetween(chain[i - 1], chain[i]);
  return Math.round(m * ROAD_FACTOR);
}

/**
 * Days out and the trip's contribution, from the same cost model the Job
 * Calculator uses. Returns nulls rather than guesses when miles are unknown.
 */
function tripEconomics({ totalCf, miles, revenue, helpers, driverRate, settings }) {
  if (!Number.isFinite(miles) || miles <= 0 || !(totalCf > 0)) return null;
  const job = {
    brokerPrice: revenue, cuFt: totalCf, originAccess: "direct", destAccess: "direct",
    longCarry: false, shuttle: false, trucks: 1, drivers: 1,
    helpers: Math.max(0, Math.round(helpers || 1)), extras: [],
  };
  const s = { ...settings };
  if (driverRate > 0) s.driverDayRate = driverRate;
  const r = evaluateJob(job, s, { loadedMiles: miles, deadheadMiles: 0 });
  return {
    truck_days: r.truckDays,
    hotel_nights: r.hotelNights,
    est_miles: Math.round(miles),
    revenue: Math.round(revenue),
    cost: Math.round(r.variableCost + r.absorbedFixed),
    contribution: Math.round(r.contributionMargin),
    per_truck_day: Math.round(r.contributionPerTruckDay),
    crew_day_rate: Math.round(crewCostPerDay(job, s)),
  };
}

// ── Pipeline actions ─────────────────────────────────────────────────────────
// All three only read and price; none of them creates a job. The heavy lifting
// (the closed extraction schema, the cost model, the containment rules) lives in
// lib/leads.mjs so the email webhook in api/agent-hub.mjs runs the same code.
async function pipelineAction(action, body, { res, lang, token, userId, appUrl }) {
  const tr = (en, es) => (lang === "es" ? es : en);
  try {
    if (action === "lead_extract") {
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!text) { res.status(400).json({ error: tr("Paste the broker's message first.", "Pegá primero el mensaje del broker.") }); return; }
      const lead = await createLeadFromText({ text, source: "manual", createdBy: userId || null });
      // Best effort: a lead with no cached route still lands on the board.
      let evaluation = null;
      try { const r = await evaluateLead(lead, { token, appUrl }); evaluation = r.evaluation || null; } catch { /* saved anyway */ }
      res.status(200).json({ lead, evaluation });
      return;
    }

    if (action === "lead_evaluate") {
      const id = Number(body.lead_id);
      if (!Number.isFinite(id)) { res.status(400).json({ error: tr("Missing lead.", "Falta el lead.") }); return; }
      const { data: lead, error } = await admin.from("job_leads").select("*").eq("id", id).is("deleted_at", null).maybeSingle();
      if (error || !lead) { res.status(404).json({ error: tr("Lead not found.", "No se encontró el lead.") }); return; }
      const r = await evaluateLead(lead, { token, appUrl });
      if (r.skipped === "incomplete") { res.status(400).json({ error: tr("Fill in both ZIPs, the volume and the price first.", "Completá primero los dos ZIPs, el volumen y el precio.") }); return; }
      if (r.skipped === "no_miles") { res.status(400).json({ error: tr("Could not measure the route between those ZIPs.", "No se pudo medir la ruta entre esos ZIPs.") }); return; }
      if (r.skipped) { res.status(500).json({ error: r.error?.message || tr("Could not price this lead.", "No se pudo evaluar este lead.") }); return; }
      res.status(200).json({ evaluation: r.evaluation, nearest: r.nearest || null });
      return;
    }

    if (action === "lead_rank") {
      const leads = Array.isArray(body.leads) ? body.leads : [];
      if (!leads.length) { res.status(200).json({ ranked: [], notes: tr("No priced leads to rank.", "No hay leads evaluados para ordenar.") }); return; }
      const out = await rankLeadBatch({ leads, trucksFree: Number(body.trucks_free) || 0, lang });
      res.status(200).json(out);
      return;
    }

    if (action === "pipeline_settings") {
      res.status(200).json({ settings: await pipelineSettings() });
      return;
    }

    res.status(400).json({ error: tr("Unknown action.", "Acción desconocida.") });
  } catch (e) {
    res.status(500).json({ error: e?.message || tr("Pipeline error.", "Error del pipeline.") });
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }

  // Require a valid logged-in user. Fails closed: with no service key there is
  // no way to verify the session, so the endpoint refuses instead of turning
  // into an open proxy on ANTHROPIC_API_KEY.
  if (!admin) { res.status(500).json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." }); return; }
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { data: { user } = {}, error: authErr } = token ? await admin.auth.getUser(token) : { data: {}, error: true };
  if (authErr || !user) { res.status(401).json({ error: "No autorizado." }); return; }

  // This deployment's own origin, for the /api/distance call a lead makes when
  // its route is not cached yet. On Vercel the host always routes back here.
  const host = String(req.headers["x-forwarded-host"] || req.headers.host || "").split(",")[0].trim();
  const appUrl = host ? `${String(req.headers["x-forwarded-proto"] || "https").split(",")[0].trim()}://${host}` : null;

  const body = req.body || {};
  const lang = body.lang === "es" ? "es" : "en"; // AI output + error language follows the user's display language
  const tr = (en, es) => (lang === "es" ? es : en);

  // Pipeline actions ride this function (12-function cap). No action = the
  // original trip-suggestion behaviour.
  if (body.action) { await pipelineAction(String(body.action), body, { res, lang, token, userId: user.id, appUrl }); return; }
  const today = typeof body.today === "string" && body.today ? body.today : new Date().toISOString().slice(0, 10);
  const rawJobs = Array.isArray(body.jobs) ? body.jobs : [];
  const rawTrucks = Array.isArray(body.trucks) ? body.trucks : [];
  const rawLoading = Array.isArray(body.loading_trips) ? body.loading_trips : [];

  // Sanitize to the exact fields the prompt needs (never trust extra payload).
  const jobs = rawJobs
    .filter((j) => j && typeof j.key === "string" && j.key)
    .slice(0, MAX_JOBS)
    .map((j) => ({
      key: j.key,
      job_number: String(j.job_number || ""),
      customer: String(j.customer || ""),
      volume_cf: Number(j.volume_cf) || 0,
      split: !!j.split,
      fadd: String(j.fadd || ""),
      status: String(j.status || ""),
      origin: String(j.origin || ""),
      delivery: String(j.delivery || ""),
      delivery_state: String(j.delivery_state || ""),
      delivery_zip: String(j.delivery_zip || "").trim().slice(0, 5),
      revenue: Number(j.revenue) || 0,
    }));
  const trucks = rawTrucks
    .filter((t) => t && Number.isFinite(Number(t.id)))
    .slice(0, MAX_TRUCKS)
    .map((t) => ({
      id: Number(t.id), name: String(t.name || ""), capacity_cf: Number(t.capacity_cf) || 0,
      // Where the truck is right now, straight off the ELD feed.
      location: String(t.location || ""),
      last_seen: String(t.last_seen || ""),
      lat: Number.isFinite(Number(t.lat)) ? Number(t.lat) : null,
      lng: Number.isFinite(Number(t.lng)) ? Number(t.lng) : null,
    }))
    .filter((t) => t.capacity_cf > 0);
  const drivers = (Array.isArray(body.drivers) ? body.drivers : [])
    .filter((d) => d && Number.isFinite(Number(d.id)))
    .slice(0, MAX_TRUCKS)
    .map((d) => ({
      id: Number(d.id), name: String(d.name || ""),
      day_rate: Number(d.day_rate) || 0,
      busy: !!d.busy,
      days_worked_30: Number(d.days_worked_30) || 0,
    }));
  const loadingTrips = rawLoading
    .filter((t) => t && Number.isFinite(Number(t.trip_id)))
    .slice(0, MAX_LOADING_TRIPS)
    .map((t) => ({
      trip_id: Number(t.trip_id),
      trip_number: String(t.trip_number || ""),
      truck_name: String(t.truck_name || ""),
      capacity_cf: Number(t.capacity_cf) || 0,
      current_cf: Number(t.current_cf) || 0,
      stops: Array.isArray(t.stops) ? t.stops.slice(0, 20).map(String) : [],
    }))
    .filter((t) => t.capacity_cf > 0);

  if (!jobs.length || (!trucks.length && !loadingTrips.length)) {
    res.status(200).json({ new_trips: [], trip_additions: [], unassigned: [], notes: tr(
      "No candidate jobs or trucks/trips with capacity to suggest.",
      "No hay jobs candidatos o camiones/trips con capacidad para sugerir.") });
    return;
  }

  try {
    const message = await client.messages.create({
      model: "claude-opus-5",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // effort "medium" keeps latency reasonable; the dispatcher reviews every
      // suggestion before anything is created, so top-tier planning depth isn't critical.
      output_config: { effort: "medium", format: { type: "json_schema", schema: SUGGESTIONS_SCHEMA } },
      messages: [{ role: "user", content: buildPrompt({ today, jobs, trucks, loadingTrips, drivers, truncated: rawJobs.length > MAX_JOBS, lang }) }],
    });
    const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
    let parsed;
    try { parsed = JSON.parse(text); }
    catch { res.status(502).json({ error: tr("The AI returned an invalid response. Try again.", "La IA devolvió una respuesta inválida. Intentá de nuevo.") }); return; }

    // Never trust the model's ids or arithmetic: filter unknowns, dedupe jobs
    // across suggestions (first occurrence wins) and recompute CF/occupancy
    // from the request data — the UI renders these numbers, not the model's.
    const jobByKey = new Map(jobs.map((j) => [j.key, j]));
    const truckById = new Map(trucks.map((t) => [t.id, t]));
    const tripById = new Map(loadingTrips.map((t) => [t.trip_id, t]));
    const used = new Set();
    const takeKeys = (keys) => {
      const out = [];
      for (const k of Array.isArray(keys) ? keys : []) {
        if (typeof k !== "string" || !jobByKey.has(k) || used.has(k)) continue;
        used.add(k); out.push(k);
      }
      return out;
    };
    const sumCf = (keys) => keys.reduce((acc, k) => acc + (jobByKey.get(k)?.volume_cf || 0), 0);

    // Days out, crew cost and the trip's P&L are computed here from the cost
    // model — never taken from the model's own arithmetic.
    const driverById = new Map(drivers.map((d) => [d.id, d]));
    const calcSettings = await jobCalcSettings().catch(() => null);
    const pts = await zipPoints(jobs.map((j) => j.delivery_zip)).catch(() => new Map());
    const sumRevenue = (keys) => keys.reduce((a, k) => a + (jobByKey.get(k)?.revenue || 0), 0);

    const newTrips = (Array.isArray(parsed.new_trips) ? parsed.new_trips : [])
      .filter((s) => s && truckById.has(Number(s.truck_id)))
      .map((s) => {
        const truck = truckById.get(Number(s.truck_id));
        const job_keys = takeKeys(s.job_keys);
        const total_cf = Math.round(sumCf(job_keys));
        const driver = driverById.get(Number(s.driver_id)) || null;
        const helpers = Math.min(2, Math.max(1, Math.round(Number(s.helpers) || 1)));
        const start = truck.lat != null && truck.lng != null ? { lat: truck.lat, lng: truck.lng } : null;
        const miles = routeMiles(start, job_keys.map((k) => jobByKey.get(k)?.delivery_zip || ""), pts);
        const econ = calcSettings
          ? tripEconomics({
              totalCf: total_cf, miles, revenue: sumRevenue(job_keys), helpers,
              driverRate: driver?.day_rate || 0, settings: calcSettings,
            })
          : null;
        return {
          truck_id: truck.id,
          truck_location: truck.location || "",
          truck_last_seen: truck.last_seen || "",
          job_keys,
          driver_id: driver ? driver.id : null,
          driver_name: driver ? driver.name : "",
          helpers,
          economics: econ,
          reasoning: String(s.reasoning || ""),
          total_cf,
          occ_pct: truck.capacity_cf > 0 ? Math.round((total_cf / truck.capacity_cf) * 100) : null,
        };
      })
      .filter((s) => s.job_keys.length > 0);

    const tripAdditions = (Array.isArray(parsed.trip_additions) ? parsed.trip_additions : [])
      .filter((s) => s && tripById.has(Number(s.trip_id)))
      .map((s) => {
        const trip = tripById.get(Number(s.trip_id));
        const job_keys = takeKeys(s.job_keys);
        const total_cf = Math.round(trip.current_cf + sumCf(job_keys));
        return {
          trip_id: trip.trip_id,
          job_keys,
          reasoning: String(s.reasoning || ""),
          total_cf,
          occ_pct: trip.capacity_cf > 0 ? Math.round((total_cf / trip.capacity_cf) * 100) : null,
        };
      })
      .filter((s) => s.job_keys.length > 0);

    const unassigned = (Array.isArray(parsed.unassigned) ? parsed.unassigned : [])
      .filter((u) => u && typeof u.job_key === "string" && jobByKey.has(u.job_key) && !used.has(u.job_key))
      .map((u) => ({ job_key: u.job_key, reason: String(u.reason || "") }));

    res.status(200).json({ new_trips: newTrips, trip_additions: tripAdditions, unassigned, notes: String(parsed.notes || "") });
  } catch (e) {
    res.status(500).json({ error: e?.message || tr("Error generating suggestions.", "Error generando sugerencias.") });
  }
}
