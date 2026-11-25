import { CircleStop } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useConfirm } from "@/components/ui/confirm";
import { useToast } from "@/components/ui/toast";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

/**
 * Cancel a queued or running curator run (rpc cancel_curator_run, reviewers+). Useful when a run is stuck; the
 * database also fails runs that made no progress for curator.stuck_after_minutes.
 */
export function CancelRunButton({ runId }: { runId: string }) {
  const { run, pending } = useMutation();
  const [confirm, dialog] = useConfirm();
  const toast = useToast();
  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        pending={pending}
        onClick={async () => {
          const ok = await confirm({
            title: "Cancel this curator run?",
            description: "Its remaining tasks stop. Proposals it already wrote stay in the inbox. You can start a new run afterwards.",
            confirmLabel: "Cancel run",
          });
          if (!ok) return;
          // cancel_curator_run returns the run unchanged when it already finished: only toast what actually happened
          const res = await run(async () => await createClient().rpc("cancel_curator_run", { p_run: runId }));
          if (!res.ok) return;
          if (res.data?.status === "cancelled") toast.success("Run cancelled");
          else toast.error(res.data ? `The run already ${res.data.status === "succeeded" ? "finished" : res.data.status}; nothing to cancel` : "Run not found");
        }}
      >
        {!pending ? <CircleStop className="size-3.5" /> : null} Cancel run
      </Button>
      {dialog}
    </>
  );
}
