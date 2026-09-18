// Pipeline — pure math and vocabularies for the job-reception board.
//
// A LEAD is an incoming opportunity that has not been decided yet. It is not a
// job (that is storage_jobs, one row per storage location) and it is not a
// pricing run (that is job_evaluations). This module owns everything about a
// lead that can be computed without React, Supabase or the network, so it can
// be unit-tested with plain node AND imported from the serverless side.
//
// No React, no I/O, no imports: lib/leads.mjs and lib/brief.mjs run this same
// code on the server.
//
// Tests: scripts/test-pipeline-data.mjs (npm test)

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Coerce anything the UI hands us (empty string, null, "12.5") to a number. */
export const num = (v, fallback = 0) => {
  const n = typeof v === "number" ? v : parseFloat(v);
  return Number.isFinite(n) ? n : fallback;
};

/** ISO date math, same hand-rolled style as the rest of the CRM (no date lib). */
export function addDaysISO(iso, days) {
  const d = new Date(String(iso) + "T00:00:00");
  if (isNaN(d.getTime())) return "";
  d.setDate(d.getDate() + days);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** Whole days from `a` to `b`; negative when b is before a. "" on bad input. */
export function daysBetween(a, b) {
  const x = new Date(String(a) + "T00:00:00"), y = new Date(String(b) + "T00:00:00");
  if (isNaN(x.getTime()) || isNaN(y.getTime())) return null;
  return Math.round((y - x) / 86400000);
}

// ── Settings ─────────────────────────────────────────────────────────────────

// Defaults live here, not in the component. A saved pipeline_settings row is
// merged on top. The two hold numbers are the parameter the workflow diagram
// left open: a reminder on day 2, a decision due on day 7.
export const DEFAULT_PIPELINE_SETTINGS = {
  holdReminderDays: 2,
  holdDecisionDays: 7,
  // Sender domains a lead may arrive from. Empty means "accept none by email" —
  // fail closed, so an unconfigured install never ingests from the open internet.
  allowedEmailDomains: [],
  // Partner carriers a job can be handed to when we pass on it.
  carriers: [],
  // Leads one sender may create in a day. Counted per address, so a busy broker
  // can never starve the others out of the board.
  maxLeadsPerSenderPerDay: 40,
  // Backstop across every sender, for the day an over-broad domain is allowed
  // in by mistake. The per-sender cap is the one that normally bites.
  maxLeadsPerDay: 200,
};

export function mergePipelineSettings(saved) {
  const s = saved && typeof saved === "object" ? saved : {};
  const out = { ...DEFAULT_PIPELINE_SETTINGS };
  for (const k of Object.keys(DEFAULT_PIPELINE_SETTINGS)) {
    if (s[k] === undefined || s[k] === null || s[k] === "") continue;
    out[k] = Array.isArray(DEFAULT_PIPELINE_SETTINGS[k]) ? (Array.isArray(s[k]) ? s[k] : out[k]) : s[k];
  }
  // A reminder after the decision is due is not a reminder.
  out.holdReminderDays = Math.max(0, Math.round(num(out.holdReminderDays, 2)));
  out.holdDecisionDays = Math.max(1, Math.round(num(out.holdDecisionDays, 7)));
  if (out.holdReminderDays > out.holdDecisionDays) out.holdReminderDays = out.holdDecisionDays;
  // A cap of 0 would silently switch the email channel off; 1 is the floor.
  out.maxLeadsPerSenderPerDay = Math.max(1, Math.round(num(out.maxLeadsPerSenderPerDay, 40)));
  out.maxLeadsPerDay = Math.max(out.maxLeadsPerSenderPerDay, Math.round(num(out.maxLeadsPerDay, 200)));
  out.allowedEmailDomains = normalizeSenderRules(out.allowedEmailDomains);
  out.carriers = normalizeCarriers(out.carriers);
  return out;
}

/**
 * What a typed allowlist entry becomes before it is stored or compared.
 *
 * An entry is EITHER a whole domain ("allied.com", which also covers its
 * subdomains) OR one exact address ("shawn@gmail.com", which covers nobody
 * else). Keeping both matters: brokers who send from a company domain want the
 * first, and someone who sends from a personal mailbox needs the second —
 * reducing "shawn@gmail.com" to "gmail.com" would hand the whole of Gmail a way
 * into the board.
 *
 * "@Allied.com", "https://allied.com/jobs" and "ALLIED.com" all mean the domain.
 */
export function normalizeSenderRule(value) {
  let s = String(value == null ? "" : value).trim().toLowerCase();
  s = s.replace(/^[a-z]+:\/\//, "").replace(/^mailto:/, "").replace(/[/\\].*$/, "");
  // A leading @ is how people write "the whole domain".
  if (s.startsWith("@")) s = s.slice(1);
  const isDomain = (d) => /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d);
  if (s.includes("@")) {
    const at = s.lastIndexOf("@");
    const local = s.slice(0, at), domain = s.slice(at + 1);
    return local && !/\s/.test(local) && isDomain(domain) ? local + "@" + domain : "";
  }
  s = s.replace(/^\.+/, "").replace(/\.+$/, "");
  // A public mailbox domain is not a company: allowing it would allow anyone
  // with a free account. Those senders have to be named address by address.
  if (PUBLIC_MAILBOX_DOMAINS.has(s)) return "";
  return isDomain(s) ? s : "";
}

/**
 * Domains anyone can get a mailbox on. Never a broker's identity, so they are
 * refused as a whole-domain rule — "shawn@gmail.com" is fine, "gmail.com" is
 * every stranger on the internet.
 */
export const PUBLIC_MAILBOX_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "ymail.com", "hotmail.com",
  "outlook.com", "live.com", "msn.com", "aol.com", "icloud.com", "me.com",
  "mac.com", "proton.me", "protonmail.com", "gmx.com", "mail.com", "zoho.com",
  "yandex.com", "qq.com", "163.com",
]);

