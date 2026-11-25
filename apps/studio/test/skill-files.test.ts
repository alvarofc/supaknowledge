import assert from "node:assert/strict";
import { test } from "node:test";
import { formatBytes, skillFiles, syncFilesErrorMessage } from "../src/lib/skill-files.ts";

test("skillFiles lists inline files with computed sizes", () => {
  const files = skillFiles({
    files: [
      { path: "scripts/run.py", content: "print('hé')", encoding: "utf8" },
      { path: "assets/logo.png", content: "iVBORw0KGgo=", encoding: "base64" },
    ],
  });
  assert.deepEqual(files, [
    { path: "assets/logo.png", size: 8, stripped: false },
    { path: "scripts/run.py", size: 12, stripped: false },
  ]);
});

test("skillFiles handles stripped (synced) files without content", () => {
  const files = skillFiles({
    body: "x",
    files: [{ path: "reference.md", encoding: "utf8", size_bytes: 2048, sha256: "ab".repeat(32), stripped: true }],
  });
  assert.deepEqual(files, [{ path: "reference.md", size: 2048, stripped: true }]);
});

test("skillFiles never throws on odd payloads", () => {
  for (const after of [null, undefined, 1, "x", [], {}, { files: "nope" }, { files: [null, 1, { content: "no path" }, { path: "" }] }]) {
    assert.deepEqual(skillFiles(after), []);
  }
  assert.deepEqual(skillFiles({ files: [{ path: "a.md" }] }), [{ path: "a.md", size: null, stripped: false }]);
});

test("formatBytes", () => {
  assert.equal(formatBytes(12), "12 B");
  assert.equal(formatBytes(2048), "2.0 KB");
  assert.equal(formatBytes(50 * 1024), "50 KB");
  assert.equal(formatBytes(3 * 1024 * 1024), "3.0 MB");
});

test("syncFilesErrorMessage explains 403 (reviewer/admin, no OAuth tokens) and 401", () => {
  // same shape as FunctionError (src/lib/functions.ts, which needs the browser env)
  class FunctionError extends Error {
    status: number;
    constructor(message: string, status: number) {
      super(message);
      this.status = status;
    }
  }
  assert.match(syncFilesErrorMessage(new FunctionError("space reviewer or admin required to sync proposal files", 403)), /reviewer or admin of this space/);
  assert.match(syncFilesErrorMessage(new FunctionError("expired", 401)), /session expired/);
  assert.equal(syncFilesErrorMessage(new FunctionError("storage down", 500)), "storage down");
  assert.equal(syncFilesErrorMessage(null), "something went wrong");
});
