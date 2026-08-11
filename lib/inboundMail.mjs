// Inbound job triage — the server half: read broker "Moving Estimate" mails,
// extract them, price them through the real Job Calculator, and leave the result
// in job_evaluations with decision='pending' for a human to accept or reject.
//
// Nothing here writes to storage_jobs. Accepting is a deliberate act performed
// from the browser (src/inboundJobs.jsx), so the CRM's own permissions, undo and
// action_log all apply to the job that gets created.
//
// All the parsing/mapping rules live in ../src/inboundJobData.js, which is pure
// and covered by scripts/test-inbound-job-data.mjs. This file is only I/O.

import { admin, client } from "./clients.mjs";
import { gmailList, gmailGet, googleConfigured } from "./google.mjs";
import {
  normalizeExtraction, crossCheck, validateExtraction,
  estimateToJobInput, pricingBasis, matchBroker,
} from "../src/inboundJobData.js";
import { evaluateJob, profitRange, mergeSettings } from "../src/jobCalcData.js";

// Gmail label the brokers' estimates land in. Kept here (not in the DB) because
// changing it means changing what the pipeline means, not a user preference.
export const ESTIMATE_LABEL = "ESTIMATE";

// Estimate bodies run ~9k characters; the tail is boilerplate terms. Generous
// enough never to clip the Order Summary in practice, low enough to bound cost.
const MAX_BODY_CHARS = 40000;

const EXTRACTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "carrier_name", "customer", "client_phone", "client_email",
    "pickup_address", "pickup_city", "pickup_state", "pickup_zip",
    "delivery_address", "delivery_city", "delivery_state", "delivery_zip",
    "pickup_date_from", "pickup_date_to",
    "volume_cf", "rate_per_cf", "estimate_total", "total_paid", "balance",
    "distance_miles", "extra_stops", "comments", "move_type",
  ],
  properties: {
    carrier_name: { type: ["string", "null"], description: "The moving company issuing the estimate, e.g. 'Adam's Moving & Storage'." },
    customer: { type: ["string", "null"], description: "The client's full name." },
    client_phone: { type: ["string", "null"] },
    client_email: { type: ["string", "null"] },
    pickup_address: { type: ["string", "null"], description: "Street address only. Use null if the mail says PENDING/TBD." },
    pickup_city: { type: ["string", "null"] },
    pickup_state: { type: ["string", "null"], description: "Two-letter state code." },
    pickup_zip: { type: ["string", "null"], description: "5-digit ZIP of the PICKUP location." },
    delivery_address: { type: ["string", "null"], description: "Street address only. Use null if the mail says PENDING/TBD." },
    delivery_city: { type: ["string", "null"] },
    delivery_state: { type: ["string", "null"] },
    delivery_zip: { type: ["string", "null"], description: "5-digit ZIP of the DELIVERY location." },
    pickup_date_from: { type: ["string", "null"], description: "First pickup date exactly as written, e.g. '8/3/2026'." },
    pickup_date_to: { type: ["string", "null"], description: "Last pickup date; same as from for a one-day window." },
    volume_cf: { type: ["number", "null"], description: "Estimated volume in cubic feet." },
    rate_per_cf: { type: ["number", "null"], description: "Estimated rate charged to the customer, per cubic foot." },
    estimate_total: { type: ["number", "null"], description: "Total Moving Estimate." },
    total_paid: { type: ["number", "null"], description: "Total Paid / deposit already collected." },
    balance: { type: ["number", "null"], description: "Balance still owed." },
    distance_miles: { type: ["number", "null"], description: "Only if the mail states a distance; otherwise null." },
    extra_stops: { type: ["string", "null"], description: "Any extra stop address, as one line." },
    comments: { type: ["string", "null"], description: "The COMMENTS / customer notes section, verbatim." },
    move_type: { type: ["string", "null"] },
  },
};

const PROMPT = `You are reading one inbound "Moving Estimate" email that a broker sent to a moving carrier.

Extract the fields defined by the schema. Rules:
- Copy values EXACTLY as they appear. Never compute, round or infer a number.
- If a field is absent, or the mail writes PENDING / TBD / N/A, return null.
- Pickup and delivery each have their own "City, State, Zip" line. Do not swap them: the pickup block comes under a PICKUP / PICK-UP heading, the delivery block under DELIVERY.
- Different carriers label things differently ("Order ID" vs "Job Number", "Move Date" vs "Pickup Date"). Match on meaning, not on the exact label.
- Dates: return them in the mail's own format, do not reformat.
- Ignore all terms & conditions, marketing links and the article inventory.

EMAIL SUBJECT: `;

