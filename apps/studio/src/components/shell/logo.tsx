import { cn } from "@/components/ui/cn";

/** The Supaknowledge mark: an isometric knowledge block in brand greens. */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6 shrink-0", className)} aria-hidden="true">
      <path d="M16 3.5 27 9.75 16 16 5 9.75z" fill="#6EE7B0" />
      <path d="M5 9.75 16 16v12.5L5 22.25z" fill="#3ECF8E" />
      <path d="M27 9.75v12.5L16 28.5V16z" fill="#1F9D63" />
    </svg>
  );
}

export function Logo({ className, withText = true }: { className?: string; withText?: boolean }) {
  return (
    <span className={cn("inline-flex items-center gap-2", className)}>
      <LogoMark />
      {withText ? (
        <span className="text-[15px] font-medium tracking-tight text-fg">
          Supaknowledge <span className="font-normal text-subtle">Studio</span>
        </span>
      ) : null}
    </span>
  );
}
