# @supaknowledge/sdk

TypeScript client for [Supaknowledge](https://github.com/alvarofc/supaknowledge), an open-source knowledge factory built on Supabase. Search, read and
flag company knowledge, load [Agent Skills](https://agentskills.io), record agent traces for the curator, and hand
Supaknowledge to any tool-calling model as OpenAI-compatible (or plain JSON Schema) tools.

No dependencies. Runs anywhere `fetch` exists: Node 18+, Deno, Bun, browsers, Cloudflare / Vercel / Supabase Edge.

> Status: alpha (0.x). APIs may change between minor versions.

```bash
npm install @supaknowledge/sdk
```

```ts
import { Supaknowledge } from "@supaknowledge/sdk";

const kf = new Supaknowledge({
  url: process.env.SUPAKNOWLEDGE_URL!,         // https://<project>.supabase.co
  space: "acme/finance",                       // <workspace>/<space>
  apiKey: process.env.SUPAKNOWLEDGE_API_KEY,   // agent key: skn_...
});

const results = await kf.search("weekly revenue by region", { kinds: ["skill", "data_access"], limit: 5 });
const skill = await kf.loadSkill("revenue-report");

await kf.flag({
  kind: "incorrect",
  conceptPath: "data/orders",
  observation: "column revenue_usd does not exist; found revenue_usd_net",
  suggestedFix: "use revenue_usd_net",
});

// any OpenAI-compatible tool loop
const tools = kf.knowledgeTools();
// ...pass `tools` to your model, then: const outputs = await kf.handleToolCalls(message.tool_calls);
```

Credentials: an agent key (`kf agents create <name>` or Studio > Agents) or a signed-in user's Supabase access
token. Every call runs under row level security as that principal.

Full guide (transports, traces, MCP client config, Deno and browsers):
[docs/sdk.md](https://github.com/alvarofc/supaknowledge/blob/main/docs/sdk.md). For Mastra agents, see
[`@supaknowledge/mastra`](https://www.npmjs.com/package/@supaknowledge/mastra).

## License

[Apache-2.0](LICENSE). Supaknowledge is a community project and is not affiliated with or endorsed by Supabase, Inc.
