// Per-space settings (spaces.settings jsonb) and the auto-apply policy engine.
// The database validates the same keys, types and bounds on write (private.validate_space_settings, latest
// definition in supabase/migrations/20261125000020_followups.sql); test/settings-db.test.ts keeps them in sync.
import { z } from "zod";
import type { ConceptKind, ProposalRisk } from "./types.ts";

const CuratorSettingsSchema = z.object({
  enabled: z.boolean().default(true),
  /** open flags on one concept (or "missing" flags in the space) that trigger a run */
  flag_threshold: z.number().int().min(0).max(1_000_000).default(3),
  /** minimum minutes between flag-threshold runs of one space (enforced in the database) */
  flag_cooldown_minutes: z.number().int().min(0).max(10080).default(60),
  /** a run/task without progress for this long is failed by the reaper (enforced in the database) */
  stuck_after_minutes: z.number().int().min(5).max(1440).default(30),
  /** model id override for this space ("" = KF_LLM_MODEL). Endpoints and keys come only from the environment. */
  model: z.string().default(""),
  /** cheaper model for bulk trace mining ("" = KF_LLM_FAST_MODEL, else `model`) */
  fast_model: z.string().default(""),
  /** tried in order when the primary model errors ([] = KF_LLM_FALLBACK_MODELS) */
  fallback_models: z.array(z.string()).default([]),
  /** research tool calls the drafting agent may make per cluster */
  max_research_steps: z.number().int().min(1).max(20).default(8),
  max_clusters_per_run: z.number().int().min(1).max(200).default(25),
  max_traces_per_run: z.number().int().min(0).max(5000).default(200),
  /**
   * Model tokens (input + output) one curator run may spend across all its tasks. When exhausted, the
   * remaining tasks fail with a clear error instead of spending more. 0 = unlimited.
   */
  max_tokens_per_run: z.number().int().min(0).max(2_000_000_000).default(3_000_000),
  /**
   * What the drafting model may research: "target_audience" (default) only shows search results that are
   * readable by everyone who can read the concepts being changed, so restricted material cannot leak into a
   * wider concept by accident; "all" searches everything (every restricted item it reads still escalates).
   */
  research_scope: z.enum(["target_audience", "all"]).default("target_audience"),
  /** let the curator dismiss flags it judges mistaken or noise (false = leave them open for a human) */
  auto_dismiss_flags: z.boolean().default(true),
  /** extra guidance appended to the curator system prompt (house style, naming rules...) */
  instructions: z.string().default(""),
});

const AutoApplySettingsSchema = z.object({
  enabled: z.boolean().default(false),
  max_risk: z.enum(["low", "medium"]).default("low"),
  kinds: z.array(z.enum(["skill", "domain", "data_access"])).default(["data_access"]),
  /** only auto-apply when at least one citation is a trace or flag (i.e. observed in real work) */
  require_observed_evidence: z.boolean().default(true),
  /** never auto-apply creates of brand-new concepts */
  allow_create: z.boolean().default(false),
  /**
   * Source kinds whose content is third-party / untrusted (anyone on the internet can write it). A changeset
   * that read evidence from them is never auto-applied.
   */
  untrusted_source_kinds: z.array(z.enum(["notion", "slack", "github", "gdrive", "web", "upload"])).default(["web"]),
});

const StalenessSettingsSchema = z.object({
  /** default lifetime for data_access concepts that do not declare stale_after */
  data_access_days: z.number().int().min(0).max(36500).default(90),
});

const EmbeddingsSettingsSchema = z.object({
  provider: z.enum(["gte-small"]).default("gte-small"),
});

const RetentionSettingsSchema = z.object({
  /** delete traces older than this many days (null = keep) */
  trace_days: z.number().int().min(1).max(36500).nullable().default(null),
  /** delete concept usage rows older than this many days (null = keep) */
  usage_days: z.number().int().min(1).max(36500).nullable().default(null),
});

export const SpaceSettingsSchema = z.object({
  curator: CuratorSettingsSchema.prefault({}),
  auto_apply: AutoApplySettingsSchema.prefault({}),
  staleness: StalenessSettingsSchema.prefault({}),
  embeddings: EmbeddingsSettingsSchema.prefault({}),
  retention: RetentionSettingsSchema.prefault({}),
});

