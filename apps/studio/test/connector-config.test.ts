import assert from "node:assert/strict";
import { test } from "node:test";
import { configSummary, configToDraft, draftToConfig } from "../src/components/sources/connector-config.ts";

test("github form writes `ref` (what the connector reads) and reads the legacy `branch` key", () => {
  const draft = configToDraft("github", { repo: "acme/handbook", branch: "release" });
  assert.equal(draft.ref, "release");
  const { config, errors } = draftToConfig("github", draft, { repo: "acme/handbook", branch: "release", include_issues: true });
  assert.deepEqual(errors, {});
  assert.equal(config.ref, "release");
  assert.equal("branch" in config, false);
  assert.equal(config.include_issues, true, "unknown keys are preserved");
  assert.equal(configSummary("github", { repo: "acme/handbook", branch: "dev" }), "acme/handbook@dev");
  assert.equal(configSummary("github", { repo: "acme/handbook", ref: "v2" }), "acme/handbook@v2");
});

test("web form writes follow_links / sitemap / max_pages / same_origin_only", () => {
  const draft = configToDraft("web", {});
  assert.equal(draft.follow_links, "false");
  assert.equal(draft.same_origin_only, "true", "connector default");
  const { config, errors } = draftToConfig("web", {
    ...draft,
    urls: "https://docs.example.com/",
    sitemap: "https://docs.example.com/sitemap.xml",
    follow_links: "true",
    max_pages: "200",
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(config, {
    urls: ["https://docs.example.com/"],
    sitemap: "https://docs.example.com/sitemap.xml",
    follow_links: true,
    same_origin_only: true,
    max_pages: 200,
  });
});

test("web form translates and drops the legacy crawl_depth key", () => {
  assert.equal(configToDraft("web", { urls: ["https://a.example/"], crawl_depth: 1 }).follow_links, "true");
  assert.equal(configToDraft("web", { urls: ["https://a.example/"], crawl_depth: 0 }).follow_links, "false");
  const prev = { urls: ["https://a.example/"], crawl_depth: 2 };
  const { config } = draftToConfig("web", configToDraft("web", prev), prev);
  assert.equal(config.follow_links, true);
  assert.equal("crawl_depth" in config, false);
});

test("web form validation", () => {
  const base = configToDraft("web", {});
  assert.ok(draftToConfig("web", base).errors.urls, "needs urls or a sitemap");
  assert.deepEqual(draftToConfig("web", { ...base, sitemap: "https://a.example/sitemap.xml" }).errors, {});
  assert.ok(draftToConfig("web", { ...base, urls: "ftp://a.example" }).errors.urls);
  assert.ok(draftToConfig("web", { ...base, urls: "https://a.example", max_pages: "5000" }).errors.max_pages);
  assert.ok(draftToConfig("web", { ...base, urls: "https://a.example", max_pages: "0" }).errors.max_pages);
});

test("URL and glob lists split on newlines only (commas are part of the value); ID lists also take commas", () => {
  const { config, errors } = draftToConfig("web", {
    ...configToDraft("web", {}),
    urls: "https://example.com/search?q=a,b\nhttps://example.com/x",
  });
  assert.deepEqual(errors, {});
  assert.deepEqual(config.urls, ["https://example.com/search?q=a,b", "https://example.com/x"]);
  const gh = draftToConfig("github", { repo: "acme/handbook", paths: "docs/{a,b}/**\nREADME.md" });
  assert.deepEqual(gh.config.paths, ["docs/{a,b}/**", "README.md"]);
  const slack = draftToConfig("slack", { channels: "C1, C2\nC3" });
  assert.deepEqual(slack.config.channels, ["C1", "C2", "C3"]);
});

test("schema sources: project ref required, schemas optional plain names", () => {
  const empty = draftToConfig("schema", configToDraft("schema", {}));
  assert.equal(empty.errors.project_ref, "Project ref is required");
  const ok = draftToConfig("schema", { project_ref: "abcdefghijklmnopqrst", schemas: "public, billing" });
  assert.deepEqual(ok.errors, {});
  assert.deepEqual(ok.config, { project_ref: "abcdefghijklmnopqrst", schemas: ["public", "billing"] });
  assert.ok(draftToConfig("schema", { project_ref: "abcdefghijklmnopqrst", schemas: "public; drop" }).errors.schemas);
  assert.ok(draftToConfig("schema", { project_ref: "https://evil.example/" }).errors.project_ref);
  assert.equal(configSummary("schema", ok.config), "Project abcdefghijklmnopqrst");
});
