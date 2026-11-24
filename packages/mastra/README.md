# @supaknowledge/mastra

[Supaknowledge](https://github.com/alvarofc/supaknowledge) for [Mastra](https://mastra.ai) agents: knowledge tools (search, read, skills, flag), a
system-prompt section that teaches the agent when to flag missing or wrong knowledge, and trace capture of agent
runs so the Supaknowledge curator can learn from them. Built on
[`@supaknowledge/sdk`](https://www.npmjs.com/package/@supaknowledge/sdk).

> Status: alpha (0.x). APIs may change between minor versions.

```bash
npm install @supaknowledge/mastra @supaknowledge/sdk @mastra/core zod
```

Peer dependencies: `@mastra/core` 1.85+ and `zod` 3.25+ or 4.

```ts
import { Agent } from "@mastra/core/agent";
import { Supaknowledge } from "@supaknowledge/sdk";
import { generateWithTrace, withSupaknowledge } from "@supaknowledge/mastra";

const kf = new Supaknowledge({ url: process.env.SUPAKNOWLEDGE_URL!, space: "acme/finance", apiKey: process.env.SUPAKNOWLEDGE_API_KEY });

const analyst = new Agent(
  withSupaknowledge(
    {
      id: "finance-analyst",
      name: "Finance analyst",
      instructions: "You answer finance questions with data from the warehouse.",
      model: "vercel/openai/gpt-6.2-sol", // or { id, url, apiKey } for your own OpenAI-compatible endpoint
    },
    kf,
  ),
);

const { result, traceId } = await generateWithTrace(analyst, kf, "What was revenue by region last week?");
```

| Export | What |
|---|---|
| `supaknowledgeTools(kf, { prefix?, include? })` | Mastra tools: `search_knowledge`, `read_concept`, `list_skills`, `load_skill`, `flag_knowledge` |
| `supaknowledgeInstructions`, `createSupaknowledgeInstructions({ prefix })` | The system-prompt section |
| `withSupaknowledge(agentConfig, kf, options?)` | Adds the tools and instructions to an Agent config |
| `generateWithTrace(agent, kf, input, options?)` | `agent.generate()` recorded as a Supaknowledge trace |
| `traceRun(kf, options?)` | The same for any call shape, including `agent.stream()` |

Full guide: [docs/sdk.md#mastra-agents](https://github.com/alvarofc/supaknowledge/blob/main/docs/sdk.md#mastra-agents).

## License

[Apache-2.0](LICENSE). Supaknowledge is a community project and is not affiliated with or endorsed by Supabase, Inc.
