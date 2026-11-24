import type { Json } from "@/lib/database.types";
import { cn } from "@/components/ui/cn";

/** Collapsible pretty-printed JSON. */
export function JsonDetails({ label, value, className, open }: { label: string; value: Json | unknown; className?: string; open?: boolean }) {
  if (value === null || value === undefined) return null;
  if (typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === 0) return null;
  return (
    <details className={cn("group rounded-md border border-line bg-surface-2/50", className)} open={open}>
      <summary className="cursor-pointer px-2.5 py-1.5 text-xs font-medium text-muted select-none hover:text-fg">{label}</summary>
      <pre className="max-h-96 overflow-auto border-t border-line px-2.5 py-2 font-mono text-[11.5px] leading-relaxed whitespace-pre-wrap break-words text-fg">
        {typeof value === "string" ? value : JSON.stringify(value, null, 2)}
      </pre>
    </details>
  );
}

/** Flat key/value chips for small stats objects (nested values are JSON-encoded). */
export function StatChips({ stats }: { stats: Json }) {
  if (!stats || typeof stats !== "object" || Array.isArray(stats)) return null;
  const entries = Object.entries(stats);
  if (!entries.length) return null;
  return (
    <ul className="flex flex-wrap gap-1.5" aria-label="Run statistics">
      {entries.map(([k, v]) => (
        <li key={k} className="inline-flex items-center gap-1 rounded-md border border-line bg-surface-2 px-1.5 py-0.5 text-[11px]">
          <span className="text-subtle">{k.replaceAll("_", " ")}</span>
          <span className="font-medium tabular-nums text-fg">{typeof v === "object" ? JSON.stringify(v) : String(v)}</span>
        </li>
      ))}
    </ul>
  );
}
