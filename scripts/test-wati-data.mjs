#!/usr/bin/env node
// Tests for src/watiData.js — WATI webhook parsing and phone matching.
// No network, no database: picked up automatically by `npm test`.
import assert from "node:assert/strict";
import { toE164, phoneKey, toISO, directionOf, parseWatiEvent, pickMatches, MAX_BODY } from "../src/watiData.js";

const t = (name, fn) => {
  try { fn(); console.log("PASS  " + name); }
  catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; }
};

// ── Phones ───────────────────────────────────────────────────────────────────
t("toE164 adds the + and rejects junk", () => {
  assert.equal(toE164("13055551234"), "+13055551234");
  assert.equal(toE164("+1 (305) 555-1234"), "+13055551234");
  assert.equal(toE164("123"), null);
  assert.equal(toE164(null), null);
  assert.equal(toE164("1234567890123456"), null);
});

t("phoneKey makes differently written US numbers meet", () => {
  const k = phoneKey("13055551234");
  assert.equal(k, "3055551234");
  assert.equal(phoneKey("(305) 555-1234"), k);
  assert.equal(phoneKey("+1 305 555 1234"), k);
  assert.equal(phoneKey("305.555.1234"), k);
});

t("phoneKey absorbs WhatsApp's extra 9 on Argentine mobiles", () => {
  assert.equal(phoneKey("5491122334455"), phoneKey("+54 11 2233-4455"));
});

t("phoneKey keeps short numbers whole and drops too-short ones", () => {
  assert.equal(phoneKey("5551234"), "5551234");
  assert.equal(phoneKey("12345"), null);
  assert.equal(phoneKey(""), null);
});

// ── Timestamps ───────────────────────────────────────────────────────────────
t("toISO reads unix seconds, ms and ISO fallbacks", () => {
  assert.equal(toISO("1700000000"), "2023-11-14T22:13:20.000Z");
  assert.equal(toISO(1700000000000), "2023-11-14T22:13:20.000Z");
  assert.equal(toISO(null, "2026-09-22T10:00:00Z"), "2026-09-22T10:00:00.000Z");
  assert.equal(toISO("", "not a date"), null);
});

// ── Direction ────────────────────────────────────────────────────────────────
t("directionOf: customer, WATI/API send, and Coexistence phone echo", () => {
  assert.equal(directionOf({ eventType: "message", owner: false }), "inbound");
  assert.equal(directionOf({ eventType: "sessionMessageSent", owner: true }), "outbound_api");
  assert.equal(directionOf({ eventType: "templateMessageSent" }), "outbound_api");
  assert.equal(directionOf({ eventType: "message", owner: true }), "outbound_app");
});

// ── Parsing ──────────────────────────────────────────────────────────────────
const INBOUND = {
  id: "650a1b2c", whatsappMessageId: "wamid.HBgL123", eventType: "message",
  created: "2026-09-22T14:00:00Z", timestamp: "1790000000",
  text: "Job for you: 800 cf NY 10001 to Miami 33101, $4,200, FADD 10/5",
  type: "text", owner: false, waId: "13055551234", senderName: "Shawn (Allied)",
};

t("parses an inbound text message into a row", () => {
  const ev = parseWatiEvent(INBOUND);
  assert.equal(ev.kind, "message");
  assert.equal(ev.row.provider_message_id, "wamid.HBgL123");
  assert.equal(ev.row.direction, "inbound");
  assert.equal(ev.row.phone, "+13055551234");
  assert.equal(ev.row.phone_key, "3055551234");
  assert.equal(ev.row.contact_name, "Shawn (Allied)");
  assert.equal(ev.row.body, INBOUND.text);
  assert.equal(ev.row.media_url, null);
  assert.equal(ev.row.sent_at, new Date(1790000000 * 1000).toISOString());
});

t("media keeps its URL and caption; a non-URL data field is ignored", () => {
  const img = parseWatiEvent({ ...INBOUND, type: "image", text: null, caption: "job sheet", data: "https://live.wati.io/media/abc.jpg" });
  assert.equal(img.row.msg_type, "image");
  assert.equal(img.row.body, "job sheet");
  assert.equal(img.row.media_url, "https://live.wati.io/media/abc.jpg");
  const odd = parseWatiEvent({ ...INBOUND, type: "document", data: "javascript:alert(1)" });
  assert.equal(odd.row.media_url, null);
});

t("a text message never takes a media URL", () => {
  assert.equal(parseWatiEvent({ ...INBOUND, data: "https://x.test/a.jpg" }).row.media_url, null);
});

t("body is clamped", () => {
  const ev = parseWatiEvent({ ...INBOUND, text: "x".repeat(MAX_BODY + 50) });
  assert.equal(ev.row.body.length, MAX_BODY);
});

t("falls back to the WATI id when there is no whatsappMessageId", () => {
  const ev = parseWatiEvent({ ...INBOUND, whatsappMessageId: null });
  assert.equal(ev.row.provider_message_id, "650a1b2c");
});

t("status events become status updates", () => {
  const ev = parseWatiEvent({ eventType: "sentMessageREAD", id: "650a1b2c", whatsappMessageId: "wamid.X" });
  assert.deepEqual(ev, { kind: "status", ids: ["wamid.X", "650a1b2c"], status: "read" });
  assert.equal(parseWatiEvent({ eventType: "sentMessageDELIVERED_v2", id: "a" }).status, "delivered");
});

t("unusable payloads are ignored with a reason", () => {
  assert.equal(parseWatiEvent(null).reason, "not_an_object");
  assert.equal(parseWatiEvent([]).reason, "not_an_object");
  assert.equal(parseWatiEvent({ ...INBOUND, waId: "" }).reason, "no_phone");
  assert.equal(parseWatiEvent({ ...INBOUND, id: null, whatsappMessageId: null }).reason, "no_message_id");
  assert.equal(parseWatiEvent({ eventType: "sentMessageREAD" }).reason, "status_without_id");
});

// ── Matching ─────────────────────────────────────────────────────────────────
t("pickMatches: open job beats delivered, newer beats older", () => {
  const m = pickMatches([
    { kind: "job", id: 50, done: true },
    { kind: "job", id: 12, done: false },
    { kind: "job", id: 30, done: false },
    { kind: "broker", id: 7, done: false },
    { kind: "broker", id: 3, done: false },
  ]);
  assert.deepEqual(m, { broker_id: 3, driver_id: null, job_id: 30 });
});

t("pickMatches with nothing links nothing", () => {
  assert.deepEqual(pickMatches(null), { broker_id: null, driver_id: null, job_id: null });
});