/** Clean, de-duplicated, order-preserving. Anything unparseable is dropped. */
export function normalizeSenderRules(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const d = normalizeSenderRule(raw);
    if (d && !out.includes(d)) out.push(d);
  }
  return out;
}

/** Carrier names are free text; only trimming and de-duplication apply. */
export function normalizeCarriers(list) {
  const out = [];
  for (const raw of Array.isArray(list) ? list : []) {
    const c = String(raw == null ? "" : raw).trim().replace(/\s+/g, " ");
    if (c && !out.some((x) => x.toLowerCase() === c.toLowerCase())) out.push(c);
  }
  return out;
}

// ── Vocabularies ─────────────────────────────────────────────────────────────

// Colours reuse the CRM's own calendar/status palette so a lead reads like
// everything else on screen. Labels are English; I18N_ES translates them.
export const LEAD_STATUSES = [
  { v: "new",       l: "New",       bg: "#EAF1F8", text: "#185FA5", bar: "#378ADD" },
  { v: "evaluating",l: "Evaluating",bg: "#F5F5F5", text: "#666666", bar: "#BBBBBB" },
  { v: "proposed",  l: "Evaluated", bg: "#EAF3DE", text: "#3B6D11", bar: "#639922" },
  { v: "held",      l: "On hold",   bg: "#FEF9C3", text: "#854D0E", bar: "#FACC15" },
  { v: "offered",   l: "Offered",   bg: "#EDE9FE", text: "#6D28D9", bar: "#7C3AED" },
  { v: "accepted",  l: "Accepted",  bg: "#EAF3DE", text: "#3B6D11", bar: "#639922" },
  { v: "converted", l: "Converted", bg: "#E6F1FB", text: "#185FA5", bar: "#378ADD" },
  { v: "rejected",  l: "Rejected",  bg: "#FCEBEB", text: "#A32D2D", bar: "#E24B4A" },
  { v: "expired",   l: "Expired",   bg: "#FCEBEB", text: "#A32D2D", bar: "#E24B4A" },
];
export const leadStatusMeta = (v) => LEAD_STATUSES.find((s) => s.v === v) || LEAD_STATUSES[0];

