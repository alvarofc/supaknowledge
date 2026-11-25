import { test } from "node:test";
import assert from "node:assert/strict";
import {
  chunkMarkdown,
  decideAutoApply,
  exportBundle,
  extractLinks,
  importBundle,
  inAudience,
  isEscalation,
  isValidConceptPath,
  lintConcept,
  narrowestSafeAudience,
  parseMarkdown,
  parseSettings,
  relativeHref,
  resolveHref,
  serializeMarkdown,
} from "../src/index.ts";

test("frontmatter round-trips unknown keys and quoted numbers", () => {
  const src = `---\ntype: Metric\ntitle: ARR\nokf_version: "0.3"\nx-acme-owner: finance\nsources:\n  - id: wiki\n    resource: https://wiki/arr\n---\n\n# ARR\n\nAnnual recurring revenue.\n`;
  const { frontmatter, body } = parseMarkdown(src);
  assert.equal(frontmatter?.["x-acme-owner"], "finance");
  assert.equal(frontmatter?.okf_version, "0.3");
  const again = parseMarkdown(serializeMarkdown(frontmatter, body));
  assert.deepEqual(again.frontmatter, frontmatter);
  assert.equal(again.body.trim(), body.trim());
});

test("frontmatter rejects duplicate keys", () => {
  assert.throws(() => parseMarkdown(`---\ntype: A\ntype: B\n---\nx`));
});

test("links resolve per OKF §6", () => {
  assert.equal(resolveHref("metrics/arr", "../data/revenue.md"), "data/revenue");
  assert.equal(resolveHref("metrics/arr", "/policies/discounts.md"), "policies/discounts");
  assert.equal(resolveHref("metrics/arr", "nrr.md#definition"), "metrics/nrr");
  assert.equal(resolveHref("a", "../../escape.md"), null);
  const links = extractLinks("metrics/arr", "See [rev](../data/revenue.md), [ext](https://x.y), `[code](no.md)` and [[wiki]].\n```\n[fenced](no.md)\n```");
  assert.deepEqual(links.map((l) => l.path ?? l.href), ["data/revenue", "https://x.y"]);
  assert.equal(relativeHref("metrics/arr", "data/revenue"), "../data/revenue.md");
  assert.equal(relativeHref("metrics/arr", "metrics/nrr"), "nrr.md");
});

test("import + export: OKF concepts and Agent Skills", () => {
  const files = [
    { path: "index.md", content: `---\nokf_version: "0.3"\ntitle: Acme\n---\n# Acme\n` },
    { path: "metrics/arr.md", content: `---\ntype: Metric\ntitle: ARR\ndescription: How Acme computes ARR.\nx-supaknowledge-audience: [finance]\nx-acme: 1\n---\n\nBody [rev](../data/revenue.md)\n` },
    { path: "data/revenue.md", content: `---\ntype: BigQuery Table\n---\n\n# Revenue table\n\nThe revenue table lives in BigQuery.\n` },
    { path: "README.md", content: "# not a concept" },
    { path: "skills/revenue-report/SKILL.md", content: `---\nname: revenue-report\ndescription: Build the monthly revenue report. Use when finance asks for it.\nlicense: Apache-2.0\n---\n\n# Revenue report\n\n1. Pull data\n` },
    { path: "skills/revenue-report/templates/header.md", content: "ACME CONFIDENTIAL" },
  ];
  const map = { toId: (s: string) => (s === "finance" ? "g-fin" : undefined), toSlug: (id: string) => (id === "g-fin" ? "finance" : undefined) };
  const res = importBundle(files, map);
  assert.deepEqual(res.warnings, []);
  assert.equal(res.bundle.title, "Acme");
  const byPath = Object.fromEntries(res.concepts.map((c) => [c.draft.path, c]));
  assert.deepEqual(Object.keys(byPath).sort(), ["data/revenue", "metrics/arr", "skills/revenue-report"]);
  assert.equal(byPath["data/revenue"]!.draft.kind, "data_access");
  assert.equal(byPath["data/revenue"]!.draft.title, "Revenue table");
  assert.equal(byPath["metrics/arr"]!.draft.kind, "domain");
  assert.deepEqual(byPath["metrics/arr"]!.draft.audience, ["g-fin"]);
  assert.equal(byPath["metrics/arr"]!.draft.frontmatter["x-acme"], 1);
  assert.equal(byPath["skills/revenue-report"]!.draft.kind, "skill");
  assert.equal(byPath["skills/revenue-report"]!.files[0]!.path, "templates/header.md");

  const out = exportBundle(
    res.concepts.map((c) => ({ ...c.draft, files: c.files })),
    { title: "Acme", audienceMap: map },
  );
  const paths = out.map((f) => f.path);
  assert.ok(paths.includes("index.md"));
  assert.ok(paths.includes("skills/revenue-report/SKILL.md"));
  assert.ok(paths.includes("skills/revenue-report/templates/header.md"));
  assert.ok(paths.includes("metrics/index.md"));
  const reimported = importBundle(out, map);
  assert.deepEqual(
    reimported.concepts.map((c) => [c.draft.path, c.draft.kind, c.draft.audience, c.draft.frontmatter["x-acme"]]),
    res.concepts.map((c) => [c.draft.path, c.draft.kind, c.draft.audience, c.draft.frontmatter["x-acme"]]),
  );
  // public exports drop restricted knowledge
  const pub = exportBundle(res.concepts.map((c) => c.draft), { title: "Acme", publicOnly: true });
  assert.ok(!pub.some((f) => f.path === "metrics/arr.md"));
});

