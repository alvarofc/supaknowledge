import { X } from "lucide-react";
import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

/**
 * Modal built on the native <dialog> element: focus trapping, Escape and inert background for free.
 * Controlled with `open` / `onClose`.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  size = "md",
  dismissible = true,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  size?: "sm" | "md" | "lg" | "xl";
  /** false blocks Escape, backdrop clicks and the close button (e.g. while a request whose result must be shown is pending) */
  dismissible?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  const widths = { sm: "max-w-md", md: "max-w-lg", lg: "max-w-2xl", xl: "max-w-4xl" } as const;
  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={(e) => {
        if (!dismissible) e.preventDefault();
      }}
      onClose={() => {
        // a close we did not ask for while not dismissible (the browser ignored preventDefault): reopen
        if (open && !dismissible) ref.current?.showModal();
        else onClose();
      }}
      onClick={(e) => {
        if (dismissible && e.target === ref.current) onClose();
      }}
      className={cn(
        "m-auto w-[calc(100%-2rem)] rounded-md border border-line-strong bg-surface p-0 text-fg shadow-xl",
        widths[size],
      )}
    >
      {open ? (
        <div className="flex max-h-[85vh] flex-col">
          <div className="flex items-start justify-between gap-4 border-b border-line px-5 py-3">
            <div className="min-w-0">
              <h2 id={titleId} className="text-sm font-medium">
                {title}
              </h2>
              {description ? <p className="mt-0.5 text-xs text-subtle">{description}</p> : null}
            </div>
            <button type="button" onClick={onClose} disabled={!dismissible} aria-label="Close" className="-mr-1 rounded p-1 text-subtle hover:bg-surface-2 hover:text-fg disabled:pointer-events-none disabled:opacity-50">
              <X className="size-4" />
            </button>
          </div>
          {/* no empty padded body for header-only dialogs (useConfirm) */}
          {children !== undefined && children !== null && children !== false ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{children}</div>
          ) : null}
          {footer ? <div className="flex flex-wrap justify-end gap-2 border-t border-line px-5 py-3">{footer}</div> : null}
        </div>
      ) : null}
    </dialog>
  );
}
