// Carrier inbox — the server half of the dispatch@ mailbox (docs/carrier-dispatch.md).
//
// A Google Apps Script running inside the dispatch@ mailbox talks to one door
// (/api/carrier-mail → api/agent-hub.mjs?action=carrier_mail):
//
//   GET                       → the dispatch emails waiting to go out (outbox)
//   POST {step:"ack"}         → one of them was sent (or failed)
//   POST {step:"message"}     → a new email arrived: we file it and hand back
//                               signed upload URLs for its attachments, which
//                               the script PUTs straight into Storage (they never
//                               cross this function, so Vercel's 4.5 MB body cap
//                               does not apply)
//   POST {step:"finalize"}    → the uploads are done: the AI reads the documents,
//                               the message is linked to its dispatch, and the
//                               team gets a Telegram notice
//
// SECURITY — a carrier email is untrusted input feeding an LLM:
//   · only mail from an address (or own domain) on a carrier record is read;
//     everything else is filed as `ignored` and never reaches the model;
//   · the extractor runs against a closed json_schema and the prompt says the
//     documents are data, not instructions;
//   · nothing here touches money: what the AI read is a proposal that a person
//     approves in the Carriers section. The only state change from mail alone
//     is "accepted" on a short ACCEPT reply to the carrier's own dispatch;
//   · documents land in a private bucket; the browser reads them through
//     short-lived signed URLs.
//
// Every I/O dependency is injectable (deps) so scripts/test-carrier-mail.mjs
// runs the whole flow against an in-memory database.
import { admin, client } from "./clients.mjs";
import { EXTRACT_MODEL } from "./leads.mjs";
import {
  findCarrierBySender, matchInbound, isAcceptReply, normalizeExtraction, extractionPrompt,
  docsNotice, EXTRACTION_SCHEMA, OPEN_STATUSES,
} from "./carriers.mjs";

export const CARRIER_MAIL_HEADER = "x-carrier-secret";
export const BUCKET = "carrier-docs";
const MODEL = process.env.CARRIER_EXTRACT_MODEL || EXTRACT_MODEL;
const TZ = "America/New_York";
const todayISO = () => new Date().toLocaleDateString("en-CA", { timeZone: TZ });

const MAX_ATTACHMENTS = 10;
const MAX_BYTES = 15 * 1024 * 1024;     // per file
const MAX_READ_BYTES = 24 * 1024 * 1024; // everything sent to the model in one request
// What the model can read, and how. HEIC (iPhone photos) is kept for a person
// to open, but not sent to the model.
const READABLE = {
  "application/pdf": "document",
  "image/jpeg": "image", "image/png": "image", "image/webp": "image", "image/gif": "image",
};
const KEPT = new Set([...Object.keys(READABLE), "image/heic", "image/heif"]);
const MAX_TEXT = 20000;

const clip = (v, n) => String(v ?? "").slice(0, n);
const safeName = (name) => String(name || "file").replace(/[^\w.\- ]+/g, "_").replace(/\s+/g, "_").slice(-80) || "file";

function must(res, what) {
  if (res?.error) throw new Error(`${what}: ${res.error.message || res.error.code || "db error"}`);
  return res.data;
}

// ── Telegram ─────────────────────────────────────────────────────────────────

/** Team notice for new carrier documents. Never throws; false when not configured. */
export async function notifyCarrierTeam(text) {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  const chatId = process.env.CARRIER_TELEGRAM_CHAT_ID || process.env.TELEGRAM_BRIEF_CHAT_ID;
  if (!token || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) { console.error("carrier telegram:", res.status, await res.text()); return false; }
    return true;
  } catch (e) { console.error("carrier telegram:", e?.message || e); return false; }
}

// ── Reading the documents ────────────────────────────────────────────────────