async function extractOne(msg) {
  const body = String(msg.body || "").slice(0, MAX_BODY_CHARS);
  const message = await client.messages.create({
    model: "claude-opus-4-8",
    max_tokens: 4000,
    output_config: { effort: "low", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: `${PROMPT}${msg.subject}\n\nEMAIL BODY:\n${body}` }],
  });
  const text = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(text); } catch { return null; }
}

// Routed miles for a ZIP pair, via the endpoint that already owns the provider
// chain and the permanent zip_distances cache. Server-to-server, so it presents
// CRON_SECRET. Returns nulls rather than throwing: a job with unknown miles is
// still worth queueing, it just cannot be priced until the operator opens it.
async function resolveMiles(originZip, destZip, baseZip) {
  const appUrl = process.env.APP_URL;
  const secret = process.env.CRON_SECRET;
  if (!appUrl || !secret || !originZip || !destZip) return null;
  try {
    const qs = new URLSearchParams({ origin: originZip, dest: destZip, ...(baseZip ? { base: baseZip } : {}) });
    const r = await fetch(`${appUrl.replace(/\/$/, "")}/api/distance?${qs}`, {
      headers: { Authorization: `Bearer ${secret}` },
    });
    if (!r.ok) return null;
    const b = await r.json();
    return {
      loadedMiles: b.loadedMiles ?? null,
      deadheadOutMiles: b.deadheadOutMiles ?? 0,
      deadheadBackMiles: b.deadheadBackMiles ?? 0,
      deadheadMiles: b.deadheadMiles ?? 0,
      deadheadKnown: !!b.deadheadKnown,
    };
  } catch { return null; }
}

// What this broker has actually paid us per cubic foot lately. The estimate
// states the CUSTOMER's price, which is not our revenue — see pricingBasis().
async function recentCarrierRate(brokerId) {
  if (!brokerId) return null;
  const { data } = await admin
    .from("storage_jobs")
    .select("carrier_rate_per_cf, created_at")
    .eq("broker_id", brokerId)
    .not("carrier_rate_per_cf", "is", null)
    .is("deleted_at", null)
    .order("created_at", { ascending: false })
    .limit(1);
  const v = data?.[0]?.carrier_rate_per_cf;
  return v == null ? null : Number(v);
}

const MISSING_COLUMN = new Set(["42703", "PGRST204"]);
export const SETUP_HINT = "Run the migration first: SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-inbound-jobs.mjs";

