import assert from "node:assert/strict";
import { test } from "node:test";
import { buildGraph, graphSearch, parseGraphFilters } from "../src/lib/graph.ts";
import type { GraphConcept, GraphData } from "../src/lib/graph.ts";
import {
  formatDuration,
  isEmptyRecap,
  monthLabel,
  normalizeMonth,
  recapKpis,
  recapText,
  recentMonths,
  shiftMonth,
} from "../src/lib/recap.ts";
import type { Recap } from "../src/lib/recap.ts";

const concept = (id: string, over: Partial<GraphConcept> = {}): GraphConcept => ({
  id,
  path: `p/${id}`,
  title: id.toUpperCase(),
  kind: "domain",
  status: "stable",
  trust: "human_reviewed",
  stale: false,
  stale_after: null,
  open_flags: 0,
  updated_at: "2026-11-01T00:00:00Z",
  ...over,
});

const data: GraphData = {
  concepts: [concept("a"), concept("b", { kind: "skill", open_flags: 2 }), concept("c", { stale: true })],
  truncated: false,
  links: [
    { from: "a", to: "b" },
    { from: "b", to: "a" },
    { from: "a", to: "c" },
  ],
  evidence: [
    { id: "d1", kind: "source_document", label: "Thread", proposal_id: null },
    { id: "d2", kind: "trace", label: "Run", proposal_id: null },
  ],
  citations: [
    { concept: "a", ref_kind: "source_document", ref: "d1" },
    { concept: "c", ref_kind: "trace", ref: "d2" },
    { concept: "b", ref_kind: "concept", ref: "c" },
    { concept: "a", ref_kind: "source_document", ref: "missing" },
  ],
};

test("buildGraph draws every concept, collapses a <-> b into one edge and keeps cited evidence", () => {
  const g = buildGraph(data, {});
  assert.deepEqual(g.nodes.map((n) => n.id).sort(), ["a", "b", "c", "d1", "d2"]);
  assert.equal(g.edges.filter((e) => e.kind === "link").length, 2);
  assert.equal(g.edges.filter((e) => e.kind === "cites").length, 3, "doc, trace and the concept citation; the unreadable ref is dropped");
  assert.equal(g.nodes.find((n) => n.id === "a")?.degree, 3);
});

test("buildGraph filters concepts and drops what no longer connects", () => {
  const flagged = buildGraph(data, { flagged: true });
  assert.deepEqual(flagged.nodes.map((n) => n.id), ["b"]);
  assert.equal(flagged.edges.length, 0);

  const stale = buildGraph(data, { stale: true });
  assert.deepEqual(stale.nodes.map((n) => n.id), ["c", "d2"]);

  const noEvidence = buildGraph(data, { evidence: false });
  assert.ok(noEvidence.nodes.every((n) => n.type === "concept"));
  assert.equal(noEvidence.edges.filter((e) => e.kind === "cites").length, 1, "concept-to-concept citations stay");

  assert.deepEqual(buildGraph(data, { kind: "skill" }).nodes.map((n) => n.id), ["b"]);
});

test("graph filters round-trip through the URL", () => {
  const f = parseGraphFilters({ kind: "skill", flagged: "1", stale: "nope", evidence: "0" });
  assert.deepEqual(f, { kind: "skill", flagged: true, stale: undefined, evidence: false });
  assert.equal(graphSearch(f, { view: "list" }), "?kind=skill&flagged=1&evidence=0&view=list");
  assert.equal(parseGraphFilters({ kind: "bogus" }).kind, undefined);
  assert.equal(graphSearch({}), "");
});

test("month helpers clamp, shift and label months in UTC", () => {
  const now = new Date("2026-11-27T12:00:00Z");
  assert.equal(normalizeMonth("2026-10", now), "2026-10");
  assert.equal(normalizeMonth("2027-01", now), "2026-11", "future months fall back to the current one");
  assert.equal(normalizeMonth("2026-13", now), "2026-11");
  assert.equal(normalizeMonth(undefined, now), "2026-11");
  assert.equal(shiftMonth("2026-01", -1), "2025-12");
  assert.equal(shiftMonth("2026-12", 1), "2027-01");
  assert.equal(monthLabel("2026-11"), "November 2026");
  assert.deepEqual(recentMonths("2026-02", 3), ["2026-02", "2026-01", "2025-12"]);
});

test("formatDuration picks a readable unit", () => {
  assert.equal(formatDuration(45 * 60), "45 min");
  assert.equal(formatDuration(5 * 3600), "5 hours");
  assert.equal(formatDuration(3600), "1 hour");
  assert.equal(formatDuration(3.1 * 86400), "3.1 days");
  assert.equal(formatDuration(12 * 86400), "12 days");
});

const recap: Recap = {
  month: "2026-11",
  spaces: 1,
  concepts_added: 4,
  concepts_changed: 7,
  revisions: 15,
  most_corrected: { path: "metrics/arr", title: "ARR", kind: "domain", space_slug: "revenue", space_name: "Revenue", n: 3 },
  applied_by_people: 5,
  applied_by_agents: 0,
  applied_by_policy: 2,
  flags_raised: 9,
  flags_fixed: 6,
  top_flagger: { display_name: "support-bot", kind: "agent", n: 4 },
  median_fix_seconds: 2 * 86400,
  went_stale: 3,
  stale_fixed: 2,
};

test("recapKpis names each measure and keeps context to one fact", () => {
  const kpis = recapKpis(recap);
  const byKey = Object.fromEntries(kpis.map((k) => [k.key, k]));
  assert.equal(byKey.corrected.value, "ARR");
  assert.equal(byKey.corrected.context, "3 changes");
  assert.deepEqual(byKey.corrected.concept, { space_slug: "revenue", path: "metrics/arr" });
  assert.equal(byKey.flagger.value, "support-bot");
  assert.equal(byKey.median.value, "2 days");
  assert.equal(byKey.stale.context, "2 fixed by month end");
  assert.equal(byKey.people.context, undefined, "no agent reviewers, no context");
  assert.ok(kpis.every((k) => !k.context?.includes("·")));
});

test("recapKpis shows empty values instead of invented numbers", () => {
  const empty: Recap = { ...recap, most_corrected: null, top_flagger: null, median_fix_seconds: null, flags_fixed: 0 };
  const byKey = Object.fromEntries(recapKpis(empty).map((k) => [k.key, k]));
  assert.equal(byKey.corrected.empty, true);
  assert.equal(byKey.flagger.value, "None");
  assert.equal(byKey.median.value, "None");
});

test("recapText is Slack-ready and says so when the month is empty", () => {
  const text = recapText(recap, "Revenue");
  assert.match(text, /^\*Knowledge recap: Revenue, November 2026\*/);
  assert.match(text, /• Most corrected concept: ARR \(3 changes\)/);
  const none: Recap = {
    ...recap,
    concepts_added: 0,
    concepts_changed: 0,
    revisions: 0,
    most_corrected: null,
    applied_by_people: 0,
    applied_by_policy: 0,
    flags_raised: 0,
    flags_fixed: 0,
    top_flagger: null,
    median_fix_seconds: null,
    went_stale: 0,
    stale_fixed: 0,
  };
  assert.equal(isEmptyRecap(none), true);
  assert.equal(recapText(none, "Revenue").split("\n").length, 2);
});
