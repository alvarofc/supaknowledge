# Evals

Does knowledge X reduce failure Y? The eval harness in [`examples/evals`](../examples/evals) answers that for a
fixed task set: it runs the same agent on every task, runs the curator on what happened, runs the same agent on the
same tasks again, and reports per task whether the answer passed its check, how many tool calls failed, and how
many flags the run produced.

```bash
npm run eval:offline        # deterministic: in-memory store, scripted agent, scripted curator model (runs in CI)
npm run eval                # live: against the local stack, with your model
```

Both print a table and write a JSON file (`examples/evals/results/<mode>.json`, or `--out <file>`).

## The task set

The tasks start from the [revenue-report example](../examples/revenue-report): its knowledge bundle, its BigQuery
warehouse (where `revenue_usd` was renamed to `revenue_usd_net`) and its finance lead. The eval adds one concept,
`data/supabase/subscriptions`, which documents a table in Acme's app database on Supabase Postgres with an old
schema: the table moved from `public` to `billing` and the `active` status label became `live`. The agent reaches
that database through tools named like the [Supabase MCP server's](mcp.md#use-with-the-supabase-mcp-server)
`execute_sql` and `list_tables`, which answer with Postgres errors.

| Task | Asks | Passes when | What is wrong in the knowledge |
|---|---|---|---|
| `revenue-by-region` | November revenue by region | every region's total is in the answer | the table guide names the old column |
| `revenue-report` | the monthly report, in the house format | the first line is `ACME CONFIDENTIAL` and the total is right | the skill does not know the finance lead's new header rule |
| `active-subscriptions` | active subscriptions per plan and in total | the total is right | the table guide names the old schema and status label |
| `arr-definition` | how Acme defines ARR | the answer has the definition and excludes services | nothing (control task) |
| `arr-board-pack` | why the board pack's ARR differs | the answer mentions committed ARR | the explanation is in a finance-only concept the agent cannot read |

When an answer fails and the task has a correction (the finance lead's header rule, the data owner's note about
the billing schema), the harness records it as human feedback on the trace, like the person who asked would.
Success is measured on the agent's answer before any correction.

The data sources are simulated (`examples/evals/src/worlds.ts`) so that results only depend on the agent, the
knowledge and the curator. Their output shapes are this simulation's, not copies of BigQuery's or the Supabase MCP
server's.

## What each phase does

1. **Before.** The agent answers every task with the knowledge as imported. Each run is one trace.
2. **Curator run.** The curator mines the traces (including [SQL-error flags](curator.md#pipeline) from failed
   `execute_sql` calls), triages, drafts and applies what the space policy allows. The policy is the
   revenue-report one: low-risk `data_access` fixes backed by observed evidence apply themselves.
3. **Review.** A simulated reviewer approves every pending proposal that is not an escalation. Escalations wait
   for a space admin, as they would in Studio. `--no-review` skips this step, which shows what the policy alone
   changes.
4. **After.** The same agent answers the same tasks again.

## Metrics

| Column | Meaning |
|---|---|
| `passed` | the answer passed the task's check |
| `tool errors` | failed tool calls (warehouse, `execute_sql`, knowledge tools) |
| `flags` | flags the agent raised with `flag_knowledge`, plus the SQL-error flags the curator mines from the trace's failed SQL calls without a model, shown as `(n SQL)` |

Lessons the curator's model mines from human corrections are not counted per task: they need a model call and
only exist after a curator run. The run's totals are in the JSON (`curator.stats.lessons`).

## Offline mode

An in-memory store, a scripted agent and a scripted curator model. Everything else is the production code path:
correction mining, the SQL-error flags, triage, the drafting checks, citations, the auto-apply policy and the
escalation guard come from the curator engine in `@supaknowledge/core`, and every trace goes through the same
sanitising as the `traces` function.

The scripted agent does what the knowledge says, literally: it runs the documented example queries, follows the
skill's steps, and recovers from an error only when the error says how (BigQuery's "Did you mean", a table with
the same name found by `list_tables`). The scripted curator model answers each curator step with text written for
these tasks. So the offline numbers come from the scripts: they show that the harness and the loop work end to
end, and CI checks that they stay that way (`examples/evals/test/offline.test.ts`). They are not a measurement of
any model, and the output says so.

The output of `npm run eval:offline` on this commit:

```
Supaknowledge evals, offline: scripted agent, scripted curator model, simulated data sources
Offline mode: a scripted agent and a scripted curator model on simulated data sources. These numbers come from the scripts and show that the harness and the curator loop work end to end; they are not a measurement of any model.

                      before                             after
task                  passed  tool errors  flags         passed  tool errors  flags
revenue-by-region     yes     1            1             yes     0            0
revenue-report        no      1            1             yes     0            0
active-subscriptions  no      2            2 (2 SQL)     yes     0            0
arr-definition        yes     0            0             yes     0            0
arr-board-pack        no      0            1             no      0            1
total                 2/5     4            5             4/5     0            1

curator run succeeded: 3 proposal(s), 2 auto-applied by policy, 1 approved in review, 0 pending, 0 escalations pending; 1 draft(s) proposed no change
simulated reviewer approved 1 pending proposal(s); escalations wait for a space admin
results: examples/evals/results/offline.json
```

`arr-board-pack` still fails afterwards by design: the explanation is finance-only, and the curator does not copy
restricted material into a concept everyone reads.

## Live mode

```bash
npx supabase start                       # the stack, with KF_LLM_MODEL in supabase/.env for the curator
export KF_LLM_MODEL=... KF_LLM_BASE_URL=... KF_LLM_API_KEY=...   # the working agent's model (optional)
npm run eval
npm run eval -- --reset                  # delete what live evals created
```

Live mode creates a fresh workspace (`kf-eval-<id>`) with one owner, the `finance` group and the revenue-report
policy, imports the bundle through the `bundle` function, registers a headless agent, and then runs the four
phases against the real Edge Functions: traces go through the `traces` function, the curator runs in the `curator`
function with the model in `supabase/.env`, and the owner approves pending non-escalated proposals through
`apply_proposal()`.

The working agent is a [Mastra](https://mastra.ai) agent with `@supaknowledge/mastra` when `KF_LLM_MODEL` is set in
your shell (same variables as the curator, see [model configuration](curator.md#model-configuration)), and the
scripted agent over the real SDK and MCP server otherwise (`--agent scripted` forces it, `--agent model` requires
a model). The JSON records which one ran.

A live run is one sample: models are not deterministic, so repeat it before drawing conclusions. It writes to the
stack (users, a workspace, traces, proposals) until you run `--reset`. Search results for changed concepts use
full-text search until the embed worker has re-embedded them (the `kf-embed` cron job runs every 10 seconds).

## Options

| Option | |
|---|---|
| `--offline` | offline mode (`npm run eval:offline` passes it) |
| `--out <file>` | where to write the JSON (default `examples/evals/results/<mode>.json`, git-ignored) |
| `--no-review` | leave pending proposals pending before the second phase |
| `--agent scripted\|model` | live mode: force the scripted agent, or require a model |
| `--reset` | live mode: delete the workspaces and users earlier live evals created |

## The JSON file

```jsonc
{
  "mode": "offline",                 // or "live"
  "agent": "scripted",               // or the model id
  "curator_model": "scripted",       // live: the Edge Functions' KF_LLM_MODEL
  "note": "...",                     // what the numbers can and cannot tell you
  "tasks": [{ "id": "...", "title": "...",
              "before": { "success": true, "tool_errors": 1, "agent_flags": 1, "sql_error_flags": 0, "corrected": false, "answer": "...", "trace_id": "..." },
              "after":  { ... } }],
  "summary": { "before": { "tasks": 5, "succeeded": 2, "success_rate": 0.4, "tool_errors": 4, "flags": 5 }, "after": { ... } },
  "curator": { "run_status": "succeeded", "stats": { ... }, "proposals": [{ "title": "...", "risk": "low", "status": "applied", "auto_applied": true, "escalation": false, "paths": ["..."] }], "review": "..." }
}
```

## Adding a task

Tasks live in `examples/evals/src/tasks.ts`. A task has a prompt, a `check(answer)` that decides pass or fail
without a model, an optional `correction` (what the person who asked says when the answer misses), and the scripted
agent's behaviour, written against the same tools a model gets. If the task needs knowledge the revenue-report
bundle does not have, add the concept under `examples/evals/knowledge/`; if the offline curator should fix it, add
the matching step to `scriptedCurator()` in `examples/evals/src/offline.ts`, then update the expectations in
`examples/evals/test/offline.test.ts`.

## Limits

- One curator run between the phases. Tracking flag rate per concept over many runs is still open
  ([DESIGN.md §11](DESIGN.md#11-open-questions)).
- The checks are string checks on the answer, which suits these tasks (numbers, a header, a term) but not open
  questions.
- The reviewer is simulated in both modes; in real use people decide.
