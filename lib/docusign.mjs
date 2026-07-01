// DocuSign eSignature helper (JWT Grant, server-to-server). No SDK — just fetch
// + Node crypto to sign the RS256 assertion, so there are no extra deps.
//
// Required env (Vercel):
//   DOCUSIGN_INTEGRATION_KEY  integration key (client id) of the DocuSign app
//   DOCUSIGN_USER_ID          API username (the user being impersonated)
//   DOCUSIGN_ACCOUNT_ID       target account id
//   DOCUSIGN_PRIVATE_KEY      RSA private key (PEM; \n or real newlines)
//   DOCUSIGN_OAUTH_HOST       account-d.docusign.com (demo) | account.docusign.com (prod)
import crypto from "crypto";

const b64url = (buf) => Buffer.from(buf).toString("base64url");
function privateKey() {
  return (process.env.DOCUSIGN_PRIVATE_KEY || "").replace(/\\n/g, "\n");
}
function signJwt(payload) {
  const header = { alg: "RS256", typ: "JWT" };
  const enc = b64url(JSON.stringify(header)) + "." + b64url(JSON.stringify(payload));
  const sig = crypto.createSign("RSA-SHA256").update(enc).sign(privateKey());
  return enc + "." + b64url(sig);
}

// Authenticate via JWT Grant and resolve the account's API base path.
export async function dsAuth() {
  const host = process.env.DOCUSIGN_OAUTH_HOST || "account-d.docusign.com";
  const iat = Math.floor(Date.now() / 1000);
  const assertion = signJwt({
    iss: process.env.DOCUSIGN_INTEGRATION_KEY,
    sub: process.env.DOCUSIGN_USER_ID,
    aud: host,
    iat, exp: iat + 3300,
    scope: "signature impersonation",
  });
  const r = await fetch(`https://${host}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }),
  });
  const tok = await r.json().catch(() => ({}));
  if (!r.ok) {
    const hint = tok.error === "consent_required" ? " — falta el consentimiento JWT (una vez)." : "";
    throw new Error("DocuSign auth: " + (tok.error_description || tok.error || r.status) + hint);
  }
  const token = tok.access_token;
  const ui = await (await fetch(`https://${host}/oauth/userinfo`, { headers: { Authorization: "Bearer " + token } })).json();
  const wanted = process.env.DOCUSIGN_ACCOUNT_ID;
  const acct = (ui.accounts || []).find(a => a.account_id === wanted) || (ui.accounts || []).find(a => a.is_default) || (ui.accounts || [])[0];
  if (!acct) throw new Error("DocuSign: el usuario no tiene cuentas.");
  return { token, base: `${acct.base_uri}/restapi/v2.1/accounts/${acct.account_id}` };
}

// Create + send an envelope with one embedded signer and absolute-positioned tabs.
export async function dsCreateEnvelope(auth, { pdfBase64, docName, emailSubject, signer, tabs }) {
  const body = {
    emailSubject: emailSubject || "Bill of Lading — signature required",
    documents: [{ documentBase64: pdfBase64, name: docName || "BOL.pdf", fileExtension: "pdf", documentId: "1" }],
    recipients: { signers: [{
      email: signer.email, name: signer.name, recipientId: "1", routingOrder: "1",
      ...(signer.clientUserId ? { clientUserId: signer.clientUserId } : {}),
      tabs,
    }] },
    status: "sent",
  };
  const r = await fetch(`${auth.base}/envelopes`, {
    method: "POST",
    headers: { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("DocuSign envelope: " + (j.message || r.status));
  return j.envelopeId;
}

// Recipient (embedded) signing URL — open it on the tablet for in-person signing.
export async function dsRecipientView(auth, envelopeId, { email, name, clientUserId, returnUrl }) {
  const r = await fetch(`${auth.base}/envelopes/${envelopeId}/views/recipient`, {
    method: "POST",
    headers: { Authorization: "Bearer " + auth.token, "Content-Type": "application/json" },
    body: JSON.stringify({ returnUrl, authenticationMethod: "none", email, userName: name, clientUserId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error("DocuSign view: " + (j.message || r.status));
  return j.url;
}

// Download the completed (signed) PDF, all pages combined.
export async function dsCombinedPdf(auth, envelopeId) {
  const r = await fetch(`${auth.base}/envelopes/${envelopeId}/documents/combined`, {
    headers: { Authorization: "Bearer " + auth.token, Accept: "application/pdf" },
  });
  if (!r.ok) throw new Error("DocuSign download: " + r.status);
  return new Uint8Array(await r.arrayBuffer());
}

// Turn our template field_map signature boxes (for a stage) into DocuSign tabs.
// Field coords are PDF points, top-left origin — same as DocuSign's tab coords.
export function tabsFromFields(fields, stage) {
  const signHereTabs = [], dateSignedTabs = [], initialHereTabs = [];
  for (const f of fields || []) {
    const k = f.kind;
    if (!["signature", "initial", "sign_date"].includes(k)) continue;
    if ((f.stage || "pickup") !== stage) continue;
    const tab = { documentId: "1", recipientId: "1", pageNumber: String((f.page || 0) + 1), xPosition: String(Math.round(f.x)), yPosition: String(Math.round(f.y)) };
    if (k === "signature") signHereTabs.push(tab);
    else if (k === "initial") initialHereTabs.push(tab);
    else dateSignedTabs.push(tab);
  }
  return { signHereTabs, dateSignedTabs, initialHereTabs };
}
