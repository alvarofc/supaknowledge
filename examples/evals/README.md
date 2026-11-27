# Evals

The same agent on a fixed task set, before and after a curator run: task success, tool errors and flags per task.
The tasks start from [revenue-report](../revenue-report) and add a table in a Supabase app database reached through
tools named like the Supabase MCP server's.

```bash
npm run eval:offline     # scripted agent and curator model, in-memory store; deterministic (CI runs it)
npm run eval             # against the local stack (npx supabase start); a Mastra agent when KF_LLM_MODEL is set
npm run eval -- --reset  # delete what live runs created
```

Offline numbers come from the scripts: they show the harness and the loop work, not how a model performs.

| File | What |
|---|---|
| `src/tasks.ts` | The task set: prompts, checks, corrections, the scripted agent |
| `src/worlds.ts` | The simulated data sources (BigQuery warehouse, Supabase app database) |
| `src/offline.ts` | Offline mode and the scripted curator model |
| `src/live.ts` | Live mode against the local stack |
| `src/harness.ts` | Metrics, the terminal table, the JSON file |
| `knowledge/` | Concepts the eval adds to the revenue-report bundle |

Details: [docs/evals.md](../../docs/evals.md).
