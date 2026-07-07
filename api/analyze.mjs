// Vercel serverless function: proxies the AI analysis to Claude with the API key
// kept server-side (never exposed to the browser, and avoids CORS).
// Requires a valid Supabase session — this endpoint spends Anthropic credits and
// must never be an open proxy.
import Anthropic from "@anthropic-ai/sdk";
import { requireUser, rateLimitOk } from "../lib/auth.mjs";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const MAX_PROMPT_CHARS = 20000; // the dashboard summary prompt is ~2k chars; anything huge is abuse

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });
    return;
  }
  const user = await requireUser(req, res);
  if (!user) return;
  if (!rateLimitOk(res, `analyze:${user.id}`, 10, 5 * 60 * 1000)) return;

  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Falta el prompt." });
      return;
    }
    if (prompt.length > MAX_PROMPT_CHARS) {
      res.status(400).json({ error: "El prompt es demasiado largo." });
      return;
    }
    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 2048,
      messages: [{ role: "user", content: prompt }],
    });
    const text = message.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");
    res.status(200).json({ text });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error al generar el análisis." });
  }
}
