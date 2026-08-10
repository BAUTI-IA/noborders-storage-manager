// Vercel serverless: agent hub — two agent features share one function to stay
// under the Hobby plan's 12-function limit.
//
//   GET  → daily ops brief (Vercel Cron / manual). Auth: Bearer CRON_SECRET or
//          ?secret=; ?dry=1 returns JSON without sending. Posts to the team's
//          Telegram group (TELEGRAM_BRIEF_CHAT_ID).
//   POST → in-app chat for the CRM widget (src/agentChat.jsx). Auth: the
//          caller's Supabase JWT, verified server-side (admin-users pattern).
import { admin, handleIncoming } from "../lib/agent.mjs";
import { collectBriefData, composeBrief, snapshotAndDeltas, saveSnapshot } from "../lib/brief.mjs";

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

async function dailyBrief(req, res) {
  const secret = process.env.CRON_SECRET;
  // Vercel Cron sends the Bearer header; humans testing from a browser pass ?secret=.
  const provided = req.headers.authorization === `Bearer ${secret}` || req.query?.secret === secret;
  if (secret && !provided) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!process.env.TELEGRAM_BOT_TOKEN) { res.status(500).json({ error: "server not configured" }); return; }

  try {
    const data = await collectBriefData();
    const { deltas } = await snapshotAndDeltas(data);
    const brief = await composeBrief(data, deltas);
    if (req.query?.dry) { res.status(200).json({ ok: true, dry: true, data, deltas, brief }); return; }

    const chatId = process.env.TELEGRAM_BRIEF_CHAT_ID;
    if (!chatId) { res.status(500).json({ error: "falta TELEGRAM_BRIEF_CHAT_ID (usá /chatid en el grupo)" }); return; }
    // Telegram caps messages at 4096 chars — split if the brief ran long.
    for (let i = 0; i < brief.length; i += 3900) await sendTelegram(chatId, brief.slice(i, i + 3900));
    await saveSnapshot(data); // after a real send only, so ?dry runs don't overwrite the day
    res.status(200).json({ ok: true, sent: true, chars: brief.length, deltas });
  } catch (e) {
    console.error("daily-brief:", e);
    res.status(500).json({ error: e?.message || "brief error" });
  }
}

async function appChat(req, res) {
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (!token) { res.status(401).json({ error: "No autorizado." }); return; }
  const { data: { user } = {}, error: uErr } = await admin.auth.getUser(token);
  if (uErr || !user) { res.status(401).json({ error: "No autorizado.", detail: uErr?.message || "token inválido" }); return; }

  const message = String(req.body?.message || "").trim();
  if (!message) { res.status(400).json({ error: "mensaje vacío" }); return; }
  if (message.length > 4000) { res.status(400).json({ error: "mensaje demasiado largo" }); return; }

  try {
    const reply = await handleIncoming(`app:${(user.email || user.id).toLowerCase()}`, message);
    res.status(200).json({ reply });
  } catch (e) {
    console.error("agent-chat:", e);
    res.status(500).json({ error: e?.message || "agent error" });
  }
}

export default async function handler(req, res) {
  if (!admin || !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "server not configured" }); return; }
  if (req.method === "GET") return dailyBrief(req, res);
  if (req.method === "POST") return appChat(req, res);
  res.status(405).end();
}
