// Fixture tests for the inbound-job triage math (src/inboundJobData.js).
// Run: node scripts/test-inbound-job-data.mjs
//
// The two ESTIMATE bodies below are verbatim excerpts of real broker mails
// (Transit Moving Systems and Adam's Moving & Storage), asterisks and all —
// including the inconsistent "*Label: *value" vs "*Label:* value" markers that
// broke the first version of the parser. Do not "tidy" them.
import assert from "node:assert/strict";
import {
  num, parseMoney, normJobNumber, jobNumberFromSubject,
  parseUsDate, parseDateRange, parseCityStateZip, isZip,
  normalizeBody, allCityStateZip, regexProbe,
  normalizeExtraction, crossCheck, validateExtraction,
  pricingBasis, PRICING_BASIS, estimateToJobInput, matchBroker, estimateToJobForm,
} from "../src/inboundJobData.js";
import { evaluateJob, VERDICT } from "../src/jobCalcData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// ── fixtures ─────────────────────────────────────────────────────────────────

const TRANSIT_SUBJECT = "Moving Estimate-Job#TZ658134 / 1088592 Pick up date 8/1";
const TRANSIT_BODY = `$100 deposit

*TRANSIT MOVING SYSTEMS*

Phone: +1 (888) 668-7064

US DOT: 2845939

*Order ID:* 1088592

*Created on:* 7/29/2026

*Binding Moving Estimate*

*PICKUP: Lisa White*

*Address:* 9213 harrison run pl

*City, State, Zip:* Indianapolis, IN 46256

*Contact Phone 1:* Business (317) 289-1095

*Email:* lhwhite1954@gmail.com

*DELIVERY: Lisa White*

*Address:* 6633 royal okland place

*City, State, Zip:* Indianapolis, IN 46236

*GENERAL INFORMATION*

*Move Type:* Intrastate Move - Local

*Distance:* 5 miles

*Estimated Volume:* 1698 cf.

*Estimated Rate:* $1.47 per cf.

*Move Date: *8/1/2026 - 8/2/2026

*Minimum Labor Hours: *5 Hours

Basic Estimate Price: $2,496.06
Fuel Surcharge 15%: $374.41
Basic Valuation Protection ($0.60 per lb per article): $0.00
Stair Carry PU: $283.00
Discount: -$124.80
Total Moving Estimate: $3,028.67
Total Paid: $0.00
Balance: $3,028.67

*METHOD OF PAYMENT*

   - The remaining balance is due upon delivery, prior to unloading.`;

const ADAMS_SUBJECT = "Moving Estimate-Job#AZ658357 / 2087235 One day move monday 8/3";
const ADAMS_BODY = `$110 deposit

*Adam's Moving & Storage*
+1 (877) 418-2031
US DOT: 3028071

MC: 37945

*FLAT RATE MOVING ESTIMATE*

*CUSTOMER INFORMATION*

*Name: *David

*Primary Phone: * (816) 288-6372

*Email: *djdwatts@yahoo.com

*Job Number: *2087235

*Created on:* 7/17/2026

*PICK-UP DETAILS*

*Pick-up Address:* 3815 NE 51st Terrace

*City, State, Zip:* Kansas City, MO 64119

*Pickup Date: *8/3/2026 - 8/3/2026

*Estimated Volume: *1385 cf.

*Estimated Rate:* $1.44 per cf.

*DELIVERY DETAILS*

*Delivery Address:* PENDING

*City, State, Zip: *Kansas City, MO 64151

Extra Stop:

5415 NE Antioch Rd

KANSAS CITY, MO 64119

*Order Summary*

Basic Estimate Price: $1,994.40
Fuel Surcharge 15%: $299.16
Handling fee PU: $206.00
Total Moving Estimate: $2,499.56
Total Paid: $110.00
Balance: $2,389.56

*COMMENTS*

CUSTOMER IS PACKING ALL BOXES AND FRAGILE -- EXTRA STOP INCLUDED -`;

