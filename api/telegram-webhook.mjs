// Vercel serverless: Telegram channel for the CRM agent. The agent brain lives
// in lib/agent.mjs (shared with WhatsApp); this file only handles the Telegram
// transport: secret-token check, whitelist, immediate ACK and async reply.
//
// Setup: create the bot with @BotFather, then register the webhook with
// scripts/setup-telegram-webhook.mjs. Trust comes from the secret token that
// Telegram echoes back on every update (TELEGRAM_WEBHOOK_SECRET) plus the
// TELEGRAM_ALLOWED_USERS whitelist.
import { waitUntil } from "@vercel/functions";
import { admin, handleIncoming } from "../lib/agent.mjs";

export const maxDuration = 300;

async function sendTelegram(chatId, text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  if (!res.ok) throw new Error(`Telegram send failed ${res.status}: ${await res.text()}`);
}

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!admin || !process.env.ANTHROPIC_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "server not configured" }); return;
  }

  // Telegram echoes the secret_token registered with setWebhook on every update.
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;
  if (secret && req.headers["x-telegram-bot-api-secret-token"] !== secret) {
    res.status(401).json({ error: "bad secret" }); return;
  }

  const msg = req.body?.message;
  const chatId = msg?.chat?.id;
  const text = (msg?.text || "").trim();
  const username = (msg?.from?.username || "").toLowerCase();
  const userId = String(msg?.from?.id || "");

  // TELEGRAM_ALLOWED_USERS: comma-separated @usernames and/or numeric user ids,
  // or "*" to allow anyone who finds the bot.
  const rawAllowed = (process.env.TELEGRAM_ALLOWED_USERS || "").trim();
  const allowed = rawAllowed.split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const isAllowed = rawAllowed === "*" || allowed.includes(username) || allowed.includes(userId);

  if (!chatId || !text || !isAllowed) { res.status(200).json({ ok: true }); return; } // silent

  // /start greeting without burning an AI call
  if (/^\/start\b/.test(text)) {
    waitUntil(sendTelegram(chatId, "¡Hola! Soy el agente del CRM de No Borders Moving 🚚\n\nContame en lenguaje natural, por ejemplo:\n• \"Tenemos un job del cliente García, pickup el 28 en Miami, entrega en Orlando\"\n• \"El job 1234 se entrega el viernes\"\n• \"¿Qué entregas hay esta semana?\"\n\nAntes de cargar algo al CRM siempre te muestro lo que entendí y confirmás con \"sí\".").catch((e) => console.error("telegram-webhook bg:", e)));
    res.status(200).json({ ok: true }); return;
  }

  // ACK immediately (Telegram retries on slow responses) and reply async.
  waitUntil(
    handleIncoming(`tg:${chatId}`, text)
      .then((reply) => sendTelegram(chatId, reply))
      .catch((e) => console.error("telegram-webhook bg:", e))
  );
  res.status(200).json({ ok: true });
}
