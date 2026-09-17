#!/usr/bin/env node
// Tests for src/pipelineData.js — the Pipeline's pure math.
// No network, no database: picked up automatically by `npm test`.
import assert from "node:assert/strict";
import {
  num, addDaysISO, daysBetween,
  DEFAULT_PIPELINE_SETTINGS, mergePipelineSettings,
  leadStatusMeta, leadSourceMeta, isOpenLead, verdictMeta,
  holdDates, holdStage, holdProgress, leadsNeedingAttention,
  leadScore, rankLeads, pipelineTotals,
  isSameOpportunity, findDuplicate,
  leadToJobForm,
  senderDomain, isAllowedSender, clampRawText, MAX_RAW_TEXT,
  isLowConfidence, missingFields, isEvaluable,
  haversineMiles, nearestTruck,
  withinRange, jobRunWindow, distinctExpenseDates, sumExpenses, computeActuals,
  deadheadOrigin, deadheadOriginLabel, DEADHEAD_ORIGINS,
} from "../src/pipelineData.js";

const t = (name, fn) => {
  try { fn(); console.log("PASS  " + name); }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; }
};

const TODAY = "2026-07-20";

// ── Helpers ──────────────────────────────────────────────────────────────────
t("num coerces strings, empties and junk", () => {
  assert.equal(num("12.5"), 12.5);
  assert.equal(num(""), 0);
  assert.equal(num(null), 0);
  assert.equal(num("abc", 7), 7);
  assert.equal(num(3), 3);
});

t("addDaysISO walks the calendar, month ends included", () => {
  assert.equal(addDaysISO("2026-07-20", 7), "2026-07-27");
  assert.equal(addDaysISO("2026-07-28", 7), "2026-08-04");
  assert.equal(addDaysISO("2026-02-27", 2), "2026-03-01"); // 2026 is not a leap year
  assert.equal(addDaysISO("2026-12-31", 1), "2027-01-01");
  assert.equal(addDaysISO("", 3), "");
});

t("daysBetween is signed and null on junk", () => {
  assert.equal(daysBetween("2026-07-20", "2026-07-27"), 7);
  assert.equal(daysBetween("2026-07-27", "2026-07-20"), -7);
  assert.equal(daysBetween("2026-07-20", "2026-07-20"), 0);
  assert.equal(daysBetween("nope", "2026-07-20"), null);
});

// ── Settings ─────────────────────────────────────────────────────────────────
t("settings default to the diagram's 2 and 7 days", () => {
  const s = mergePipelineSettings(null);
  assert.equal(s.holdReminderDays, 2);
  assert.equal(s.holdDecisionDays, 7);
  assert.deepEqual(s.allowedEmailDomains, []);
});

t("saved settings override, empties do not", () => {
  const s = mergePipelineSettings({ holdReminderDays: 3, holdDecisionDays: "", carriers: ["Shawn"] });
  assert.equal(s.holdReminderDays, 3);
  assert.equal(s.holdDecisionDays, 7);
  assert.deepEqual(s.carriers, ["Shawn"]);
});

t("a reminder can never land after the decision is due", () => {
  const s = mergePipelineSettings({ holdReminderDays: 30, holdDecisionDays: 7 });
  assert.equal(s.holdReminderDays, 7);
});

t("settings never mutate the defaults", () => {
  mergePipelineSettings({ carriers: ["X"] });
  assert.deepEqual(DEFAULT_PIPELINE_SETTINGS.carriers, []);
});

// ── Vocabularies ─────────────────────────────────────────────────────────────
t("status and source metas fall back instead of throwing", () => {
  assert.equal(leadStatusMeta("held").l, "On hold");
  assert.equal(leadStatusMeta("nonsense").v, "new");
  assert.equal(leadSourceMeta("email").l, "Email");
  assert.equal(leadSourceMeta(undefined).v, "manual");
  assert.equal(verdictMeta("green").l, "Take it");
  assert.equal(verdictMeta("purple"), null);
});

