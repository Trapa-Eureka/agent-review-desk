import { test } from "node:test";
import assert from "node:assert/strict";
import { diffFromTexts, diffStats, formatDuration, parseUnifiedDiff } from "./view.js";

const PATCH = `diff --git a/a.txt b/a.txt
index 111..222 100644
--- a/a.txt
+++ b/a.txt
@@ -1,3 +1,3 @@
 keep
-old line
+new line
 tail
\\ No newline at end of file
`;

test("parseUnifiedDiff separates headers, hunks and changed lines", () => {
  const lines = parseUnifiedDiff(PATCH);
  assert.deepEqual(lines.map((l) => l.kind), ["meta", "meta", "meta", "meta", "hunk", "ctx", "del", "add", "ctx", "meta"]);
  assert.deepEqual(lines.filter((l) => l.kind === "add" || l.kind === "del").map((l) => [l.kind, l.text]), [["del", "old line"], ["add", "new line"]]);
  assert.deepEqual(diffStats(lines), { added: 1, removed: 1 });
});

test("parseUnifiedDiff treats a '+++ ' line inside a hunk as content, not a header", () => {
  const lines = parseUnifiedDiff("@@ -1 +1 @@\n-a\n+++ b\n");
  assert.deepEqual(lines.map((l) => [l.kind, l.text]), [["hunk", "@@ -1 +1 @@"], ["del", "a"], ["add", "++ b"]]);
});

test("parseUnifiedDiff copes with empty input and CRLF", () => {
  assert.deepEqual(parseUnifiedDiff(""), []);
  assert.deepEqual(parseUnifiedDiff("@@ -1 +1 @@\r\n-a\r\n+b\r\n").map((l) => l.kind), ["hunk", "del", "add"]);
});

test("diffFromTexts keeps unchanged lines as context", () => {
  const lines = diffFromTexts("a\nb\nc", "a\nB\nc");
  assert.deepEqual(lines.map((l) => [l.kind, l.text]), [["ctx", "a"], ["del", "b"], ["add", "B"], ["ctx", "c"]]);
});

test("diffFromTexts handles creation, deletion and missing sides", () => {
  assert.deepEqual(diffFromTexts(undefined, "x\ny").map((l) => l.kind), ["add", "add"]);
  assert.deepEqual(diffFromTexts("x\ny", undefined).map((l) => l.kind), ["del", "del"]);
  assert.deepEqual(diffFromTexts(undefined, undefined), []);
  assert.deepEqual(diffStats(diffFromTexts("same", "same")), { added: 0, removed: 0 });
});

test("diffFromTexts falls back to remove-all/add-all for very large inputs", () => {
  const big = Array.from({ length: 500 }, (_, i) => `line ${i}`).join("\n");
  const lines = diffFromTexts(big, `${big}\nextra`);
  assert.equal(lines.filter((l) => l.kind === "ctx").length, 0);
  assert.equal(lines.filter((l) => l.kind === "del").length, 500);
  assert.equal(lines.filter((l) => l.kind === "add").length, 501);
});

test("formatDuration", () => {
  assert.equal(formatDuration(340), "340ms");
  assert.equal(formatDuration(12_000), "12s");
  assert.equal(formatDuration(65_000), "1m 05s");
  assert.equal(formatDuration(3_900_000), "1h 05m");
  assert.equal(formatDuration(-1), "");
  assert.equal(formatDuration(Number.NaN), "");
});
