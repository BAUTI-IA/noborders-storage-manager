// WhatsApp (WATI Coexistence) — the server half of the capture step.
//
// WATI posts every WhatsApp event of the business number to
// /api/wati-webhook (a vercel.json rewrite onto api/whatsapp-webhook.mjs,
// because api/ is at the Hobby plan's 12-function cap). This module stores
// each message in wa_messages and links it to the broker / driver / job that
// phone belongs to. No AI runs here: reading jobs out of the messages is the
// next phase, built on top of what this stores. See docs/wati-whatsapp.md.
//
// SECURITY — anyone can write to the WhatsApp number:
//   · the endpoint only accepts posts carrying WATI_WEBHOOK_SECRET, and refuses
//     everything when it is not configured (fails closed);
//   · text, names and the raw payload are stored as data, never executed.
import { timingSafeEqual } from "node:crypto";
import { admin } from "./clients.mjs";
import { parseWatiEvent, pickMatches } from "../src/watiData.js";

const secretEq = (got, want) => {
  const a = Buffer.from(String(got || ""));
  const b = Buffer.from(String(want));
  return a.length === b.length && timingSafeEqual(a, b);
};

// WATI's webhook form takes a URL and not always a header, so the one secret is
// accepted as ?token=, an X-Webhook-Secret header or a bearer token.
export function watiWebhookAuthOk(req) {
  const secret = process.env.WATI_WEBHOOK_SECRET;
  if (!secret) return false;
  return secretEq(req.query?.token, secret)
    || secretEq(req.headers["x-webhook-secret"], secret)
    || secretEq(req.headers.authorization, `Bearer ${secret}`);
}

async function matchPhone(key) {
  if (!key) return pickMatches([]);
  const { data, error } = await admin.rpc("wa_match_phone", { p_key: key });
  // A failed lookup must not lose the message: store it unlinked and say so.
  if (error) { console.error("[wati] wa_match_phone:", error.message); return pickMatches([]); }
  return pickMatches(data);
}

/** Store one WATI event. Throws on a database failure so WATI retries. */
export async function ingestWatiEvent(payload) {
  const ev = parseWatiEvent(payload);

  if (ev.kind === "ignore") {
    // The payload shape is not fully documented (Coexistence echoes are new),
    // so an event we could not read is logged whole: that log is how we learn.
    console.log(`[wati] ignored (${ev.reason}):`, JSON.stringify(payload).slice(0, 4000));
    return { ok: true, ignored: ev.reason };
  }

  if (ev.kind === "status") {
    const { error } = await admin.from("wa_messages").update({ status: ev.status })
      .eq("provider", "wati").in("provider_message_id", ev.ids);
    if (error) throw new Error("wa_messages status: " + error.message);
    return { ok: true, status: ev.status };
  }

  const links = await matchPhone(ev.row.phone_key);
  const { error } = await admin.from("wa_messages")
    .upsert({ ...ev.row, ...links, raw: payload }, { onConflict: "provider,provider_message_id", ignoreDuplicates: true });
  if (error) throw new Error("wa_messages insert: " + error.message);
  return { ok: true, direction: ev.row.direction, ...links };
}

/** The webhook: auth, parse, store. 200 on success, 500 so WATI retries a failure. */
export async function watiWebhook(req, res, raw) {
  if (req.method !== "POST") { res.status(405).end(); return; }
  if (!process.env.WATI_WEBHOOK_SECRET) { res.status(503).json({ error: "server not configured: WATI_WEBHOOK_SECRET" }); return; }
  if (!watiWebhookAuthOk(req)) { res.status(401).json({ error: "unauthorized" }); return; }
  if (!admin) { res.status(503).json({ error: "server not configured" }); return; }

  let body;
  try { body = JSON.parse(raw.toString("utf8")); } catch { res.status(400).json({ error: "bad json" }); return; }

  try {
    const events = Array.isArray(body) ? body.slice(0, 100) : [body];
    const results = [];
    for (const e of events) results.push(await ingestWatiEvent(e));
    res.status(200).json(Array.isArray(body) ? { ok: true, results } : results[0]);
  } catch (e) {
    console.error("[wati] webhook:", e);
    res.status(500).json({ error: "failed" });
  }
}
