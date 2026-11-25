// Follow-ups from the PR #5 bot review (container-aware fences, code spans, trace rendering budget) and the
// curator frontmatter churn found on a hosted run (tags, sources and stale_after rewritten by an update).
import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMarkdown, extractLinks, parseSettings } from "../src/index.ts";
import { fencedLines, stripCodeSpans } from "../src/fences.ts";
import { buildProposal, type Evidence, renderTrace } from "../src/curator/index.ts";
import type { DraftOutput } from "../src/curator/schemas.ts";
import type { Concept, SourceDocument, Trace, TraceEvent } from "../src/types.ts";

// ---------------------------------------------------------------------------------------------------------
// fences and code spans
// ---------------------------------------------------------------------------------------------------------

const paths = (md: string) => extractLinks("x/y", md).map((l) => l.path);

test("fences inside block quotes exclude their links; the quote ending closes an unclosed fence", () => {
  assert.deepEqual(paths("> ~~~\n> [example](fake.md)\n> ~~~\n\n[real](real.md)"), ["x/real"]);
  assert.deepEqual(paths(">> ```\n>> [deep](fake.md)\n>> ```\n[real](real.md)"), ["x/real"]);
  assert.deepEqual(paths("> ```\n> [inside](fake.md)\n\n[after the quote](real.md)"), ["x/real"]);
  assert.deepEqual(paths("> ```\n> [inside](fake.md)\nlazy [line](real.md)"), ["x/real"]);
});

test("four-space indented code is not a fence and does not swallow what follows", () => {
  assert.deepEqual(paths("    ~~~\n\n[real](real.md)"), ["x/real"]);
  assert.deepEqual(fencedLines(["    ```", "x", "```", "y", "```"]), [false, false, true, true, true]);
  // a paragraph continuation line indented 4+ columns is not an opener either
  assert.deepEqual(fencedLines(["text", "    ```", "[a](a.md)"]), [false, false, false]);
});

test("fences inside list items: relative indentation, nested lists, and the item ending", () => {
  const md = [
    "- item",
    "",
    "  ```",
    "  [in list fence](no1.md)",
    "  ```",
    "1. step",
    "   ~~~",
    "   [ordered](no2.md)",
    "   ~~~",
    "- outer",
    "  - inner",
    "    ```",
    "    [nested](no3.md)",
    "    ```",
    "- ```",
    "  [same line](no4.md)",
    "  ```",
    "- item",
    "  ```",
    "  [open](no5.md)",
    "[item ended](yes.md)",
  ].join("\n");
  assert.deepEqual(paths(md), ["x/yes"]);
  // a fence indented 4+ columns past its list item's content is indented code inside the item
  assert.deepEqual(fencedLines(["- item", "", "      ```", "  [x](x.md)"]), [false, false, false, false]);
});

test("the earlier fence rules still hold (character, length, info string, unclosed)", () => {
  const lines = ["````md", "```", "~~~", "inside", "````", "after", "~~~", "``` still open", "```x`y", "tail"];
  assert.deepEqual(fencedLines(lines), [true, true, true, true, true, false, true, true, true, true]);
  assert.deepEqual(fencedLines(["   ```", "x", "   ```"]), [true, true, true], "up to 3 spaces of indentation is a fence");
  const md = ["# Real", "> ```", "> # quoted, fenced", "> ```", "# Second", "text"].join("\n");
  assert.deepEqual(chunkMarkdown(md).map((c) => c.heading), ["Real", "Second"]);
});

test("code spans: multi-backtick and multi-line spans hide their links; unmatched backticks are literal", () => {
  assert.deepEqual(paths("``[a](no1.md) with a ` inside`` [b](b.md)"), ["x/b"]);
  assert.deepEqual(paths("see `[a](no.md)\nstill code` and [c](c.md)"), ["x/c"]);
  assert.deepEqual(paths("a ``` b [d](d.md)"), ["x/d"], "an unmatched run is literal text");
  assert.deepEqual(paths("`open\n\n[e](e.md) `"), ["x/e"], "a span never crosses a blank line");
  assert.deepEqual(paths("`x` [f](f.md) ``y``"), ["x/f"]);
  // a run only closes on exactly the same length
  assert.equal(stripCodeSpans("``a`b`` c"), "  c");
  assert.equal(stripCodeSpans("[a]`x`(b.md)").includes("[a](b.md)"), false, "removing a span never joins text into a link");
});

// ---------------------------------------------------------------------------------------------------------
// renderTrace budget
// ---------------------------------------------------------------------------------------------------------

function trace(events: TraceEvent[]): Trace {
  return { id: "t1", space_id: "s", principal_id: null, name: "long", outcome: "corrected", audience: [], metadata: {}, started_at: "", events };
}

