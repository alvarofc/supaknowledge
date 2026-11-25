// Structured-output schemas for every curator LLM call. Kept flat and simple (objects, arrays, enums,
// strings, nullables) so they work with constrained decoding.
import { z } from "zod";

export const CorrectionSchema = z.object({
  lessons: z.array(
    z.object({
      /** event seq numbers that show the problem and the correction */
      seqs: z.array(z.number().int()),
      kind: z.enum(["missing", "incorrect", "outdated", "unclear"]),
      knowledge_kind: z.enum(["skill", "domain", "data_access"]),
      /** the reusable lesson, phrased as knowledge ("ARR excludes one-off services revenue") */
      lesson: z.string(),
      /** what the agent did or believed before being corrected */
      observation: z.string(),
      /** exact short quote from the trace that proves the lesson */
      evidence_quote: z.string(),
      /** best guess of an existing concept path this belongs to, or null */
      concept_path: z.string().nullable(),
      /** true when this is a durable rule, false when it was a one-off preference for this task */
      durable: z.boolean(),
    }),
  ),
});
export type CorrectionOutput = z.infer<typeof CorrectionSchema>;

export const ClusterSchema = z.object({
  clusters: z.array(
    z.object({
      topic: z.string(),
      /** ids of signals ("f:<flag id>", "d:<document id>") that belong together */
      signal_ids: z.array(z.string()),
      /** existing concept paths this topic likely touches */
      concept_paths: z.array(z.string()),
      /** search query to research this topic in sources */
      research_query: z.string(),
      priority: z.enum(["high", "medium", "low"]),
    }),
  ),
  /** signals that need no knowledge change (noise, duplicates, already covered) with a reason each */
  ignored: z.array(z.object({ signal_id: z.string(), reason: z.string() })),
});
export type ClusterOutput = z.infer<typeof ClusterSchema>;

const OpSchema = z.object({
  op: z.enum(["create", "update", "deprecate", "move"]),
  path: z.string(),
  new_path: z.string().nullable(),
  kind: z.enum(["skill", "domain", "data_access"]).nullable(),
  type: z.string().nullable(),
  title: z.string().nullable(),
  description: z.string().nullable(),
  /** complete new markdown body (no frontmatter) for create/update; null to keep the body */
  body: z.string().nullable(),
  tags: z.array(z.string()).nullable(),
  superseded_by: z.string().nullable(),
  /** RFC 3339; when this knowledge should be re-checked */
  stale_after: z.string().nullable(),
  /** labels of citations supporting this op */
  citation_labels: z.array(z.string()),
  rationale: z.string(),
});

export const DraftSchema = z.object({
  decision: z.enum(["propose", "no_change"]),
  title: z.string(),
  rationale: z.string(),
  risk: z.enum(["low", "medium", "high"]),
  ops: z.array(OpSchema),
  citations: z.array(
    z.object({
      label: z.string(),
      /** id exactly as given in the evidence list: "doc:<id>", "trace:<id>", "flag:<id>", "concept:<path>", or a URL */
      ref: z.string(),
      quote: z.string(),
    }),
  ),
  /** flag ids (from the evidence list) this proposal addresses */
  resolves_flags: z.array(z.string()),
  /** flag ids that are wrong or need no change, with why */
  dismiss_flags: z.array(z.object({ flag_id: z.string(), reason: z.string() })),
});
export type DraftOutput = z.infer<typeof DraftSchema>;

export const ReviewSchema = z.object({
  ok: z.boolean(),
  issues: z.array(
    z.object({
      severity: z.enum(["blocker", "warning"]),
      kind: z.enum(["contradiction", "unsupported_claim", "lost_information", "format", "scope", "other"]),
      detail: z.string(),
    }),
  ),
  /** risk after review */
  risk: z.enum(["low", "medium", "high"]),
});
export type ReviewOutput = z.infer<typeof ReviewSchema>;
