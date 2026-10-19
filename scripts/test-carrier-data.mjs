// Carrier dispatch — pure math and texts (lib/carriers.mjs via src/carrierData.js).
import assert from "node:assert/strict";
import {
  carrierPay, estimatedPay, dispatchNet, carrierCollectedByJob, carrierBalances, carrierKpis,
  insuranceStatus, dispatchAlerts, senderAddress, carrierEmails, findCarrierBySender, waNumber,
  replyToFor, tagFromAddresses, refFromSubject, matchInbound, stripQuoted, isAcceptReply,
  buildDispatchEmail, buildDispatchWhatsApp, dispatchSubject, rateConfirmationRows,
  normalizeExtraction, reviewOutcome, docsNotice, jobKeyOf, EXTRACTION_SCHEMA,
} from "../src/carrierData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };
const TODAY = "2026-10-16";

const bravo = { id: 2, name: "Carrier Bravo Moving", contact_name: "Mike Reyes", email: "ops@carrierbravo.com, Mike@CarrierBravo.com", whatsapp: "(312) 555-0199", insurance_expires: "2027-03-31" };
const charlie = { id: 3, name: "Carrier Charlie", email: "charlie.dispatch@gmail.com" };
const d57 = { id: 57, carrier_id: 2, job_number: "NB-24107", rate_type: "per_cf", rate_per_cf: 2.6, est_cf: 800, final_cf: 800, carrier_extras: 0, expected_collect: 2950, collected: 2950, status: "verified", verified_at: "2026-10-14T22:00:00Z" };
const job = {
  job_number: "NB-24107", customer: "J. Carter", client_phone: "(312) 555-0147",
  pickup_date: "2026-10-09", pickup_address: "1420 W Fulton St", pickup_city: "Chicago", pickup_state: "IL", pickup_zip: "60607",
  delivery_city: "Atlanta", delivery_state: "GA", delivery_zip: "30309", fadd: "2026-10-15",
};

// ── Money ──
t("pay is rate × final CF + extras; net is collected − pay", () => {
  assert.equal(carrierPay(d57), 2080);
  assert.equal(dispatchNet(d57), 870);
  assert.equal(carrierPay({ ...d57, final_cf: 950, carrier_extras: 250 }), 2720);
});
t("pay falls back to the estimate before the final CF is known", () => {
  assert.equal(carrierPay({ ...d57, final_cf: null }), 2080);
  assert.equal(estimatedPay({ ...d57, final_cf: 900 }), 2080);
});
t("flat rate ignores CF", () => {
  assert.equal(carrierPay({ rate_type: "flat", flat_rate: 1800, final_cf: 999, carrier_extras: 100 }), 1900);
});
t("we owe the carrier when it collected less than its pay", () => {
  assert.equal(dispatchNet({ rate_type: "per_cf", rate_per_cf: 2.8, final_cf: 750, collected: 780 }), -1320);
});

t("carrier collections per job count only verified, live dispatches", () => {
  const m = carrierCollectedByJob([
    d57,
    { ...d57, id: 58, job_number: "NB-1", status: "docs_received", collected: 500 },
    { ...d57, id: 59, job_number: "NB-2", collected: 100, deleted_at: "2026-10-01" },
  ]);
  assert.deepEqual(m, { [jobKeyOf("NB-24107")]: 2950 });
  assert.equal(jobKeyOf(" NB-24107 "), "n:nb-24107");
});

