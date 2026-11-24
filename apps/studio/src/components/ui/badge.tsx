import type { ReactNode } from "react";
import { cn } from "./cn";

export type Tone = "neutral" | "accent" | "info" | "warn" | "danger" | "ok" | "violet";

const tones: Record<Tone, string> = {
  neutral: "bg-surface-2 text-muted border-line-strong",
  accent: "bg-accent-soft text-accent border-accent/30",
  info: "bg-info-soft text-info border-info/30",
  warn: "bg-warn-soft text-warn border-warn/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  ok: "bg-ok-soft text-ok border-ok/30",
  violet: "bg-violet-soft text-violet border-violet/30",
};

/**
 * Tiny status pill. Short status words render as uppercase monospace ("PENDING", "ADMIN"); pass `plain` for
 * free text such as group names or sentences.
 */
export function Badge({
  tone = "neutral",
  children,
  className,
  icon,
  title,
  plain,
}: {
  tone?: Tone;
  children: ReactNode;
  className?: string;
  icon?: ReactNode;
  title?: string;
  plain?: boolean;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center gap-1 rounded-full border px-1.5 leading-none whitespace-nowrap [&_svg]:size-3",
        plain ? "text-[11px] font-medium" : "font-mono text-[10.5px] tracking-[0.06em] uppercase",
        tones[tone],
        className,
      )}
    >
      {icon}
      {children}
    </span>
  );
}
