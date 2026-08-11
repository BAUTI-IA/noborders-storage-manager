// Inbound job triage — pure parsing, normalization and mapping for the jobs
// that arrive by email (broker "Moving Estimate" mails).
//
// No React, no I/O, NO IMPORTS AT ALL: this file must stay runnable under plain
// node (`node scripts/test-inbound-job-data.mjs`), same discipline as
// jobCalcData.js. Every number the queue shows and every field that ends up in
// the job form is produced here, so this is the layer that gets tested.
//
// Division of labour with the AI extractor (api/agent-hub.mjs):
//   - the model FINDS the fields (carrier formats differ too much for regex),
//   - this module NORMALIZES and VALIDATES what it returned, and
//   - regexProbe()/crossCheck() independently re-read the handful of fields that
//     ARE identical across carriers, so a hallucinated amount or zip is caught
//     before a human ever sees the card.

// ── primitives ───────────────────────────────────────────────────────────────

// Mirrors jobCalcData.num: blank/null/NaN collapse to the fallback.
export function num(v, fallback = 0) {
  if (v === "" || v == null) return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// "$2,499.56" → 2499.56 · "(123.45)" → -123.45 · "1698 cf." → 1698
//                        · "$1.47 per cf." → 1.47 · "5 miles" → 5
// Takes the FIRST numeric token rather than stripping non-digits globally:
// "$1.47 per cf." would otherwise collapse to "1.47." and Number() → NaN.
export function parseMoney(v) {
  if (v == null) return null;
  const s = String(v);
  const m = s.match(/\d[\d,]*(?:\.\d+)?/);
  if (!m) return null;
  const n = Number(m[0].replace(/,/g, ""));
  if (!Number.isFinite(n)) return null;
  const neg = /^\s*[(-]/.test(s);
  return neg ? -n : n;
}

// Same normalization the CRM uses to link a free-text job number to a job row
// (src/App.jsx:1675). Kept byte-identical on purpose.
export const normJobNumber = (s) => (s || "").trim().toLowerCase();

// Real job numbers in this CRM: A1824813, HV4610476, FV8132068 — AND 26175872,
// purely numeric (that is the shape brokers like Compass use). The older parser
// at src/App.jsx:2156 requires a letter prefix and would silently drop those,
// so the prefix is optional here.
export const JOB_NUMBER_RE = /\b([A-Z]{0,2}\d{6,})\b/i;

// Subject lines look like:
//   "Moving Estimate JoB#TZ658518 / 1089168 8/10 - 8/11"
//   "Moving Estimate-Job#AZ658357 / 2087235 One day move monday 8/3"
//   "Bill of Lading to Carrier 4381382"
// The token right after "Job#" is the CRM's own number; the one after the slash
// is the broker's internal order id. Returns both, never throws.
export function jobNumberFromSubject(subject) {
  const s = String(subject || "");
  const tagged = s.match(/job\s*#\s*([A-Z]{0,2}\d{6,})/i);
  const job_number = tagged ? tagged[1].toUpperCase() : null;

  let broker_job_number = null;
  const afterSlash = s.match(/job\s*#\s*[A-Z]{0,2}\d{6,}\s*\/\s*(\d{4,})/i);
  if (afterSlash) broker_job_number = afterSlash[1];

  if (!job_number) {
    // No "Job#" tag (broker BOL mails): fall back to the first id-shaped token.
    const loose = s.match(JOB_NUMBER_RE);
    if (loose) return { job_number: loose[1].toUpperCase(), broker_job_number: null };
  }
  return { job_number, broker_job_number };
}

// ── dates ────────────────────────────────────────────────────────────────────

const pad2 = (n) => String(n).padStart(2, "0");

// "8/3/2026" → "2026-08-03". Accepts 2- or 4-digit years and already-ISO input.
// Returns null rather than an invalid date: a wrong pickup date would put a job
// on the wrong calendar day, so guessing is worse than leaving it blank.
export function parseUsDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const iso = s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return s;
  const m = s.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2}|\d{4})$/);
  if (!m) return null;
  const mo = Number(m[1]), da = Number(m[2]);
  let yr = Number(m[3]);
  if (yr < 100) yr += 2000;
  if (mo < 1 || mo > 12 || da < 1 || da > 31) return null;
  return `${yr}-${pad2(mo)}-${pad2(da)}`;
}

// "8/1/2026 - 8/2/2026" → { from:"2026-08-01", to:"2026-08-02" }
// "8/3/2026"            → { from:"2026-08-03", to:"2026-08-03" }
// A reversed range is returned in order — brokers do occasionally type it backwards.
export function parseDateRange(v) {
  if (!v) return { from: null, to: null };
  const parts = String(v).split(/\s*(?:-|–|—|to|through)\s*/i).filter(Boolean);
  const from = parseUsDate(parts[0]);
  const to = parts.length > 1 ? parseUsDate(parts[1]) : from;
  if (!from) return { from: null, to: null };
  if (!to) return { from, to: from };
  return from <= to ? { from, to } : { from: to, to: from };
}

