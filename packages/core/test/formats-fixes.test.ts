// Review fixes outside the curator engine: settings parsing, chunking, OKF round-trips, links, LLM config.
import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { z } from "zod";
import { chunkMarkdown, exportBundle, importBundle, parseMarkdown, resolveHref, conceptToFiles } from "../src/formats.ts";
import { decideAutoApply, parseSettings, parseSettingsWithWarnings } from "../src/settings.ts";
import { isModelAllowed, llmConfigFromEnv, LLMConfigError, MastraLLM } from "../src/llm.ts";

test("parseSettings keeps every valid field when one field is invalid", () => {
  const { settings, warnings } = parseSettingsWithWarnings({
    curator: { enabled: false, instructions: "Never include customer names", max_research_steps: 0 },
    auto_apply: { enabled: true, max_risk: "extreme" },
    staleness: "nope",
  });
  assert.equal(settings.curator.enabled, false);
  assert.equal(settings.curator.instructions, "Never include customer names");
  assert.equal(settings.curator.max_research_steps, 8);
  assert.equal(settings.auto_apply.enabled, true);
  assert.equal(settings.auto_apply.max_risk, "low");
  assert.equal(settings.staleness.data_access_days, 90);
  assert.equal(warnings.length, 3);
  assert.match(warnings.join("\n"), /curator\.max_research_steps/);
  assert.deepEqual(parseSettings(null), parseSettings({}));
  assert.equal(parseSettings({}).curator.max_tokens_per_run, 3_000_000);
  assert.equal(parseSettings({}).curator.research_scope, "target_audience");
});

test("auto-apply never applies URL citations or untrusted source kinds", () => {
  const s = parseSettings({ auto_apply: { enabled: true, require_observed_evidence: false } });
  const base = { risk: "low" as const, escalation: false, opKinds: ["update" as const], conceptKinds: ["data_access" as const], citationKinds: ["flag" as const] };
  assert.equal(decideAutoApply(s, base).autoApply, true);
  assert.equal(decideAutoApply(s, { ...base, citationKinds: ["flag", "url"] }).autoApply, false);
  assert.equal(decideAutoApply(s, { ...base, sourceKinds: ["notion", "web"] }).autoApply, false);
  assert.equal(decideAutoApply(s, { ...base, sourceKinds: ["notion"] }).autoApply, true);
});

test("chunks stay within maxChars including the preamble and heading trail", () => {
  const preamble = "Skill title — " + "d".repeat(900);
  const body = "# Steps\n\n" + Array.from({ length: 40 }, (_, i) => `Paragraph ${i} ` + "word ".repeat(60)).join("\n\n");
  const chunks = chunkMarkdown(body, { maxChars: 1200, preamble });
  assert.ok(chunks.length > 1);
  for (const c of chunks) assert.ok(c.content.length <= 1200, `chunk ${c.ord} is ${c.content.length} chars`);
  assert.ok(chunks.every((c) => c.content.includes("Paragraph")), "every chunk keeps body text");
});

test("chunking terminates when overlap >= maxChars", () => {
  const long = "x".repeat(5000);
  const chunks = chunkMarkdown(long, { maxChars: 500, overlapChars: 900 });
  assert.ok(chunks.length >= 10 && chunks.length < 100);
  for (const c of chunks) assert.ok(c.content.length <= 500);
});