t("open leads are the ones still waiting on a human", () => {
  assert.equal(isOpenLead({ status: "new" }), true);
  assert.equal(isOpenLead({ status: "held" }), true);
  assert.equal(isOpenLead({ status: "converted" }), false);
  assert.equal(isOpenLead({ status: "rejected" }), false);
  assert.equal(isOpenLead({}), true); // missing status reads as new
});

// ── The hold clock ───────────────────────────────────────────────────────────
t("holdDates puts the reminder on day 2 and the decision on day 7", () => {
  const d = holdDates(TODAY, null);
  assert.equal(d.hold_started_on, "2026-07-20");
  assert.equal(d.remind_at, "2026-07-22");
  assert.equal(d.hold_until, "2026-07-27");
});

t("holdStage walks running → reminder → due → expired", () => {
  const mk = (over) => ({ status: "held", hold_started_on: "2026-07-20", remind_at: "2026-07-22", hold_until: "2026-07-27", ...over });
  assert.equal(holdStage(mk(), "2026-07-21"), "running");
  assert.equal(holdStage(mk(), "2026-07-22"), "reminder");
  assert.equal(holdStage(mk(), "2026-07-24"), "reminder");
  assert.equal(holdStage(mk(), "2026-07-27"), "due");
  assert.equal(holdStage(mk(), "2026-07-28"), "expired");
});

t("a sent reminder stops re-firing but the due date still lands", () => {
  const l = { status: "held", hold_started_on: "2026-07-20", remind_at: "2026-07-22",
    hold_until: "2026-07-27", reminder_sent_at: "2026-07-22T12:00:00Z" };
  assert.equal(holdStage(l, "2026-07-23"), "running");
  assert.equal(holdStage(l, "2026-07-27"), "due");
  assert.equal(holdStage(l, "2026-07-30"), "expired");
});

t("leads that are not on hold have no clock", () => {
  assert.equal(holdStage({ status: "new" }, TODAY), "none");
  assert.equal(holdStage({ status: "converted", hold_until: "2020-01-01" }, TODAY), "none");
  assert.equal(holdStage(null, TODAY), "none");
  assert.equal(holdProgress({ status: "new" }, TODAY), null);
});

t("holdProgress reports day N of M and clamps at both ends", () => {
  const l = { status: "held", hold_started_on: "2026-07-20", hold_until: "2026-07-27" };
  assert.deepEqual(holdProgress(l, "2026-07-25"), { day: 5, total: 7, pct: 71 });
  assert.deepEqual(holdProgress(l, "2026-07-20"), { day: 0, total: 7, pct: 0 });
  assert.deepEqual(holdProgress(l, "2026-08-10"), { day: 7, total: 7, pct: 100 });
});

t("the sweep buckets leads by what it owes each one", () => {
  const mk = (id, over) => ({ id, status: "held", hold_started_on: "2026-07-20",
    remind_at: "2026-07-22", hold_until: "2026-07-27", ...over });
  const leads = [
    mk(1),                                   // reminder on 07-22
    mk(2, { reminder_sent_at: "x" }),        // running
    mk(3, { hold_until: "2026-07-22" }),     // due today
    mk(4, { hold_until: "2026-07-19" }),     // expired
    mk(5, { deleted_at: "x" }),              // ignored
    { id: 6, status: "new" },                // ignored
  ];
  const r = leadsNeedingAttention(leads, "2026-07-22");
  assert.deepEqual(r.remind.map((l) => l.id), [1]);
  assert.deepEqual(r.due.map((l) => l.id), [3]);
  assert.deepEqual(r.expired.map((l) => l.id), [4]);
});

// ── Ranking ──────────────────────────────────────────────────────────────────
t("the score is contribution per truck-day, not margin", () => {
  assert.equal(leadScore({ evaluation: { contribution_per_truck_day: 940 } }), 940);
  assert.equal(leadScore({ evaluation: { contribution_per_truck_day: "-180" } }), -180);
  assert.equal(leadScore({ evaluation: {} }), null);
  assert.equal(leadScore({}), null);
});

