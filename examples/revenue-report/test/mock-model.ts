// A mock OpenAI-compatible chat-completions endpoint that plays the working agent of the story: load the
// skill, search, read the table guide, hit the renamed column, retry, flag, write the report, then apply the
// finance lead's correction. Used by agent.test.ts; also handy to try the live demo without a model:
//   node --conditions=supaknowledge-source test/mock-model.ts   (prints KF_LLM_* to export)
import http from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { REVENUE_TABLE_PATH, SKILL_NAME, STORY } from "../src/lib.ts";

type Msg = { role: string; content?: unknown; tool_calls?: unknown[] };

function reply(messages: Msg[]): { content?: string; tool_calls?: { id: string; name: string; arguments: unknown }[] } {
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (String(lastUser?.content ?? "").includes("ACME CONFIDENTIAL")) return { content: STORY.draftWithHeader + STORY.draftWithoutHeader };
  const done = messages.filter((m) => m.role === "tool").length;
  const call = (name: string, args: unknown) => ({ tool_calls: [{ id: `call_${done + 1}`, name, arguments: args }] });
  switch (done) {
    case 0: return call("load_skill", { name: SKILL_NAME });
    case 1: return call("search_knowledge", { query: "which table has monthly revenue by region", kinds: ["data_access"] });
    case 2: return call("read_concept", { path: REVENUE_TABLE_PATH });
    case 3: return call("run_warehouse_query", { sql: STORY.firstQuery });
    case 4: return call("run_warehouse_query", { sql: STORY.fixedQuery });
    case 5: return call("flag_knowledge", { kind: STORY.flag.kind, concept_path: REVENUE_TABLE_PATH, query: STORY.flag.query, observation: STORY.flag.observation, suggested_fix: STORY.flag.suggestedFix });
    default: return { content: STORY.draftWithoutHeader };
  }
}

export function startMockModel(port = 0) {
  const requests: { model: string; messages: Msg[]; tools?: unknown[] }[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { model: string; messages: Msg[]; tools?: unknown[] };
      requests.push(body);
      const r = reply(body.messages ?? []);
      const toolCalls = r.tool_calls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: JSON.stringify(t.arguments) } }));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({
        id: `chatcmpl-${requests.length}`, object: "chat.completion", created: 1, model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: r.content ?? null, ...(toolCalls ? { tool_calls: toolCalls } : {}) }, finish_reason: toolCalls ? "tool_calls" : "stop" }],
        usage: { prompt_tokens: 50, completion_tokens: 5, total_tokens: 55 },
      }));
    });
  });
  return new Promise<{ url: string; requests: typeof requests; close: () => void }>((resolve) =>
    server.listen(port, "127.0.0.1", () => resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests, close: () => server.close() })),
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const m = await startMockModel(Number(process.env.PORT ?? 0));
  console.log(`export KF_LLM_MODEL=mock/working-agent KF_LLM_BASE_URL=${m.url} KF_LLM_API_KEY=mock`);
}
