// Webhook auth must fail CLOSED: a missing secret refuses every request instead
// of skipping verification. Run: node scripts/test-webhook-auth.mjs
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { verifyTwilioSignature } from "../lib/twilio.mjs";

const t = (name, fn) => { try { fn(); console.log("PASS  " + name); } catch (e) { console.log("FAIL  " + name + " — " + e.message); process.exitCode = 1; } };

const url = "https://crm.example.com/api/whatsapp-webhook";
const params = new URLSearchParams({ From: "whatsapp:+5491100000000", Body: "hola" });
const sign = (token) => {
  let data = url; for (const k of [...params.keys()].sort()) data += k + params.get(k);
  return crypto.createHmac("sha1", token).update(Buffer.from(data, "utf8")).digest("base64");
};

t("twilio: no auth token configured → refused, even with a signature header", () => {
  assert.equal(verifyTwilioSignature("", sign("whatever"), url, params), false);
  assert.equal(verifyTwilioSignature(undefined, "abc", url, params), false);
});
t("twilio: token configured, no signature header → refused", () => {
  assert.equal(verifyTwilioSignature("tok", undefined, url, params), false);
});
t("twilio: token configured, wrong signature → refused", () => {
  assert.equal(verifyTwilioSignature("tok", sign("other"), url, params), false);
});
t("twilio: token configured, matching signature → accepted", () => {
  assert.equal(verifyTwilioSignature("tok", sign("tok"), url, params), true);
});

// ── ELD GPS webhooks ─────────────────────────────────────────────────────────
// Neither provider signs its deliveries, so both authenticate with a credential
// we gave them at registration. The point of these tests is the fail-closed
// half: with no secret configured the endpoint must refuse everything rather
// than accept anonymous truck positions.
process.env.ANTHROPIC_API_KEY ||= "test-key";
const { verizonWebhookAuthOk, motiveWebhookAuthOk } = await import("../api/geocode.mjs");

const req = (headers = {}, query = {}) => ({ headers, query });
const basic = (u, p) => "Basic " + Buffer.from(`${u}:${p}`).toString("base64");

delete process.env.VERIZON_WEBHOOK_USER;
delete process.env.VERIZON_WEBHOOK_PASSWORD;
t("verizon gps: no credentials configured → refused, even with a Basic header", () => {
  assert.equal(verizonWebhookAuthOk(req({ authorization: basic("a", "b") })), false);
});
process.env.VERIZON_WEBHOOK_USER = "hook";
process.env.VERIZON_WEBHOOK_PASSWORD = "s3cret";
t("verizon gps: no header → refused", () => {
  assert.equal(verizonWebhookAuthOk(req()), false);
});
t("verizon gps: wrong password → refused", () => {
  assert.equal(verizonWebhookAuthOk(req({ authorization: basic("hook", "nope") })), false);
});
t("verizon gps: matching credentials → accepted", () => {
  assert.equal(verizonWebhookAuthOk(req({ authorization: basic("hook", "s3cret") })), true);
});

delete process.env.MOTIVE_WEBHOOK_SECRET;
t("motive gps: no secret configured → refused, however the request is dressed", () => {
  assert.equal(motiveWebhookAuthOk(req({ authorization: "Bearer anything" })), false);
  assert.equal(motiveWebhookAuthOk(req({ "x-webhook-secret": "anything" })), false);
  assert.equal(motiveWebhookAuthOk(req({}, { token: "anything" })), false);
});
process.env.MOTIVE_WEBHOOK_SECRET = "mo7ive-s3cret";
t("motive gps: nothing presented → refused", () => {
  assert.equal(motiveWebhookAuthOk(req()), false);
});
t("motive gps: wrong secret → refused, in every form it is accepted in", () => {
  assert.equal(motiveWebhookAuthOk(req({ authorization: "Bearer nope" })), false);
  assert.equal(motiveWebhookAuthOk(req({ "x-webhook-secret": "nope" })), false);
  assert.equal(motiveWebhookAuthOk(req({}, { token: "nope" })), false);
});
t("motive gps: the secret is accepted as a bearer, a header or a query token", () => {
  assert.equal(motiveWebhookAuthOk(req({ authorization: "Bearer mo7ive-s3cret" })), true);
  assert.equal(motiveWebhookAuthOk(req({ "x-webhook-secret": "mo7ive-s3cret" })), true);
  assert.equal(motiveWebhookAuthOk(req({}, { token: "mo7ive-s3cret" })), true);
});
t("motive gps: a secret that is only a prefix of the real one → refused", () => {
  assert.equal(motiveWebhookAuthOk(req({ "x-webhook-secret": "mo7ive" })), false);
});

if (process.exitCode) console.log("\nSome webhook-auth tests failed."); else console.log("\nAll webhook-auth tests passed.");
