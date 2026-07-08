// Internal team chat, Messenger-style: a "Chats" inbox listing conversations
// (group channels + 1-to-1 DMs) with last-message preview and unread badges,
// a bubble conversation view, and online presence (green dots) via Supabase
// Realtime Presence. Tables: chat_channels, chat_channel_members, chat_messages.
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

// Upgrade for read receipts + last connection (scripts/setup-chat-receipts.mjs).
export const CHAT_SQL_V2 = `create table if not exists public.chat_presence (
  user_id uuid primary key references public.profiles(id) on delete cascade,
  last_seen_at timestamptz not null default now()
);
alter table public.chat_presence enable row level security;
drop policy if exists "chat_presence_select" on public.chat_presence;
create policy "chat_presence_select" on public.chat_presence
  for select to authenticated using (true);
drop policy if exists "chat_presence_insert" on public.chat_presence;
create policy "chat_presence_insert" on public.chat_presence
  for insert to authenticated with check (user_id = auth.uid());
drop policy if exists "chat_presence_update" on public.chat_presence;
create policy "chat_presence_update" on public.chat_presence
  for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
drop policy if exists "chat_members_select_mates" on public.chat_channel_members;
create policy "chat_members_select_mates" on public.chat_channel_members
  for select to authenticated using (
    exists (select 1 from public.chat_channels c where c.id = channel_id and public.chat_can_see(c))
  );
alter publication supabase_realtime add table public.chat_channel_members;
alter publication supabase_realtime add table public.chat_presence;`;

// Upgrade for private group chats with hand-picked members (setup-chat-groups.mjs).
export const CHAT_SQL_V3 = `alter table public.chat_channels add column if not exists is_private boolean not null default false;
create or replace function public.chat_is_member(cid bigint)
returns boolean language sql security definer stable as
$$ select exists(select 1 from public.chat_channel_members where channel_id = cid and user_id = auth.uid()) $$;
create or replace function public.chat_can_see(ch public.chat_channels)
returns boolean language sql stable as
$$ select case
     when ch.is_dm then auth.uid() in (ch.dm_a, ch.dm_b)
     when coalesce(ch.is_private, false) then (ch.created_by = auth.uid() or public.chat_is_member(ch.id))
     else true
   end $$;
drop policy if exists "chat_members_add_by_creator" on public.chat_channel_members;
create policy "chat_members_add_by_creator" on public.chat_channel_members
  for insert to authenticated with check (
    exists (select 1 from public.chat_channels c where c.id = channel_id and c.created_by = auth.uid())
  );`;

const BLUE = "#0A7CFF";                 // Messenger-style own-bubble blue
const AVATAR_COLORS = ["#185FA5", "#3B6D11", "#B45309", "#A32D2D", "#6D28D9", "#0F766E", "#BE185D", "#4D7C0F"];
export const avatarColor = (id) => AVATAR_COLORS[[...String(id)].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_COLORS.length];
export const initials = (name) => (name || "?").trim().split(/\s+/).slice(0, 2).map(w => w[0]).join("").toUpperCase();
const dmKey = (a, b) => [a, b].sort().join(":");
const fmtTime = (ts) => new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtDay = (ts) => {
  const d = new Date(ts), today = new Date();
  const yest = new Date(today); yest.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === yest.toDateString()) return "Yesterday";
  return d.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" });
};
// Inbox row timestamp: time if today, weekday if this week, date otherwise.
const fmtListTime = (ts) => {
  if (!ts) return "";
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return fmtTime(ts);
  if (now - d < 6 * 24 * 3600 * 1000) return d.toLocaleDateString([], { weekday: "short" });
  return d.toLocaleDateString([], { month: "numeric", day: "numeric" });
};
// Compact relative time for "last seen" (language-neutral: 5m, 3h, 2d).
const relTime = (ts) => {
  const s = (Date.now() - new Date(ts)) / 1000;
  if (s < 90) return "1m";
  if (s < 3600) return Math.round(s / 60) + "m";
  if (s < 86400) return Math.round(s / 3600) + "h";
  if (s < 7 * 86400) return Math.round(s / 86400) + "d";
  return new Date(ts).toLocaleDateString();
};
const after = (a, b) => a && b && new Date(a) >= new Date(b);

