// In-memory stand-in for supabase-js, shared by scripts/test-bank-feed.mjs and
// scripts/plaid-sandbox-check.mjs. Not a test file itself (npm test runs only
// scripts/test-*.mjs).
import assert from "node:assert/strict";

// ── PostgREST-shaped fake ────────────────────────────────────────────────────
// The chain shapes lib/bankFeed.mjs uses: select (with count/head), insert,
// upsert (onConflict, ignoreDuplicates), update, delete; eq/in/gt/gte/not-is;
// order/limit; single/maybeSingle. Ids are identity-like; `unique` columns
// reject duplicates like a unique index; a missing table answers 42P01.
export function fakeDb(tables, unique = {}) {
  const db = structuredClone(tables);
  const seq = {};
  const nextId = (t) => (seq[t] = (seq[t] ?? Math.max(0, ...db[t].map((r) => Number(r.id) || 0))) + 1);
  const dup = (table, col, v, except = []) => v != null && db[table].some((x) => x[col] === v && !except.includes(x));
  function from(table) {
    const filters = [];
    let op = "select", payload = null, opts = {}, single = null, returning = false, order = null, limit = null, head = false;
    const b = {
      select(_cols, o = {}) { if (op === "select") head = !!o.head; else returning = true; return b; },
      insert(rows) { op = "insert"; payload = [].concat(rows); return b; },
      upsert(rows, o = {}) { op = "upsert"; payload = [].concat(rows); opts = o; return b; },
      update(p) { op = "update"; payload = p; return b; },
      delete() { op = "delete"; return b; },
      eq(c, v) { filters.push((r) => r[c] === v); return b; },
      in(c, vs) { filters.push((r) => vs.includes(r[c])); return b; },
      gt(c, v) { filters.push((r) => r[c] > v); return b; },
      gte(c, v) { filters.push((r) => r[c] >= v); return b; },
      not(c, o, v) { assert.equal(o, "is"); filters.push((r) => (v === null ? r[c] != null : r[c] !== v)); return b; },
      order(c, { ascending = true } = {}) { order = { c, ascending }; return b; },
      limit(n) { limit = n; return b; },
      single() { single = "one"; return b; },
      maybeSingle() { single = "maybe"; return b; },
      then(resolve, reject) { try { resolve(run()); } catch (e) { reject(e); } },
    };
    const run = () => {
      if (!db[table]) return { data: null, error: { code: "42P01", message: `relation "public.${table}" does not exist` } };
      let out;
      if (op === "insert" || op === "upsert") {
        out = [];
        for (const r of payload) {
          const ex = opts.onConflict ? db[table].find((x) => x[opts.onConflict] === r[opts.onConflict]) : null;
          if (ex) { if (!opts.ignoreDuplicates) { Object.assign(ex, r); out.push(ex); } continue; }
          for (const u of unique[table] || []) if (dup(table, u, r[u])) return { data: null, error: { code: "23505", message: `duplicate key value violates unique constraint (${u})` } };
          const row = { ...r, id: r.id ?? nextId(table) };
          db[table].push(row);
          out.push(row);
        }
      } else {
        const rows = db[table].filter((r) => filters.every((f) => f(r)));
        if (op === "update") {
          for (const u of unique[table] || []) if (payload[u] != null && (rows.length > 1 || dup(table, u, payload[u], rows))) return { data: null, error: { code: "23505", message: `duplicate key (${u})` } };
          rows.forEach((r) => Object.assign(r, payload));
          out = rows;
        } else if (op === "delete") {
          db[table] = db[table].filter((r) => !rows.includes(r));
          out = rows;
        } else {
          out = [...rows];
          if (order) out.sort((x, y) => (x[order.c] > y[order.c] ? 1 : x[order.c] < y[order.c] ? -1 : 0) * (order.ascending ? 1 : -1));
          if (limit != null) out = out.slice(0, limit);
        }
      }
      if (head) return { data: null, count: out.length, error: null };
      let data = op === "select" || returning ? out.map((r) => structuredClone(r)) : null;
      if (single) {
        if (single === "one" && data?.length !== 1) return { data: null, error: { code: "PGRST116", message: "JSON object requested, multiple (or no) rows returned" } };
        data = data?.[0] ?? null;
      }
      return { data, error: null };
    };
    return b;
  }
  return { from, db };
}
