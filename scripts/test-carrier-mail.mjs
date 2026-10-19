// Carrier inbox (lib/carrierMail.mjs) against an in-memory database, storage
// and model: outbox → ack, a new email → signed uploads → finalize, dedupe,
// unknown senders, ACCEPT replies, and the door's secret.
import assert from "node:assert/strict";
import { fakeDb } from "./fake-supabase.mjs";

// The module loads the shared clients; keep them inert.
delete process.env.SUPABASE_SERVICE_ROLE_KEY;
process.env.ANTHROPIC_API_KEY ||= "test-key";
const { listOutbox, ackOutbox, receiveMessage, finalizeMessage, carrierMail } = await import("../lib/carrierMail.mjs");
const { carrierMailDoor } = await import("../api/agent-hub.mjs");

const ta = async (name, fn) => { try { await fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const NOW = new Date("2026-10-14T22:20:00Z");

function fakeStorage(files = {}) {
  const store = { ...files };
  const bucket = () => ({
    createSignedUrl: async (path) => ({ data: { signedUrl: `https://storage.test/sign/${path}?t=1` }, error: null }),
    createSignedUploadUrl: async (path) => ({ data: { signedUrl: `https://storage.test/upload/${path}?token=x`, path, token: "x" }, error: null }),
    download: async (path) => store[path]
      ? { data: { arrayBuffer: async () => new TextEncoder().encode(store[path]).buffer }, error: null }
      : { data: null, error: { message: "not found" } },
  });
  return { store, from: bucket };
}

function world() {
  const { from, db } = fakeDb({
    carriers: [
      { id: 2, name: "Carrier Bravo Moving", email: "ops@carrierbravo.com, mike@carrierbravo.com" },
      { id: 3, name: "Carrier Charlie", email: "charlie@charlietransport.com" },
    ],
    carrier_dispatches: [
      { id: 57, carrier_id: 2, job_number: "NB-24107", status: "sent", rate_type: "per_cf", rate_per_cf: 2.6, est_cf: 800, expected_collect: 2950, sent_at: null },
      { id: 58, carrier_id: 2, job_number: "NB-24111", status: "accepted", rate_type: "per_cf", rate_per_cf: 2.7, est_cf: 650, expected_collect: 2300 },
    ],
    carrier_messages: [
      { id: 1, direction: "out", channel: "email", status: "queued", dispatch_id: 57, to_addr: "ops@carrierbravo.com", subject: "[Job NB-24107 · D57] Dispatch", body_text: "Hi", body_html: "<p>Hi</p>", attachments: [{ path: "ratecons/D57.pdf", name: "RateCon_NB-24107.pdf", mime: "application/pdf" }], created_at: "2026-10-08T10:40:00Z" },
      { id: 2, direction: "out", channel: "whatsapp", status: "logged", dispatch_id: 57, created_at: "2026-10-08T10:41:00Z" },
    ],
  });
  const notices = [];
  const extractCalls = [];
  const deps = {
    db: { from }, storage: fakeStorage(), now: () => NOW, appUrl: "https://crm.test",
    notify: async (text) => { notices.push(text); return true; },
    extract: async (args) => {
      extractCalls.push(args);
      return { has_completion_docs: true, job_number: "NB-24107", final_cf: 800, amount_collected: 2950, payment_methods: ["cash", "zelle"], payment_breakdown: "$1,500 cash + $1,450 Zelle", delivery_date: "2026-10-14", customer_signed: true, driver_signed: true, balance_due_on_bol: 2950, notes: "", low_confidence: [], confidence: 1 };
    },
  };
  return { db, deps, notices, extractCalls };
}

const mail = (over = {}) => ({
  step: "message", from: "Mike Reyes <mike@carrierbravo.com>", to: "dispatch+cd57@nobordersmoving.com",
  subject: "Re: [Job NB-24107 · D57] Dispatch · Chicago, IL → Atlanta, GA", message_id: "gm-1", thread_id: "th-1",
  text: "Delivered today. Customer paid $2,950. BOL attached.\n\nOn Oct 8 No Borders wrote:\n> Hi",
  attachments: [{ name: "BOL NB-24107 signed.pdf", mime: "application/pdf", size: 120000 }, { name: "zelle.jpg", mime: "image/jpeg", size: 90000 }],
  ...over,
});

await ta("outbox lists queued emails with a signed link to the rate confirmation", async () => {
  const { deps } = world();
  const out = await listOutbox(deps);
  assert.equal(out.messages.length, 1);
  assert.equal(out.messages[0].id, 1);
  assert.equal(out.messages[0].to, "ops@carrierbravo.com");
  assert.match(out.messages[0].attachments[0].url, /ratecons\/D57\.pdf/);
});

await ta("ack marks the email sent and stamps the dispatch; a repeat ack changes nothing", async () => {
  const { db, deps } = world();
  assert.deepEqual(await ackOutbox({ id: 1, gmail_message_id: "gm-out-1", gmail_thread_id: "th-1", from: "dispatch@nobordersmoving.com" }, deps), { ok: true, status: "sent" });
  const m = db.carrier_messages.find((x) => x.id === 1);
  assert.equal(m.status, "sent");
  assert.equal(m.gmail_thread_id, "th-1");
  assert.equal(db.carrier_dispatches.find((d) => d.id === 57).sent_at, NOW.toISOString());
  assert.deepEqual(await ackOutbox({ id: 1, ok: false, error: "late" }, deps), { ok: true, status: "sent" });
  assert.equal((await listOutbox(deps)).messages.length, 0);
});

await ta("a failed send is recorded with its error", async () => {
  const { db, deps } = world();
  await ackOutbox({ id: 1, ok: false, error: "Invalid email: ops@" }, deps);
  const m = db.carrier_messages.find((x) => x.id === 1);
  assert.equal(m.status, "failed");
  assert.equal(m.error, "Invalid email: ops@");
});

await ta("new mail with documents: filed, uploads signed, then read, matched and announced", async () => {
  const { db, deps, notices, extractCalls } = world();
  const r = await receiveMessage(mail(), deps);
  assert.equal(r.status, "receiving");
  assert.equal(r.uploads.length, 2);
  const row = db.carrier_messages.find((x) => x.id === r.id);
  assert.equal(row.carrier_id, 2);
  assert.deepEqual(row.attachments.map((a) => a.path), [`inbox/${r.id}/1-BOL_NB-24107_signed.pdf`, `inbox/${r.id}/2-zelle.jpg`]);
  // The script PUTs the bytes, then finalizes.
  deps.storage.store[row.attachments[0].path] = "%PDF-1.7 fake";
  deps.storage.store[row.attachments[1].path] = "jpeg bytes";
  const f = await finalizeMessage({ id: r.id }, deps);
  assert.deepEqual(f, { ok: true, id: r.id, status: "review", dispatch_id: 57 });
  assert.equal(extractCalls.length, 1);
  assert.deepEqual(extractCalls[0].files.map((x) => x.mime), ["application/pdf", "image/jpeg"]);
  assert.equal(extractCalls[0].dispatch.id, 57);
  const after = db.carrier_messages.find((x) => x.id === r.id);
  assert.equal(after.match_method, "tag");
  assert.equal(after.extraction.amount_collected, 2950);
  assert.equal(db.carrier_dispatches.find((d) => d.id === 57).status, "docs_received");
  assert.equal(notices.length, 1);
  assert.match(notices[0], /NB-24107 \(D57\)/);
  assert.match(notices[0], /they owe us \$870/);
  // Finalizing twice does nothing more.
  assert.deepEqual(await finalizeMessage({ id: r.id }, deps), { ok: true, id: r.id, status: "review" });
  assert.equal(extractCalls.length, 1);
});

await ta("the same Gmail message twice is a duplicate; a half-received one gets fresh upload URLs", async () => {
  const { deps } = world();
  const first = await receiveMessage(mail(), deps);
  const again = await receiveMessage(mail(), deps);
  assert.equal(again.id, first.id);
  assert.equal(again.status, "receiving");
  assert.equal(again.uploads.length, 2);
  await finalizeMessage({ id: first.id }, deps);
  const third = await receiveMessage(mail(), deps);
  assert.equal(third.duplicate, true);
  assert.deepEqual(third.uploads, []);
});

await ta("mail from someone who is not a carrier is filed as ignored and never read", async () => {
  const { db, deps, extractCalls, notices } = world();
  const r = await receiveMessage(mail({ from: "promo@randomstore.com", message_id: "gm-spam" }), deps);
  assert.equal(r.ignored, true);
  assert.deepEqual(r.uploads, []);
  assert.equal(db.carrier_messages.find((x) => x.id === r.id).status, "ignored");
  assert.equal(extractCalls.length, 0);
  assert.equal(notices.length, 0);
});

await ta("an ACCEPT reply accepts the dispatch without reading anything", async () => {
  const { db, deps, extractCalls } = world();
  const r = await receiveMessage(mail({ message_id: "gm-acc", text: "ACCEPT 👍\n\n> Hi Carrier Bravo team", attachments: [] }), deps);
  assert.equal(r.status, "applied");
  assert.equal(r.accepted, true);
  const d = db.carrier_dispatches.find((x) => x.id === 57);
  assert.equal(d.status, "accepted");
  assert.equal(d.accepted_at, NOW.toISOString());
  assert.equal(extractCalls.length, 0);
});

await ta("attachments: unsupported types and oversize files are kept out; HEIC is stored but not read", async () => {
  const { db, deps } = world();
  const r = await receiveMessage(mail({ message_id: "gm-mix", attachments: [
    { name: "a.exe", mime: "application/x-msdownload", size: 10 },
    { name: "huge.pdf", mime: "application/pdf", size: 40 * 1024 * 1024 },
    { name: "IMG_1.HEIC", mime: "image/heic", size: 2000 },
  ] }), deps);
  const a = db.carrier_messages.find((x) => x.id === r.id).attachments;
  assert.deepEqual(a.map((x) => x.skipped || (x.readable ? "read" : "kept")), ["type", "size", "kept"]);
  assert.equal(r.uploads.length, 1);
});

await ta("unmatched mail goes to the review queue as unmatched; a failed AI read still lands for a person", async () => {
  const { db, deps } = world();
  deps.extract = async () => { throw new Error("model down"); };
  const r = await receiveMessage(mail({ message_id: "gm-x", to: "dispatch@nobordersmoving.com", subject: "paperwork", text: "see attached", attachments: [{ name: "x.pdf", mime: "application/pdf", size: 10 }] }), deps);
  deps.storage.store[db.carrier_messages.find((x) => x.id === r.id).attachments[0].path] = "pdf";
  const f = await finalizeMessage({ id: r.id }, deps);
  assert.equal(f.status, "unmatched");
  const row = db.carrier_messages.find((x) => x.id === r.id);
  assert.match(row.error, /model down/);
  assert.equal(row.extraction, null);
});

await ta("router: unknown step and method", async () => {
  const { deps } = world();
  assert.equal((await carrierMail({ method: "POST", body: { step: "nope" } }, deps)).status, 400);
  assert.equal((await carrierMail({ method: "PUT", body: {} }, deps)).status, 405);
  assert.equal((await receiveMessage({ from: "" }, deps)).status, 400);
});

// ── The door ──
const fakeRes = () => ({ statusCode: 0, body: null, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; } });
const hit = async (req, deps) => { const res = fakeRes(); await carrierMailDoor({ headers: {}, query: {}, body: {}, method: "GET", ...req }, res, deps); return res; };

await ta("door: no secret configured → 503; wrong or missing secret → 401; right secret → 200", async () => {
  const { deps } = world();
  delete process.env.CARRIER_MAIL_SECRET;
  assert.equal((await hit({ headers: { "x-carrier-secret": "x" } }, deps)).statusCode, 503);
  process.env.CARRIER_MAIL_SECRET = "s3cret-value";
  assert.equal((await hit({}, deps)).statusCode, 401);
  assert.equal((await hit({ headers: { "x-carrier-secret": "s3cret" } }, deps)).statusCode, 401);
  const ok = await hit({ headers: { "x-carrier-secret": "s3cret-value" } }, deps);
  assert.equal(ok.statusCode, 200);
  assert.equal(ok.body.messages.length, 1);
  const bad = await hit({ method: "POST", headers: { "x-carrier-secret": "s3cret-value" }, body: { step: "ack" } }, deps);
  assert.equal(bad.statusCode, 400);
});

if (!process.exitCode) console.log("\nAll carrier mail tests passed.");
