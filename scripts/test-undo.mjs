// Tests for src/undo.js against an in-memory stand-in for supabase-js: soft
// delete, restore, and — the reason this file exists — restoring a row from
// the Trash together with the children that were deleted with it.
// Run: node scripts/test-undo.mjs (npm test picks it up).
import assert from "node:assert/strict";
import { createUndoManager, CASCADE_WINDOW_MS } from "../src/undo.js";

const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// ── Minimal PostgREST-shaped fake ────────────────────────────────────────────
// Supports the chain shapes undo.js uses: from().select().eq/in/is/not/gte/lte
// [.maybeSingle()], from().update().eq/in, from().insert(). Missing tables
// answer with a 42P01 error like Postgres does.
function fakeSupabase(tables) {
  const db = structuredClone(tables);
  const log = [];
  function from(table) {
    const filters = [];
    let op = "select", patch = null, single = false;
    const match = (r) => filters.every((f) => f(r));
    const b = {
      select() { op = "select"; return b; },
      update(p) { op = "update"; patch = p; return b; },
      insert(rows) { op = "insert"; patch = rows; return b; },
      eq(col, v) { filters.push((r) => r[col] === v); return b; },
      in(col, vs) { filters.push((r) => vs.includes(r[col])); return b; },
      is(col, v) { filters.push((r) => (v === null ? r[col] == null : r[col] === v)); return b; },
      not(col, opName, v) { assert.equal(opName, "is"); filters.push((r) => (v === null ? r[col] != null : r[col] !== v)); return b; },
      gte(col, v) { filters.push((r) => r[col] >= v); return b; },
      lte(col, v) { filters.push((r) => r[col] <= v); return b; },
      maybeSingle() { single = true; return b; },
      then(resolve) {
        if (!db[table]) return resolve({ data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } });
        log.push({ table, op, patch });
        if (op === "insert") { db[table].push(...patch); return resolve({ data: patch, error: null }); }
        const rows = db[table].filter(match);
        if (op === "update") { rows.forEach((r) => Object.assign(r, patch)); return resolve({ data: rows, error: null }); }
        const data = rows.map((r) => ({ ...r }));
        return resolve({ data: single ? (data[0] ?? null) : data, error: null });
      },
    };
    return b;
  }
  return { from, db, log };
}

const T0 = Date.parse("2026-09-10T12:00:00Z");
const iso = (ms) => new Date(ms).toISOString();

// A job deleted through deleteJob: extras and payments stamped ~200ms before
// the job itself, plus an extra the user had removed on its own the day before.
function scenario() {
  return {
    storage_jobs: [
      { id: 10, job_number: "J-10", deleted_at: iso(T0) },
      { id: 11, job_number: "J-11", deleted_at: null },
    ],
    job_extras: [
      { id: 100, job_id: 10, amount: 50, deleted_at: iso(T0 - 200) },   // deleted with the job
      { id: 101, job_id: 10, amount: 20, deleted_at: iso(T0 - 86400e3) }, // removed on its own, a day earlier
      { id: 102, job_id: 11, amount: 5, deleted_at: null },
    ],
    payments: [
      { id: 200, job_id: 10, amount: 500, deleted_at: iso(T0 - 150), cc_fee_payment_id: 201 },
      { id: 201, job_id: 10, amount: 15, concept: "cc_fee", deleted_at: iso(T0 - 150), cc_fee_payment_id: null },
      { id: 202, job_id: 11, amount: 1, deleted_at: null, cc_fee_payment_id: null },
    ],
    action_log: [],
  };
}

await ta("restoreWithChildren: a job comes back with the extras and payments deleted with it", async () => {
  const sb = fakeSupabase(scenario());
  const mgr = createUndoManager(sb);
  const res = await mgr.restoreWithChildren("storage_jobs", 10);
  assert.equal(res.error, null);
  assert.equal(sb.db.storage_jobs.find((r) => r.id === 10).deleted_at, null, "job restored");
  assert.equal(sb.db.job_extras.find((r) => r.id === 100).deleted_at, null, "extra deleted with the job restored");
  assert.equal(sb.db.payments.find((r) => r.id === 200).deleted_at, null, "payment restored");
  assert.equal(sb.db.payments.find((r) => r.id === 201).deleted_at, null, "cc fee payment (same job) restored");
  const tables = res.entries.map((e) => `${e.table}:${e.id}`).sort();
  assert.deepEqual(tables, ["job_extras:100", "payments:200", "payments:201", "storage_jobs:10"]);
  assert.ok(res.entries.every((e) => e.action === "restore"));
});

