import { ChevronRight, FileDiff } from "lucide-react";
import { Link } from "@/components/ui/link";
import { EscalationBadge, ProposalStatusBadge, RiskBadge } from "@/components/kf/badges";
import type { Database } from "@/lib/database.types";
import { actorLabel } from "@/lib/format";
import type { ProfileMap } from "@/lib/format";
import { Timestamp } from "@/components/kf/timestamp";

export type ProposalRow = Pick<
  Database["public"]["Tables"]["proposals"]["Row"],
  "id" | "title" | "author" | "risk" | "escalation" | "status" | "auto_applied" | "created_at" | "applied_at" | "reviewed_at" | "reviewed_by"
> & { proposal_ops: { count: number }[] };

export function ProposalItem({ p, base, profiles, history }: { p: ProposalRow; base: string; profiles: ProfileMap; history?: boolean }) {
  const when = history ? (p.applied_at ?? p.reviewed_at ?? p.created_at) : p.created_at;
  // one fact per row: who decided it (history) or who proposed it; the curator's model is on the proposal page
  // (the number of changes is on the proposal page)
  const who =
    history && p.reviewed_by
      ? `Reviewed by ${profiles[p.reviewed_by]?.display_name ?? "a reviewer"}`
      : history && p.auto_applied
        ? `Applied by ${actorLabel("process:policy", profiles).toLowerCase()}`
        : `By ${actorLabel(p.author.startsWith("curator") ? "curator" : p.author, profiles)}`;
  return (
    <li>
      <Link href={`${base}/proposals/${p.id}`} className="group flex items-start gap-3 px-4 py-3.5 transition-colors hover:bg-surface-2/60">
        <FileDiff className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-medium text-fg group-hover:text-accent">{p.title}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {history || p.status !== "pending" ? <ProposalStatusBadge status={p.status} autoApplied={p.auto_applied} /> : null}
            <RiskBadge risk={p.risk} />
            {p.escalation ? <EscalationBadge /> : null}
            <span className="text-xs text-subtle">{who}</span>
          </div>
        </div>
        <Timestamp iso={when} className="shrink-0 text-xs text-subtle" />
        <ChevronRight className="mt-0.5 size-4 shrink-0 text-subtle" aria-hidden="true" />
      </Link>
    </li>
  );
}
