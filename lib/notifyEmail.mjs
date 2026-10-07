// Email copy of the notifications bell: when a teammate is tagged on a job
// note, they also get an email with the note and a link that opens the job.
// Sent through Resend (https://resend.com) with a plain fetch — no SDK.
//
// Called from api/admin-users.mjs (`action: "notify_email"`) right after the
// note's author inserted the notification rows. The author's browser only
// names the note (event_id); everything else is read here with the service
// role, and only rows that caller authored in the last few minutes and that
// were never emailed are sent — so a replayed call can't spam anyone.
//
// Env (Vercel project settings):
//   RESEND_API_KEY     - Resend API key. Unset → emails are skipped, the bell still works.
//   NOTIFY_EMAIL_FROM  - sender, e.g. "No Borders CRM <crm@yourdomain.com>" (domain verified in Resend).
//   APP_URL            - public CRM origin, for the "Open the job" link.

const cleanEnv = (v) => (v || "").trim().replace(/^["']+|["']+$/g, "");
export const emailConfig = () => ({
  apiKey: cleanEnv(process.env.RESEND_API_KEY),
  from: cleanEnv(process.env.NOTIFY_EMAIL_FROM),
});

// Only notifications this recent are emailed: the call comes right after the
// insert, so anything older is a replay, not a new tag.
export const EMAIL_WINDOW_MS = 15 * 60 * 1000;

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

// Subject, HTML and plain-text bodies for one mention. In English, like the
// team's other automated messages (the daily brief, the Customer Line alerts).
export function mentionEmail({ n, recipientName, appUrl }) {
  const who = n.from_name || "A teammate";
  const job = [n.job_number ? `Job ${n.job_number}` : null, n.customer].filter(Boolean).join(" · ");
  const params = new URLSearchParams();
  if (n.job_id != null) params.set("job", String(n.job_id));
  if (n.id != null) params.set("notif", String(n.id));
  const link = appUrl ? `${appUrl.replace(/\/+$/, "")}/?${params}` : "";
  const subject = `${who} tagged you${job ? ` · ${job}` : ""}`;
  const text = [
    `Hi${recipientName ? ` ${recipientName}` : ""},`,
    "",
    `${who} tagged you on a job note${job ? ` (${job})` : ""}:`,
    "",
    `"${n.body || ""}"`,
    "",
    link ? `Open the job: ${link}` : null,
    "",
    "— No Borders Operations CRM",
  ].filter((l) => l !== null).join("\n");
  const html = `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f6f6;font-family:-apple-system,system-ui,Segoe UI,Roboto,sans-serif;color:#111">
<div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #ececec;border-radius:12px;padding:24px">
  <div style="font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:#999;margin-bottom:14px">No Borders · Operations CRM</div>
  <div style="font-size:15px;line-height:1.5"><b>${esc(who)}</b> tagged you on a job note</div>
  ${job ? `<div style="font-size:13px;font-weight:600;color:#185FA5;margin-top:4px">${esc(job)}</div>` : ""}
  <div style="margin:16px 0;padding:12px 14px;background:#F7F4FE;border-left:3px solid #6D28D9;border-radius:6px;font-size:14px;line-height:1.5;white-space:pre-wrap">${esc(n.body)}</div>
  ${link ? `<a href="${esc(link)}" style="display:inline-block;background:#111;color:#fff;text-decoration:none;font-size:14px;font-weight:600;padding:10px 18px;border-radius:8px">Open the job</a>` : ""}
  <div style="font-size:11.5px;color:#aaa;margin-top:22px;line-height:1.5">You get this email because a teammate tagged you in the CRM. It is also in the 🔔 at the top of the menu.</div>
</div></body></html>`;
  return { subject, text, html };
}

async function sendResend({ apiKey, from, to, subject, html, text, idempotencyKey, fetchImpl }) {
  const res = await fetchImpl("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
    body: JSON.stringify({ from, to: [to], subject, html, text }),
  });
  if (!res.ok) throw new Error(`Resend ${res.status}: ${(await res.text()).slice(0, 300)}`);
}

// Give rows back so a later call can send them; a failure here is only logged
// (the worst case is a missed email, never a duplicate).
async function unclaim(db, ids) {
  const { error } = await db.from("notifications").update({ emailed_at: null }).in("id", ids);
  if (error) console.error("[notify_email] un-claiming", ids, error.message);
}

/**
 * Email every teammate tagged by `userId` on note `eventId` that wasn't
 * emailed yet. Rows are claimed (emailed_at stamped) before sending, so two
 * overlapping calls can't both send; a failed send un-claims its row.
 * Resolves { status, body } for the HTTP response.
 */
export async function emailMentionNotifications({ db, userId, eventId, appUrl, apiKey, from, fetchImpl = fetch, now = () => new Date() }) {
  if (!apiKey || !from) return { status: 200, body: { ok: true, skipped: "email not configured (RESEND_API_KEY / NOTIFY_EMAIL_FROM)" } };
  const ev = Number(eventId);
  if (!Number.isFinite(ev)) return { status: 400, body: { error: "Missing event_id." } };

  const stamp = now();
  const since = new Date(stamp.getTime() - EMAIL_WINDOW_MS).toISOString();
  const { data: rows, error } = await db.from("notifications")
    .update({ emailed_at: stamp.toISOString() })
    .eq("from_id", userId).eq("event_id", ev).is("emailed_at", null).gte("created_at", since)
    .select("*");
  if (error) return { status: 500, body: { error: error.message, code: error.code } };
  if (!rows?.length) return { status: 200, body: { ok: true, sent: 0 } };

  const { data: people, error: pErr } = await db.from("profiles").select("id, email, full_name, active").in("id", [...new Set(rows.map((r) => r.user_id))]);
  if (pErr) {
    await unclaim(db, rows.map((r) => r.id));
    return { status: 500, body: { error: pErr.message } };
  }
  const byId = new Map((people || []).map((p) => [p.id, p]));

  let sent = 0;
  const failed = [], skipped = [];
  for (const n of rows) {
    const p = byId.get(n.user_id);
    // An inactive or email-less profile keeps its bell notification; there is
    // just no one to email. The claim stays so it is never retried.
    if (!p || p.active === false || !p.email) { skipped.push(n.id); continue; }
    const mail = mentionEmail({ n, recipientName: (p.full_name || "").trim().split(/\s+/)[0] || "", appUrl });
    try {
      await sendResend({ apiKey, from, to: p.email, ...mail, idempotencyKey: `crm-notification-${n.id}`, fetchImpl });
      sent++;
    } catch (e) {
      console.error("[notify_email]", n.id, e?.message || e);
      failed.push(n.id);
    }
  }
  if (failed.length) await unclaim(db, failed);
  return { status: 200, body: { ok: failed.length === 0, sent, failed: failed.length, skipped: skipped.length } };
}
