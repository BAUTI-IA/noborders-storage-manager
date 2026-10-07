// Notifications bell: the per-user inbox for things addressed to you. Today
// that is @mentions on dispatch notes — the note's author tags a teammate, a
// row lands in `notifications` for them, and the bell at the top of the
// sidebar lights up live (Supabase Realtime). Clicking one opens the job.
// Pure mention logic lives in ./notificationsData.js.
import { useState, useEffect, useRef, useCallback } from "react";
import { tr } from "./i18n.js";
import { dbFailed } from "./db.js";
import { badgeText } from "./notificationsData.js";

// Shown in the bell's setup banner when the table doesn't exist yet.
// Keep in sync with scripts/setup-notifications.mjs (the one-time migration).
export const NOTIFICATIONS_SQL = `create table if not exists public.notifications (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  from_id uuid references public.profiles(id) on delete set null,
  from_name text,
  kind text not null default 'mention',
  job_id bigint,
  job_number text,
  customer text,
  event_id bigint,
  body text,
  read_at timestamptz,
  emailed_at timestamptz,
  created_at timestamptz not null default now()
);
alter table public.notifications add column if not exists emailed_at timestamptz;
create index if not exists notifications_user_idx on public.notifications (user_id, created_at desc);
alter table public.notifications enable row level security;
drop policy if exists "notifications_select_own" on public.notifications;
create policy "notifications_select_own" on public.notifications
  for select to authenticated using (user_id = auth.uid());
drop policy if exists "notifications_insert_as_sender" on public.notifications;
create policy "notifications_insert_as_sender" on public.notifications
  for insert to authenticated with check (from_id = auth.uid());
drop policy if exists "notifications_update_own" on public.notifications;
create policy "notifications_update_own" on public.notifications
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "notifications_delete_own" on public.notifications;
create policy "notifications_delete_own" on public.notifications
  for delete to authenticated using (user_id = auth.uid());
do $$ begin alter publication supabase_realtime add table public.notifications; exception when others then null; end $$;`;

const isMissingErr = (error) =>
  !!error && (error.code === "42P01" || error.code === "PGRST205" || /relation .*notifications.* does not exist|Could not find the table 'public\.notifications'/i.test(error.message || ""));

// One row per tagged teammate. Resolves { sent, missing }: `missing` means the
// table isn't created yet, so the caller can fall back to the old Chats DM and
// the alert still reaches the person.
export async function sendMentionNotifications({ supabase, fromId, fromName, toIds, job, eventId, body }) {
  const ids = (toIds || []).filter(id => id && id !== fromId);
  if (!supabase || !fromId || !ids.length) return { sent: 0, missing: false };
  const rows = ids.map(user_id => ({
    user_id, from_id: fromId, from_name: fromName, kind: "mention",
    job_id: job?.id ?? null, job_number: job?.job_number || null, customer: job?.customer || null,
    event_id: eventId ?? null, body,
  }));
  const res = await supabase.from("notifications").insert(rows);
  if (isMissingErr(res.error)) return { sent: 0, missing: true };
  if (dbFailed(res, "notifications")) return { sent: 0, missing: false };
  return { sent: rows.length, missing: false };
}

// Email copy of the alert, sent server side (api/admin-users.mjs →
// lib/notifyEmail.mjs) for the notifications this note just created. Best
// effort: the bell already has them, so a failure is only logged — and with
// no email provider configured the server simply skips it.
export function emailMentionCopies({ session, eventId }) {
  if (!session?.access_token || eventId == null) return;
  fetch("/api/admin-users", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + session.access_token },
    body: JSON.stringify({ action: "notify_email", payload: { event_id: eventId } }),
  })
    .then(r => r.ok ? r.json().then(j => { if (j.failed) console.warn("[notify_email]", j); }) : r.text().then(t => console.warn("[notify_email]", r.status, t)))
    .catch(e => console.warn("[notify_email]", e?.message || e));
}

