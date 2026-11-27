import { notFound } from "@tanstack/react-router";
import { createServerFn } from "@tanstack/react-start";
import { actorUserId } from "@/lib/format";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** A concept page: the concept, its links and backlinks, files, open flags, verifications and (on the History tab) revisions. */
export const loadConcept = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { path: string; history: boolean }) => {
    if (typeof d.path !== "string" || !d.path) throw new Error("Bad request");
    return spaceParams(d);
  })
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();

    const { data: concept } = await supabase
      .from("concepts")
      .select(
        "id, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, revision, generated_by, generated_at, created_at, updated_at, trust, is_stale",
      )
      .eq("space_id", ctx.space.id)
      .eq("path", data.path)
      .maybeSingle();
    if (!concept) throw notFound();

    const [linksRes, backRes, filesRes, flagsRes, verRes, revRes] = await Promise.all([
      supabase.from("concept_links").select("to_path, to_concept, anchor").eq("from_concept", concept.id).order("to_path"),
      supabase.from("concept_links").select("from_concept, anchor").eq("to_concept", concept.id),
      supabase.from("concept_files").select("id, path, content_type, size_bytes").eq("concept_id", concept.id).order("path"),
      supabase
        .from("flags")
        .select("id, kind, observation, suggested_fix, created_by, synthetic, trace_id, created_at, schema_drift:evidence->schema_drift->>key")
        .eq("concept_id", concept.id)
        .eq("status", "open")
        .order("created_at", { ascending: false }),
      supabase
        .from("verifications")
        .select("id, revision, actor, actor_user_id, note, created_at")
        .eq("concept_id", concept.id)
        .order("created_at", { ascending: false }),
      data.history
        ? supabase
            .from("concept_revisions")
            .select(
              "id, revision, path, kind, type, title, description, body, frontmatter, tags, status, superseded_by, stale_after, audience, actor, actor_user_id, reason, proposal_id, created_at",
            )
            .eq("concept_id", concept.id)
            .order("revision", { ascending: false })
        : Promise.resolve({ data: null }),
    ]);

    const links = linksRes.data ?? [];
    const backlinks = backRes.data ?? [];
    const relatedIds = [
      ...new Set([...links.map((l) => l.to_concept), ...backlinks.map((b) => b.from_concept)].filter((x): x is string => Boolean(x))),
    ];
    const { data: related } = relatedIds.length
      ? await supabase.from("concepts").select("id, path, title, kind").in("id", relatedIds)
      : { data: [] as { id: string; path: string; title: string; kind: "skill" | "domain" | "data_access" }[] };

    const verifications = verRes.data ?? [];
    const revisions = revRes.data ?? [];
    const flags = flagsRes.data ?? [];
    const profiles = await getProfiles([
      actorUserId(concept.generated_by),
      ...verifications.map((v) => v.actor_user_id),
      ...revisions.map((r) => r.actor_user_id),
      ...flags.map((f) => f.created_by),
    ]);

    return {
      concept,
      links,
      backlinks,
      related: related ?? [],
      files: filesRes.data ?? [],
      flags,
      verifications,
      revisions,
      profiles,
    };
  });