export const LEAD_SOURCES = [
  { v: "manual",   l: "Manual",   icon: "⌨" },
  { v: "email",    l: "Email",    icon: "✉" },
  { v: "whatsapp", l: "WhatsApp", icon: "💬" },
  { v: "telegram", l: "Telegram", icon: "✈" },
];
export const leadSourceMeta = (v) => LEAD_SOURCES.find((s) => s.v === v) || LEAD_SOURCES[0];

// Statuses that are still waiting on a human. Everything else is settled.
export const OPEN_LEAD_STATUSES = ["new", "evaluating", "proposed", "held", "expired"];
export const isOpenLead = (l) => OPEN_LEAD_STATUSES.includes(l?.status || "new");

// The verdict traffic light, mirroring jobCalcData's VERDICT.
export const VERDICT_META = {
  green:  { l: "Take it",   bg: "#EAF3DE", text: "#3B6D11", dot: "#639922" },
  yellow: { l: "Marginal",  bg: "#FEF9C3", text: "#854D0E", dot: "#FACC15" },
  red:    { l: "Loses money", bg: "#FCEBEB", text: "#A32D2D", dot: "#E24B4A" },
};
export const verdictMeta = (v) => VERDICT_META[v] || null;

// ── The hold clock (the diagram's "X amount of days") ────────────────────────

/** The three dates a hold starts, given today and the settings. */
export function holdDates(todayISO, settings) {
  const s = mergePipelineSettings(settings);
  return {
    hold_started_on: todayISO,
    remind_at: addDaysISO(todayISO, s.holdReminderDays),
    hold_until: addDaysISO(todayISO, s.holdDecisionDays),
  };
}

/**
 * Where a held lead stands today.
 *   none     — not on hold
 *   running  — the clock is going, nothing due
 *   reminder — reached the reminder day (and it has not been sent)
 *   due      — the decision is due today
 *   expired  — the decision date has passed
 */
export function holdStage(lead, todayISO) {
  if (!lead || lead.status !== "held") return "none";
  const toDue = lead.hold_until ? daysBetween(todayISO, lead.hold_until) : null;
  if (toDue != null && toDue < 0) return "expired";
  if (toDue != null && toDue === 0) return "due";
  const toRemind = lead.remind_at ? daysBetween(todayISO, lead.remind_at) : null;
  if (toRemind != null && toRemind <= 0 && !lead.reminder_sent_at) return "reminder";
  return "running";
}

/** Day N of M for the progress bar. Returns null when the lead is not on hold. */
export function holdProgress(lead, todayISO) {
  if (!lead || lead.status !== "held" || !lead.hold_started_on || !lead.hold_until) return null;
  const total = daysBetween(lead.hold_started_on, lead.hold_until);
  const elapsed = daysBetween(lead.hold_started_on, todayISO);
  if (total == null || elapsed == null || total <= 0) return null;
  const day = Math.max(0, Math.min(total, elapsed));
  return { day, total, pct: Math.round((day / total) * 100) };
}

/** Leads the daily sweep has to act on, split by what it owes each one. */
export function leadsNeedingAttention(leads, todayISO) {
  const remind = [], due = [], expired = [];
  for (const l of leads || []) {
    if (l?.deleted_at) continue;
    const st = holdStage(l, todayISO);
    if (st === "reminder") remind.push(l);
    else if (st === "due") due.push(l);
    else if (st === "expired") expired.push(l);
  }
  return { remind, due, expired };
}

// ── Ranking ──────────────────────────────────────────────────────────────────

// The scarce resource is the truck-day, not the percentage. A 30% job that ties
// a truck up for five days is worth less than an 18% job that takes one, so the
// board sorts on contribution per truck-day and nothing else.
export const leadScore = (lead) => {
  const v = lead?.evaluation?.contribution_per_truck_day;
  return v == null || v === "" ? null : num(v);
};

/** Sort a copy: scored leads by score desc, unscored last, then newest first. */
export function rankLeads(leads) {
  return (leads || []).slice().sort((a, b) => {
    const sa = leadScore(a), sb = leadScore(b);
    if (sa == null && sb == null) return num(b?.id) - num(a?.id);
    if (sa == null) return 1;
    if (sb == null) return -1;
    if (sb !== sa) return sb - sa;
    return num(b?.id) - num(a?.id);
  });
}