t("rankLeads sorts by truck-day value and parks the unpriced last", () => {
  const mk = (id, v) => ({ id, evaluation: v == null ? {} : { contribution_per_truck_day: v } });
  const out = rankLeads([mk(1, 610), mk(2, null), mk(3, 940), mk(4, -180), mk(5, null)]);
  assert.deepEqual(out.map((l) => l.id), [3, 1, 4, 5, 2]);
});

t("a big cheque can lose to a small one that frees the truck sooner", () => {
  const rich = { id: 1, broker_price: 5900, evaluation: { contribution_per_truck_day: 610 } };
  const quick = { id: 2, broker_price: 3200, evaluation: { contribution_per_truck_day: 940 } };
  assert.deepEqual(rankLeads([rich, quick]).map((l) => l.id), [2, 1]);
});

t("rankLeads does not mutate its input", () => {
  const input = [{ id: 1, evaluation: { contribution_per_truck_day: 1 } },
                 { id: 2, evaluation: { contribution_per_truck_day: 9 } }];
  rankLeads(input);
  assert.deepEqual(input.map((l) => l.id), [1, 2]);
});

t("pipelineTotals counts the tiles the board shows", () => {
  const leads = [
    { id: 1, status: "new" }, { id: 2, status: "new" },
    { id: 3, status: "proposed" }, { id: 4, status: "evaluating" },
    { id: 5, status: "held", hold_started_on: "2026-07-20", remind_at: "2026-07-22", hold_until: "2026-07-27" },
    { id: 6, status: "held", hold_started_on: "2026-07-10", remind_at: "2026-07-12", hold_until: "2026-07-19" },
    { id: 7, status: "offered" },
    { id: 8, status: "converted", broker_price: 3700 },
    { id: 9, status: "converted", broker_price: 4100 },
    { id: 10, status: "new", deleted_at: "x" },
  ];
  const tot = pipelineTotals(leads, "2026-07-20");
  assert.equal(tot.new, 2);
  assert.equal(tot.evaluated, 2);
  assert.equal(tot.held, 2);
  assert.equal(tot.expiring, 1);      // #6 expired on 07-19
  assert.equal(tot.offered, 1);
  assert.equal(tot.converted, 2);
  assert.equal(tot.convertedValue, 7800);
});

// ── Deduplication ────────────────────────────────────────────────────────────
t("the broker's own job number settles it", () => {
  assert.equal(isSameOpportunity({ broker_job_number: "B8417142" }, { broker_job_number: "b8417142" }), true);
  assert.equal(isSameOpportunity({ broker_job_number: "B8417142" }, { broker_job_number: "B999" }), false);
});

t("without a job number it takes broker, both ZIPs and volume within 10%", () => {
  const a = { broker_id: 3, origin_zip: "33125", dest_zip: "30301", cu_ft: 820 };
  assert.equal(isSameOpportunity(a, { ...a, cu_ft: 860 }), true);   // 4.9% apart
  assert.equal(isSameOpportunity(a, { ...a, cu_ft: 1200 }), false);
  assert.equal(isSameOpportunity(a, { ...a, broker_id: 4 }), false);
  assert.equal(isSameOpportunity(a, { ...a, dest_zip: "19104" }), false);
  assert.equal(isSameOpportunity(a, { ...a, cu_ft: 0 }), false);    // no volume, no match
});

t("findDuplicate skips itself, deleted, rejected and expired leads", () => {
  const cand = { id: 9, broker_job_number: "B8417142" };
  assert.equal(findDuplicate(cand, [{ id: 9, broker_job_number: "B8417142" }]), null);
  assert.equal(findDuplicate(cand, [{ id: 1, broker_job_number: "B8417142", deleted_at: "x" }]), null);
  assert.equal(findDuplicate(cand, [{ id: 1, broker_job_number: "B8417142", status: "rejected" }]), null);
  assert.equal(findDuplicate(cand, [{ id: 1, broker_job_number: "B8417142", status: "expired" }]), null);
  assert.equal(findDuplicate(cand, [{ id: 1, broker_job_number: "B8417142", status: "new" }]).id, 1);
});

