// Bank feed (Chase → Plaid → Bancos) and the daily bank email — the pure half.
//
// Plaid (plaid.com) reads the company's bank accounts, connected once from
// Bancos → Accounts: the person signs in on Chase's own page (OAuth) and picks
// which accounts to share. Every morning the CRM pulls the new POSTED
// transactions into bank_transactions as `unreviewed` (they still go through
// categorize → verify like any other line) and builds the daily summary email
// that scripts/bank-digest-email.gs sends from Gmail.
//
// Everything here is pure so scripts/test-bank-feed-data.mjs can run it with
// node; the I/O (Plaid's API, Supabase) lives in lib/bankFeed.mjs and the
// endpoint is api/bank-analyze.mjs (docs/bank-feed.md).
import { dedupHash } from "./bankData.js";
import { numv } from "./analyticsData.js";

export const FEED_SOURCE = "plaid";
export const MAX_RECIPIENTS = 10;
export const DIGEST_LIST_CAP = 150;
export const DIGEST_TZ = "America/New_York";

// One-time migration, shown in the Bancos setup banner and run by
// scripts/setup-bank-feed.mjs. Re-runnable, and safe on a database where the
// first (Teller) version of this table was already created.
export const BANK_FEED_SQL = `-- Bank feed (Plaid) + daily bank email (docs/bank-feed.md). Re-runnable.
create table if not exists public.bank_feed_connections (
  id bigint generated always as identity primary key,
  provider text not null default 'plaid',
  item_id text,
  access_token text not null,
  sync_cursor text,
  institution text,
  accounts jsonb default '[]'::jsonb,
  status text default 'active',
  last_error text,
  last_sync_at timestamptz,
  created_by text,
  created_at timestamptz default now(),
  updated_at timestamptz
);
alter table public.bank_feed_connections add column if not exists item_id text;
alter table public.bank_feed_connections add column if not exists sync_cursor text;
alter table public.bank_feed_connections alter column provider set default 'plaid';
do $$ begin alter table public.bank_feed_connections alter column enrollment_id drop not null; exception when undefined_column then null; end $$;
create unique index if not exists bank_feed_connections_item on public.bank_feed_connections(item_id);
-- The access token reads the bank: no policy at all, so only the service role
-- (api/bank-analyze.mjs) can touch this table. Never add it to TABLE_ACL.
alter table public.bank_feed_connections enable row level security;
revoke all on public.bank_feed_connections from anon, authenticated;

create table if not exists public.bank_digest_settings (
  id int primary key default 1 check (id = 1),
  recipients text default '',
  lang text default 'en',
  enabled boolean default true,
  last_sent_txn_id bigint,
  last_sent_at timestamptz,
  updated_by text,
  updated_at timestamptz
);
insert into public.bank_digest_settings (id) values (1) on conflict (id) do nothing;
alter table public.bank_digest_settings enable row level security;
revoke all on public.bank_digest_settings from anon, authenticated;

alter table public.bank_accounts add column if not exists feed_connection_id bigint references public.bank_feed_connections(id) on delete set null;
alter table public.bank_accounts add column if not exists feed_account_id text;
alter table public.bank_accounts add column if not exists feed_since date;
alter table public.bank_accounts add column if not exists feed_ledger numeric;
alter table public.bank_accounts add column if not exists feed_balance_at date;
create unique index if not exists bank_accounts_feed_account on public.bank_accounts(feed_account_id) where feed_account_id is not null;`;

const round2 = (v) => Math.round(numv(v) * 100) / 100;
export const todayInTz = (now = new Date()) => now.toLocaleDateString("en-CA", { timeZone: DIGEST_TZ });

// ── Plaid → the CRM's shapes ─────────────────────────────────────────────────
// Plaid's sign is the opposite of the ledger's: "Positive values when money
// moves out of the account; negative values when money moves in" (Plaid docs,
// Transaction.amount). bank_transactions.amount is negative for money out.
export const ledgerAmount = (plaidAmount) => round2(-numv(plaidAmount));

// A Plaid transaction as the importer sees it. The description is the bank's
// own text (original_description, the line as it reads on Chase), so it lines
// up with what a screenshot or CSV of the same line said.
export const fromPlaidTxn = (t) => ({
  id: String(t.transaction_id),
  account_id: t.account_id,
  date: t.date,
  amount: ledgerAmount(t.amount),
  description: String(t.original_description || t.name || "").trim(),
  counterparty: t.merchant_name || null,
  pending: !!t.pending,
});