test("importBundle: skills/x/SKILL.md and skills/x.md do not collide; root SKILL.md keeps its files and the OKF concepts", () => {
  const skill = (name: string) => `---\nname: ${name}\ndescription: Does ${name}.\n---\n\n# ${name}\n`;
  const okf = `---\ntype: Policy\ntitle: P\n---\n\n# P\n`;
  const dup = importBundle([
    { path: "skills/dup/SKILL.md", content: skill("dup") },
    { path: "skills/dup.md", content: `---\ntype: Skill\ntitle: Dup\n---\n\nbody\n` },
  ]);
  assert.deepEqual(dup.concepts.map((c) => c.draft.path), ["skills/dup"]);
  assert.match(dup.warnings.join("\n"), /already defined/);

  const root = importBundle([
    { path: "SKILL.md", content: skill("solo") },
    { path: "scripts/run.sh", content: "echo hi" },
    { path: "policies/p.md", content: okf },
  ]);
  const byPath = Object.fromEntries(root.concepts.map((c) => [c.draft.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), ["policies/p", "skills/solo"]);
  assert.deepEqual(byPath["skills/solo"]!.files.map((f) => f.path), ["scripts/run.sh"]);
});

test("export re-derives x-supaknowledge-* keys: a concept made public loses its stale audience", () => {
  const c = {
    path: "metrics/arr", kind: "domain" as const, type: "Metric", title: "ARR", description: "", body: "# ARR\n",
    frontmatter: { "x-supaknowledge-audience": ["finance"], "x-acme": 1 }, tags: [], status: "stable" as const, audience: [],
  };
  const [file] = conceptToFiles(c);
  assert.doesNotMatch(file!.content, /x-supaknowledge-audience/);
  assert.match(file!.content, /x-acme: 1/);
  const skill = { ...c, path: "skills/s", kind: "skill" as const, type: "Skill", description: "Does s.", frontmatter: { metadata: { "supaknowledge-audience": ["finance"], keep: "y" } } };
  const [sk] = conceptToFiles(skill);
  assert.doesNotMatch(sk!.content, /supaknowledge-audience/);
  assert.match(sk!.content, /keep: y/);
});

test("an empty export still has a root index.md", () => {
  const files = exportBundle([], { title: "Empty" });
  assert.deepEqual(files.map((f) => f.path), ["index.md"]);
  assert.match(files[0]!.content, /okf_version/);
});

test("empty frontmatter blocks parse; a root index.md link is not a concept", () => {
  assert.deepEqual(parseMarkdown("---\n---\n\n# T\n"), { frontmatter: {}, body: "\n# T\n" });
  assert.equal(resolveHref("a", "index.md"), null);
  assert.equal(resolveHref("dir/a", "../index.md"), null);
  assert.equal(resolveHref("dir/a", "index.md"), "dir");
});

test("KF_LLM_ALLOWED_MODELS restricts space model overrides; JSON env values must be objects", () => {
  const env = (vars: Record<string, string>) => (n: string) => vars[n];
  assert.ok(isModelAllowed("vercel/openai/gpt-x", ["vercel/openai/*"]));
  assert.ok(!isModelAllowed("vercel/anthropic/x", ["vercel/openai/*", "acme/m"]));
  const vars = { KF_LLM_MODEL: "acme/m", KF_LLM_ALLOWED_MODELS: "acme/m, vercel/openai/*" };
  assert.equal(llmConfigFromEnv(env(vars), { model: "vercel/openai/gpt-x" }).model, "vercel/openai/gpt-x");
  assert.throws(() => llmConfigFromEnv(env(vars), { model: "vercel/anthropic/opus" }), LLMConfigError);
  assert.throws(() => llmConfigFromEnv(env(vars), { fallbackModels: ["other/x"] }), /not in KF_LLM_ALLOWED_MODELS/);
  assert.equal(llmConfigFromEnv(env({ KF_LLM_MODEL: "a/b" }), { model: "any/model" }).model, "any/model", "no allow-list: unchanged");
  for (const bad of ["null", "[1]", "3", '{"x": 1}']) {
    assert.throws(() => llmConfigFromEnv(env({ KF_LLM_MODEL: "a/b", KF_LLM_BASE_URL: "http://x", KF_LLM_HEADERS: bad })), LLMConfigError, bad);
  }
  assert.throws(() => llmConfigFromEnv(env({ KF_LLM_MODEL: "a/b", KF_LLM_BASE_URL: "http://x", KF_LLM_EXTRA_BODY: "[]" })), LLMConfigError);
});

test("MastraLLM honours the abort signal (a hanging endpoint does not hang the task)", async () => {
  const server = http.createServer(() => {
    /* never answers */
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    const llm = new MastraLLM({ model: "acme/slow", endpoint: { baseUrl: url, apiKey: "k" } });
    const started = Date.now();
    await assert.rejects(llm.generate({ system: "s", input: "i", schema: z.object({ ok: z.boolean() }), signal: AbortSignal.timeout(300) }));
    assert.ok(Date.now() - started < 5000, `took ${Date.now() - started}ms`);
  } finally {
    server.closeAllConnections();
    server.close();
  }
});
