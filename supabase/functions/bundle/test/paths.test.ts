import assert from "node:assert/strict";
import { isSafeFilePath } from "../paths.ts";

Deno.test("skill file paths: relative, no traversal, no backslashes, no blanks", () => {
  for (const ok of ["SKILL.md", "scripts/run.py", "a/b/c.txt", "with space.md", ".hidden", "a.b/c"]) assert.ok(isSafeFilePath(ok), ok);
  for (
    const bad of [
      "", " ", "\t", " a.md", "a.md ", "/etc/passwd", "../x", "a/../b", "a/..", "a..b", "a\\b", "..\\x", "C:\\x",
      "a//b", "a/./b", "./a", "a/", "a/ b /c", "a\u0000b", "a\nb", 5, null, undefined, "x".repeat(513),
    ]
  ) assert.equal(isSafeFilePath(bad), false, JSON.stringify(bad));
});
