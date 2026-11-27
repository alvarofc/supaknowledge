import { useId, useState } from "react";
import { FLAG_KIND_HELP } from "@/components/kf/badges";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { ASK_FLAG_KINDS, ASK_LIMITS } from "@/lib/ask";
import type { AskFlagKind, UsedConcept } from "@/lib/ask";
import { errorMessage } from "@/lib/format";
import { flagAnswer } from "@/server/ask.functions";

const KIND_LABEL: Record<AskFlagKind, string> = {
  incorrect: "Incorrect",
  missing: "Missing",
  outdated: "Outdated",
  unclear: "Unclear",
  conflicting: "Conflicting",
};

const NO_CONCEPT = "";

/** The short form behind "Flag this answer": raises one flag through MCP flag_knowledge, as the signed-in person. */
export function FlagAnswerDialog({
  open,
  onClose,
  onFlagged,
  workspace,
  space,
  question,
  answer,
  concepts,
  traceId,
}: {
  open: boolean;
  onClose: () => void;
  onFlagged: () => void;
  workspace: string;
  space: string;
  question: string;
  answer: string;
  concepts: UsedConcept[];
  traceId: string | null;
}) {
  const toast = useToast();
  const id = useId();
  const firstRead = concepts.find((c) => c.use !== "found")?.path ?? NO_CONCEPT;
  const [kind, setKind] = useState<AskFlagKind>(firstRead ? "incorrect" : "missing");
  const [concept, setConcept] = useState(firstRead);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!note.trim()) {
      setError("Describe what is wrong.");
      return;
    }
    setPending(true);
    try {
      const r = await flagAnswer({
        data: {
          workspace,
          space,
          kind,
          note,
          conceptPath: concept || null,
          question,
          answer,
          concepts: concepts.map((c) => c.path),
          traceId,
        },
      });
      if (!r.ok) {
        toast.error(r.message);
        return;
      }
      toast.success("Flag sent to the inbox.");
      onFlagged();
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPending(false);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissible={!pending}
      title="Flag this answer"
      description="Goes to the inbox with the question, the answer and the concepts it used."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="submit" form={`${id}-form`} variant="primary" pending={pending}>
            Send flag
          </Button>
        </>
      }
    >
      <form id={`${id}-form`} onSubmit={submit} className="flex flex-col gap-4">
        <Field label="What is wrong" htmlFor={`${id}-kind`} hint={FLAG_KIND_HELP[kind]}>
          <Select
            id={`${id}-kind`}
            value={kind}
            onChange={(e) => {
              const k = e.target.value as AskFlagKind;
              setKind(k);
              if (k === "missing") setConcept(NO_CONCEPT);
            }}
          >
            {ASK_FLAG_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Concept" htmlFor={`${id}-concept`}>
          <Select id={`${id}-concept`} value={concept} onChange={(e) => setConcept(e.target.value)}>
            <option value={NO_CONCEPT}>None: the knowledge is missing</option>
            {concepts.map((c) => (
              <option key={c.path} value={c.path}>
                {c.title ? `${c.title} (${c.path})` : c.path}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Note" htmlFor={`${id}-note`} error={error}>
          <Textarea
            id={`${id}-note`}
            rows={4}
            maxLength={ASK_LIMITS.noteMax}
            placeholder="What should the answer have said?"
            value={note}
            onChange={(e) => {
              setNote(e.target.value);
              setError(null);
            }}
          />
        </Field>
      </form>
    </Dialog>
  );
}
