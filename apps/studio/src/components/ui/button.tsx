import { Link } from "@/components/ui/link";
import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "outline-danger";
type Size = "sm" | "md" | "lg";

const base =
  "inline-flex items-center justify-center gap-1.5 rounded-md border font-normal whitespace-nowrap transition-colors select-none disabled:opacity-50 disabled:pointer-events-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&_svg]:shrink-0";
const variants: Record<Variant, string> = {
  // Supabase-style primary: brand green fill, darker green hairline, dark text (light) / deep green with white text (dark)
  primary: "border-primary-border bg-primary text-primary-fg hover:bg-primary-hover shadow-xs",
  secondary: "border-line-strong bg-button text-fg hover:bg-surface-2 hover:border-subtle/50 shadow-xs",
  ghost: "border-transparent text-muted hover:text-fg hover:bg-surface-2",
  danger: "border-danger/40 bg-danger-soft text-danger hover:bg-danger/15 shadow-xs",
  "outline-danger": "border-line-strong bg-button text-danger hover:border-danger/40 hover:bg-danger-soft shadow-xs",
};
const sizes: Record<Size, string> = {
  sm: "h-[26px] px-2.5 text-xs [&_svg]:size-3.5",
  md: "h-8 px-3 text-sm [&_svg]:size-4",
  lg: "h-9 px-4 text-sm [&_svg]:size-4",
};

export function buttonClass(variant: Variant = "secondary", size: Size = "md", className?: string) {
  return cn(base, variants[variant], sizes[size], className);
}

export function Button({
  variant = "secondary",
  size = "md",
  className,
  pending,
  children,
  type = "button",
  ...props
}: ComponentProps<"button"> & { variant?: Variant; size?: Size; pending?: boolean }) {
  return (
    <button
      type={type}
      className={buttonClass(variant, size, className)}
      disabled={pending || props.disabled}
      aria-busy={pending || undefined}
      {...props}
    >
      {pending ? <Spinner /> : null}
      {children}
    </button>
  );
}

export function LinkButton({
  href,
  variant = "secondary",
  size = "md",
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof Link>, "className"> & { variant?: Variant; size?: Size; className?: string; children: ReactNode }) {
  return (
    <Link href={href} className={buttonClass(variant, size, className)} {...props}>
      {children}
    </Link>
  );
}

export function Spinner({ className }: { className?: string }) {
  return (
    <svg className={cn("size-3.5 animate-spin", className)} viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <circle cx="12" cy="12" r="9" stroke="currentColor" strokeOpacity="0.25" strokeWidth="3" />
      <path d="M21 12a9 9 0 0 0-9-9" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </svg>
  );
}