t("balance = verified nets + adjustments − paid to us + paid by us", () => {
  const rows = carrierBalances({
    carriers: [bravo, charlie, { id: 9, name: "Gone", deleted_at: "2026-01-01" }],
    dispatches: [
      d57,
      { ...d57, id: 60, job_number: "NB-24102", rate_per_cf: 2.5, final_cf: 1180, est_cf: 1100, collected: 4120, verified_at: "2026-09-28T10:00:00Z" },
      { ...d57, id: 61, status: "sent", collected: null, final_cf: null },
      { ...d57, id: 62, status: "docs_received", collected: null },
      { ...d57, id: 63, status: "cancelled", collected: 99999 },
      { id: 70, carrier_id: 3, job_number: "NB-24103", rate_type: "per_cf", rate_per_cf: 2.8, est_cf: 750, final_cf: 750, collected: 780, status: "verified", verified_at: "2026-09-25T00:00:00Z" },
    ],
    payments: [{ carrier_id: 2, direction: "in", amount: 1000 }, { carrier_id: 3, direction: "out", amount: 320 }, { carrier_id: 2, direction: "in", amount: 5, deleted_at: "x" }],
    adjustments: [{ carrier_id: 2, amount: 150 }],
  });
  const b = rows.find((r) => r.carrierId === 2), c = rows.find((r) => r.carrierId === 3);
  assert.equal(rows.some((r) => r.carrierId === 9), false);
  assert.equal(b.jobsNet, 870 + 1170);
  assert.equal(b.balance, 870 + 1170 + 150 - 1000);
  assert.equal(b.active, 2);
  assert.equal(b.review, 1);
  assert.equal(b.verified, 2);
  assert.equal(b.total, 4);
  assert.equal(b.oldest, "2026-09-28");
  assert.equal(c.balance, -1320 + 320);
  const k = carrierKpis(rows);
  assert.deepEqual(k, { owe: 1190, weOwe: 1000, net: 190, active: 2, review: 1 });
});
t("a settled carrier has no oldest date", () => {
  const [r] = carrierBalances({ carriers: [bravo], dispatches: [d57], payments: [{ carrier_id: 2, direction: "in", amount: 870 }] });
  assert.equal(r.balance, 0);
  assert.equal(r.oldest, null);
});

t("insurance status", () => {
  assert.equal(insuranceStatus(bravo, TODAY), "ok");
  assert.equal(insuranceStatus({ insurance_expires: "2026-11-01" }, TODAY), "soon");
  assert.equal(insuranceStatus({ insurance_expires: "2026-10-15" }, TODAY), "expired");
  assert.equal(insuranceStatus({}, TODAY), "unknown");
});

t("alerts: short collection, CF variance, not accepted, docs overdue", () => {
  const codes = (d, o) => dispatchAlerts(d, o).map((a) => a.code);
  assert.deepEqual(codes(d57, { today: TODAY }), []);
  const short = dispatchAlerts({ ...d57, collected: 2700 }, { today: TODAY });
  assert.deepEqual(short, [{ code: "short_collect", amount: 250 }]);
  assert.deepEqual(codes({ ...d57, final_cf: 900 }, { today: TODAY }), ["cf_variance"]);
  assert.deepEqual(codes({ ...d57, final_cf: 870 }, { today: TODAY }), []);
  assert.deepEqual(codes({ status: "sent", sent_at: "2026-10-14T10:00:00Z" }, { today: TODAY, now: "2026-10-16T10:00:00Z" }), ["not_accepted"]);
  assert.deepEqual(codes({ status: "sent", sent_at: "2026-10-16T08:00:00Z" }, { today: TODAY, now: "2026-10-16T10:00:00Z" }), []);
  assert.deepEqual(codes({ status: "accepted", due_date: "2026-10-12" }, { today: TODAY }), ["docs_overdue"]);
  assert.deepEqual(codes({ status: "accepted", due_date: "2026-10-15" }, { today: TODAY }), []);
});

// ── Addresses ──
t("sender address and carrier emails", () => {
  assert.equal(senderAddress("Mike Reyes <Mike@CarrierBravo.com>"), "mike@carrierbravo.com");
  assert.equal(senderAddress("ops@x.com"), "ops@x.com");
  assert.deepEqual(carrierEmails(bravo), ["ops@carrierbravo.com", "mike@carrierbravo.com"]);
});
t("carrier by sender: exact address, own domain, never a free-mail domain", () => {
  const cs = [bravo, charlie];
  assert.equal(findCarrierBySender("Mike <mike@carrierbravo.com>", cs)?.id, 2);
  assert.equal(findCarrierBySender("billing@carrierbravo.com", cs)?.id, 2);
  assert.equal(findCarrierBySender("charlie.dispatch@gmail.com", cs)?.id, 3);
  assert.equal(findCarrierBySender("someone.else@gmail.com", cs), null);
  assert.equal(findCarrierBySender("x@unknown.com", cs), null);
  assert.equal(findCarrierBySender("mike@carrierbravo.com", [{ ...bravo, deleted_at: "x" }]), null);
});
t("WhatsApp numbers get the US country code", () => {
  assert.equal(waNumber("(312) 555-0199"), "13125550199");
  assert.equal(waNumber("+1 312 555 0199"), "13125550199");
  assert.equal(waNumber("+54 9 11 5555 1234"), "5491155551234");
  assert.equal(waNumber("555"), "");
});

