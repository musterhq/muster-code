import { test } from "node:test";
import assert from "node:assert/strict";
import { parseUnifiedDiff, reverseApply } from "../src/unified-diff.js";

test("parses files and hunks, reverse-applies to recover the original", () => {
  const before = "a\nb\nc\nd\n";
  const after = "a\nB\nc\nd\nnew\n";
  const diff = `diff --git a/x.txt b/x.txt\n--- a/x.txt\n+++ b/x.txt\n@@ -1,4 +1,5 @@\n a\n-b\n+B\n c\n d\n+new\n`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files.length, 1);
  assert.equal(files[0]!.path, "x.txt");
  assert.equal(reverseApply(after, files[0]!), before);
});

test("new files reverse to empty; hunks after earlier insertions still anchor", () => {
  const diff = `--- /dev/null\n+++ b/n.txt\n@@ -0,0 +1,2 @@\n+one\n+two\n`;
  const files = parseUnifiedDiff(diff);
  assert.equal(files[0]!.oldPath, null);
  assert.equal(reverseApply("one\ntwo\n", files[0]!), "");
  const two = `--- a/y\n+++ b/y\n@@ -1,2 +1,3 @@\n+top\n a\n b\n@@ -5,2 +6,2 @@\n e\n-f\n+F\n`;
  const after = "top\na\nb\nc\nd\ne\nF\n";
  assert.equal(reverseApply(after, parseUnifiedDiff(two)[0]!), "a\nb\nc\nd\ne\nf\n");
});