// ── addresses ────────────────────────────────────────────────────────────────

// "Indianapolis, IN 46256" → { city:"Indianapolis", state:"IN", zip:"46256" }
// Also tolerates "KANSAS CITY, MO 64119" and ZIP+4.
export function parseCityStateZip(v) {
  if (!v) return { city: null, state: null, zip: null };
  const s = String(v).trim();
  const m = s.match(/^(.*?),\s*([A-Z]{2})\s+(\d{5})(?:-\d{4})?\s*$/i);
  if (!m) {
    const zipOnly = s.match(/\b(\d{5})(?:-\d{4})?\b/);
    return { city: null, state: null, zip: zipOnly ? zipOnly[1] : null };
  }
  return { city: m[1].trim() || null, state: m[2].toUpperCase(), zip: m[3] };
}

export const isZip = (v) => /^\d{5}$/.test(String(v ?? "").trim());

// ── regex probe (the independent cross-check) ────────────────────────────────

// The plaintext bodies carry markdown-ish bold markers whose placement is not
// stable — "*Estimated Rate:* $1.44" in one carrier, "*Estimated Volume: *1385"
// in another. Dropping '*' and collapsing runs of spaces makes label matching
// reliable without caring which side the marker landed on.
export function normalizeBody(body) {
  return String(body || "").replace(/\*/g, "").replace(/[ \t]+/g, " ");
}

