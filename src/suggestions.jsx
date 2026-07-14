// Suggestions: an internal suggestion box where any employee can post feedback
// and improvement ideas ("what works / what doesn't"), vote on teammates'
// suggestions, and admins triage them (In review / Implemented / Rejected)
// with an optional written response. Tables: suggestions, suggestion_votes.
import { useState, useEffect, useCallback, useMemo } from "react";

// Shown in the setup banner when the tables don't exist yet.
// Keep in sync with scripts/setup-suggestions.mjs (the one-time migration).
export const SUGGESTIONS_SQL = `create table if not exists public.suggestions (
  id bigint generated always as identity primary key,
  created_by uuid references public.profiles(id) on delete set null,
  author_name text,
  category text default 'Other',
  body text not null,
  is_anonymous boolean not null default false,
  status text not null default 'new' check (status in ('new','reviewing','implemented','rejected')),
  admin_note text,
  created_at timestamptz not null default now()
);
create table if not exists public.suggestion_votes (
  suggestion_id bigint not null references public.suggestions(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (suggestion_id, user_id)
);
alter table public.suggestions enable row level security;
alter table public.suggestion_votes enable row level security;
drop policy if exists "suggestions_select" on public.suggestions;
create policy "suggestions_select" on public.suggestions
  for select to authenticated using (true);
drop policy if exists "suggestions_insert" on public.suggestions;
create policy "suggestions_insert" on public.suggestions
  for insert to authenticated with check (created_by = auth.uid());
drop policy if exists "suggestions_update" on public.suggestions;
create policy "suggestions_update" on public.suggestions
  for update to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "suggestions_delete" on public.suggestions;
create policy "suggestions_delete" on public.suggestions
  for delete to authenticated using (created_by = auth.uid() or public.is_admin());
drop policy if exists "suggestion_votes_select" on public.suggestion_votes;
create policy "suggestion_votes_select" on public.suggestion_votes
  for select to authenticated using (true);
drop policy if exists "suggestion_votes_own" on public.suggestion_votes;
create policy "suggestion_votes_own" on public.suggestion_votes
  for all to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());
do $$ begin alter publication supabase_realtime add table public.suggestions; exception when others then null; end $$;
do $$ begin alter publication supabase_realtime add table public.suggestion_votes; exception when others then null; end $$;`;

const CATEGORIES = ["Operations", "Dispatching", "Storage", "Billing / Payments", "CRM / System", "Team", "Other"];
const STATUS_META = {
  new:         { label: "New",         bg: "#EAF1F8", color: "#185FA5" },
  reviewing:   { label: "In review",   bg: "#FAEEDA", color: "#B45309" },
  implemented: { label: "Implemented", bg: "#EAF3DE", color: "#3B6D11" },
  rejected:    { label: "Rejected",    bg: "#FCEBEB", color: "#A32D2D" },
};
const STATUS_ORDER = ["new", "reviewing", "implemented", "rejected"];

const fmtDate = (ts) => new Date(ts).toLocaleDateString([], { year: "numeric", month: "short", day: "numeric" });
const chip = (bg, color) => ({ display: "inline-block", fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: bg, color });
const card = { background: "#fff", border: "1px solid #efefef", borderRadius: 12, padding: "16px 18px" };
const inp = { width: "100%", boxSizing: "border-box", border: "1px solid #e5e5e5", borderRadius: 8, padding: "9px 12px", fontSize: 13, outline: "none", background: "#fff" };
const btn = (primary) => ({ padding: "8px 14px", borderRadius: 8, border: primary ? "none" : "1px solid #e5e5e5", background: primary ? "#111" : "#fff", color: primary ? "#fff" : "#444", fontSize: 13, fontWeight: 600, cursor: "pointer" });

