// Vercel serverless + Cron: composes the daily ops brief (lib/brief.mjs) and
// posts it to the team's Telegram group (TELEGRAM_BRIEF_CHAT_ID).
//
// vercel.json schedules this daily; Vercel Cron authenticates itself with
// `Authorization: Bearer ${CRON_SECRET}` when that env var exists. Manual
// runs: same header. `?dry=1` returns the brief as JSON without sending it.
import { admin } from "../lib/agent.mjs";
import { collectBriefData, composeBrief } from "../lib/brief.mjs";

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
  const secret = process.env.CRON_SECRET;
  // Auth: the Vercel Cron sends the Bearer header; humans testing from a
  // browser can pass ?secret=... instead.
  const provided = req.headers.authorization === `Bearer ${secret}` || req.query?.secret === secret;
  if (secret && !provided) {
    res.status(401).json({ error: "unauthorized" }); return;
  }
  if (!admin || !process.env.ANTHROPIC_API_KEY || !process.env.TELEGRAM_BOT_TOKEN) {
    res.status(500).json({ error: "server not configured" }); return;
  }

  try {
    const data = await collectBriefData();
    const brief = await composeBrief(data);
    if (req.query?.dry) { res.status(200).json({ ok: true, dry: true, data, brief }); return; }

    const chatId = process.env.TELEGRAM_BRIEF_CHAT_ID;
    if (!chatId) { res.status(500).json({ error: "falta TELEGRAM_BRIEF_CHAT_ID (usá /chatid en el grupo)" }); return; }
    // Telegram caps messages at 4096 chars — split if the brief ran long.
    for (let i = 0; i < brief.length; i += 3900) await sendTelegram(chatId, brief.slice(i, i + 3900));
    res.status(200).json({ ok: true, sent: true, chars: brief.length });
  } catch (e) {
    console.error("daily-brief:", e);
    res.status(500).json({ error: e?.message || "brief error" });
  }
}
