// Google API helper (service account + domain-wide delegation, server-to-server).
// No googleapis SDK — just fetch + Node crypto to sign the RS256 assertion, the
// same shape as lib/docusign.mjs, so there are no extra deps.
//
// Domain-wide delegation means the service account impersonates a real Workspace
// mailbox, so there is no OAuth redirect and no refresh token to store anywhere.
//
// Required env (Vercel):
//   GOOGLE_SA_CLIENT_EMAIL    service account email (…@….iam.gserviceaccount.com)
//   GOOGLE_SA_PRIVATE_KEY     its RSA private key (PEM; \n or real newlines)
//   GOOGLE_IMPERSONATE_USER   the mailbox to read, e.g. ops@nobordersmoving.com
//
// One-time setup outside this repo: create the service account, enable the Gmail
// API, then in the Workspace admin console authorize its client id for the
// scopes below (Security → API controls → Domain-wide delegation). Without that
// last step the token exchange fails with "unauthorized_client".

import crypto from "crypto";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const GMAIL = "https://gmail.googleapis.com/gmail/v1/users/me";

export const SCOPE_GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
const privateKey = () => (process.env.GOOGLE_SA_PRIVATE_KEY || "").replace(/\\n/g, "\n");

// True only when every piece needed to authenticate is present. Callers use this
// to fail closed with a "not configured" 503 instead of throwing a stack trace.
export function googleConfigured() {
  return !!(process.env.GOOGLE_SA_CLIENT_EMAIL && process.env.GOOGLE_SA_PRIVATE_KEY && process.env.GOOGLE_IMPERSONATE_USER);
}

function signJwt(payload) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const sig = crypto.createSign("RSA-SHA256").update(enc).sign(privateKey());
  return enc + "." + b64url(sig);
}

// Tokens last an hour; a warm lambda handling a whole sync would otherwise
// re-authenticate per request. Cached per scope, with a minute of headroom.
const tokenCache = new Map();

export async function googleAuth(scope = SCOPE_GMAIL_READONLY) {
  if (!googleConfigured()) throw new Error("Google is not configured on the server.");

  const cached = tokenCache.get(scope);
  const now = Math.floor(Date.now() / 1000);
  if (cached && cached.exp > now + 60) return cached.token;

  const assertion = signJwt({
    iss: process.env.GOOGLE_SA_CLIENT_EMAIL,
    sub: process.env.GOOGLE_IMPERSONATE_USER, // the mailbox being impersonated
    scope,
    aud: TOKEN_URL,
    iat: now,
    exp: now + 3600,
  });

  const r = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok) {
    // The two failures worth naming, because both are configuration, not code.
    const hint =
      tok.error === "unauthorized_client"
        ? " — the service account's client id is not authorized for this scope in the Workspace admin console (domain-wide delegation)."
        : tok.error === "invalid_grant"
          ? " — GOOGLE_IMPERSONATE_USER is not a mailbox this service account may impersonate (or the server clock is skewed)."
          : "";
    throw new Error("Google auth: " + (tok.error_description || tok.error || r.status) + hint);
  }
  tokenCache.set(scope, { token: tok.access_token, exp: now + Number(tok.expires_in || 3600) });
  return tok.access_token;
}

async function gapi(token, url) {
  const r = await fetch(url, { headers: { Authorization: "Bearer " + token } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("Gmail API " + r.status + ": " + (j.error?.message || "request failed"));
  return j;
}

// Message ids matching a Gmail search query, newest first. Paginates up to
// `max` so a first run over a busy label cannot spin forever.
export async function gmailList(query, { max = 50 } = {}) {
  const token = await googleAuth();
  const out = [];
  let pageToken = null;
  do {
    const qs = new URLSearchParams({ q: query, maxResults: String(Math.min(100, max - out.length)) });
    if (pageToken) qs.set("pageToken", pageToken);
    const j = await gapi(token, `${GMAIL}/messages?${qs}`);
    for (const m of j.messages || []) out.push({ id: m.id, threadId: m.threadId });
    pageToken = j.nextPageToken || null;
  } while (pageToken && out.length < max);
  return out.slice(0, max);
}

const decodeB64 = (data) => Buffer.from(String(data || "").replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");

// Last-resort conversion when a mail carries no text/plain part.
function htmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&#39;/g, "'").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

// Walk the MIME tree and return the best plain-text rendering of the body.
// Estimate mails do carry text/plain; the HTML path is the fallback.
export function extractPlainText(payload) {
  let plain = "", html = "";
  const walk = (part) => {
    if (!part) return;
    const mime = part.mimeType || "";
    const data = part.body?.data;
    if (data) {
      if (mime === "text/plain") plain += (plain ? "\n" : "") + decodeB64(data);
      else if (mime === "text/html") html += (html ? "\n" : "") + decodeB64(data);
    }
    for (const p of part.parts || []) walk(p);
  };
  walk(payload);
  return plain.trim() || htmlToText(html);
}

const headerOf = (payload, name) =>
  (payload?.headers || []).find((h) => (h.name || "").toLowerCase() === name.toLowerCase())?.value || null;

// One message, flattened to what the triage pipeline actually consumes.
export async function gmailGet(id) {
  const token = await googleAuth();
  const m = await gapi(token, `${GMAIL}/messages/${encodeURIComponent(id)}?format=full`);
  const p = m.payload || {};
  const dateHeader = headerOf(p, "Date");
  const ts = Number(m.internalDate);
  return {
    id: m.id,
    threadId: m.threadId,
    subject: headerOf(p, "Subject") || "",
    from: headerOf(p, "From") || "",
    to: headerOf(p, "To") || "",
    receivedAt: Number.isFinite(ts) ? new Date(ts).toISOString() : (dateHeader ? new Date(dateHeader).toISOString() : null),
    snippet: m.snippet || "",
    body: extractPlainText(p),
    labelIds: m.labelIds || [],
  };
}
