// Internal team chat (Slack-style): public channels + direct messages between
// CRM users, live via Supabase Realtime. Tables: chat_channels,
// chat_channel_members (per-user read cursor) and chat_messages.
import { useState, useEffect, useRef, useCallback, useMemo } from "react";

// Shown in the setup banner when the chat tables don't exist yet.
// Keep in sync with scripts/setup-chat.mjs (the one-time migration).
export const CHAT_SQL = `create table if not exists public.chat_channels (
  id bigint generated always as identity primary key,
  name text,
  is_dm boolean not null default false,
  dm_a uuid references public.profiles(id) on delete cascade,
  dm_b uuid references public.profiles(id) on delete cascade,
  dm_key text unique,
  created_by uuid references public.profiles(id),
  created_at timestamptz default now()
);
create table if not exists public.chat_channel_members (
  channel_id bigint references public.chat_channels(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  last_read_at timestamptz not null default now(),
  primary key (channel_id, user_id)
);
create table if not exists public.chat_messages (
  id bigint generated always as identity primary key,
  channel_id bigint not null references public.chat_channels(id) on delete cascade,
  sender_id uuid not null references public.profiles(id),
  sender_name text,
  body text not null,
  created_at timestamptz not null default now()
);
create index if not exists chat_messages_channel_idx on public.chat_messages (channel_id, created_at);
alter table public.chat_channels enable row level security;
alter table public.chat_channel_members enable row level security;
alter table public.chat_messages enable row level security;
create or replace function public.chat_can_see(ch public.chat_channels)
returns boolean language sql stable as
$$ select (not ch.is_dm) or auth.uid() in (ch.dm_a, ch.dm_b) $$;
drop policy if exists "chat_channels_select" on public.chat_channels;
create policy "chat_channels_select" on public.chat_channels
  for select to authenticated using (public.chat_can_see(chat_channels));
drop policy if exists "chat_channels_insert" on public.chat_channels;
create policy "chat_channels_insert" on public.chat_channels
  for insert to authenticated
  with check (created_by = auth.uid() and (not is_dm or auth.uid() in (dm_a, dm_b)));
drop policy if exists "chat_channels_delete" on public.chat_channels;
create policy "chat_channels_delete" on public.chat_channels
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "chat_members_own" on public.chat_channel_members;
create policy "chat_members_own" on public.chat_channel_members
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "chat_messages_select" on public.chat_messages;
create policy "chat_messages_select" on public.chat_messages
  for select to authenticated using (
    exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );
drop policy if exists "chat_messages_insert" on public.chat_messages;
create policy "chat_messages_insert" on public.chat_messages
  for insert to authenticated with check (
    sender_id = auth.uid()
    and exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );
drop policy if exists "chat_messages_delete" on public.chat_messages;
create policy "chat_messages_delete" on public.chat_messages
  for delete to authenticated using (sender_id = auth.uid() or public.is_admin());
drop policy if exists "profiles_select_chat" on public.profiles;
create policy "profiles_select_chat" on public.profiles
  for select to authenticated using (true);
insert into public.chat_channels (name, is_dm)
select 'general', false
where not exists (select 1 from public.chat_channels where name = 'general' and not is_dm);
alter publication supabase_realtime add table public.chat_channels;
alter publication supabase_realtime add table public.chat_messages;`;

const AVATAR_COLORS = ["#185FA5", "#3B6D11", "#B45309", "#A32D2D", "#6D28D9", "#0F766E", "#BE185D", "#4D7C0F"];
const avatarColor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const dmKey = (a, b) => [a, b].sort().join(":");
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts) => {
  const d = new Date(ts), today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};

