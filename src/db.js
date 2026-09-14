// Supabase / PostgREST helpers shared by every module.
//
// PostgREST caps every response at the project's max-rows setting (1000 on
// Supabase by default) and says nothing when it does: a table that grows past
// it silently drops its oldest rows from the UI. Every "load the whole table"
// query goes through selectAll, which pages until a short page comes back.
// Tables under the cap still cost exactly one request, same as before.
import { tr } from "./i18n.js";

export const PAGE_SIZE = 1000;

// `build` returns a fresh query (from().select().order()) on every call —
// builders are mutable, so each page needs its own. The tiebreak column keeps
// pages stable when the caller's order column has duplicates (names, dates);
// pass { tiebreak: null } when the query already orders by a unique column.
// Resolves to the same { data, error } shape as a plain query.
export async function selectAll(build, { tiebreak = "id", pageSize = PAGE_SIZE } = {}) {
  const rows = [];
  for (let from = 0; ; from += pageSize) {
    let q = build();
    if (tiebreak) q = q.order(tiebreak, { ascending: true });
    const { data, error } = await q.range(from, from + pageSize - 1);
    if (error) return { data: null, error };
    rows.push(...(data || []));
    if (!data || data.length < pageSize) break;
  }
  return { data: rows, error: null };
}

// A write that fails must never look like it saved. supabase-js resolves a
// failed mutation to { error } instead of throwing, so a bare `await` swallows
// it and the UI carries on as if the row were stored. Every fire-and-forget
// mutation goes through here:
//
//   if (dbFailed(await supabase.from("drivers").update(p).eq("id", id), "drivers")) return;
//
// It logs the Postgres error, tells the user (alert — it must not be missed —
// with the table so they can say what broke) and returns true so the caller
// stops instead of closing the modal / reloading over a phantom save.
// `quiet` skips the alert for background loops (backfills, auto-generation)
// that would otherwise nag on every render; they still log and stop.
export function dbFailed(res, what, { quiet = false } = {}) {
  const error = res?.error;
  if (!error) return false;
  const msg = error.message || error.details || error.code || String(error);
  console.error(`[db] write failed${what ? ` (${what})` : ""}:`, error);
  if (!quiet && typeof window !== "undefined" && typeof window.alert === "function") {
    window.alert(`${tr("Could not save", "No se pudo guardar")}${what ? ` (${what})` : ""}: ${msg}`);
  }
  return true;
}
