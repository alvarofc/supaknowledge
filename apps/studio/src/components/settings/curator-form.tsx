import type { SpaceSettings } from "@supaknowledge/core";
import { ShieldAlert } from "lucide-react";
import { useRouter } from "@tanstack/react-router";
import { useState, useTransition } from "react";
import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Callout, Card, CardHeader } from "@/components/ui/card";
import { Checkbox, Field, Input, Select, Textarea } from "@/components/ui/form";
import { useToast } from "@/components/ui/toast";
import { saveSpaceSettings } from "@/server/settings.functions";

const MODEL_PLACEHOLDER = "vercel/openai/gpt-6.2-sol or acme/your-model (blank = server default)";
/** One model id per line (commas work too). */
const parseModelList = (text: string) => text.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const KINDS = [
  { value: "data_access", label: "Data access", hint: "Table, column and query fixes observed in real work" },
  { value: "domain", label: "Domain", hint: "Definitions, policies, business facts" },
  { value: "skill", label: "Skills", hint: "Procedures and templates" },
] as const;

function Section({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <Card>
      <CardHeader title={title} description={description} />
      <div className="flex flex-col gap-5 px-4 py-4">{children}</div>
    </Card>
  );
}

export function CuratorSettingsForm({ spaceId, initial, canEdit }: { spaceId: string; initial: SpaceSettings; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [s, setS] = useState<SpaceSettings>(initial);
  // raw text of the fallback list, so typing a new line is not swallowed by parsing
  const [fallbackText, setFallbackText] = useState(initial.curator.fallback_models.join("\n"));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [pending, startTransition] = useTransition();
  const dirty = JSON.stringify(s) !== JSON.stringify(initial);

  const setCurator = <TKey extends keyof SpaceSettings["curator"]>(k: TKey, v: SpaceSettings["curator"][TKey]) => setS((x) => ({ ...x, curator: { ...x.curator, [k]: v } }));
  const setAuto = <TKey extends keyof SpaceSettings["auto_apply"]>(k: TKey, v: SpaceSettings["auto_apply"][TKey]) =>
    setS((x) => ({ ...x, auto_apply: { ...x.auto_apply, [k]: v } }));
  const num = (v: string) => (v.trim() === "" ? Number.NaN : Number(v));
  const err = (k: string) => errors[k] ?? Object.entries(errors).find(([key]) => key.startsWith(`${k}.`))?.[1] ?? null;
  const invalid = (k: string) => (errors[k] ? true : undefined);

  function save(e: React.FormEvent) {
    e.preventDefault();
    startTransition(async () => {
      const res = await saveSpaceSettings({ data: { spaceId, settings: s } });
      if (res.ok) {
        setErrors({});
        toast.success("Settings saved. The next curator run uses them.");
        void router.invalidate();
      } else {
        setErrors(res.fieldErrors ?? {});
        toast.error(res.message);
      }
    });
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-4" noValidate>
      {!canEdit ? <Callout tone="neutral">Only space admins can change these settings. You can see them so you know how this space is curated.</Callout> : null}
      <fieldset disabled={!canEdit || pending} className="flex flex-col gap-4">
        <Section
          title="Curator"
          description="The background agent that reads flags, traces and changed documents, then proposes knowledge changes with citations."
        >
          <Checkbox
            label="Run the curator for this space"
            description="Nightly when there is something new, when flags pile up, and when you start a run manually."
            checked={s.curator.enabled}
            onChange={(e) => setCurator("enabled", e.target.checked)}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <Field
              label="Flag threshold"
              htmlFor="flag_threshold"
              error={err("curator.flag_threshold")}
              hint="Open flags on one concept (or “missing” flags in the space) that trigger a run right away. 0 turns this off."
            >
              <Input id="flag_threshold" type="number" min={0} value={Number.isNaN(s.curator.flag_threshold) ? "" : s.curator.flag_threshold} aria-invalid={invalid("curator.flag_threshold")} onChange={(e) => setCurator("flag_threshold", num(e.target.value))} />
            </Field>
            <Field
              label="Research steps per cluster"
              htmlFor="max_research_steps"
              error={err("curator.max_research_steps")}
              hint="1–20. Tool calls the drafting agent may make (search, read concepts, sources and traces) before it proposes a change."
            >
              <Input
                id="max_research_steps"
                type="number"
                min={1}
                max={20}
                value={Number.isNaN(s.curator.max_research_steps) ? "" : s.curator.max_research_steps}
                aria-invalid={invalid("curator.max_research_steps")}
                onChange={(e) => setCurator("max_research_steps", num(e.target.value))}
              />
            </Field>
            <Field label="Model" htmlFor="model" optional error={err("curator.model")} hint="Drafts and checks proposals. Blank uses KF_LLM_MODEL.">
              <Input
                id="model"
                className="font-mono text-xs"
                value={s.curator.model}
                placeholder={MODEL_PLACEHOLDER}
                aria-invalid={invalid("curator.model")}
                onChange={(e) => setCurator("model", e.target.value)}
              />
            </Field>
            <Field label="Fast model" htmlFor="fast_model" optional error={err("curator.fast_model")} hint="Cheaper model for bulk work like spotting corrections in traces. Blank uses KF_LLM_FAST_MODEL, else the model.">
              <Input
                id="fast_model"
                className="font-mono text-xs"
                value={s.curator.fast_model}
                placeholder={MODEL_PLACEHOLDER}
                aria-invalid={invalid("curator.fast_model")}
                onChange={(e) => setCurator("fast_model", e.target.value)}
              />
            </Field>
            <Field
              label="Fallback models"
              htmlFor="fallback_models"
              optional
              error={err("curator.fallback_models")}
              hint="One per line, tried in order when the model errors. Blank uses KF_LLM_FALLBACK_MODELS."
            >
              <Textarea
                id="fallback_models"
                rows={3}
                className="font-mono text-xs"
                value={fallbackText}
                placeholder={"openrouter/vendor/backup-model\nacme/your-other-model"}
                aria-invalid={invalid("curator.fallback_models")}
                onChange={(e) => {
                  setFallbackText(e.target.value);
                  setCurator("fallback_models", parseModelList(e.target.value));
                }}
              />
            </Field>
            <div className="grid grid-cols-2 gap-4">
              <Field label="Max clusters / run" htmlFor="max_clusters" error={err("curator.max_clusters_per_run")} hint="1–200">
                <Input id="max_clusters" type="number" min={1} max={200} value={Number.isNaN(s.curator.max_clusters_per_run) ? "" : s.curator.max_clusters_per_run} aria-invalid={invalid("curator.max_clusters_per_run")} onChange={(e) => setCurator("max_clusters_per_run", num(e.target.value))} />
              </Field>
              <Field label="Max traces / run" htmlFor="max_traces" error={err("curator.max_traces_per_run")} hint="0–5000">
                <Input id="max_traces" type="number" min={0} max={5000} value={Number.isNaN(s.curator.max_traces_per_run) ? "" : s.curator.max_traces_per_run} aria-invalid={invalid("curator.max_traces_per_run")} onChange={(e) => setCurator("max_traces_per_run", num(e.target.value))} />
              </Field>
            </div>
          </div>
          <p className="text-xs text-subtle">
            Model ids only. Endpoints and API keys (<code className="font-mono">KF_LLM_BASE_URL</code>, <code className="font-mono">KF_LLM_API_KEY</code>,{" "}
            <code className="font-mono">AI_GATEWAY_API_KEY</code>, ...) are configured as Edge Function secrets, not here; a model id must be one those
            secrets can serve.
          </p>
          <Field
            label="House rules for the curator"
            htmlFor="instructions"
            optional
            error={err("curator.instructions")}
            hint="Appended to the curator's instructions: naming conventions, tone, what never to write down."
          >
            <Textarea
              id="instructions"
              rows={5}
              value={s.curator.instructions}
              onChange={(e) => setCurator("instructions", e.target.value)}
              placeholder={"Name metrics with their unit (revenue_usd, not revenue).\nNever copy customer names into domain knowledge."}
            />
          </Field>
        </Section>

        <Section
          title="Auto-apply policy"
          description="By default every proposal waits for a reviewer. Auto-apply lets low-risk, evidence-backed fixes go live without one; they still show up in the inbox history."
        >
          <Checkbox
            label="Auto-apply proposals that match this policy"
            description="Applied as “process:policy”; the concept stays unverified until a person verifies it."
            checked={s.auto_apply.enabled}
            onChange={(e) => setAuto("enabled", e.target.checked)}
          />
          <div className={s.auto_apply.enabled ? "flex flex-col gap-5" : "pointer-events-none flex flex-col gap-5 opacity-50"} aria-disabled={!s.auto_apply.enabled}>
            <Field label="Highest risk to auto-apply" htmlFor="max_risk" error={err("auto_apply.max_risk")}>
              <Select id="max_risk" value={s.auto_apply.max_risk} onChange={(e) => setAuto("max_risk", e.target.value as "low" | "medium")} disabled={!s.auto_apply.enabled}>
                <option value="low">Low risk only</option>
                <option value="medium">Low and medium risk</option>
              </Select>
            </Field>
            <fieldset>
              <legend className="mb-2 text-sm font-medium">Kinds of knowledge</legend>
              <div className="flex flex-col gap-2">
                {KINDS.map((k) => (
                  <Checkbox
                    key={k.value}
                    label={k.label}
                    description={k.hint}
                    disabled={!s.auto_apply.enabled}
                    checked={s.auto_apply.kinds.includes(k.value)}
                    onChange={(e) =>
                      setAuto("kinds", e.target.checked ? [...s.auto_apply.kinds, k.value] : s.auto_apply.kinds.filter((x) => x !== k.value))
                    }
                  />
                ))}
              </div>
              {err("auto_apply.kinds") ? <p className="mt-1 text-xs text-danger">{err("auto_apply.kinds")}</p> : null}
            </fieldset>
            <Checkbox
              label="Require evidence from real work"
              description="Only when a citation is an agent trace or a flag, not just a document."
              disabled={!s.auto_apply.enabled}
              checked={s.auto_apply.require_observed_evidence}
              onChange={(e) => setAuto("require_observed_evidence", e.target.checked)}
            />
            <Checkbox
              label="Allow creating new concepts"
              description="Off: only updates to existing concepts are auto-applied."
              disabled={!s.auto_apply.enabled}
              checked={s.auto_apply.allow_create}
              onChange={(e) => setAuto("allow_create", e.target.checked)}
            />
          </div>
          <Callout tone="neutral" icon={<ShieldAlert />}>
            Never auto-applied, whatever this policy says: proposals that widen access to restricted knowledge (they always need a space admin), and moves.
          </Callout>
        </Section>

        <Section title="Staleness" description="Stale knowledge is re-checked against its sources by a nightly sweep and marked in search results.">
          <Field
            label="Data access knowledge expires after (days)"
            htmlFor="data_access_days"
            error={err("staleness.data_access_days")}
            hint="Applies to data-access concepts without their own stale_after. 0 = never."
            className="max-w-xs"
          >
            <Input
              id="data_access_days"
              type="number"
              min={0}
              value={Number.isNaN(s.staleness.data_access_days) ? "" : s.staleness.data_access_days}
              aria-invalid={invalid("staleness.data_access_days")}
              onChange={(e) => setS((x) => ({ ...x, staleness: { ...x.staleness, data_access_days: num(e.target.value) } }))}
            />
          </Field>
          <p className="text-xs text-subtle">
            Embeddings: <code className="font-mono">{s.embeddings.provider}</code> (384 dimensions, runs inside Supabase Edge Functions).
          </p>
        </Section>
      </fieldset>
      {canEdit ? (
        <div className="sticky bottom-4 flex justify-end gap-2">
          {dirty ? (
            <Button
              onClick={() => {
                setS(initial);
                setFallbackText(initial.curator.fallback_models.join("\n"));
                setErrors({});
              }}
            >
              Discard
            </Button>
          ) : null}
          <Button type="submit" variant="primary" pending={pending} disabled={!dirty}>
            Save settings
          </Button>
        </div>
      ) : null}
    </form>
  );
}
