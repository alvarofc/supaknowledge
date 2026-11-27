# Example: the revenue report

The story from LangChain's [How to build a knowledge factory](https://www.langchain.com/blog/knowledge-factory),
played end to end on Supaknowledge for a fictional company, Acme Analytics:

1. An agent writes the monthly revenue report. The knowledge says the revenue column is `revenue_usd`, but it
   was renamed to `revenue_usd_net`. The query fails, the agent works around it, and **flags** the table guide
   with a suggested fix.
2. The finance lead corrects the report: *"from now on every report needs the ACME CONFIDENTIAL header"*. The
   correction is part of the agent's **trace**.
3. The **curator** turns the flag into a fix of the table guide (low risk, data access: the space policy applies
   it on its own) and mines the correction from the trace into a change to the `revenue-report` skill (waits for
   human review).
4. Along the way, the **access model**: one concept is finance-only, and neither the engineer (a space admin
   outside `finance`) nor the agent can see it.

## Run it

From the repository root, with the local stack running (`npx supabase start`, see
[getting started](../../docs/getting-started.md)):

```bash
npm run demo -w @supaknowledge/example-revenue-report              # or: npm run demo
npm run demo -w @supaknowledge/example-revenue-report -- --reset   # delete what earlier runs created
```

Each run creates a new workspace `acme-demo-<id>` and two people `@acme-demo.test` (password
`acme-demo-password`), so runs never collide. The demo narrates each step:

| Step | What happens | Supaknowledge piece |
|---|---|---|
| 1 | Create the finance lead and the engineer | Auth admin API (secret key, only here and in `--reset`) |
| 2 | Workspace, space, `finance` group, roles, auto-apply policy | `create_workspace`, `create_space`, inserts under RLS |
| 3 | Import `knowledge/` and apply it | `bundle` function → one proposal → `apply_proposal()` |
| 4 | Wait until every concept is embedded | triggers → pgmq `kf_embed` → cron → `embed` function |
| 5 | Register `revenue-report-agent` as a reader | `agents` function |
| 6 | The agent loads the skill, searches, reads the table guide, hits the renamed column (simulated warehouse), flags it, and records a trace with the finance lead's correction | A Mastra agent with `@supaknowledge/mastra` (tools, instructions, trace capture) when a model is configured, else a simulated agent on `@supaknowledge/sdk`; agent key over MCP; `traces` function |
| 7 | Who can read `finance/board-pack`: finance lead yes; engineer and agent no | RLS through MCP and PostgREST |
| 8 | Request a curator run and wait for it | `curator` function → `request_curator_run()` → pgmq `kf_curator` |
| 9 | Show the proposals (risk, escalation, auto-applied) and how to review them | Studio inbox, `kf proposals` / `kf approve` |

### The working agent: real or simulated

With a model configured in your shell, using the same variables as the curator, the working agent in step 6 is a
real [Mastra](https://mastra.ai) agent (`src/agent.ts`): `withSupaknowledge()` gives it the Supaknowledge tools and instructions,
a `run_warehouse_query` tool talks to the simulated warehouse, and `traceRun()` records the whole run (both turns,
every tool call, the warehouse error, the flag, the correction) as one trace.

```bash
# your OpenAI-compatible endpoint
KF_LLM_MODEL=acme/your-model KF_LLM_BASE_URL=https://llm.acme.internal/v1 KF_LLM_API_KEY=... npm run demo
# or the Vercel AI Gateway
KF_LLM_MODEL=vercel/openai/gpt-6.2-sol AI_GATEWAY_API_KEY=... npm run demo
```

A real model decides for itself: it may phrase the flag differently, or not flag at all (the demo says so; the
curator can still mine the failed query from the trace). Without `KF_LLM_MODEL` the agent is simulated: it makes the
same SDK calls in a fixed order. `test/mock-model.ts` is a mock OpenAI-compatible endpoint that plays the agent's
part, for trying the real-agent path without a model (`node --conditions=supaknowledge-source test/mock-model.ts` prints
the variables to export).

### The curator

The curator reads its model from the Edge Function secrets in `supabase/.env` (`KF_LLM_MODEL` with
`KF_LLM_BASE_URL` / `KF_LLM_API_KEY`, or `AI_GATEWAY_API_KEY`; then `npx supabase stop && npx supabase start`), not
from your shell; see [model configuration](../../docs/curator.md#model-configuration). Without a model the run fails
at once; the demo detects that, prints how to configure one, and stops cleanly. The flag and trace stay in the
space for the next run.

Environment: `SUPAKNOWLEDGE_URL`, `SUPAKNOWLEDGE_PUBLISHABLE_KEY`, `SUPAKNOWLEDGE_SECRET_KEY` (default: the local stack's keys),
`SUPAKNOWLEDGE_STUDIO_URL`, `DEMO_CURATOR_TIMEOUT_S` (default 900).

## Without a stack or an API key

```bash
npm run offline -w @supaknowledge/example-revenue-report           # or: npm run demo:offline
```

`src/offline.ts` loads the same bundle into an in-memory store (`src/memory-store.ts`), replays the flag, the
trace and a finance-only question about ARR, and runs the real curator engine (`runTask` from
`@supaknowledge/core/curator`) with `ScriptedLLM` answering in place of a model. It prints every task and a diff of each proposal:
the table fix is auto-applied, the skill change waits for review, and an ARR clarification that cites
finance-only evidence is flagged as an **escalation**.

A second part replays the rename as a [schema source](../../docs/connectors.md#database-schema-schema) would see
it, before any agent runs: two snapshots of a Postgres copy of `finance.revenue_daily` (`revenue_usd`, then
`revenue_usd_net`) give a drift flag on `data/bigquery/revenue` ("probably renamed to `revenue_usd_net`"), and the
curator drafts the fix citing the schema document and the flag. A rename is a guess, so that proposal waits for
review. `npm test -w @supaknowledge/example-revenue-report` runs it as a test, together with the real-agent path against the
mock endpoint (`test/agent.test.ts`).

## The knowledge

`knowledge/` is an OKF bundle with an Agent Skill ([format](../../docs/okf.md)):

| Path | Kind | Notes |
|---|---|---|
| `data/bigquery/revenue` | data_access | The table guide with the outdated `revenue_usd` column |
| `data/salesforce/opportunities` | data_access | Bookings and ARR deltas |
| `metrics/arr`, `metrics/nrr` | domain | Metric definitions |
| `policies/report-formatting` | domain | House style (no confidential header yet) |
| `finance/board-pack` | domain | `x-supaknowledge-audience: [finance]` |
| `skills/revenue-report` | skill | `SKILL.md` + `templates/report-template.md` |

Load it into your own space with `npx kf import examples/revenue-report/knowledge --apply` (create the `finance`
group first: `npx kf groups create finance && npx kf groups add finance me`).
