// Reading broker paperwork — the server half: one model call per document.
// Schemas, prompts and coercion live in lib/brokerDocsData.mjs. Nothing here
// writes to the database: the reading only pre-fills a form a person saves.
// Rides api/trip-suggestions.mjs (actions broker_job_extract and
// settlement_extract) because api/ is at the Hobby plan's 12-function cap.
import { client } from "./clients.mjs";
import { EXTRACT_MODEL } from "./leads.mjs";
import {
  BROKER_JOB_SCHEMA, SETTLEMENT_SCHEMA, brokerJobPrompt, settlementPrompt,
  normalizeBrokerJob, normalizeSettlement,
} from "./brokerDocsData.mjs";

const MODEL = process.env.BROKER_EXTRACT_MODEL || EXTRACT_MODEL;
const TZ = "America/New_York";
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

export const IMAGE_TYPES = new Set(["image/jpeg", "image/png", "image/webp", "image/gif"]);
export const DOC_TYPES = new Set([...IMAGE_TYPES, "application/pdf"]);

/** A content block for an attached file: PDFs as documents, the rest as images. */
export function fileBlock({ media_type, data }) {
  return media_type === "application/pdf"
    ? { type: "document", source: { type: "base64", media_type, data } }
    : { type: "image", source: { type: "base64", media_type, data } };
}

async function readJson({ blocks, prompt, schema, maxTokens = 4000 }) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.AGENT_ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    output_config: { effort: "medium", format: { type: "json_schema", schema } },
    messages: [{ role: "user", content: [...blocks, { type: "text", text: prompt }] }],
  });
  if (message.stop_reason === "refusal") throw new Error("the model declined to read this document");
  const raw = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  try { return JSON.parse(raw); } catch { throw new Error("the model returned an unreadable answer"); }
}

/** A broker job from a WhatsApp message, a screenshot of one, or call notes. */
export async function readBrokerJob({ text = "", image = null, brokers = [], today = todayISO() }) {
  const blocks = image ? [fileBlock(image)] : [];
  const p = await readJson({ blocks, prompt: brokerJobPrompt({ text, brokers, today }), schema: BROKER_JOB_SCHEMA, maxTokens: 2000 });
  return normalizeBrokerJob(p);
}

/** A broker's closing sheet (PDF or photo). */
export async function readClosingSheet({ file, brokers = [], today = todayISO() }) {
  const p = await readJson({ blocks: [fileBlock(file)], prompt: settlementPrompt({ brokers, today }), schema: SETTLEMENT_SCHEMA, maxTokens: 8000 });
  return normalizeSettlement(p);
}
