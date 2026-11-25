import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import type { Database } from "@/lib/database.types";

type Outcome = Database["public"]["Enums"]["trace_outcome"];
const OUTCOME: Record<Outcome, { label: string; tone: Tone; help: string }> = {
  success: { label: "Success", tone: "ok", help: "The agent finished the task" },
  failure: { label: "Failure", tone: "danger", help: "The agent failed the task" },
  corrected: { label: "Corrected", tone: "accent", help: "A person corrected the agent — a learning moment for the curator" },
  unknown: { label: "Unknown outcome", tone: "neutral", help: "The trace did not report an outcome" },
};

export function OutcomeBadge({ outcome }: { outcome: Outcome }) {
  const o = OUTCOME[outcome];
  return (
    <Badge tone={o.tone} title={o.help}>
      {o.label}
    </Badge>
  );
}

type RunStatus = Database["public"]["Enums"]["run_status"];
export const RUN_STATUS: Record<RunStatus, { label: string; tone: "ok" | "warn" | "danger" | "neutral" | "info" }> = {
  queued: { label: "Queued", tone: "neutral" },
  running: { label: "Running", tone: "info" },
  succeeded: { label: "Succeeded", tone: "ok" },
  failed: { label: "Failed", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export function duration(from: string | null, to: string | null): string | null {
  if (!from) return null;
  const ms = (to ? new Date(to).getTime() : Date.now()) - new Date(from).getTime();
  if (ms < 0) return null;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}