test("lint catches bad skills and paths", () => {
  assert.deepEqual(lintConcept({ path: "metrics/arr", kind: "domain", type: "Metric", title: "ARR", description: "x" }), []);
  assert.ok(lintConcept({ path: "skills/Bad_Name", kind: "skill", type: "Skill", title: "x", description: "" }).length >= 2);
  assert.ok(lintConcept({ path: "../x" }).length > 0);
  assert.ok(lintConcept({ path: "a/index" }).length > 0);
  for (const bad of ["metrics//arr", "metrics/./arr", "metrics/arr/", "./metrics"]) {
    assert.equal(isValidConceptPath(bad), false, bad);
    assert.ok(lintConcept({ path: bad }).length > 0, bad);
  }
  assert.equal(isValidConceptPath("metrics/v1.2/arr"), true);
});

test("chunking keeps heading trails and respects size", () => {
  const md = `# Title\n\nIntro.\n\n## Section A\n\n${"word ".repeat(600)}\n\n## Section B\n\n\`\`\`\n# not a heading\n\`\`\`\n`;
  const chunks = chunkMarkdown(md, { maxChars: 1000, preamble: "ARR" });
  assert.ok(chunks.length >= 4);
  assert.ok(chunks.every((c) => c.content.startsWith("ARR")));
  assert.ok(chunks.some((c) => c.heading === "Title > Section A"));
  assert.ok(chunks.some((c) => c.heading === "Title > Section B" && c.content.includes("# not a heading")));
  assert.ok(chunks.every((c) => c.content.length < 1200));
});

test("audience rules match the database", () => {
  assert.equal(inAudience([], []), true);
  assert.equal(inAudience(["fin"], ["eng"]), false);
  assert.equal(inAudience(["fin", "exec"], ["exec"]), true);
  assert.equal(isEscalation([], []), false);
  assert.equal(isEscalation(["fin"], []), true);
  assert.equal(isEscalation(["fin", "exec"], ["fin"]), false);
  assert.equal(isEscalation(["fin"], ["fin", "eng"]), true);
  assert.deepEqual(narrowestSafeAudience([[], ["fin", "exec"], ["exec"]]), ["exec"]);
  assert.equal(narrowestSafeAudience([["fin"], ["eng"]]), null);
});

test("auto-apply policy", () => {
  const off = parseSettings({});
  const base = { risk: "low" as const, escalation: false, opKinds: ["update" as const], conceptKinds: ["data_access" as const], citationKinds: ["flag" as const] };
  assert.equal(decideAutoApply(off, base).autoApply, false);
  const on = parseSettings({ auto_apply: { enabled: true } });
  assert.equal(decideAutoApply(on, base).autoApply, true);
  assert.equal(decideAutoApply(on, { ...base, escalation: true }).autoApply, false);
  assert.equal(decideAutoApply(on, { ...base, risk: "medium" }).autoApply, false);
  assert.equal(decideAutoApply(on, { ...base, conceptKinds: ["domain"] }).autoApply, false);
  assert.equal(decideAutoApply(on, { ...base, citationKinds: ["source_document"] }).autoApply, false);
  assert.equal(decideAutoApply(on, { ...base, opKinds: ["create"] }).autoApply, false);
});

test("import fails closed on unknown audience groups", () => {
  const files = [
    { path: "finance/secret.md", content: `---\ntype: Policy\ntitle: Secret\nx-supaknowledge-audience: [finance]\n---\nTop secret\n` },
    { path: "public.md", content: `---\ntype: Policy\ntitle: Public\n---\nHello\n` },
  ];
  const res = importBundle(files, { toId: () => undefined, toSlug: () => undefined });
  assert.deepEqual(res.concepts.map((c) => c.draft.path), ["public"], "restricted concept is skipped, not made public");
  assert.match(res.warnings.join("\n"), /finance\/secret\.md: skipped/);
});

test("skill links resolve to the skill concept", () => {
  assert.equal(resolveHref("metrics/arr", "../skills/revenue-report/SKILL.md"), "skills/revenue-report");
  // inside a SKILL.md, relative links resolve from the skill directory
  assert.equal(resolveHref("skills/revenue-report/SKILL", "../../metrics/arr.md"), "metrics/arr");
});

test("skill titles survive export", () => {
  const out = exportBundle([{ path: "skills/x", kind: "skill", type: "Skill", title: "Custom title", description: "Does x. Use when y.", body: "# Other heading\n", frontmatter: {}, tags: [], status: "stable", audience: [] }], { title: "t" });
  const back = importBundle(out);
  assert.equal(back.concepts[0]!.draft.title, "Custom title");
});