// ── Linking replies ──
t("reply-to tag round-trips", () => {
  assert.equal(replyToFor("Dispatch@NoBordersMoving.com", 57), "dispatch+cd57@nobordersmoving.com");
  assert.equal(replyToFor("dispatch+old@x.com", 9), "dispatch+cd9@x.com");
  assert.equal(replyToFor("", 9), "");
  assert.equal(tagFromAddresses("No Borders <dispatch+cd57@nobordersmoving.com>, x@y.com"), 57);
  assert.equal(tagFromAddresses("dispatch@nobordersmoving.com"), null);
  assert.equal(refFromSubject("Re: [Job NB-24107 · D57] Dispatch · Chicago, IL → Atlanta, GA"), 57);
  assert.equal(refFromSubject("BOL 24108 signed"), null);
});
t("matching: tag, then subject, then job number, then the only open dispatch", () => {
  const ds = [
    { id: 57, carrier_id: 2, job_number: "NB-24107", status: "accepted" },
    { id: 58, carrier_id: 2, job_number: "NB-24111", status: "in_progress" },
    { id: 70, carrier_id: 3, job_number: "NB-24108", status: "accepted" },
  ];
  assert.deepEqual(matchInbound({ to: "dispatch+cd57@nb.com" }, ds, 2), { dispatchId: 57, method: "tag" });
  assert.deepEqual(matchInbound({ to: "dispatch@nb.com", subject: "Re: [Job NB-24107 · D57] Dispatch" }, ds, 2), { dispatchId: 57, method: "subject" });
  assert.deepEqual(matchInbound({ subject: "Fwd: paperwork", text: "BOL for NB-24111 attached" }, ds, 2), { dispatchId: 58, method: "job_number" });
  assert.deepEqual(matchInbound({ subject: "done", extraction: { job_number: "nb-24111" } }, ds, 2), { dispatchId: 58, method: "job_number" });
  assert.deepEqual(matchInbound({ subject: "BOL signed" }, ds, 3), { dispatchId: 70, method: "only_open" });
  assert.deepEqual(matchInbound({ subject: "BOL signed" }, ds, 2), { dispatchId: null, method: null });
  // A tag pointing at another carrier's dispatch does not match.
  assert.deepEqual(matchInbound({ to: "dispatch+cd70@nb.com", subject: "x" }, ds, 2), { dispatchId: null, method: null });
  // A job number must stand alone: NB-241070 is not NB-24107.
  assert.equal(matchInbound({ text: "job NB-241070" }, ds.slice(0, 2), null).dispatchId, null);
});
t("accept replies, but not refusals or long messages", () => {
  assert.equal(isAcceptReply("ACCEPT 👍\n\nOn Oct 8, 2026, No Borders Dispatch wrote:\n> Hi"), true);
  assert.equal(isAcceptReply("Accepted, thanks"), true);
  assert.equal(isAcceptReply("Confirmed."), true);
  assert.equal(isAcceptReply("Sorry, we can't accept this one"), false);
  assert.equal(isAcceptReply("Delivered. BOL attached."), false);
  assert.equal(isAcceptReply("accept " + "x".repeat(400)), false);
  assert.equal(stripQuoted("Done\n> quoted"), "Done");
});

