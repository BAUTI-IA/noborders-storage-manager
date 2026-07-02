// Vercel serverless: send a saved BOL to DocuSign for signature (pickup or
// delivery). Authenticates the caller from their JWT and authorizes against
// profiles (needs BOL create/edit). Returns an embedded signing URL to open on
// the tablet for in-person signing.
//
// Required env: SUPABASE_SERVICE_ROLE_KEY, SUPABASE_URL (or VITE_SUPABASE_URL),
//   APP_URL, and the DOCUSIGN_* vars (see lib/docusign.mjs).
import { createClient } from "@supabase/supabase-js";
import { dsAuth, dsCreateEnvelope, dsRecipientView, tabsFromFields } from "../lib/docusign.mjs";

const SUPABASE_URL = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const APP_URL = process.env.APP_URL || "";
const admin = SERVICE_KEY ? createClient(SUPABASE_URL, SERVICE_KEY, { auth: { autoRefreshToken: false, persistSession: false } }) : null;

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!admin) { res.status(500).json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." }); return; }
  if (!process.env.DOCUSIGN_INTEGRATION_KEY) { res.status(500).json({ error: "Falta configurar DocuSign (env DOCUSIGN_*) en Vercel." }); return; }

  // 1) AuthN — verify the caller's token.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "No autorizado." }); return; }
  const { data: { user }, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) { res.status(401).json({ error: "No autorizado." }); return; }

  // 2) AuthZ — BOL create or edit (admins always pass).
  const { data: prof } = await admin.from("profiles").select("role, active, permissions").eq("id", user.id).single();
  const perms = prof?.permissions?.bol || {};
  const allowed = prof?.active && (prof.role === "admin" || perms.create || perms.edit);
  if (!allowed) { res.status(403).json({ error: "Sin permiso para firmar BOL." }); return; }

  const { document_id, stage, signer_email, signer_name, mode } = req.body || {};
  if (!document_id || !["pickup", "delivery"].includes(stage)) { res.status(400).json({ error: "document_id y stage (pickup|delivery) requeridos." }); return; }
  // "email" (default): DocuSign emails the signing link to the client (remote
  // back office flow). "embedded": in-person signing on the employee's device.
  const sendMode = mode === "embedded" ? "embedded" : "email";

  try {
    // Load the BOL record + its template field map + the generated PDF.
    const { data: doc, error: dErr } = await admin.from("bol_documents").select("*").eq("id", document_id).single();
    if (dErr || !doc) throw new Error("BOL no encontrado.");
    if (!doc.pdf_path) throw new Error("El BOL no tiene PDF generado. Guardalo primero.");

    let fields = [];
    if (doc.template_id) {
      const { data: tpl } = await admin.from("bol_templates").select("field_map").eq("id", doc.template_id).single();
      fields = tpl?.field_map || [];
    }
    const tabs = tabsFromFields(fields, stage);
    if (!tabs.signHereTabs.length && !tabs.initialHereTabs.length && !tabs.dateSignedTabs.length) {
      throw new Error(`El template no tiene campos de firma para "${stage}". Agregalos en el editor (kind: signature/date, stage: ${stage}).`);
    }

    const { data: file, error: fErr } = await admin.storage.from("bol-generated").download(doc.pdf_path);
    if (fErr || !file) throw new Error("No se pudo leer el PDF generado.");
    const pdfBase64 = Buffer.from(await file.arrayBuffer()).toString("base64");

    const email = signer_email || doc.values?.client_email || doc.values?.customer_email || "";
    const name = signer_name || doc.customer || doc.values?.customer || "Customer";
    if (!email) throw new Error("Falta el email del firmante (signer_email).");

    const auth = await dsAuth();
    const signer = { email, name };
    if (sendMode === "embedded") signer.clientUserId = "1"; // embedded → no email is sent
    const envelopeId = await dsCreateEnvelope(auth, {
      pdfBase64, docName: `${doc.job_number || "BOL"} - ${name}.pdf`,
      emailSubject: `Bill of Lading ${doc.job_number || ""} — ${stage === "pickup" ? "pickup" : "delivery"} signature`.trim(),
      signer, tabs,
    });

    // Record the envelope + advance status.
    await admin.from("bol_documents").update({
      [`${stage}_envelope_id`]: envelopeId,
      sign_status: `${stage}_sent`,
    }).eq("id", document_id);

    if (sendMode === "embedded") {
      const url = await dsRecipientView(auth, envelopeId, {
        email, name, clientUserId: "1",
        returnUrl: `${APP_URL}/?signed=${stage}`,
      });
      res.status(200).json({ ok: true, envelopeId, url });
      return;
    }
    // Email mode: DocuSign already sent the signing email to the client.
    res.status(200).json({ ok: true, envelopeId, emailed: true, email });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error enviando a DocuSign." });
  }
}
