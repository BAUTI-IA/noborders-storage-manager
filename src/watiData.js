// WhatsApp (WATI Coexistence) — pure parsing and phone matching.
//
// WATI posts one JSON event per WhatsApp happening: a customer message, a reply
// the team sent (from WATI, from the API, or — with Coexistence — from the
// WhatsApp Business app on the phone), or a delivery/read status. This module
// turns that payload into the row we store, and knows how two differently
// written phone numbers are "the same".
//
// WATI does not publish a strict schema and Coexistence echoes are new, so the
// parser is deliberately tolerant: it reads the fields WATI is known to send,
// falls back quietly, and the webhook stores the raw payload next to the parsed
// row so anything misread can be reprocessed later.
//
// No React, no I/O, no imports: lib/wati.mjs runs this on the server and the
// CRM screens can import it too.
//
// Tests: scripts/test-wati-data.mjs (npm test)

export const MAX_BODY = 10000;

const digits = (v) => String(v == null ? "" : v).replace(/\D/g, "");

/** "+15551234567" from a WATI waId ("15551234567") or any formatted number. */
export function toE164(v) {
  const d = digits(v);
  return d.length >= 7 && d.length <= 15 ? "+" + d : null;
}

/**
 * The key two phone numbers are compared by: the last 10 digits (or all of
 * them, for shorter numbers). CRM phones are free text — "(305) 555-1234",
 * "+1 305 555 1234", "3055551234" — and WhatsApp sends country code + number,
 * so comparing the tail is what makes them meet. It also absorbs the extra 9
 * WhatsApp puts in Argentine mobiles (549 11… vs 54 11…), which sits before
 * the last 10 digits. MUST match public.wa_phone_key() in scripts/setup-wati.sql.
 */
export function phoneKey(v) {
  const d = digits(v);
  if (d.length >= 10) return d.slice(-10);
  return d.length >= 7 ? d : null;
}

/** Unix seconds or ms (string or number), or an ISO date → ISO string. */
export function toISO(ts, fallback) {
  const n = Number(ts);
  if (ts != null && ts !== "" && Number.isFinite(n) && n > 0) {
    return new Date(n < 1e12 ? n * 1000 : n).toISOString();
  }
  if (fallback) {
    const d = new Date(fallback);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return null;
}

const STATUS_EVENT = /^sentMessage(DELIVERED|READ|REPLIED|FAILED|SENT)/i;
const API_SENT_EVENT = /template|session|broadcast/i;

/**
 * Who sent it:
 *   inbound      — the customer / broker / driver wrote to us
 *   outbound_api — sent through WATI (Team Inbox, API, template, broadcast)
 *   outbound_app — sent from the WhatsApp Business app on the phone and echoed
 *                  to WATI by Coexistence
 */
export function directionOf(p) {
  if (API_SENT_EVENT.test(String(p?.eventType || ""))) return "outbound_api";
  if (p?.owner === true || p?.owner === "true") return "outbound_app";
  return "inbound";
}

/**
 * One WATI webhook payload → what to do with it:
 *   { kind: "message", row }         — store it
 *   { kind: "status", ids, status }  — update an already-stored message
 *   { kind: "ignore", reason }       — nothing we can use
 */
export function parseWatiEvent(p) {
  if (!p || typeof p !== "object" || Array.isArray(p)) return { kind: "ignore", reason: "not_an_object" };
  const eventType = String(p.eventType || "");

  const ids = [p.whatsappMessageId, p.id, p.localMessageId]
    .map((v) => (v == null ? "" : String(v).trim())).filter(Boolean);

  const st = eventType.match(STATUS_EVENT);
  if (st) {
    if (!ids.length) return { kind: "ignore", reason: "status_without_id" };
    return { kind: "status", ids, status: st[1].toLowerCase() };
  }

  const phone = toE164(p.waId ?? p.whatsappNumber ?? p.phone);
  if (!phone) return { kind: "ignore", reason: "no_phone" };
  if (!ids.length) return { kind: "ignore", reason: "no_message_id" };

  const type = String(p.type || "text").toLowerCase();
  const body = [p.text, p.finalText, p.caption].find((v) => typeof v === "string" && v.trim()) || "";
  const media = type !== "text" ? [p.data, p.mediaUrl, p.url].find((v) => typeof v === "string" && /^https?:\/\//i.test(v)) : null;

  return {
    kind: "message",
    row: {
      provider: "wati",
      provider_message_id: ids[0],
      event_type: eventType || null,
      direction: directionOf(p),
      phone,
      phone_key: phoneKey(phone),
      contact_name: String(p.senderName || p.contactName || "").trim().slice(0, 200) || null,
      msg_type: type.slice(0, 40),
      body: body ? body.slice(0, MAX_BODY) : null,
      media_url: media || null,
      status: p.statusString ? String(p.statusString).toLowerCase().slice(0, 40) : null,
      sent_at: toISO(p.timestamp, p.created) || new Date().toISOString(),
    },
  };
}

/**
 * Which CRM rows a phone belongs to, from the wa_match_phone() rows
 * ({ kind, id, done }). One of each kind; for jobs, an open one beats a
 * delivered one and a newer one beats an older one.
 */
export function pickMatches(rows) {
  const out = { broker_id: null, driver_id: null, job_id: null };
  const of = (k) => (rows || []).filter((r) => r && r.kind === k && r.id != null);
  const first = (k) => of(k).sort((a, b) => Number(a.id) - Number(b.id))[0];
  out.broker_id = first("broker")?.id ?? null;
  out.driver_id = first("driver")?.id ?? null;
  const jobs = of("job").sort((a, b) => (!!a.done - !!b.done) || Number(b.id) - Number(a.id));
  out.job_id = jobs[0]?.id ?? null;
  return out;
}
