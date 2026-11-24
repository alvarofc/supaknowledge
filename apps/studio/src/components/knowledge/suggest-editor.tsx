import { Eye, GitPullRequestCreate, Pencil, ShieldAlert } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useId, useMemo, useState } from "react";
import { AudiencePicker } from "@/components/kf/audience-picker";
import { KIND_HELP, KIND_LABEL } from "@/components/kf/badges";
import { DiffView } from "@/components/kf/diff-view";
import { Markdown } from "@/components/kf/markdown";
import { Button, LinkButton } from "@/components/ui/button";
import { Callout, Card, CardHeader } from "@/components/ui/card";
import { Field, Input, Select, Textarea } from "@/components/ui/form";
import { Segmented } from "@/components/ui/tabs";
import { useToast } from "@/components/ui/toast";
import type { Database, Json } from "@/lib/database.types";
import { errorMessage } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import { conceptHref, validateConceptPath } from "./paths";

type Enums = Database["public"]["Enums"];
const KINDS: Enums["concept_kind"][] = ["domain", "skill", "data_access"];
const STATUSES: Enums["concept_status"][] = ["stable", "draft", "deprecated"];
const TYPE_SUGGESTIONS = ["Reference", "Definition", "Metric", "Policy", "Playbook", "Procedure", "Skill", "BigQuery Table", "Postgres Table", "API Endpoint"];

export interface EditableConcept {
  id: string;
  path: string;
  kind: Enums["concept_kind"];
  type: string;
  title: string;
  description: string;
  body: string;
  frontmatter: Json;
  tags: string[];
  status: Enums["concept_status"];
  stale_after: string | null;
  audience: string[];
  revision: number;
}

function sameSet(a: string[], b: string[]) {
  return a.length === b.length && a.every((x) => b.includes(x));
}

/** Mirrors private.is_escalation: restricted source -> target that is unrestricted or not a subset. */
function widens(source: string[], target: string[]) {
  if (source.length === 0) return false;
  if (target.length === 0) return true;
  return !target.every((t) => source.includes(t));
}

function parseTags(s: string): string[] {
  return [...new Set(s.split(",").map((t) => t.trim()).filter(Boolean))];
}

