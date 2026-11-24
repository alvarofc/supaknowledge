import { Search } from "lucide-react";
import { Link } from "@/components/ui/link";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/form";
import { errorMessage, timeAgo } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";

type Hit = { document_id: string; source_id: string; title: string; url: string; snippet: string; changed_at: string; score: number };

/** Full-text search over raw documents (search_sources without an embedding = FTS only). */
export function DocumentSearch({ spaceId, sourceId, base }: { spaceId: string; sourceId?: string; base: string }) {
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<Hit[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function search(e: React.FormEvent) {
    e.preventDefault();
    if (!q.trim()) {
      setHits(null);
      return;
    }
    setPending(true);
    setError(null);
    const { data, error: err } = await createClient().rpc("search_sources", { p_space: spaceId, p_query: q.trim(), p_limit: 25 });
    setPending(false);
    if (err) {
      setError(errorMessage(err));
      return;
    }
    setHits(((data ?? []) as Hit[]).filter((h) => !sourceId || h.source_id === sourceId));
  }

  return (
    <div className="flex flex-col gap-3">
      <form onSubmit={search} role="search" className="flex gap-2">
        <label htmlFor="doc-search" className="sr-only">
          Search documents
        </label>
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-subtle" />
          <Input id="doc-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search document text…" className="pl-8" />
        </div>
        <Button type="submit" pending={pending}>
          Search
        </Button>
        {hits ? (
          <Button
            variant="ghost"
            onClick={() => {
              setHits(null);
              setQ("");
            }}
          >
            Clear
          </Button>
        ) : null}
      </form>
      {error ? <p className="text-sm text-danger">{error}</p> : null}
      {hits ? (
        hits.length === 0 ? (
          <p className="text-sm text-muted">No documents match “{q}”. Documents are searchable after they are chunked by the embed worker.</p>
        ) : (
          <ul className="divide-y divide-line rounded-md border border-line">
            {hits.map((h) => (
              <li key={h.document_id} className="px-3 py-2.5">
                <Link href={`${base}/sources/documents/${h.document_id}`} className="text-sm font-medium text-fg hover:text-accent">
                  {h.title || "Untitled document"}
                </Link>
                <span className="ml-2 text-xs text-subtle">changed {timeAgo(h.changed_at)}</span>
                {h.snippet ? <p className="mt-1 line-clamp-2 text-xs text-muted">{h.snippet}</p> : null}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
