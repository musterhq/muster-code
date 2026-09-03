import assert from "node:assert/strict";
import test from "node:test";
import { ApplyPatchStream } from "../src/apply-patch.js";

const BASE = ["const a = 1;", "function f() {", "  return a;", "}", ""].join("\n");

test("streams an update hunk token by token and renders the partial result each step", () => {
  const stream = new ApplyPatchStream();
  const chunks = ["*** Begin Patch\n*** Update File: src/x.js\n@@ function f() {\n", "-  return a;\n", "+  const b = a", " * 2;\n", "+  return b;\n", "*** End Patch\n"];
  const renders: string[] = [];
  for (const chunk of chunks) {
    for (const file of stream.push(chunk)) renders.push(stream.render(file, BASE));
  }
  assert.ok(renders.some((r) => r.includes("const b = a") && !r.includes("* 2")), "the partial line paints before its newline lands");
  const final = renders.at(-1)!;
  assert.equal(final, ["const a = 1;", "function f() {", "  const b = a * 2;", "  return b;", "}", ""].join("\n"));
  assert.equal(stream.files[0]!.complete, true);
});

test("add and delete files render as whole-file content / empty", () => {
  const stream = new ApplyPatchStream();
  stream.push("*** Begin Patch\n*** Add File: docs/NEW.md\n+# New\n+body\n*** Delete File: old.txt\n*** End Patch\n");
  const [added, deleted] = stream.files;
  assert.equal(stream.render(added!, ""), "# New\nbody");
  assert.equal(deleted!.op, "delete");
  assert.equal(stream.render(deleted!, "anything"), "");
});

test("unanchored hunks append instead of vanishing", () => {
  const stream = new ApplyPatchStream();
  stream.push("*** Begin Patch\n*** Update File: src/x.js\n@@ nowhere\n+// appended\n*** End Patch\n");
  assert.ok(stream.render(stream.files[0]!, BASE).endsWith("// appended\n") || stream.render(stream.files[0]!, BASE).includes("// appended"));
});
