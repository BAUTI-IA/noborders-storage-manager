// Tests for the email copy of the notifications bell (lib/notifyEmail.mjs):
// the message itself, and who gets emailed — only the caller's own fresh,
// never-emailed notifications for that note, once each.
// Run: node scripts/test-notify-email.mjs (npm test picks it up).
import assert from "node:assert/strict";
import { mentionEmail, emailMentionNotifications, EMAIL_WINDOW_MS } from "../lib/notifyEmail.mjs";

const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

// ── Minimal PostgREST-shaped fake: from().update/select().eq/is/gte/in()[.select()] ──
function fakeDb(tables, { failSelect = null } = {}) {
  const db = structuredClone(tables);
  function from(table) {
    const filters = [];
    let op = "select", patch = null, returning = false;
    const q = {
      update(p) { op = "update"; patch = p; return q; },
      select() { if (op === "update") returning = true; return q; },
      eq(k, v) { filters.push((r) => r[k] === v); return q; },
      is(k, v) { filters.push((r) => (r[k] ?? null) === v); return q; },
      gte(k, v) { filters.push((r) => String(r[k]) >= v); return q; },
      in(k, vs) { filters.push((r) => vs.includes(r[k])); return q; },
      then(resolve) {
        if (failSelect === table && op === "select") return resolve({ data: null, error: { message: "boom" } });
        const rows = (db[table] || []).filter((r) => filters.every((f) => f(r)));
        if (op === "update") { for (const r of rows) Object.assign(r, patch); return resolve({ data: returning ? structuredClone(rows) : null, error: null }); }
        return resolve({ data: structuredClone(rows), error: null });
      },
    };
    return q;
  }
  return { from, db };
}
function fakeFetch({ failFor = [] } = {}) {
  const calls = [];
  const fn = async (url, init) => {
    const body = JSON.parse(init.body);
    calls.push({ url, headers: init.headers, body });
    if (failFor.includes(body.to[0])) return { ok: false, status: 422, text: async () => "domain not verified" };
    return { ok: true, status: 200, text: async () => "{}" };
  };
  fn.calls = calls;
  return fn;
}

const NOW = new Date("2026-10-07T12:00:00Z");
const ago = (min) => new Date(NOW.getTime() - min * 60000).toISOString();
const ME = "u-seba";
const base = () => ({
  notifications: [
    { id: 1, user_id: "u-gonza", from_id: ME, from_name: "Sebastian", event_id: 50, job_id: 501, job_number: "B6048595", customer: "Mark Schoor", body: "@Gonzalo confirm the customer", emailed_at: null, created_at: ago(1) },
    { id: 2, user_id: "u-yancy", from_id: ME, from_name: "Sebastian", event_id: 50, job_id: 501, job_number: "B6048595", customer: "Mark Schoor", body: "@Yancy too", emailed_at: null, created_at: ago(1) },
    { id: 3, user_id: "u-gonza", from_id: "u-other", from_name: "Other", event_id: 50, body: "not mine", emailed_at: null, created_at: ago(1) },
    { id: 4, user_id: "u-gonza", from_id: ME, from_name: "Sebastian", event_id: 49, body: "another note", emailed_at: null, created_at: ago(1) },
    { id: 5, user_id: "u-gonza", from_id: ME, from_name: "Sebastian", event_id: 50, body: "old", emailed_at: null, created_at: ago(60) },
    { id: 6, user_id: "u-old", from_id: ME, from_name: "Sebastian", event_id: 50, body: "inactive", emailed_at: null, created_at: ago(1) },
  ],
  profiles: [
    { id: "u-gonza", email: "gonza@nb.com", full_name: "Gonzalo Balassanian", active: true },
    { id: "u-yancy", email: "yancy@nb.com", full_name: "Yancy", active: true },
    { id: "u-old", email: "old@nb.com", full_name: "Old", active: false },
  ],
});
const run = (db, extra = {}) => emailMentionNotifications({ db, userId: ME, eventId: 50, appUrl: "https://crm.nb.com/", apiKey: "re_test", from: "CRM <crm@nb.com>", now: () => NOW, ...extra });

