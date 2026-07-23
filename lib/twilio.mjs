// Twilio helpers for the WhatsApp webhook: request signature validation and
// TwiML replies. No `twilio` npm dependency — the signature algorithm is just
// HMAC-SHA1 over the URL + sorted POST params.
// https://www.twilio.com/docs/usage/security#validating-requests
import crypto from "crypto";

// X-Twilio-Signature = base64(HMAC-SHA1(authToken, url + concat(sortedKey + value)))
export function verifyTwilioSignature(authToken, signatureHeader, url, params) {
  if (!authToken) return true; // not configured → skip (dev only)
  if (!signatureHeader) return false;
  let data = url;
  for (const key of [...params.keys()].sort()) data += key + params.get(key);
  const expected = crypto.createHmac("sha1", authToken).update(Buffer.from(data, "utf8")).digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signatureHeader)); } catch { return false; }
}

const escapeXml = (s) => String(s)
  .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
  .replace(/"/g, "&quot;").replace(/'/g, "&apos;");

// TwiML response: Twilio sends `text` back to the sender as a WhatsApp message.
// With no text (silent ignore) it returns an empty <Response/>.
export function twimlReply(text) {
  return text
    ? `<?xml version="1.0" encoding="UTF-8"?><Response><Message>${escapeXml(text)}</Message></Response>`
    : `<?xml version="1.0" encoding="UTF-8"?><Response/>`;
}

// Twilio WhatsApp numbers arrive as "whatsapp:+549112233..." → "+549112233..."
export const normalizePhone = (from) => String(from || "").replace(/^whatsapp:/i, "").trim();