export function Avatar({ id, name, size = 36, online = false, group = false }) {
  return (
    <span style={{ position: "relative", width: size, height: size, flexShrink: 0, display: "inline-block" }}>
      <span style={{ width: size, height: size, borderRadius: "50%", background: group ? "#e8e8ec" : avatarColor(id), color: group ? "#555" : "#fff", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: size * 0.36, fontWeight: 700 }}>
        {group ? "#" : initials(name)}
      </span>
      {online && (
        <span style={{ position: "absolute", right: -1, bottom: -1, width: Math.max(9, size * 0.28), height: Math.max(9, size * 0.28), borderRadius: "50%", background: "#31CC46", border: "2px solid #fff" }} />
      )}
    </span>
  );
}

export function MessagesSection({ supabase, session, profile, isAdmin = false, onlineIds = [], onUnreadTotal = () => {} }) {
  const me = session.user.id;
  const myName = profile?.full_name || session.user.email;

  const [missing, setMissing] = useState(false);      // chat tables not created yet
  const [sqlCopied, setSqlCopied] = useState(false);
  const [people, setPeople] = useState([]);           // active profiles (teammates)
  const [channels, setChannels] = useState([]);       // rows from chat_channels visible to me
  const [cursors, setCursors] = useState({});         // channel_id -> my last_read_at
  const [unread, setUnread] = useState({});           // channel_id -> count
  const [lastMsg, setLastMsg] = useState({});         // channel_id -> latest message (inbox preview)
  const [activeId, setActiveId] = useState(null);
  const [messages, setMessages] = useState([]);       // active conversation, asc
  const [loadingMsgs, setLoadingMsgs] = useState(false);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [search, setSearch] = useState("");
  const [showNewChat, setShowNewChat] = useState(false);
  const [newChatSearch, setNewChatSearch] = useState("");
  const [newGroupName, setNewGroupName] = useState("");
  const [readBy, setReadBy] = useState({});           // active channel: user_id -> last_read_at (others)
  const [lastSeen, setLastSeen] = useState({});       // user_id -> last_seen_at (chat_presence heartbeat)
  const [members, setMembers] = useState({});         // channel_id -> [user_id] (group membership)
  const [groupSel, setGroupSel] = useState(new Set()); // people ticked in the New chat modal
  const [receiptsMissing, setReceiptsMissing] = useState(false); // v2 SQL (receipts/last seen) not run yet
  const [groupsMissing, setGroupsMissing] = useState(false);     // v3 SQL (private groups) not run yet
  const [v2Copied, setV2Copied] = useState(false);
  const [v3Copied, setV3Copied] = useState(false);

  const scrollRef = useRef(null);
  const activeIdRef = useRef(null);
  activeIdRef.current = activeId;
  const channelsRef = useRef(channels);
  channelsRef.current = channels;

  const online = useMemo(() => new Set(onlineIds), [onlineIds]);
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
    setCursors(Object.fromEntries((mem || []).map(m => [m.channel_id, m.last_read_at])));
    return data || [];
  }, [supabase, me]);

  // Per conversation: unread count (others' messages newer than my cursor) + last message for the preview.
  const loadMeta = useCallback(async (chs, cur) => {
    const metas = await Promise.all(chs.map(async ch => {
      let q = supabase.from("chat_messages").select("id", { count: "exact", head: true }).eq("channel_id", ch.id).neq("sender_id", me);
      if (cur[ch.id]) q = q.gt("created_at", cur[ch.id]);
      const [{ count }, { data: last }] = await Promise.all([
        q,
        supabase.from("chat_messages").select("*").eq("channel_id", ch.id).order("created_at", { ascending: false }).limit(1),
      ]);
      return [ch.id, count || 0, last?.[0] || null];
    }));
    setUnread(Object.fromEntries(metas.map(([id, n]) => [id, n])));
    setLastMsg(Object.fromEntries(metas.filter(([, , m]) => m).map(([id, , m]) => [id, m])));
  }, [supabase, me]);

  const markRead = useCallback(async (channelId) => {
    const now = new Date().toISOString();
    setCursors(c => ({ ...c, [channelId]: now }));
    setUnread(u => ({ ...u, [channelId]: 0 }));
    await supabase.from("chat_channel_members").upsert({ channel_id: channelId, user_id: me, last_read_at: now });
  }, [supabase, me]);

  // Last connection of every teammate (chat_presence heartbeats). Its absence
  // means the receipts upgrade SQL hasn't been run yet — degrade gracefully.
  const loadLastSeen = useCallback(async () => {
    const { data, error } = await supabase.from("chat_presence").select("*");
    if (error) {
      if (error.code === "42P01" || /chat_presence/.test(error.message || "")) setReceiptsMissing(true);
      return;
    }
    setReceiptsMissing(false);
    setLastSeen(Object.fromEntries((data || []).map(r => [r.user_id, r.last_seen_at])));
  }, [supabase]);

  // Membership of every conversation (drives private-group member lists).
  const loadMembers = useCallback(async () => {
    const { data } = await supabase.from("chat_channel_members").select("channel_id, user_id");
    const map = {};
    (data || []).forEach(r => { (map[r.channel_id] ||= []).push(r.user_id); });
    setMembers(map);
  }, [supabase]);

  // Read cursors of the other members of the open conversation (seen receipts).
  const loadReadBy = useCallback(async (channelId) => {
    const { data } = await supabase.from("chat_channel_members")
      .select("user_id, last_read_at").eq("channel_id", channelId).neq("user_id", me);
    setReadBy(Object.fromEntries((data || []).map(r => [r.user_id, r.last_read_at])));
  }, [supabase, me]);

  const loadMessages = useCallback(async (channelId) => {
    setLoadingMsgs(true);
    const { data, error } = await supabase.from("chat_messages").select("*")
      .eq("channel_id", channelId).order("created_at", { ascending: true }).limit(500);
    if (isMissingErr(error)) setMissing(true);
    setMessages(data || []);
    setLoadingMsgs(false);
  }, [supabase]);

  // Initial load: people + channels, then previews/unread.
  useEffect(() => {
    (async () => {
      await loadPeople();
      await loadChannels();
      await loadMembers();
      await loadLastSeen();
    })();
    // Refresh last-seen periodically as a fallback if realtime misses beats.
    const iv = setInterval(loadLastSeen, 60_000);
    return () => clearInterval(iv);
  }, [loadPeople, loadChannels, loadMembers, loadLastSeen]);

  useEffect(() => {
    if (channels.length) loadMeta(channels, cursors);
  }, [channels.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // Surface the total in the sidebar badge (open conversation doesn't count).
  useEffect(() => {
    onUnreadTotal(Object.entries(unread).reduce((a, [id, n]) => a + (Number(id) === activeId ? 0 : n), 0));
  }, [unread, activeId, onUnreadTotal]);

  // Open conversation → load history + others' read cursors + mark read.
  useEffect(() => {
    if (activeId == null) return;
    setReadBy({});
    loadMessages(activeId);
    loadReadBy(activeId);
    markRead(activeId);
  }, [activeId, loadMessages, loadReadBy, markRead]);

  // Realtime: append to the open conversation, bump unread + preview elsewhere.
  useEffect(() => {
    const channel = supabase.channel("chat-realtime")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "chat_messages" }, (payload) => {
        const msg = payload.new;
        if (!channelsRef.current.some(c => c.id === msg.channel_id)) { loadChannels(); }
        setLastMsg(lm => ({ ...lm, [msg.channel_id]: msg }));
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
      // Membership changes: someone added me to a group → reload; and keep the
      // per-channel member list current. Also: a read cursor moving = "seen".
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_channel_members" }, (payload) => {
        const row = payload.new;
        if (!row) return;
        if (row.user_id === me) { loadChannels(); loadMembers(); }
        else setMembers(mm => {
          const cur = mm[row.channel_id] || [];
          return cur.includes(row.user_id) ? mm : { ...mm, [row.channel_id]: [...cur, row.user_id] };
        });
        if (row.channel_id === activeIdRef.current && row.user_id !== me)
          setReadBy(rb => ({ ...rb, [row.user_id]: row.last_read_at }));
      })
      // Heartbeats → last connection updates live.
      .on("postgres_changes", { event: "*", schema: "public", table: "chat_presence" }, (payload) => {
        const row = payload.new;
        if (row) setLastSeen(ls => ({ ...ls, [row.user_id]: row.last_seen_at }));
      })
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [supabase, me, loadChannels, loadMembers, markRead]);

  // Keep the conversation pinned to the bottom.
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
    setLastMsg(lm => ({ ...lm, [activeId]: data }));
    markRead(activeId);
  };

  const deleteMessage = async (id) => {
    setMessages(ms => ms.filter(m => m.id !== id));
    await supabase.from("chat_messages").delete().eq("id", id);
  };

  // Private group with hand-picked members (creator + everyone in memberIds).
  const createGroup = async (memberIds, rawName) => {
    const ids = [...new Set(memberIds)].filter(id => id && id !== me);
    if (ids.length < 1) return;
    const name = (rawName || "").trim() || ids.map(id => personName(peopleById[id]).split(/\s+/)[0]).join(", ");
    const { data, error } = await supabase.from("chat_channels")
      .insert([{ name, is_dm: false, is_private: true, created_by: me }]).select().single();
    if (error) {
      if (/is_private|chat_is_member|column|does not exist/i.test(error.message || "")) { setGroupsMissing(true); return; }
      window.alert(error.message); return;
    }
    const rows = [me, ...ids].map(uid => ({ channel_id: data.id, user_id: uid }));
    await supabase.from("chat_channel_members").insert(rows);
    setShowNewChat(false);
    setNewGroupName(""); setNewChatSearch(""); setGroupSel(new Set());
    setChannels(cs => cs.some(c => c.id === data.id) ? cs : [...cs, data]);
    setMembers(mm => ({ ...mm, [data.id]: [me, ...ids] }));
    setActiveId(data.id);
  };

  const toggleSel = (id) => setGroupSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  // The New chat modal's primary action: 1 person → DM, 2+ → private group.
  const confirmNewChat = () => {
    const ids = [...groupSel];
    if (ids.length === 1) openDm(ids[0]);
    else if (ids.length >= 2) createGroup(ids, newGroupName);
  };

  const openNewChat = () => { setGroupSel(new Set()); setNewChatSearch(""); setNewGroupName(""); setShowNewChat(true); };

  const openDm = async (otherId) => {
    setShowNewChat(false);
    const key = dmKey(me, otherId);
    const existing = channelsRef.current.find(c => c.dm_key === key);
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
  const personName = (p) => p?.full_name || p?.email || "Unknown user";
  const dmOther = (ch) => {
    const otherId = ch.dm_a === me ? ch.dm_b : ch.dm_a;
    return { id: otherId, name: personName(peopleById[otherId]) };
  };
  const convName = (ch) => ch.is_dm ? dmOther(ch).name : ch.name;
  const memberFirstNames = (ch) => (members[ch.id] || []).map(id => id === me ? "You" : personName(peopleById[id]).split(/\s+/)[0]);
  const dmByOther = useMemo(() => Object.fromEntries(channels.filter(c => c.is_dm).map(c => [c.dm_a === me ? c.dm_b : c.dm_a, c])), [channels, me]);
  const active = channels.find(c => c.id === activeId) || null;

  // Inbox: every conversation sorted by latest activity (Messenger-style).
  const conversations = useMemo(() => {
    const q = search.trim().toLowerCase();
    return channels
      .filter(ch => !q || convName(ch).toLowerCase().includes(q))
      .sort((a, b) => new Date(lastMsg[b.id]?.created_at || b.created_at) - new Date(lastMsg[a.id]?.created_at || a.created_at));
  }, [channels, lastMsg, search, peopleById]); // eslint-disable-line react-hooks/exhaustive-deps

  // People matching the search who don't have a DM yet → offer to start one.
  const searchPeople = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return [];
    return people.filter(p => p.id !== me && !dmByOther[p.id] && personName(p).toLowerCase().includes(q));
  }, [search, people, me, dmByOther]); // eslint-disable-line react-hooks/exhaustive-deps

  const activeNow = people.filter(p => p.id !== me && online.has(p.id));

  // ── Missing-tables banner ──────────────────────────────────────────────────
  if (missing) return (
    <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#854F0B" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>One-time setup needed</div>
      <div>Team chat needs its tables created once. Run this SQL in Supabase (SQL Editor), or run <code>node scripts/setup-chat.mjs</code>.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => { navigator.clipboard?.writeText([CHAT_SQL, CHAT_SQL_V2, CHAT_SQL_V3].join("\n\n")).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          {sqlCopied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={loadChannels} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — retry
        </button>
      </div>
    </div>
  );

  const otherOnline = active?.is_dm && online.has(dmOther(active).id);

  return (
    <>
    {receiptsMissing && (
      <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "8px 14px", marginBottom: 12, fontSize: 12.5, color: "#854F0B", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span>To enable read receipts and last connection, run this SQL once in Supabase (SQL Editor):</span>
        <button onClick={() => { navigator.clipboard?.writeText(CHAT_SQL_V2).then(() => { setV2Copied(true); setTimeout(() => setV2Copied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
          {v2Copied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={loadLastSeen} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — retry
        </button>
      </div>
    )}
    {groupsMissing && (
      <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "8px 14px", marginBottom: 12, fontSize: 12.5, color: "#854F0B", display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
        <span>To create private groups with selected members, run this SQL once in Supabase (SQL Editor):</span>
        <button onClick={() => { navigator.clipboard?.writeText(CHAT_SQL_V3).then(() => { setV3Copied(true); setTimeout(() => setV3Copied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
          {v3Copied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={() => setGroupsMissing(false)} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "5px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — dismiss
        </button>
      </div>
    )}
    <div style={{ display: "flex", background: "#fff", border: "1px solid #efefef", borderRadius: 12, overflow: "hidden", height: "calc(100vh - 150px)", minHeight: 460 }}>

      {/* ── Inbox: conversation list ── */}
      <div style={{ width: 300, flexShrink: 0, borderRight: "1px solid #f0f0f0", display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "14px 14px 8px" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: 10 }}>
            <span style={{ flex: 1, fontSize: 19, fontWeight: 800, letterSpacing: "-0.02em" }}>Chats</span>
            <button onClick={openNewChat} title="New chat"
              style={{ width: 30, height: 30, borderRadius: "50%", border: "none", background: "#f2f2f4", cursor: "pointer", fontSize: 20, lineHeight: 1, color: "#333", display: "flex", alignItems: "center", justifyContent: "center", paddingBottom: 2 }}>+</button>
          </div>
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search chats…"
            style={{ width: "100%", boxSizing: "border-box", border: "none", outline: "none", background: "#f2f2f4", borderRadius: 18, padding: "8px 14px", fontSize: 13 }} />
        </div>

        {/* Active now (online teammates) */}
        {activeNow.length > 0 && (
          <div style={{ padding: "4px 14px 8px" }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: "#999", marginBottom: 6 }}>Active now</div>
            <div style={{ display: "flex", gap: 12, overflowX: "auto", paddingBottom: 2 }}>
              {activeNow.slice(0, 12).map(p => (
                <button key={p.id} onClick={() => openDm(p.id)} title={personName(p)}
                  style={{ border: "none", background: "transparent", cursor: "pointer", padding: 0, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, width: 48, flexShrink: 0 }}>
                  <Avatar id={p.id} name={personName(p)} size={40} online />
                  <span style={{ fontSize: 10.5, color: "#666", maxWidth: 48, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{personName(p).split(/\s+/)[0]}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        <div style={{ flex: 1, overflowY: "auto", padding: "2px 8px 10px" }}>
          {conversations.map(ch => {
            const isActive = ch.id === activeId;
            const last = lastMsg[ch.id];
            const n = unread[ch.id] || 0;
            const name = convName(ch);
            const preview = last ? `${last.sender_id === me ? "You: " : (!ch.is_dm ? `${(last.sender_name || "").split(/\s+/)[0]}: ` : "")}${last.body.replace(/\n/g, " ")}` : (ch.is_dm ? "Say hi 👋" : "No messages yet");
            return (
              <button key={ch.id} onClick={() => setActiveId(ch.id)}
                style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 10, border: "none", cursor: "pointer", textAlign: "left", background: isActive ? "#f0f6ff" : "transparent", marginBottom: 1 }}>
                {ch.is_dm
                  ? <Avatar id={dmOther(ch).id} name={name} size={44} online={online.has(dmOther(ch).id)} />
                  : <Avatar id={ch.id} name={name} size={44} group />}
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span style={{ display: "flex", alignItems: "baseline", gap: 6 }}>
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: n ? 800 : 600, color: "#111", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{name}</span>
                    <span style={{ fontSize: 11, color: n ? BLUE : "#aaa", fontWeight: n ? 700 : 400, flexShrink: 0 }}>{fmtListTime(last?.created_at)}</span>
                  </span>
                  <span style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 1 }}>
                    <span style={{ flex: 1, fontSize: 12.5, color: n ? "#111" : "#8a8d91", fontWeight: n ? 600 : 400, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{preview}</span>
                    {n > 0 && <span style={{ background: BLUE, color: "#fff", fontSize: 10, fontWeight: 700, borderRadius: 10, padding: "1px 6px", flexShrink: 0 }}>{n}</span>}
                  </span>
                </span>
              </button>
            );
          })}
          {searchPeople.length > 0 && (
            <>
              <div style={{ fontSize: 11, fontWeight: 600, color: "#999", padding: "10px 8px 4px" }}>People</div>
              {searchPeople.map(p => (
                <button key={p.id} onClick={() => openDm(p.id)}
                  style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "8px 8px", borderRadius: 10, border: "none", cursor: "pointer", textAlign: "left", background: "transparent" }}>
                  <Avatar id={p.id} name={personName(p)} size={36} online={online.has(p.id)} />
                  <span style={{ fontSize: 13.5, fontWeight: 600 }}>{personName(p)}</span>
                </button>
              ))}
            </>
          )}
          {conversations.length === 0 && searchPeople.length === 0 && (
            <div style={{ fontSize: 12.5, color: "#bbb", padding: "10px 8px" }}>No chats yet — tap + to start one.</div>
          )}
        </div>
      </div>

      {/* ── Conversation pane ── */}
      <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", background: "#fff" }}>
        {!active ? (
          <div style={{ flex: 1, display: "flex", alignItems: "center", justifyContent: "center", flexDirection: "column", gap: 8, color: "#bbb", fontSize: 14 }}>
            <span style={{ fontSize: 40 }}>💬</span>
            Pick a chat to start messaging
          </div>
        ) : (
          <>
            <div style={{ padding: "10px 16px", borderBottom: "1px solid #f0f0f0", display: "flex", alignItems: "center", gap: 10 }}>
              {active.is_dm
                ? <Avatar id={dmOther(active).id} name={convName(active)} size={36} online={otherOnline} />
                : <Avatar id={active.id} name={convName(active)} size={36} group />}
              <span style={{ minWidth: 0 }}>
                <span style={{ display: "block", fontSize: 14.5, fontWeight: 700, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{convName(active)}</span>
                <span style={{ display: "block", fontSize: 11.5, color: otherOnline ? "#31A24C" : "#999" }}>
                  {active.is_dm
                    ? (otherOnline
                      ? "Active now"
                      : lastSeen[dmOther(active).id]
                        ? <><span>Last seen</span>{" " + relTime(lastSeen[dmOther(active).id])}</>
                        : "Offline")
                    : active.is_private
                      ? memberFirstNames(active).join(", ") || "Private group"
                      : "Group chat · visible to the whole team"}
                </span>
              </span>
              {!active.is_dm && (isAdmin || active.created_by === me) && active.name !== "general" && (
                <button onClick={() => deleteChannel(active)} title="Delete group" style={{ marginLeft: "auto", border: "none", background: "transparent", cursor: "pointer", color: "#ccc", fontSize: 14 }}>🗑</button>
              )}
            </div>

            <div ref={scrollRef} style={{ flex: 1, overflowY: "auto", padding: "14px 16px", background: "#fff" }}>
              {loadingMsgs ? (
                <div style={{ color: "#bbb", fontSize: 13 }}>Loading…</div>
              ) : messages.length === 0 ? (
                <div style={{ color: "#bbb", fontSize: 13, textAlign: "center", marginTop: 30 }}>No messages yet. Say hi! 👋</div>
              ) : messages.map((m, i) => {
                const prev = messages[i - 1], next = messages[i + 1];
                const mine = m.sender_id === me;
                const newDay = !prev || fmtDay(prev.created_at) !== fmtDay(m.created_at);
                const gap = (a, b) => (new Date(b.created_at) - new Date(a.created_at)) > 5 * 60 * 1000;
                const runStart = newDay || !prev || prev.sender_id !== m.sender_id || gap(prev, m);
                const runEnd = !next || next.sender_id !== m.sender_id || gap(m, next) || fmtDay(next.created_at) !== fmtDay(m.created_at);
                const name = peopleById[m.sender_id]?.full_name || m.sender_name || "Unknown";
                // Messenger-style corner rounding within a run of bubbles.
                const r = 18, rs = 5;
                const radius = mine
                  ? `${r}px ${runStart ? r : rs}px ${runEnd ? r : rs}px ${r}px`
                  : `${runStart ? r : rs}px ${r}px ${r}px ${runEnd ? r : rs}px`;
                return (
                  <div key={m.id}>
                    {newDay && (
                      <div style={{ textAlign: "center", margin: "16px 0 10px" }}>
                        <span style={{ fontSize: 11, fontWeight: 600, color: "#aaa" }}>{fmtDay(m.created_at)} · {fmtTime(m.created_at)}</span>
                      </div>
                    )}
                    {!mine && !active.is_dm && runStart && (
                      <div style={{ fontSize: 11, color: "#8a8d91", margin: "6px 0 2px 46px" }}>{name}</div>
                    )}
                    <div onMouseEnter={e => { const b = e.currentTarget.querySelector(".msg-del"); if (b) b.style.opacity = 1; }}
                      onMouseLeave={e => { const b = e.currentTarget.querySelector(".msg-del"); if (b) b.style.opacity = 0; }}
                      style={{ display: "flex", justifyContent: mine ? "flex-end" : "flex-start", alignItems: "flex-end", gap: 8, marginTop: runStart ? (active.is_dm || mine ? 6 : 0) : 2 }}>
                      {!mine && (
                        <span style={{ width: 28, flexShrink: 0 }}>
                          {runEnd && <Avatar id={m.sender_id} name={name} size={28} />}
                        </span>
                      )}
                      {mine && (m.sender_id === me || isAdmin) && (
                        <button className="msg-del" onClick={() => deleteMessage(m.id)} title="Delete message"
                          style={{ opacity: 0, transition: "opacity .15s", border: "none", background: "transparent", cursor: "pointer", color: "#ccc", fontSize: 12 }}>✕</button>
                      )}
                      <div title={fmtTime(m.created_at)}
                        style={{ maxWidth: "62%", padding: "8px 12px", borderRadius: radius, background: mine ? BLUE : "#f0f0f2", color: mine ? "#fff" : "#111", fontSize: 13.5, lineHeight: 1.4, whiteSpace: "pre-wrap", wordBreak: "break-word" }}>
                        {m.body}
                      </div>
                      {!mine && isAdmin && (
                        <button className="msg-del" onClick={() => deleteMessage(m.id)} title="Delete message"
                          style={{ opacity: 0, transition: "opacity .15s", border: "none", background: "transparent", cursor: "pointer", color: "#ccc", fontSize: 12 }}>✕</button>
                      )}
                    </div>
                  </div>
                );
              })}
              {/* Receipt status under my last message: Sent ✓ → Delivered ✓✓ → Seen. */}
              {(() => {
                if (receiptsMissing || loadingMsgs || !messages.length) return null;
                const last = messages[messages.length - 1];
                if (last.sender_id !== me) return null;
                const line = (children) => (
                  <div style={{ display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 4, marginTop: 4, fontSize: 10.5, color: "#8a8d91" }}>{children}</div>
                );
                if (active.is_dm) {
                  const other = dmOther(active);
                  if (after(readBy[other.id], last.created_at)) return line(<>
                    <Avatar id={other.id} name={other.name} size={14} />
                    <span>Seen</span><span>{fmtTime(readBy[other.id])}</span>
                  </>);
                  if (online.has(other.id) || after(lastSeen[other.id], last.created_at))
                    return line(<><span style={{ color: BLUE }}>✓✓</span><span>Delivered</span></>);
                  return line(<><span>✓</span><span>Sent</span></>);
                }
                const readers = Object.entries(readBy)
                  .filter(([uid, t]) => after(t, last.created_at))
                  .map(([uid]) => (peopleById[uid]?.full_name || "?").split(/\s+/)[0]);
                if (!readers.length) return line(<><span>✓</span><span>Sent</span></>);
                return line(<>
                  <span>👁</span><span>Seen by</span>
                  <span>{readers.slice(0, 3).join(", ")}{readers.length > 3 ? ` +${readers.length - 3}` : ""}</span>
                </>);
              })()}
            </div>

            <div style={{ padding: "10px 14px 12px", borderTop: "1px solid #f0f0f0", display: "flex", gap: 8, alignItems: "flex-end" }}>
              <textarea
                value={draft}
                onChange={e => setDraft(e.target.value)}
                onKeyDown={e => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }}
                placeholder="Aa"
                rows={Math.min(5, Math.max(1, draft.split("\n").length))}
                style={{ flex: 1, border: "none", outline: "none", background: "#f2f2f4", borderRadius: 18, padding: "9px 14px", resize: "none", fontSize: 13.5, fontFamily: "inherit", lineHeight: 1.4 }}
              />
              <button onClick={send} disabled={!draft.trim() || sending} title="Send"
                style={{ width: 36, height: 36, borderRadius: "50%", border: "none", flexShrink: 0, cursor: draft.trim() ? "pointer" : "default", background: draft.trim() ? BLUE : "#e8e8ec", color: draft.trim() ? "#fff" : "#aaa", fontSize: 16, display: "flex", alignItems: "center", justifyContent: "center" }}>
                ➤
              </button>
            </div>
          </>
        )}
      </div>

      {/* ── New chat modal: tick people → 1 = DM, 2+ = private group ── */}
      {showNewChat && (() => {
        const sel = [...groupSel];
        const filtered = people.filter(p => p.id !== me && personName(p).toLowerCase().includes(newChatSearch.trim().toLowerCase()));
        const isGroup = sel.length >= 2;
        const canGo = sel.length >= 1;
        const btnLabel = sel.length <= 1
          ? (sel.length === 1 ? `Message ${personName(peopleById[sel[0]]).split(/\s+/)[0]}` : "Select people")
          : `Create group · ${sel.length}`;
        return (
        <div onClick={() => setShowNewChat(false)} style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.35)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "#fff", borderRadius: 14, padding: 18, width: 400, maxHeight: "76vh", display: "flex", flexDirection: "column", boxShadow: "0 12px 40px rgba(0,0,0,.18)" }}>
            <div style={{ fontSize: 15, fontWeight: 800, marginBottom: 4 }}>New chat</div>
            <div style={{ fontSize: 12, color: "#999", marginBottom: 10 }}>Pick one person for a direct message, or several for a private group.</div>

            {/* Selected chips */}
            {sel.length > 0 && (
              <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 10 }}>
                {sel.map(id => (
                  <span key={id} style={{ display: "inline-flex", alignItems: "center", gap: 5, background: "#eaf2ff", color: "#0a5fd0", borderRadius: 16, padding: "3px 6px 3px 8px", fontSize: 12, fontWeight: 600 }}>
                    {personName(peopleById[id]).split(/\s+/)[0]}
                    <button onClick={() => toggleSel(id)} title="Remove" style={{ border: "none", background: "transparent", cursor: "pointer", color: "#0a5fd0", fontSize: 13, lineHeight: 1, padding: 0 }}>×</button>
                  </span>
                ))}
              </div>
            )}

            <input autoFocus value={newChatSearch} onChange={e => setNewChatSearch(e.target.value)} placeholder="Search people…"
              style={{ border: "none", outline: "none", background: "#f2f2f4", borderRadius: 18, padding: "8px 14px", fontSize: 13, marginBottom: 10 }} />

            <div style={{ flex: 1, overflowY: "auto", minHeight: 140 }}>
              {filtered.map(p => {
                const on = groupSel.has(p.id);
                return (
                  <button key={p.id} onClick={() => toggleSel(p.id)}
                    style={{ width: "100%", display: "flex", alignItems: "center", gap: 10, padding: "7px 8px", borderRadius: 10, border: "none", cursor: "pointer", textAlign: "left", background: on ? "#f0f6ff" : "transparent" }}>
                    <Avatar id={p.id} name={personName(p)} size={34} online={online.has(p.id)} />
                    <span style={{ flex: 1, fontSize: 13.5, fontWeight: 600 }}>{personName(p)}</span>
                    {online.has(p.id) && <span style={{ fontSize: 11, color: "#31A24C" }}>Active now</span>}
                    <span style={{ width: 18, height: 18, borderRadius: "50%", border: on ? "none" : "1.5px solid #ccc", background: on ? BLUE : "transparent", color: "#fff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, flexShrink: 0 }}>{on ? "✓" : ""}</span>
                  </button>
                );
              })}
              {filtered.length === 0 && (
                <div style={{ fontSize: 12.5, color: "#bbb", padding: "6px 8px" }}>No teammates found.</div>
              )}
            </div>

            {isGroup && (
              <input value={newGroupName} onChange={e => setNewGroupName(e.target.value)}
                placeholder="Group name (optional)" style={{ border: "1px solid #e5e5e5", outline: "none", borderRadius: 10, padding: "8px 12px", fontSize: 13, marginTop: 10 }} />
            )}

            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 12 }}>
              <button onClick={() => setShowNewChat(false)} style={{ border: "1px solid #eee", background: "#fff", borderRadius: 10, padding: "8px 14px", fontSize: 13, cursor: "pointer", color: "#666" }}>Cancel</button>
              <button onClick={confirmNewChat} disabled={!canGo}
                style={{ border: "none", background: canGo ? BLUE : "#e8e8ec", color: canGo ? "#fff" : "#aaa", borderRadius: 10, padding: "8px 16px", fontSize: 13, fontWeight: 700, cursor: canGo ? "pointer" : "default" }}>{btnLabel}</button>
            </div>
          </div>
        </div>
        );
      })()}
    </div>
    </>
  );
}
