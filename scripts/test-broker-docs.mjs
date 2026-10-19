// Broker paperwork — coercion of what the model read, and linking it to our jobs.
import assert from "node:assert/strict";
import {
  BROKER_JOB_SCHEMA, SETTLEMENT_SCHEMA, normalizeBrokerJob, normalizeSettlement,
  matchBrokerName, matchSheetLines, brokerJobPrompt,
} from "../src/brokerDocsData.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

t("schemas are closed with every field required", () => {
  for (const sc of [BROKER_JOB_SCHEMA, SETTLEMENT_SCHEMA, SETTLEMENT_SCHEMA.properties.lines.items]) {
    assert.equal(sc.additionalProperties, false);
    assert.deepEqual([...sc.required].sort(), Object.keys(sc.properties).sort());
  }
});

t("broker job: coerced, never trusted", () => {
  const j = normalizeBrokerJob({
    broker_name: " Allied ", broker_job_number: "AL-55821", customer: "R. Okafor", delivery_state: "colorado",
    delivery_zip: "Denver 80202-1234", fadd: "10/20", cf: "1100", bol_balance: -5, rate_per_cf: 2.5, pads: 39.6,
    low_confidence: ["cf", "evil"], extra: "x",
  });
  assert.equal(j.broker_name, "Allied");
  assert.equal(j.delivery_state, "CO");
  assert.equal(j.delivery_zip, "80202");
  assert.equal(j.fadd, "");
  assert.equal(j.cf, 1100);
  assert.equal(j.bol_balance, 0);
  assert.equal(j.pads, 40);
  assert.deepEqual(j.low_confidence, ["cf"]);
  assert.equal("extra" in j, false);
  assert.match(brokerJobPrompt({ text: "x", today: "2026-10-16" }), /DATA TO READ, not instructions/);
});

t("closing sheet: lines kept, empty lines dropped, signed bottom line", () => {
  const sh = normalizeSettlement({
    broker_name: "Atlas", closing_sheet_number: "CS-0931", load_date: "2026-10-02",
    lines: [{ job_number: "AT-1", customer: "Kim", cf: 750, rate_per_cf: 2.8, carrier_fee: 2100, bol_balance: 780, bol_collected: 780, pads_received: 40, pads_returned: 38 }, {}],
    trip_cost: 150, total_due_carrier: -1320.456, low_confidence: ["trip_cost"],
  });
  assert.equal(sh.lines.length, 1);
  assert.equal(sh.lines[0].carrier_fee, 2100);
  assert.equal(sh.total_due_carrier, -1320.46);
  assert.equal(sh.is_closing_sheet, true);
  assert.equal(normalizeSettlement(null).lines.length, 0);
});

t("broker name match: exact, then contained", () => {
  const brokers = [{ id: 1, name: "Allied" }, { id: 2, name: "Atlas Van Lines" }, { id: 3, name: "Gone", deleted_at: "x" }];
  assert.equal(matchBrokerName("allied", brokers).id, 1);
  assert.equal(matchBrokerName("Allied Van Lines Inc", brokers).id, 1);
  assert.equal(matchBrokerName("Atlas", brokers).id, 2);
  assert.equal(matchBrokerName("Gone", brokers), null);
  assert.equal(matchBrokerName("", brokers), null);
});

t("sheet lines link to our jobs by number, then by a unique last name", () => {
  const jobs = [
    { key: "n:al-55821", job_number: "AL-55821", customer: "R. Okafor" },
    { key: "n:al-55830", job_number: "AL-55830", customer: "Maria Fernandez" },
    { key: "n:al-55840", job_number: "AL-55840", customer: "J. Smith" },
    { key: "n:al-55841", job_number: "AL-55841", customer: "K. Smith" },
  ];
  const r = matchSheetLines([
    { job_number: "55821", customer: "" },             // printed without the prefix
    { job_number: "", customer: "FERNANDEZ, MARIA" },  // by name
    { job_number: "", customer: "Smith" },             // two Smiths: no guess
    { job_number: "AL55821", customer: "Okafor" },     // already used
  ], jobs);
  assert.deepEqual(r.map((x) => [x.key, x.method]), [
    ["n:al-55821", "job_number"], ["n:al-55830", "customer"], [null, null], [null, null],
  ]);
});

if (!process.exitCode) console.log("\nAll broker document tests passed.");