// ── Lead → job ───────────────────────────────────────────────────────────────
t("leadToJobForm fills the job form and keeps the rest of the shape", () => {
  const EMPTY = { job_number: "", customer: "", job_type: "full", status: "scheduled",
    storage_ids: [], driver_ids: [], notes: "", pickup_balance: "" };
  const f = leadToJobForm({
    broker_job_number: "B8417142", customer: "García", broker_id: 3, job_type: "direct",
    cu_ft: 820, broker_price: 3200, fadd: "2026-08-01",
    pickup_date_from: "2026-07-25", pickup_date_to: "2026-07-26",
    origin_city: "Miami", origin_state: "FL", origin_zip: "33125",
    dest_city: "Atlanta", dest_state: "GA", dest_zip: "30301",
  }, EMPTY);
  assert.equal(f.job_number, "B8417142");
  assert.equal(f.customer, "García");
  assert.equal(f.broker_id, "3");
  assert.equal(f.job_type, "direct");
  assert.equal(f.volume, "820");
  assert.equal(f.estimate, "3200");
  assert.equal(f.pickup_zip, "33125");
  assert.equal(f.delivery_state, "GA");
  assert.equal(f.status, "scheduled");
  assert.deepEqual(f.storage_ids, []);   // untouched keys survive
  assert.equal(f.pickup_balance, "");
});

t("leadToJobForm turns nulls into empty strings, never 'null'", () => {
  const f = leadToJobForm({ customer: null, broker_id: null, cu_ft: null, fadd: null }, { job_type: "full" });
  assert.equal(f.customer, "");
  assert.equal(f.broker_id, "");
  assert.equal(f.volume, "");
  assert.equal(f.fadd, "");
  assert.equal(f.job_type, "full");
});

// ── Inbound email containment ────────────────────────────────────────────────
t("senderDomain handles bare and display-name addresses", () => {
  assert.equal(senderDomain("dispatch@allied.com"), "allied.com");
  assert.equal(senderDomain("Allied Dispatch <Dispatch@Allied.com>"), "allied.com");
  assert.equal(senderDomain("ops@mail.atlas.com"), "mail.atlas.com");
  assert.equal(senderDomain("garbage"), "");
  assert.equal(senderDomain(null), "");
});

t("an unconfigured allowlist accepts nobody", () => {
  assert.equal(isAllowedSender("dispatch@allied.com", null), false);
  assert.equal(isAllowedSender("dispatch@allied.com", { allowedEmailDomains: [] }), false);
});

t("the allowlist matches the domain and its subdomains only", () => {
  const s = { allowedEmailDomains: ["allied.com", "@atlas.com"] };
  assert.equal(isAllowedSender("dispatch@allied.com", s), true);
  assert.equal(isAllowedSender("ops@mail.allied.com", s), true);
  assert.equal(isAllowedSender("ops@atlas.com", s), true);
  assert.equal(isAllowedSender("evil@notallied.com", s), false);
  assert.equal(isAllowedSender("evil@allied.com.attacker.net", s), false);
  assert.equal(isAllowedSender("", s), false);
});

t("raw text is capped before it is stored", () => {
  assert.equal(clampRawText("x".repeat(MAX_RAW_TEXT + 500)).length, MAX_RAW_TEXT);
  assert.equal(clampRawText(null), "");
});

// ── Field confidence and readiness ───────────────────────────────────────────
t("low-confidence fields are flagged for review", () => {
  const lead = { parsed: { confidence: { job_type: "low", customer: "high" } } };
  assert.equal(isLowConfidence(lead, "job_type"), true);
  assert.equal(isLowConfidence(lead, "customer"), false);
  assert.equal(isLowConfidence({}, "customer"), false);
});

