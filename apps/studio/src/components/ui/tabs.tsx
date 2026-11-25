import { Link } from "@/components/ui/link";
import type { ReactNode } from "react";
import { cn } from "./cn";
import { handleRadioKeys, radioTabIndex } from "./radio-group";

/** Underline tabs as links (URL is the state, so tabs are shareable and work without JS). */
export function LinkTabs({
  tabs,
  active,
  className,
}: {
  tabs: { id: string; label: ReactNode; href: string; count?: number }[];
  active: string;
  className?: string;
}) {
  return (
    <nav className={cn("flex gap-5 overflow-x-auto border-b border-line", className)} aria-label="Tabs">
      {tabs.map((t) => (
        <Link
          key={t.id}
          href={t.href}
          scroll={false}
          aria-current={t.id === active ? "page" : undefined}
          className={cn(
            "-mb-px inline-flex items-center gap-1.5 border-b py-2 text-sm whitespace-nowrap transition-colors",
            t.id === active ? "border-fg text-fg" : "border-transparent text-subtle hover:text-fg",
          )}
        >
          {t.label}
          {t.count !== undefined ? (
            <span className="rounded-full border border-line-strong px-1.5 font-mono text-[10.5px] leading-4 tabular-nums text-subtle">{t.count}</span>
          ) : null}
        </Link>
      ))}
    </nav>
  );
}

/** Client-state tabs (segmented control). */
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  className,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
  className?: string;
}) {
  const values = options.map((o) => o.value);
  const current = values.indexOf(value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => handleRadioKeys(e, values, value, onChange)}
      className={cn("inline-flex rounded-md border border-line bg-surface-2 p-0.5", className)}
    >
      {options.map((o, i) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          tabIndex={radioTabIndex(i, current)}
          onClick={() => onChange(o.value)}
          className={cn(
            "flex-1 rounded-[5px] border px-2.5 py-0.5 text-xs whitespace-nowrap transition-colors",
            o.value === value ? "border-line-strong bg-button text-fg shadow-xs" : "border-transparent text-subtle hover:text-fg",
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}
