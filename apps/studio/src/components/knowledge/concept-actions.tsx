import { BadgeCheck, Flag, History, Pencil } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useId, useState } from "react";
import { FLAG_KIND_HELP } from "@/components/kf/badges";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/form";
import type { Database } from "@/lib/database.types";
import { createClient } from "@/lib/supabase/client";
import { useMutation } from "@/lib/use-mutation";

type FlagKind = Database["public"]["Enums"]["flag_kind"];
const FLAG_KINDS: FlagKind[] = ["incorrect", "outdated", "conflicting", "unclear", "missing"];

export function ConceptActions({
  conceptId,
  spaceId,
  path,
  revision,
  base,
  canEdit,
  canVerify,
  alreadyVerifiedByMe,
}: {
  conceptId: string;
  spaceId: string;
  path: string;
  revision: number;
  base: string;
  canEdit: boolean;
  canVerify: boolean;
  alreadyVerifiedByMe: boolean;
}) {
  const [dialog, setDialog] = useState<"verify" | "report" | null>(null);
  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {canVerify ? (
          <Button onClick={() => setDialog("verify")} disabled={alreadyVerifiedByMe} title={alreadyVerifiedByMe ? "You already verified this revision" : undefined}>
            <BadgeCheck className="size-4" /> {alreadyVerifiedByMe ? "Verified by you" : "Verify"}
          </Button>
        ) : null}
        {canEdit ? (
          <LinkButton href={`${base}/suggest?path=${encodeURIComponent(path)}`}>
            <Pencil className="size-4" /> Suggest an edit
          </LinkButton>
        ) : null}
        <Button onClick={() => setDialog("report")}>
          <Flag className="size-4" /> Report a problem
        </Button>
      </div>
      <VerifyDialog open={dialog === "verify"} onClose={() => setDialog(null)} conceptId={conceptId} revision={revision} />
      <ReportDialog open={dialog === "report"} onClose={() => setDialog(null)} spaceId={spaceId} path={path} />
    </>
  );
}

function VerifyDialog({ open, onClose, conceptId, revision }: { open: boolean; onClose: () => void; conceptId: string; revision: number }) {
  const [note, setNote] = useState("");
  const { run, pending } = useMutation();
  const id = useId();
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`Verify revision ${revision}`}
      description="You vouch that this revision is correct. The concept becomes “Human reviewed” until its next change, and agents see that trust tier in search results."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={pending}
            onClick={async () => {
              const r = await run(
                async () => await createClient().rpc("verify_concept", { p_concept: conceptId, p_note: note.trim() || undefined }),
                { success: "Verified — this revision is now human reviewed" },
              );
              if (r.ok) {
                setNote("");
                onClose();
              }
            }}
          >
            <BadgeCheck className="size-4" /> Verify
          </Button>
        </>
      }
    >
      <Field label="Note" htmlFor={`${id}-note`} optional hint="For example, what you checked it against.">
        <Textarea id={`${id}-note`} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Checked against the finance handbook, Nov 2026" />
      </Field>
    </Dialog>
  );
}

function ReportDialog({ open, onClose, spaceId, path }: { open: boolean; onClose: () => void; spaceId: string; path: string }) {
  const [kind, setKind] = useState<FlagKind>("incorrect");
  const [observation, setObservation] = useState("");
  const [fix, setFix] = useState("");
  const [touched, setTouched] = useState(false);
  const { run, pending } = useMutation();
  const id = useId();
  const missingObs = observation.trim().length === 0;
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Report a problem"
      description="Flags go to the space's inbox. The curator reads open flags on its next run and proposes a fix for review."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            pending={pending}
            onClick={async () => {
              setTouched(true);
              if (missingObs) return;
              const r = await run(
                async () =>
                  await createClient().rpc("flag_knowledge", {
                    p_space: spaceId,
                    p_kind: kind,
                    p_observation: observation.trim(),
                    p_concept_path: path,
                    p_suggested_fix: fix.trim() || undefined,
                  }),
                { success: "Thanks — your flag is in the inbox" },
              );
              if (r.ok) {
                setObservation("");
                setFix("");
                setTouched(false);
                onClose();
              }
            }}
          >
            <Flag className="size-4" /> Send flag
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="What kind of problem?" htmlFor={`${id}-kind`} hint={FLAG_KIND_HELP[kind]}>
          <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as FlagKind)}>
            {FLAG_KINDS.map((k) => (
              <option key={k} value={k}>
                {k[0].toUpperCase() + k.slice(1)}
              </option>
            ))}
          </Select>
        </Field>
        <Field
          label="What did you see?"
          htmlFor={`${id}-obs`}
          error={touched && missingObs ? "Describe what is wrong so the curator can fix it" : null}
          hint="Be specific: quote the sentence, name the column, link the source that disagrees."
        >
          <Textarea
            id={`${id}-obs`}
            rows={4}
            value={observation}
            aria-invalid={touched && missingObs}
            onChange={(e) => setObservation(e.target.value)}
            placeholder="The query uses revenue_usd, but the column was renamed to revenue_usd_net in October."
          />
        </Field>
        <Field label="Suggested fix" htmlFor={`${id}-fix`} optional>
          <Textarea id={`${id}-fix`} rows={3} value={fix} onChange={(e) => setFix(e.target.value)} />
        </Field>
        <Callout tone="neutral">The flag inherits this concept&apos;s audience, so only people who can read the concept will see it.</Callout>
      </div>
    </Dialog>
  );
}

export function RevertButton({ conceptId, revision, base }: { conceptId: string; revision: number; base: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const { run, pending } = useMutation();
  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>
        <History className="size-3.5" /> Revert to this revision
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        title={`Revert to revision ${revision}?`}
        description="This creates a proposal that restores the content of this revision. Nothing changes until a reviewer approves it."
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button
              variant="primary"
              pending={pending}
              onClick={async () => {
                await run(async () => await createClient().rpc("propose_revert", { p_concept: conceptId, p_revision: revision }), {
                  success: "Revert proposal created",
                  refresh: false,
                  onSuccess: (p) => {
                    setOpen(false);
                    if (p && typeof p === "object" && "id" in p) router.navigate({ href: `${base}/proposals/${(p as { id: string }).id}` });
                  },
                });
              }}
            >
              Create revert proposal
            </Button>
          </>
        }
      >
        <p className="text-sm text-muted">
          The proposal restores this revision&apos;s title, description, body, frontmatter, tags, status and audience. It is drafted against the
          current revision, so if someone changes the concept first, it will show as conflicted instead of overwriting their work.
        </p>
      </Dialog>
    </>
  );
}
