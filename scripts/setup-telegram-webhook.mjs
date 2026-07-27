#!/usr/bin/env node
// One-time: points the Telegram bot's webhook at the CRM agent endpoint, with a
// secret token that api/telegram-webhook.mjs verifies on every update.
//
// Usage (Node 18+):
//   TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_WEBHOOK_SECRET=un-secreto-largo \
//   APP_URL=https://noborders-storage-manager-mu.vercel.app \
//   node scripts/setup-telegram-webhook.mjs
//
// TELEGRAM_BOT_TOKEN comes from @BotFather (/newbot). TELEGRAM_WEBHOOK_SECRET
// is any random string you invent — set the SAME value in Vercel.

const TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const SECRET = process.env.TELEGRAM_WEBHOOK_SECRET;
const APP_URL = (process.env.APP_URL || "").replace(/\/+$/, "");

if (!TOKEN || !SECRET || !APP_URL) {
  console.error("Faltan variables. Ejemplo:\n  TELEGRAM_BOT_TOKEN=123:abc TELEGRAM_WEBHOOK_SECRET=mi-secreto APP_URL=https://mi-app.vercel.app node scripts/setup-telegram-webhook.mjs");
  process.exit(1);
}

const res = await fetch(`https://api.telegram.org/bot${TOKEN}/setWebhook`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    url: `${APP_URL}/api/telegram-webhook`,
    secret_token: SECRET,
    allowed_updates: ["message"],
    drop_pending_updates: true,
  }),
});
const body = await res.json();
if (body.ok) {
  console.log(`✓ Webhook configurado: ${APP_URL}/api/telegram-webhook`);
  console.log("  El bot ya redirige los mensajes al agente del CRM.");
} else {
  console.error("✗ Error:", JSON.stringify(body));
  process.exit(1);
}
