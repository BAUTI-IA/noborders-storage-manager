// Supabase / PostgREST helpers shared by every module.
//
// PostgREST caps every response at the project's max-rows setting (1000 on
// Supabase by default) and says nothing when it does: a table that grows past
// it silently drops its oldest rows from the UI. Every "load the whole table"
// query goes through selectAll, which pages until a short page comes back.
// Tables under the cap still cost exactly one request, same as before.
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