// What the AI extractor is expected to return for each mail.
const TRANSIT_AI = {
  carrier_name: "Transit Moving Systems", customer: "Lisa White",
  client_phone: "(317) 289-1095", client_email: "lhwhite1954@gmail.com",
  pickup_address: "9213 harrison run pl", pickup_city: "Indianapolis", pickup_state: "IN", pickup_zip: "46256",
  delivery_address: "6633 royal okland place", delivery_city: "Indianapolis", delivery_state: "IN", delivery_zip: "46236",
  pickup_date_from: "8/1/2026", pickup_date_to: "8/2/2026",
  volume_cf: 1698, rate_per_cf: 1.47, estimate_total: 3028.67, total_paid: 0, balance: 3028.67,
  move_type: "Intrastate Move - Local",
};
const ADAMS_AI = {
  carrier_name: "Adam's Moving & Storage", customer: "David",
  client_phone: "(816) 288-6372", client_email: "djdwatts@yahoo.com",
  pickup_address: "3815 NE 51st Terrace", pickup_city: "Kansas City", pickup_state: "MO", pickup_zip: "64119",
  delivery_address: "PENDING", delivery_city: "Kansas City", delivery_state: "MO", delivery_zip: "64151",
  pickup_date_from: "8/3/2026", pickup_date_to: "8/3/2026",
  volume_cf: 1385, rate_per_cf: 1.44, estimate_total: 2499.56, total_paid: 110, balance: 2389.56,
  extra_stops: "5415 NE Antioch Rd, KANSAS CITY, MO 64119",
  comments: "CUSTOMER IS PACKING ALL BOXES AND FRAGILE -- EXTRA STOP INCLUDED -",
};

// ── primitives ───────────────────────────────────────────────────────────────

t("parseMoney handles currency, thousands, parens, and trailing units", () => {
  assert.equal(parseMoney("$2,499.56"), 2499.56);
  assert.equal(parseMoney("(123.45)"), -123.45);
  assert.equal(parseMoney("-$124.80"), -124.80);
  assert.equal(parseMoney("$0.00"), 0);
  assert.equal(parseMoney("1698 cf."), 1698);
  assert.equal(parseMoney("5 miles"), 5);
  assert.equal(parseMoney(null), null);
  assert.equal(parseMoney("PENDING"), null);
});

t("parseMoney: '$1.47 per cf.' must not become NaN via the trailing period", () => {
  assert.equal(parseMoney("$1.47 per cf."), 1.47);
});

t("num mirrors jobCalcData: blank/null/NaN collapse to the fallback", () => {
  assert.equal(num(""), 0);
  assert.equal(num(null, 7), 7);
  assert.equal(num("12.5"), 12.5);
  assert.equal(num("abc", 3), 3);
});

t("normJobNumber matches the CRM's own normalization", () => {
  assert.equal(normJobNumber("  AZ658357 "), "az658357");
  assert.equal(normJobNumber(null), "");
});

// ── job numbers ──────────────────────────────────────────────────────────────

t("jobNumberFromSubject pulls the CRM number and the broker order id", () => {
  assert.deepEqual(jobNumberFromSubject(TRANSIT_SUBJECT), { job_number: "TZ658134", broker_job_number: "1088592" });
  assert.deepEqual(jobNumberFromSubject(ADAMS_SUBJECT), { job_number: "AZ658357", broker_job_number: "2087235" });
  assert.deepEqual(jobNumberFromSubject("Moving Estimate JoB#TZ658518 / 1089168 8/10 - 8/11"),
    { job_number: "TZ658518", broker_job_number: "1089168" });
});

t("purely numeric job numbers are found — the old regex needed a letter prefix", () => {
  // Real rows in the Jobs list: A1824813, HV4610476, FV8132068 and 26175872.
  assert.equal(jobNumberFromSubject("Bill of Lading to Carrier 4381382").job_number, "4381382");
  assert.equal(jobNumberFromSubject("job for 26175872").job_number, "26175872");
  assert.equal(jobNumberFromSubject("HV4610476 delivered").job_number, "HV4610476");
});

t("jobNumberFromSubject returns nulls instead of guessing on a subject with no id", () => {
  assert.deepEqual(jobNumberFromSubject("Re: your move"), { job_number: null, broker_job_number: null });
  assert.deepEqual(jobNumberFromSubject(""), { job_number: null, broker_job_number: null });
  assert.deepEqual(jobNumberFromSubject(null), { job_number: null, broker_job_number: null });
});

// ── dates ────────────────────────────────────────────────────────────────────

t("parseUsDate converts US dates and passes ISO through", () => {
  assert.equal(parseUsDate("8/3/2026"), "2026-08-03");
  assert.equal(parseUsDate("12/25/26"), "2026-12-25");
  assert.equal(parseUsDate("2026-08-03"), "2026-08-03");
});

t("parseUsDate returns null rather than an invalid date — a wrong pickup date is worse than none", () => {
  assert.equal(parseUsDate("13/45/2026"), null);
  assert.equal(parseUsDate("PENDING"), null);
  assert.equal(parseUsDate(""), null);
  assert.equal(parseUsDate(null), null);
});

