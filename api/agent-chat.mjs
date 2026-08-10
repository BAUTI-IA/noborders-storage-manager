// Vercel serverless: in-app channel for the CRM agent. The chat widget in the
// React app (src/agentChat.jsx) POSTs the user's message with their Supabase
// JWT; we verify it server-side (same pattern as api/admin-users.mjs) and run
// the shared agent brain (lib/agent.mjs). Conversation state is keyed
// "app:<user email>", so each CRM user has their own thread — independent of
// any Telegram/WhatsApp conversation they may also have.
import { admin, handleIncoming } from "../lib/agent.mjs";

export const maxDuration = 300;

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!admin || !process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "server not configured" }); return; }

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
