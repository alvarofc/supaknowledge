import { useSyncExternalStore } from "react";
import { formatDate, formatTime, timeAgo } from "@/lib/format";
import type { DateFormatOptions } from "@/lib/format";

const subscribe = () => () => {};

/** false during SSR and hydration, true once the component has mounted in the browser. */
export function useHydrated(): boolean {
  return useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
}

/** Deterministic formatting for server output (and the hydration pass): English, UTC. */
const SERVER: DateFormatOptions = { locale: "en", timeZone: "UTC" };

/**
 * A date that renders identically on the server and during hydration (English, UTC; relative times use the
 * render-time clock) and switches to the viewer's locale and time zone once mounted. Avoids hydration mismatches
 * from `toLocaleString()` / `Date.now()` differing between server and browser.
 */
export function Timestamp({
  iso,
  format = "relative",
  className,
  empty,
}: {
  iso: string | null | undefined;
  /** relative ("3 hours ago"), date (date + time) or time (hh:mm:ss) */
  format?: "relative" | "date" | "time";
  className?: string;
  /** text when iso is empty (default "never" for relative, "—" otherwise) */
  empty?: string;
}) {
  const hydrated = useHydrated();
  if (!iso) return <span className={className}>{empty ?? (format === "relative" ? "never" : "—")}</span>;
  const opts = hydrated ? {} : SERVER;
  const text =
    format === "relative" ? timeAgo(iso, undefined, opts) : format === "time" ? formatTime(iso, opts) : formatDate(iso, opts);
  return (
    // the relative text depends on the clock, which differs between the server render and hydration
    <time dateTime={iso} title={formatDate(iso, opts)} className={className} suppressHydrationWarning>
      {text}
    </time>
  );
}
