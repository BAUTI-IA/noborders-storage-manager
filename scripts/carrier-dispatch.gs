/**
 * No Borders CRM — the dispatch@ mailbox (docs/carrier-dispatch.md).
 *
 * Runs every 5 minutes inside the dispatch@ Gmail / Google Workspace account:
 *   1. sendOutbox(): asks the CRM for the dispatch emails waiting to go out,
 *      sends each one from this mailbox (Reply-To dispatch+cd<ID>@…, so the
 *      carrier's answer comes back tagged with its dispatch) with the rate
 *      confirmation PDF attached, and tells the CRM it went out.
 *   2. readInbox(): hands every new email in this inbox to the CRM. Attachments
 *      go straight to the CRM's private storage through one-time upload links;
 *      then the CRM reads them with AI and puts them in "Docs to review".
 *
 * Install (once), logged in AS dispatch@:
 *   1. script.google.com → New project → paste this file.
 *   2. Fill CRM_URL and SECRET below (SECRET = CARRIER_MAIL_SECRET in Vercel).
 *   3. Run install() once and accept the permissions (Gmail + external requests).
 * To test by hand, run run().
 */
const CRM_URL = 'https://YOUR-APP.vercel.app/api/carrier-mail';
const SECRET = 'THE_SECRET';

const SENDER_NAME = 'No Borders Dispatch';
const DONE_LABEL = 'crm/carriers';      // put on threads the CRM already has
const KEY = 'carrierInboxCheckpointMs'; // last email handed to the CRM
const BACKFILL_HOURS = 24;              // first run: look this far back
const MAX_PER_RUN = 15;

function install() {
  ScriptApp.getProjectTriggers()
    .filter(function (t) { return t.getHandlerFunction() === 'run'; })
    .forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(5).create();
  run();
}

function run() {
  sendOutbox();
  readInbox();
}

// ── CRM calls ────────────────────────────────────────────────────────────────

function api_(method, payload) {
  const opts = { method: method, muteHttpExceptions: true, headers: { 'x-carrier-secret': SECRET } };
  if (payload) { opts.contentType = 'application/json'; opts.payload = JSON.stringify(payload); }
  const res = UrlFetchApp.fetch(CRM_URL, opts);
  const code = res.getResponseCode();
  let body = {};
  try { body = JSON.parse(res.getContentText() || '{}'); } catch (e) { body = { error: res.getContentText() }; }
  // A wrong secret or a missing server setting will not fix itself: fail loudly
  // so Google emails the error to this account.
  if (code === 401 || code === 503) throw new Error('CRM refused the request (' + code + '): ' + (body.error || ''));
  return { code: code, body: body };
}

// ── 1. Outbox ────────────────────────────────────────────────────────────────

function sendOutbox() {
  const me = Session.getEffectiveUser().getEmail();
  const r = api_('get');
  if (r.code !== 200) { console.warn('outbox', r.code, JSON.stringify(r.body)); return; }
  (r.body.messages || []).forEach(function (m) {
    try {
      const attachments = (m.attachments || []).map(function (a) {
        return UrlFetchApp.fetch(a.url).getBlob().setName(a.name);
      });
      const draft = GmailApp.createDraft(m.to, m.subject, m.text || '', {
        htmlBody: m.html || undefined,
        name: SENDER_NAME,
        replyTo: replyTo_(me, m.dispatch_id),
        attachments: attachments,
      });
      const sent = draft.send();
      api_('post', { step: 'ack', id: m.id, from: me, gmail_message_id: sent.getId(), gmail_thread_id: sent.getThread().getId() });
    } catch (e) {
      api_('post', { step: 'ack', id: m.id, ok: false, error: String((e && e.message) || e) });
    }
  });
}

// dispatch@nobordersmoving.com + 57 → dispatch+cd57@nobordersmoving.com
function replyTo_(me, dispatchId) {
  const at = me.indexOf('@');
  if (!dispatchId || at < 0) return me;
  return me.slice(0, at).split('+')[0] + '+cd' + dispatchId + me.slice(at);
}

// ── 2. Inbox ─────────────────────────────────────────────────────────────────

function readInbox() {
  const props = PropertiesService.getScriptProperties();
  const since = Number(props.getProperty(KEY) || (Date.now() - BACKFILL_HOURS * 3600 * 1000));
  const me = Session.getEffectiveUser().getEmail().toLowerCase();
  const label = GmailApp.getUserLabelByName(DONE_LABEL) || GmailApp.createLabel(DONE_LABEL);

  const msgs = [];
  GmailApp.search('in:inbox after:' + Math.floor(since / 1000 - 60), 0, 50).forEach(function (thread) {
    thread.getMessages().forEach(function (msg) {
      if (msg.getDate().getTime() <= since) return;
      if (msg.getFrom().toLowerCase().indexOf(me) >= 0) return; // our own dispatch emails
      msgs.push(msg);
    });
  });
  msgs.sort(function (a, b) { return a.getDate().getTime() - b.getDate().getTime(); });

  for (let i = 0; i < Math.min(msgs.length, MAX_PER_RUN); i++) {
    const msg = msgs[i];
    // On any failure stop here: the checkpoint stays before this email, so the
    // next run retries it (the CRM ignores an email it already has).
    if (!pushMessage_(msg)) return;
    props.setProperty(KEY, String(msg.getDate().getTime()));
    msg.getThread().addLabel(label);
  }
}

function pushMessage_(msg) {
  // Inline images are mostly signature logos; photos come as real attachments.
  const atts = msg.getAttachments({ includeInlineImages: false, includeAttachments: true });
  const r = api_('post', {
    step: 'message',
    from: msg.getFrom(),
    to: msg.getTo(),
    cc: msg.getCc(),
    subject: msg.getSubject(),
    text: msg.getPlainBody().slice(0, 20000),
    message_id: msg.getId(),
    thread_id: msg.getThread().getId(),
    date: msg.getDate().toISOString(),
    attachments: atts.map(function (a) { return { name: a.getName(), mime: a.getContentType(), size: a.getSize() }; }),
  });
  if (r.code >= 400) { console.warn('message', r.code, JSON.stringify(r.body)); return false; }
  if (r.body.status !== 'receiving') return true; // ignored sender, duplicate, or an ACCEPT reply

  const uploads = r.body.uploads || [];
  for (let i = 0; i < uploads.length; i++) {
    const a = atts[uploads[i].index];
    const put = UrlFetchApp.fetch(uploads[i].url, {
      method: 'put',
      contentType: a.getContentType(),
      payload: a.getBytes(),
      headers: { 'x-upsert': 'true' },
      muteHttpExceptions: true,
    });
    if (put.getResponseCode() >= 300) { console.warn('upload', put.getResponseCode(), put.getContentText()); return false; }
  }
  const f = api_('post', { step: 'finalize', id: r.body.id });
  if (f.code >= 400) { console.warn('finalize', f.code, JSON.stringify(f.body)); return false; }
  return true;
}
