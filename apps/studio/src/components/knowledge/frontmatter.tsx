import { ExternalLink } from "lucide-react";
import type { Json } from "@/lib/database.types";
import { Link } from "@/components/ui/link";
import { parseSources } from "@/lib/okf-sources";
import { safeHref } from "@/lib/safe-href";

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function Value({ v }: { v: unknown }) {
  if (v === null || v === undefined) return <span className="text-subtle">—</span>;
  if (typeof v === "string") {
    const href = safeHref(v);
    if (href)
      return (
        <a href={href} target="_blank" rel="noopener noreferrer" className="break-all text-accent hover:underline">
          {v}
        </a>
      );
    return <span className="break-words">{v}</span>;
  }
  if (typeof v === "number" || typeof v === "boolean") return <span className="font-mono">{String(v)}</span>;
  if (Array.isArray(v) && v.every((x) => typeof x === "string" || typeof x === "number")) {
    return (
      <span className="flex flex-wrap gap-1">
        {v.map((x, i) => (
          <span key={i} className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-xs">
            {String(x)}
          </span>
        ))}
      </span>
    );
  }
  return <pre className="overflow-x-auto rounded bg-surface-2 px-2 py-1 font-mono text-xs whitespace-pre-wrap">{JSON.stringify(v, null, 2)}</pre>;
}

/** Key/value view of OKF frontmatter with the raw JSON one click away. `sources` is rendered separately. */
export function FrontmatterPanel({ frontmatter }: { frontmatter: Json }) {
  const fm = isRecord(frontmatter) ? frontmatter : {};
  const entries = Object.entries(fm).filter(([k]) => k !== "sources");
  return (
    <div>
      {entries.length === 0 ? (
        <p className="px-4 py-3 text-sm text-subtle">No extra frontmatter. Unknown OKF keys are preserved here on import and export.</p>
      ) : (
        <dl className="divide-y divide-line">
          {entries.map(([k, v]) => (
            <div key={k} className="grid grid-cols-1 gap-1 px-4 py-2 text-sm sm:grid-cols-[9rem_1fr] sm:gap-3">
              <dt className="font-mono text-xs text-subtle sm:pt-0.5">{k}</dt>
              <dd className="min-w-0 text-fg">
                <Value v={v} />
              </dd>
            </div>
          ))}
        </dl>
      )}
      <details className="border-t border-line px-4 py-2">
        <summary className="cursor-pointer text-xs text-subtle hover:text-fg">Raw frontmatter JSON</summary>
        <pre className="mt-2 max-h-80 overflow-auto rounded bg-surface-2 p-2 font-mono text-xs">{JSON.stringify(fm, null, 2)}</pre>
      </details>
    </div>
  );
}

export function SourcesList({ frontmatter, base }: { frontmatter: Json; base?: string }) {
  const items = parseSources(frontmatter, base);
  if (!items.length)
    return <p className="px-4 py-3 text-sm text-subtle">No sources declared. Curator-written concepts cite their evidence here and as footnotes.</p>;
  return (
    <ul className="divide-y divide-line">
      {items.map((s, i) => (
        <li key={i} className="px-4 py-2 text-sm">
          {s.url ? (
            <a href={s.url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
              {s.label}
              <ExternalLink className="size-3 shrink-0" />
            </a>
          ) : s.href ? (
            <Link href={s.href} className="break-all text-accent hover:underline">
              {s.label}
            </Link>
          ) : (
            <span className="break-all text-fg">{s.label}</span>
          )}
          {s.resource ? <span className="block font-mono text-xs break-all text-subtle">{s.resource}</span> : null}
          {s.detail ? <span className="block text-xs text-subtle">{s.detail}</span> : null}
        </li>
      ))}
    </ul>
  );
}
