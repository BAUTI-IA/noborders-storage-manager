// Customer Line — the pure rules (no I/O) behind the ElevenLabs agent that
// answers customers with a job in progress (docs/customer-line.md):
//   · how a caller proves a job is theirs,
//   · what the job looks like from the customer's side of the counter,
//   · what they still owe — the CRM's own number, not an approximation.
// Kept apart from lib/customerLine.mjs so scripts/test-customer-line.mjs runs it
// with plain node.
import { paymentNet } from "./paymentAlloc.mjs";

const num = (v) => (v === "" || v == null || isNaN(Number(v))) ? 0 : Number(v);
const round2 = (n) => Math.round(n * 100) / 100;

export const MAX_FAILED_PER_CALL = 3;            // then this call is locked
export const MAX_FAILED_PER_JOB = 10;            // across calls, rolling window
export const JOB_FAIL_WINDOW_MS = 24 * 3600 * 1000;
export const STAGE_TTL_MS = 15 * 60 * 1000;      // a read-back older than this can't be confirmed
export const LOCATION_FRESH_MS = 36 * 3600 * 1000;

export const CHANGE_KINDS = ["delivery_date", "delivery_address", "pickup_date", "contact_info", "storage", "other"];
export const CALLBACK_TOPICS = ["quote", "refund", "damage_claim", "complaint", "billing", "change_followup", "delivery_issue", "other"];

const KIND_LABEL = {
  delivery_date: "delivery date", delivery_address: "delivery address", pickup_date: "pickup date",
  contact_info: "contact info", storage: "storage", other: "other",
};

