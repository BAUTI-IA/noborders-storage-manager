// Google Apps Script — forwards EVERY email that lands in this Gmail inbox to
// the CRM Pipeline, where it becomes a lead (docs/pipeline.md → "Canal de mail").
//
// Install: script.google.com, logged in AS THE MAILBOX (e.g. the Workspace
// account) → New project → paste this file → fill CRM_URL and SECRET → run
// `install` once (it asks for Gmail permission and creates the 5-minute trigger).
//
// It walks the inbox by date, not by label: a checkpoint in Script Properties
// remembers the newest message already delivered, so each email is posted once.
// If the CRM answers with an error the checkpoint stops there and the next tick
// retries from that message on. Posting the same message twice is harmless
// anyway — the CRM dedupes on message_id.
//
// Emails that are not a job offer (newsletters, receipts, Google notices) are
// discarded by the CRM and listed under Pipeline → "Emails dropped today".

const CRM_URL = 'https://YOUR-APP.vercel.app/api/inbound-email';
const SECRET = 'THE_SECRET'; // same value as PIPELINE_INBOUND_SECRET in Vercel
const BACKFILL_HOURS = 0;    // >0 on the first run also sends the last N hours
const MAX_PER_RUN = 30;      // keeps one run well under Apps Script's 6-minute limit
const KEY = 'pipelineCheckpointMs';

function install() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'pushInbox')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('pushInbox').timeBased().everyMinutes(5).create();
  pushInbox();
}

function pushInbox() {
  const props = PropertiesService.getScriptProperties();
  let since = Number(props.getProperty(KEY) || 0);
  if (!since) {
    since = Date.now() - BACKFILL_HOURS * 3600 * 1000;
    props.setProperty(KEY, String(since));
  }
  const me = String(Session.getEffectiveUser().getEmail() || '').toLowerCase();

  // Gmail's after: is second-granular; the exact cut is made on getDate() below.
  const query = 'in:inbox after:' + Math.floor(since / 1000 - 60);
  const msgs = [];
  for (const thread of GmailApp.search(query, 0, 100)) {
    for (const msg of thread.getMessages()) {
      if (msg.getDate().getTime() <= since) continue;
      if (me && msg.getFrom().toLowerCase().indexOf(me) >= 0) continue; // our own replies
      msgs.push(msg);
    }
  }
  msgs.sort((a, b) => a.getDate() - b.getDate());

  for (const msg of msgs.slice(0, MAX_PER_RUN)) {
    const res = UrlFetchApp.fetch(CRM_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-pipeline-secret': SECRET },
      payload: JSON.stringify({
        from: msg.getFrom(),
        subject: msg.getSubject(),
        message_id: msg.getId(),
        text: msg.getPlainBody().slice(0, 40000),
      }),
      muteHttpExceptions: true,
    });
    if (res.getResponseCode() >= 400) {
      console.error(res.getResponseCode() + ' ' + res.getContentText());
      return; // checkpoint stays before this message: the next tick retries it
    }
    props.setProperty(KEY, String(msg.getDate().getTime()));
  }
}