test("renderTrace: correction signals are kept before predecessor context (late user correction survives)", () => {
  const big = (c: string) => `${c} ${"z".repeat(1990)}`;
  const events: TraceEvent[] = [
    { seq: 0, role: "assistant", content: big("first answer") },
    { seq: 1, role: "feedback", content: big("thumbs down") },
    { seq: 2, role: "tool", tool_name: "sql", content: big("ordinary tool") },
    { seq: 3, role: "assistant", content: big("second answer") },
    { seq: 4, role: "user", content: big("actually, use revenue_usd_net") },
  ];
  const out = renderTrace(trace(events), 8000);
  assert.ok(out.length <= 8000, `${out.length}`);
  assert.match(out, /\[4\] user: actually, use revenue_usd_net/);
  assert.match(out, /\[1\] feedback: thumbs down/);
});

test("renderTrace: a failed tool keeps its later successful retry; late corrections beat early errors", () => {
  const filler = (seq: number): TraceEvent => ({ seq, role: "assistant", content: `filler ${seq} ${"f".repeat(300)}` });
  const events: TraceEvent[] = [{ seq: 0, role: "user", content: "build the report" }];
  // many early failures that alone would exceed the budget
  for (let i = 1; i <= 20; i++) events.push({ seq: i, role: "tool", tool_name: `t${i}`, is_error: true, content: `error ${i} ${"e".repeat(300)}` });
  events.push({ seq: 21, role: "tool", tool_name: "sql", is_error: true, content: "Unrecognized name: revenue_usd" });
  for (let i = 22; i <= 40; i++) events.push(filler(i));
  events.push({ seq: 41, role: "tool", tool_name: "sql", content: "ok: 12 rows using revenue_usd_net" });
  for (let i = 42; i <= 60; i++) events.push(filler(i));
  events.push({ seq: 61, role: "user", content: "no, that's wrong: finance wants net revenue" });
  const out = renderTrace(trace(events), 3000);
  assert.ok(out.length <= 3000, `${out.length}`);
  assert.match(out, /\[61\] user: no, that's wrong/, "the late correction is kept");
  assert.match(out, /\[21\] tool:sql \(ERROR\)/);
  assert.match(out, /\[41\] tool:sql: ok: 12 rows/, "the recovery is kept with its failure");
});

test("renderTrace: one oversized event does not stop the fill, and contiguous kept events share one marker budget", () => {
  const events: TraceEvent[] = [{ seq: 0, role: "user", content: "task" }];
  for (let i = 1; i <= 30; i++) events.push({ seq: i, role: "assistant", content: `small ${i}` });
  events.push({ seq: 31, role: "tool", tool_name: "dump", content: "d".repeat(1900) });
  for (let i = 32; i <= 40; i++) events.push({ seq: i, role: "assistant", content: `tail ${i}` });
  const out = renderTrace(trace(events), 1000);
  assert.ok(out.length <= 1000, `${out.length}`);
  assert.doesNotMatch(out, /\[31\]/);
  assert.match(out, /\[40\] assistant: tail 40/);
  assert.match(out, /\[30\] assistant: small 30/, "events before the oversized one are still considered");
  assert.match(out, /\[0\] user: task/);
  // markers are paid per omitted run, not reserved per kept event (32 chars each would fit fewer than 20 here)
  assert.ok((out.match(/^\[\d+\] /gm) ?? []).length >= 35, out);
  assert.ok((out.match(/omitted\]/g) ?? []).length <= 2, out);
});

// ---------------------------------------------------------------------------------------------------------
// curator: an update preserves the frontmatter it did not mean to change
// ---------------------------------------------------------------------------------------------------------

const NOW = new Date("2026-11-25T00:00:00Z");

function revenueConcept(): Concept {
  return {
    id: "11111111-1111-1111-1111-111111111111", space_id: "s", path: "data/bigquery/revenue", kind: "data_access", type: "BigQuery Table",
    title: "Revenue fact table (finance.revenue_daily)", description: "Daily recognized revenue.",
    body: "# Revenue fact table\n\nOne row per invoice line per day.[^dbt-revenue-daily]\n",
    frontmatter: {
      resource: "bigquery://acme-prod/finance/revenue_daily",
      sources: [
        { id: "dbt-revenue-daily", title: "dbt model finance.revenue_daily", resource: "https://github.example/acme/analytics/blob/main/models/finance/revenue_daily.sql" },
        { id: "data-catalog", title: "Data catalog entry", resource: "https://catalog.acme.example/tables/acme-prod.finance.revenue_daily" },
      ],
      "x-acme-owner": "finance-data",
    },
    tags: ["revenue", "bigquery", "finance"], status: "stable", superseded_by: null,
    // as Postgres returns a timestamptz
    stale_after: "2027-03-01T00:00:00+00:00",
    audience: [], revision: 3, generated_by: null, generated_at: "", created_at: "", updated_at: "",
  } as Concept;
}

