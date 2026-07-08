// Vercel serverless function: ask Claude to group available jobs into truck
// trips (and top-ups of trips still loading). The frontend sends a compact JSON
// snapshot of candidate jobs + free trucks + loading trips; Claude returns strict
// JSON suggestions which are validated and re-computed server-side before being
// shown to the dispatcher. Nothing is written to the database here.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

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
          reasoning: { type: "string", description: "1-2 sentences for the dispatcher, in the requested output language" },
        },
        required: ["truck_id", "job_keys", "reasoning"],
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

function buildPrompt({ today, jobs, trucks, loadingTrips, truncated, lang }) {
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
    "",
    lang === "es"
      ? "Write \"reasoning\", \"reason\" and \"notes\" in Spanish, addressed to the dispatcher."
      : "Write \"reasoning\", \"reason\" and \"notes\" in English, addressed to the dispatcher.",
    truncated ? "Note: the candidate job list was truncated to the most urgent jobs; mention this in notes." : "",
    "",
    `TODAY: ${today}`,
    `FREE TRUCKS (available for new trips): ${JSON.stringify(trucks)}`,
    `LOADING TRIPS (accepting additions): ${JSON.stringify(loadingTrips)}`,
    `CANDIDATE JOBS: ${JSON.stringify(jobs)}`,
  ].filter(Boolean).join("\n");
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }

  // Require a valid logged-in user (best-effort auth via service role).
  if (admin) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const { data: { user } = {}, error } = await admin.auth.getUser(token);
    if (error || !user) { res.status(401).json({ error: "No autorizado." }); return; }
  }

  const body = req.body || {};
  const lang = body.lang === "es" ? "es" : "en"; // AI output + error language follows the user's display language
  const tr = (en, es) => (lang === "es" ? es : en);
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
    }));
  const trucks = rawTrucks
    .filter((t) => t && Number.isFinite(Number(t.id)))
    .slice(0, MAX_TRUCKS)
    .map((t) => ({ id: Number(t.id), name: String(t.name || ""), capacity_cf: Number(t.capacity_cf) || 0 }))
    .filter((t) => t.capacity_cf > 0);
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
      model: "claude-opus-4-8",
      max_tokens: 16000,
      thinking: { type: "adaptive" },
      // effort "medium" keeps latency reasonable; the dispatcher reviews every
      // suggestion before anything is created, so top-tier planning depth isn't critical.
      output_config: { effort: "medium", format: { type: "json_schema", schema: SUGGESTIONS_SCHEMA } },
      messages: [{ role: "user", content: buildPrompt({ today, jobs, trucks, loadingTrips, truncated: rawJobs.length > MAX_JOBS, lang }) }],
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

    const newTrips = (Array.isArray(parsed.new_trips) ? parsed.new_trips : [])
      .filter((s) => s && truckById.has(Number(s.truck_id)))
      .map((s) => {
        const truck = truckById.get(Number(s.truck_id));
        const job_keys = takeKeys(s.job_keys);
        const total_cf = Math.round(sumCf(job_keys));
        return {
          truck_id: truck.id,
          job_keys,
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