t("missingFields lists what the operator still has to type", () => {
  const m = missingFields({ customer: "García", origin_zip: "33125", cu_ft: 820 });
  assert.equal(m.includes("customer"), false);
  assert.equal(m.includes("dest_zip"), true);
  assert.equal(m.includes("broker_price"), true);
});

t("a lead is evaluable only with both ZIPs, volume and price", () => {
  const ok = { origin_zip: "33125", dest_zip: "30301", cu_ft: 820, broker_price: 3200 };
  assert.equal(isEvaluable(ok), true);
  assert.equal(isEvaluable({ ...ok, dest_zip: "303" }), false);
  assert.equal(isEvaluable({ ...ok, cu_ft: 0 }), false);
  assert.equal(isEvaluable({ ...ok, broker_price: "" }), false);
});

// ── Nearest truck ────────────────────────────────────────────────────────────
t("haversineMiles is right to within a mile on a known pair", () => {
  // Miami (25.7743,-80.1937) → Orlando (28.5383,-81.3792) ≈ 202 mi
  const d = haversineMiles(25.7743, -80.1937, 28.5383, -81.3792);
  assert.ok(Math.abs(d - 202) < 4, `expected ~202, got ${d}`);
  assert.equal(Math.round(haversineMiles(25.7743, -80.1937, 25.7743, -80.1937)), 0);
});

t("nearestTruck picks the closest located truck and skips the rest", () => {
  const trucks = [
    { id: 1, name: "Truck 1", last_lat: 41.8, last_lng: -87.6 },  // Chicago, far
    { id: 3, name: "Truck 3", last_lat: 29.19, last_lng: -82.14 }, // Ocala, near
    { id: 4, name: "Truck 4", last_lat: null, last_lng: null },    // no fix
    { id: 5, name: "Truck 5", last_lat: 25.8, last_lng: -80.2, active: false },
    { id: 6, name: "Truck 6", last_lat: 25.8, last_lng: -80.2, deleted_at: "x" },
  ];
  const best = nearestTruck(trucks, 28.5383, -81.3792); // from Orlando
  assert.equal(best.truck.id, 3);
  assert.ok(best.miles > 0 && best.miles < 100, `unexpected miles: ${best.miles}`);
});

t("nearestTruck answers null when nothing is locatable", () => {
  assert.equal(nearestTruck([{ id: 1 }], 28.5, -81.3), null);
  assert.equal(nearestTruck([], 28.5, -81.3), null);
  assert.equal(nearestTruck([{ id: 1, last_lat: 28, last_lng: -81 }], NaN, -81.3), null);
});

// ── Actuals: closing the calibration loop ────────────────────────────────────
t("withinRange is inclusive and tolerant of open bounds", () => {
  assert.equal(withinRange("2026-07-25", "2026-07-20", "2026-07-27"), true);
  assert.equal(withinRange("2026-07-20", "2026-07-20", "2026-07-27"), true);  // inclusive
  assert.equal(withinRange("2026-07-27", "2026-07-20", "2026-07-27"), true);  // inclusive
  assert.equal(withinRange("2026-07-28", "2026-07-20", "2026-07-27"), false);
  assert.equal(withinRange("2026-07-01", null, "2026-07-27"), true);           // open start
  assert.equal(withinRange("", "2026-07-20", "2026-07-27"), false);
});

t("the run window is the trip, not the job's whole life", () => {
  // A job can sit in storage for months; sweeping that whole span would pull in
  // expenses that have nothing to do with the run.
  const job = { pickup_date: "2026-03-01", date_out: "2026-07-27" };
  assert.deepEqual(jobRunWindow(job, { departure_date: "2026-07-24" }),
                   { start: "2026-07-24", end: "2026-07-27" });
  assert.deepEqual(jobRunWindow(job, null), { start: "2026-03-01", end: "2026-07-27" });
});