/** files: [{ mime, data (base64) }]. Returns the normalized extraction. */
export async function extractDocs({ subject, text, files, dispatch, today = todayISO() }) {
  if (!process.env.ANTHROPIC_API_KEY && !process.env.AGENT_ANTHROPIC_API_KEY) throw new Error("ANTHROPIC_API_KEY is not set");
  const blocks = (files || []).map((f) => READABLE[f.mime] === "document"
    ? { type: "document", source: { type: "base64", media_type: "application/pdf", data: f.data } }
    : { type: "image", source: { type: "base64", media_type: f.mime, data: f.data } });
  const message = await client.messages.create({
    model: MODEL,
    max_tokens: 4000,
    output_config: { effort: "medium", format: { type: "json_schema", schema: EXTRACTION_SCHEMA } },
    messages: [{ role: "user", content: [...blocks, { type: "text", text: extractionPrompt({ subject, text, dispatch, today }) }] }],
  });
  if (message.stop_reason === "refusal") throw new Error("the model declined to read these documents");
  const raw = message.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new Error("the model returned an unreadable answer"); }
  return normalizeExtraction(parsed);
}

function defaults(deps = {}) {
  return {
    db: deps.db || admin,
    storage: deps.storage || admin?.storage,
    extract: deps.extract || extractDocs,
    notify: deps.notify || notifyCarrierTeam,
    now: deps.now || (() => new Date()),
    appUrl: deps.appUrl ?? (process.env.APP_URL || ""),
  };
}

// ── Outbox ───────────────────────────────────────────────────────────────────

/** Dispatch emails waiting to be sent, with a short-lived link to each rate confirmation. */
export async function listOutbox(deps) {
  const { db, storage } = defaults(deps);
  const rows = must(await db.from("carrier_messages").select("*")
    .eq("direction", "out").eq("channel", "email").eq("status", "queued").is("deleted_at", null)
    .order("created_at", { ascending: true }).limit(20), "carrier_messages") || [];
  const out = [];
  for (const m of rows) {
    const attachments = [];
    for (const a of Array.isArray(m.attachments) ? m.attachments : []) {
      if (!a?.path) continue;
      const signed = await storage.from(BUCKET).createSignedUrl(a.path, 900);
      if (signed.error || !signed.data?.signedUrl) continue;
      attachments.push({ name: a.name || "attachment.pdf", mime: a.mime || "application/pdf", url: signed.data.signedUrl });
    }
    out.push({
      id: m.id, dispatch_id: m.dispatch_id, to: m.to_addr, subject: m.subject,
      text: m.body_text, html: m.body_html, attachments,
    });
  }
  return { ok: true, messages: out };
}

/** The script reports a send. Idempotent: only a queued message changes. */
export async function ackOutbox(body, deps) {
  const { db, now } = defaults(deps);
  const id = Number(body?.id);
  if (!id) return { ok: false, status: 400, error: "missing id" };
  const [m] = must(await db.from("carrier_messages").select("*").eq("id", id).limit(1), "carrier_messages") || [];
  if (!m || m.direction !== "out") return { ok: false, status: 404, error: "unknown message" };
  if (m.status !== "queued") return { ok: true, status: m.status };
  const at = now().toISOString();
  if (body.ok === false) {
    must(await db.from("carrier_messages").update({ status: "failed", error: clip(body.error || "send failed", 500), updated_at: at }).eq("id", id), "carrier_messages");
    return { ok: true, status: "failed" };
  }
  must(await db.from("carrier_messages").update({
    status: "sent", sent_at: at, error: null, updated_at: at,
    from_addr: clip(body.from || m.from_addr, 320) || null,
    gmail_message_id: clip(body.gmail_message_id, 200) || m.gmail_message_id || null,
    gmail_thread_id: clip(body.gmail_thread_id, 200) || null,
  }).eq("id", id), "carrier_messages");
  if (m.dispatch_id) {
    const [d] = must(await db.from("carrier_dispatches").select("id, sent_at").eq("id", m.dispatch_id).limit(1), "carrier_dispatches") || [];
    if (d && !d.sent_at) must(await db.from("carrier_dispatches").update({ sent_at: at, updated_at: at }).eq("id", d.id), "carrier_dispatches");
  }
  return { ok: true, status: "sent" };
}

// ── Inbox ────────────────────────────────────────────────────────────────────

