import {
  AlertTriangle,
  BadgeCheck,
  BookOpen,
  Bot,
  CircleDashed,
  Clock,
  Database,
  Lock,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  Zap,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { Tone } from "@/components/ui/badge";
import { cn } from "@/components/ui/cn";
import type { Database as DB } from "@/lib/database.types";

type Enums = DB["public"]["Enums"];

export const KIND_LABEL: Record<Enums["concept_kind"], string> = {
  skill: "Skill",
  domain: "Domain",
  data_access: "Data access",
};
export const KIND_HELP: Record<Enums["concept_kind"], string> = {
  skill: "How to do the work: procedures, templates, scripts",
  domain: "How the business works: definitions, policies, facts",
  data_access: "Where live data lives and how to query it",
};

export function KindIcon({ kind, className }: { kind: Enums["concept_kind"]; className?: string }) {
  const Icon = kind === "skill" ? Wrench : kind === "data_access" ? Database : BookOpen;
  const color = kind === "skill" ? "text-violet" : kind === "data_access" ? "text-info" : "text-accent";
  return <Icon className={cn("size-4 shrink-0", color, className)} aria-label={KIND_LABEL[kind]} />;
}

export function KindBadge({ kind }: { kind: Enums["concept_kind"] }) {
  const tone: Tone = kind === "skill" ? "violet" : kind === "data_access" ? "info" : "accent";
  return (
    <Badge tone={tone} title={KIND_HELP[kind]}>
      {KIND_LABEL[kind]}
    </Badge>
  );
}

const TRUST: Record<Enums["trust_tier"], { label: string; tone: Tone; help: string }> = {
  human_reviewed: { label: "Human reviewed", tone: "ok", help: "A person verified the current revision" },
  machine_confirmed: { label: "Machine confirmed", tone: "info", help: "Confirmed by an automated check, not yet by a person" },
  unverified: { label: "Unverified", tone: "neutral", help: "Nobody has verified the current revision yet" },
};

export function TrustBadge({ trust, compact }: { trust: Enums["trust_tier"] | null | undefined; compact?: boolean }) {
  const t = TRUST[trust ?? "unverified"];
  const icon = trust === "human_reviewed" ? <BadgeCheck /> : trust === "machine_confirmed" ? <ShieldCheck /> : <CircleDashed />;
  if (compact) {
    return (
      <span title={`${t.label}: ${t.help}`} className={cn("inline-flex [&_svg]:size-3.5", t.tone === "ok" ? "text-ok" : t.tone === "info" ? "text-info" : "text-subtle")}>
        {icon}
        <span className="sr-only">{t.label}</span>
      </span>
    );
  }
  return (
    <Badge tone={t.tone} icon={icon} title={t.help}>
      {t.label}
    </Badge>
  );
}

export function StaleBadge() {
  return (
    <Badge tone="warn" icon={<Clock />} title="Past its stale_after date: the curator will re-check it against its sources">
      Stale
    </Badge>
  );
}

export function RiskBadge({ risk }: { risk: Enums["proposal_risk"] }) {
  const tone: Tone = risk === "high" ? "danger" : risk === "medium" ? "warn" : "ok";
  return <Badge tone={tone}>{risk[0].toUpperCase() + risk.slice(1)} risk</Badge>;
}

export function EscalationBadge() {
  return (
    <Badge plain tone="danger" icon={<ShieldAlert />} title="Applying this would expose restricted material to a wider audience">
      Widens access — admin approval required
    </Badge>
  );
}

const PROPOSAL_STATUS: Record<Enums["proposal_status"], { label: string; tone: Tone }> = {
  pending: { label: "Pending review", tone: "info" },
  approved: { label: "Approved", tone: "accent" },
  applied: { label: "Applied", tone: "ok" },
  rejected: { label: "Rejected", tone: "neutral" },
  conflicted: { label: "Conflicted", tone: "warn" },
  superseded: { label: "Superseded", tone: "neutral" },
};

export function ProposalStatusBadge({ status, autoApplied }: { status: Enums["proposal_status"]; autoApplied?: boolean }) {
  if (status === "applied" && autoApplied) {
    return (
      <Badge tone="ok" icon={<Zap />} title="Applied automatically by the space auto-apply policy">
        Auto-applied
      </Badge>
    );
  }
  const s = PROPOSAL_STATUS[status];
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

const FLAG_KIND: Record<Enums["flag_kind"], { label: string; tone: Tone }> = {
  missing: { label: "Missing", tone: "violet" },
  incorrect: { label: "Incorrect", tone: "danger" },
  outdated: { label: "Outdated", tone: "warn" },
  conflicting: { label: "Conflicting", tone: "warn" },
  unclear: { label: "Unclear", tone: "info" },
};

export function FlagKindBadge({ kind }: { kind: Enums["flag_kind"] }) {
  const f = FLAG_KIND[kind];
  return (
    <Badge tone={f.tone} icon={<AlertTriangle />}>
      {f.label}
    </Badge>
  );
}

export const FLAG_KIND_HELP: Record<Enums["flag_kind"], string> = {
  missing: "Knowledge an agent needed but could not find",
  incorrect: "Says something that is wrong",
  outdated: "Was true, is not any more",
  conflicting: "Contradicts another concept or a source",
  unclear: "Ambiguous or hard to apply",
};

export function RoleBadge({ role }: { role: Enums["space_role"] | null }) {
  if (!role) return <Badge>No access</Badge>;
  const tone: Tone = role === "admin" ? "violet" : role === "reviewer" ? "accent" : role === "editor" ? "info" : "neutral";
  return <Badge tone={tone}>{role[0].toUpperCase() + role.slice(1)}</Badge>;
}

/** Restricted knowledge shows which groups can see it. */
export function AudienceBadge({ audience, groups }: { audience: string[]; groups: { id: string; name: string }[] }) {
  if (!audience.length) return null;
  const names = audience.map((id) => groups.find((g) => g.id === id)?.name ?? "hidden group");
  return (
    <Badge plain tone="warn" icon={<Lock />} title={`Only members of: ${names.join(", ")}`}>
      {names.join(", ")}
    </Badge>
  );
}

export function AgentBadge() {
  return (
    <Badge tone="info" icon={<Bot />}>
      Agent
    </Badge>
  );
}

export function StatusDot({ tone }: { tone: "ok" | "warn" | "danger" | "neutral" | "info" }) {
  const c = { ok: "bg-ok", warn: "bg-warn", danger: "bg-danger", neutral: "bg-subtle", info: "bg-info" }[tone];
  return <span className={cn("inline-block size-2 shrink-0 rounded-full", c)} aria-hidden="true" />;
}
