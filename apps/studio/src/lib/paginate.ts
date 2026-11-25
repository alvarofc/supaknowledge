/** PostgREST caps every response at api.max_rows (1,000 by default): page size must not exceed it. */
export const MAX_ROWS = 1000;

/**
 * Reads every row of a query by paging with .range(). `page(from, to)` must run the same, deterministically
 * ordered query for the inclusive row range; paging stops at the first short page or at the first error.
 */
export async function fetchAllPages<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  pageSize = MAX_ROWS,
): Promise<{ data: T[]; error: { message: string } | null }> {
  const out: T[] = [];
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await page(from, from + pageSize - 1);
    if (error) return { data: out, error };
    out.push(...(data ?? []));
    if (!data || data.length < pageSize) return { data: out, error: null };
  }
}