async function signUploads(storage, attachments) {
  const uploads = [];
  for (const [index, a] of attachments.entries()) {
    if (!a.path) continue;
    const r = await storage.from(BUCKET).createSignedUploadUrl(a.path, { upsert: true });
    if (r.error || !r.data?.signedUrl) throw new Error(`storage: ${r.error?.message || "no upload url"}`);
    uploads.push({ index, url: r.data.signedUrl });
  }
  return uploads;
}

/**
 * A new email in dispatch@. Files it and answers with where to upload each
 * attachment. Shape: { id, status, uploads: [{ index, url }], duplicate?, ignored?, accepted? }.
 */
export async function receiveMessage(body, deps) {
  const { db, storage, now } = defaults(deps);
  const b = body || {};
  const from = clip(b.from, 320);
  const messageId = clip(b.message_id, 200);
  if (!from || !messageId) return { ok: false, status: 400, error: "from and message_id are required" };
  const at = now().toISOString();

  const [seen] = must(await db.from("carrier_messages").select("*").eq("gmail_message_id", messageId).limit(1), "carrier_messages") || [];
  if (seen) {
    // A run that died between filing and uploading gets fresh upload URLs.
    if (seen.status === "receiving") return { ok: true, id: seen.id, status: "receiving", uploads: await signUploads(storage, seen.attachments || []) };
    return { ok: true, id: seen.id, status: seen.status, duplicate: true, uploads: [] };
  }

  const carriers = must(await db.from("carriers").select("*").is("deleted_at", null), "carriers") || [];
  const carrier = findCarrierBySender(from, carriers);
  const base = {
    direction: "in", channel: "email", from_addr: from, to_addr: clip([b.to, b.cc].filter(Boolean).join(", "), 1000),
    subject: clip(b.subject, 500), body_text: clip(b.text, MAX_TEXT), gmail_message_id: messageId,
    gmail_thread_id: clip(b.thread_id, 200) || null, received_at: b.date || at, created_at: at,
  };

  if (!carrier) {
    // Not a carrier we know: kept for the record, never read by the model.
    const row = must(await db.from("carrier_messages").insert([{ ...base, status: "ignored", attachments: [] }]).select("id").single(), "carrier_messages");
    return { ok: true, id: row.id, status: "ignored", ignored: true, uploads: [] };
  }

  const dispatches = must(await db.from("carrier_dispatches").select("*").eq("carrier_id", carrier.id).is("deleted_at", null), "carrier_dispatches") || [];
  const files = (Array.isArray(b.attachments) ? b.attachments : []).slice(0, 25);
  const match = matchInbound({ to: base.to_addr, subject: base.subject, text: base.body_text }, dispatches, carrier.id);

  // A short "ACCEPT" with nothing attached, on a dispatch still waiting for it.
  if (!files.length && isAcceptReply(base.body_text) && match.dispatchId) {
    const d = dispatches.find((x) => x.id === match.dispatchId);
    const row = must(await db.from("carrier_messages").insert([{
      ...base, carrier_id: carrier.id, dispatch_id: d.id, match_method: match.method,
      status: "applied", attachments: [], reviewed_by: "auto: accept reply", reviewed_at: at,
    }]).select("id").single(), "carrier_messages");
    if (d.status === "sent") {
      must(await db.from("carrier_dispatches").update({ status: "accepted", accepted_at: at, updated_at: at, updated_by: "carrier reply" }).eq("id", d.id), "carrier_dispatches");
    }
    return { ok: true, id: row.id, status: "applied", accepted: d.status === "sent", uploads: [] };
  }

  const row = must(await db.from("carrier_messages").insert([{
    ...base, carrier_id: carrier.id, status: "receiving", attachments: [],
  }]).select("id").single(), "carrier_messages");

  let kept = 0;
  const attachments = files.map((f, i) => {
    const mime = String(f?.mime || "").toLowerCase();
    const size = Number(f?.size) || 0;
    const a = { name: clip(f?.name || `attachment-${i + 1}`, 200), mime, size };
    if (!KEPT.has(mime)) return { ...a, skipped: "type" };
    if (size > MAX_BYTES) return { ...a, skipped: "size" };
    if (kept >= MAX_ATTACHMENTS) return { ...a, skipped: "count" };
    kept++;
    return { ...a, path: `inbox/${row.id}/${i + 1}-${safeName(a.name)}`, readable: !!READABLE[mime] };
  });
  must(await db.from("carrier_messages").update({ attachments }).eq("id", row.id), "carrier_messages");
  return { ok: true, id: row.id, status: "receiving", uploads: await signUploads(storage, attachments) };
}