// ── Messages ──
t("dispatch email: subject reference, rows and both bodies", () => {
  const d = { ...d57, final_cf: null, collected: null, status: "sent", notes: "Piano, 2nd floor" };
  const e = buildDispatchEmail({ dispatch: d, job, carrier: bravo });
  assert.equal(e.subject, "[Job NB-24107 · D57] Dispatch · Chicago, IL → Atlanta, GA · 800 CF");
  assert.equal(refFromSubject("Re: " + e.subject), 57);
  assert.match(e.text, /^Hi Mike,/);
  assert.match(e.text, /Your rate: \$2\.60 \/ CF on final CF/);
  assert.match(e.text, /Collect at delivery: \$2,950/);
  assert.match(e.text, /Pickup: Oct 9 · 1420 W Fulton St, Chicago, IL 60607/);
  assert.match(e.text, /Delivery: FADD Oct 15 · Atlanta, GA 30309/);
  assert.match(e.html, /Reply ACCEPT/);
  assert.equal(dispatchSubject({ dispatch: { id: 1 }, job: { job_number: "X" } }), "[Job X · D1] Dispatch · ? → ?");
});
t("dispatch email escapes HTML from job fields", () => {
  const e = buildDispatchEmail({ dispatch: { ...d57, notes: "<script>x</script>" }, job, carrier: bravo });
  assert.equal(e.html.includes("<script>"), false);
  assert.match(e.html, /&lt;script&gt;/);
});
t("flat rate and extras in the rate confirmation", () => {
  const rows = rateConfirmationRows({ dispatch: { id: 1, rate_type: "flat", flat_rate: 1800, carrier_extras: 250, expected_collect: 2000 }, job });
  const m = Object.fromEntries(rows);
  assert.equal(m["Your rate"], "$1,800 flat");
  assert.equal(m["Extras for you"], "$250");
});
t("WhatsApp text", () => {
  const w = buildDispatchWhatsApp({ dispatch: { ...d57, status: "sent" }, job });
  assert.match(w, /\*No Borders · Job NB-24107 \(D57\)\*/);
  assert.match(w, /Chicago, IL → Atlanta, GA · 800 CF/);
  assert.match(w, /Rate \$2\.60\/CF · collect \$2,950 at delivery/);
});

// ── Extraction ──
t("extraction schema is closed and every field required", () => {
  assert.equal(EXTRACTION_SCHEMA.additionalProperties, false);
  assert.deepEqual([...EXTRACTION_SCHEMA.required].sort(), Object.keys(EXTRACTION_SCHEMA.properties).sort());
});
t("extraction is coerced, never trusted", () => {
  const x = normalizeExtraction({
    has_completion_docs: true, job_number: " NB-24107 ", final_cf: "800", amount_collected: 2950,
    payment_methods: ["cash", "zelle", "bitcoin", "cash"], delivery_date: "Oct 14", customer_signed: true,
    driver_signed: "yes", balance_due_on_bol: -5, low_confidence: ["final_cf", "hack"], extra: "ignored",
  });
  assert.equal(x.job_number, "NB-24107");
  assert.equal(x.final_cf, 800);
  assert.deepEqual(x.payment_methods, ["cash", "zelle"]);
  assert.equal(x.delivery_date, "");
  assert.equal(x.driver_signed, false);
  assert.equal(x.balance_due_on_bol, 0);
  assert.deepEqual(x.low_confidence, ["final_cf"]);
  assert.equal("extra" in x, false);
  assert.equal(x.confidence, 0.92);
  assert.equal(normalizeExtraction(null).confidence, 0.35);
});
t("review outcome and Telegram notice", () => {
  const d = { ...d57, final_cf: null, collected: null, status: "docs_received" };
  assert.deepEqual(reviewOutcome(d, { final_cf: 800, collected: 2950 }), { pay: 2080, net: 870, short: 0 });
  assert.deepEqual(reviewOutcome({ ...d, expected_collect: 1650, rate_per_cf: 2.7 }, { final_cf: 540, collected: 1400 }), { pay: 1458, net: -58, short: 250 });
  const msg = docsNotice({ dispatch: d, carrier: bravo, extraction: normalizeExtraction({ final_cf: 800, amount_collected: 2950, payment_breakdown: "cash + Zelle", customer_signed: true }), appUrl: "https://crm.example/" });
  assert.match(msg, /New carrier docs · NB-24107 \(D57\)/);
  assert.match(msg, /they owe us \$870/);
  assert.match(msg, /https:\/\/crm\.example › Carriers › Docs to review/);
  assert.match(docsNotice({ dispatch: null, carrier: null, extraction: null }), /not matched/);
});

if (!process.exitCode) console.log("\nAll carrier data tests passed.");