/** Board counters, in the order the metric tiles show them. */
export function pipelineTotals(leads, todayISO) {
  const live = (leads || []).filter((l) => !l?.deleted_at);
  const by = (s) => live.filter((l) => (l.status || "new") === s).length;
  const { due, expired } = leadsNeedingAttention(live, todayISO);
  const converted = live.filter((l) => l.status === "converted");
  return {
    new: by("new"),
    evaluated: by("proposed") + by("evaluating"),
    held: by("held"),
    expiring: due.length + expired.length,
    offered: by("offered"),
    converted: converted.length,
    convertedValue: converted.reduce((a, l) => a + num(l.broker_price), 0),
  };
}

// ── Deduplication ────────────────────────────────────────────────────────────

// The same job arrives by email AND by WhatsApp. Two leads are the same
// opportunity when the broker's own job number matches, or when broker, both
// ZIPs and the volume (within 10%) line up.
export const CF_TOLERANCE = 0.1;

export function isSameOpportunity(a, b) {
  if (!a || !b) return false;
  const jn = (x) => String(x?.broker_job_number || "").trim().toLowerCase();
  if (jn(a) && jn(a) === jn(b)) return true;
  const sameBroker = a.broker_id != null && String(a.broker_id) === String(b.broker_id);
  if (!sameBroker) return false;
  const zip = (x, k) => String(x?.[k] || "").trim().slice(0, 5);
  if (!zip(a, "origin_zip") || zip(a, "origin_zip") !== zip(b, "origin_zip")) return false;
  if (!zip(a, "dest_zip") || zip(a, "dest_zip") !== zip(b, "dest_zip")) return false;
  const ca = num(a.cu_ft), cb = num(b.cu_ft);
  if (ca <= 0 || cb <= 0) return false;
  return Math.abs(ca - cb) <= Math.max(ca, cb) * CF_TOLERANCE;
}

/** The first live lead that looks like the same opportunity, or null. */
export function findDuplicate(candidate, leads) {
  for (const l of leads || []) {
    if (l?.deleted_at) continue;
    if (candidate?.id != null && String(l.id) === String(candidate.id)) continue;
    if (l.status === "rejected" || l.status === "expired") continue;
    if (isSameOpportunity(candidate, l)) return l;
  }
  return null;
}

// ── Lead → job ───────────────────────────────────────────────────────────────

// The conversion never writes: it produces the SHAPE of the job form so App.jsx
// can open its own modal pre-filled and let saveJob() do the per-location
// fan-out exactly as it does for a hand-typed job.
export function leadToJobForm(lead, emptyJob) {
  const base = emptyJob && typeof emptyJob === "object" ? emptyJob : {};
  const s = (v) => (v == null ? "" : String(v));
  const n = (v) => (v == null || v === "" ? "" : String(num(v)));
  return {
    ...base,
    job_number: s(lead?.broker_job_number),
    customer: s(lead?.customer),
    job_type: lead?.job_type || base.job_type || "full",
    status: "scheduled",
    calendar_status: "active",
    broker_id: lead?.broker_id == null ? "" : String(lead.broker_id),
    volume: n(lead?.cu_ft),
    estimate: n(lead?.broker_price),
    fadd: s(lead?.fadd),
    pickup_date_from: s(lead?.pickup_date_from),
    pickup_date_to: s(lead?.pickup_date_to),
    pickup_city: s(lead?.origin_city),
    pickup_state: s(lead?.origin_state),
    pickup_zip: s(lead?.origin_zip),
    delivery_date: s(lead?.delivery_date),
    delivery_city: s(lead?.dest_city),
    delivery_state: s(lead?.dest_state),
    delivery_zip: s(lead?.dest_zip),
  };
}

// ── Inbound email containment ────────────────────────────────────────────────

/**
 * The bare address out of a From header, lowercased. `"Allied Dispatch
 * <Dispatch@Allied.com>"` and `"dispatch@allied.com"` both come back the same,
 * which is what makes the per-sender count mean one sender.
 */
