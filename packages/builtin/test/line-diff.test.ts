import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDiff, applyHunk } from "../src/line-diff.js";

test("identical inputs produce no hunks", () => {
  assert.deepEqual(lineDiff(["a", "b"], ["a", "b"]), []);
});

test("a replaced line is one hunk with the removed text", () => {
  const hunks = lineDiff(["a", "b", "c"], ["a", "B", "c"]);
  assert.deepEqual(hunks, [{ baseStart: 1, baseCount: 1, targetStart: 1, targetCount: 1, removed: ["b"] }]);
});

test("insertions and deletions at both ends, and a mixed middle", () => {
  const base = ["import x", "", "fn a", "old1", "old2", "end"];
  const target = ["use client", "import x", "", "fn a", "new1", "end", "trailer"];
  const hunks = lineDiff(base, target);
  assert.deepEqual(hunks.map((h) => [h.baseStart, h.baseCount, h.targetStart, h.targetCount, h.removed]), [
    [0, 0, 0, 1, []],
    [3, 2, 4, 1, ["old1", "old2"]],
    [6, 0, 6, 1, []],
  ]);
  // Accepting every hunk from the bottom up reproduces the target exactly.
  let lines = [...base];
  for (const hunk of [...hunks].reverse()) lines = applyHunk(lines, target, hunk);
  assert.deepEqual(lines, target);
});

test("a streaming partial line diffs as an added line that keeps growing", () => {
  const base = ["a", "b"];
  assert.deepEqual(lineDiff(base, ["a", "b", "con"])[0]?.targetCount, 1);
  assert.deepEqual(lineDiff(base, ["a", "b", "const x = 1;"])[0]?.targetCount, 1);
  assert.deepEqual(lineDiff(base, ["a", "b", "const x = 1;", ""])[0]?.targetCount, 2);
});

test("large unrelated inputs fall back without exploding", () => {
  const base = Array.from({ length: 3000 }, (_, i) => `b${i}`);
  const target = Array.from({ length: 3000 }, (_, i) => `t${i}`);
  const hunks = lineDiff(base, target);
  assert.equal(hunks.length, 1);
  assert.equal(hunks[0]?.removed.length, 3000);
});
