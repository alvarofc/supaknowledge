import type { ComponentProps, ReactNode } from "react";
import { cn } from "./cn";

export const controlClass =
  "rounded-md border border-line-strong bg-control px-3 text-sm text-fg placeholder:text-subtle transition-colors focus:border-accent focus:outline-none focus-visible:outline-none focus:ring-2 focus:ring-ring disabled:opacity-60 aria-invalid:border-danger";

/** Full width unless the caller sets a width (cn() does not dedupe conflicting utilities). */
function control(className: string | undefined, extra: string) {
  return cn(controlClass, /(^|\s)(w-|flex-1|min-w-0)/.test(className ?? "") ? "" : "w-full", extra, className);
}

export function Input({ className, ...props }: ComponentProps<"input">) {
  return <input className={control(className, "h-8")} {...props} />;
}

export function Textarea({ className, ...props }: ComponentProps<"textarea">) {
  return <textarea className={control(className, "py-2 leading-relaxed")} {...props} />;
}

export function Select({ className, children, ...props }: ComponentProps<"select">) {
  return (
    <select className={control(className, "h-8 pr-8")} {...props}>
      {children}
    </select>
  );
}

export function Label({ className, ...props }: ComponentProps<"label">) {
  return <label className={cn("text-sm text-muted", className)} {...props} />;
}

/** Label + control + hint/error, wired for screen readers via `id`. */
export function Field({
  label,
  htmlFor,
  hint,
  error,
  children,
  className,
  optional,
}: {
  label: ReactNode;
  htmlFor: string;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
  optional?: boolean;
}) {
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      <Label htmlFor={htmlFor}>
        {label}
        {optional ? <span className="ml-1.5 font-mono text-[10.5px] tracking-[0.06em] text-subtle uppercase">optional</span> : null}
      </Label>
      {children}
      {error ? (
        <p id={`${htmlFor}-error`} className="text-xs text-danger" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={`${htmlFor}-hint`} className="text-xs text-subtle">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Checkbox({ label, description, className, ...props }: ComponentProps<"input"> & { label: ReactNode; description?: ReactNode }) {
  return (
    <label className={cn("flex cursor-pointer items-start gap-2.5 text-sm", className)}>
      <input type="checkbox" className="mt-0.5 size-4 rounded border-line accent-[var(--brand-strong)]" {...props} />
      <span>
        <span className="font-medium text-fg">{label}</span>
        {description ? <span className="block text-xs text-subtle">{description}</span> : null}
      </span>
    </label>
  );
}
