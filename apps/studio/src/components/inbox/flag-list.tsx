import { FileSearch, Lightbulb, Sparkles } from "lucide-react";
import { Link } from "@/components/ui/link";
import { AgentBadge, AudienceBadge, FlagKindBadge } from "@/components/kf/badges";
import { Badge } from "@/components/ui/badge";
import type { Database } from "@/lib/database.types";

import type { ProfileMap } from "@/lib/format";
import { DismissFlagButton } from "./dismiss-flag";
import { Timestamp } from "@/components/kf/timestamp";

export type FlagRow = Pick<
  Database["public"]["Tables"]["flags"]["Row"],
  | "id"
  | "kind"
  | "concept_id"
  | "concept_path"
  | "query"
  | "observation"
  | "suggested_fix"
  | "created_by"
  | "trace_id"
  | "synthetic"
  | "created_at"
  | "status"
  | "audience"
  | "resolution"
  | "proposal_id"
>;

export function conceptHref(base: string, path: string) {
  return `${base}/knowledge/${path.split("/").map(encodeURIComponent).join("/")}`;
}

export function FlagItem({
  flag,
  base,
  profiles,
  groups,
  canDismiss,
  inTrace = false,
}: {
  flag: FlagRow;
  base: string;
  profiles: ProfileMap;
  groups: { id: string; name: string }[];
  canDismiss: boolean;
  /** Rendered on the page of the trace the flag came from: skip the link back to it. */
  inTrace?: boolean;
}) {
  const author = flag.created_by ? profiles[flag.created_by] : undefined;
  const open = flag.status === "open";
  // the proposal the flag is in (in_proposal) or that applied it (resolved); a dismissed flag links nowhere
  const proposalId = flag.status === "in_proposal" || flag.status === "resolved" ? flag.proposal_id : null;
  const status = flag.status.replace("_", " ");
  const showSource = !(inTrace && flag.synthetic);
  return (
    <li className="px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-2">
        <FlagKindBadge kind={flag.kind} />
        {flag.concept_path ? (
          flag.concept_id ? (
            <Link href={conceptHref(base, flag.concept_path)} className="font-mono text-xs text-fg hover:text-accent hover:underline">
              {flag.concept_path}
            </Link>
          ) : (
            <span className="font-mono text-xs text-muted" title="No concept exists at this path (or you cannot see it)">
              {flag.concept_path}
            </span>
          )
        ) : (
          <span className="text-xs text-subtle">No concept yet</span>
        )}
        <AudienceBadge audience={flag.audience} groups={groups} />
        {open ? null : proposalId ? (
          <Link href={`${base}/proposals/${proposalId}`} title={flag.status === "resolved" ? "Open the proposal that resolved this flag" : "Open the proposal for this flag"} className="hover:opacity-80">
            <Badge>{status}</Badge>
          </Link>
        ) : (
          <Badge>{status}</Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Timestamp iso={flag.created_at} className="text-xs text-subtle" />
          {canDismiss && open ? <DismissFlagButton flagId={flag.id} observation={flag.observation} /> : null}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg">{flag.observation}</p>
      {flag.status === "dismissed" && flag.resolution ? <p className="mt-1.5 text-xs text-subtle">Dismissed: {flag.resolution}</p> : null}
      {flag.query || flag.suggested_fix ? (
        // Open flags are what a reviewer acts on, so their details show; handled ones fold away.
        <details className="mt-1.5 text-xs text-muted" open={open}>
          <summary className="w-fit cursor-pointer select-none text-subtle hover:text-fg">{flag.suggested_fix ? "Suggested fix" : "Context"}</summary>
          {flag.suggested_fix ? (
            <p className="mt-1.5 flex items-start gap-1.5">
              <Lightbulb className="mt-px size-3.5 shrink-0 text-subtle" aria-hidden="true" />
              <span>{flag.suggested_fix}</span>
            </p>
          ) : null}
          {flag.query ? (
            <p className="mt-1.5 flex items-start gap-1.5">
              <FileSearch className="mt-px size-3.5 shrink-0 text-subtle" aria-hidden="true" />
              <span>
                <span className="text-subtle">Was trying to: </span>
                {flag.query}
              </span>
            </p>
          ) : null}
        </details>
      ) : null}
      {showSource || (flag.trace_id && !inTrace) ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
          {!showSource ? null : flag.synthetic ? (
            <Badge tone="violet" icon={<Sparkles />} title="The curator found a correction moment in an agent trace and raised this flag itself">
              Mined from trace
            </Badge>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              from {author?.display_name ?? (flag.created_by ? "someone in this workspace" : "a deleted user")}
              {author?.kind === "agent" ? <AgentBadge /> : null}
            </span>
          )}
          {flag.trace_id && !inTrace ? (
            <Link href={`${base}/activity/traces/${flag.trace_id}`} className="inline-flex items-center gap-0.5 text-accent hover:underline">
              View trace
            </Link>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
