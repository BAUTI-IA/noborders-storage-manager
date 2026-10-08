// Google Apps Script — sends the CRM's daily bank email from this Gmail account
// (docs/bank-feed.md → "El email diario").
//
// Every morning it asks the CRM for the summary (GET /api/bank-digest). That
// call first syncs the bank, then answers with the recipients, subject and
// body; this script sends it with Gmail and confirms (POST /api/bank-digest),
// so the next email starts after the lines this one listed. If the send fails,
// nothing is confirmed and tomorrow's email repeats them — nothing is lost.
//
// Install: script.google.com, logged in AS THE ACCOUNT THAT SENDS (e.g. the
// Workspace account) → New project → paste this file → fill CRM_URL and SECRET
// → run `install` once (it asks for permission to send email and to call the
// CRM, and creates the daily trigger). `sendBankDigest` can be run by hand
// any time to test it. Who receives it is set in the CRM: Bancos → Accounts.
//
// If a run fails, Google emails the failure to this account (Apps Script's
// default notification), so a broken connection is never silent.

const CRM_URL = 'https://YOUR-APP.vercel.app/api/bank-digest';
const SECRET = 'THE_SECRET'; // same value as BANK_DIGEST_SECRET in Vercel
const HOUR = 8;              // runs between 8 and 9 AM, New York time
const TZ = 'America/New_York';

function install() {
  ScriptApp.getProjectTriggers()
    .filter((t) => t.getHandlerFunction() === 'sendBankDigest')
    .forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('sendBankDigest').timeBased().everyDays(1).atHour(HOUR).inTimezone(TZ).create();
  console.log('Daily trigger created: every day ' + HOUR + ':00–' + (HOUR + 1) + ':00 ' + TZ);
}

function sendBankDigest() {
  const digest = fetchDigest();
  if (digest.skip === 'disabled') { console.log('The daily email is turned off in the CRM.'); return; }
  if (digest.skip === 'no_linked_accounts') { console.log('No bank account is linked yet: Bancos → Accounts → Connect bank.'); return; }
  if (digest.skip === 'no_recipients') {
    throw new Error('Nobody is set to receive the bank email. Add the emails in the CRM: Bancos → Accounts → Daily email.');
  }
  MailApp.sendEmail({
    to: digest.to.join(','),
    subject: digest.subject,
    htmlBody: digest.html,
    body: digest.text,
    name: 'No Borders CRM',
  });
  const ack = UrlFetchApp.fetch(CRM_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-digest-secret': SECRET },
    payload: JSON.stringify({ ack: digest.ack }),
    muteHttpExceptions: true,
  });
  // The email is out either way; a failed confirmation only means tomorrow's
  // repeats today's lines.
  if (ack.getResponseCode() !== 200) console.warn('Sent, but the CRM did not confirm: ' + ack.getContentText().slice(0, 300));
  console.log('Sent to ' + digest.to.length + ' recipient(s): ' + digest.subject);
}

// The CRM syncs the bank inside this call, which can take a while; one retry
// covers a slow morning (the second call finds the lines already imported).
function fetchDigest() {
  let last = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const res = UrlFetchApp.fetch(CRM_URL, { method: 'get', headers: { 'x-digest-secret': SECRET }, muteHttpExceptions: true });
      if (res.getResponseCode() === 200) return JSON.parse(res.getContentText());
      last = 'CRM ' + res.getResponseCode() + ': ' + res.getContentText().slice(0, 300);
      if (res.getResponseCode() === 401 || res.getResponseCode() === 503) break; // config, not luck
    } catch (e) {
      last = String(e);
    }
    if (attempt < 2) Utilities.sleep(20000);
  }
  throw new Error('Could not get the bank email from the CRM — ' + last);
}
