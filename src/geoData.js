// Pure derivation behind the scheduled-job pins on the Trips / Live Load map.
// Kept out of App.jsx so the window/dedupe rules can be tested without a browser
// (scripts/test-geo-pins.mjs), same as the other *Data.js siblings.

import { jobKey } from "./analyticsData.js";
import { addDaysStr } from "./appData.js";

// How far ahead the map looks by default. Two weeks is what a dispatcher is
// actually planning against; a longer window mostly piles pins on top of each
// other in the dense metros.
export const JOB_PIN_DAYS = 14;

// Statuses that mean the job is off the board — nothing left to drive to.
const JOB_PIN_DONE = new Set(["delivered", "cancelled"]);

// storage_jobs keeps one row PER LOCATION, so a logical job is several rows
// sharing a job_number. A split job can carry the pickup address on one row and
// the delivery on another, so every field below is taken from the first row that
// actually has it rather than from row zero.
const COALESCE = [
  "job_number", "customer", "status", "calendar_status", "job_type", "trip_id",
  "driver", "driver_ids", "volume", "real_cf",
  "pickup_date", "pickup_date_from", "pickup_date_to", "delivery_date", "fadd",
  "pickup_address", "pickup_city", "pickup_state", "pickup_zip",
  "delivery_address", "delivery_city", "delivery_state", "delivery_zip",
  "pickup_balance", "delivery_balance", "bol_balance",
];

// One entry per logical job, inside the window, still open. Rows are grouped by
// jobKey (the same key the calendars use) — without that, every multi-unit job
// would stack duplicate pins on the same spot.
export function scheduledJobGroups(jobs, { from, days = JOB_PIN_DAYS } = {}) {
  const to = addDaysStr(from, days);
  const byKey = new Map();
  for (const j of jobs || []) {
    const k = jobKey(j);
    if (!byKey.has(k)) byKey.set(k, []);
    byKey.get(k).push(j);
  }

  const out = [];
  for (const [k, parts] of byKey) {
    const g = { key: k };
    for (const f of COALESCE) {
      let v = null;
      for (const p of parts) if (p[f] != null && p[f] !== "") { v = p[f]; break; }
      g[f] = v;
    }
    // Judged on the coalesced job, not on whichever row happened to come first.
    if (JOB_PIN_DONE.has(g.status) || g.calendar_status === "cancelled") continue;

    // A pickup range counts if it overlaps the window at all; a delivery is a
    // single day. Either one puts the job on the map.
    const pFrom = g.pickup_date_from || g.pickup_date;
    const pTo = g.pickup_date_to || pFrom;
    const pickupIn = !!pFrom && pFrom <= to && pTo >= from;
    const deliveryIn = !!g.delivery_date && g.delivery_date >= from && g.delivery_date <= to;
    if (!pickupIn && !deliveryIn) continue;

    out.push({ ...g, pickup_date_from: pFrom, pickup_date_to: pTo, pickupIn, deliveryIn });
  }
  return out;
}

// The stop list the batch geocoder is asked to resolve: up to two per job.
// `geoCandidates` is injected because it lives in App.jsx and reaches into the
// US state table there — passing it keeps this module free of UI imports.
export function mapJobStops(jobs, { from, days = JOB_PIN_DAYS, geoCandidates } = {}) {
  const out = [];
  for (const g of scheduledJobGroups(jobs, { from, days })) {
    const pick = geoCandidates({ address: g.pickup_address, city: g.pickup_city, state: g.pickup_state, zip: g.pickup_zip });
    const drop = geoCandidates({ address: g.delivery_address, city: g.delivery_city, state: g.delivery_state, zip: g.delivery_zip });
    const stops = [];
    // A side with no usable address at all is left out rather than guessed at.
    if (pick.length) stops.push({ key: `job:${g.key}:pickup`, kind: "pickup", candidates: pick });
    if (drop.length) stops.push({ key: `job:${g.key}:delivery`, kind: "delivery", candidates: drop });
    if (stops.length) out.push({ job: g, stops });
  }
  return out;
}
