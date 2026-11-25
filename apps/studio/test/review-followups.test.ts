import assert from "node:assert/strict";
import { test } from "node:test";
import { validateConceptPath } from "../src/components/knowledge/paths.ts";
import { nextRadioIndex, radioTabIndex } from "../src/components/ui/radio-group.ts";
import { conceptFile, resolveConceptHref } from "../src/lib/concept-links.ts";
import { MAX_SERVER_NAME, serverName } from "../src/lib/mcp-name.ts";
import { parseSources } from "../src/lib/okf-sources.ts";
import { fetchAllPages } from "../src/lib/paginate.ts";
import { mergeSettingsUpdate } from "../src/lib/settings-form.ts";

test("validateConceptPath rejects empty and '.' segments", () => {
  for (const p of ["metrics//arr", "metrics/./arr", "./arr", "metrics/.", "metrics/arr/"]) assert.ok(validateConceptPath(p), p);
  for (const p of ["metrics/arr", "skills/revenue-report", "data/v1.2/orders", "a/.hidden"]) assert.equal(validateConceptPath(p), null, p);
});

test("fetchAllPages reads past the max_rows cap and stops at a short page or an error", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => i);
  const ranges: [number, number][] = [];
  const all = await fetchAllPages((from, to) => {
    ranges.push([from, to]);
    return Promise.resolve({ data: rows.slice(from, to + 1), error: null });
  });
  assert.equal(all.data.length, 2500);
  assert.deepEqual(ranges, [[0, 999], [1000, 1999], [2000, 2999]]);
  const failing = await fetchAllPages((from) => Promise.resolve(from ? { data: null, error: { message: "boom" } } : { data: rows.slice(0, 1000), error: null }));
  assert.equal(failing.data.length, 1000);
  assert.equal(failing.error?.message, "boom");
});

test("parseSources keeps author, last_modified and supaknowledge:// resources", () => {
  const doc = "11111111-2222-4333-8444-555555555555";
  const items = parseSources(
    {
      sources: [
        { id: "doc-1", resource: `supaknowledge://documents/${doc}`, title: "Pricing notes", author: "ana@acme.test", last_modified: "2026-11-01T00:00:00Z" },
        { id: "flag-1", resource: "supaknowledge://flags/abc" },
        { id: "web", resource: "https://handbook.acme.example/x", "x-supaknowledge-document": doc },
      ],
    },
    "/w/acme/finance",
  );
  assert.deepEqual(items[0], {
    label: "Pricing notes",
    url: undefined,
    href: `/w/acme/finance/sources/documents/${doc}`,
    resource: `supaknowledge://documents/${doc}`,
    detail: "by ana@acme.test · modified 2026-11-01T00:00:00Z",
  });
  assert.equal(items[1].resource, "supaknowledge://flags/abc");
  assert.equal(items[1].href, undefined);
  assert.equal(items[2].url, "https://handbook.acme.example/x");
  assert.equal(items[2].href, undefined);
});

test("resolveConceptHref drops ?query and resolves skill links from the skill's directory", () => {
  const kb = "/w/a/s/knowledge";
  assert.equal(resolveConceptHref("arr.md?x=1#def", "metrics/nrr", kb), `${kb}/metrics/arr#def`);
  const skill = conceptFile("skills/revenue-report", "skill");
  assert.equal(skill, "skills/revenue-report/SKILL");
  assert.equal(resolveConceptHref("../other/SKILL.md", skill, kb), `${kb}/skills/other`);
  assert.equal(resolveConceptHref("../../metrics/arr.md", skill, kb), `${kb}/metrics/arr`);
  assert.equal(resolveConceptHref("/policies/report-formatting.md", skill, kb), `${kb}/policies/report-formatting`);
  assert.equal(resolveConceptHref("../../../x.md", skill, kb), null);
  assert.equal(resolveConceptHref("https://x.test", skill, kb), null);
  assert.equal(conceptFile("metrics/arr", "domain"), "metrics/arr");
});

test("serverName includes the workspace and stays short and stable", () => {
  assert.equal(serverName("acme", "main"), "supaknowledge-acme-main");
  assert.notEqual(serverName("acme", "main"), serverName("globex", "main"));
  const long = serverName("a".repeat(40), "b".repeat(40));
  assert.ok(long.length <= MAX_SERVER_NAME);
  assert.match(long, /^supaknowledge-a+-[0-9a-f]{8}$/);
  assert.equal(long, serverName("a".repeat(40), "b".repeat(40)));
  assert.notEqual(long, serverName("a".repeat(40), "c".repeat(40)));
});

test("radio group keys move and wrap; only the checked option is tabbable", () => {
  assert.equal(nextRadioIndex("ArrowRight", 2, 3), 0);
  assert.equal(nextRadioIndex("ArrowLeft", 0, 3), 2);
  assert.equal(nextRadioIndex("ArrowDown", -1, 3), 0);
  assert.equal(nextRadioIndex("End", 0, 3), 2);
  assert.equal(nextRadioIndex("Enter", 0, 3), null);
  assert.deepEqual([0, 1, 2].map((i) => radioTabIndex(i, 1)), [-1, 0, -1]);
  assert.deepEqual([0, 1, 2].map((i) => radioTabIndex(i, -1)), [0, -1, -1]);
});

test("mergeSettingsUpdate keeps unknown keys and other admins' changes to untouched fields", () => {
  const base = { curator: { enabled: true, model: "a", flag_threshold: 3 }, retention: { trace_days: 30 } };
  const stored = { curator: { enabled: true, model: "b", flag_threshold: 3, stuck_after_minutes: 20 }, retention: { trace_days: 30 }, extra: 1 };
  const draft = { curator: { enabled: true, model: "a", flag_threshold: 5 }, retention: { trace_days: 30 } };
  assert.deepEqual(mergeSettingsUpdate(stored, draft, base), {
    curator: { enabled: true, model: "b", flag_threshold: 5, stuck_after_minutes: 20 },
    retention: { trace_days: 30 },
    extra: 1,
  });
  // without a base every draft field is written
  assert.equal((mergeSettingsUpdate(stored, draft).curator as { model: string }).model, "a");
  // a field missing from the stored document is written even when unchanged
  assert.deepEqual(mergeSettingsUpdate({}, draft, base), draft);
});