function labelValue(text, labels) {
  for (const label of labels) {
    const re = new RegExp(label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*:\\s*([^\\n]*)", "i");
    const m = text.match(re);
    if (m && m[1].trim()) return m[1].trim();
  }
  return null;
}

// Every "City, State, Zip" line in the mail, in document order. Used to verify
// the model's zips actually appear in the source instead of trusting them.
export function allCityStateZip(body) {
  const text = normalizeBody(body);
  const out = [];
  const re = /City,\s*State,\s*Zip\s*:\s*([^\n]*)/gi;
  let m;
  while ((m = re.exec(text))) {
    const parsed = parseCityStateZip(m[1]);
    if (parsed.zip) out.push(parsed);
  }
  return out;
}

// Only the fields that are byte-identical across every carrier sampled. These
// are re-read deterministically so crossCheck() can contradict the model.
export function regexProbe(body) {
  const text = normalizeBody(body);
  const money = (labels) => parseMoney(labelValue(text, labels));

  const volumeRaw = labelValue(text, ["Estimated Volume"]);
  const rateRaw = labelValue(text, ["Estimated Rate"]);
  const distRaw = labelValue(text, ["Distance"]);
  const fuel = text.match(/Fuel Surcharge\s*(\d+(?:\.\d+)?)\s*%/i);

  return {
    volume_cf: volumeRaw ? parseMoney(volumeRaw) : null,
    rate_per_cf: rateRaw ? parseMoney(rateRaw) : null,
    fuel_surcharge_pct: fuel ? Number(fuel[1]) : null,
    basic_estimate_price: money(["Basic Estimate Price"]),
    estimate_total: money(["Total Moving Estimate"]),
    total_paid: money(["Total Paid"]),
    balance: money(["Balance"]),
    distance_miles: distRaw ? parseMoney(distRaw) : null,
    zips: allCityStateZip(body).map((z) => z.zip),
  };
}

// ── normalization of the model's output ──────────────────────────────────────

export const PARSED_FIELDS = [
  "job_number", "broker_job_number", "carrier_name",
  "customer", "client_phone", "client_email",
  "pickup_address", "pickup_city", "pickup_state", "pickup_zip",
  "delivery_address", "delivery_city", "delivery_state", "delivery_zip",
  "pickup_date_from", "pickup_date_to",
  "volume_cf", "rate_per_cf", "fuel_surcharge_pct",
  "estimate_total", "total_paid", "balance",
  "distance_miles", "extra_stops", "comments", "move_type",
];

const clean = (v) => {
  if (v == null) return null;
  const s = String(v).trim();
  if (!s) return null;
  // Brokers write "PENDING" / "TBD" / "N/A" where they have no value yet.
  if (/^(pending|tbd|n\/?a|none|unknown)$/i.test(s)) return null;
  return s;
};

const cleanZip = (v) => {
  const s = clean(v);
  if (!s) return null;
  const m = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  return m ? m[1] : null;
};

// Takes whatever the model returned (plus the subject) and produces the single
// canonical `parsed` object the rest of the pipeline consumes. Pure and total:
// any shape of input yields a complete object with nulls where data is missing.
export function normalizeExtraction(raw, { subject = "", body = "" } = {}) {
  const r = raw && typeof raw === "object" ? raw : {};
  const fromSubject = jobNumberFromSubject(subject);

  const range = (() => {
    const from = parseUsDate(r.pickup_date_from) || parseDateRange(r.pickup_date).from;
    const to = parseUsDate(r.pickup_date_to) || parseDateRange(r.pickup_date).to || from;
    if (!from) return { from: null, to: null };
    return from <= (to || from) ? { from, to: to || from } : { from: to, to: from };
  })();

  const probe = regexProbe(body);

  const out = {
    job_number: clean(r.job_number) ? String(clean(r.job_number)).toUpperCase() : fromSubject.job_number,
    broker_job_number: clean(r.broker_job_number) || fromSubject.broker_job_number,
    carrier_name: clean(r.carrier_name),

    customer: clean(r.customer),
    client_phone: clean(r.client_phone),
    client_email: clean(r.client_email),

    pickup_address: clean(r.pickup_address),
    pickup_city: clean(r.pickup_city),
    pickup_state: clean(r.pickup_state) ? String(clean(r.pickup_state)).toUpperCase() : null,
    pickup_zip: cleanZip(r.pickup_zip),

    delivery_address: clean(r.delivery_address),
    delivery_city: clean(r.delivery_city),
    delivery_state: clean(r.delivery_state) ? String(clean(r.delivery_state)).toUpperCase() : null,
    delivery_zip: cleanZip(r.delivery_zip),

    pickup_date_from: range.from,
    pickup_date_to: range.to,

    // Numbers prefer the deterministic probe: it read the same line the model
    // did, but it cannot hallucinate.
    volume_cf: probe.volume_cf ?? parseMoney(r.volume_cf),
    rate_per_cf: probe.rate_per_cf ?? parseMoney(r.rate_per_cf),
    fuel_surcharge_pct: probe.fuel_surcharge_pct ?? parseMoney(r.fuel_surcharge_pct),
    estimate_total: probe.estimate_total ?? parseMoney(r.estimate_total),
    total_paid: probe.total_paid ?? parseMoney(r.total_paid),
    balance: probe.balance ?? parseMoney(r.balance),
    distance_miles: probe.distance_miles ?? parseMoney(r.distance_miles),

    extra_stops: clean(r.extra_stops),
    comments: clean(r.comments),
    move_type: clean(r.move_type),
  };
  return out;
}

// Disagreements between the model and the deterministic re-read. Anything listed
// here is shown on the card as a warning; it never blocks silently.
export function crossCheck(parsed, body) {
  const probe = regexProbe(body);
  const issues = [];
  const cmp = (field, a, b) => {
    if (a == null || b == null) return;
    if (Math.abs(a - b) > 0.01) issues.push({ field, model: b, source: a });
  };
  cmp("volume_cf", probe.volume_cf, parsed.volume_cf);
  cmp("rate_per_cf", probe.rate_per_cf, parsed.rate_per_cf);
  cmp("estimate_total", probe.estimate_total, parsed.estimate_total);
  cmp("total_paid", probe.total_paid, parsed.total_paid);
  cmp("balance", probe.balance, parsed.balance);

  if (probe.zips.length) {
    for (const f of ["pickup_zip", "delivery_zip"]) {
      if (parsed[f] && !probe.zips.includes(parsed[f])) {
        issues.push({ field: f, model: parsed[f], source: probe.zips.join(", ") });
      }
    }
  }
  return issues;
}

// ── validation ───────────────────────────────────────────────────────────────

// `blocking` = cannot be priced or cannot be saved as a job. `missing` = merely
// incomplete; the operator can accept anyway and fill it in later.
export function validateExtraction(parsed) {
  const p = parsed || {};
  const blocking = [];
  const missing = [];

  if (!isZip(p.pickup_zip)) blocking.push("pickup_zip");
  if (!isZip(p.delivery_zip)) blocking.push("delivery_zip");
  if (!(num(p.volume_cf) > 0)) blocking.push("volume_cf");
  // saveJob() refuses a row with none of job_number / customer / driver.
  if (!p.job_number && !p.customer) blocking.push("job_number_or_customer");

  for (const f of ["client_phone", "client_email", "pickup_address", "delivery_address", "pickup_date_from", "estimate_total"]) {
    if (!p[f]) missing.push(f);
  }
  return { ok: blocking.length === 0, blocking, missing };
}

// ── pricing basis ────────────────────────────────────────────────────────────

export const PRICING_BASIS = { CARRIER_RATE: "carrier_rate", CUSTOMER_TOTAL: "customer_total" };

// What No Borders actually gets paid — NOT what the customer pays.
// The estimate states the customer-facing total; the carrier is paid the
// broker's rate per cf (storage_jobs.carrier_rate_per_cf). Pricing a job off the
// customer total overstates profit on every single job, so when no carrier rate
// is known the result is flagged `assumed` and the UI must surface that.
export function pricingBasis(parsed, { carrierRatePerCf = null } = {}) {
  const cuFt = num(parsed?.volume_cf);
  const rate = carrierRatePerCf === "" || carrierRatePerCf == null ? null : num(carrierRatePerCf);
  if (rate != null && rate > 0 && cuFt > 0) {
    return { brokerPrice: cuFt * rate, basis: PRICING_BASIS.CARRIER_RATE, assumed: false, ratePerCf: rate };
  }
  return {
    brokerPrice: num(parsed?.estimate_total),
    basis: PRICING_BASIS.CUSTOMER_TOTAL,
    assumed: true,
    ratePerCf: cuFt > 0 ? num(parsed?.estimate_total) / cuFt : null,
  };
}

// ── mapping out ──────────────────────────────────────────────────────────────

// The exact `job` object evaluateJob(job, settings, miles) expects. Access flags
// are not stated in estimate mails, so they stay "direct" (multiplier 1.0) —
// which is what evaluateJob already assumes for a missing field.
export function estimateToJobInput(parsed, opts = {}) {
  const { carrierRatePerCf = null, trucks = 1, drivers = 1, helpers = 1,
          originAccess = "direct", destAccess = "direct",
          longCarry = false, shuttle = false } = opts;
  const price = pricingBasis(parsed, { carrierRatePerCf });
  return {
    originZip: parsed?.pickup_zip || "",
    destZip: parsed?.delivery_zip || "",
    cuFt: num(parsed?.volume_cf),
    brokerPrice: price.brokerPrice,
    originAccess, destAccess, longCarry, shuttle,
    trucks, drivers, helpers,
  };
}

// Apostrophes are DROPPED, not turned into separators: "Adam's Moving" must
// normalize to "adams moving" so it matches a CRM broker stored as "Adams
// Moving". Everything else non-alphanumeric collapses to a single space.
const normName = (s) => String(s || "").toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

// Resolve the carrier named in the mail to a row in `brokers`. Exact normalized
// match first, then containment either way — "Adam's Moving & Storage" in the
// mail vs "Adams Moving" in the CRM. Ambiguous containment resolves to null
// rather than picking one at random.
export function matchBroker(carrierName, brokers = []) {
  const target = normName(carrierName);
  if (!target) return null;
  const list = Array.isArray(brokers) ? brokers : [];
  const exact = list.find((b) => normName(b?.name) === target);
  if (exact) return exact;
  const partial = list.filter((b) => {
    const n = normName(b?.name);
    return n && (n.includes(target) || target.includes(n));
  });
  return partial.length === 1 ? partial[0] : null;
}

// The patch to merge over EMPTY_JOB before opening the "+ New job" modal.
// Every value is a string or a primitive the existing form already handles —
// saveJob() does the coercion, so nothing here pre-empts its normalization.
export function estimateToJobForm(parsed, { brokers = [], jobType = "full" } = {}) {
  const p = parsed || {};
  const broker = matchBroker(p.carrier_name, brokers);
  const str = (v) => (v == null ? "" : String(v));

  return {
    job_number: str(p.job_number),
    customer: str(p.customer),
    client_phone: str(p.client_phone),
    client_email: str(p.client_email),

    pickup_address: str(p.pickup_address),
    pickup_city: str(p.pickup_city),
    pickup_state: str(p.pickup_state),
    pickup_zip: str(p.pickup_zip),

    delivery_address: str(p.delivery_address),
    delivery_city: str(p.delivery_city),
    delivery_state: str(p.delivery_state),
    delivery_zip: str(p.delivery_zip),

    // saveJob() mirrors pickup_date from pickup_date_from; setting the range is
    // what actually puts the job on the pickup calendar.
    pickup_date_from: str(p.pickup_date_from),
    pickup_date_to: str(p.pickup_date_to || p.pickup_date_from),

    volume: str(p.volume_cf),
    price_per_cf: str(p.rate_per_cf),
    fuel_surcharge_pct: str(p.fuel_surcharge_pct),
    estimate: str(p.estimate_total),
    deposit: str(p.total_paid),
    // The estimates state the remaining balance is collected on delivery.
    delivery_balance: str(p.balance),

    broker_id: broker ? String(broker.id) : "",
    extra_stops: str(p.extra_stops),
    carrier_notes: str(p.comments),

    job_type: jobType,
    status: "scheduled",
    calendar_status: "active",
  };
}
