import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { callFunction, FunctionError } from "@/lib/functions";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

/**
 * Queue a manual curator run through POST /curator/run, which applies the per-space cooldown and per-caller rate
 * limit (KF_CURATOR_RUN_COOLDOWN_S). Falls back to rpc request_curator_run only when the function is not deployed.
 * The database keeps one active run per space and the kf-curator cron hands queued tasks to the curator function.
 */
async function requestRun(spaceId: string) {
  try {
    return await callFunction("curator/run", { body: { space: spaceId } });
  } catch (e) {
    if (e instanceof FunctionError && e.status === 429) {
      throw new Error("The curator ran recently for this space. Try again in a couple of minutes.");
    }
    if (e instanceof FunctionError && (e.status === 404 || e.status === 501)) {
      const { error } = await createClient().rpc("request_curator_run", { p_space: spaceId });
      if (error) throw error;
      return null;
    }
    throw e;
  }
}

export function RunCuratorButton({ spaceId, active }: { spaceId: string; active: boolean }) {
  const { run, pending } = useMutation();
  return (
    <Button
      variant="primary"
      pending={pending}
      disabled={active}
      title={active ? "A run is already queued or running for this space" : undefined}
      onClick={() =>
        run(async () => await requestRun(spaceId), {
          success: "Curator run queued. It starts within a few seconds.",
        })
      }
    >
      {!pending ? <Play className="size-3.5" /> : null}
      {active ? "Run in progress" : "Run curator now"}
    </Button>
  );
}
