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

if (process.exitCode) console.log("\nSome webhook-auth tests failed."); else console.log("\nAll webhook-auth tests passed.");
