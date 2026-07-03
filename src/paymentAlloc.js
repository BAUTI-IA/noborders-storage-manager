// Payment-allocation math (pure, no deps) — how a job's charges (job balance +
// each extra) relate to its payments, and how a new payment gets proposed and
// serialized against them. Kept out of App.jsx so it can be unit-tested with
// plain node (`node scripts/test-payment-alloc.mjs`).

const num = (v) => (v === "" || v == null || isNaN(Number(v))) ? 0 : Number(v);

// Net of a payment row: amount − discount.
export function paymentNet(p) { return num(p.amount) - num(p.discount); }

// Charge state for one job.
//   expected  — job balance owed (pickup + delivery + bol)
//   extras    — job_extras rows (only active ones are charges)
//   payments  — RECEIVED payments of the job group
// Per-extra collected rule (no double count):
//   1) payments explicitly linked via payments.job_extra_id === extra.id
//   2) legacy fallback: the payment that CREATED the extra (extra.payment_id
//      back-link written by the old split flow) when it has no job_extra_id
// Extra-concept payments matching neither stay aggregate-only
// (unattributedExtraCollected) so old data displays without double-counting.
export function buildJobCharges({ expected, extras, payments }) {
  const received = (payments || []).filter(p => p.received);
  const jobCollected = received.filter(p => p.concept === "job").reduce((s, p) => s + paymentNet(p), 0);
  const jobCharge = {
    kind: "job",
    expected: num(expected),
    collected: jobCollected,
    remaining: Math.max(0, num(expected) - jobCollected),
  };

  const activeExtras = (extras || []).filter(e => e.active !== false)
    .slice().sort((a, b) => String(a.created_at || "").localeCompare(String(b.created_at || "")) || num(a.id) - num(b.id));
  const used = new Set(); // payment ids consumed by a specific extra
  const extraCharges = activeExtras.map(e => {
    let collected = 0;
    for (const p of received) {
      if (used.has(p.id)) continue;
      const linked = p.job_extra_id != null && Number(p.job_extra_id) === Number(e.id);
      const legacy = p.job_extra_id == null && p.concept === "extra" && e.payment_id != null && Number(e.payment_id) === Number(p.id);
      if (linked || legacy) { collected += paymentNet(p); used.add(p.id); }
    }
    const amount = num(e.amount);
    return { kind: "extra", extra: e, amount, collected, remaining: Math.max(0, amount - collected) };
  });

  const onAccount = received.filter(p => p.concept === "on_account").reduce((s, p) => s + paymentNet(p), 0);
  const unattributedExtraCollected = received
    .filter(p => p.concept === "extra" && !used.has(p.id))
    .reduce((s, p) => s + paymentNet(p), 0);

  return { jobCharge, extraCharges, onAccount, unattributedExtraCollected };
}

// Greedy proposal: fill the job balance first, then extras oldest-first;
// whatever doesn't fit stays unassigned ("a cuenta").
// Returns { lines: [{ kind, job_extra_id?, label, remaining, amount }], unassigned }.
export function proposeAllocation(total, charges) {
  let left = Math.max(0, num(total));
  const lines = [];
  const push = (kind, remaining, extra) => {
    const amount = Math.min(left, remaining);
    left -= amount;
    lines.push({ kind, job_extra_id: extra ? extra.id : null, remaining, amount: amount > 0 ? String(round2(amount)) : "" });
  };
  if (charges.jobCharge.remaining > 0 || charges.extraCharges.length === 0) push("job", charges.jobCharge.remaining, null);
  for (const c of charges.extraCharges) push("extra", c.remaining, c.extra);
  return { lines, unassigned: round2(left) };
}

// Validate + serialize the edited lines against the payment total.
// A line may exceed its charge's remaining (overpay → warning, allowed);
// the SUM of lines may not exceed the total (error). Remainder ≥ 0 becomes
// the on-account row.
export function serializeAllocLines(lines, total) {
  const t = num(total);
  const rows = (lines || []).filter(l => num(l.amount) > 0).map(l => ({ ...l, amount: num(l.amount) }));
  const sum = rows.reduce((s, l) => s + l.amount, 0);
  const unassigned = round2(t - sum);
  if (unassigned < -0.01) return { rows, unassigned, error: `Las asignaciones superan el total en $${Math.abs(unassigned).toLocaleString()}` };
  return { rows, unassigned: Math.max(0, unassigned), error: null };
}

function round2(n) { return Math.round(n * 100) / 100; }