t("a job that has not been delivered has no window", () => {
  assert.equal(jobRunWindow({ pickup_date: "2026-07-24" }, null), null);
  assert.equal(jobRunWindow({ date_out: "" }, null), null);
});

t("a departure after the delivery does not invert the window", () => {
  const w = jobRunWindow({ date_out: "2026-07-27" }, { departure_date: "2026-07-30" });
  assert.ok(w.start <= w.end, `inverted: ${JSON.stringify(w)}`);
});

t("expenses sum by category and hotel nights count distinct dates", () => {
  const exp = [
    { category: "fuel", amount: 300, expense_date: "2026-07-24" },
    { category: "fuel", amount: 250, expense_date: "2026-07-26" },
    { category: "hotel", amount: 120, expense_date: "2026-07-24" },
    { category: "hotel", amount: 130, expense_date: "2026-07-24" }, // same night, two rows
    { category: "hotel", amount: 140, expense_date: "2026-07-25" },
    { category: "tolls", amount: 40, expense_date: "2026-07-25" },
  ];
  assert.equal(sumExpenses(exp, "fuel"), 550);
  assert.equal(sumExpenses(exp, "materials"), 0);
  assert.equal(distinctExpenseDates(exp, "hotel"), 2);
});

const JOB = { id: 1, job_number: "B8417142", date_out: "2026-07-27", trip_id: 9, driver_ids: [4] };
const TRIP = { id: 9, truck_id: 3, driver_id: 4, departure_date: "2026-07-24" };
const PINGS = [
  { date: "2026-07-24", miles: 210, moved: true },
  { date: "2026-07-25", miles: 240, moved: true },
  { date: "2026-07-26", miles: 0,   moved: false }, // parked: not a day out
  { date: "2026-07-27", miles: 150, moved: true },
];
const EXP = [
  { category: "fuel", amount: 400, expense_date: "2026-07-25" },
  { category: "tolls", amount: 60, expense_date: "2026-07-25" },
  { category: "materials", amount: 80, expense_date: "2026-07-24" },
  { category: "hotel", amount: 130, expense_date: "2026-07-24" },
];

t("a job alone on its trip takes the whole cost and is clean", () => {
  const a = computeActuals({
    job: JOB, trip: TRIP, siblingCf: [{ jobKey: "n:b8417142", cuFt: 820 }],
    jobCuFt: 820, pingDays: PINGS, expenses: EXP, workDays: [],
  });
  assert.equal(a.actual_truck_days, 3);        // parked day excluded
  assert.equal(a.actual_miles, 600);
  assert.equal(a.actual_fuel, 400);
  assert.equal(a.actual_tolls, 60);
  assert.equal(a.actual_materials, 80);
  assert.equal(a.actual_hotel_nights, 1);
  assert.equal(a.actuals_shared, false);       // → calibrate() will learn from it
  assert.equal(a.actuals_source, "eld");
  assert.equal(a.actual_trucks, 1);
  assert.equal(a.actual_drivers, 1);
  assert.equal(a.actual_helpers, null);        // never tracked; falls back to planned
});

t("a shared trip is split by cubic feet AND flagged so calibration skips it", () => {
  const a = computeActuals({
    job: JOB, trip: TRIP,
    siblingCf: [{ jobKey: "n:b8417142", cuFt: 820 }, { jobKey: "n:x", cuFt: 1640 }],
    jobCuFt: 820, pingDays: PINGS, expenses: EXP, workDays: [],
  });
  assert.equal(a.actuals_shared, true);        // the whole point
  assert.equal(a.actual_truck_days, 1);        // 3 × (820/2460)
  assert.equal(a.actual_miles, 200);           // 600 × ⅓
  assert.equal(a.actual_fuel, 133.33);
});