export function senderAddress(address) {
  const m = String(address || "").match(/<([^>]*)>\s*$/);
  const addr = (m ? m[1] : String(address || "")).trim().toLowerCase().replace(/^mailto:/, "");
  return /^[^\s@]+@[^\s@]+$/.test(addr) ? addr : "";
}

/** The domain of an address, lowercased. "" when it does not parse. */
export function senderDomain(address) {
  const m = String(address || "").match(/<([^>]*)>\s*$/);
  const addr = (m ? m[1] : String(address || "")).trim().toLowerCase();
  const at = addr.lastIndexOf("@");
  return at < 0 ? "" : addr.slice(at + 1).replace(/[>\s]+$/, "");
}

/**
 * Why an inbound email never became a lead. The webhook answers a flat 202 in
 * every case — it must not tell the internet which domains we accept — so this
 * is the only place an operator can find out, and it is worth being plain.
 */
export const DROP_REASONS = [
  { v: "sender_not_allowed", l: "Sender not on the allowlist", hint: "Add the domain in Settings if it is a broker of ours." },
  { v: "rate_limited", l: "Over this sender's daily cap", hint: "Raise the per-sender cap in Settings, or check whether the sender is looping." },
  { v: "day_cap", l: "Over the daily cap for all senders", hint: "Raise the daily cap in Settings." },
  { v: "no_sender", l: "No readable sender address", hint: "The forwarder did not send a usable From header." },
];
export const dropReasonMeta = (v) => DROP_REASONS.find((r) => r.v === v) || { v, l: v, hint: "" };

/**
 * Fail closed: with nothing configured nobody is accepted. A broker email is
 * untrusted input feeding an LLM, so the allowlist is the first gate and the
 * strict output schema is the second.
 *
 * A rule with an "@" is one exact address and matches only that mailbox; a bare
 * domain matches the domain and its subdomains.
 */
export function isAllowedSender(address, settings) {
  const s = mergePipelineSettings(settings);
  const dom = senderDomain(address);
  const addr = senderAddress(address);
  if (!dom) return false;
  return (s.allowedEmailDomains || []).some((rule) =>
    rule.includes("@")
      ? (!!addr && addr === rule)
      : (dom === rule || dom.endsWith("." + rule)));
}

/** Hard cap on what we store from an email body. */
export const MAX_RAW_TEXT = 20000;
export const clampRawText = (t) => String(t == null ? "" : t).slice(0, MAX_RAW_TEXT);

// ── Field confidence ─────────────────────────────────────────────────────────

// The extractor reports a confidence per field. Anything it is not sure about is
// highlighted in the UI rather than silently trusted.
export const LOW_CONFIDENCE = "low";
export const confidenceOf = (lead, field) => {
  const c = lead?.parsed?.confidence;
  return c && typeof c === "object" ? c[field] || null : null;
};
export const isLowConfidence = (lead, field) => confidenceOf(lead, field) === LOW_CONFIDENCE;

/** Fields the extractor is allowed to fill, and that the form shows back. */
export const LEAD_FIELDS = [
  "broker_job_number", "customer", "origin_zip", "origin_city", "origin_state",
  "dest_zip", "dest_city", "dest_state", "cu_ft", "broker_price",
  "fadd", "pickup_date_from", "pickup_date_to", "delivery_date", "job_type",
];

/** Everything the extractor left empty — what the operator has to complete. */
export function missingFields(lead) {
  return LEAD_FIELDS.filter((f) => {
    const v = lead?.[f];
    return v == null || v === "";
  });
}

/** A lead can be priced once it has both ZIPs, a volume and a price. */
export function isEvaluable(lead) {
  return /^\d{5}$/.test(String(lead?.origin_zip || "").trim())
    && /^\d{5}$/.test(String(lead?.dest_zip || "").trim())
    && num(lead?.cu_ft) > 0
    && num(lead?.broker_price) > 0;
}

// ── Nearest truck (the map-aware deadhead) ───────────────────────────────────