function Avatar({ id, name, size = 30 }) {
  return (
    <span style={{ width: size, height: size, borderRadius: 8, flexShrink: 0, background: avatarColor(id), color: "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.38, fontWeight: 700 }}>
      {initials(name)}
    </span>
  );
}

export function MessagesSection({ supabase, session, profile, isAdmin = false, onUnreadTotal = () => {} }) {
  const me = session.user.id;
  const myName = profile?.full_name || session.user.email;

  const [missing, setMissing] = useState(false);      // chat tables not created yet
  const [sqlCopied, setSqlCopied] = useState(false);
  const [people, setPeople] = useState([]);           // active profiles (teammates)
  const [channels, setChannels] = useState([]);       // rows from chat_channels visible to me
  const [cursors, setCursors] = useState({});         // channel_id -> last_read_at (mine)
  const [unread, setUnread] = useState({});           // channel_id -> count
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);       // active channel messages, asc
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [showNewChannel, setShowNewChannel] = useState(false);
  const [newChannelName, setNewChannelName] = useState("");

  const scrollRef = useRef(null);
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const isMissingErr = (error) => error && (error.code === "42P01" || /chat_channels|chat_messages/.test(error.message || ""));

  // ── Loaders ────────────────────────────────────────────────────────────────
  const loadPeople = useCallback(async () => {
    const { data } = await supabase.from("profiles").select("id, full_name, email, active").order("full_name");
    setPeople((data || []).filter(p => p.active !== false));
  }, [supabase]);

  const loadChannels = useCallback(async () => {
    const { data, error } = await supabase.from("chat_channels").select("*").order("created_at");
    if (isMissingErr(error)) { setMissing(true); return []; }
    setMissing(false);
    setChannels(data || []);
    const { data: mem } = await supabase.from("chat_channel_members").select("channel_id, last_read_at").eq("user_id", me);
    const cur = Object.fromEntries((mem || []).map(m => [m.channel_id, m.last_read_at]));
    setCursors(cur);
    return data || [];
  }, [supabase, me]);

  // Unread = messages from others newer than my read cursor, per channel.
  const loadUnread = useCallback(async (chs, cur) => {
    const counts = await Promise.all(chs.map(async ch => {
      let q = supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("channel_id", ch.id).neq("sender_id", me);
      if (cur[ch.id]) q = q.gt("created_at", cur[ch.id]);
      const { count } = await q;
      return [ch.id, count || 0];
    }));
    setUnread(Object.fromEntries(counts));
  }, [supabase, me]);

  const markRead = useCallback(async (channelId) => {
    const now = new Date().toISOString();
    setCursors(c => ({ ...c, [channelId]: now }));
    setUnread(u => ({ ...u, [channelId]: 0 }));
    await supabase.from("chat_channel_members").upsert({ channel_id: channelId, user_id: me, last_read_at: now });
  }, [supabase, me]);

  const loadMessages = useCallback(async (channelId) => {
    setLoadingMsgs(true);
    const { data, error } = await supabase.from("chat_messages").select("*")
      .eq("channel_id", channelId).order("created_at", { ascending: true }).limit(500);
    if (isMissingErr(error)) setMissing(true);
    setMessages(data || []);
    setLoadingMsgs(false);
  }, [supabase]);

  // Initial load: people + channels + unread, then land on #general.
  useEffect(() => {
    (async () => {
      await loadPeople();
      const chs = await loadChannels();
      if (chs.length && activeIdRef.current == null) {
        const general = chs.find(c => !c.is_dm) || chs[0];
        setActiveId(general.id);
      }
    })();
  }, [loadPeople, loadChannels]);

  // Unread counts once channels + cursors are known.
  useEffect(() => {
    if (channels.length) loadUnread(channels, cursors);
  }, [channels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface the total in the sidebar badge.
  useEffect(() => {
    onUnreadTotal(Object.entries(unread).reduce((a, [id, n]) => a + (Number(id) === activeId ? 0 : n), 0));
  }, [unread, activeId, onUnreadTotal]);

  // Switch channel → load history + mark read.
  useEffect(() => {
    if (activeId == null) return;
    loadMessages(activeId);
    markRead(activeId);
  }, [activeId, loadMessages, markRead]);

  // Realtime: append new messages to the open channel, bump unread elsewhere.
  useEffect(() => {
    const channel = supabase.channel("chat-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
        const msg = payload.new;
        // RLS doesn't filter realtime rows for DMs we can't see; skip unknown channels.
        if (!channelsRef.current.some(c => c.id === msg.channel_id)) { loadChannels(); return; }
        if (msg.channel_id === activeIdRef.current) {
          setMessages(ms => ms.some(m => m.id === msg.id) ? ms : [...ms, msg]);
          if (msg.sender_id !== me) markRead(msg.channel_id);
        } else if (msg.sender_id !== me) {
          setUnread(u => ({ ...u, [msg.channel_id]: (u[msg.channel_id] || 0) + 1 }));
        }
      })
      .on("postgres_changes", { event: "DELETE", schema: "public", table: "chat_messages" }, (payload) => {
        setMessages(ms => ms.filter(m => m.id !== payload.old.id));
      })
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_channels" }, () => loadChannels())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [supabase, me, loadChannels, markRead]);

  // Keep the message list pinned to the bottom.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, activeId, loadingMsgs]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const send = async () => {
    const body = draft.trim();
    if (!body || activeId == null || sending) return;
    setSending(true);
    setDraft("");
    const { data, error } = await supabase.from("chat_messages")
      .insert([{ channel_id: activeId, sender_id: me, sender_name: myName, body }])
      .select().single();
    setSending(false);
    if (error) { setDraft(body); window.alert("Could not send: " + error.message); return; }
    setMessages(ms => ms.some(m => m.id === data.id) ? ms : [...ms, data]);
    markRead(activeId);
  };

  const deleteMessage = async (id) => {
    setMessages(ms => ms.filter(m => m.id !== id));
    await supabase.from("chat_messages").delete().eq("id", id);
  };

  const createChannel = async () => {
    const name = newChannelName.trim().toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9\-_]/g, "");
    if (!name) return;
    const { data, error } = await supabase.from("chat_channels")
      .insert([{ name, is_dm: false, created_by: me }]).select().single();
    if (error) { window.alert(error.message); return; }
    setShowNewChannel(false);
    setNewChannelName("");
    setChannels(cs => cs.some(c => c.id === data.id) ? cs : [...cs, data]);
    setActiveId(data.id);
  };

  const openDm = async (otherId) => {
    const key = dmKey(me, otherId);
    const existing = channels.find(c => c.dm_key === key);
    if (existing) { setActiveId(existing.id); return; }
    const { data, error } = await supabase.from("chat_channels")
      .insert([{ is_dm: true, dm_a: me, dm_b: otherId, dm_key: key, created_by: me }]).select().single();
    if (error) {
      // Unique dm_key race: someone (or another tab) created it first — reload and reuse.
      const chs = await loadChannels();
      const found = chs.find(c => c.dm_key === key);
      if (found) setActiveId(found.id); else window.alert(error.message);
      return;
    }
    setChannels(cs => cs.some(c => c.id === data.id) ? cs : [...cs, data]);
    setActiveId(data.id);
  };

  const deleteChannel = async (ch) => {
    if (!window.confirm(`Delete #${ch.name} and all its messages?`)) return;
    await supabase.from("chat_channels").delete().eq("id", ch.id);
    setChannels(cs => cs.filter(c => c.id !== ch.id));
    if (activeId === ch.id) setActiveId(null);
  };

  // ── Derived ────────────────────────────────────────────────────────────────
  const peopleById = useMemo(() => Object.fromEntries(people.map(p => [p.id, p])), [people]);
  const dmName = (ch) => {
    const otherId = ch.dm_a === me ? ch.dm_b : ch.dm_a;
    const p = peopleById[otherId];
    return { id: otherId, name: p?.full_name || p?.email || "Unknown user" };
  };
  const publicChannels = channels.filter(c => !c.is_dm);
  const dmChannels = channels.filter(c => c.is_dm);
  const dmByOther = Object.fromEntries(dmChannels.map(c => [c.dm_a === me ? c.dm_b : c.dm_a, c]));
  const active = channels.find(c => c.id === activeId) || null;
  const activeTitle = active ? (active.is_dm ? dmName(active).name : `# ${active.name}`) : "";

  // ── Missing-tables banner ──────────────────────────────────────────────────
  if (missing) return (
    <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#854F0B" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>One-time setup needed</div>
      <div>Team chat needs its tables created once. Run this SQL in Supabase (SQL Editor), or run <code>node scripts/setup-chat.mjs</code>.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => { navigator.clipboard?.writeText(CHAT_SQL).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          {sqlCopied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={loadChannels} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — retry
        </button>
      </div>
    </div>
  );

  const railBtn = (isActive) => ({
    width: "100%", display: "flex", alignItems: "center", gap: 8, padding: "6px 10px", borderRadius: 7,
    border: "none", cursor: "pointer", fontSize: 13, textAlign: "left", marginBottom: 1,
    background: isActive ? "#111" : "transparent", color: isActive ? "#fff" : "#444", fontWeight: isActive ? 600 : 500,
  });
  const unreadPill = (n, isActive) => n > 0 && (
    <span style={{ background: isActive ? "#fff" : "#E24B4A", color: isActive ? "#111" : "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px" }}>{n}</span>
  );

  return (
    <div style={{ display: "flex", background: "#fff", border: "1px solid #efefef", borderRadius: 12, overflow: "hidden", height: "calc(100vh - 150px)", minHeight: 420 }}>

      {/* ── Channel rail ── */}
      <div style={{ width: 230, flexShrink: 0, borderRight: "1px solid #f0f0f0", display: "flex", flexDirection: "column", background: "#fbfbfb" }}>
        <div style={{ flex: 1, overflowY: "auto", padding: 10 }}>
          <div style={{ display: "flex", alignItems: "center", padding: "4px 10px 4px" }}>
            <span style={{ flex: 1, fontSize: 10, fontWeight: 600, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.07em" }}>Channels</span>
            <button onClick={() => setShowNewChannel(true)} title="New channel" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#888", fontSize: 15, lineHeight: 1, padding: 2 }}>＋</button>
          </div>
          {publicChannels.map(ch => {
            const isActive = ch.id === activeId;
            return (
              <button key={ch.id} onClick={() => setActiveId(ch.id)} style={railBtn(isActive)}>
                <span style={{ color: isActive ? "#999" : "#aaa", fontWeight: 700 }}>#</span>
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{ch.name}</span>
                {unreadPill(unread[ch.id], isActive)}
              </button>
            );
          })}
          {publicChannels.length === 0 && <div style={{ fontSize: 12, color: "#bbb", padding: "4px 10px" }}>No channels yet</div>}

          <div style={{ fontSize: 10, fontWeight: 600, color: "#bbb", textTransform: "uppercase", letterSpacing: "0.07em", padding: "14px 10px 4px" }}>Direct messages</div>
          {people.filter(p => p.id !== me).map(p => {
            const ch = dmByOther[p.id];
            const isActive = ch && ch.id === activeId;
            return (
              <button key={p.id} onClick={() => openDm(p.id)} style={railBtn(isActive)}>
                <Avatar id={p.id} name={p.full_name || p.email} size={20} />
                <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.full_name || p.email}</span>
                {ch && unreadPill(unread[ch.id], isActive)}
              </button>
            );
          })}
          {people.filter(p => p.id !== me).length === 0 && (
            <div style={{ fontSize: 12, color: "#bbb", padding: "4px 10px" }}>No teammates yet — if this list looks empty, run the chat setup SQL to allow reading teammate names.</div>
          )}
        </div>
      </div>

      {/* ── Conversation pane ── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column" }}>
        {!active ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", color: "#bbb", fontSize: 14 }}>
            Pick a channel or a teammate to start chatting 💬
          </div>
        ) : (
          <>
            <div style={{ padding: "12px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10 }}>
              {active.is_dm && <Avatar id={dmName(active).id} name={dmName(active).name} size={26} />}
              <span style={{ fontSize: 15, fontWeight: 700 }}>{activeTitle}</span>
              {!active.is_dm && (isAdmin || active.created_by === me) && active.name !== "general" && (
                <button onClick={() => deleteChannel(active)} title="Delete channel" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "#ccc", fontSize: 13 }}>🗑</button>
              )}
            </div>

            <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 16px" }}>
              {loadingMsgs ? (
                <div style={{ color: "#bbb", fontSize: 13 }}>Loading…</div>
              ) : messages.length === 0 ? (
                <div style={{ color: "#bbb", fontSize: 13 }}>No messages yet. Say hi! 👋</div>
              ) : messages.map((m, i) => {
                const prev = messages[i - 1];
                const newDay = !prev || fmtDay(prev.created_at) !== fmtDay(m.created_at);
                const grouped = !newDay && prev && prev.sender_id === m.sender_id &&
                  (new Date(m.created_at) - new Date(prev.created_at)) < 5 * 60 * 1000;
                const name = peopleById[m.sender_id]?.full_name || m.sender_name || "Unknown";
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "14px 0 10px" }}>
                        <div style={{ flex: 1, height: 1, background: "#f0f0f0" }} />
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#bbb" }}>{fmtDay(m.created_at)}</span>
                        <div style={{ flex: 1, height: 1, background: "#f0f0f0" }} />
                      </div>
                    )}
                    <div className="chat-msg" style={{ display: "flex", gap: 10, padding: grouped ? "1px 6px" : "5px 6px", borderRadius: 8, position: "relative" }}
                      onMouseEnter={e => { const b = e.currentTarget.querySelector(".msg-del"); if (b) b.style.opacity = 1; }}
                      onMouseLeave={e => { const b = e.currentTarget.querySelector(".msg-del"); if (b) b.style.opacity = 0; }}>
                      {grouped ? <span style={{ width: 30, flexShrink: 0 }} /> : <Avatar id={m.sender_id} name={name} />}
                      <div style={{ minWidth: 0, flex: 1 }}>
                        {!grouped && (
                          <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                            <span style={{ fontSize: 13.5, fontWeight: 700 }}>{name}{m.sender_id === me ? " (you)" : ""}</span>
                            <span style={{ fontSize: 11, color: "#bbb" }}>{fmtTime(m.created_at)}</span>
                          </div>
                        )}
                        <div style={{ fontSize: 13.5, lineHeight: 1.45, whiteSpace: "pre-wrap", wordBreak: "break-word", color: "#222" }}>{m.body}</div>
                      </div>
                      {(m.sender_id === me || isAdmin) && (
                        <button className="msg-del" onClick={() => deleteMessage(m.id)} title="Delete message"
                          style={{ opacity: 0, transition: "opacity .15s", border: "none", background: "transparent", cursor: "pointer", color: "#ccc", fontSize: 12, alignSelf: "flex-start" }}>✕</button>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>

            <div style={{ padding: "10px 14px 14px", borderTop: "1px solid #f0f0f0" }}>
              <div style={{ display: "flex", gap: 8, alignItems: "flex-end", background: "#fafafa", border: "1px solid #eee", borderRadius: 10, padding: "8px 10px" }}>
                <textarea
                  value={draft}
                  onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                  placeholder={active.is_dm ? `Message ${dmName(active).name}` : `Message #${active.name}`}
                  rows={Math.min(5, Math.max(1, draft.split("\n").length))}
                  style={{ flex: 1, border: "none", outline: "none", background: "transparent", resize: "none", fontSize: 13.5, fontFamily: "inherit", lineHeight: 1.45 }}
                />
                <button onClick={send} disabled={!draft.trim() || sending}
                  style={{ border: "none", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? "#111" : "#e8e8e8", color: draft.trim() ? "#fff" : "#aaa" }}>
                  Send
                </button>
              </div>
              <div style={{ fontSize: 10.5, color: "#ccc", marginTop: 4 }}>Enter to send · Shift+Enter for a new line</div>
            </div>
          </>
        )}
      </div>

      {/* ── New channel modal ── */}
      {showNewChannel && (
        <div onClick={() => setShowNewChannel(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 12, padding: 20, width: 360, boxShadow: "0 12px 40px rgba(0,0,0,.18)" }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>New channel</div>
            <div style={{ fontSize: 12, color: "#999", marginBottom: 12 }}>Channels are visible to the whole team.</div>
            <div style={{ display: "flex", alignItems: "center", gap: 6, border: "1px solid #e5e5e5", borderRadius: 8, padding: "8px 10px" }}>
              <span style={{ color: "#aaa", fontWeight: 700 }}>#</span>
              <input autoFocus value={newChannelName} onChange={e => setNewChannelName(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter") createChannel(); }}
                placeholder="e.g. dispatch, sales, random" style={{ flex: 1, border: "none", outline: "none", fontSize: 13.5 }} />
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 14 }}>
              <button onClick={() => setShowNewChannel(false)} style={{ border: "1px solid #eee", background: "#fff", borderRadius: 8, padding: "7px 14px", fontSize: 13, cursor: "pointer", color: "#666" }}>Cancel</button>
              <button onClick={createChannel} disabled={!newChannelName.trim()} style={{ border: "none", background: newChannelName.trim() ? "#111" : "#e8e8e8", color: newChannelName.trim() ? "#fff" : "#aaa", borderRadius: 8, padding: "7px 14px", fontSize: 13, fontWeight: 600, cursor: "pointer" }}>Create</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
