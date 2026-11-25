import { createServerFn } from "@tanstack/react-start";
import type { FlagRow } from "@/components/inbox/flag-list";
import type { ProposalRow } from "@/components/inbox/proposal-list";
import { actorUserId } from "@/lib/format";
import { atLeast } from "@/lib/roles";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getProfiles, getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";
import { myInvitations } from "@/server/invitations.functions";

const PROPOSAL_COLS =
  "id, title, author, risk, escalation, status, auto_applied, created_at, applied_at, reviewed_at, reviewed_by, created_by, proposal_ops(count)";
const FLAG_COLS =
  "id, kind, concept_id, concept_path, query, observation, suggested_fix, created_by, trace_id, synthetic, created_at, status, audience, resolution, proposal_id";

/** Inbox: pending proposals, decided proposals (history) and open flags. */
export const loadInbox = createServerFn({ method: "GET" })
  .validator((d: SpaceParams) => spaceParams(d))
  .handler(async ({ data }) => {
    const ctx = await getSpaceContext(data.workspace, data.space);
    const supabase = getSupabase();
    const isEditor = atLeast(ctx.role, "editor");

    const [pendingRes, historyRes, flagsRes, invitations] = await Promise.all([
      isEditor
        ? supabase
            .from("proposals")
            .select(PROPOSAL_COLS)
            .eq("space_id", ctx.space.id)
            .in("status", ["pending", "approved"])
            .order("created_at", { ascending: false })
            .limit(100)
        : Promise.resolve({ data: [] as ProposalRow[] }),
      isEditor
        ? supabase
            .from("proposals")
            .select(PROPOSAL_COLS)
            .eq("space_id", ctx.space.id)
            .in("status", ["applied", "rejected", "conflicted", "superseded"])
            .order("created_at", { ascending: false })
            .limit(50)
        : Promise.resolve({ data: [] as ProposalRow[] }),
      // readers only get their own flags back from RLS; editors+ see every flag in their audience
      supabase.from("flags").select(FLAG_COLS).eq("space_id", ctx.space.id).eq("status", "open").order("created_at", { ascending: false }).limit(200),
      // "you've been invited" banner (open invitations to other workspaces)
      myInvitations(),
    ]);

    const pending = pendingRes.data ?? [];
    const history = (historyRes.data ?? []).sort((a, b) =>
      (b.applied_at ?? b.reviewed_at ?? b.created_at).localeCompare(a.applied_at ?? a.reviewed_at ?? a.created_at),
    );
    const flags = (flagsRes.data ?? []) as FlagRow[];
    const profiles = await getProfiles([
      ...pending.map((p) => actorUserId(p.author)),
      ...history.flatMap((p) => [actorUserId(p.author), p.reviewed_by]),
      ...flags.map((f) => f.created_by),
    ]);
    return { pending, history, flags, profiles, invitations };
  });