function draftOut(op: Partial<DraftOutput["ops"][number]>, citations: DraftOutput["citations"]): DraftOutput {
  return {
    decision: "propose", title: "t", rationale: "r", risk: "low",
    ops: [{
      op: "update", path: "data/bigquery/revenue", new_path: null, kind: null, type: null, title: null, description: null,
      body: "# Revenue fact table\n\nOne row per invoice line per day.[^dbt-revenue-daily] Use `revenue_usd_net`.[^renamed]\n",
      tags: null, superseded_by: null, stale_after: null, citation_labels: citations.map((c) => c.label), rationale: "fix", ...op,
    }],
    citations, resolves_flags: [], dismiss_flags: [],
  };
}

function evidence(c: Concept, docs: SourceDocument[] = []): Evidence {
  return { flags: new Map(), traces: new Map(), documents: new Map(docs.map((d) => [d.id, d])), sourceHits: [], targets: new Map([[c.path, c]]), related: [] };
}

test("curator update: the hosted-run repro keeps tags, x-* keys, sources (titles, resources, order) and stale_after", () => {
  const c = revenueConcept();
  const changelog: SourceDocument = {
    id: "d-1", source_id: "src", space_id: "s", external_id: "changelog", title: "Schema changelog", url: "https://wiki.example/changelog",
    content: "revenue_usd renamed to revenue_usd_net", audience: [], author: null, changed_at: "2026-11-20T00:00:00Z",
  };
  const out = draftOut(
    // what the model sent: tags emptied, the same review date in another format, the old footnote re-cited with
    // the concept itself as evidence, and a new footnote for the new evidence
    { tags: [], stale_after: "2027-03-01T00:00:00+00:00" },
    [
      { label: "dbt-revenue-daily", ref: `concept:${c.path}`, quote: "One row per invoice line per day." },
      { label: "renamed", ref: "doc:d-1", quote: "revenue_usd renamed to revenue_usd_net" },
    ],
  );
  const { draft, problems } = buildProposal(out, evidence(c, [changelog]), new Map(), parseSettings({}), NOW);
  assert.deepEqual(problems, []);
  const after = draft.ops[0]!.after;
  assert.equal("tags" in after, false, "tags are kept");
  assert.equal("stale_after" in after, false, "the same instant in another format is not a change");
  const fm = after.frontmatter!;
  assert.deepEqual(Object.keys(fm), ["resource", "sources", "x-acme-owner"], "every other key is kept, in order");
  assert.equal(fm["x-acme-owner"], "finance-data");
  assert.deepEqual(fm.sources, [
    ...(c.frontmatter.sources as unknown[]),
    { id: "renamed", resource: "https://wiki.example/changelog", "x-supaknowledge-document": "d-1", title: "Schema changelog", last_modified: "2026-11-20T00:00:00Z" },
  ]);
  // the concept was not mutated
  assert.equal((revenueConcept().frontmatter.sources as unknown[]).length, 2);
});

test("curator update: a reused label with different evidence gets a free id; already-listed evidence is not added twice", () => {
  const c = revenueConcept();
  const flagEv = { ...evidence(c), flags: new Map([["f1", { id: "f1", audience: [] } as never]]) };
  const out = draftOut({}, [
    { label: "dbt-revenue-daily", ref: "flag:f1", quote: "renamed" },
    { label: "catalog-again", ref: "https://catalog.acme.example/tables/acme-prod.finance.revenue_daily", quote: "q" },
  ]);
  const { draft } = buildProposal(out, flagEv, new Map(), parseSettings({}), NOW);
  const sources = draft.ops[0]!.after.frontmatter!.sources as { id: string; resource: string; title?: string }[];
  assert.deepEqual(sources.map((s) => [s.id, s.resource]), [
    ["dbt-revenue-daily", "https://github.example/acme/analytics/blob/main/models/finance/revenue_daily.sql"],
    ["data-catalog", "https://catalog.acme.example/tables/acme-prod.finance.revenue_daily"],
    ["dbt-revenue-daily-2", "supaknowledge://flags/f1"],
  ]);
  assert.equal(sources[0]!.title, "dbt model finance.revenue_daily");
});

test("curator update: only a real tag or review-date change is written; nothing cited new leaves frontmatter alone", () => {
  const c = revenueConcept();
  const same = buildProposal(draftOut({ tags: ["finance", "revenue", "bigquery"] }, [{ label: "dbt-revenue-daily", ref: `concept:${c.path}`, quote: "q" }]), evidence(c), new Map(), parseSettings({}), NOW);
  const a = same.draft.ops[0]!.after;
  assert.equal("tags" in a, false, "the same tags in another order are not a change");
  assert.equal("frontmatter" in a, false, "re-citing an existing footnote with the concept itself changes nothing");

  const changed = buildProposal(draftOut({ tags: ["revenue", "finance", "net-revenue"], stale_after: "2027-06-01T00:00:00Z" }, []), evidence(c), new Map(), parseSettings({}), NOW);
  const b = changed.draft.ops[0]!.after;
  assert.deepEqual(b.tags, ["revenue", "finance", "net-revenue"]);
  assert.equal(b.stale_after, "2027-06-01T00:00:00.000Z");
});
