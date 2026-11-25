/** PostgREST caps every response at api.max_rows (1,000 by default): page size must not exceed it. */
export const MAX_ROWS = 1000;

/**
 * Reads every row of a query with keyset pagination. `page(after, limit)` must run the same query ordered by a
 * unique key, returning at most `limit` rows that come after the row `after` (all rows from the start when `after`
 * is null), e.g. `.order("path").gt("path", after.path).limit(limit)`. Unlike offset paging, rows added or deleted
 * between two page requests never make a later page skip or repeat a row. Paging stops at the first short page or
 * at the first error.
 */
export async function fetchAllPages<T>(
  page: (after: T | null, limit: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = MAX_ROWS,
): Promise<{ data: T[]; error: { message: string } | null }> {
  // a page over the cap comes back capped (and so "short"), which would end paging early
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > MAX_ROWS) throw new RangeError(`pageSize must be an integer from 1 to ${MAX_ROWS}`);
  const out: T[] = [];
  for (let after: T | null = null; ; ) {
    const { data, error } = await page(after, pageSize);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: out, error: null };
    after = data[data.length - 1]!;
  }
}
