// Vercel serverless function: ask Claude to read a homebanking screenshot (or a
// statement photo) and extract every USD transaction line, suggesting a category
// from the Bancos chart of accounts. The employee then reviews/verifies each
// line in the app — this is extraction + suggestion, never final categorization.
// Mirrors api/bol-analyze.mjs (vision + auth + JSON-only response).
import Anthropic from "@anthropic-ai/sdk";
import { createClient } from "@supabase/supabase-js";

const client = new Anthropic(); // ANTHROPIC_API_KEY from env
const admin = process.env.SUPABASE_SERVICE_ROLE_KEY
  ? createClient(process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { autoRefreshToken: false, persistSession: false } })
  : null;

// Keep in sync with BANK_CATEGORIES in src/bankData.js.
const CATEGORY_KEYS = [
  "customer_payment", "broker_payment", "storage_income", "refund_in", "owner_contribution", "transfer_in", "other_income",
  "fuel", "tolls", "maintenance", "materials", "lodging", "meals", "truck_lease", "driver_pay", "payroll_office",
  "commissions", "insurance", "rent_storage", "utilities", "software_subscriptions", "bank_fees", "taxes",
  "marketing", "refund_out", "owner_draw", "transfer_out", "other_expense",
];

export default async function handler(req, res) {
  if (req.method !== "POST") { res.status(405).json({ error: "Method not allowed" }); return; }
  if (!process.env.ANTHROPIC_API_KEY) { res.status(500).json({ error: "Falta ANTHROPIC_API_KEY en Vercel." }); return; }

  // Require a valid logged-in user (best-effort auth via service role).
  if (admin) {
    const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    const { data: { user } = {}, error } = await admin.auth.getUser(token);
    if (error || !user) { res.status(401).json({ error: "No autorizado." }); return; }
  }

  const { image_base64, media_type, descriptions } = req.body || {};
  if (!image_base64 && !Array.isArray(descriptions)) { res.status(400).json({ error: "Falta la imagen o las descripciones." }); return; }

  try {
    let content;
    if (image_base64) {
      // Vision mode: extract every statement line from a screenshot.
      const prompt = `This image is a screenshot of a US bank's online banking (or a bank statement) for a moving & storage company. All amounts are USD. ` +
        `Extract EVERY transaction line visible. For each line return: "date" (ISO YYYY-MM-DD; if the year is not visible assume the most recent plausible one), ` +
        `"description" (the verbatim transaction text), "amount" (positive number), "direction" ("in" for credits/deposits, "out" for debits/withdrawals), ` +
        `"category" (your best guess from exactly this list, or "" if unsure: ${CATEGORY_KEYS.join(", ")}), and "confidence" (0 to 1). ` +
        `Do NOT invent lines; skip running-balance columns, headers and totals. ` +
        `Respond with ONLY compact JSON: {"lines":[{"date":"","description":"","amount":0,"direction":"in","category":"","confidence":0}]}`;
      content = [
        { type: "image", source: { type: "base64", media_type: media_type || "image/jpeg", data: image_base64 } },
        { type: "text", text: prompt },
      ];
    } else {
      // Text mode: batch-suggest categories for already-parsed CSV lines.
      const list = descriptions.slice(0, 300).map((d, i) => `${i}. [${d.direction === "out" ? "OUT" : "IN"}] $${d.amount} — ${String(d.description || "").slice(0, 160)}`).join("\n");
      const prompt = `These are bank transaction lines (USD) from a moving & storage company. For each, suggest a category from exactly this list (or "" if unsure): ${CATEGORY_KEYS.join(", ")}. ` +
        `Lines:\n${list}\n` +
        `Respond with ONLY compact JSON: {"lines":[{"i":0,"category":"","confidence":0}]} — one entry per input line, same order, "i" is the input index.`;
      content = [{ type: "text", text: prompt }];
    }

    const message = await client.messages.create({
      model: "claude-opus-4-8",
      max_tokens: 8192,
      messages: [{ role: "user", content }],
    });
    const text = message.content.filter(b => b.type === "text").map(b => b.text).join("");
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) { res.status(200).json({ lines: [] }); return; }
    const parsed = JSON.parse(m[0]);
    const lines = (parsed.lines || []).map(l => ({
      ...l,
      amount: Math.abs(Number(l.amount) || 0),
      direction: l.direction === "out" ? "out" : "in",
      category: CATEGORY_KEYS.includes(l.category) ? l.category : "",
      confidence: Math.max(0, Math.min(1, Number(l.confidence) || 0)),
    }));
    res.status(200).json({ lines });
  } catch (e) {
    res.status(500).json({ error: e?.message || "Error analizando el extracto." });
  }
}
