import { CheckCircle2, CircleAlert, X } from "lucide-react";
import { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "./cn";

type ToastItem = { id: number; tone: "ok" | "error"; message: string };
type ToastApi = { success: (m: string) => void; error: (m: string) => void };

const ToastContext = createContext<ToastApi | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const push = useCallback((tone: ToastItem["tone"], message: string) => {
    const id = nextId.current++;
    setItems((xs) => [...xs.slice(-3), { id, tone, message }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), tone === "error" ? 8000 : 4000);
  }, []);
  const api = useMemo<ToastApi>(() => ({ success: (m) => push("ok", m), error: (m) => push("error", m) }), [push]);
  return (
    <ToastContext.Provider value={api}>
      {children}
      <div aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-4 z-[60] flex flex-col items-center gap-2 px-4 sm:items-end sm:pr-6">
        {items.map((t) => (
          <div
            key={t.id}
            role={t.tone === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex w-full max-w-sm items-start gap-2.5 rounded-md border bg-surface px-3.5 py-3 text-sm shadow-lg",
              t.tone === "error" ? "border-danger/40" : "border-line-strong",
            )}
          >
            {t.tone === "error" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> : <CheckCircle2 className="mt-0.5 size-4 shrink-0 text-ok" />}
            <span className="min-w-0 flex-1 text-fg">{t.message}</span>
            <button
              type="button"
              aria-label="Dismiss notification"
              className="text-subtle hover:text-fg"
              onClick={() => setItems((xs) => xs.filter((x) => x.id !== t.id))}
            >
              <X className="size-4" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used inside <ToastProvider>");
  return ctx;
}
