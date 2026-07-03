// Fixture tests for the payment-allocation math (src/paymentAlloc.js).
// Run: node scripts/test-payment-alloc.mjs
import assert from "node:assert/strict";
import { paymentNet, buildJobCharges, proposeAllocation, serializeAllocLines } from "../src/paymentAlloc.js";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// Fixtures: job owes 1000; extras: packing $200 (old), stairs $150 (new).
const extras = [
  { id: 1, extra_type: "packing", amount: 200, active: true, created_at: "2026-01-01" },
  { id: 2, extra_type: "stairs", amount: 150, active: true, created_at: "2026-02-01" },
  { id: 3, extra_type: "shuttle", amount: 99, active: false, created_at: "2026-01-15" }, // inactive → not a charge
];

t("paymentNet = amount − discount", () => {
  assert.equal(paymentNet({ amount: 100, discount: 10 }), 90);
  assert.equal(paymentNet({ amount: "50", discount: "" }), 50);
});

t("per-extra collected via job_extra_id; job remaining independent", () => {
  const st = buildJobCharges({ expected: 1000, extras, payments: [
    { id: 10, concept: "job", amount: 400, received: true },
    { id: 11, concept: "extra", amount: 120, received: true, job_extra_id: 1 },
  ]});
  assert.equal(st.jobCharge.remaining, 600);
  assert.equal(st.extraCharges.length, 2); // inactive excluded
  assert.equal(st.extraCharges[0].collected, 120);      // packing (oldest first)
  assert.equal(st.extraCharges[0].remaining, 80);
  assert.equal(st.extraCharges[1].remaining, 150);      // stairs untouched
});

t("legacy fallback: payment that created the extra (payment_id) counts once, no double count", () => {
  const legacyExtras = [{ id: 5, extra_type: "packing", amount: 300, active: true, created_at: "2026-01-01", payment_id: 77 }];
  const st = buildJobCharges({ expected: 0, extras: legacyExtras, payments: [
    { id: 77, concept: "extra", amount: 300, received: true },            // created the extra (legacy split)
    { id: 78, concept: "extra", amount: 50, received: true },             // unrelated legacy extra payment
  ]});
  assert.equal(st.extraCharges[0].collected, 300);
  assert.equal(st.extraCharges[0].remaining, 0);
  assert.equal(st.unattributedExtraCollected, 50);      // shown aggregate-only
});

t("mixed legacy + explicit links don't double count", () => {
  const ex = [{ id: 5, extra_type: "packing", amount: 300, active: true, payment_id: 77 }];
  const st = buildJobCharges({ expected: 0, extras: ex, payments: [
    { id: 77, concept: "extra", amount: 100, received: true, job_extra_id: 5 }, // explicit wins, counted once
  ]});
  assert.equal(st.extraCharges[0].collected, 100);
});

t("unreceived payments don't count; on_account accumulates", () => {
  const st = buildJobCharges({ expected: 500, extras: [], payments: [
    { id: 1, concept: "job", amount: 100, received: false },
    { id: 2, concept: "on_account", amount: 80, received: true },
  ]});
  assert.equal(st.jobCharge.remaining, 500);
  assert.equal(st.onAccount, 80);
});

t("proposal: job first, then oldest extra, remainder unassigned", () => {
  const st = buildJobCharges({ expected: 1000, extras, payments: [] });
  const { lines, unassigned } = proposeAllocation(1300, st);
  assert.equal(lines[0].kind, "job");     assert.equal(Number(lines[0].amount), 1000);
  assert.equal(lines[1].job_extra_id, 1); assert.equal(Number(lines[1].amount), 200);
  assert.equal(lines[2].job_extra_id, 2); assert.equal(Number(lines[2].amount), 100); // partial
  assert.equal(unassigned, 0);
  const over = proposeAllocation(1500, st);
  assert.equal(over.unassigned, 150);     // 1500 − (1000+200+150)
});

t("proposal with no extras degrades to job line only", () => {
  const st = buildJobCharges({ expected: 500, extras: [], payments: [] });
  const { lines } = proposeAllocation(300, st);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].kind, "job");
  assert.equal(Number(lines[0].amount), 300);
});

t("serialize: remainder becomes unassigned; over-allocation is an error; overpay of one charge is allowed", () => {
  const ok = serializeAllocLines([{ kind: "job", amount: "300" }, { kind: "extra", job_extra_id: 1, amount: "100" }], 500);
  assert.equal(ok.error, null); assert.equal(ok.unassigned, 100); assert.equal(ok.rows.length, 2);
  const bad = serializeAllocLines([{ kind: "job", amount: "600" }], 500);
  assert.ok(bad.error);
  const overpay = serializeAllocLines([{ kind: "extra", job_extra_id: 1, amount: "500", remaining: 200 }], 500);
  assert.equal(overpay.error, null);      // warning-level only, serializes fine
});

t("reallocation serializer: exact fit, no remainder", () => {
  const st = buildJobCharges({ expected: 0, extras, payments: [] });
  const { lines, unassigned } = proposeAllocation(350, st);
  const s = serializeAllocLines(lines, 350);
  assert.equal(unassigned, 0); assert.equal(s.error, null);
  assert.equal(s.rows.reduce((x, l) => x + l.amount, 0), 350);
});

console.log(process.exitCode ? "\nSOME TESTS FAILED" : "\nALL ALLOCATION TESTS PASSED");