await ta("message: subject, escaped note, link that opens the job and marks it read", () => {
  const m = mentionEmail({ n: { id: 9, job_id: 501, job_number: "B6048595", customer: "Mark <Schoor>", from_name: "Sebastian", body: "<script>x</script> & go" }, recipientName: "Gonzalo", appUrl: "https://crm.nb.com/" });
  assert.equal(m.subject, "Sebastian tagged you · Job B6048595 · Mark <Schoor>");
  assert.ok(m.html.includes("&lt;script&gt;x&lt;/script&gt; &amp; go"), "note must be HTML-escaped");
  assert.ok(!m.html.includes("<script>"), "no raw markup from the note");
  assert.ok(m.html.includes("Mark &lt;Schoor&gt;"));
  assert.ok(m.html.includes('href="https://crm.nb.com/?job=501&amp;notif=9"'));
  assert.ok(m.text.includes("Open the job: https://crm.nb.com/?job=501&notif=9"));
  assert.ok(m.text.startsWith("Hi Gonzalo,"));
});

await ta("message: no APP_URL → no broken link", () => {
  const m = mentionEmail({ n: { id: 9, from_name: "", body: "hi" }, appUrl: "" });
  assert.equal(m.subject, "A teammate tagged you");
  assert.ok(!m.html.includes("href="));
  assert.ok(!m.text.includes("Open the job"));
});

await ta("not configured → skipped, nothing claimed", async () => {
  const { db, from } = fakeDb(base());
  const f = fakeFetch();
  const out = await run({ from }, { apiKey: "", fetchImpl: f });
  assert.ok(out.body.skipped);
  assert.equal(f.calls.length, 0);
  assert.ok(db.notifications.every((n) => n.emailed_at === null));
});

await ta("sends only the caller's fresh rows for that note, once, to active profiles", async () => {
  const { db, from } = fakeDb(base());
  const f = fakeFetch();
  const out = await run({ from }, { fetchImpl: f });
  assert.deepEqual(out.body, { ok: true, sent: 2, failed: 0, skipped: 1 });
  assert.deepEqual(f.calls.map((c) => c.body.to[0]).sort(), ["gonza@nb.com", "yancy@nb.com"]);
  assert.equal(f.calls[0].headers.Authorization, "Bearer re_test");
  assert.equal(f.calls[0].body.from, "CRM <crm@nb.com>");
  assert.ok(f.calls.every((c) => c.headers["Idempotency-Key"].startsWith("crm-notification-")));
  const stamped = db.notifications.filter((n) => n.emailed_at).map((n) => n.id).sort();
  assert.deepEqual(stamped, [1, 2, 6], "someone else's (3), another note's (4) and an old one (5) stay untouched");
  // A replay of the same call sends nothing new.
  const again = await run({ from }, { fetchImpl: f });
  assert.equal(again.body.sent, 0);
  assert.equal(f.calls.length, 2);
});

await ta("the window: a notification older than it is never emailed", async () => {
  assert.ok(EMAIL_WINDOW_MS >= 5 * 60000 && EMAIL_WINDOW_MS <= 60 * 60000);
  const { db, from } = fakeDb(base());
  await run({ from }, { fetchImpl: fakeFetch() });
  assert.equal(db.notifications.find((n) => n.id === 5).emailed_at, null);
});

await ta("a failed send is un-claimed so it can go out later; the others still send", async () => {
  const { db, from } = fakeDb(base());
  const out = await run({ from }, { fetchImpl: fakeFetch({ failFor: ["yancy@nb.com"] }) });
  assert.deepEqual(out.body, { ok: false, sent: 1, failed: 1, skipped: 1 });
  assert.equal(db.notifications.find((n) => n.id === 2).emailed_at, null);
  assert.ok(db.notifications.find((n) => n.id === 1).emailed_at);
});

await ta("profiles lookup failing → nothing sent and the claim is given back", async () => {
  const { db, from } = fakeDb(base(), { failSelect: "profiles" });
  const f = fakeFetch();
  const out = await run({ from }, { fetchImpl: f });
  assert.equal(out.status, 500);
  assert.equal(f.calls.length, 0);
  assert.ok([1, 2, 6].every((id) => db.notifications.find((n) => n.id === id).emailed_at === null));
});

await ta("bad event id → 400", async () => {
  const { from } = fakeDb(base());
  const out = await run({ from }, { eventId: undefined, fetchImpl: fakeFetch() });
  assert.equal(out.status, 400);
});