export function SuggestEditor({
  concept,
  spaceId,
  base,
  groups,
  myGroupIds,
}: {
  concept: EditableConcept | null;
  spaceId: string;
  base: string;
  groups: { id: string; name: string; description: string | null }[];
  myGroupIds: string[];
}) {
  const router = useRouter();
  const toast = useToast();
  const id = useId();
  const isCreate = concept === null;

  const [path, setPath] = useState(concept?.path ?? "");
  const [title, setTitle] = useState(concept?.title ?? "");
  const [description, setDescription] = useState(concept?.description ?? "");
  const [kind, setKind] = useState<Enums["concept_kind"]>(concept?.kind ?? "domain");
  const [type, setType] = useState(concept?.type ?? "Reference");
  const [status, setStatus] = useState<Enums["concept_status"]>(concept?.status ?? "stable");
  const [tags, setTags] = useState((concept?.tags ?? []).join(", "));
  const [staleAfter, setStaleAfter] = useState(concept?.stale_after ? concept.stale_after.slice(0, 10) : "");
  const [audience, setAudience] = useState<string[]>(concept?.audience ?? []);
  const [body, setBody] = useState(concept?.body ?? "");
  const [bodyView, setBodyView] = useState<"write" | "preview" | "diff">("write");
  const [proposalTitle, setProposalTitle] = useState("");
  const [rationale, setRationale] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const staleIso = staleAfter ? new Date(`${staleAfter}T00:00:00Z`).toISOString() : null;
  const audienceChanged = !isCreate && !sameSet(audience, concept.audience);
  const escalates = !isCreate && widens(concept.audience, audience);

  const changed = useMemo(() => {
    if (isCreate) return true;
    const c = concept;
    return (
      title !== c.title ||
      description !== c.description ||
      kind !== c.kind ||
      type !== c.type ||
      status !== c.status ||
      body !== c.body ||
      !sameSet(parseTags(tags), c.tags) ||
      (staleIso ?? null) !== (c.stale_after ? new Date(c.stale_after).toISOString() : null) ||
      audienceChanged
    );
  }, [isCreate, concept, title, description, kind, type, status, body, tags, staleIso, audienceChanged]);

  async function validate(): Promise<Record<string, string>> {
    const e: Record<string, string> = {};
    if (isCreate) {
      const pe = validateConceptPath(path.trim());
      if (pe) e.path = pe;
      else {
        const { data } = await createClient().from("concepts").select("id").eq("space_id", spaceId).eq("path", path.trim()).maybeSingle();
        if (data) e.path = "A concept already exists at this path — open it and suggest an edit instead";
      }
    }
    if (!title.trim()) e.title = "Title is required";
    if (!type.trim()) e.type = "Type is required (for example Metric, Policy, Playbook)";
    if (!body.trim()) e.body = "Write the knowledge itself — agents read the body";
    if (!changed) e.form = "Nothing changed yet. Edit a field before submitting.";
    const notMine = audience.filter((g) => !myGroupIds.includes(g));
    if (notMine.length) e.audience = "You can only restrict knowledge to groups you belong to";
    return e;
  }

  async function submit() {
    setSubmitting(true);
    try {
      const e = await validate();
      setErrors(e);
      if (Object.keys(e).length) {
        toast.error(e.form ?? "Fix the highlighted fields first");
        return;
      }
      const supabase = createClient();
      const finalPath = isCreate ? path.trim() : concept.path;
      const after = {
        kind,
        type: type.trim(),
        title: title.trim(),
        description: description.trim(),
        body,
        frontmatter: (concept?.frontmatter ?? {}) as Json,
        tags: parseTags(tags),
        status,
        stale_after: staleIso,
        audience,
      };
      // one atomic RPC: the proposal, its op and citations commit together (author is forced to human:<you>)
      const { data: proposal, error: pErr } = await supabase.rpc("create_proposal", {
        p_space: spaceId,
        p_title: proposalTitle.trim() || `${isCreate ? "Create" : "Update"} ${finalPath}`,
        p_rationale: rationale.trim(),
        p_risk: isCreate || audienceChanged ? "medium" : "low",
        p_ops: [
          {
            op: isCreate ? "create" : "update",
            path: finalPath,
            concept_id: isCreate ? null : concept.id,
            base_revision: isCreate ? null : concept.revision,
            after,
            rationale: rationale.trim() || null,
          },
        ],
      });
      if (pErr || !proposal) {
        toast.error(`Could not create the proposal: ${errorMessage(pErr)}`);
        return;
      }
      toast.success("Proposal created — a reviewer will take it from here");
      void router.navigate({ href: `${base}/proposals/${proposal.id}` });
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      noValidate
      className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_20rem]"
    >
      <div className="min-w-0 space-y-5">
        <Card className="space-y-4 p-4">
          <Field label="Title" htmlFor={`${id}-title`} error={errors.title}>
            <Input id={`${id}-title`} value={title} onChange={(e) => setTitle(e.target.value)} aria-invalid={Boolean(errors.title)} placeholder="Annual recurring revenue (ARR)" />
          </Field>
          <Field label="Description" htmlFor={`${id}-desc`} hint="One or two sentences. Agents see this in search results before deciding to read the body.">
            <Textarea id={`${id}-desc`} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
          </Field>
        </Card>

        <Card>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-4 py-2">
            <label htmlFor={`${id}-body`} className="text-sm font-medium text-fg">
              Body <span className="font-normal text-subtle">(markdown)</span>
            </label>
            <Segmented
              label="Body view"
              value={bodyView}
              onChange={setBodyView}
              options={[
                { value: "write", label: <span className="inline-flex items-center gap-1"><Pencil className="size-3" /> Write</span> },
                { value: "preview", label: <span className="inline-flex items-center gap-1"><Eye className="size-3" /> Preview</span> },
                { value: "diff", label: isCreate ? "Diff" : "Changes" },
              ]}
            />
          </div>
          <div className="p-4">
            {bodyView === "write" ? (
              <Textarea
                id={`${id}-body`}
                rows={22}
                value={body}
                onChange={(e) => setBody(e.target.value)}
                aria-invalid={Boolean(errors.body)}
                className="font-mono text-[13px]"
                placeholder={"## Definition\n\nARR is the annualised value of active subscriptions…\n\nSee [MRR](metrics/mrr.md). Cite evidence with footnotes.[^1]\n\n[^1]: Finance handbook, section 3."}
              />
            ) : bodyView === "preview" ? (
              body.trim() ? (
                <Markdown conceptPath={path || undefined} knowledgeBase={`${base}/knowledge`}>
                  {body}
                </Markdown>
              ) : (
                <p className="text-sm text-subtle">Nothing to preview yet.</p>
              )
            ) : (
              <DiffView before={concept?.body ?? ""} after={body} beforeLabel={isCreate ? "Empty" : `Revision ${concept.revision}`} afterLabel="Your edit" />
            )}
            {errors.body ? (
              <p className="mt-1.5 text-xs text-danger" role="alert">
                {errors.body}
              </p>
            ) : null}
          </div>
        </Card>

        <Card>
          <CardHeader title="Proposal" description="Reviewers see this next to the diff. Explain why, and cite where you learned it." />
          <div className="space-y-4 p-4">
            <Field label="Proposal title" htmlFor={`${id}-ptitle`} optional>
              <Input
                id={`${id}-ptitle`}
                value={proposalTitle}
                onChange={(e) => setProposalTitle(e.target.value)}
                placeholder={`${isCreate ? "Create" : "Update"} ${(isCreate ? path : concept.path) || "concept"}`}
              />
            </Field>
            <Field label="Why this change?" htmlFor={`${id}-why`} hint="Markdown. Link the Slack thread, doc or incident that motivated it.">
              <Textarea id={`${id}-why`} rows={4} value={rationale} onChange={(e) => setRationale(e.target.value)} placeholder="Finance renamed the column on Oct 12; the revenue report agent failed twice last week." />
            </Field>
          </div>
        </Card>

        {!isCreate && !changed ? <p className="text-sm text-subtle">Edit any field to create a proposal.</p> : null}
        {errors.form ? <Callout tone="warn">{errors.form}</Callout> : null}
        {escalates ? (
          <Callout tone="danger" icon={<ShieldAlert />} title="This widens who can see this knowledge">
            The database marks proposals like this as escalations: high risk, never auto-applied, and only a space admin can approve them.
          </Callout>
        ) : null}
        <Callout tone="info" icon={<GitPullRequestCreate />} title="Your edit becomes a proposal">
          Knowledge only changes through reviewed proposals — the same audited path the curator uses. A reviewer (or admin) approves it, which creates a new
          revision{isCreate ? "" : " and marks it human reviewed"}. If someone else changes this concept first, your proposal shows as conflicted instead of
          overwriting their work.
        </Callout>
        <div className="flex flex-wrap justify-end gap-2">
          <LinkButton href={isCreate ? `${base}/knowledge` : conceptHref(base, concept.path)} variant="ghost">
            Cancel
          </LinkButton>
          <Button type="submit" variant="primary" pending={submitting} disabled={!changed}>
            <GitPullRequestCreate className="size-4" /> Submit for review
          </Button>
        </div>
      </div>

      <aside className="space-y-4" aria-label="Concept properties">
        <Card className="space-y-4 p-4">
          {isCreate ? (
            <Field label="Path" htmlFor={`${id}-path`} error={errors.path} hint="Folder-style id, e.g. metrics/arr. Becomes metrics/arr.md in OKF exports.">
              <Input
                id={`${id}-path`}
                value={path}
                onChange={(e) => setPath(e.target.value)}
                aria-invalid={Boolean(errors.path)}
                className="font-mono"
                placeholder="metrics/arr"
                autoComplete="off"
                spellCheck={false}
              />
            </Field>
          ) : (
            <div className="text-sm">
              <div className="font-medium text-fg">Path</div>
              <div className="mt-1 font-mono text-xs text-muted">{concept.path}</div>
              <div className="mt-1 text-xs text-subtle">Editing revision {concept.revision}</div>
            </div>
          )}
          <Field label="Kind" htmlFor={`${id}-kind`} hint={KIND_HELP[kind]}>
            <Select id={`${id}-kind`} value={kind} onChange={(e) => setKind(e.target.value as Enums["concept_kind"])}>
              {KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Type" htmlFor={`${id}-type`} error={errors.type} hint="Free-form OKF type.">
            <Input id={`${id}-type`} value={type} onChange={(e) => setType(e.target.value)} list={`${id}-types`} aria-invalid={Boolean(errors.type)} />
            <datalist id={`${id}-types`}>
              {TYPE_SUGGESTIONS.map((t) => (
                <option key={t} value={t} />
              ))}
            </datalist>
          </Field>
          <Field label="Status" htmlFor={`${id}-status`} hint={status === "draft" ? "Drafts are hidden from agent search." : status === "deprecated" ? "Deprecated concepts are hidden from agent search." : undefined}>
            <Select id={`${id}-status`} value={status} onChange={(e) => setStatus(e.target.value as Enums["concept_status"])}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Tags" htmlFor={`${id}-tags`} optional hint="Comma separated.">
            <Input id={`${id}-tags`} value={tags} onChange={(e) => setTags(e.target.value)} placeholder="finance, revenue" />
          </Field>
          <Field label="Re-check after" htmlFor={`${id}-stale`} optional hint="After this date the concept shows as stale and the curator re-checks it.">
            <Input id={`${id}-stale`} type="date" value={staleAfter} onChange={(e) => setStaleAfter(e.target.value)} />
          </Field>
        </Card>
        <Card className="p-4">
          <div className="mb-2 text-sm font-medium text-fg">Who can see it</div>
          <AudiencePicker groups={groups} myGroupIds={myGroupIds} value={audience} onChange={setAudience} />
          {errors.audience ? (
            <p className="mt-1.5 text-xs text-danger" role="alert">
              {errors.audience}
            </p>
          ) : null}
        </Card>
      </aside>
    </form>
  );
}
