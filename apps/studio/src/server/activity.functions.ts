import { createServerFn } from "@tanstack/react-start";
import { notFound } from "@tanstack/react-router";
import type { TraceEventRow } from "@/components/activity/transcript";
import type { FlagRow } from "@/components/inbox/flag-list";
import { actorUserId, cancelledBy } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import type { SpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

export const PAGE_SIZE = 50;
export type ActivityTab = "runs" | "audit" | "traces";

async function loadRuns(ctx: SpaceContext, isAdmin: boolean) {
  const supabase = getSupabase();
  const { data: runs } = await supabase
    .from("curator_runs")
    .select("id, trigger, requested_by, status, since, until, stats, error, created_at, started_at, finished_at")
    .eq("space_id", ctx.space.id)
    .order("created_at", { ascending: false })
    .limit(50);
  const list = runs ?? [];
  // task rows without their (large) input/output payloads: those load on demand (loadTaskPayload)
  const [{ data: tasks }, profiles] = await Promise.all([
    isAdmin && list.length
      ? supabase
          .from("curator_tasks")
          .select("id, run_id, step, status, attempts, error, created_at, finished_at")
          .in(
            "run_id",
            list.map((r) => r.id),
          )
          .order("created_at")
      : Promise.resolve({ data: [] as never[] }),
    getProfiles(list.flatMap((r) => [r.requested_by, actorUserId(cancelledBy(r.error))])),
  ]);
  return { list, tasks: tasks ?? [], profiles };
}

/** Input and output of one curator task (space admins; RLS decides), loaded when its details are opened. */
export const loadTaskPayload = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { taskId: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    if (!/^[0-9a-f-]{36}$/i.test(data.taskId)) throw notFound();
    const { data: task } = await getSupabase()
      .from("curator_tasks")
      .select("input, output")
      .eq("id", data.taskId)
      .eq("space_id", ctx.space.id)
      .maybeSingle();
    if (!task) throw notFound();
    return task;
  });

async function loadTraces(ctx: SpaceContext, from: number) {
  const { data, count } = await getSupabase()
    .from("traces")
    .select("id, name, outcome, principal_id, on_behalf_of, started_at, ended_at, curated_at, trace_events(count)", { count: "exact" })
    .eq("space_id", ctx.space.id)
    .order("started_at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  const traces = (data ?? []).map(({ trace_events, ...t }) => ({
    ...t,
    events: (trace_events as unknown as { count: number }[])[0]?.count ?? 0,
  }));
  const profiles = await getProfiles(traces.flatMap((t) => [t.principal_id, t.on_behalf_of]));
  return { traces, count: count ?? 0, profiles };
}

async function loadAudit(ctx: SpaceContext, from: number) {
  const { data, count } = await getSupabase()
    .from("audit_log")
    .select("id, actor, actor_user_id, action, target_kind, target_id, data, at", { count: "exact" })
    .eq("space_id", ctx.space.id)
    .order("at", { ascending: false })
    .range(from, from + PAGE_SIZE - 1);
  const rows = data ?? [];
  const profiles = await getProfiles(rows.map((r) => r.actor_user_id));
  return { rows, count: count ?? 0, profiles };
}

/** Activity: curator runs (and their tasks for admins), traces (reviewers+) or the audit log (admins). */
export const loadActivity = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { tab?: string; page: number }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const isAdmin = atLeast(ctx.role, "admin");
    const isReviewer = atLeast(ctx.role, "reviewer");
    const allowed: ActivityTab[] = ["runs", ...(isReviewer ? (["traces"] as ActivityTab[]) : []), ...(isAdmin ? (["audit"] as ActivityTab[]) : [])];
    const tab: ActivityTab = allowed.includes(data.tab as ActivityTab) ? (data.tab as ActivityTab) : "runs";
    const page = Math.max(1, Math.floor(Number(data.page)) || 1);
    const from = (page - 1) * PAGE_SIZE;

    return {
      tab,
      page,
      runs: tab === "runs" ? await loadRuns(ctx, isAdmin) : null,
      traces: tab === "traces" ? await loadTraces(ctx, from) : null,
      audit: tab === "audit" ? await loadAudit(ctx, from) : null,
    };
  });

/** One trace: transcript, the knowledge it used and the flags raised from it. RLS decides who may read it. */
export const loadTrace = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { id: string }) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    if (!/^[0-9a-f-]{36}$/i.test(data.id)) throw notFound();
    const supabase = getSupabase();

    // RLS: the sender, the person it was for, and reviewers+ in the trace's audience
    const { data: trace } = await supabase
      .from("traces")
      .select("id, name, outcome, principal_id, on_behalf_of, external_id, metadata, audience, started_at, ended_at, curated_at")
      .eq("id", data.id)
      .eq("space_id", ctx.space.id)
      .maybeSingle();
    if (!trace) throw notFound();

    const [eventsRes, flagsRes, usageRes] = await Promise.all([
      supabase
        .from("trace_events")
        .select("id, seq, role, content, tool_name, tool_input, tool_output, is_error, at")
        .eq("trace_id", trace.id)
        .order("seq")
        .limit(1000),
      supabase
        .from("flags")
        .select(
          "id, kind, concept_id, concept_path, query, observation, suggested_fix, created_by, trace_id, synthetic, created_at, status, audience, resolution",
        )
        .eq("trace_id", trace.id)
        .order("created_at"),
      supabase.from("concept_usage").select("id, concept_id, revision, via, query, at").eq("trace_id", trace.id).order("at"),
    ]);
    const events = (eventsRes.data ?? []) as TraceEventRow[];
    const flags = (flagsRes.data ?? []) as FlagRow[];
    const usage = usageRes.data ?? [];
    const conceptIds = [...new Set(usage.map((u) => u.concept_id))];
    const [{ data: concepts }, profiles] = await Promise.all([
      conceptIds.length
        ? supabase.from("concepts").select("id, path, title, kind").in("id", conceptIds)
        : Promise.resolve({ data: [] as { id: string; path: string; title: string; kind: "skill" | "domain" | "data_access" }[] }),
      getProfiles([trace.principal_id, trace.on_behalf_of, ...flags.map((f) => f.created_by)]),
    ]);
    return { trace, events, flags, usage, conceptIds, concepts: concepts ?? [], profiles };
  });
