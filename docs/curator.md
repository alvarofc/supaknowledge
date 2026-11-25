# The curator

The curator is the agent that keeps knowledge current. Working agents only **flag**; the curator reads the flags,
agent traces and changed source documents, and writes **proposals**: minimal, cited changesets that a space
policy may apply on its own or that people review in Studio or with `kf`.

| Where | What |
|---|---|
| `packages/core/src/curator/engine.ts` | The state machine: `runTask()`, `gather`, `triage`, `sweep`, `draft`, `buildProposal()` |
| `packages/core/src/curator/corrections.ts` | Correction mining from traces (heuristic score + extraction) |
| `packages/core/src/curator/prompts.ts` | Every system prompt |
| `packages/core/src/curator/schemas.ts` | The structured-output schemas (zod) for each model call |
| `packages/core/src/curator/store.ts`, `supabase-store.ts` | The storage interface and its Supabase implementation (service role) |
| `packages/core/src/llm.ts`, `settings.ts` | `MastraLLM` (Mastra model router: your endpoint, Vercel AI Gateway, OpenRouter...), `llmConfigFromEnv()`, `ScriptedLLM`; space settings and the auto-apply policy |
| `supabase/functions/curator/index.ts` | The Edge Function: runs one queued task per message, plus `POST /curator/run` |

The engine has no Supabase or Deno dependency of its own: it runs in the Edge Function, in Node, and in tests and
the offline demo with an in-memory store (`examples/revenue-report/src/offline.ts`). After changing anything in
`packages/core`, run `npm run sync:shared` so the functions get the same code.

## Runs and triggers

A **run** (`curator_runs`) covers the evidence since the previous successful run (staleness runs do not count:
they never read documents, so they do not move that watermark); the database allows at most one queued or
running run per space. Runs start from:

| Trigger | How |
|---|---|
| `manual` | Studio (Activity → Run now), `kf curate [--watch]` (through `POST /curator/run`, so the cooldown applies), `POST /functions/v1/curator/run {"space": "<ws>/<space>"}` or `select request_curator_run('<space-id>')`. Needs the reviewer role (not through an OAuth client token) |
| `flag_threshold` | A trigger on `flags`: `curator.flag_threshold` open flags on one concept, or that many `missing` flags in the space (default 3; 0 disables) |
| `cron` | 02:00 UTC, for every space with open flags, uncurated traces or documents changed since the last run |
| `staleness` | 03:00 UTC, for every space with stable concepts past `stale_after` |

