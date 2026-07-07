// Vercel serverless: DocuSign Connect webhook. Fires when an envelope completes.
// Verifies the Connect HMAC, downloads the signed PDF, stores it in the private
// bol-signed bucket and advances the BOL's sign_status. Called by DocuSign (no
// user auth) — trust comes from the HMAC signature.
//
// Configure DocuSign Connect → URL https://APP_URL/api/docusign-webhook, JSON
// format, "Include HMAC" with secret = DOCUSIGN_CONNECT_HMAC.
import crypto from "crypto";
import { createClient } from "@supabase/supabase-js";
import { dsAuth, dsCombinedPdf } from "../lib/docusign.mjs";

export const config = { api: { bodyParser: false } };

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

function readRaw(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", c => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}
function hmacOk(raw, header) {
  const key = process.env.DOCUSIGN_CONNECT_HMAC;
  if (!key) return false; // FAIL CLOSED: without the shared secret, no payload is trusted
  if (!header) return false;
  const expected = crypto.createHmac("sha256", key).update(raw).digest("base64");
  try { return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(header)); } catch { return false; }
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!admin) { res.status(500).json({ error: "server not configured" }); return; }
  if (!process.env.DOCUSIGN_CONNECT_HMAC) {
    // Refuse to process unauthenticated webhooks: configure "Include HMAC" in
    // DocuSign Connect and set DOCUSIGN_CONNECT_HMAC in Vercel.
    res.status(500).json({ error: "webhook HMAC not configured" });
    return;
  }

  const raw = await readRaw(req);
  if (!hmacOk(raw, req.headers["x-docusign-signature-1"])) { res.status(401).json({ error: "bad signature" }); return; }

  let payload;
  try { payload = JSON.parse(raw.toString("utf8")); } catch { res.status(400).json({ error: "bad json" }); return; }

  // Connect JSON: { event, data: { envelopeId, envelopeSummary?: { status } } }
  const envelopeId = payload?.data?.envelopeId || payload?.envelopeId;
  const status = (payload?.event || payload?.data?.envelopeSummary?.status || "").toLowerCase();
  if (!envelopeId) { res.status(200).json({ ok: true, note: "no envelopeId" }); return; }
  if (status && !status.includes("complet")) { res.status(200).json({ ok: true, note: "ignored " + status }); return; }

  try {
    // Which BOL + stage does this envelope belong to?
    let stage = "pickup";
    let { data: doc } = await admin.from("bol_documents").select("id, job_number, customer, sign_status").eq("pickup_envelope_id", envelopeId).maybeSingle();
    if (!doc) {
      ({ data: doc } = await admin.from("bol_documents").select("id, job_number, customer, sign_status").eq("delivery_envelope_id", envelopeId).maybeSingle());
      stage = "delivery";
    }
    if (!doc) { res.status(200).json({ ok: true, note: "envelope not tracked" }); return; }

    const auth = await dsAuth();
    const pdf = await dsCombinedPdf(auth, envelopeId);
    const path = `signed-${stage}-${envelopeId}.pdf`;
    const { error: upErr } = await admin.storage.from("bol-signed").upload(path, pdf, { contentType: "application/pdf", upsert: true });
    if (upErr) throw upErr;

    const nextStatus = stage === "delivery" ? "completed" : "pickup_signed";
    await admin.from("bol_documents").update({
      [`${stage}_signed_path`]: path,
      [`${stage}_signed_at`]: new Date().toISOString(),
      sign_status: nextStatus,
    }).eq("id", doc.id);

    res.status(200).json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e?.message || "webhook error" });
  }
}
