// Gmail read-only helper (OAuth2 refresh-token flow). No SDK — just fetch,
// same approach as lib/docusign.mjs. The refresh token is minted once by hand
// (see docs/gmail-sync.md) and exchanged here for short-lived access tokens.
//
// Required env (Vercel):
//   GMAIL_CLIENT_ID      OAuth client id (Google Cloud Console)
//   GMAIL_CLIENT_SECRET  OAuth client secret
//   GMAIL_REFRESH_TOKEN  refresh token with scope gmail.readonly

// Env values pasted into Vercel often carry stray whitespace or wrapping quotes.
const cleanEnv = (v) => (v || "").trim().replace(/^["']+|["']+$/g, "");

const API = "https://gmail.googleapis.com/gmail/v1/users/me";

// Sender domain → normalized brand, as stored in storages.brand. Also drives
// the Gmail search query so unrelated mail in the inbox is never fetched.
export const BRAND_SENDERS = {
  "publicstorage.com": "Public Storage",
  "extraspace.com": "Extra Space Storage",
  "cubesmart.com": "CubeSmart",
  "lifestorage.com": "Life Storage",
  "uhaul.com": "U-Haul",
  "sroa.com": "Storage Rentals of America",
  "simplyss.com": "Simply Self Storage",
};

export function brandFromAddress(fromAddress) {
  const domain = String(fromAddress || "").toLowerCase().match(/@([a-z0-9.-]+)/)?.[1] || "";
  for (const [d, brand] of Object.entries(BRAND_SENDERS)) {
    if (domain === d || domain.endsWith("." + d)) return brand;
  }
  return "";
}

export function gmailConfigured() {
  return Boolean(cleanEnv(process.env.GMAIL_CLIENT_ID) && cleanEnv(process.env.GMAIL_CLIENT_SECRET) && cleanEnv(process.env.GMAIL_REFRESH_TOKEN));
}

// Exchange the long-lived refresh token for a ~1h access token.
export async function gmailAccessToken() {
  const r = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: cleanEnv(process.env.GMAIL_CLIENT_ID),
      client_secret: cleanEnv(process.env.GMAIL_CLIENT_SECRET),
      refresh_token: cleanEnv(process.env.GMAIL_REFRESH_TOKEN),
      grant_type: "refresh_token",
    }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok || !tok.access_token) {
    const hint = tok.error === "invalid_grant" ? " — el refresh token expiró o fue revocado; regenerarlo (docs/gmail-sync.md)." : "";
    throw new Error("Gmail auth: " + (tok.error_description || tok.error || r.status) + hint);
  }
  return tok.access_token;
}

export async function gmailList(token, { q, maxResults = 25, pageToken } = {}) {
  const params = new URLSearchParams({ maxResults: String(maxResults) });
  if (q) params.set("q", q);
  if (pageToken) params.set("pageToken", pageToken);
  const r = await fetch(`${API}/messages?${params}`, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail list: " + (j.error?.message || r.status));
  return j; // { messages: [{id, threadId}], nextPageToken, resultSizeEstimate }
}

export async function gmailGet(token, id) {
  const r = await fetch(`${API}/messages/${id}?format=full`, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail get: " + (j.error?.message || r.status));
  return j;
}

export function headerValue(message, name) {
  const h = (message?.payload?.headers || []).find((x) => x.name?.toLowerCase() === name.toLowerCase());
  return h?.value || "";
}

const decodeB64Url = (data) => Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

const stripHtml = (html) =>
  html
    .replace(/<(style|script|head)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&").replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&#39;|&apos;/gi, "'").replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();

// Walk the MIME tree and return the best plain-text body (text/plain preferred,
// text/html stripped as fallback).
export function extractBodyText(payload) {
  let plain = "", html = "";
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || "";
    if (part.body?.data) {
      if (mime === "text/plain" && !plain) plain = decodeB64Url(part.body.data);
      else if (mime === "text/html" && !html) html = decodeB64Url(part.body.data);
    }
    (part.parts || []).forEach(walk);
  };
  walk(payload);
  return (plain || stripHtml(html)).trim();
}