export type SpaceSettings = z.infer<typeof SpaceSettingsSchema>;

const SECTIONS = {
  curator: CuratorSettingsSchema,
  auto_apply: AutoApplySettingsSchema,
  staleness: StalenessSettingsSchema,
  embeddings: EmbeddingsSettingsSchema,
  retention: RetentionSettingsSchema,
} as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Parse spaces.settings field by field: an invalid value falls back to that field's default (and is reported
 * in `warnings`) while every valid field is kept. One typo must never silently reset a whole space's policy.
 */
export function parseSettingsWithWarnings(raw: unknown): { settings: SpaceSettings; warnings: string[] } {
  const warnings: string[] = [];
  const obj = isPlainObject(raw) ? raw : {};
  if (raw !== null && raw !== undefined && !isPlainObject(raw)) warnings.push("settings must be an object; using defaults");
  const out: Record<string, Record<string, unknown>> = {};
  for (const [name, schema] of Object.entries(SECTIONS)) {
    const section = obj[name];
    if (section !== undefined && section !== null && !isPlainObject(section)) warnings.push(`${name}: must be an object; using defaults`);
    const values = isPlainObject(section) ? section : {};
    const fields: Record<string, unknown> = {};
    for (const [key, field] of Object.entries(schema.shape) as [string, z.ZodType][]) {
      const r = field.safeParse(values[key]);
      if (r.success) fields[key] = r.data;
      else {
        warnings.push(`${name}.${key}: ${r.error.issues[0]?.message ?? "invalid"}; using the default`);
        fields[key] = field.parse(undefined);
      }
    }
    out[name] = fields;
  }
  return { settings: SpaceSettingsSchema.parse(out), warnings };
}

export function parseSettings(raw: unknown, onWarning?: (warning: string) => void): SpaceSettings {
  const { settings, warnings } = parseSettingsWithWarnings(raw);
  if (onWarning) for (const w of warnings) onWarning(w);
  return settings;
}

export interface PolicyInput {
  risk: ProposalRisk;
  escalation: boolean;
  opKinds: ("create" | "update" | "deprecate" | "move")[];
  conceptKinds: ConceptKind[];
  citationKinds: ("source_document" | "trace" | "flag" | "concept" | "url")[];
  /** connector kinds of every source document the changeset read or cited (web, notion, ...) */
  sourceKinds?: string[];
}

export interface PolicyDecision {
  autoApply: boolean;
  reason: string;
}

const RISK_ORDER: Record<ProposalRisk, number> = { low: 0, medium: 1, high: 2 };

export function decideAutoApply(settings: SpaceSettings, p: PolicyInput): PolicyDecision {
  const a = settings.auto_apply;
  if (!a.enabled) return { autoApply: false, reason: "auto-apply is disabled for this space" };
  if (p.escalation) return { autoApply: false, reason: "widens access to restricted knowledge; needs a space admin" };
  if (RISK_ORDER[p.risk] > RISK_ORDER[a.max_risk]) return { autoApply: false, reason: `risk ${p.risk} exceeds ${a.max_risk}` };
  if (!a.allow_create && p.opKinds.includes("create")) return { autoApply: false, reason: "creates new concepts" };
  if (p.opKinds.includes("move")) return { autoApply: false, reason: "moves concepts" };
  const disallowed = p.conceptKinds.filter((k) => !a.kinds.includes(k));
  if (disallowed.length) return { autoApply: false, reason: `touches ${[...new Set(disallowed)].join(", ")} knowledge` };
  const untrusted = [...new Set((p.sourceKinds ?? []).filter((k) => (a.untrusted_source_kinds as string[]).includes(k)))];
  if (untrusted.length) return { autoApply: false, reason: `read untrusted ${untrusted.join(", ")} sources` };
  if (p.citationKinds.includes("url")) return { autoApply: false, reason: "cites external URLs a human must check" };
  if (a.require_observed_evidence && !p.citationKinds.some((k) => k === "trace" || k === "flag")) {
    return { autoApply: false, reason: "no evidence observed in real agent work" };
  }
  return { autoApply: true, reason: "matches the space auto-apply policy" };
}