t("parseDateRange handles ranges, single dates and reversed ranges", () => {
  assert.deepEqual(parseDateRange("8/1/2026 - 8/2/2026"), { from: "2026-08-01", to: "2026-08-02" });
  assert.deepEqual(parseDateRange("8/3/2026"), { from: "2026-08-03", to: "2026-08-03" });
  assert.deepEqual(parseDateRange("8/5/2026 - 8/1/2026"), { from: "2026-08-01", to: "2026-08-05" });
  assert.deepEqual(parseDateRange(""), { from: null, to: null });
});

// ── addresses ────────────────────────────────────────────────────────────────

t("parseCityStateZip splits the city/state/zip line", () => {
  assert.deepEqual(parseCityStateZip("Indianapolis, IN 46256"), { city: "Indianapolis", state: "IN", zip: "46256" });
  assert.deepEqual(parseCityStateZip("Kansas City, MO 64119"), { city: "Kansas City", state: "MO", zip: "64119" });
  assert.deepEqual(parseCityStateZip("Boca Raton, FL 33487-1234"), { city: "Boca Raton", state: "FL", zip: "33487" });
});

t("parseCityStateZip degrades to a bare zip when the line is malformed", () => {
  assert.deepEqual(parseCityStateZip("somewhere 46256"), { city: null, state: null, zip: "46256" });
  assert.deepEqual(parseCityStateZip("PENDING"), { city: null, state: null, zip: null });
});

t("isZip only accepts 5 digits", () => {
  assert.equal(isZip("46256"), true);
  assert.equal(isZip("4625"), false);
  assert.equal(isZip(null), false);
});

// ── regex probe ──────────────────────────────────────────────────────────────

t("normalizeBody strips the markdown bold markers that sit on either side of the colon", () => {
  assert.match(normalizeBody("*Estimated Volume: *1385 cf."), /Estimated Volume: 1385 cf\./);
  assert.match(normalizeBody("*Estimated Rate:* $1.44 per cf."), /Estimated Rate: \$1\.44 per cf\./);
});

t("regexProbe reads Transit's numbers off the raw body", () => {
  const p = regexProbe(TRANSIT_BODY);
  assert.equal(p.volume_cf, 1698);
  assert.equal(p.rate_per_cf, 1.47);
  assert.equal(p.fuel_surcharge_pct, 15);
  assert.equal(p.estimate_total, 3028.67);
  assert.equal(p.total_paid, 0);
  assert.equal(p.balance, 3028.67);
  assert.equal(p.distance_miles, 5);
  assert.deepEqual(p.zips, ["46256", "46236"]);
});

t("regexProbe reads Adam's numbers despite different labels and a missing Distance line", () => {
  const p = regexProbe(ADAMS_BODY);
  assert.equal(p.volume_cf, 1385);
  assert.equal(p.rate_per_cf, 1.44);
  assert.equal(p.estimate_total, 2499.56);
  assert.equal(p.total_paid, 110);
  assert.equal(p.balance, 2389.56);
  assert.equal(p.distance_miles, null, "Adam's estimates carry no Distance line");
  assert.deepEqual(p.zips, ["64119", "64151"]);
});

t("allCityStateZip ignores the Extra Stop address, which has no City/State/Zip label", () => {
  // The extra stop is "KANSAS CITY, MO 64119" on its own lines — it must not
  // become a third candidate zip.
  assert.equal(allCityStateZip(ADAMS_BODY).length, 2);
});

// ── normalization ────────────────────────────────────────────────────────────

t("normalizeExtraction produces the canonical object for Transit", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  assert.equal(p.job_number, "TZ658134");
  assert.equal(p.broker_job_number, "1088592");
  assert.equal(p.customer, "Lisa White");
  assert.equal(p.pickup_zip, "46256");
  assert.equal(p.delivery_zip, "46236");
  assert.equal(p.pickup_date_from, "2026-08-01");
  assert.equal(p.pickup_date_to, "2026-08-02");
  assert.equal(p.volume_cf, 1698);
  assert.equal(p.estimate_total, 3028.67);
  assert.equal(p.distance_miles, 5);
});

t("normalizeExtraction blanks broker placeholders: PENDING delivery address becomes null", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  assert.equal(p.delivery_address, null, "'PENDING' is not an address");
  assert.equal(p.delivery_zip, "64151", "...but the zip is still there, so the job is priceable");
  assert.equal(p.delivery_city, "Kansas City");
});

