import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
// @ts-expect-error plain .mjs script without type declarations
import { compareDiagnostics, parseDiagnostics } from "../scripts/typecheck-parity.mjs";

const script = join(import.meta.dirname, "..", "scripts", "typecheck-parity.mjs");

const TSC = [
  "src/b.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "src/a.ts(10,1): error TS2304: Cannot find name 'foo'.",
  "",
].join("\n");
// Same diagnostics, different order, CRLF and a ./ prefix: still parity.
const TSC_RS_SAME = [
  "./src/a.ts(10,1): error TS2304: Cannot find name 'foo'.",
  "src/b.ts(3,5): error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
].join("\r\n");
const TSC_RS_DIFFERENT = [
  "src/a.ts(10,1): error TS2304: Cannot find name 'foo'.",
  "src/b.ts(3,6): error TS2322: Type 'string' is not assignable to type 'number'.",
  "",
].join("\n");

function compareFiles(reference: string, candidate: string) {
  const dir = mkdtempSync(join(tmpdir(), "typecheck-parity-"));
  writeFileSync(join(dir, "tsc.txt"), reference);
  writeFileSync(join(dir, "tsc-rs.txt"), candidate);
  return spawnSync(process.execPath, [script, "--compare", join(dir, "tsc.txt"), join(dir, "tsc-rs.txt")], { encoding: "utf8" });
}

test("matching diagnostics pass", () => {
  const result = compareFiles(TSC, TSC_RS_SAME);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /parity OK/);
});

test("two clean runs pass", () => {
  assert.equal(compareFiles("", "").status, 0);
});

test("differing diagnostics fail and name both sides", () => {
  const result = compareFiles(TSC, TSC_RS_DIFFERENT);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /only tsc reported:.*src\/b\.ts\(3,5\)/);
  assert.match(result.stderr, /only tsc-rs reported:.*src\/b\.ts\(3,6\)/);
});

test("a missing diagnostic fails", () => {
  assert.equal(compareFiles(TSC, "").status, 1);
});

test("duplicate diagnostics are counted", () => {
  const line = "src/a.ts(1,1): error TS1005: ';' expected.";
  const diff = compareDiagnostics(parseDiagnostics(`${line}\n${line}`), parseDiagnostics(line));
  assert.equal(diff.same, false);
  assert.deepEqual(diff.onlyInReference, [line]);
});