// Main entry point. Returns a summary; never throws for per-message problems,
// which are collected so one malformed mail cannot abort the whole run.
export async function syncInboundJobs({ days = 30, max = 25 } = {}) {
  if (!admin) throw Object.assign(new Error("Supabase service role is not configured on the server."), { status: 503 });
  if (!googleConfigured()) throw Object.assign(new Error("Google is not configured on the server."), { status: 503 });

  const summary = { scanned: 0, created: 0, skipped: 0, blocked: 0, errors: [] };

  const listed = await gmailList(`label:${ESTIMATE_LABEL} newer_than:${days}d`, { max });
  summary.scanned = listed.length;
  if (!listed.length) return summary;

  // Everything we already know about, in one query.
  const { data: seenRows, error: seenErr } = await admin
    .from("job_evaluations")
    .select("gmail_message_id")
    .in("gmail_message_id", listed.map((m) => m.id));
  if (seenErr && MISSING_COLUMN.has(seenErr.code)) {
    throw Object.assign(new Error(SETUP_HINT), { status: 503, setup: true });
  }
  const seen = new Set((seenRows || []).map((r) => r.gmail_message_id));

  const [{ data: settingsRow }, { data: brokers }] = await Promise.all([
    admin.from("job_calc_settings").select("settings").eq("id", 1).maybeSingle(),
    admin.from("brokers").select("id,name").is("deleted_at", null),
  ]);
  const settings = mergeSettings(settingsRow?.settings || {});
  const baseZip = settings.baseZip || "";

  for (const m of listed) {
    if (seen.has(m.id)) { summary.skipped++; continue; }
    try {
      const msg = await gmailGet(m.id);
      const raw = await extractOne(msg);
      const parsed = normalizeExtraction(raw, { subject: msg.subject, body: msg.body });
      const issues = crossCheck(parsed, msg.body);
      const validation = validateExtraction(parsed);

      const broker = matchBroker(parsed.carrier_name, brokers || []);
      const carrierRatePerCf = await recentCarrierRate(broker?.id);
      const price = pricingBasis(parsed, { carrierRatePerCf });

      // Price it only when it can be priced honestly. A blocked extraction is
      // still stored — the operator needs to see and fix it, not lose it.
      let miles = null, result = null, range = null;
      if (validation.ok) {
        miles = await resolveMiles(parsed.pickup_zip, parsed.delivery_zip, baseZip);
        const input = estimateToJobInput(parsed, { carrierRatePerCf });
        const legs = miles || {};
        result = evaluateJob(input, settings, {
          loadedMiles: miles?.loadedMiles ?? 0,
          deadheadMiles: miles?.deadheadMiles ?? 0,
        });
        try { range = profitRange(input, settings, legs); } catch { range = null; }
      }

      const row = {
        source: "gmail",
        gmail_message_id: msg.id,
        gmail_thread_id: msg.threadId,
        received_at: msg.receivedAt,
        parsed: { ...parsed, _issues: issues, _validation: validation, _pricing: price, _subject: msg.subject, _from: msg.from },
        raw_body: msg.body,

        label: parsed.job_number || parsed.customer || msg.subject,
        broker: parsed.carrier_name,
        broker_id_guess: broker?.id ?? null,
        job_number: parsed.job_number,
        broker_job_number: parsed.broker_job_number,
        customer: parsed.customer,
        client_email: parsed.client_email,
        client_phone: parsed.client_phone,

        origin_zip: parsed.pickup_zip,
        dest_zip: parsed.delivery_zip,
        pickup_address: parsed.pickup_address,
        pickup_city: parsed.pickup_city,
        pickup_state: parsed.pickup_state,
        delivery_address: parsed.delivery_address,
        delivery_city: parsed.delivery_city,
        delivery_state: parsed.delivery_state,
        pickup_date_from: parsed.pickup_date_from,
        pickup_date_to: parsed.pickup_date_to,

        cu_ft: parsed.volume_cf,
        estimate: parsed.estimate_total,
        deposit: parsed.total_paid,
        carrier_rate_per_cf: carrierRatePerCf,
        broker_price: price.brokerPrice,
        origin_access: "direct",
        dest_access: "direct",
        long_carry: false,
        shuttle: false,
        decision: "pending",
        settings_snapshot: settings,

        ...(result
          ? {
              loaded_miles: miles?.loadedMiles ?? null,
              deadhead_miles: miles?.deadheadMiles ?? null,
              total_miles: result.totalMiles,
              miles_manual: false,
              handling_hours: result.handlingHours,
              driving_hours: result.drivingHours,
              truck_days: result.truckDays,
              truck_days_estimated: result.truckDaysEstimated,
              hotel_nights: result.hotelNights,
              hotel_rooms: result.hotelRooms,
              variable_cost: result.variableCost,
              absorbed_fixed: result.absorbedFixed,
              contribution_margin: result.contributionMargin,
              contribution_per_truck_day: result.contributionPerTruckDay,
              operating_margin: result.operatingMargin,
              breakeven_price: result.breakevenPrice,
              hurdle_per_truck_day: result.hurdlePerTruckDay,
              ask_price: result.askPrice,
              total_revenue: result.totalRevenue,
              effective_cu_ft: result.effectiveCuFt,
              verdict: result.verdict,
              reason: result.reason,
              profit_low: range?.low?.operatingMargin ?? null,
              profit_high: range?.high?.operatingMargin ?? null,
              profit_mid: range?.mid?.operatingMargin ?? null,
            }
          : {}),
      };

      const { error } = await admin.from("job_evaluations").insert([row]);
      if (error) {
        if (MISSING_COLUMN.has(error.code)) throw Object.assign(new Error(SETUP_HINT), { status: 503, setup: true });
        // A concurrent run already inserted this message — the partial unique
        // index on gmail_message_id is doing its job.
        if (error.code === "23505") { summary.skipped++; continue; }
        throw new Error(error.message);
      }
      summary.created++;
      if (!validation.ok) summary.blocked++;
    } catch (e) {
      if (e?.setup) throw e;
      summary.errors.push({ id: m.id, error: e?.message || String(e) });
    }
  }
  return summary;
}
