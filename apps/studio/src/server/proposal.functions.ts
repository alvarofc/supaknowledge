import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import type { OpRow } from "@/components/inbox/op-card";
import type { Database, Json } from "@/lib/database.types";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

type Enums = Database["public"]["Enums"];
const CONCEPT_COLS = "id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision";

/** Concept columns as stored (frontmatter is raw JSON); the page turns them into ConceptState. */
export type ConceptCols = {
  path: string;
  kind: Enums["concept_kind"];
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter: Json;
  tags: string[];
  status: Enums["concept_status"];
  superseded_by: string | null;
  stale_after: string | null;
  audience: string[];
  revision: number;
};

/**
 * A proposal with everything a reviewer needs: its ops, the current (or, once applied, the previous) state of each
 * target concept, the cited evidence (each lookup RLS-filtered), reviews and linked flags.
 */
export const loadProposal = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { id: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    if (!/^[0-9a-f-]{36}$/i.test(data.id)) throw notFound();

    const { data: p } = await supabase
      .from("proposals")
      .select(
        "id, space_id, run_id, author, created_by, title, rationale, risk, escalation, status, auto_applied, reviewed_by, reviewed_at, review_note, applied_at, created_at",
      )
      .eq("id", data.id)
      .eq("space_id", ctx.space.id)
      .maybeSingle();
    if (!p) throw notFound();

    const [opsRes, citesRes, reviewsRes, linkedFlagsRes, revsRes, runRes] = await Promise.all([
      supabase
        .from("proposal_ops")
        .select("id, ord, op, concept_id, path, new_path, base_revision, after, target_audience, rationale")
        .eq("proposal_id", p.id)
        .order("ord"),
      supabase.from("proposal_citations").select("id, op_id, label, ref_kind, ref_id, url, quote, audience").eq("proposal_id", p.id),
      supabase.from("proposal_reviews").select("id, reviewer, decision, note, created_at").eq("proposal_id", p.id).order("created_at"),
      supabase.from("flags").select("id, kind, concept_path, observation, status, trace_id").eq("proposal_id", p.id),
      // revisions this proposal produced (for applied proposals: diff against the revision before)
      supabase.from("concept_revisions").select("concept_id, revision").eq("proposal_id", p.id),
      p.run_id
        ? supabase.from("curator_runs").select("id, trigger, status, created_at").eq("id", p.run_id).maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    const ops = (opsRes.data ?? []) as OpRow[];
    const citations = citesRes.data ?? [];
    const reviews = reviewsRes.data ?? [];
    const applied = p.status === "applied";

    // current state of the target concepts
    const conceptIds = [...new Set(ops.map((o) => o.concept_id).filter((x): x is string => Boolean(x)))];
    const { data: concepts } = conceptIds.length
      ? await supabase.from("concepts").select(CONCEPT_COLS).in("id", conceptIds)
      : { data: [] as never[] };
    const current: Record<string, ConceptCols> = {};
    for (const c of concepts ?? []) current[c.id] = c;

    // for applied proposals the "before" is the revision preceding the one this proposal wrote (null = created by it)
    const before: Record<string, ConceptCols | null> = {};
    if (applied) {
      const produced = revsRes.data ?? [];
      const prev = produced.filter((r) => r.revision > 1);
      const prevRevs = prev.length
        ? (
            await supabase
              .from("concept_revisions")
              .select("concept_id, " + CONCEPT_COLS.replace("id, ", ""))
              .or(prev.map((r) => `and(concept_id.eq.${r.concept_id},revision.eq.${r.revision - 1})`).join(","))
          ).data
        : [];
      for (const r of produced) before[r.concept_id] = null;
      for (const r of (prevRevs ?? []) as unknown as (ConceptCols & { concept_id: string })[]) before[r.concept_id] = r;
    }

    // resolve cited material (each lookup is RLS-filtered; proposals are only visible if all of it is)
    const idsOf = (k: Enums["citation_kind"]) => citations.filter((c) => c.ref_kind === k && c.ref_id).map((c) => c.ref_id!);
    const [docsRes, tracesRes, citedFlagsRes, citedConceptsRes] = await Promise.all([
      idsOf("source_document").length
        ? supabase.from("source_documents").select("id, title, url, source_id").in("id", idsOf("source_document"))
        : Promise.resolve({ data: [] as { id: string; title: string | null; url: string | null; source_id: string }[] }),
      idsOf("trace").length
        ? supabase.from("traces").select("id, name, outcome, started_at").in("id", idsOf("trace"))
        : Promise.resolve({ data: [] as { id: string; name: string | null; outcome: Enums["trace_outcome"]; started_at: string }[] }),
      idsOf("flag").length
        ? supabase.from("flags").select("id, kind, concept_path, observation, status, trace_id").in("id", idsOf("flag"))
        : Promise.resolve({
            data: [] as {
              id: string;
              kind: Enums["flag_kind"];
              concept_path: string | null;
              observation: string;
              status: Enums["flag_status"];
              trace_id: string | null;
            }[],
          }),
      idsOf("concept").length
        ? supabase.from("concepts").select("id, path, title").in("id", idsOf("concept"))
        : Promise.resolve({ data: [] as { id: string; path: string; title: string }[] }),
    ]);

    const profiles = await getProfiles([
      p.created_by,
      p.reviewed_by,
      p.author.startsWith("human:") ? p.author.slice(6) : null,
      ...reviews.map((r) => r.reviewer),
    ]);

    return {
      p,
      ops,
      citations,
      reviews,
      run: runRes.data,
      current,
      before,
      docs: docsRes.data ?? [],
      traces: tracesRes.data ?? [],
      citedFlags: citedFlagsRes.data ?? [],
      citedConcepts: citedConceptsRes.data ?? [],
      linkedFlags: linkedFlagsRes.data ?? [],
      profiles,
    };
  });
