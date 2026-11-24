// Per-space settings (spaces.settings jsonb) and the auto-apply policy engine.
import { z } from "zod";
import type { ConceptKind, ProposalRisk } from "./types.ts";

export const SpaceSettingsSchema = z.object({
  curator: z
    .object({
      enabled: z.boolean().default(true),
      /** open flags on one concept (or "missing" flags in the space) that trigger a run */
      flag_threshold: z.number().int().min(0).default(3),
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
      /** extra guidance appended to the curator system prompt (house style, naming rules...) */
      instructions: z.string().default(""),
    })
    .prefault({}),
  auto_apply: z
    .object({
      enabled: z.boolean().default(false),
      max_risk: z.enum(["low", "medium"]).default("low"),
      kinds: z.array(z.enum(["skill", "domain", "data_access"])).default(["data_access"]),
      /** only auto-apply when at least one citation is a trace or flag (i.e. observed in real work) */
      require_observed_evidence: z.boolean().default(true),
      /** never auto-apply creates of brand-new concepts */
      allow_create: z.boolean().default(false),
    })
    .prefault({}),
  staleness: z
    .object({
      /** default lifetime for data_access concepts that do not declare stale_after */
      data_access_days: z.number().int().min(0).default(90),
    })
    .prefault({}),
  embeddings: z
    .object({
      provider: z.enum(["gte-small"]).default("gte-small"),
    })
    .prefault({}),
});

export type SpaceSettings = z.infer<typeof SpaceSettingsSchema>;

export function parseSettings(raw: unknown): SpaceSettings {
  const r = SpaceSettingsSchema.safeParse(raw ?? {});
  return r.success ? r.data : SpaceSettingsSchema.parse({});
}

export interface PolicyInput {
  risk: ProposalRisk;
  escalation: boolean;
  opKinds: ("create" | "update" | "deprecate" | "move")[];
  conceptKinds: ConceptKind[];
  citationKinds: ("source_document" | "trace" | "flag" | "concept" | "url")[];
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
  if (a.require_observed_evidence && !p.citationKinds.some((k) => k === "trace" || k === "flag")) {
    return { autoApply: false, reason: "no evidence observed in real agent work" };
  }
  return { autoApply: true, reason: "matches the space auto-apply policy" };
}