// ── Identity ─────────────────────────────────────────────────────────────────
// Job numbers arrive transcribed from speech: "#1201", "nb-1201", "Job 1201".
// Compare letters and digits only; a spoken "job"/"number" prefix is not part
// of the number.
export const normJobNumber = (v) =>
  String(v ?? "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/^(JOB)?(NUMBER|NUM|NO)?(?=\d)/, "");

// What to ILIKE for in the DB. The stored number may carry dashes the caller
// didn't say ("ATL-2024-1201"), so search by its last digits and compare the
// normalized forms afterwards. Too short to search → null.
export function jobSearchFragment(input) {
  const n = normJobNumber(input);
  const digits = n.replace(/\D/g, "");
  if (digits.length >= 3) return digits.slice(-4);
  return n.length >= 3 ? n : null;
}

// Logical-job key — same rule as src/analyticsData.js:14 (split rows share it).
export const jobKeyOf = (j) => (j.job_number && j.job_number.trim() ? "n:" + j.job_number.trim().toLowerCase() : "id:" + j.id);

// A 4-digit ZIP is a 5-digit one that lost its leading zero (NJ, MA…) on the
// way through a spreadsheet or a speech-to-number conversion.
export function zip5(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  if (d.length === 4) return "0" + d;
  return d.length >= 5 ? d.slice(0, 5) : null;
}
export function last4(v) {
  const d = String(v ?? "").replace(/\D/g, "");
  return d.length >= 4 ? d.slice(-4) : null;
}

/**
 * Group candidate rows into logical jobs whose number matches what the caller
 * said. -> [{ key, rows }] (rows newest first, like the CRM loads them).
 */
export function matchingJobs(rows, jobNumberInput) {
  const target = normJobNumber(jobNumberInput);
  if (!target) return [];
  const groups = new Map();
  for (const r of rows || []) {
    if (r.deleted_at || normJobNumber(r.job_number) !== target) continue;
    const k = jobKeyOf(r);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  return [...groups.entries()].map(([key, rs]) => ({
    key,
    rows: rs.slice().sort((a, b) => String(b.created_at || "").localeCompare(String(a.created_at || "")) || num(b.id) - num(a.id)),
  }));
}

/**
 * Does the second factor match ANY row of the job? (A job split across storage
 * units is several rows; the ZIP or phone may live on just one of them.)
 * -> { ok: true, factor } | { ok: false, reason } — `reason` is for the audit
 * log only. The caller always hears the same thing, so the endpoint never
 * tells anyone whether a job number exists.
 */
export function factorsMatch(rows, { zip, phone_last4 } = {}) {
  const z = zip5(zip);
  const p = last4(phone_last4);
  if (!z && !p) return { ok: false, reason: "no_factor" };
  const zips = new Set((rows || []).flatMap((r) => [zip5(r.delivery_zip), zip5(r.pickup_zip)]).filter(Boolean));
  const phones = new Set((rows || []).map((r) => last4(r.client_phone)).filter(Boolean));
  if (z && zips.has(z)) return { ok: true, factor: "zip" };
  if (p && phones.has(p)) return { ok: true, factor: "phone_last4" };
  if (!zips.size && !phones.size) return { ok: false, reason: "nothing_on_file" };
  return { ok: false, reason: "mismatch" };
}

// ── What the customer may hear ───────────────────────────────────────────────
const STATUS_MEANING = {
  scheduled: "Scheduled for pickup — nothing has been picked up yet.",
  picked_up: "Picked up and on our truck.",
  in_storage: "In storage at our facility, waiting for delivery.",
  out_for_delivery: "Out for delivery.",
  delivered: "Delivered.",
  on_hold: "On hold — a coordinator has to review it before anything moves. Don't guess why; offer a callback.",
  cancelled: "Cancelled.",
};
const statusOf = (r) => r.status || "scheduled";

export function firstName(customer) {
  const s = String(customer || "").trim();
  if (!s) return null;
  const given = s.includes(",") ? s.split(",")[1] : s; // "Doe, Jane"
  const w = String(given || "").trim().split(/\s+/)[0] || "";
  return w.replace(/[^\p{L}'-]/gu, "") || null;
}

// Verizon and the geocoder sometimes spell the state out ("Ocala, Florida").
const STATE_CODES = {
  alabama: "AL", alaska: "AK", arizona: "AZ", arkansas: "AR", california: "CA", colorado: "CO", connecticut: "CT",
  delaware: "DE", "district of columbia": "DC", florida: "FL", georgia: "GA", hawaii: "HI", idaho: "ID", illinois: "IL",
  indiana: "IN", iowa: "IA", kansas: "KS", kentucky: "KY", louisiana: "LA", maine: "ME", maryland: "MD",
  massachusetts: "MA", michigan: "MI", minnesota: "MN", mississippi: "MS", missouri: "MO", montana: "MT",
  nebraska: "NE", nevada: "NV", "new hampshire": "NH", "new jersey": "NJ", "new mexico": "NM", "new york": "NY",
  "north carolina": "NC", "north dakota": "ND", ohio: "OH", oklahoma: "OK", oregon: "OR", pennsylvania: "PA",
  "rhode island": "RI", "south carolina": "SC", "south dakota": "SD", tennessee: "TN", texas: "TX", utah: "UT",
  vermont: "VT", virginia: "VA", washington: "WA", "west virginia": "WV", wisconsin: "WI", wyoming: "WY",
};
const CODES = new Set(Object.values(STATE_CODES));
// "Main St, Washington" — a street name where a city should be. A leading
// "St." is a saint (St. Louis), so the suffix only counts after another word.
const STREETISH = /\S\s+(st|street|ave|avenue|rd|road|hwy|highway|blvd|boulevard|dr|drive|ln|lane|way|pkwy|parkway|route|rte)\b/i;

/**
 * City-level place from a telematics label, or null. The driver's exact
 * position is not the customer's business — "near Richmond, VA" is.
 *   "5 mi NE of Plymouth, IN"                 → "Plymouth, IN"
 *   "123 Main St, Richmond, VA 23220, USA"    → "Richmond, VA"
 *   "Ocala, Florida, United States"           → "Ocala, FL"
 * Anything it can't reduce to "City, ST" is dropped rather than read out.
 */
export function cityLevel(label) {
  const parts = String(label || "").split(",").map((s) => s.trim());
  for (let i = parts.length - 1; i >= 1; i--) {
    const m = parts[i].match(/^([A-Za-z][A-Za-z .]*?)(\s+\d{5}(-\d{4})?)?$/);
    if (!m) continue;
    const code = CODES.has(m[1]) ? m[1] : STATE_CODES[m[1].toLowerCase()];
    if (!code) continue;
    const city = parts[i - 1].replace(/^.*\bof\s+/i, "").trim();
    if (!city || /\d/.test(city) || STREETISH.test(city) || city.length > 40) return null;
    return `${city}, ${code}`;
  }
  return null;
}

/**
 * What the customer still owes — App.jsx's jobOutstanding (src/App.jsx:6533),
 * so the agent says the same number dispatch sees:
 *   max(0, pickup + delivery + bol balance − collected) + extras still open
 *   collected = max(bol_collected, received 'job' payments)
 * `rep` is the job's representative row (the newest, as the CRM loads them).
 * Money already collected is applied to the pickup balance first, so whatever
 * is left of it is what a scheduled job owes at pickup.
 */
export function jobBalance({ rep, payments = [], extras = [] }) {
  const toCollect = num(rep.pickup_balance) + num(rep.delivery_balance) + num(rep.bol_balance);
  const received = payments.filter((p) => p.received && !p.deleted_at);
  const paidJob = received.filter((p) => p.concept === "job").reduce((s, p) => s + paymentNet(p), 0);
  const paidExtra = received.filter((p) => p.concept === "extra").reduce((s, p) => s + paymentNet(p), 0);
  const collected = Math.max(num(rep.bol_collected), paidJob);
  const extrasOwed = extras.filter((e) => e.active !== false && !e.deleted_at).reduce((s, e) => s + num(e.amount), 0);
  const total = Math.max(0, toCollect - collected) + Math.max(0, extrasOwed - paidExtra);
  const atPickup = statusOf(rep) === "scheduled" ? Math.min(total, Math.max(0, num(rep.pickup_balance) - collected)) : 0;
  return {
    total_due: round2(total),
    due_at_pickup: round2(atPickup),
    due_at_delivery: round2(total - atPickup),
    paid_so_far: round2(collected + paidExtra),
  };
}

const dayISO = (d, tz = "America/New_York") => new Date(d).toLocaleDateString("en-CA", { timeZone: tz });

/**
 * The one sentence the agent bases every delivery-date answer on. Dates are a
 * fact the server owns; leaving "is the FADD a promise?" to the model let it
 * read a first-available date as if it were booked (test 06, Spanish). The
 * model still phrases it naturally, but it no longer has to infer it.
 */
export function deliverySummary({ delivered, deliveredOn, scheduled, fadd }) {
  if (delivered) return deliveredOn ? `Delivered on ${deliveredOn}.` : "Delivered.";
  if (scheduled) return `Delivery is scheduled for ${scheduled}.`;
  if (fadd) return `Delivery is not scheduled yet. ${fadd} is the first available delivery date (FADD): the earliest day we could deliver, not a booked day.`;
  return "Delivery is not scheduled yet, and there is no first available delivery date on file.";
}

/**
 * The whitelisted view of one logical job. Everything here may be read aloud to
 * a verified caller; nothing else from the row leaves the server — no email,
 * full phone, street address, ZIP, notes, broker, driver or price.
 */
export function customerSnapshot({ rows, payments = [], extras = [], billing = [], trips = [], trucks = [], now = new Date() }) {
  const rep = rows[0];
  const statuses = [...new Set(rows.map(statusOf))];
  const status = statuses.length === 1 ? statuses[0] : "split";
  const today = dayISO(now);

  // Where the truck is: only for a job that is physically on a truck that is
  // actually rolling, and only when the fix is recent enough to mean something.
  let truck_last_seen = null;
  const tripById = new Map(trips.map((t) => [t.id, t]));
  const truckById = new Map(trucks.map((t) => [t.id, t]));
  for (const r of rows) {
    if (!["picked_up", "out_for_delivery"].includes(statusOf(r)) || !r.trip_id) continue;
    const trip = tripById.get(r.trip_id);
    if (!trip || trip.status !== "in_transit" || trip.deleted_at) continue;
    const truck = truckById.get(trip.truck_id);
    const at = truck?.last_location_at ? new Date(truck.last_location_at).getTime() : NaN;
    const near = cityLevel(truck?.last_location);
    if (!near || !Number.isFinite(at) || now.getTime() - at > LOCATION_FRESH_MS) continue;
    const hours_ago = Math.max(0, Math.round((now.getTime() - at) / 3600000));
    if (!truck_last_seen || hours_ago < truck_last_seen.hours_ago) truck_last_seen = { near, hours_ago };
  }

  // Storage: rows still sitting in a unit or warehouse (date_out empty).
  const stored = rows.filter((r) => (r.storage_id || r.warehouse) && !r.date_out);
  const rentPending = billing.filter((b) => b.status === "pending");
  const storage = stored.length || rep.billing_active
    ? {
        location: stored.find((r) => r.warehouse)?.warehouse ? `our ${stored.find((r) => r.warehouse).warehouse} warehouse` : (stored.length ? "a storage facility" : null),
        stored_since: stored.map((r) => r.date_in).filter(Boolean).sort()[0] || null,
        monthly_rate: rep.billing_active && num(rep.client_monthly_rate) ? round2(num(rep.client_monthly_rate)) : null,
        first_month_free: !!rep.first_month_free,
        rent_pending: round2(rentPending.reduce((s, b) => s + num(b.amount), 0)),
        rent_overdue: round2(rentPending.filter((b) => b.billing_period_end && b.billing_period_end < today).reduce((s, b) => s + num(b.amount), 0)),
      }
    : null;

  const balance = jobBalance({ rep, payments, extras });
  const delivered = status === "delivered";
  return {
    job_number: String(rep.job_number || "").trim(),
    customer_first_name: firstName(rep.customer),
    status,
    status_meaning: status === "split"
      ? "Shipped in parts that are at different stages — see portions."
      : STATUS_MEANING[status] || status,
    ...(status === "split" ? { portions: statuses.map((s) => ({ status: s, meaning: STATUS_MEANING[s] || s })) } : {}),
    pickup: statuses.includes("scheduled")
      ? { date: rep.pickup_date || null, window_from: rep.pickup_date_from || null, window_to: rep.pickup_date_to || null }
      : null,
    first_available_delivery_date: rep.fadd || null,
    scheduled_delivery_date: rep.delivery_date || null,
    delivered_on: delivered ? (rep.delivery_date || rep.date_out || null) : null,
    delivery_summary: deliverySummary({ delivered, deliveredOn: rep.delivery_date || rep.date_out || null, scheduled: rep.delivery_date || null, fadd: rep.fadd || null }),
    delivery_to: [rep.delivery_city, rep.delivery_state].filter(Boolean).join(", ") || null,
    truck_last_seen,
    balance: {
      ...balance,
      ...(delivered && balance.total_due > 0 ? { note: "Delivered with an open balance. Don't negotiate it; offer a billing callback." } : {}),
    },
    storage,
  };
}

// ── Change requests ──────────────────────────────────────────────────────────
const isoDate = (v) => (/^\d{4}-\d{2}-\d{2}$/.test(String(v || "")) ? String(v) : null);

/** -> { ok: true, staged } | { ok: false, error } */
export function validateChange(input = {}) {
  const kind = String(input.kind || "").trim().toLowerCase();
  const details = String(input.details || "").trim().slice(0, 500);
  if (!CHANGE_KINDS.includes(kind)) return { ok: false, error: `kind must be one of: ${CHANGE_KINDS.join(", ")}` };
  if (!details) return { ok: false, error: "details is required: what the customer wants changed, in their words" };
  return { ok: true, staged: { kind, details, preferred_date: isoDate(input.preferred_date) } };
}

export function changeReadback(jobNumber, s) {
  return `Change request for job ${jobNumber}: ${KIND_LABEL[s.kind] || s.kind}${s.preferred_date ? ` (preferred date ${s.preferred_date})` : ""} — "${s.details}". `
    + "Nothing on the job changes until a coordinator reviews it and calls back to confirm.";
}

/** -> { ok: true, callback } | { ok: false, error } */
export function validateCallback(input = {}) {
  const topic = String(input.topic || "other").trim().toLowerCase();
  const reason = String(input.reason || "").trim().slice(0, 500);
  if (!CALLBACK_TOPICS.includes(topic)) return { ok: false, error: `topic must be one of: ${CALLBACK_TOPICS.join(", ")}` };
  if (!reason) return { ok: false, error: "reason is required: one sentence on what the coordinator should call about" };
  const urgency = String(input.urgency || "").toLowerCase() === "urgent" ? "urgent" : "normal";
  return {
    ok: true,
    callback: {
      topic, reason, urgency,
      caller_name: String(input.caller_name || "").trim().slice(0, 120) || null,
      best_time: String(input.best_time || "").trim().slice(0, 120) || null,
      claimed_job_number: String(input.job_number || "").trim().slice(0, 40) || null,
    },
  };
}

// A number someone can actually dial back: 10 US digits (a leading 1 is fine).
export function callbackPhone(...candidates) {
  for (const c of candidates) {
    const d = String(c ?? "").replace(/\D/g, "");
    if (d.length === 10) return d;
    if (d.length === 11 && d.startsWith("1")) return d.slice(1);
    if (d.length > 11) return d; // international: pass through for a human to dial
  }
  return null;
}

// ── Team notification (Telegram) ─────────────────────────────────────────────
// Always in English, whatever language the caller spoke, so the team reads one
// format. Only the quoted request text is the agent's own words.
const phoneLabel = (p) => { const d = String(p || "").replace(/\D/g, ""); return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : p; };
export function teamMessage(req) {
  const ref = req.kind === "change" ? `CR-${req.id}` : `CB-${req.id}`;
  const who = req.job_number
    ? `Job ${req.job_number}${req.caller_name ? ` · ${req.caller_name}` : ""} (verified)`
    : `Not verified${req.caller_name ? ` · ${req.caller_name}` : ""}${req.claimed_job_number ? ` · says job ${req.claimed_job_number}` : ""}`;
  const lines = req.kind === "change"
    ? [`📞 Customer Line — change request ${ref}`, who, `Change: ${KIND_LABEL[req.topic] || req.topic}${req.preferred_date ? ` · requested date ${req.preferred_date}` : ""}`, `“${req.details}”`, "Nothing on the job has changed: approve it and call the customer back."]
    : [`☎️ Customer Line — callback ${ref}${req.urgency === "urgent" ? " · URGENT" : ""}`, who, `Topic: ${String(req.topic || "other").replace(/_/g, " ")}`, req.callback_phone ? `Phone: ${phoneLabel(req.callback_phone)}` : null, req.best_time ? `Best time: ${req.best_time}` : null, `“${req.details}”`];
  return [...lines.filter(Boolean), `conv: ${req.conversation_id}`].join("\n");
}