t("normalizeExtraction takes the job number from the subject when the model omits it", () => {
  const p = normalizeExtraction({ ...ADAMS_AI, job_number: null }, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  assert.equal(p.job_number, "AZ658357");
});

t("the deterministic probe overrides the model's numbers", () => {
  const lying = { ...TRANSIT_AI, volume_cf: 9999, estimate_total: 99999 };
  const p = normalizeExtraction(lying, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  assert.equal(p.volume_cf, 1698);
  assert.equal(p.estimate_total, 3028.67);
});

t("normalizeExtraction is total: garbage in still yields a complete object", () => {
  const p = normalizeExtraction(null, { subject: "", body: "" });
  assert.equal(p.job_number, null);
  assert.equal(p.volume_cf, null);
  assert.equal(p.pickup_date_from, null);
  assert.ok("delivery_zip" in p);
});

// ── cross-check ──────────────────────────────────────────────────────────────

t("crossCheck is silent when the model agrees with the source", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  assert.deepEqual(crossCheck(p, TRANSIT_BODY), []);
});

t("crossCheck catches a hallucinated zip that never appears in the mail", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const issues = crossCheck({ ...p, delivery_zip: "90210" }, TRANSIT_BODY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "delivery_zip");
  assert.equal(issues[0].model, "90210");
});

t("crossCheck catches a fabricated amount", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const issues = crossCheck({ ...p, balance: 1 }, TRANSIT_BODY);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].field, "balance");
  assert.equal(issues[0].source, 3028.67);
});

// ── validation ───────────────────────────────────────────────────────────────

t("both real estimates validate clean", () => {
  for (const [ai, subject, body] of [[TRANSIT_AI, TRANSIT_SUBJECT, TRANSIT_BODY], [ADAMS_AI, ADAMS_SUBJECT, ADAMS_BODY]]) {
    const v = validateExtraction(normalizeExtraction(ai, { subject, body }));
    assert.equal(v.ok, true, "blocking: " + v.blocking.join(", "));
  }
});

t("a missing delivery zip blocks: no zip means no distance means no honest price", () => {
  const p = normalizeExtraction({ ...ADAMS_AI, delivery_zip: null }, { subject: ADAMS_SUBJECT, body: "" });
  const v = validateExtraction(p);
  assert.equal(v.ok, false);
  assert.ok(v.blocking.includes("delivery_zip"));
});

t("a missing street address does NOT block — it is merely incomplete", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  const v = validateExtraction(p);
  assert.equal(v.ok, true);
  assert.ok(v.missing.includes("delivery_address"));
});

t("zero volume blocks, and so does having neither job number nor customer", () => {
  const base = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  assert.ok(validateExtraction({ ...base, volume_cf: 0 }).blocking.includes("volume_cf"));
  assert.ok(validateExtraction({ ...base, job_number: null, customer: null }).blocking.includes("job_number_or_customer"));
});

// ── pricing basis ────────────────────────────────────────────────────────────

t("with a carrier rate, revenue is rate x cuFt and nothing is assumed", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const b = pricingBasis(p, { carrierRatePerCf: 1.10 });
  assert.equal(b.basis, PRICING_BASIS.CARRIER_RATE);
  assert.equal(b.assumed, false);
  assert.ok(Math.abs(b.brokerPrice - 1698 * 1.10) < 0.001);
});

t("without a carrier rate it falls back to the customer total and flags itself as assumed", () => {
  // This is the difference between "we get paid $1,867" and "the customer pays
  // $3,028" — pricing off the latter overstates profit on every job.
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const b = pricingBasis(p, {});
  assert.equal(b.basis, PRICING_BASIS.CUSTOMER_TOTAL);
  assert.equal(b.assumed, true);
  assert.equal(b.brokerPrice, 3028.67);
});

t("a blank or zero carrier rate counts as no rate, not as free", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  assert.equal(pricingBasis(p, { carrierRatePerCf: "" }).assumed, true);
  assert.equal(pricingBasis(p, { carrierRatePerCf: 0 }).assumed, true);
});

// ── mapping to the calculator ────────────────────────────────────────────────

t("estimateToJobInput produces exactly the shape evaluateJob documents", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const input = estimateToJobInput(p, { carrierRatePerCf: 1.10 });
  assert.deepEqual(Object.keys(input).sort(), [
    "brokerPrice", "cuFt", "destAccess", "destZip", "drivers", "helpers",
    "longCarry", "originAccess", "originZip", "shuttle", "trucks",
  ]);
  assert.equal(input.originZip, "46256");
  assert.equal(input.destZip, "46236");
  assert.equal(input.cuFt, 1698);
  assert.equal(input.originAccess, "direct", "estimates never state access; direct = multiplier 1.0");
});

