import { Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

/**
 * Queue a manual curator run (rpc request_curator_run). The database keeps one active run per space and
 * the kf-curator cron hands queued tasks to the curator Edge Function.
 */
export function RunCuratorButton({ spaceId, active }: { spaceId: string; active: boolean }) {
  const { run, pending } = useMutation();
  return (
    <Button
      variant="primary"
      pending={pending}
      disabled={active}
      title={active ? "A run is already queued or running for this space" : undefined}
      onClick={() =>
        run(async () => await createClient().rpc("request_curator_run", { p_space: spaceId }), {
          success: "Curator run queued. It starts within a few seconds.",
        })
      }
    >
      {!pending ? <Play className="size-3.5" /> : null}
      {active ? "Run in progress" : "Run curator now"}
    </Button>
  );
}