/** Great-circle miles. Only used to RANK trucks; real miles come from /api/distance. */
export function haversineMiles(aLat, aLng, bLat, bLng) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat), dLng = toRad(bLng - aLng);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/**
 * The free truck closest to the load point. This is the improvement over a
 * fixed base ZIP: the same job 40 miles from an idle truck is worth far more
 * than the same job 900 miles away, and the fleet already reports its position.
 */
export function nearestTruck(trucks, lat, lng) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  let best = null;
  for (const t of trucks || []) {
    if (t?.deleted_at || t?.active === false) continue;
    const tLat = Number(t?.last_lat), tLng = Number(t?.last_lng);
    if (!Number.isFinite(tLat) || !Number.isFinite(tLng)) continue;
    const miles = haversineMiles(lat, lng, tLat, tLng);
    if (!best || miles < best.miles) best = { truck: t, miles: Math.round(miles) };
  }
  return best;
}

// ── Closing the loop: actuals from what the CRM already recorded ─────────────
//
// job_evaluations has columns for what a job REALLY cost, and calibrate() in
// jobCalcData.js turns them into corrected settings. Until now they were typed
// by hand, which means they were never typed at all, so the cost model could
// only age. Everything they need is already in the CRM: the ELD pings say how
// far the truck went and on which days it moved, and the expense rows say what
// was spent on fuel, tolls, materials and hotels.
//
// THE TRAP this guards against: a trip carries several jobs, but the evaluation
// priced each one as if it had the truck to itself. Feeding a job its slice of
// a shared trip would teach the model that everything is cheaper than it is.
// So a job that shared its trip still gets its actuals recorded — the operator
// wants to see them — but flagged `actuals_shared`, and calibrate() skips it.
// Only a job that ran alone is a clean reading.

/** Inclusive ISO date-range test, tolerant of missing bounds. */
export const withinRange = (iso, start, end) => {
  const d = String(iso || "").slice(0, 10);
  if (!d) return false;
  if (start && d < String(start).slice(0, 10)) return false;
  if (end && d > String(end).slice(0, 10)) return false;
  return true;
};

/**
 * The window a job was actually on the road. A job can sit in storage for
 * months, so the run is the trip's departure (or the pickup) through delivery —
 * never the job's whole life, which would sweep in unrelated expenses.
 * Returns null when the job has not been delivered.
 */
export function jobRunWindow(job, trip) {
  const end = String(job?.date_out || "").slice(0, 10);
  if (!end) return null;
  const start = String(
    trip?.departure_date || job?.pickup_date || job?.pickup_date_from || ""
  ).slice(0, 10) || end;
  return start <= end ? { start, end } : { start: end, end };
}

/** Distinct calendar dates an expense category appears on — the hotel-night proxy. */
export const distinctExpenseDates = (expenses, category) =>
  new Set((expenses || [])
    .filter((e) => e && e.category === category && e.expense_date)
    .map((e) => String(e.expense_date).slice(0, 10))).size;

export const sumExpenses = (expenses, category) =>
  (expenses || []).filter((e) => e && e.category === category)
    .reduce((a, e) => a + num(e.amount), 0);

/**
 * What a delivered job really cost, from rows the CRM already has.
 *
 * @param job         the representative storage_jobs row (delivered)
 * @param trip        its trips row, or null when it rode no trip
 * @param siblingCf   [{ jobKey, cuFt }] every job on that trip, this one included
 * @param jobCuFt     this job's own cubic feet
 * @param pingDays    truckDays() rows for THIS truck, already filtered to the window
 * @param expenses    expense rows already filtered to the trip/job and the window
 * @param workDays    driver_work_days rows already filtered to the trip and window
 * @returns a patch for job_evaluations, or null when there is nothing to record
 */
