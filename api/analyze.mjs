// Vercel serverless function: proxies the AI analysis to Claude with the API key
// kept server-side (never exposed to the browser, and avoids CORS).
//
// Only a logged-in CRM user may call it: the browser sends its Supabase session
// token and we verify it with the service role, same as api/bank-analyze.mjs.
// Without that check anyone who found the URL could run prompts on our key.
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment
const admin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ error: "Method not allowed" });
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    res.status(500).json({ error: "Falta configurar ANTHROPIC_API_KEY en Vercel." });
    return;
  }
  if (!admin) {
    res.status(500).json({ error: "Falta SUPABASE_SERVICE_ROLE_KEY / SUPABASE_URL en Vercel." });
    return;
  }

  // AuthN — a valid session token is required; fail closed, never open.
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  const { data: { user } = {}, error: authErr } = token ? await admin.auth.getUser(token) : { data: {}, error: true };
  if (authErr || !user) {
    res.status(401).json({ error: "No autorizado." });
    return;
  }

  try {
    const { prompt } = req.body || {};
    if (!prompt || typeof prompt !== "string") {
      res.status(400).json({ error: "Falta el prompt." });
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
