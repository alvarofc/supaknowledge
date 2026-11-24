import { createServerFn } from "@tanstack/react-start";
import { spaceParams } from "@/server/shell.functions";
import type { SpaceParams } from "@/server/shell.functions";
import { getSpaceContext } from "@/server/space.server";
import { getSupabase } from "@/server/supabase.server";

/** Shape of rpc knowledge_health. */
export interface Health {
  concepts: number;
  by_kind: Partial<Record<"skill" | "domain" | "data_access", number>>;
  by_trust: Partial<Record<"unverified" | "machine_confirmed" | "human_reviewed", number>>;
  stale: number;
  open_flags: number;
  missing_flags: number;
  pending_proposals: number;
  applied_proposals: number;
  auto_applied: number;
  never_used: number;
  most_flagged: { path: string; title: string; flags: number; uses: number; flag_rate: number }[];
  last_run: {
    id: string;
    status: string;
    trigger: string;
    stats: Record<string, string | number | boolean | null>;
    finished_at: string | null;
  } | null;
}

export const HEALTH_DAYS = [7, 30, 90] as const;

/** knowledge_health for the space over a 7/30/90-day window (counts only what the user can see). */
export const loadHealth = createServerFn({ method: "GET" })
  .validator((d: SpaceParams & { days: number }) => spaceParams(d))
  .handler(async ({ data }) => {
    const days = HEALTH_DAYS.find((d) => d === Number(data.days)) ?? 30;
    const ctx = await getSpaceContext(data.workspace, data.space);
    const { data: health, error } = await getSupabase().rpc("knowledge_health", { p_space: ctx.space.id, p_days: days });
    return { days, health: (health ?? null) as unknown as Health | null, error: error?.message ?? null };
  });
