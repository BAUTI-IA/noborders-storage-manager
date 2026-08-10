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
import { transcribeAudio } from "../lib/transcribe.mjs";

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

// Voice note / audio file → text, via Telegram's file API + Whisper.
async function transcribeTelegramAudio(fileId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const meta = await fetch(`https://api.telegram.org/bot${token}/getFile`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: fileId }),
  }).then((r) => r.json());
  if (!meta.ok) throw new Error(`Telegram getFile: ${JSON.stringify(meta)}`);
  const filePath = meta.result.file_path;
  const audio = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!audio.ok) throw new Error(`Telegram file download ${audio.status}`);
  const buffer = Buffer.from(await audio.arrayBuffer());
  return transcribeAudio(buffer, filePath.split("/").pop() || "audio.ogg");
}

// "typing…" in the chat while the agent works. Telegram clears the indicator
// after ~5s, so it's refreshed until the reply is ready.
function keepTyping(chatId) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const ping = () => fetch(`https://api.telegram.org/bot${token}/sendChatAction`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action: "typing" }),
  }).catch(() => {});
  ping();
  const timer = setInterval(ping, 4000);
  return () => clearInterval(timer);
}

// Which CRM user is this Telegram account? Drives what the agent may write.
// Unlinked users stay read-only (see /link below).
async function actorFor(from) {
  const tgId = String(from?.id || "");
  if (!tgId) return {};
  const { data: profile } = await admin.from("profiles").select("*").eq("telegram_user_id", tgId).maybeSingle();
  if (!profile?.active) return {};
  return { profile, userEmail: profile.email };
}

// `/link 123456` — the code comes from the "Vincular Telegram" button inside
// the CRM chat widget, which proves the person is that CRM user.
async function handleLink(chatId, from, text) {
  const code = (text.match(/\/link\s+(\d{6})/) || [])[1];
  if (!code) return "Mandame: /link 123456 (el código sale del botón \"Vincular Telegram\" en el chat del agente dentro del CRM).";
  const { data: profile } = await admin.from("profiles")
    .select("*").eq("link_code", code).gt("link_code_expires_at", new Date().toISOString()).maybeSingle();
  if (!profile) return "Ese código no existe o ya venció. Generá uno nuevo desde el CRM.";
  const { error } = await admin.from("profiles")
    .update({ telegram_user_id: String(from.id), link_code: null, link_code_expires_at: null })
    .eq("id", profile.id);
  if (error) return "No pude vincular la cuenta: " + error.message;
  const scope = profile.role === "admin" ? "acceso total" : "tus permisos del CRM";
  return `✅ Vinculado como ${profile.full_name || profile.email}. Ya podés pedirme que cargue cosas: uso ${scope}.`;
}

// Full voice pipeline: transcribe, echo what was heard, then run the agent.
async function processVoice(chatId, fileId, from) {
  let text;
  try {
    text = await transcribeTelegramAudio(fileId);
  } catch (e) {
    console.error("telegram voice:", e);
    await sendTelegram(chatId, "⚠️ No pude procesar el audio. " + (process.env.OPENAI_API_KEY ? "Probá de nuevo o mandalo por texto." : "Falta configurar la transcripción (OPENAI_API_KEY)."));
    return;
  }
  if (!text) { await sendTelegram(chatId, "🎤 No se escucha nada en el audio. ¿Probás de nuevo?"); return; }
  await sendTelegram(chatId, `🎤 «${text}»`); // language-neutral echo of the transcript
  const stopTyping = keepTyping(chatId);
  try {
    const reply = await handleIncoming(`tg:${chatId}`, text, [], await actorFor(from));
    await sendTelegram(chatId, reply);
  } finally { stopTyping(); }
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
  // Voice note (voice), audio file (audio) or round video note (video_note — has an audio track Whisper can read)
  const audioFileId = msg?.voice?.file_id || msg?.audio?.file_id || msg?.video_note?.file_id || null;
  const username = (msg?.from?.username || "").toLowerCase();
  const userId = String(msg?.from?.id || "");

  // TELEGRAM_ALLOWED_USERS: comma-separated @usernames and/or numeric user ids,
  // or "*" to allow anyone who finds the bot.
  const rawAllowed = (process.env.TELEGRAM_ALLOWED_USERS || "").trim();
  const allowed = rawAllowed.split(",").map((s) => s.trim().toLowerCase().replace(/^@/, "")).filter(Boolean);
  const isAllowed = rawAllowed === "*" || allowed.includes(username) || allowed.includes(userId);

  if (!chatId || !isAllowed || (!text && !audioFileId)) { res.status(200).json({ ok: true }); return; } // silent

  // /chatid works everywhere (incl. groups) — it's how the daily-brief group id
  // is discovered. In groups that's ALL the bot reacts to, so it doesn't butt
  // into normal team conversation; the agent itself is DM-only.
  const isGroup = ["group", "supergroup"].includes(msg?.chat?.type);
  if (/^\/chatid(@\w+)?\b/.test(text)) {
    waitUntil(sendTelegram(chatId, `Chat ID: ${chatId}`).catch((e) => console.error("telegram-webhook bg:", e)));
    res.status(200).json({ ok: true }); return;
  }
  if (isGroup) { res.status(200).json({ ok: true }); return; }

  if (audioFileId) {
    waitUntil(processVoice(chatId, audioFileId, msg.from).catch((e) => console.error("telegram-webhook voice bg:", e)));
    res.status(200).json({ ok: true }); return;
  }

  // Account linking: ties this Telegram user to a CRM user so the agent can
  // apply that person's permissions to writes.
  if (/^\/link\b/.test(text)) {
    waitUntil(handleLink(chatId, msg.from, text).then((r) => sendTelegram(chatId, r)).catch((e) => console.error("telegram-webhook link:", e)));
    res.status(200).json({ ok: true }); return;
  }

  // /start greeting without burning an AI call
  if (/^\/start\b/.test(text)) {
    waitUntil(sendTelegram(chatId, "¡Hola! Soy el agente del CRM de No Borders Moving 🚚\n\nPuedo:\n📦 Cargar jobs: \"Tenemos un job del cliente García, pickup el 28 en Miami, entrega en Orlando\"\n✏️ Actualizar: \"El job 1234 se entrega el viernes\"\n🔎 Consultar CUALQUIER dato del CRM: \"¿Qué entregas hay esta semana?\", \"¿Cuánto facturamos este mes?\", \"¿Qué camiones están en ruta?\", \"¿Balances pendientes de cobro?\"\n\nAntes de escribir algo en el CRM siempre te muestro qué voy a hacer y confirmás con \"sí\".\n\n🔗 Para poder cargar datos, vinculá tu cuenta: abrí el chat del agente dentro del CRM, tocá \"Vincular Telegram\" y mandame /link con el código.").catch((e) => console.error("telegram-webhook bg:", e)));
    res.status(200).json({ ok: true }); return;
  }

  // ACK immediately (Telegram retries on slow responses) and reply async.
  const stopTyping = keepTyping(chatId);
  waitUntil(
    actorFor(msg.from)
      .then((actor) => handleIncoming(`tg:${chatId}`, text, [], actor))
      .finally(stopTyping)
      .then((reply) => sendTelegram(chatId, reply))
      .catch((e) => console.error("telegram-webhook bg:", e))
  );
  res.status(200).json({ ok: true });
}
