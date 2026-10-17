#!/usr/bin/env node
// Parity guard between the official TypeScript compiler (`tsc`) and `tsc-rs`, the Rust port we typecheck with.
// Both run with --noEmit --pretty false; the sorted "file(line,col): error TSnnnn: message" lines must be identical.
// The official `tsc` is the reference: if the two differ, or either one fails without printing diagnostics, this exits 1.
//
// Usage:
//   node scripts/typecheck-parity.mjs                    # check packages/agent-app and packages/server
//   node scripts/typecheck-parity.mjs --dir <path> ...   # check specific project directories
//   node scripts/typecheck-parity.mjs --compare <tsc-output.txt> <tsc-rs-output.txt>   # compare saved outputs
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DIAGNOSTIC = /^(.+?)\((\d+),(\d+)\): (error|warning) (TS\d+): (.*)$/;

/** Diagnostic lines from compiler output, normalised and sorted. Continuation lines are folded into their diagnostic. */
export function parseDiagnostics(output) {
  const lines = [];
  for (const raw of String(output).replace(/\r\n/g, "\n").split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (DIAGNOSTIC.test(line)) lines.push(line.replace(/\\/g, "/").replace(/^(\.\/)+/, ""));
    else if (lines.length && /^\s+\S/.test(raw)) lines[lines.length - 1] += `\n${line}`;
  }
  return lines.sort();
}

/** `{ same, onlyInReference, onlyInCandidate }` for two sorted diagnostic lists (multiset difference). */
export function compareDiagnostics(reference, candidate) {
  const counts = new Map();
  for (const line of reference) counts.set(line, (counts.get(line) ?? 0) + 1);
  const onlyInCandidate = [];
  for (const line of candidate) {
    const n = counts.get(line) ?? 0;
    if (n > 0) counts.set(line, n - 1);
    else onlyInCandidate.push(line);
  }
  const onlyInReference = [];
  for (const [line, n] of counts) for (let i = 0; i < n; i++) onlyInReference.push(line);
  onlyInReference.sort();
  return { same: !onlyInReference.length && !onlyInCandidate.length, onlyInReference, onlyInCandidate };
}

function run(bin, cwd) {
  const result = spawnSync(join(cwd, "node_modules", ".bin", bin), ["--noEmit", "--pretty", "false"], {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  if (result.error) throw new Error(`could not run ${bin} in ${cwd}: ${result.error.message}`);
  return { status: result.status, output: `${result.stdout ?? ""}\n${result.stderr ?? ""}` };
}

/** Compares two checkers' results. Returns report lines; empty means parity. */
export function parityProblems(label, reference, candidate) {
  const ref = parseDiagnostics(reference.output);
  const cand = parseDiagnostics(candidate.output);
  const problems = [];
  const diff = compareDiagnostics(ref, cand);
  for (const line of diff.onlyInReference) problems.push(`${label}: only tsc reported:    ${line}`);
  for (const line of diff.onlyInCandidate) problems.push(`${label}: only tsc-rs reported: ${line}`);
  if (reference.status !== undefined && candidate.status !== undefined) {
    if (ref.length === 0 && reference.status !== 0) problems.push(`${label}: tsc exited ${reference.status} without diagnostics`);
    if (cand.length === 0 && candidate.status !== 0) problems.push(`${label}: tsc-rs exited ${candidate.status} without diagnostics`);
    if ((reference.status === 0) !== (candidate.status === 0)) problems.push(`${label}: exit status differs (tsc ${reference.status}, tsc-rs ${candidate.status})`);
  }
  return problems;
}

function main(argv) {
  const here = dirname(fileURLToPath(import.meta.url));
  if (argv[0] === "--compare") {
    if (argv.length !== 3) throw new Error("usage: --compare <tsc-output.txt> <tsc-rs-output.txt>");
    const problems = parityProblems("compare", { output: readFileSync(argv[1], "utf8") }, { output: readFileSync(argv[2], "utf8") });
    return report(problems, 1);
  }
  const dirs = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--dir") dirs.push(resolve(argv[++i]));
  if (!dirs.length) dirs.push(resolve(here, ".."), resolve(here, "..", "..", "server"));
  const problems = [];
  for (const dir of dirs) {
    const reference = run("tsc", dir);
    const candidate = run("tsc-rs", dir);
    const found = parityProblems(dir, reference, candidate);
    problems.push(...found);
    console.log(`${dir}: tsc ${parseDiagnostics(reference.output).length} diagnostics, tsc-rs ${parseDiagnostics(candidate.output).length}${found.length ? " (MISMATCH)" : ""}`);
  }
  return report(problems, dirs.length);
}

function report(problems, checked) {
  if (problems.length) {
    console.error(`typecheck parity FAILED:\n${problems.join("\n")}`);
    return 1;
  }
  console.log(`typecheck parity OK (${checked} project${checked === 1 ? "" : "s"})`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