await ta("restoreWithChildren: a child deleted on its own earlier stays in the trash", async () => {
  const sb = fakeSupabase(scenario());
  const mgr = createUndoManager(sb);
  await mgr.restoreWithChildren("storage_jobs", 10);
  assert.notEqual(sb.db.job_extras.find((r) => r.id === 101).deleted_at, null);
});

await ta("restoreWithChildren: other jobs' rows are untouched", async () => {
  const sb = fakeSupabase(scenario());
  const mgr = createUndoManager(sb);
  sb.db.job_extras.push({ id: 103, job_id: 11, amount: 9, deleted_at: iso(T0 - 100) }); // same moment, different job
  await mgr.restoreWithChildren("storage_jobs", 10);
  assert.notEqual(sb.db.job_extras.find((r) => r.id === 103).deleted_at, null);
});

await ta("restoreWithChildren: the window is a few minutes, not unbounded", async () => {
  const sb = fakeSupabase(scenario());
  sb.db.job_extras.push({ id: 104, job_id: 10, amount: 1, deleted_at: iso(T0 - CASCADE_WINDOW_MS - 1000) });
  const mgr = createUndoManager(sb);
  await mgr.restoreWithChildren("storage_jobs", 10);
  assert.notEqual(sb.db.job_extras.find((r) => r.id === 104).deleted_at, null);
});

await ta("restoreWithChildren: a payment brings back its cc-fee sibling and split extras", async () => {
  const sb = fakeSupabase({
    payments: [
      { id: 1, job_id: 5, amount: 100, cc_fee_payment_id: 2, deleted_at: iso(T0) },
      { id: 2, job_id: 5, amount: 3, concept: "cc_fee", cc_fee_payment_id: null, deleted_at: iso(T0 - 100) },
    ],
    job_extras: [{ id: 7, payment_id: 1, amount: 40, deleted_at: iso(T0 - 120) }],
    action_log: [],
  });
  const mgr = createUndoManager(sb);
  const res = await mgr.restoreWithChildren("payments", 1);
  assert.equal(res.error, null);
  assert.ok(sb.db.payments.every((r) => r.deleted_at === null));
  assert.equal(sb.db.job_extras[0].deleted_at, null);
});

await ta("restoreWithChildren: a child table that is not set up is skipped, not fatal", async () => {
  const sb = fakeSupabase({ storage_jobs: [{ id: 1, deleted_at: iso(T0) }], action_log: [] }); // no job_extras / payments tables
  const mgr = createUndoManager(sb);
  const res = await mgr.restoreWithChildren("storage_jobs", 1);
  assert.equal(res.error, null);
  assert.equal(sb.db.storage_jobs[0].deleted_at, null);
  assert.equal(res.entries.length, 1);
});

await ta("restoreWithChildren: a table without cascade rules restores just the row", async () => {
  const sb = fakeSupabase({ brokers: [{ id: 3, name: "Atlas", deleted_at: iso(T0) }], action_log: [] });
  const mgr = createUndoManager(sb);
  const res = await mgr.restoreWithChildren("brokers", 3);
  assert.equal(res.error, null);
  assert.deepEqual(res.entries.map((e) => e.table), ["brokers"]);
});

await ta("restore: a failed select is reported instead of silently restoring nothing", async () => {
  const sb = fakeSupabase({ action_log: [] });
  const mgr = createUndoManager(sb);
  const res = await mgr.restore("ghost_table", 1);
  assert.ok(res.error, "error surfaced");
  assert.equal(res.entries.length, 0);
});

await ta("softDelete + undo: the batch replays back to the original state", async () => {
  const sb = fakeSupabase({ storage_jobs: [{ id: 1, deleted_at: null }, { id: 2, deleted_at: null }], action_log: [] });
  const mgr = createUndoManager(sb);
  const del = await mgr.softDelete("storage_jobs", [1, 2]);
  assert.equal(del.error, null);
  assert.equal(del.entries.length, 2);
  assert.ok(sb.db.storage_jobs.every((r) => r.deleted_at));
  mgr.record("two jobs", del.entries);
  assert.equal(mgr.canUndo(), true);
  const u = await mgr.undo();
  assert.equal(u.error, null);
  assert.ok(sb.db.storage_jobs.every((r) => r.deleted_at === null));
  assert.equal(mgr.canRedo(), true);
});

if (process.exitCode) console.log("\nSome undo tests failed."); else console.log("\nAll undo tests passed.");
