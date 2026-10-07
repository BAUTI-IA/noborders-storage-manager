// Pure @mention logic for dispatch notes and the notifications bell.
// No React, no Supabase — tested by scripts/test-notifications-data.mjs.
//
// A teammate is addressed by their display label (full name, or the email's
// local part when the profile has no name). A unique first name works too, so
// "@Yancy" reaches "Yancy Perez" — unless two teammates share that first name,
// in which case only the full label is unambiguous.

export const personLabel = (p) =>
  (p?.full_name || "").trim() || (p?.email || "").split("@")[0] || "user";

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const norm = (s) => String(s || "").trim().toLowerCase();

// Every spelling that points at exactly one teammate: name → person.
// Full labels always win; first names are added only when no other teammate
// has the same first name (or the same full label).
export function mentionAliases(people) {
  const map = new Map();
  for (const p of people || []) map.set(norm(personLabel(p)), p);
  const firstCount = new Map();
  for (const p of people || []) {
    const first = norm(personLabel(p)).split(/\s+/)[0];
    firstCount.set(first, (firstCount.get(first) || 0) + 1);
  }
  for (const p of people || []) {
    const first = norm(personLabel(p)).split(/\s+/)[0];
    if (first && firstCount.get(first) === 1 && !map.has(first)) map.set(first, p);
  }
  return map;
}

// "@" + any alias, longest first so a two-word name matches whole instead of
// stopping at its first token. Exactly one capture group (the name), so
// String.split(re) alternates plain text / mentioned name. The lookahead stops
// "@Ana" from matching inside "@Anabella".
export function mentionPattern(people) {
  const names = [...mentionAliases(people).keys()].filter(Boolean).sort((a, b) => b.length - a.length);
  if (!names.length) return null;
  return new RegExp("@(" + names.map(escapeRe).join("|") + ")(?![\\p{L}\\p{N}_])", "giu");
}

// Profile ids of every teammate written as @name in the text, in order, once.
export function findMentionedIds(text, people) {
  const re = mentionPattern(people);
  if (!re) return [];
  const aliases = mentionAliases(people);
  const ids = [];
  for (const m of String(text || "").matchAll(re)) {
    const p = aliases.get(norm(m[1]));
    if (p && !ids.includes(p.id)) ids.push(p.id);
  }
  return ids;
}

// The note as stored plus who it alerts. Teammates picked with the Alert chips
// are written into the text as @name (so the thread reads right later); the
// ones already typed as @name are not written twice. The author never alerts
// themself.
export function composeNote(body, people, chipIds = [], selfId = null) {
  const text = String(body || "").trim();
  const typed = findMentionedIds(text, people);
  const byId = new Map((people || []).map(p => [p.id, p]));
  const prefix = chipIds.filter(id => byId.has(id) && !typed.includes(id));
  const stored = prefix.length ? `${prefix.map(id => "@" + personLabel(byId.get(id))).join(" ")} ${text}` : text;
  const taggedIds = [...new Set([...prefix, ...typed])].filter(id => id !== selfId);
  return { stored, taggedIds };
}

// The half-typed mention at the end of the draft ("Call @Yan" → "Yan"), or
// null when the draft doesn't end in one. A space ends the query only when no
// teammate's name continues with it ("@Yancy P" still completes "Yancy Perez").
export function mentionQuery(draft, people = []) {
  const s = String(draft || "");
  const at = s.lastIndexOf("@");
  if (at < 0 || (at > 0 && !/\s/.test(s[at - 1]))) return null;
  const q = s.slice(at + 1);
  if (/\n/.test(q)) return null;
  if (!/\s/.test(q)) return q;
  const lq = q.toLowerCase();
  return (people || []).some(p => norm(personLabel(p)).startsWith(lq)) ? q : null;
}

// Teammates matching a mention query (prefix of the full label or of any word
// in it). Hidden once the query already spells the only match out in full.
export function mentionSuggestions(query, people, selfId = null, limit = 6) {
  if (query == null) return [];
  const q = norm(query);
  const list = (people || []).filter(p => p.id !== selfId).filter(p => {
    const label = norm(personLabel(p));
    return !q || label.startsWith(q) || label.split(/\s+/).some(w => w.startsWith(q));
  });
  if (list.length === 1 && mentionAliases(people).get(q) === list[0]) return [];
  return list.slice(0, limit);
}

// Replace the trailing half-typed mention with the full "@Label ".
export function applyMention(draft, person) {
  const s = String(draft || "");
  const at = s.lastIndexOf("@");
  if (at < 0) return s;
  return s.slice(0, at) + "@" + personLabel(person) + " ";
}

// Bell badge text: exact up to 9, then "9+" so it fits the dot.
export const badgeText = (n) => (n > 9 ? "9+" : String(n || 0));
