import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export function Card({ className, ...props }: ComponentProps<"div">) {
  return <div className={cn("rounded-md border border-line bg-surface", className)} {...props} />;
}

export function CardHeader({
  title,
  description,
  actions,
  className,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3", className)}>
      <div className="min-w-0">
        <h2 className="text-sm font-medium text-fg">{title}</h2>
        {description ? <p className="mt-0.5 text-xs text-subtle">{description}</p> : null}
      </div>
      {actions ? <div className="flex items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
}: {
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  eyebrow?: ReactNode;
}) {
  return (
    <div className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        {eyebrow ? <div className="mb-1.5 flex flex-wrap items-center gap-1.5 text-xs text-subtle">{eyebrow}</div> : null}
        <h1 className="text-xl font-normal tracking-tight text-fg sm:text-2xl">{title}</h1>
        {description ? <p className="mt-1 max-w-2xl text-sm text-muted">{description}</p> : null}
      </div>
      {actions ? <div className="flex flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

/** A small uppercase monospace section label ("FIELDS", "CONFIGURATION"). */
export function SectionLabel({ children, className, as: As = "h3" }: { children: ReactNode; className?: string; as?: "h2" | "h3" | "div" }) {
  return <As className={cn("mono-label text-subtle", className)}>{children}</As>;
}

/**
 * Empty states teach the concept behind the screen instead of just saying "nothing here".
 * `framed` draws the dashed box used when the empty state stands on its own (not inside a card).
 */
export function EmptyState({
  icon,
  title,
  children,
  actions,
  className,
  framed,
}: {
  icon?: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
  framed?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex flex-col items-center px-6 py-12 text-center",
        framed && "rounded-md border border-dashed border-line-strong bg-surface/40",
        className,
      )}
    >
      {icon ? <div className="mb-3 text-subtle [&_svg]:size-5">{icon}</div> : null}
      <h3 className="text-sm font-medium text-fg">{title}</h3>
      {children ? <div className="mt-1 max-w-md text-sm text-muted">{children}</div> : null}
      {actions ? <div className="mt-4 flex flex-wrap justify-center gap-2">{actions}</div> : null}
    </div>
  );
}

export function Callout({
  tone = "info",
  title,
  children,
  icon,
  className,
}: {
  tone?: "info" | "warn" | "danger" | "ok" | "neutral";
  title?: ReactNode;
  children?: ReactNode;
  icon?: ReactNode;
  className?: string;
}) {
  const tones = {
    info: "border-info/30 bg-info-soft",
    warn: "border-warn/30 bg-warn-soft",
    danger: "border-danger/30 bg-danger-soft",
    ok: "border-ok/30 bg-ok-soft",
    neutral: "border-line bg-surface",
  } as const;
  const iconTones = { info: "text-info", warn: "text-warn", danger: "text-danger", ok: "text-ok", neutral: "text-muted" } as const;
  return (
    <div className={cn("flex gap-3 rounded-md border px-3.5 py-3 text-sm", tones[tone], className)} role={tone === "danger" ? "alert" : undefined}>
      {icon ? <div className={cn("mt-px shrink-0 [&_svg]:size-4", iconTones[tone])}>{icon}</div> : null}
      <div className="min-w-0">
        {title ? <div className="font-medium text-fg">{title}</div> : null}
        {children ? <div className={cn("text-muted", title ? "mt-0.5" : "")}>{children}</div> : null}
      </div>
    </div>
  );
}

export function Stat({ label, value, hint, tone }: { label: ReactNode; value: ReactNode; hint?: ReactNode; tone?: "warn" | "danger" | "ok" }) {
  const toneClass = tone === "warn" ? "text-warn" : tone === "danger" ? "text-danger" : tone === "ok" ? "text-ok" : "text-fg";
  return (
    <Card className="px-4 py-3">
      <div className="mono-label text-subtle">{label}</div>
      <div className={cn("mt-1.5 text-2xl font-normal tabular-nums tracking-tight", toneClass)}>{value}</div>
      {hint ? <div className="mt-0.5 text-xs text-subtle">{hint}</div> : null}
    </Card>
  );
}

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd className={cn("rounded border border-line-strong bg-surface-2 px-1 py-px font-mono text-[10.5px] leading-none text-subtle", className)}>
      {children}
    </kbd>
  );
}

export function Code({ children, className }: { children: ReactNode; className?: string }) {
  return <code className={cn("rounded border border-line bg-surface-2 px-1 py-px font-mono text-[0.85em]", className)}>{children}</code>;
}
