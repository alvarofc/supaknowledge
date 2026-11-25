import { Check, RefreshCw, ShieldAlert, X } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { errorMessage } from "@/lib/format";
import { callFunction } from "@/lib/functions";
import { syncFilesErrorMessage } from "@/lib/skill-files";
import { createClient } from "@/lib/supabase/client";

async function syncFiles(proposalId: string): Promise<number> {
  return (await callFunction<{ files_synced: number }>("bundle/sync-files", { body: { proposal_id: proposalId } })).files_synced;
}

/**
 * Shown on an applied proposal whose skill files are not in Storage yet (the sync right after approving failed).
 * bundle/sync-files is idempotent, so retrying is always safe.
 */
export function RetryFileSync({ proposalId }: { proposalId: string }) {
  const router = useRouter();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  return (
    <Callout tone="warn" title="Skill files not synced" className="mt-3">
      <p>This proposal is applied, but its skill files have not been copied into Storage yet, so agents can't download them.</p>
      <Button
        size="sm"
        className="mt-2"
        pending={busy}
        onClick={async () => {
          setBusy(true);
          try {
            const n = await syncFiles(proposalId);
            toast.success(n ? `${n} skill file${n === 1 ? "" : "s"} synced.` : "Nothing left to sync.");
            startTransition(() => router.invalidate());
          } catch (e) {
            toast.error(`The skill files were not synced: ${syncFilesErrorMessage(e)}.`);
          } finally {
            setBusy(false);
          }
        }}
      >
        {!busy ? <RefreshCw className="size-3.5" /> : null} Retry file sync
      </Button>
    </Callout>
  );
}

/**
 * Approve (rpc apply_proposal) or reject (rpc reject_proposal) a proposal. The database re-checks
 * everything: reviewer role, visibility of all evidence, admin for escalations, and base revisions.
 * Skill files travel inside the ops (`after.files`) and are copied into Storage by `bundle/sync-files` once the
 * proposal is applied (same as `kf approve`).
 */
export function ReviewActions({
  proposalId,
  canApprove,
  canReject,
  approveBlockedReason,
  hasFiles = false,
}: {
  proposalId: string;
  /** some op carries skill files (after.files) that must be synced into Storage after applying */
  hasFiles?: boolean;
  canApprove: boolean;
  canReject: boolean;
  approveBlockedReason?: string | null;
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<"approve" | "reject" | null>(null);
  const [note, setNote] = useState("");
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();

  const rejectError = dialog === "reject" && touched && !note.trim() ? "A reason is required — the curator reads it on its next run." : null;

  function close() {
    setDialog(null);
    setNote("");
    setTouched(false);
  }

  async function approve() {
    setBusy(true);
    try {
      const { data, error } = await createClient().rpc("apply_proposal", { p_proposal: proposalId, p_note: note.trim() || undefined });
      if (error) {
        toast.error(errorMessage(error));
        return;
      }
      if (data?.status === "conflicted") {
        toast.error("Not applied: the knowledge changed since this proposal was drafted. See the conflict details.");
      } else {
        let synced: number | null = null;
        let syncError: string | null = null;
        if (hasFiles) {
          try {
            synced = await syncFiles(proposalId);
          } catch (e) {
            syncError = syncFilesErrorMessage(e);
          }
        }
        // one toast: a failed file sync is the news, not the (successful) apply
        if (syncError) toast.error(`Applied, but the skill files were not synced into Storage: ${syncError}.${/Retry file sync/.test(syncError) ? "" : " Use “Retry file sync” on this page."}`);
        else toast.success(`Applied. The knowledge is updated and verified by you.${synced ? ` ${synced} skill file${synced === 1 ? "" : "s"} synced.` : ""}`);
      }
      close();
      startTransition(() => router.invalidate());
    } finally {
      setBusy(false);
    }
  }

  async function reject() {
    setTouched(true);
    if (!note.trim()) return;
    setBusy(true);
    try {
      const { error } = await createClient().rpc("reject_proposal", { p_proposal: proposalId, p_note: note.trim() });
      if (error) {
        toast.error(errorMessage(error));
        return;
      }
      toast.success("Rejected. Linked flags are back in the curator's queue.");
      close();
      startTransition(() => router.invalidate());
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {approveBlockedReason ? (
        <Callout tone="danger" icon={<ShieldAlert />} title="You cannot approve this">
          {approveBlockedReason}
        </Callout>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canApprove ? (
          <Button variant="primary" onClick={() => setDialog("approve")} disabled={Boolean(approveBlockedReason)}>
            <Check className="size-4" /> Approve &amp; apply
          </Button>
        ) : null}
        {canReject ? (
          <Button variant="outline-danger" onClick={() => setDialog("reject")}>
            <X className="size-4" /> Reject
          </Button>
        ) : null}
      </div>

      <Dialog
        open={dialog === "approve"}
        onClose={close}
        title="Approve and apply this proposal?"
        description="Each change becomes a new revision, marked as verified by you. Linked flags are resolved."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" pending={busy} onClick={approve}>
              Approve &amp; apply
            </Button>
          </>
        }
      >
        <Field label="Note" htmlFor="approve-note" optional hint="Saved with the review and the verification.">
          <Textarea id="approve-note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Checked against the finance dashboard." />
        </Field>
      </Dialog>

      <Dialog
        open={dialog === "reject"}
        onClose={close}
        title="Reject this proposal?"
        description="Nothing changes in the knowledge. Flags it addressed go back to open, and your reason is context for the curator's next draft."
        footer={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="danger" pending={busy} onClick={reject}>
              Reject proposal
            </Button>
          </>
        }
      >
        <Field label="Reason" htmlFor="reject-note" error={rejectError} hint="Required.">
          <Textarea
            id="reject-note"
            rows={4}
            value={note}
            autoFocus
            aria-invalid={Boolean(rejectError) || undefined}
            aria-describedby={rejectError ? "reject-note-error" : "reject-note-hint"}
            onChange={(e) => setNote(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. The column was renamed only in staging; production still uses revenue_usd."
          />
        </Field>
      </Dialog>
    </div>
  );
}
