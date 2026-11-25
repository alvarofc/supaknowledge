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

test("fetchAllPages pages by key past the max_rows cap and stops at a short page or an error", async () => {
  const rows = Array.from({ length: 2500 }, (_, i) => ({ k: i }));
  const seen: (number | null)[] = [];
  const page = (after: { k: number } | null, limit: number) => {
    seen.push(after?.k ?? null);
    const start = after ? rows.findIndex((r) => r.k > after.k) : 0;
    return Promise.resolve({ data: start < 0 ? [] : rows.slice(start, start + limit), error: null });
  };
  const all = await fetchAllPages(page);
  assert.equal(all.data.length, 2500);
  assert.deepEqual(seen, [null, 999, 1999]);
  const failing = await fetchAllPages<{ k: number }>((after) => Promise.resolve(after ? { data: null, error: { message: "boom" } } : { data: rows.slice(0, 1000), error: null }));
  assert.equal(failing.data.length, 1000);
  assert.equal(failing.error?.message, "boom");
});

test("fetchAllPages does not skip a row when an earlier row is deleted between pages", async () => {
  const rows = Array.from({ length: 6 }, (_, i) => ({ k: i }));
  let calls = 0;
  const all = await fetchAllPages<{ k: number }>((after, limit) => {
    if (calls++ === 1) rows.splice(0, 1); // a concept on page 1 is deleted before page 2 is read
    const start = after ? rows.findIndex((r) => r.k > after.k) : 0;
    return Promise.resolve({ data: start < 0 ? [] : rows.slice(start, start + limit), error: null });
  }, 2);
  assert.deepEqual(all.data.map((r) => r.k), [0, 1, 2, 3, 4, 5]);
});

test("fetchAllPages rejects page sizes that would loop forever or end early", async () => {
  const page = () => Promise.resolve({ data: [], error: null });
  for (const size of [0, -1, Number.NaN, 1.5, 1001]) await assert.rejects(fetchAllPages(page, size), RangeError, String(size));
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

test("parseSources links evidence pages only for viewers who can open them", () => {
  const doc = "11111111-2222-4333-8444-555555555555";
  const fm = { sources: [`supaknowledge://documents/${doc}`, { id: "t", resource: `supaknowledge://traces/${doc}` }, { id: "w", "x-supaknowledge-document": doc }] };
  const reader = parseSources(fm, "/w/a/s", { documents: false, traces: false });
  assert.deepEqual(reader.map((i) => i.href), [undefined, undefined, undefined]);
  assert.equal(reader[0].label, `supaknowledge://documents/${doc}`); // still shown, as text
  assert.equal(reader[1].resource, `supaknowledge://traces/${doc}`);
  const editor = parseSources(fm, "/w/a/s", { documents: true, traces: false });
  assert.deepEqual(editor.map((i) => i.href), [`/w/a/s/sources/documents/${doc}`, undefined, `/w/a/s/sources/documents/${doc}`]);
  const reviewer = parseSources(fm, "/w/a/s", { documents: true, traces: true });
  assert.equal(reviewer[1].href, `/w/a/s/activity/traces/${doc}`);
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

test("serverName includes the workspace, is unique per (workspace, space) pair, and stays short and stable", () => {
  assert.equal(serverName("acme", "main"), "supaknowledge_acme_main");
  assert.notEqual(serverName("acme", "main"), serverName("globex", "main"));
  // hyphens in either slug cannot move the boundary
  assert.notEqual(serverName("ab-c", "d"), serverName("ab", "c-d"));
  const long = serverName("a".repeat(40), "b".repeat(40));
  assert.ok(long.length <= MAX_SERVER_NAME);
  assert.match(long, /^supaknowledge-a+-[0-9a-f]{8}$/);
  assert.equal(long, serverName("a".repeat(40), "b".repeat(40)));
  assert.notEqual(long, serverName("a".repeat(40), "c".repeat(40)));
  // a shortened name is never a valid unshortened one (those start with "supaknowledge_")
  const [ws, sp] = [long.slice("supaknowledge-".length, -9), long.slice(-8)];
  assert.notEqual(serverName(ws, sp), long);
  assert.ok(serverName(ws, sp).length <= MAX_SERVER_NAME);
  // a boundary inside the kept prefix is preserved and the name stays within the cap
  const mixed = serverName("acme", "x".repeat(60));
  assert.ok(mixed.length <= MAX_SERVER_NAME && mixed.startsWith("supaknowledge-acme_x"), mixed);
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

test("mergeSettingsUpdate repairs an untouched field whose stored value is malformed", () => {
  // the page loaded the parsed settings (flag_threshold fell back to its default, 3); the user changed only the model
  const stored = { curator: { enabled: true, model: "a", flag_threshold: "lots", stuck_after_minutes: 20 }, extra: 1 };
  const parsedStored = { curator: { enabled: true, model: "a", flag_threshold: 3 } };
  const base = { curator: { enabled: true, model: "a", flag_threshold: 3 } };
  const draft = { curator: { enabled: true, model: "b", flag_threshold: 3 } };
  assert.deepEqual(mergeSettingsUpdate(stored, draft, base, parsedStored), {
    curator: { enabled: true, model: "b", flag_threshold: 3, stuck_after_minutes: 20 },
    extra: 1,
  });
  // a valid stored value another admin saved is still kept
  const other = { curator: { enabled: false, model: "a", flag_threshold: 3 } };
  assert.equal((mergeSettingsUpdate(other, draft, base, other).curator as { enabled: boolean }).enabled, false);
});