const PURPLE = "#6D28D9";
const initials = (name) => (String(name || "?").split(/[.\-_\s]+/).filter(Boolean).map(w => w[0]).join("") || "?").slice(0, 2).toUpperCase();
const fmtWhen = (ts) => {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return tr("Yesterday", "Ayer");
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
};

export function NotificationsBell({ supabase, session, isAdmin = false, onOpen = () => {} }) {
  const me = session?.user?.id;
  const [items, setItems] = useState([]);       // latest notifications, newest first
  const [unread, setUnread] = useState(0);
  const [missing, setMissing] = useState(false); // table not created yet
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const boxRef = useRef(null);

  const load = useCallback(async () => {
    if (!me) return;
    const [list, count] = await Promise.all([
      supabase.from("notifications").select("*").eq("user_id", me).order("created_at", { ascending: false }).limit(40),
      supabase.from("notifications").select("id", { count: "exact", head: true }).eq("user_id", me).is("read_at", null),
    ]);
    if (isMissingErr(list.error) || isMissingErr(count.error)) { setMissing(true); setItems([]); setUnread(0); return; }
    setMissing(false);
    if (!list.error) setItems(list.data || []);
    if (!count.error) setUnread(count.count || 0);
  }, [supabase, me]);

  useEffect(() => { load(); }, [load]);

  // Live: a teammate tags me → the row arrives here; marking read in another
  // tab → the badge follows. RLS already limits rows to mine; the filter just
  // saves the traffic.
  useEffect(() => {
    if (!me || missing) return;
    const ch = supabase.channel("notifications-" + me)
      .on("postgres_changes", { event: "*", schema: "public", table: "notifications", filter: `user_id=eq.${me}` }, (payload) => {
        if (payload.eventType === "INSERT") {
          setItems(list => [payload.new, ...list.filter(n => n.id !== payload.new.id)].slice(0, 40));
          if (!payload.new.read_at) setUnread(n => n + 1);
        } else {
          load();
        }
      })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [supabase, me, missing, load]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDown = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onDown); document.removeEventListener("keydown", onKey); };
  }, [open]);

  async function openItem(n) {
    setOpen(false);
    if (!n.read_at) {
      const at = new Date().toISOString();
      setItems(list => list.map(x => x.id === n.id ? { ...x, read_at: at } : x));
      setUnread(c => Math.max(0, c - 1));
      dbFailed(await supabase.from("notifications").update({ read_at: at }).eq("id", n.id), "notifications", { quiet: true });
    }
    onOpen(n);
  }

  async function markAllRead() {
    const at = new Date().toISOString();
    if (dbFailed(await supabase.from("notifications").update({ read_at: at }).eq("user_id", me).is("read_at", null), "notifications")) return;
    setItems(list => list.map(x => x.read_at ? x : { ...x, read_at: at }));
    setUnread(0);
  }

  const count = missing ? 0 : unread;
  return (
    <div ref={boxRef} style={{ position: "relative", flexShrink: 0 }}>
      <button onClick={() => { setOpen(o => !o); if (!open) load(); }} title="Notifications"
        style={{ position: "relative", width: 30, height: 30, borderRadius: 9, border: "1px solid " + (open ? "#111" : "#ececec"), background: open ? "#111" : "#fff", cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", padding: 0, fontSize: 15, lineHeight: 1 }}>
        <span style={{ filter: open ? "grayscale(1) brightness(3)" : "none" }}>🔔</span>
        {count > 0 && (
          <span style={{ position: "absolute", top: -6, right: -6, minWidth: 17, height: 17, borderRadius: 9, background: "#E24B4A", color: "#fff", fontSize: 10, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px", border: "2px solid #fff", boxSizing: "content-box", fontVariantNumeric: "tabular-nums" }}>{badgeText(count)}</span>
        )}
      </button>

      {open && (
        <div style={{ position: "fixed", top: 12, left: 228, width: 360, maxWidth: "calc(100vw - 240px)", maxHeight: "calc(100vh - 24px)", display: "flex", flexDirection: "column", background: "#fff", border: "1px solid #ececec", borderRadius: 12, boxShadow: "0 12px 40px rgba(0,0,0,0.14)", zIndex: 60, overflow: "hidden" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, padding: "13px 16px 11px", borderBottom: "1px solid #f2f2f2" }}>
            <span style={{ fontSize: 14, fontWeight: 700 }}>Notifications</span>
            {count > 0 && <span style={{ fontSize: 11, fontWeight: 700, color: "#A32D2D", background: "#FCEBEB", borderRadius: 10, padding: "1px 7px" }}>{tr(`${count} new`, `${count} nuevas`)}</span>}
            {!missing && (
              <button onClick={markAllRead} disabled={count === 0}
                style={{ marginLeft: "auto", border: "none", background: "none", padding: 0, fontSize: 12, fontWeight: 600, color: count ? "#185FA5" : "#ccc", cursor: count ? "pointer" : "default" }}>
                Mark all read
              </button>
            )}
          </div>

          <div style={{ overflowY: "auto" }}>
            {missing ? (
              <div style={{ margin: 14, background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "12px 14px", fontSize: 12.5, color: "#854F0B", lineHeight: 1.5 }}>
                <div style={{ fontWeight: 700, marginBottom: 4 }}>One-time setup needed</div>
                {isAdmin ? (<>
                  <div>Notifications need their table created once. Run this SQL in Supabase (SQL Editor), or run <code>node scripts/setup-notifications.mjs</code>. Until then, tags still arrive as a Chats message.</div>
                  <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                    <button onClick={() => { navigator.clipboard?.writeText(NOTIFICATIONS_SQL).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => {}); }}
                      style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
                      {copied ? "Copied!" : "Copy SQL"}
                    </button>
                    <button onClick={load} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
                      I ran it — retry
                    </button>
                  </div>
                </>) : (
                  <div>Notifications are not set up yet — ask an admin. Until then, tags still arrive as a Chats message.</div>
                )}
              </div>
            ) : items.length === 0 ? (
              <div style={{ padding: "34px 24px", textAlign: "center" }}>
                <div style={{ fontSize: 26, marginBottom: 8, opacity: 0.5 }}>🔔</div>
                <div style={{ fontSize: 13, fontWeight: 600, color: "#555" }}>No notifications yet</div>
                <div style={{ fontSize: 12, color: "#999", marginTop: 4, lineHeight: 1.5 }}>When a teammate tags you on a job note, it shows up here.</div>
              </div>
            ) : items.map(n => {
              const isNew = !n.read_at;
              const jobLine = [n.job_number ? `Job ${n.job_number}` : null, n.customer].filter(Boolean).join(" · ");
              return (
                <button key={n.id} onClick={() => openItem(n)}
                  style={{ width: "100%", display: "flex", alignItems: "flex-start", gap: 10, padding: "11px 16px", border: "none", borderBottom: "1px solid #f6f6f6", background: isNew ? "#F7F4FE" : "#fff", cursor: "pointer", textAlign: "left", fontFamily: "inherit", color: "#111" }}>
                  <span style={{ width: 28, height: 28, borderRadius: "50%", background: "#EDE9FE", color: PURPLE, fontSize: 10.5, fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, marginTop: 1 }}>{initials(n.from_name)}</span>
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.4 }}>
                        <b>{n.from_name || "—"}</b> <span style={{ color: "#666" }}>tagged you</span>
                      </span>
                      <span style={{ fontSize: 10.5, color: "#aaa", flexShrink: 0, fontVariantNumeric: "tabular-nums" }}>{fmtWhen(n.created_at)}</span>
                    </span>
                    {jobLine && <span style={{ display: "block", fontSize: 11.5, fontWeight: 600, color: "#185FA5", marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{jobLine}</span>}
                    {n.body && <span style={{ display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden", fontSize: 12.5, color: "#444", marginTop: 3, lineHeight: 1.45, wordBreak: "break-word" }}>{n.body}</span>}
                  </span>
                  {isNew && <span style={{ width: 8, height: 8, borderRadius: "50%", background: PURPLE, flexShrink: 0, marginTop: 6 }} />}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