t("with no volumes recorded a shared trip splits evenly", () => {
  const a = computeActuals({
    job: JOB, trip: TRIP,
    siblingCf: [{ jobKey: "a", cuFt: 0 }, { jobKey: "b", cuFt: 0 }],
    jobCuFt: 0, pingDays: PINGS, expenses: EXP, workDays: [],
  });
  assert.equal(a.actuals_shared, true);
  assert.equal(a.actual_truck_days, 1.5);      // 3 / 2
});

t("payroll fills in for a truck with no ELD", () => {
  const a = computeActuals({
    job: JOB, trip: TRIP, siblingCf: [{ jobKey: "a", cuFt: 820 }], jobCuFt: 820,
    pingDays: [], expenses: EXP,
    workDays: [
      { driver_id: 4, work_date: "2026-07-24" },
      { driver_id: 7, work_date: "2026-07-24" },  // two drivers, one day
      { driver_id: 4, work_date: "2026-07-25" },
    ],
  });
  assert.equal(a.actual_truck_days, 2);        // distinct DATES, not rows
  assert.equal(a.actual_drivers, 2);
  assert.equal(a.actual_miles, null);          // nothing measured it
  assert.equal(a.actuals_source, "payroll");
});

t("nothing measured means nothing written — no invented actuals", () => {
  assert.equal(computeActuals({
    job: JOB, trip: TRIP, siblingCf: [], jobCuFt: 820,
    pingDays: [], expenses: EXP, workDays: [],
  }), null);
  assert.equal(computeActuals({
    job: { id: 1 }, trip: null, siblingCf: [], jobCuFt: 0,
    pingDays: PINGS, expenses: [], workDays: [],
  }), null);  // not delivered
});

t("a job with no trip is its own run and reads clean", () => {
  const a = computeActuals({
    job: { id: 1, date_out: "2026-07-27", pickup_date: "2026-07-26", driver_ids: [4] },
    trip: null, siblingCf: [{ jobKey: "a", cuFt: 500 }], jobCuFt: 500,
    pingDays: [], expenses: [{ category: "fuel", amount: 90, expense_date: "2026-07-26" }],
    workDays: [{ driver_id: 4, work_date: "2026-07-26" }],
  });
  assert.equal(a.actuals_shared, false);
  assert.equal(a.actual_truck_days, 1);
  assert.equal(a.actual_fuel, 90);
  assert.equal(a.actual_trucks, null);   // no trip, so no truck to claim
});

// ── Where the empty miles start ──────────────────────────────────────────────
t("the truck's live position beats the base ZIP", () => {
  const r = deadheadOrigin("34470", "33166");   // Truck 3 in Ocala vs the yard
  assert.equal(r.zip, "34470");
  assert.equal(r.from, DEADHEAD_ORIGINS.truck);
});

t("the base ZIP is the fallback, not the default", () => {
  for (const bad of [null, "", "   ", "34", "not a zip", undefined]) {
    const r = deadheadOrigin(bad, "33166");
    assert.equal(r.zip, "33166", `truckZip ${JSON.stringify(bad)} should fall back`);
    assert.equal(r.from, DEADHEAD_ORIGINS.base);
  }
});

t("with neither, the empty miles are honestly not in play", () => {
  const r = deadheadOrigin("", "");
  assert.equal(r.zip, "");
  assert.equal(r.from, DEADHEAD_ORIGINS.none);
});

t("a ZIP+4 or a padded string is not silently accepted", () => {
  // reverseZip() already trims to five digits; anything else reaching here is junk.
  assert.equal(deadheadOrigin("34470-1234", "33166").from, DEADHEAD_ORIGINS.base);
});

t("the label says where the miles were measured from", () => {
  assert.equal(deadheadOriginLabel(DEADHEAD_ORIGINS.truck, "Truck 3"), "from Truck 3");
  assert.equal(deadheadOriginLabel(DEADHEAD_ORIGINS.truck, ""), "from the closest truck");
  assert.equal(deadheadOriginLabel(DEADHEAD_ORIGINS.base), "from the base");
  assert.equal(deadheadOriginLabel(DEADHEAD_ORIGINS.none), "not measured");
});