// What the panel keeps of a Plaid account — never the account number (Plaid
// only gives the last digits, as `mask`).
export const fromPlaidAccount = (a, institution = "") => ({
  id: a.account_id, name: a.name || a.official_name || "", last_four: a.mask || "",
  type: a.type, subtype: a.subtype || "", institution: { name: institution || "" },
});

// Cards are left out for now: the panel would show what is owed as a
// "balance", and nobody asked for them yet.
export const isFeedSupported = (a) => a?.type === "depository";
export const newAccountName = (a) => [a?.institution?.name, a?.name].filter(Boolean).join(" ").trim() || "Bank account";
export const feedAccountLabel = (a) => newAccountName(a) + (a?.last_four ? ` ····${a.last_four}` : "");
export const crmTypeOf = (a) => (a?.type === "credit" ? "credit_card" : a?.subtype === "savings" ? "savings" : "checking");

// For each bank account, which CRM account it feeds. An existing link wins;
// otherwise the active CRM account with the same last 4 digits; otherwise a
// new account (checking/savings) or "don't import" (cards). The person
// confirms the proposal before anything is imported.
//   -> [{ feed_account_id, label, last_four, supported, bank_account_id: id | "new" | "", since, linked }]
export function proposeLinks(feedAccounts = [], crmAccounts = [], today = todayInTz()) {
  const used = new Set();
  const out = feedAccounts.map((fa) => {
    const linked = crmAccounts.find((c) => c.feed_account_id && c.feed_account_id === fa.id);
    if (linked) used.add(linked.id);
    return { fa, linked };
  });
  return out.map(({ fa, linked }) => {
    const base = {
      feed_account_id: fa.id, label: feedAccountLabel(fa), last_four: fa.last_four || "",
      supported: isFeedSupported(fa), since: today, linked: !!linked,
    };
    if (linked) return { ...base, bank_account_id: linked.id, since: linked.feed_since || today };
    if (!base.supported) return { ...base, bank_account_id: "" };
    const match = fa.last_four && crmAccounts.find((c) =>
      !used.has(c.id) && !c.feed_account_id && c.active !== false && String(c.account_last4 || "").trim() === fa.last_four);
    if (match) { used.add(match.id); return { ...base, bank_account_id: match.id }; }
    return { ...base, bank_account_id: "new" };
  });
}

// Turn one account's transactions (fromPlaidTxn shape) into bank_transactions rows.
//   existing: rows already in the table for this account and date range,
//             as { dedup_hash, source, source_ref }.
// Rules:
//   · only POSTED lines: a pending one can still change or vanish, and when it
//     posts Plaid sends it again as a new posted transaction;
//   · nothing dated before the account's import start (feed_since);
//   · a Plaid id already imported is skipped (re-syncs are idempotent);
//   · a line that matches a screenshot/CSV/manual row (same account, date,
//     amount and description) is that row — skipped, one match per row;
//   · two identical lines on the same day are both real (two $50 fills at the
//     same station): the second one gets a hash suffixed with its Plaid id.
export function planFeedImport({ txns = [], account, existing = [] }) {
  const since = account?.feed_since || "";
  const taken = new Map(existing.map((r) => [r.dedup_hash, r]));
  const knownRefs = new Set(existing.filter((r) => r.source === FEED_SOURCE).map((r) => String(r.source_ref)));
  const consumed = new Set();
  const rows = [];
  const skipped = { pending: 0, before_since: 0, already: 0, duplicate: 0 };
  // Oldest first, so an identical pair is numbered the same way on every sync.
  const list = [...txns].sort((a, b) => String(a.date || "").localeCompare(String(b.date || "")) || String(a.id).localeCompare(String(b.id)));
  for (const t of list) {
    if (t.pending) { skipped.pending++; continue; }
    if (!t.date || (since && t.date < since)) { skipped.before_since++; continue; }
    const ref = String(t.id);
    if (knownRefs.has(ref)) { skipped.already++; continue; }
    const amount = round2(t.amount);
    const h = dedupHash({ bank_account_id: account.id, txn_date: t.date, amount, raw_description: t.description || "" });
    const ex = taken.get(h);
    if (ex && ex.source !== FEED_SOURCE && !consumed.has(h)) { consumed.add(h); skipped.duplicate++; continue; }
    const hash = taken.has(h) ? `${h}|${FEED_SOURCE}:${ref}` : h;
    taken.set(hash, { dedup_hash: hash, source: FEED_SOURCE, source_ref: ref });
    knownRefs.add(ref);
    rows.push({
      bank_account_id: account.id, txn_date: t.date, amount, direction: amount < 0 ? "out" : "in", currency: "USD",
      raw_description: t.description || null, counterparty: t.counterparty || null,
      status: "unreviewed", source: FEED_SOURCE, source_ref: ref, dedup_hash: hash,
    });
  }
  return { rows, skipped };
}

