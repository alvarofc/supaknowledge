// Embeddings with the Edge Runtime's built-in gte-small model (384 dims): no API key, no extra cost.
// To switch providers, replace this module and migrate the vector(384) columns.

// deno-lint-ignore no-explicit-any
declare const Supabase: any;

let session: { run: (input: string, opts: { mean_pool: boolean; normalize: boolean }) => Promise<number[]> } | null = null;

export const EMBEDDING_DIMS = 384;

export async function embed(text: string): Promise<number[]> {
  session ??= new Supabase.ai.Session("gte-small");
  const input = text.replace(/\s+/g, " ").trim().slice(0, 4000) || " ";
  const out = await session!.run(input, { mean_pool: true, normalize: true });
  return Array.from(out as ArrayLike<number>);
}

/** pgvector literal for PostgREST / RPC parameters */
export function toVector(v: number[] | null): string | null {
  return v ? `[${v.join(",")}]` : null;
}
