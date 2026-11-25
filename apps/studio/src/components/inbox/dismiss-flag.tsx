import { X } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Textarea } from "@/components/ui/form";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

/** Dismiss a flag with a reason (rpc dismiss_flag; RLS: reviewers in the flag's audience). */
export function DismissFlagButton({ flagId, observation }: { flagId: string; observation: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [touched, setTouched] = useState(false);
  const { run, pending } = useMutation();
  const error = touched && !reason.trim() ? "Say why, so the curator and the agent's owner can learn from it." : null;
  const fieldId = `dismiss-${flagId}`;

  async function submit() {
    setTouched(true);
    if (!reason.trim()) return;
    const res = await run(async () => await createClient().rpc("dismiss_flag", { p_flag: flagId, p_reason: reason.trim() }), {
      success: "Flag dismissed",
    });
    if (res.ok) {
      setOpen(false);
      setReason("");
      setTouched(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <X className="size-3.5" /> Dismiss
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title="Dismiss this flag?"
        description="Dismissed flags leave the curator's queue. Use this when the report is wrong, a duplicate, or not worth acting on."
        footer={
          <>
            <Button onClick={() => setOpen(false)}>Cancel</Button>
            <Button variant="primary" pending={pending} onClick={submit}>
              Dismiss flag
            </Button>
          </>
        }
      >
        <blockquote className="mb-4 border-l-2 border-line-strong pl-3 text-sm text-muted">{observation}</blockquote>
        <Field label="Reason" htmlFor={fieldId} error={error} hint="Required. Visible to reviewers and recorded on the flag.">
          <Textarea
            id={fieldId}
            rows={3}
            value={reason}
            autoFocus
            aria-invalid={Boolean(error) || undefined}
            aria-describedby={error ? `${fieldId}-error` : `${fieldId}-hint`}
            onChange={(e) => setReason(e.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="e.g. Duplicate of an existing flag; the column was renamed back yesterday."
          />
        </Field>
      </Dialog>
    </>
  );
}