export function SuggestionsSection({ supabase, session, profile, isAdmin = false }) {
  const me = session.user.id;
  const myName = profile?.full_name || session.user.email;

  const [missing, setMissing] = useState(false);   // tables not created yet
  const [sqlCopied, setSqlCopied] = useState(false);
  const [rows, setRows] = useState([]);            // suggestions, newest first
  const [votes, setVotes] = useState([]);          // all suggestion_votes rows
  const [loading, setLoading] = useState(true);

  // Submit form
  const [body, setBody] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0]);
  const [anonymous, setAnonymous] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState(null);

  // List controls
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortBy, setSortBy] = useState("recent");  // recent | votes
  const [noteEditId, setNoteEditId] = useState(null); // suggestion being answered by an admin
  const [noteDraft, setNoteDraft] = useState("");

  const isMissingErr = (error) => error && (error.code === "42P01" || /suggestion/.test(error.message || ""));

  const load = useCallback(async () => {
    const { data, error } = await supabase.from("suggestions").select("*").order("created_at", { ascending: false });
    if (isMissingErr(error)) { setMissing(true); setLoading(false); return; }
    setMissing(false);
    setRows(data || []);
    const { data: v } = await supabase.from("suggestion_votes").select("suggestion_id, user_id");
    setVotes(v || []);
    setLoading(false);
  }, [supabase]);

  // Probe the tables; if missing, try to self-create through an exec_sql RPC
  // (same convention as the other CRM modules), else show the setup banner.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const { error } = await supabase.from("suggestions").select("id").limit(1);
      if (cancelled) return;
      if (!error) { load(); return; }
      let created = false;
      for (const fn of ["exec_sql", "exec", "execute_sql"]) {
        const { error: rpcErr } = await supabase.rpc(fn, { sql: SUGGESTIONS_SQL });
        if (!rpcErr) { created = true; break; }
      }
      if (cancelled) return;
      if (created) load(); else { setMissing(true); setLoading(false); }
    })();
    return () => { cancelled = true; };
  }, [supabase, load]);

  useEffect(() => {
    if (missing) return;
    const channel = supabase.channel("suggestions-realtime")
      .on("postgres_changes", { event: "*", schema: "public", table: "suggestions" }, () => load())
      .on("postgres_changes", { event: "*", schema: "public", table: "suggestion_votes" }, () => load())
      .subscribe();
    return () => supabase.removeChannel(channel);
  }, [supabase, missing, load]);

  const voteCount = useMemo(() => {
    const m = {};
    for (const v of votes) m[v.suggestion_id] = (m[v.suggestion_id] || 0) + 1;
    return m;
  }, [votes]);
  const myVotes = useMemo(() => new Set(votes.filter(v => v.user_id === me).map(v => v.suggestion_id)), [votes, me]);
  const statusCounts = useMemo(() => {
    const m = { all: rows.length };
    for (const r of rows) m[r.status] = (m[r.status] || 0) + 1;
    return m;
  }, [rows]);

  const visible = useMemo(() => {
    const list = rows.filter(r => statusFilter === "all" || r.status === statusFilter);
    if (sortBy === "votes") return [...list].sort((a, b) => (voteCount[b.id] || 0) - (voteCount[a.id] || 0));
    return list;
  }, [rows, statusFilter, sortBy, voteCount]);

  async function submit() {
    const text = body.trim();
    if (!text) { setErr("Write your suggestion first."); return; }
    setSaving(true); setErr(null);
    const { error } = await supabase.from("suggestions").insert({
      created_by: me,
      author_name: anonymous ? null : myName,
      category,
      body: text,
      is_anonymous: anonymous,
    });
    setSaving(false);
    if (error) { setErr(error.message); return; }
    setBody(""); setAnonymous(false);
    load();
  }

  async function toggleVote(s) {
    if (myVotes.has(s.id)) await supabase.from("suggestion_votes").delete().eq("suggestion_id", s.id).eq("user_id", me);
    else await supabase.from("suggestion_votes").insert({ suggestion_id: s.id, user_id: me });
    load();
  }

  async function setStatus(s, status) {
    await supabase.from("suggestions").update({ status }).eq("id", s.id);
    load();
  }

  async function saveNote(s) {
    await supabase.from("suggestions").update({ admin_note: noteDraft.trim() || null }).eq("id", s.id);
    setNoteEditId(null); setNoteDraft("");
    load();
  }

  async function remove(s) {
    if (!window.confirm("Delete this suggestion?")) return;
    await supabase.from("suggestions").delete().eq("id", s.id);
    load();
  }

  // ── Missing-tables banner ──────────────────────────────────────────────────
  if (missing) return (
    <div style={{ background: "#FAEEDA", border: "1px solid #EF9F27", borderRadius: 10, padding: "14px 16px", fontSize: 13, color: "#854F0B" }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>One-time setup needed</div>
      <div>The suggestion box needs its tables created once. Run this SQL in Supabase (SQL Editor), or run <code>node scripts/setup-suggestions.mjs</code>.</div>
      <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
        <button onClick={() => { navigator.clipboard?.writeText(SUGGESTIONS_SQL).then(() => { setSqlCopied(true); setTimeout(() => setSqlCopied(false), 1500); }); }}
          style={{ background: "#854F0B", border: "none", color: "#fff", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          {sqlCopied ? "Copied!" : "Copy SQL"}
        </button>
        <button onClick={load} style={{ background: "#fff", border: "1px solid #EF9F27", color: "#854F0B", fontWeight: 600, borderRadius: 7, padding: "6px 12px", cursor: "pointer", fontSize: 12 }}>
          I ran it — retry
        </button>
      </div>
    </div>
  );

  return (
    <div style={{ maxWidth: 860 }}>
      {/* ── Submit a suggestion ── */}
      <div style={{ ...card, marginBottom: 16 }}>
        <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>💡 Share a suggestion</div>
        <div style={{ fontSize: 12.5, color: "#999", marginBottom: 12 }}>
          Tell us what's working, what isn't, and what you'd change — ideas here go straight to management.
        </div>
        <textarea rows={3} value={body} onChange={e => { setBody(e.target.value); setErr(null); }}
          placeholder="Your idea or feedback… e.g. 'The pickup calendar should show the driver's phone'"
          style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
        <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 10, flexWrap: "wrap" }}>
          <select value={category} onChange={e => setCategory(e.target.value)} style={{ ...inp, width: "auto", padding: "8px 10px" }}>
            {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <label style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "#666", cursor: "pointer" }}>
            <input type="checkbox" checked={anonymous} onChange={e => setAnonymous(e.target.checked)} />
            Post without my name
          </label>
          <div style={{ flex: 1 }} />
          {err && <span style={{ fontSize: 12, color: "#b91c1c" }}>{err}</span>}
          <button style={btn(true)} disabled={saving} onClick={submit}>{saving ? "Sending…" : "Send suggestion"}</button>
        </div>
      </div>

      {/* ── Filters ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 12, flexWrap: "wrap" }}>
        {["all", ...STATUS_ORDER].map(s => {
          const active = statusFilter === s;
          const label = s === "all" ? "All" : STATUS_META[s].label;
          const n = statusCounts[s] || 0;
          return (
            <button key={s} onClick={() => setStatusFilter(s)}
              style={{ padding: "6px 12px", borderRadius: 20, border: "1px solid " + (active ? "#111" : "#e5e5e5"), background: active ? "#111" : "#fff", color: active ? "#fff" : "#555", fontSize: 12, fontWeight: 600, cursor: "pointer" }}>
              {label}{n > 0 ? ` (${n})` : ""}
            </button>
          );
        })}
        <div style={{ flex: 1 }} />
        <select value={sortBy} onChange={e => setSortBy(e.target.value)} style={{ ...inp, width: "auto", padding: "7px 10px", fontSize: 12 }}>
          <option value="recent">Most recent</option>
          <option value="votes">Most voted</option>
        </select>
      </div>

      {/* ── List ── */}
      {loading ? (
        <div style={{ ...card, color: "#999", fontSize: 13 }}>Loading...</div>
      ) : visible.length === 0 ? (
        <div style={{ ...card, textAlign: "center", padding: "36px 18px" }}>
          <div style={{ fontSize: 28, marginBottom: 8 }}>📬</div>
          <div style={{ fontSize: 14, fontWeight: 600 }}>{statusFilter !== "all" ? "No suggestions in this status" : "No suggestions yet"}</div>
          <div style={{ fontSize: 12.5, color: "#999", marginTop: 4 }}>Be the first — every idea helps us improve.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {visible.map(s => {
            const st = STATUS_META[s.status] || STATUS_META.new;
            const mine = s.created_by === me;
            const n = voteCount[s.id] || 0;
            const voted = myVotes.has(s.id);
            return (
              <div key={s.id} style={card}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={chip("#f2f2f4", "#555")}>{s.category || "Other"}</span>
                  {isAdmin ? (
                    <select value={s.status} onChange={e => setStatus(s, e.target.value)}
                      style={{ ...chip(st.bg, st.color), border: "none", cursor: "pointer", outline: "none", appearance: "auto" }}>
                      {STATUS_ORDER.map(k => <option key={k} value={k}>{STATUS_META[k].label}</option>)}
                    </select>
                  ) : (
                    <span style={chip(st.bg, st.color)}>{st.label}</span>
                  )}
                  <div style={{ flex: 1 }} />
                  <span style={{ fontSize: 11.5, color: "#aaa" }}>
                    {s.is_anonymous ? "Anonymous" : (s.author_name || "Unknown")}{mine ? " (you)" : ""} · {fmtDate(s.created_at)}
                  </span>
                </div>
                <div style={{ fontSize: 13.5, color: "#333", lineHeight: 1.55, marginTop: 10, whiteSpace: "pre-wrap" }}>{s.body}</div>

                {s.admin_note && noteEditId !== s.id && (
                  <div style={{ marginTop: 10, background: "#f8f8f6", borderLeft: "3px solid #111", borderRadius: "0 8px 8px 0", padding: "8px 12px", fontSize: 12.5, color: "#555" }}>
                    <span style={{ fontWeight: 700, color: "#111" }}>Management reply: </span>{s.admin_note}
                  </div>
                )}

                {noteEditId === s.id && (
                  <div style={{ marginTop: 10 }}>
                    <textarea rows={2} value={noteDraft} onChange={e => setNoteDraft(e.target.value)} autoFocus
                      placeholder="Reply to the team about this suggestion…" style={{ ...inp, resize: "vertical", fontFamily: "inherit" }} />
                    <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", marginTop: 6, flexWrap: "wrap" }}>
                      <button style={btn(false)} onClick={() => { setNoteEditId(null); setNoteDraft(""); }}>Cancel</button>
                      <button style={btn(true)} onClick={() => saveNote(s)}>Save reply</button>
                    </div>
                  </div>
                )}

                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
                  <button onClick={() => toggleVote(s)} title={voted ? "Remove my vote" : "Vote for this"}
                    style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "5px 12px", borderRadius: 20, border: "1px solid " + (voted ? "#111" : "#e5e5e5"), background: voted ? "#111" : "#fff", color: voted ? "#fff" : "#555", fontSize: 12.5, fontWeight: 600, cursor: "pointer" }}>
                    👍 {n > 0 ? n : ""}
                  </button>
                  <div style={{ flex: 1 }} />
                  {isAdmin && noteEditId !== s.id && (
                    <button style={{ ...btn(false), padding: "5px 12px", fontSize: 12 }}
                      onClick={() => { setNoteEditId(s.id); setNoteDraft(s.admin_note || ""); }}>
                      {s.admin_note ? "Edit reply" : "Reply"}
                    </button>
                  )}
                  {(mine || isAdmin) && (
                    <button style={{ ...btn(false), padding: "5px 12px", fontSize: 12, color: "#A32D2D" }} onClick={() => remove(s)}>Delete</button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