/**
 * The script finished uploading: read the documents, link the message to its
 * dispatch and tell the team. Idempotent: only a `receiving` message is read.
 */
export async function finalizeMessage(body, deps) {
  const { db, storage, extract, notify, now, appUrl } = defaults(deps);
  const id = Number(body?.id);
  if (!id) return { ok: false, status: 400, error: "missing id" };
  const [m] = must(await db.from("carrier_messages").select("*").eq("id", id).limit(1), "carrier_messages") || [];
  if (!m || m.direction !== "in") return { ok: false, status: 404, error: "unknown message" };
  if (m.status !== "receiving") return { ok: true, id, status: m.status };

  const [carrier] = must(await db.from("carriers").select("*").eq("id", m.carrier_id).limit(1), "carriers") || [];
  const dispatches = must(await db.from("carrier_dispatches").select("*").eq("carrier_id", m.carrier_id).is("deleted_at", null), "carrier_dispatches") || [];

  // Pull what the model can read, within one request's budget.
  const attachments = (m.attachments || []).map((a) => ({ ...a }));
  const files = [];
  let budget = MAX_READ_BYTES;
  for (const a of attachments) {
    if (!a.path) continue;
    const dl = await storage.from(BUCKET).download(a.path);
    if (dl.error || !dl.data) { a.missing = true; continue; }
    if (!a.readable) continue;
    const buf = Buffer.from(await dl.data.arrayBuffer());
    if (buf.length > budget) { a.unread = "budget"; continue; }
    budget -= buf.length;
    files.push({ mime: a.mime, data: buf.toString("base64") });
  }

  // The likely dispatch before reading gives the model a reference point.
  const pre = matchInbound({ to: m.to_addr, subject: m.subject, text: m.body_text }, dispatches, m.carrier_id);
  const preDispatch = dispatches.find((d) => d.id === pre.dispatchId) || null;

  let extraction = null, error = null;
  if (files.length || String(m.body_text || "").trim()) {
    try {
      extraction = await extract({ subject: m.subject, text: m.body_text, files, dispatch: preDispatch });
    } catch (e) {
      error = clip(`AI read failed: ${e?.message || e}`, 500);
      console.error("carrier finalize:", error);
    }
  }

  const match = matchInbound({ to: m.to_addr, subject: m.subject, text: m.body_text, extraction }, dispatches, m.carrier_id);
  const dispatch = dispatches.find((d) => d.id === match.dispatchId) || null;
  const status = dispatch ? "review" : "unmatched";
  const at = now().toISOString();
  must(await db.from("carrier_messages").update({
    status, dispatch_id: dispatch?.id ?? null, match_method: match.method, extraction, error, attachments, updated_at: at,
  }).eq("id", id), "carrier_messages");

  if (dispatch && OPEN_STATUSES.includes(dispatch.status) && dispatch.status !== "docs_received") {
    must(await db.from("carrier_dispatches").update({ status: "docs_received", updated_at: at, updated_by: "carrier inbox" }).eq("id", dispatch.id), "carrier_dispatches");
  }

  await notify(docsNotice({ dispatch, carrier, extraction, appUrl }));
  return { ok: true, id, status, dispatch_id: dispatch?.id ?? null };
}

/** Route one authenticated request from the script. */
export async function carrierMail(req, deps) {
  if (req.method === "GET") return listOutbox(deps);
  if (req.method !== "POST") return { ok: false, status: 405, error: "method not allowed" };
  const b = req.body && typeof req.body === "object" ? req.body : {};
  if (b.step === "ack") return ackOutbox(b, deps);
  if (b.step === "message") return receiveMessage(b, deps);
  if (b.step === "finalize") return finalizeMessage(b, deps);
  return { ok: false, status: 400, error: `unknown step "${clip(b.step, 40)}"` };
}