// ── Daily email ──────────────────────────────────────────────────────────────
const EMAIL_RE = /^[^\s@,;<>"']+@[^\s@,;<>"']+\.[a-z]{2,}$/i;
export function parseRecipients(input) {
  const parts = String(input || "").split(/[\s,;]+/).map((p) => p.trim().toLowerCase()).filter(Boolean);
  const valid = [], invalid = [];
  for (const p of parts) {
    if (!EMAIL_RE.test(p)) invalid.push(p);
    else if (!valid.includes(p)) valid.push(p);
  }
  return { valid: valid.slice(0, MAX_RECIPIENTS), invalid, tooMany: valid.length > MAX_RECIPIENTS };
}

// Problems the sync ran into, as one sentence each (email and Bancos panel).
//   kind: disconnected | error | missing_account | not_configured
export function problemText(p, lang = "en") {
  const L = (en, es) => (lang === "es" ? es : en);
  const who = p.label || L("Bank connection", "Conexión bancaria");
  if (p.kind === "disconnected") return L(`${who}: the bank asks to sign in again. Open Bancos → Accounts and press Reconnect.`, `${who}: el banco pide volver a iniciar sesión. Entrá a Bancos → Cuentas y tocá Reconectar.`);
  if (p.kind === "missing_account") return L(`${who}: this account is no longer shared by the bank connection.`, `${who}: esta cuenta ya no está en la conexión con el banco.`);
  if (p.kind === "not_configured") return L(`The bank feed is not configured on the server (missing ${p.detail}).`, `La conexión bancaria no está configurada en el servidor (falta ${p.detail}).`);
  return L(`${who}: the sync failed (${p.detail || "unknown error"}).`, `${who}: falló la sincronización (${p.detail || "error desconocido"}).`);
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
export const money = (v) => {
  const n = round2(v);
  return (n < 0 ? "−$" : "$") + Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
};

// Builds the email from what landed in the ledger since the last one.
//   accounts: the CRM accounts the feed fills (name, account_last4, bank_name,
//             feed_ledger, feed_balance_at)
//   txns:     bank_transactions rows with id > last_sent_txn_id
//   -> { subject, html, text, count, ackId, totals: { in, out } }
// ackId is the highest row id included: once the email is out, the next one
// starts after it — nothing is repeated and nothing is skipped, whatever the
// day the bank posted it.
export function buildDigest({
  accounts = [], txns = [], unreviewed = 0, problems = [], since = null,
  now = new Date(), lang = "en", appUrl = "", cap = DIGEST_LIST_CAP,
}) {
  const L = (en, es) => (lang === "es" ? es : en);
  const locale = lang === "es" ? "es-AR" : "en-US";
  const day = (iso) => (iso ? new Date(iso + "T12:00:00Z").toLocaleDateString(locale, { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" }) : "—");
  const stamp = (ts) => new Date(ts).toLocaleString(locale, { timeZone: DIGEST_TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const today = new Date(now).toLocaleDateString(locale, { timeZone: DIGEST_TZ, weekday: "short", month: "short", day: "numeric" });

  const acctName = (a) => (a?.name || L("Account", "Cuenta")) + (a?.account_last4 ? ` ····${a.account_last4}` : "");
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const per = new Map(accounts.map((a) => [a.id, { in: 0, out: 0, count: 0 }]));
  const totals = { in: 0, out: 0 };
  let ackId = null;
  for (const t of txns) {
    const amt = round2(t.amount);
    const s = per.get(t.bank_account_id) || { in: 0, out: 0, count: 0 };
    if (amt >= 0) { s.in += amt; totals.in += amt; } else { s.out += -amt; totals.out += -amt; }
    s.count++;
    per.set(t.bank_account_id, s);
    if (Number.isFinite(Number(t.id)) && (ackId == null || Number(t.id) > ackId)) ackId = Number(t.id);
  }
  totals.in = round2(totals.in); totals.out = round2(totals.out);

  const banks = [...new Set(accounts.map((a) => (a.bank_name || "").trim()).filter(Boolean))];
  const bank = banks.length === 1 ? banks[0] : L("Bank", "Banco");
  const count = txns.length;
  const countLabel = count === 1 ? L("1 new transaction", "1 movimiento nuevo") : `${count} ${L("new transactions", "movimientos nuevos")}`;
  const subject = (problems.length ? "⚠ " : "") + `${bank} · ${today}: ` + (count
    ? `${countLabel} · ${L("in", "entró")} ${money(totals.in)} · ${L("out", "salió")} ${money(totals.out)}`
    : L("no new transactions", "sin movimientos nuevos"));
  const sinceLabel = since ? `${L("New since", "Nuevo desde")} ${stamp(since)}` : L("First summary", "Primer resumen");

  const sorted = [...txns].sort((a, b) => String(b.txn_date || "").localeCompare(String(a.txn_date || "")) || Number(b.id) - Number(a.id));
  const shown = sorted.slice(0, cap);
  const more = sorted.length - shown.length;
  const balanceOf = (a) => (a.feed_ledger != null && a.feed_ledger !== "" ? `${money(a.feed_ledger)} (${day(a.feed_balance_at)})` : "—");
  const allBalances = accounts.length > 0 && accounts.every((a) => a.feed_ledger != null && a.feed_ledger !== "");
  const totalBalance = allBalances ? money(accounts.reduce((s, a) => s + numv(a.feed_ledger), 0)) : "";
  const problemLines = problems.map((p) => problemText(p, lang));
  const reviewLine = unreviewed
    ? `${unreviewed} ${unreviewed === 1 ? L("transaction is", "movimiento está") : L("transactions are", "movimientos están")} ${L("waiting for review in Bancos → Inbox.", "esperando revisión en Bancos → Bandeja.")}`
    : L("Nothing waiting for review in Bancos → Inbox.", "No hay nada esperando revisión en Bancos → Bandeja.");
  const moreLine = more > 0 ? `${L("…and", "…y")} ${more} ${L("more in the CRM.", "más en el CRM.")}` : "";
  const link = String(appUrl || "").replace(/\/+$/, "");

  // ── HTML (inline styles: email clients drop <style> blocks) ────────────────
  const cell = "padding:7px 8px;border-bottom:1px solid #eee;font-size:13px;vertical-align:top";
  const head = "padding:7px 8px;border-bottom:2px solid #ddd;font-size:11px;color:#888;text-align:left;text-transform:uppercase;letter-spacing:.04em";
  const num = cell + ";text-align:right;white-space:nowrap";
  const amtColor = (v) => (v < 0 ? "#A32D2D" : "#3B6D11");
  const html = [
    `<div style="font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;color:#111;max-width:720px;margin:0 auto">`,
    `<h2 style="margin:0 0 4px;font-size:19px">${esc(L("Daily bank summary", "Resumen bancario diario"))} · ${esc(bank)}</h2>`,
    `<div style="color:#777;font-size:13px;margin-bottom:16px">${esc(today)} · ${esc(sinceLabel)}</div>`,
    problemLines.length ? `<div style="background:#FCEBEB;color:#A32D2D;border-radius:8px;padding:10px 12px;font-size:13px;margin-bottom:14px">${problemLines.map((l) => `⚠ ${esc(l)}`).join("<br>")}</div>` : "",
    `<table style="width:100%;border-collapse:collapse;margin-bottom:18px"><thead><tr>`,
    `<th style="${head}">${esc(L("Account", "Cuenta"))}</th><th style="${head};text-align:right">${esc(L("In", "Entró"))}</th><th style="${head};text-align:right">${esc(L("Out", "Salió"))}</th><th style="${head};text-align:right">${esc(L("Bank balance", "Saldo del banco"))}</th>`,
    `</tr></thead><tbody>`,
    ...accounts.map((a) => {
      const s = per.get(a.id) || { in: 0, out: 0, count: 0 };
      return `<tr><td style="${cell};font-weight:600">${esc(acctName(a))}</td><td style="${num};color:#3B6D11">${money(s.in)}</td><td style="${num};color:#A32D2D">${money(-s.out)}</td><td style="${num}">${esc(balanceOf(a))}</td></tr>`;
    }),
    `<tr><td style="${cell};font-weight:700">${esc(L("Total", "Total"))}</td><td style="${num};font-weight:700;color:#3B6D11">${money(totals.in)}</td><td style="${num};font-weight:700;color:#A32D2D">${money(-totals.out)}</td><td style="${num};font-weight:700">${esc(totalBalance)}</td></tr>`,
    `</tbody></table>`,
    count
      ? [
        `<h3 style="font-size:15px;margin:0 0 6px">${esc(L("Transactions", "Movimientos"))} (${count})</h3>`,
        `<table style="width:100%;border-collapse:collapse"><thead><tr>`,
        `<th style="${head}">${esc(L("Date", "Fecha"))}</th><th style="${head}">${esc(L("Account", "Cuenta"))}</th><th style="${head}">${esc(L("Description", "Descripción"))}</th><th style="${head};text-align:right">${esc(L("Amount", "Monto"))}</th><th style="${head}">${esc(L("Category", "Categoría"))}</th>`,
        `</tr></thead><tbody>`,
        ...shown.map((t) => {
          const amt = round2(t.amount);
          const a = byId.get(t.bank_account_id);
          return `<tr><td style="${cell};white-space:nowrap">${esc(day(t.txn_date))}</td><td style="${cell};color:#666">${esc(a?.account_last4 ? "····" + a.account_last4 : a?.name || "")}</td><td style="${cell}">${esc(t.raw_description || "")}</td><td style="${num};font-weight:700;color:${amtColor(amt)}">${money(amt)}</td><td style="${cell};color:#666">${esc(t.category || "—")}</td></tr>`;
        }),
        `</tbody></table>`,
        moreLine ? `<div style="font-size:12px;color:#777;margin-top:6px">${esc(moreLine)}</div>` : "",
      ].join("")
      : `<div style="font-size:13px;color:#555">${esc(L("No new transactions since the last summary.", "No hubo movimientos nuevos desde el último resumen."))}</div>`,
    `<p style="font-size:13px;margin:18px 0 6px">${esc(reviewLine)}${link ? ` <a href="${esc(link)}" style="color:#185FA5">${esc(L("Open the CRM", "Abrir el CRM"))}</a>` : ""}</p>`,
    `<p style="font-size:11px;color:#999;margin:0">${esc(L("Sent by the CRM. Transactions come from the bank connection and land in Bancos as unreviewed: categories are suggestions until someone verifies them.", "Lo manda el CRM. Los movimientos llegan por la conexión con el banco y entran a Bancos sin revisar: las categorías son sugerencias hasta que alguien las verifica."))}</p>`,
    `</div>`,
  ].join("");

  // ── Plain text (clients that block HTML, and the notification preview) ─────
  const text = [
    `${L("Daily bank summary", "Resumen bancario diario")} · ${bank} · ${today}`,
    sinceLabel,
    ...problemLines.map((l) => `⚠ ${l}`),
    "",
    ...accounts.map((a) => {
      const s = per.get(a.id) || { in: 0, out: 0 };
      return `${acctName(a)}: ${L("in", "entró")} ${money(s.in)} · ${L("out", "salió")} ${money(-s.out)} · ${L("balance", "saldo")} ${balanceOf(a)}`;
    }),
    `${L("Total", "Total")}: ${L("in", "entró")} ${money(totals.in)} · ${L("out", "salió")} ${money(-totals.out)}${totalBalance ? ` · ${L("balance", "saldo")} ${totalBalance}` : ""}`,
    "",
    ...(count
      ? shown.map((t) => {
        const a = byId.get(t.bank_account_id);
        return `${day(t.txn_date)}  ${a?.account_last4 ? "····" + a.account_last4 : ""}  ${money(t.amount)}  ${t.raw_description || ""}${t.category ? `  [${t.category}]` : ""}`;
      })
      : [L("No new transactions since the last summary.", "No hubo movimientos nuevos desde el último resumen.")]),
    ...(moreLine ? [moreLine] : []),
    "",
    reviewLine,
    ...(link ? [link] : []),
  ].join("\n");

  return { subject, html, text, count, ackId, totals };
}
