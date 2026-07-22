// Session-scoped undo/redo manager over Supabase, backed by soft deletes
// (deleted_at) and an action_log audit table (see scripts/setup-undo.mjs).
//
// Every user-visible mutation gets recorded as a "step" — a labelled batch of
// entries {table, id, action, before, after}. Undo replays the batch backwards
// (restore before-values, un-delete soft-deleted rows); redo replays it forward.
// The stacks live in this browser session only, so two users never undo each
// other's work; the action_log table is the shared audit trail.

const uid = () => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;

// Postgres "column does not exist" for deleted_at → migration not applied yet.
const isMissingDeletedAt = (error) =>
  !!error && /deleted_at|column .* does not exist|42703|PGRST204/i.test(`${error.code || ""} ${error.message || ""}`);

export const UNDO_SETUP_HINT =
  "Run the migration first: SUPABASE_ACCESS_TOKEN=sbp_xxx node scripts/setup-undo.mjs (adds deleted_at + action_log).";

export function createUndoManager(supabase) {
  const undoStack = [];
  const redoStack = [];
  const listeners = new Set();
  let userEmail = null;
  let auditAvailable = true; // flips off after the first failed action_log insert

  const notify = () => listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } });

  async function audit(rows) {
    if (!auditAvailable || !rows.length) return;
    try {
      const { error } = await supabase.from("action_log").insert(rows);
      if (error) auditAvailable = false;
    } catch { auditAvailable = false; }
  }

  function auditRowsFor(step, kind) {
    return step.entries.map((e) => ({
      batch_id: step.batchId,
      entity: e.table,
      entity_id: String(e.id),
      action: kind || e.action,
      label: step.label || null,
      before: e.before ?? null,
      after: e.after ?? null,
      user_email: userEmail,
    }));
  }

  // Record an already-performed batch of mutations as one undoable step.
  function record(label, entries) {
    const clean = (entries || []).filter(Boolean);
    if (!clean.length) return;
    const step = { label, entries: clean, batchId: uid() };
    undoStack.push(step);
    if (undoStack.length > 100) undoStack.shift();
    redoStack.length = 0;
    audit(auditRowsFor(step));
    notify();
  }

  // ── Helpers that mutate AND build entries ──────────────────────────────────

  // Soft-delete rows (by id, or by another FK column). Returns { error, entries }.
  // Refuses to fall back to a physical delete: if deleted_at is missing the
  // caller must run the migration first.
  async function softDelete(table, ids, col = "id") {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null);
    if (!list.length) return { error: null, entries: [] };
    // Only rows not already in the trash — re-deleting an old soft-deleted row
    // would wrongly pull it into this undo step.
    const { data: before, error: selErr } = await supabase.from(table).select("*").in(col, list).is("deleted_at", null);
    if (selErr) return { error: isMissingDeletedAt(selErr) ? { ...selErr, message: `Soft delete unavailable on "${table}". ${UNDO_SETUP_HINT}` } : selErr, entries: [] };
    if (!before || !before.length) return { error: null, entries: [] };
    const now = new Date().toISOString();
    const rowIds = before.map((r) => r.id);
    const { error } = await supabase.from(table).update({ deleted_at: now }).in("id", rowIds);
    if (error) {
      if (isMissingDeletedAt(error)) return { error: { ...error, message: `Soft delete unavailable on "${table}". ${UNDO_SETUP_HINT}` }, entries: [] };
      return { error, entries: [] };
    }
    return {
      error: null,
      entries: before.map((r) => ({ table, id: r.id, action: "delete", before: r, after: { ...r, deleted_at: now } })),
    };
  }

  // Restore soft-deleted rows. Returns { error, entries }.
  async function restore(table, ids) {
    const list = (Array.isArray(ids) ? ids : [ids]).filter((v) => v != null);
    if (!list.length) return { error: null, entries: [] };
    const { data: before } = await supabase.from(table).select("*").in("id", list);
    const { error } = await supabase.from(table).update({ deleted_at: null }).in("id", list);
    if (error) return { error, entries: [] };
    return {
      error: null,
      entries: (before || []).map((r) => ({ table, id: r.id, action: "restore", before: r, after: { ...r, deleted_at: null } })),
    };
  }

  // Build an update entry from the previous row + the patch that was applied.
  // (The caller performs the actual update; this only captures before/after.)
  function updateEntry(table, prevRow, patch) {
    if (!prevRow || !patch) return null;
    const before = {};
    for (const k of Object.keys(patch)) before[k] = prevRow[k] ?? null;
    return { table, id: prevRow.id, action: "update", before, after: { ...patch } };
  }

  // Build a create entry from the inserted row (needs the row back from .select()).
  function createEntry(table, row) {
    return row && row.id != null ? { table, id: row.id, action: "create", before: null, after: row } : null;
  }

  // ── Undo / redo ────────────────────────────────────────────────────────────

  async function applyEntry(e, direction) {
    const t = supabase.from(e.table);
    if (e.action === "update" || e.action === "restore" || e.action === "delete") {
      if (e.action === "update") {
        const patch = direction === "undo" ? e.before : e.after;
        return (await t.update(patch).eq("id", e.id)).error;
      }
      // delete / restore: only the deleted_at flag flips.
      const wasDeleted = e.action === "delete";
      const setDeleted = direction === "undo" ? !wasDeleted : wasDeleted;
      return (await t.update({ deleted_at: setDeleted ? (e.after?.deleted_at || new Date().toISOString()) : null }).eq("id", e.id)).error;
    }
    if (e.action === "create") {
      if (direction === "undo") {
        // Reverting a create = soft-delete the new row.
        const { error } = await t.update({ deleted_at: new Date().toISOString() }).eq("id", e.id);
        if (error && isMissingDeletedAt(error)) return (await supabase.from(e.table).delete().eq("id", e.id)).error;
        return error;
      }
      return (await t.update({ deleted_at: null }).eq("id", e.id)).error;
    }
    return null;
  }

  async function replay(fromStack, toStack, direction, kind) {
    const step = fromStack.pop();
    if (!step) return null;
    let firstError = null;
    const entries = direction === "undo" ? [...step.entries].reverse() : step.entries;
    for (const e of entries) {
      const err = await applyEntry(e, direction);
      if (err && !firstError) firstError = err;
    }
    toStack.push(step);
    audit([{ batch_id: step.batchId, entity: "*", entity_id: "*", action: kind, label: step.label || null, before: null, after: null, user_email: userEmail }]);
    notify();
    return { label: step.label, error: firstError, tables: [...new Set(step.entries.map((e) => e.table))] };
  }

  return {
    setUser(email) { userEmail = email || null; },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    canUndo: () => undoStack.length > 0,
    canRedo: () => redoStack.length > 0,
    peekUndoLabel: () => undoStack[undoStack.length - 1]?.label || null,
    peekRedoLabel: () => redoStack[redoStack.length - 1]?.label || null,
    record,
    softDelete,
    restore,
    updateEntry,
    createEntry,
    undo: () => replay(undoStack, redoStack, "undo", "undo"),
    redo: () => replay(redoStack, undoStack, "redo", "redo"),
  };
}
