// Vercel serverless: WhatsApp channel for the CRM agent (Twilio inbound
// webhook). The agent brain lives in lib/agent.mjs (shared with Telegram);
// this file only handles the Twilio transport: signature check, whitelist,
// immediate ACK and async reply.
//
// Configure Twilio → Messaging → WhatsApp → inbound webhook (POST) to
// https://APP_URL/api/whatsapp-webhook. Trust comes from the Twilio signature
// (TWILIO_AUTH_TOKEN) plus the WHATSAPP_ALLOWED_NUMBERS whitelist.
import { waitUntil } from "@vercel/functions";
import { verifyTwilioSignature, twimlReply, normalizePhone, sendWhatsApp } from "../lib/twilio.mjs";
import { admin, handleIncoming, REPLY_MAX } from "../lib/agent.mjs";
import { transcribeAudio } from "../lib/transcribe.mjs";

export const config = { api: { bodyParser: false } }; // raw body: the signature covers the exact form params
export const maxDuration = 300;

// Twilio cuts webhooks off at ~15s and the Claude extraction can exceed that,
// so the handler ACKs immediately with empty TwiML and does the real work in
// the background (waitUntil keeps the function alive after the response); the
// answer is delivered via the Twilio REST API instead of a TwiML reply.
function sendTwiml(res, text) {
  res.setHeader("Content-Type", "text/xml");
  res.status(200).send(twimlReply(text ? String(text).slice(0, REPLY_MAX + 100) : ""));
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!admin || !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "server not configured" }); return; }

  const raw = await new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
  const params = new URLSearchParams(raw.toString("utf8"));

  // Signature over the exact public URL Twilio was configured with (APP_URL,
  // never req.headers — those are attacker-controlled).
  const url = `${(process.env.APP_URL || "").replace(/\/+$/, "")}/api/whatsapp-webhook`;
  if (!verifyTwilioSignature(process.env.TWILIO_AUTH_TOKEN, req.headers["x-twilio-signature"], url, params)) {
    res.status(401).json({ error: "bad signature" }); return;
  }

  const phone = normalizePhone(params.get("From"));
  const text = (params.get("Body") || "").trim();
  // Inbound WhatsApp voice note: Twilio delivers it as media (audio/ogg URL).
  const mediaUrl = Number(params.get("NumMedia") || 0) > 0 && (params.get("MediaContentType0") || "").startsWith("audio/")
    ? params.get("MediaUrl0")
    : null;
  // WHATSAPP_ALLOWED_NUMBERS: comma-separated E.164 whitelist, or "*" to allow
  // any sender (the Twilio signature still gates who can call the webhook).
  const rawAllowed = (process.env.WHATSAPP_ALLOWED_NUMBERS || "").trim();
  const allowed = rawAllowed.split(",").map((s) => s.trim()).filter(Boolean);
  const isAllowed = rawAllowed === "*" || allowed.includes(phone);
  if (!phone || !isAllowed || (!text && !mediaUrl)) { sendTwiml(res, ""); return; } // unknown sender / empty → silent

  waitUntil(processIncoming(phone, text, mediaUrl).catch((e) => console.error("whatsapp-webhook bg:", e)));
  sendTwiml(res, ""); // ACK now; the real answer arrives via the REST API
}

async function processIncoming(phone, text, mediaUrl) {
  if (!text && mediaUrl) {
    try {
      // Twilio media URLs require basic auth with the account credentials.
      const auth = "Basic " + Buffer.from(`${process.env.TWILIO_ACCOUNT_SID}:${process.env.TWILIO_AUTH_TOKEN}`).toString("base64");
      const audio = await fetch(mediaUrl, { headers: { Authorization: auth } });
      if (!audio.ok) throw new Error(`media download ${audio.status}`);
      text = await transcribeAudio(Buffer.from(await audio.arrayBuffer()), "audio.ogg");
      if (!text) { await sendWhatsApp(phone, "🎤 No se escucha nada en el audio. ¿Probás de nuevo?"); return; }
      await sendWhatsApp(phone, `🎤 Escuché: «${text}»`);
    } catch (e) {
      console.error("whatsapp voice:", e);
      await sendWhatsApp(phone, "⚠️ No pude procesar el audio. Probá de nuevo o mandalo por texto.");
      return;
    }
  }
  const reply = await handleIncoming(phone, text);
  await sendWhatsApp(phone, reply);
}
