import { ArrowUpRight, FileSearch, Lightbulb, Sparkles } from "lucide-react";
import { Link } from "@/components/ui/link";
import { AgentBadge, AudienceBadge, FlagKindBadge } from "@/components/kf/badges";
import { Badge } from "@/components/ui/badge";
import type { Database } from "@/lib/database.types";
import { timeAgo } from "@/lib/format";
import type { ProfileMap } from "@/lib/format";
import { DismissFlagButton } from "./dismiss-flag";

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
}: {
  flag: FlagRow;
  base: string;
  profiles: ProfileMap;
  groups: { id: string; name: string }[];
  canDismiss: boolean;
}) {
  const author = flag.created_by ? profiles[flag.created_by] : undefined;
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
        {flag.status !== "open" ? <Badge>{flag.status.replace("_", " ")}</Badge> : null}
        <span className="ml-auto flex items-center gap-2">
          <time className="text-xs text-subtle" dateTime={flag.created_at} title={new Date(flag.created_at).toLocaleString()}>
            {timeAgo(flag.created_at)}
          </time>
          {canDismiss && flag.status === "open" ? <DismissFlagButton flagId={flag.id} observation={flag.observation} /> : null}
        </span>
      </div>
      <p className="mt-2 text-sm text-fg">{flag.observation}</p>
      {flag.query ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted">
          <FileSearch className="mt-px size-3.5 shrink-0 text-subtle" aria-hidden="true" />
          <span>
            <span className="text-subtle">Was trying to: </span>
            {flag.query}
          </span>
        </p>
      ) : null}
      {flag.suggested_fix ? (
        <p className="mt-1.5 flex items-start gap-1.5 text-xs text-muted">
          <Lightbulb className="mt-px size-3.5 shrink-0 text-warn" aria-hidden="true" />
          <span>
            <span className="text-subtle">Suggested fix: </span>
            {flag.suggested_fix}
          </span>
        </p>
      ) : null}
      {flag.resolution && flag.status !== "open" ? <p className="mt-1.5 text-xs text-subtle">Resolution: {flag.resolution}</p> : null}
      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-subtle">
        {flag.synthetic ? (
          <Badge tone="violet" icon={<Sparkles />} title="The curator found a correction moment in an agent trace and raised this flag itself">
            Mined from trace
          </Badge>
        ) : (
          <span className="inline-flex items-center gap-1.5">
            from {author?.display_name ?? (flag.created_by ? "someone in this workspace" : "a deleted user")}
            {author?.kind === "agent" ? <AgentBadge /> : null}
          </span>
        )}
        {flag.trace_id ? (
          <Link href={`${base}/activity/traces/${flag.trace_id}`} className="inline-flex items-center gap-0.5 text-accent hover:underline">
            View trace <ArrowUpRight className="size-3" />
          </Link>
        ) : null}
      </div>
    </li>
  );
}