export function computeActuals({ job, trip, siblingCf = [], jobCuFt = 0, pingDays = [], expenses = [], workDays = [] }) {
  const window = jobRunWindow(job, trip);
  if (!window) return null;

  // How much of a shared trip is this job's. Cubic feet is the weight the cost
  // model itself thinks in; with no volumes recorded, split evenly.
  const totalCf = (siblingCf || []).reduce((a, s) => a + num(s.cuFt), 0);
  const siblings = Math.max(1, (siblingCf || []).length);
  const share = totalCf > 0 && num(jobCuFt) > 0 ? num(jobCuFt) / totalCf : 1 / siblings;
  const shared = siblings > 1;

  // Miles and days out come off the GPS breadcrumbs — the same numbers the
  // Reports screen shows, so the two screens can never disagree.
  const moved = (pingDays || []).filter((d) => d && d.moved);
  const pingMiles = moved.reduce((a, d) => a + num(d.miles), 0);
  const pingDayCount = moved.length;

  // Payroll is the fallback for days when the truck has no ELD: distinct dates
  // somebody was paid to be out.
  const paidDates = new Set((workDays || [])
    .filter((w) => w && w.work_date).map((w) => String(w.work_date).slice(0, 10)));

  const truckDaysActual = pingDayCount > 0 ? pingDayCount : paidDates.size;
  if (truckDaysActual <= 0) return null; // nothing measured — record nothing

  const source = pingDayCount > 0 ? "eld" : "payroll";
  const drivers = new Set();
  for (const w of workDays || []) if (w?.driver_id != null) drivers.add(String(w.driver_id));
  if (trip?.driver_id != null) drivers.add(String(trip.driver_id));
  for (const d of job?.driver_ids || []) if (d != null) drivers.add(String(d));

  const round2 = (v) => Math.round(v * 100) / 100;
  const money = (v) => Math.round(v * 100) / 100;

  return {
    actual_truck_days: round2(truckDaysActual * share),
    actual_miles: pingMiles > 0 ? round2(pingMiles * share) : null,
    actual_fuel: money(sumExpenses(expenses, "fuel") * share),
    actual_tolls: money(sumExpenses(expenses, "tolls") * share),
    actual_materials: money(sumExpenses(expenses, "materials") * share),
    // No column records nights, so distinct hotel-expense dates stand in for them.
    actual_hotel_nights: distinctExpenseDates(expenses, "hotel"),
    actual_trucks: trip?.truck_id != null ? 1 : null,
    actual_drivers: drivers.size > 0 ? drivers.size : null,
    // helpers are not tracked as a role anywhere, so this stays null and
    // rowCrew() falls back to what was planned.
    actual_helpers: null,
    actuals_shared: shared,
    actuals_source: source,
    actuals_at: null, // the caller stamps this
  };
}

// ── Where the empty miles are measured from ─────────────────────────────────
//
// The Job Calculator measures deadhead from a fixed company base ZIP, which is
// the only thing it can do for a job a week out. But a lead is priced NOW, and
// the fleet reports where it is: the empty miles that matter are the ones the
// truck that would actually take the job has to drive to reach the pickup.
//
// The two legs are deliberately asymmetric, because that is what really happens:
//   · out  — from where the truck IS to the pickup (the real approach)
//   · back — from the delivery to the company base (it eventually comes home)
// deadheadFor() in jobCalcData.js already takes them separately, so the three
// assumptions (roundTrip / oneWay / none) keep working unchanged.

export const DEADHEAD_ORIGINS = {
  truck: "truck",   // measured from the closest truck's live position
  base: "base",     // measured from the company base ZIP — the old behaviour
  none: "none",     // no base at all, so empty miles are not in play
};

/**
 * Which ZIP the approach leg starts at, and why.
 * @param truckZip the nearest free truck's position reverse-geocoded, or "" / null
 * @param baseZip  the company base ZIP from the Job Calculator settings
 */
export function deadheadOrigin(truckZip, baseZip) {
  const t = String(truckZip || "").trim();
  const b = String(baseZip || "").trim();
  if (/^\d{5}$/.test(t)) return { zip: t, from: DEADHEAD_ORIGINS.truck };
  if (/^\d{5}$/.test(b)) return { zip: b, from: DEADHEAD_ORIGINS.base };
  return { zip: "", from: DEADHEAD_ORIGINS.none };
}

/** One line for the operator saying where the empty miles were measured from. */
export function deadheadOriginLabel(from, truckName) {
  if (from === DEADHEAD_ORIGINS.truck) return truckName ? `from ${truckName}` : "from the closest truck";
  if (from === DEADHEAD_ORIGINS.base) return "from the base";
  return "not measured";
}
