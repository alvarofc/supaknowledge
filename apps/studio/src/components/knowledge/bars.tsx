import type { ReactNode } from "react";
import { cn } from "@/components/ui/cn";

/** Horizontal bars for a small categorical breakdown. Every bar carries its number; no chart library. */
export function Bars({
  items,
  total,
}: {
  items: { key: string; label: ReactNode; value: number; color: string; hint?: string }[];
  total?: number;
}) {
  const max = Math.max(1, total ?? Math.max(...items.map((i) => i.value), 0));
  return (
    <ul className="space-y-2.5">
      {items.map((i) => {
        const pct = (i.value / max) * 100;
        return (
          <li key={i.key} title={i.hint}>
            <div className="mb-1 flex items-baseline justify-between gap-2 text-sm">
              <span className="text-fg">{i.label}</span>
              <span className="font-mono text-xs tabular-nums text-muted">
                {i.value}
                {total ? <span className="ml-1 text-xs text-subtle">({Math.round((i.value / Math.max(total, 1)) * 100)}%)</span> : null}
              </span>
            </div>
            <div className="h-2 overflow-hidden rounded-[3px] bg-surface-2" aria-hidden="true">
              <div className={cn("h-full rounded-[3px]", i.color)} style={{ width: `${i.value > 0 ? Math.max(pct, 2) : 0}%` }} />
            </div>
          </li>
        );
      })}
    </ul>
  );
}