t("the mapped input actually prices through the real calculator", () => {
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const input = estimateToJobInput(p, { carrierRatePerCf: 1.10 });
  const r = evaluateJob(input, {}, { loadedMiles: 5, deadheadMiles: 40 });
  assert.ok(Number.isFinite(r.operatingMargin));
  assert.ok(Number.isFinite(r.contributionPerTruckDay));
  assert.ok([VERDICT.RED, VERDICT.YELLOW, VERDICT.GREEN].includes(r.verdict));
  assert.equal(r.totalMiles, 45);
});

t("a job with no known miles still prices instead of crashing", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  const r = evaluateJob(estimateToJobInput(p, { carrierRatePerCf: 1.0 }), {}, {});
  assert.equal(r.totalMiles, 0);
  assert.ok(Number.isFinite(r.variableCost));
});

// ── broker matching ──────────────────────────────────────────────────────────

const BROKERS = [{ id: 3, name: "Adams Moving" }, { id: 7, name: "Transit Moving Systems" }, { id: 9, name: "Compass Moving Group" }];

t("matchBroker resolves exact and punctuation-insensitive names", () => {
  assert.equal(matchBroker("Transit Moving Systems", BROKERS).id, 7);
  assert.equal(matchBroker("Adam's Moving & Storage", BROKERS).id, 3, "'Adams Moving' is contained in the mail's name");
});

t("matchBroker refuses to guess when nothing matches, or when only ambiguous partials do", () => {
  assert.equal(matchBroker("Totally Unknown Movers", BROKERS), null);
  assert.equal(matchBroker("", BROKERS), null);
  assert.equal(matchBroker(null, BROKERS), null);
  // Two partial candidates and no exact hit → refuse rather than pick one.
  assert.equal(matchBroker("Moving", [{ id: 1, name: "Moving Co" }, { id: 2, name: "Moving Inc" }]), null);
});

t("an exact name match wins even when other partials exist", () => {
  assert.equal(matchBroker("Moving", [{ id: 1, name: "Moving" }, { id: 2, name: "Moving Co" }]).id, 1);
});

// ── mapping to the job form ──────────────────────────────────────────────────

t("estimateToJobForm fills the fields the Jobs form owns", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  const f = estimateToJobForm(p, { brokers: BROKERS });
  assert.equal(f.job_number, "AZ658357");
  assert.equal(f.customer, "David");
  assert.equal(f.client_phone, "(816) 288-6372");
  assert.equal(f.client_email, "djdwatts@yahoo.com");
  assert.equal(f.pickup_city, "Kansas City");
  assert.equal(f.pickup_zip, "64119");
  assert.equal(f.delivery_zip, "64151");
  assert.equal(f.volume, "1385");
  assert.equal(f.price_per_cf, "1.44");
  assert.equal(f.estimate, "2499.56");
  assert.equal(f.deposit, "110");
  assert.equal(f.delivery_balance, "2389.56", "the estimates state the balance is collected on delivery");
  assert.equal(f.broker_id, "3");
});

t("estimateToJobForm sets the dates that put the job on the pickup calendar", () => {
  // src/App.jsx:4591 — a job is on the calendar iff pickup_date_from (or the
  // legacy pickup_date, which saveJob mirrors) is non-null.
  const p = normalizeExtraction(TRANSIT_AI, { subject: TRANSIT_SUBJECT, body: TRANSIT_BODY });
  const f = estimateToJobForm(p, { brokers: BROKERS });
  assert.equal(f.pickup_date_from, "2026-08-01");
  assert.equal(f.pickup_date_to, "2026-08-02");
  assert.equal(f.calendar_status, "active");
  assert.equal(f.status, "scheduled");
});

t("estimateToJobForm emits strings only, so saveJob's own coercion still runs", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  const f = estimateToJobForm(p, { brokers: [] });
  for (const [k, v] of Object.entries(f)) {
    assert.equal(typeof v, "string", `${k} should be a string, got ${typeof v}`);
  }
  assert.equal(f.broker_id, "", "an unmatched carrier leaves the broker unset rather than guessing");
  assert.equal(f.delivery_address, "", "PENDING became null and serializes to an empty field");
});

t("a single-day pickup gets an equal from/to so it occupies exactly one calendar day", () => {
  const p = normalizeExtraction(ADAMS_AI, { subject: ADAMS_SUBJECT, body: ADAMS_BODY });
  const f = estimateToJobForm(p, { brokers: BROKERS });
  assert.equal(f.pickup_date_from, "2026-08-03");
  assert.equal(f.pickup_date_to, "2026-08-03");
});

console.log(process.exitCode ? "\nSOME INBOUND-JOB TESTS FAILED" : "\nALL INBOUND-JOB TESTS PASSED");