A run is split into **tasks** (`curator_tasks`), one per `kf_curator` queue message, so each fits in one Edge
Function invocation (the worker gives each task a 110 s budget). The `kf-curator` cron job hands messages to the
function every 15 seconds. A failing task is retried up to 3 times; then the task is marked failed with the error.
When the last task of a run finishes, the run is closed with its `stats`: `succeeded` only if every task
succeeded, `failed` if any task failed (so a failed run's evidence is picked up again by the next run).

A trace is curated again when it changes after a run: new events or a new outcome reset its `curated_at`.

**Stuck and cancelled runs.** A reaper fails runs and tasks that have been running for more than 30 minutes
(per space: `curator.stuck_after_minutes`), so a crashed task cannot keep a space from starting new runs. A
reviewer can also cancel a queued or running run: **Cancel** on the run in Studio's Activity page,
`kf runs cancel <run-id>`, or `select cancel_curator_run('<run-id>')`.

## Pipeline

```
gather ──► mine traces (fast model) ──► triage ──► draft × N ──► proposal ──► policy: auto-apply or review
sweep  ──────────────────────────────────────────► draft × N (stale concepts)
```

**1. Gather: mine traces.** Up to 50 uncurated traces per task (a run continues in new tasks until all, capped by
`max_traces_per_run`, are scanned). A cheap heuristic scores each trace: outcome `corrected` (+3) or `failure`
(+2), a `feedback` event (+3), a user message after an assistant turn with correction cues such as "actually",
"from now on", "should use", "renamed" (+2), a tool that failed and then succeeded (+2). Traces scoring 2 or more go
to the fast model, which extracts **durable lessons** (one-off preferences are dropped). Each lesson becomes a
**synthetic flag** linked to the trace, carrying the trace's audience. Traces are then marked curated.

**2. Triage.** Open flags attached to a concept are grouped per concept (`incorrect` / `outdated` raise the
priority). Changed documents cited by a concept (through its OKF `sources`) go to that concept. The remaining
"loose" signals (flags without a concept, other changed documents) go to the model, together with candidate
concepts found by search, which groups them into clusters, points each at concepts and writes a topic and a
research query; signals it marks as noise are dismissed with a reason. The model works in **one pass per
audience**: unrestricted signals together, each distinct restricted audience on its own, and each pass only sees
candidate concepts that every reader of its audience may read (see [Access](#access)). Candidate searches are
keyword searches, except for the first few of a task (embedding many queries in one Edge Function invocation
would exceed its CPU limit). Clusters that touch the same concept are merged. Up to `max_clusters_per_run`
clusters per run are queued as `draft` tasks, highest priority first, before any flag is dismissed (a retried
triage sees the same open flags). Changed documents are read 100 at a time: later pages, and audience passes that
do not fit one task (at most 6 passes per task), continue in further `triage` tasks of the same run, so no changed
document is skipped by the run's watermark.

**3. Sweep** (staleness runs). Every stable concept past `stale_after` becomes a `draft` task asking the model to
re-validate it: either move `stale_after` forward (low risk) or fix it.

**4. Draft**, one cluster per task:

- *Evidence.* Load the cluster's flags, up to 5 traces they link to, its documents, the target concepts (full
  text), related concepts (search) and source excerpts (search over `source_chunks`), plus recent **rejected**
  proposals on the same concepts with their review notes, so a rejection teaches the next run. Searches are
  limited to the research scope in SQL (`p_visible_to`), before the result limit. Source excerpts are only
  pre-fetched when they match the cluster's research query by keyword or with a cosine similarity of at least
  0.8, and never from untrusted source kinds (`auto_apply.untrusted_source_kinds`, `web` by default): the model
  can still find those with `search_sources`, which then makes the changeset ineligible for auto-apply.
- *Research and draft.* The drafting model runs as a Mastra agent that starts from that evidence and may pull more
  with research tools before it answers: `search_knowledge`, `read_concept`, `search_sources`, `read_document` and
  `read_trace` (up to `curator.max_research_steps` agent steps). Whatever a tool returns joins the evidence, so a
  citation to something found during research resolves (and carries its audience) like pre-fetched evidence. It
  returns a structured changeset: `propose` or `no_change`, ops (`create`, `update`, `deprecate`, `move`) with
  complete new bodies, citations, flags it resolves and flags to dismiss.
- *Check.* `buildProposal()` resolves every citation to real evidence (unknown references are dropped and
  reported), normalises ops (an update of a missing path becomes a create only if it has full content), lints
  the result against OKF and Agent Skills rules, sets a default `stale_after` on data-access concepts, merges the
  citations into the concept's OKF `sources`, and gives new concepts the narrowest audience that does not leak
  any cited material.
- *Repair round.* If the check found problems (unknown citations, lint errors, an update without content...), the
  model gets its own changeset back with the list of problems and one chance to fix them (a few more research
  steps allowed). The repaired version is kept only if it has fewer problems; runs count these in `stats.repaired`.
  Whatever problems remain are attached to the proposal and raise its risk.
- *Self-review.* A second call reviews the changeset against the evidence and the related concepts for
  contradictions, unsupported claims, lost information, format problems and scope creep. Findings are appended
  to the proposal's rationale; blockers raise the risk to `high`.
- *Propose.* The proposal is stored (the database then computes escalation, see below) and its flags move to
  `in_proposal`.
- *Policy.* If the space policy allows it, and there are no blockers or unresolved check problems, the curator
  applies the proposal itself through `apply_proposal()`. Otherwise it waits in the inbox.

Applying a proposal resolves its flags. Rejecting one (`kf reject <id> --note …`) puts its flags back to `open`,
and the note becomes context for the next draft.

## Provenance

Every new or changed claim gets a footnote (`[^label]`) in the body, and every label is a citation:

- a `proposal_citations` row with the evidence kind (`flag`, `trace`, `source_document`, `concept`, `url`), its
  id, a supporting quote and the evidence's audience, which reviewers see on the proposal page. A `url` citation
  that matches a source document of the space is stored as that document, with its audience;
- an entry in the concept's OKF frontmatter `sources`, so the provenance travels with exports:

```yaml
sources:
  - id: renamed-column
    resource: supaknowledge://flags/3405e3c1-…        # or supaknowledge://documents/<id>, supaknowledge://traces/<id>, a URL
  - id: slack-finance-2026-11-20
    resource: https://acme.slack.com/archives/C0FIN/p1732…
    title: "#finance, 2026-11-20"
    last_modified: "2026-11-20T16:02:11Z"
```

The citations are also how changed sources find their concepts: when a document cited by a concept changes, the
next run drafts against that concept.

## Access

The curator runs with the service role, because it has to see evidence from every audience. It keeps access
intact in four ways: each piece of evidence carries its audience into the proposal's citations; restricted
evidence the model **consulted** while drafting (shown to it, or read through its research tools) but did not
cite is recorded too, as citations with `consulted = true`, so it counts for visibility and escalation exactly
like cited evidence (Studio lists it separately on the proposal page); new concepts get the narrowest safe
audience; and the database marks any proposal that would move restricted material into a wider audience as an
**escalation** (risk `high`), which only a space admin can approve and which is never auto-applied, whatever the
policy says. The proposal, its ops and its citations are written in one transaction by `create_proposal()`, so
nothing is visible before the escalation check has run. The prompts also tell the model to summarise only what agents need from
restricted evidence. See [access control](access-control.md#the-escalation-guard).

### The invariant: everything a model saw is evidence

Model output can repeat anything that was in the model's context. So every input of every curator prompt either
travels with the proposal as cited or consulted evidence with its audience (the database escalation guard then
sees it), or is never shown:

| Prompt input | How it is handled |
|---|---|
| Trace being mined (`gather`) | One trace per call; the lessons become flags with the trace's audience |
| Triage signals and candidate concepts | One pass per audience; candidates limited to what every reader of that audience may read. The model's topic, research query and concept paths therefore carry exactly that audience: the cluster records it (`audiences` in the draft task input) and the draft adds it as consulted evidence. The cluster's own flags and documents are consulted rows too. |
| Triage dismissal reasons | Written only by a pass whose whole context is readable by the flag's audience, so the reason is shown as written |
| Topic in the drafting prompt | Fenced as untrusted data (it is model-written from untrusted signals) |
| Cluster flags, linked traces, documents, target concepts | Consulted rows (live audience) |
| Pre-fetched related concepts and source excerpts | Research scope only (filtered in SQL and again in the engine); consulted rows |
| Research tool results | Research scope only; everything returned joins the evidence and is consulted |
| Rejected proposals' titles and review notes | `kf_rejected_proposals()` returns the audiences of everything each one touched (citations, consulted evidence, target concepts; live and as recorded). A rejection is shown only when all of them are in the research scope; its restricted audiences are added as consulted evidence. Fenced as untrusted data. |
| Repair round and self-review | The same evidence plus the model's own changeset: nothing new |
| `curator.instructions` | Written by space admins; clipped to 8000 characters |

Evidence that is not a row (a triage pass, a rejected proposal's note) is stored as a consulted citation without
a `ref_id` (`ref_kind = url`, no URL, a note saying what it stands for); the database keeps the audience the
curator states for it (service role only; the groups must belong to the workspace) and counts it like any other
evidence. Rows are preferred where they exist, because the database follows their live audience.

**Flag dismissals** are written to `flags.resolution`, which the flag's readers see outside any proposal. The
drafting model's reason is used only when everything in its context (including research results and taint) is
readable by the flag's audience; otherwise the resolution is the fixed
`curator: dismissed (reason withheld: restricted_context)`.

## Settings and policy

Per space, in `spaces.settings` (validated by `SpaceSettingsSchema` in `packages/core/src/settings.ts`). Edit them in
Studio under **Settings → Curator & policy**, or as a space admin with SQL / PostgREST:

```sql
update public.spaces set settings = '{
  "curator":   { "instructions": "Write table names fully qualified. Finance owns metric definitions." },
  "auto_apply": { "enabled": true, "kinds": ["data_access"], "max_risk": "low" }
}' where id = '<space-id>';
```

| Key | Default | Meaning |
|---|---|---|
| `curator.enabled` | `true` | Scheduled and threshold runs for this space |
| `curator.flag_threshold` | `3` | Open flags on one concept (or `missing` flags in the space) that start a run (0–1000000); `0` disables |
| `curator.flag_cooldown_minutes` | `60` | Minimum minutes between flag-threshold runs of one space (0–10080), so a misbehaving agent cannot trigger runs continuously |
| `curator.model` | `""` (= `KF_LLM_MODEL`) | Model id for triage, drafting and self-review, e.g. `vercel/openai/gpt-6.2-sol` or `acme/your-model` (at most 200 characters) |
| `curator.fast_model` | `""` (= `KF_LLM_FAST_MODEL`, else the model) | Cheaper model for correction mining in traces |
| `curator.fallback_models` | `[]` (= `KF_LLM_FALLBACK_MODELS`) | Tried in order when the model errors (at most 5) |
| `curator.max_research_steps` | `8` | Agent steps (model calls that may use research tools) per draft (1–20) |
| `curator.max_clusters_per_run` | `25` | Drafts per run (1–200); the rest wait for the next run |
| `curator.max_traces_per_run` | `200` | Traces scanned per run (0–5000) |
| `curator.max_tokens_per_run` | `3000000` | Model tokens (input + output) one run may spend across its tasks (0–2000000000); when spent, the remaining tasks fail with a clear error. `0` = unlimited. The operator ceiling `KF_LLM_MAX_TOKENS_PER_RUN` (env) caps it: a space can go lower, never higher. Tokens of failed calls (e.g. a research phase whose answer failed) count too |
| `curator.research_scope` | `target_audience` | What the drafting model may research: `target_audience` shows only results readable by everyone who can read the concepts being changed; `all` searches everything (restricted items it reads still escalate) |
| `curator.auto_dismiss_flags` | `true` | Let the curator dismiss flags it judges mistaken or noise; `false` leaves them open for a person |
| `curator.instructions` | `""` | House rules appended to every curator system prompt (at most 8000 characters) |
| `curator.stuck_after_minutes` | `30` | A run or task without progress for this long is failed by the reaper (10–1440; the queue's visibility timeout is 400 s) |
| `auto_apply.enabled` | `false` | Let the curator apply proposals that match the rules below |
| `auto_apply.max_risk` | `low` | `low` or `medium` |
| `auto_apply.kinds` | `["data_access"]` | Kinds of knowledge that may change without review |
| `auto_apply.require_observed_evidence` | `true` | Only when a citation is a trace or a flag, i.e. the problem was seen in real work |
| `auto_apply.allow_create` | `false` | Allow new concepts |
| `auto_apply.untrusted_source_kinds` | `["web"]` | Connector kinds (`notion`, `slack`, `github`, `gdrive`, `web`, `upload`) whose content outsiders can write; a proposal that read or cited them is never auto-applied |
| `staleness.data_access_days` | `90` | `stale_after` given to data-access concepts that have none (0–36500; 0 disables) |
| `embeddings.provider` | `gte-small` | Only option today |
| `retention.trace_days` | `null` (keep) | Delete traces older than this many days (1–36500), daily by cron `kf-cleanup` |
| `retention.usage_days` | `null` (keep) | Delete concept usage rows older than this many days (1–36500) |

The schema is `SpaceSettingsSchema` in `packages/core/src/settings.ts`. Studio's **Settings → Curator & policy**
has a field for every key above. The database validates the same keys, types and bounds whenever
`spaces.settings` is written (`private.validate_space_settings()`, SQLSTATE `22023` with the key and the expected
value); unknown keys are kept for forward compatibility. A test (`packages/core/test/settings-db.test.ts`) keeps
the schema and the database validator in sync. When reading, an invalid value (for example in a row written
before validation existed) falls back to that field's default with a warning, and every valid field is kept, so
one typo never resets a space's whole policy.

The policy (`decideAutoApply()`) refuses, in this order: auto-apply disabled; an escalation; risk above
`max_risk`; creates (unless allowed); moves; a concept kind outside `kinds`; evidence read from an untrusted
source kind; a citation of an external URL; no observed evidence (when required).
The reason is recorded in the task output.

Risk comes from the model (low: a factual fix with direct evidence in one concept, such as a renamed column;
medium: new concepts, policy or procedure wording, several concepts; high: money, compliance, deletions or weak
evidence), raised by self-review findings and check problems, and forced to `high` by an escalation.

## Prompts

All prompts are in `packages/core/src/curator/prompts.ts`: a shared description of the knowledge model
(`KNOWLEDGE_MODEL`), then `CORRECTIONS_SYSTEM` (lesson extraction), `CLUSTER_SYSTEM` (triage), `DRAFT_SYSTEM`
(drafting rules: evidence only, prefer updates, keep what is correct, footnote every claim, data-access and skill
conventions, risk levels) and `REVIEW_SYSTEM` (the second reviewer). `curator.instructions` is appended to them as
"house rules". Change the prompts in `packages/core`, run `npm run sync:shared`, and check the scripted story in
`packages/core/test/curator.test.ts` and `examples/revenue-report` still passes.

`packages/core/test/curator-safety.test.ts` replays the access scenarios from the security reviews (triage and
rejection leaks, dismissal reasons, research scope) with a scripted model. `packages/core/test/curator-eval.test.ts`
runs the main leak scenario against a real model; it is skipped unless you opt in:

```bash
cd packages/core && set -a && . ../../supabase/.env && set +a && KF_EVAL_LLM=1 node --test test/curator-eval.test.ts
```

Each call asks Mastra for structured output with a zod schema from `schemas.ts`, so the engine never parses free
text. Models without native structured output still work: `jsonPromptInjection: "auto"` falls back to putting the
JSON schema in the prompt, and Mastra validates the answer against the schema either way.

## Model configuration

The curator reaches models through [Mastra](https://mastra.ai)'s model router (`MastraLLM` in
`packages/core/src/llm.ts`). There is no default provider: you choose one with environment variables, which are
Edge Function secrets (`supabase/.env` locally, `supabase secrets set` when deployed, see [deploy](deploy.md)).
Endpoints and API keys only ever come from these secrets; space settings can only pick model ids.

| Variable | Meaning |
|---|---|
| `KF_LLM_MODEL` | Model id, `provider/model`. Required |
| `KF_LLM_FAST_MODEL` | Cheaper model for bulk trace mining (default: `KF_LLM_MODEL`) |
| `KF_LLM_FALLBACK_MODELS` | Comma-separated ids tried in order when a model errors |
| `KF_LLM_BASE_URL` | Your OpenAI-compatible endpoint. When set, every model id is served by it |
| `KF_LLM_API_KEY` | Bearer key for `KF_LLM_BASE_URL` |
| `KF_LLM_HEADERS` | Extra headers for your endpoint, as a JSON object, e.g. `{"x-team":"knowledge"}` |
| `KF_LLM_API` | Wire format of your endpoint: `chat` (chat completions, default) or `responses` |
| `KF_LLM_EXTRA_BODY` | JSON merged into every request body to your endpoint, for server-specific switches (single-quote it in `.env`) |
| `KF_LLM_ALLOWED_MODELS` | Comma-separated model ids that space settings may choose (`curator.model`, `fast_model`, `fallback_models`); a trailing `*` matches a prefix, e.g. `acme/*`. Empty or unset = any id. A space that picks another model fails its tasks with a clear error. The environment's own `KF_LLM_*` ids are not checked |
| `KF_LLM_MAX_TOKENS_PER_RUN` | Operator ceiling on model tokens per curator run; `curator.max_tokens_per_run` can only go lower. Unset/`0` = the space setting alone |
| `KF_CURATOR_RUN_COOLDOWN_S` | Minimum seconds between two manual runs of one space through `POST /curator/run` (default `120`; asking while a run is active returns that run). Each caller may also send at most 10 run requests a minute per worker (HTTP 429 with `Retry-After`) |
| `KF_CURATOR_TASK_BUDGET_MS` | Wall-clock budget per curator task in ms (default `110000`, clamped to 30000–380000). The engine stops model calls when it runs out and keeps a reserve to record the result. Raise it (e.g. `300000`) on plans whose functions may run 400 s |
| `AI_GATEWAY_API_KEY` | Vercel AI Gateway key, for `vercel/...` model ids |
| `OPENROUTER_API_KEY` | OpenRouter key, for `openrouter/...` model ids |

**Your own OpenAI-compatible endpoint** (vLLM, LiteLLM, Ollama, an internal gateway, Azure OpenAI...). The part of
the id after the first `/` is sent as the `model` name; the prefix is only a label:

```bash
KF_LLM_MODEL=acme/llama-4-maverick          # sends "model": "llama-4-maverick"
KF_LLM_BASE_URL=https://llm.acme.internal/v1
KF_LLM_API_KEY=...
KF_LLM_HEADERS={"x-team":"knowledge"}       # optional
```

**Self-hosted Qwen on vLLM** (tested end to end with `qwen3.8-flash`). Qwen 3 models think by default; on vLLM
you turn that off per request with `chat_template_kwargs`, which saves most of the output tokens and keeps the
JSON answers clean:

```bash
KF_LLM_MODEL=acme/qwen3.8-flash
KF_LLM_BASE_URL=https://your-vllm-host/v1
KF_LLM_API_KEY=...
KF_LLM_EXTRA_BODY='{"chat_template_kwargs":{"enable_thinking":false}}'
```

With that endpoint the whole loop ran inside the local Edge Runtime: trace mining, triage, research with tools,
drafting, self-review and proposals. A drafting task took about 30-60 s.

**Vercel AI Gateway.** One key, many providers; ids are `vercel/<provider>/<model>`:

```bash
KF_LLM_MODEL=vercel/openai/gpt-6.2-sol
KF_LLM_FALLBACK_MODELS=vercel/openai/gpt-6.1-sol    # optional
AI_GATEWAY_API_KEY=...
```

**OpenRouter** works the same way with `openrouter/<vendor>/<model>` ids and `OPENROUTER_API_KEY`. Other providers
Mastra's router knows (see [mastra.ai/models](https://mastra.ai/models)) work with their own key variable, as
long as the Edge Function can read it; add it to `edge_runtime.secrets` in `supabase/config.jsonc` first.

**Fallbacks.** `KF_LLM_FALLBACK_MODELS=vercel/openai/gpt-6.1-sol,openrouter/vendor/backup-model` makes Mastra
try each model in order (each with one retry) when the previous one errors: an outage, a rate limit, a rejected
request. With `KF_LLM_BASE_URL` set, fallbacks are served by the same endpoint.

**Research, then answer.** When a call has tools (the drafting step), `MastraLLM` runs it in two phases: a
research phase where the model may call the tools and writes notes that cite evidence ids, then an answer phase
with no tools that returns the structured changeset. Many models, vLLM-served Qwen among them, cannot call tools
and produce schema-constrained JSON in the same request; splitting the two works with any model, at the cost of
one extra call per draft. Tool results from the research phase are passed to the answer phase verbatim.

**Fast model.** Correction mining sends one call per likely-corrected trace, so it is the bulk of the calls on
busy spaces; a smaller model is usually enough there. Triage, drafting, the repair round and the self-review use
the main model.

**Per-space override.** Space admins can set `curator.model`, `curator.fast_model` and `curator.fallback_models`
(Studio: Settings → Curator & policy). They replace the environment's ids for that space only, and must be ids
the configured endpoint or gateway can serve. Leave them blank to use the server default.
Operators can restrict those overrides with `KF_LLM_ALLOWED_MODELS` (see the table above).

Without `KF_LLM_MODEL`, a task fails at once with `no model configured: set KF_LLM_MODEL ...` and the run is marked
failed (no retries: retrying cannot help).

### Checking a configuration

- *Unit level.* `packages/core/test/llm.test.ts` runs `MastraLLM` against a local mock OpenAI-compatible server:
  custom endpoint with key and headers, fallback to the next model on a 500, research tools before a structured
  answer. Use it as a template to check a new endpoint's quirks.
- *In the Edge Runtime.* Point the stack at any OpenAI-compatible server on your machine (a mock, Ollama,
  LiteLLM): set `KF_LLM_BASE_URL=http://host.docker.internal:<port>/v1` in `supabase/.env` (the functions run in
  Docker, so `127.0.0.1` would be the container), restart the stack, then `npx kf curate --watch`. Your server
  sees the requests (model name, `Authorization: Bearer $KF_LLM_API_KEY`, your headers); the run's tasks show any
  error in Studio (Activity) and in `docker logs supabase_edge_runtime_supaknowledge`.

## Cost and model choice

Model calls per run:

- one call to the fast model per trace that scores as a likely correction;
- one triage call, only when there are signals not attached to a concept;
- per cluster: the draft (one model call per research step, up to `max_research_steps`), the repair round when the
  check found problems, and the self-review.

So cost grows with the number of clusters (capped by `max_clusters_per_run`) and of corrected traces (capped by
`max_traces_per_run`), not with the size of the knowledge base. Scheduled runs only start when there is something
new. Inputs put the stable context (system prompt, the concepts under review) first, so providers that cache
prompt prefixes can reuse it between the draft, the repair round and the self-review.

Every run records what it spent in `curator_runs.stats` (shown in Studio under Activity and Health, and by
`kf runs`): `model_calls`, `input_tokens`, `output_tokens` and `cached_input_tokens` (as reported by the provider),
next to `proposals`, `auto_applied`, `repaired` and the other counters. Multiply by your provider's prices to get the
run's cost.

To spend less: use a cheaper `fast_model`, lower `max_research_steps` (data-access fixes rarely need more than 3 or
4), use a smaller `curator.model` for spaces with simple knowledge (keep the self-review: it is the cheap safety
net), lower the caps, or raise `flag_threshold` so fewer flags trigger runs between nightly runs. Measure on your
own flags before changing defaults: a weaker draft costs a reviewer's time.

The engine only depends on a small interface (`LLM` in `packages/core/src/llm.ts`: `generate()` with a zod schema,
optional tools, and token usage back), so tests and the offline demo use `ScriptedLLM`, and another runtime could
be plugged in the same way.

## Running it locally

`npx supabase start` serves the curator function and the cron jobs drive it. It needs a model (see
[model configuration](#model-configuration)):

```bash
# in supabase/.env: your endpoint ...
KF_LLM_MODEL=acme/your-model
KF_LLM_BASE_URL=https://llm.acme.internal/v1
KF_LLM_API_KEY=...
# ... or the Vercel AI Gateway
KF_LLM_MODEL=vercel/openai/gpt-6.2-sol
AI_GATEWAY_API_KEY=...
```

```bash
npx supabase stop && npx supabase start                   # the Edge Runtime reads secrets at start
npx kf curate --watch
```

Without a model, tasks fail at once with `no model configured: set KF_LLM_MODEL ...` and the run is marked failed.
Follow runs with `kf runs` or in Studio (Activity; admins also see each task's status), and the function logs with
`docker logs -f supabase_edge_runtime_supaknowledge`.

To try the pipeline without a stack or a model, `npm run demo:offline` runs the revenue-report story through
`runTask()` with an in-memory store and a scripted model, and prints each task and the resulting diffs.
