import assert from "node:assert/strict";
import { isStripped, stripFiles } from "../strip.ts";

Deno.test("stripFiles keeps paths, encoding and metadata, drops content", () => {
  const files = [
    { path: "SKILL.md", content: "# hi", encoding: "utf8" },
    { path: "bin/tool.png", content: "iVBORw0KGgo=", encoding: "base64", content_type: "image/png" },
  ];
  const meta = new Map([
    ["SKILL.md", { size_bytes: 4, sha256: "a".repeat(64), content_type: "text/markdown" }],
    ["bin/tool.png", { size_bytes: 8, sha256: "b".repeat(64) }],
  ]);
  const out = stripFiles(files, meta);
  assert.deepEqual(out, [
    { path: "SKILL.md", encoding: "utf8", size_bytes: 4, sha256: "a".repeat(64), stripped: true, content_type: "text/markdown" },
    { path: "bin/tool.png", encoding: "base64", size_bytes: 8, sha256: "b".repeat(64), stripped: true, content_type: "image/png" },
  ]);
  assert.ok(out.every((f) => !("content" in f)));
  assert.ok(out.every(isStripped));
  assert.ok(!isStripped(files[0]));
  assert.ok(!isStripped({ path: "x", content: "y", stripped: true }), "content present = not stripped");
});

Deno.test("stripFiles refuses a file without metadata (never drops content it did not sync)", () => {
  assert.throws(() => stripFiles([{ path: "a", content: "x" }], new Map()), /no metadata for a/);
});
