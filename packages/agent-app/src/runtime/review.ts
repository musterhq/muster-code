// Agent Mode review host — full-file change data scoped to the selected
// source root. The legacy host below (git.changes / git.diff) is read-only. Baseline is HEAD; untracked files are included and
// deletions/renames are honored. Serves the renderer's review messages with
// full before/after content so it can render real inline/split diffs.
// It never writes; rejects path escapes and symlinks that resolve outside the
// root; bounds per-file text and the change-list length. Git is invoked via
// execFile (no shell) with NUL-delimited output so odd filenames survive.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { REVIEW_REF_PATTERN, type ReviewBaseline, type ReviewChange, type ReviewChanges, type ReviewFileDiff, type ReviewWriteResult } from "../shared/domains/review-protocol.ts";
import { applyHunk, computeHunks, relocateReverse, reverseHunk } from "../shared/review-hunks.ts";
import { serial } from "./git-local.ts";
import { resolveInside } from './paths.ts';
import { EMPTY_TREE, indexTree, isGitWorkTree, snapshotTree } from "./review-baseline.ts";

export interface ReviewFileEntry {
  readonly path: string; // root-relative, "/"-separated (as git reports)
  readonly previousPath?: string; // set for renames/copies
  readonly status: string; // added | modified | deleted | renamed | copied | untracked | …
  readonly adds: number;
  readonly dels: number;
  /** For an untracked file inside a fully-untracked directory: that directory (git's `?? dir/` root, with a
   *  trailing '/'). Absent for untracked files git reports individually. The Changes pane groups by it. */
  readonly untrackedRoot?: string;
}

/** Host -> renderer payload (the `reviewFiles` message body). */
export interface ReviewFilesUpdate {
  readonly type: "reviewFiles";
  readonly root: string;
  readonly files: readonly ReviewFileEntry[];
  readonly error?: string;
}

/** Host -> renderer payload (the `reviewFile` message body). */
export interface ReviewFileUpdate {
  readonly type: "reviewFile";
  readonly root: string;
  readonly path: string;
  readonly before: string;
  readonly after: string;
  readonly truncated: boolean;
  readonly error?: string;
}

const MAX_SIDE_BYTES = 512 * 1024; // before + after together stay within 1 MiB
const MAX_FILES = 500;
const GIT_BUFFER = 16 * 1024 * 1024;
const GIT_TIMEOUT_MS = 10_000;

const STATUS_NAMES: Record<string, string> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "copied",
  T: "modified",
  U: "conflicted",
};

export interface GitResult {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Run git with argv (never a shell) and buffered binary output. Errors are
 * reported via `ok`/`stderr`; stderr is the only text ever surfaced to the
 * user, so environment values cannot leak through messages.
 */
export function git(root: string, args: readonly string[], options: {env?: Record<string, string>; input?: Buffer | string; timeoutMs?: number} = {}): Promise<GitResult> {
  const { promise, resolve: settle } = Promise.withResolvers<GitResult>();
  const child = execFile(
    "git",
    ["--literal-pathspecs", "-C", root, ...args],
    { maxBuffer: GIT_BUFFER, encoding: "buffer", timeout: options.timeoutMs ?? GIT_TIMEOUT_MS, killSignal: "SIGKILL", env: { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", ...options.env } },
    (error, stdout, stderr) => {
      settle({ ok: !error, stdout, stderr: stderr.toString("utf8").split("\n")[0] ?? "" });
    },
  );
  if (options.input !== undefined) child.stdin?.end(options.input); else child.stdin?.end();
  return promise;
}

/**
 * Resolve an untrusted root-relative path inside `root`, following symlinks,
 * and refuse anything that lands outside the real root. Nonexistent paths
 * (deleted files) pass the lexical check only. Returns the absolute path.
 */
async function readPrefix(path: string): Promise<Buffer> {
  const handle = await fs.open(path,'r');
  try {
    if (!(await handle.stat()).isFile()) throw new Error('Not a regular file.');
    const buffer = Buffer.alloc(MAX_SIDE_BYTES + 1);
    const {bytesRead} = await handle.read(buffer,0,buffer.length,0);
    return buffer.subarray(0,bytesRead);
  } finally {await handle.close();}
}

function looksBinary(buffer: Buffer): boolean {
  return buffer.subarray(0, 8192).includes(0);
}

function countLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = 0;
  for (const byte of buffer) if (byte === 10) lines++;
  if (buffer[buffer.length - 1] !== 10) lines++;
  return lines;
}

/** Split NUL-delimited git output into fields, dropping the trailing empty one. */
function nulFields(stdout: Buffer): string[] {
  const text = stdout.toString("utf8");
  return text.length === 0 ? [] : text.split("\0").filter((field, index, all) => field.length > 0 || index < all.length - 1);
}

/** Parse `git diff -z -M --name-status` output into path -> {status, previousPath}. */
function parseNameStatus(stdout: Buffer): Map<string, { status: string; previousPath?: string }> {
  const fields = nulFields(stdout);
  const entries = new Map<string, { status: string; previousPath?: string }>();
  for (let index = 0; index < fields.length; ) {
    const code = fields[index][0];
    if (code === "R" || code === "C") {
      const previousPath = fields[index + 1];
      entries.set(fields[index + 2], { status: STATUS_NAMES[code], previousPath });
      index += 3;
    } else {
      entries.set(fields[index + 1], { status: STATUS_NAMES[code] ?? "modified" });
      index += 2;
    }
  }
  return entries;
}

/** Parse `git diff -z -M --numstat` output into path -> {adds, dels}. Binary files report `-` and become 0/0. */
function parseNumstat(stdout: Buffer): Map<string, { adds: number; dels: number }> {
  const fields = nulFields(stdout);
  const entries = new Map<string, { adds: number; dels: number }>();
  for (let index = 0; index < fields.length; ) {
    const [adds, dels, ...pathParts] = fields[index].split("\t");
    const inlinePath = pathParts.join('\t');
    const counts = { adds: Number(adds) || 0, dels: Number(dels) || 0 };
    if (inlinePath !== undefined && inlinePath.length > 0) {
      entries.set(inlinePath, counts);
      index += 1;
    } else {
      // Rename/copy: counts field is followed by old path then new path.
      entries.set(fields[index + 2], counts);
      index += 3;
    }
  }
  return entries;
}

/** Count added lines of an untracked file without unbounded reads. */
async function untrackedAdds(root: string, rel: string): Promise<number> {
  try {
    const abs = await resolveInside(root, rel);
    const stat = await fs.lstat(abs);
    if (!stat.isFile() || stat.size > MAX_SIDE_BYTES) return 0;
    const buffer = await readPrefix(abs);
    return looksBinary(buffer) ? 0 : countLines(buffer);
  } catch {
    return 0;
  }
}

/**
 * The review host: pure request -> update payloads. `root` is the trusted
 * selected source root (absolute); `path` values come from the renderer and
 * are untrusted.
 */
export class AgentModeReviewHost {
  constructor(private readonly rootOf: () => string | undefined) {}

  async listChanges(): Promise<ReviewFilesUpdate> {
    const root = this.rootOf();
    if (!root) return { type: "reviewFiles", root: "", files: [], error: "Select a source folder first." };
    const inside = await git(root, ["rev-parse", "--is-inside-work-tree"]);
    if (!inside.ok || inside.stdout.toString("utf8").trim() !== "true") {
      return { type: "reviewFiles", root, files: [], error: `Not a git repository: ${root}` };
    }
    const files: ReviewFileEntry[] = [];
    const hasHead = (await git(root, ["rev-parse", "--verify", "--quiet", "HEAD"])).ok;
    if (hasHead) {
      const [nameStatus, numstat] = await Promise.all([
        git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "-M", "-z", "--name-status", "--"]),
        git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "-M", "-z", "--numstat", "--"]),
      ]);
      if (!nameStatus.ok || !numstat.ok) {
        return { type: "reviewFiles", root, files: [], error: `git diff failed: ${nameStatus.stderr || numstat.stderr}` };
      }
      const counts = parseNumstat(numstat.stdout);
      for (const [path, { status, previousPath }] of parseNameStatus(nameStatus.stdout)) {
        const count = counts.get(path) ?? { adds: 0, dels: 0 };
        files.push({ path, ...(previousPath ? { previousPath } : {}), status, adds: count.adds, dels: count.dels });
      }
    } else {
      // Unborn repository (no commits yet): every staged file is an addition.
      const staged = await git(root, ["ls-files", "-z", "--"]);
      for (const path of nulFields(staged.stdout)) {
        files.push({ path, status: "added", adds: await untrackedAdds(root, path), dels: 0 });
      }
    }
    const [untracked, roots] = await Promise.all([
      git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--"]),
      untrackedRoots(root),
    ]);
    if (!untracked.ok) return { type: "reviewFiles", root, files: [], error: `git ls-files failed: ${untracked.stderr}` };
    const seen = new Set(files.map((file) => file.path));
    for (const path of nulFields(untracked.stdout)) {
      if (seen.has(path)) continue;
      const untrackedRoot = untrackedRootOf(path, roots);
      files.push({ path, status: "untracked", adds: await untrackedAdds(root, path), dels: 0, ...(untrackedRoot ? { untrackedRoot } : {}) });
    }
    if (files.length > MAX_FILES) {
      return { type: "reviewFiles", root, files: files.slice(0, MAX_FILES), error: `Showing first ${MAX_FILES} of ${files.length} changed files.` };
    }
    return { type: "reviewFiles", root, files };
  }

  async readChange(path: string): Promise<ReviewFileUpdate> {
    const root = this.rootOf();
    if (!root) return { type: "reviewFile", root: "", path, before: "", after: "", truncated: false, error: "Select a source folder first." };
    try {
      const abs = await resolveInside(root, path);
      // Honor renames: the HEAD side of a renamed file lives at its old path.
      let headPath = path;
      const nameStatus = await git(root, ["diff", "--no-ext-diff", "--no-textconv", "HEAD", "-M", "-z", "--name-status", "--"]);
      if (nameStatus.ok) {
        const previous = parseNameStatus(nameStatus.stdout).get(path)?.previousPath;
        if (previous) headPath = previous;
      }
      let truncated = false;
      // Before: content at HEAD; absent there (untracked/added/unborn) means empty.
      let before = "";
      const shown = await git(root, ["show", `HEAD:${headPath}`]);
      if (!shown.ok && (await git(root, ["cat-file", "-e", `HEAD:${headPath}`])).ok) throw new Error("Could not read the full Git baseline. It may exceed the preview limit.");
      if (shown.ok) {
        if (looksBinary(shown.stdout)) throw new Error(`Binary file (no text diff): ${path}`);
        if (shown.stdout.length > MAX_SIDE_BYTES) truncated = true;
        before = shown.stdout.subarray(0, MAX_SIDE_BYTES).toString("utf8");
      }
      // After: current working-tree content; absent (deleted) means empty.
      let after = "";
      try {
        const stat = await fs.stat(abs);
        if (!stat.isFile()) throw new Error(`Not a file: ${path}`);
        const buffer = await readPrefix(abs);
        if (looksBinary(buffer)) throw new Error(`Binary file (no text diff): ${path}`);
        if (buffer.length > MAX_SIDE_BYTES) truncated = true;
        after = buffer.subarray(0, MAX_SIDE_BYTES).toString("utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        if (!shown.ok) throw new Error(`No such file in HEAD or working tree: ${path}`);
      }
      return { type: "reviewFile", root, path, before, after, truncated };
    } catch (error) {
      return { type: "reviewFile", root, path, before: "", after: "", truncated: false, error: error instanceof Error ? error.message : String(error) };
    }
  }
}

// ---------------------------------------------------------------------------
// Baseline-aware review (review.* commands). Every comparison is tree → tree:
// the working tree side is a fresh snapshot (review-baseline.ts), the index
// side is the index written as a tree, so untracked files, renames, modes and
// blob ids come from one `git diff-tree` call. Writes (undo, stage) are
// guarded by the blob id of the side they change and run one at a time per
// repository.

const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif", svg: "image/svg+xml" };
const IMAGE_BYTES = 2 * 1024 * 1024;
const NULL_SHA = /^0+$/;

export function baselineKey(baseline: ReviewBaseline): string {
  return typeof baseline === "string" ? baseline : "ref" in baseline ? `ref:${baseline.ref}` : `run:${baseline.runId}`;
}

export function baselineLabel(baseline: ReviewBaseline): string {
  return baseline === "head" ? "HEAD" : baseline === "staged" ? "Staged" : baseline === "unstaged" ? "Unstaged" : "ref" in baseline ? baseline.ref : "Agent turn";
}

/** Validate an untrusted baseline value from the renderer. */
export function parseBaseline(value: unknown): ReviewBaseline {
  if (value === "head" || value === "staged" || value === "unstaged") return value;
  if (value && typeof value === "object" && typeof (value as { runId?: unknown }).runId === "string") {
    const runId = (value as { runId: string }).runId;
    if (runId && runId.length <= 128 && !/[\0-\x1f]/.test(runId)) return { runId };
  }
  if (value && typeof value === "object" && typeof (value as { ref?: unknown }).ref === "string") {
    const ref = (value as { ref: string }).ref.trim();
    if (REVIEW_REF_PATTERN.test(ref)) return { ref };
    throw new Error("Enter a branch, tag or commit to compare against.");
  }
  throw new Error("Choose a review baseline.");
}

interface RawEntry { path: string; previousPath?: string; status: string; oldMode: string; newMode: string; oldSha: string; newSha: string }

/** Parse `git diff-tree -z --raw` (":old new oldSha newSha STATUS\0path[\0path]"). */
export function parseRaw(stdout: Buffer): RawEntry[] {
  const fields = nulFields(stdout), entries: RawEntry[] = [];
  for (let index = 0; index < fields.length; ) {
    const [oldMode, newMode, oldSha, newSha, code] = fields[index].replace(/^:/, "").split(" ");
    const letter = code?.[0] ?? "M";
    const sha = (value: string) => NULL_SHA.test(value) ? "" : value;
    const mode = (value: string) => NULL_SHA.test(value) ? "" : value;
    if (letter === "R" || letter === "C") {
      entries.push({ path: fields[index + 2], previousPath: fields[index + 1], status: STATUS_NAMES[letter], oldMode: mode(oldMode), newMode: mode(newMode), oldSha: sha(oldSha), newSha: sha(newSha) });
      index += 3;
    } else {
      entries.push({ path: fields[index + 1], status: STATUS_NAMES[letter] ?? "modified", oldMode: mode(oldMode), newMode: mode(newMode), oldSha: sha(oldSha), newSha: sha(newSha) });
      index += 2;
    }
  }
  return entries;
}

function revisionOf(beforeHash: string, afterHash: string): string {
  return createHash("sha256").update(`${beforeHash}:${afterHash}`).digest("hex");
}

async function prefixOf(root: string): Promise<string> {
  const result = await git(root, ["rev-parse", "--show-prefix"]);
  if (!result.ok) throw new Error(`Not a git repository: ${root}`);
  return result.stdout.toString("utf8").trim();
}

async function headTree(root: string): Promise<string> {
  const head = await git(root, ["rev-parse", "--verify", "--quiet", "HEAD^{tree}"]);
  return head.ok ? head.stdout.toString("utf8").trim() : EMPTY_TREE;
}

interface Sides { from: string; to: string; toWorktree: boolean }

/** The tree of a branch, tag or commit (DIF-05); a missing ref is a clear error, never an empty diff. */
export async function refTree(root: string, ref: string): Promise<string> {
  const result = await git(root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{tree}`]);
  if (!result.ok) throw new Error(`There is no branch, tag or commit named ${ref}.`);
  return result.stdout.toString("utf8").trim();
}

async function sides(root: string, baseline: ReviewBaseline, baseTree: string | null | undefined): Promise<Sides> {
  if (!(await isGitWorkTree(root))) throw new Error(`Not a git repository: ${root}`);
  if (baseline === "staged") return { from: await headTree(root), to: await indexTree(root), toWorktree: false };
  const to = await snapshotTree(root, 15_000);
  if (baseline === "head") return { from: await headTree(root), to, toWorktree: true };
  if (baseline === "unstaged") return { from: await indexTree(root), to, toWorktree: true };
  if ("ref" in baseline) return { from: await refTree(root, baseline.ref), to, toWorktree: true };
  if (!baseTree) throw new Error("This agent turn has no review baseline.");
  return { from: baseTree, to, toWorktree: true };
}

async function rawDiff(root: string, from: string, to: string): Promise<RawEntry[]> {
  const result = await git(root, ["diff-tree", "-r", "-M", "-z", "--raw", "--no-abbrev", "--relative", from, to, "--"]);
  if (!result.ok) throw new Error(`git diff failed: ${result.stderr}`);
  return parseRaw(result.stdout);
}

async function blob(root: string, sha: string): Promise<Buffer> {
  if (!sha) return Buffer.alloc(0);
  const result = await git(root, ["cat-file", "blob", sha]);
  if (!result.ok) throw new Error("Could not read the baseline content. It may exceed the preview limit.");
  return result.stdout;
}

async function blobSize(root: string, sha: string): Promise<number> {
  if (!sha) return 0;
  const result = await git(root, ["cat-file", "-s", sha]);
  return result.ok ? Number(result.stdout.toString("utf8").trim()) || 0 : 0;
}

/**
 * Fully-untracked directories, as `git status --untracked-files=normal` reports them (`?? dir/`): the
 * shallowest directory whose every non-ignored file is untracked. The Changes pane groups the files
 * under one of these into a single row; untracked files outside them are reported one by one.
 */
export async function untrackedRoots(root: string): Promise<string[]> {
  const result = await git(root, ["ls-files", "-z", "--others", "--directory", "--no-empty-directory", "--exclude-standard", "--"]);
  return result.ok ? nulFields(result.stdout).filter(path => path.endsWith("/")) : [];
}

/** The `untrackedRoots` entry containing `path`, if any. */
export function untrackedRootOf(path: string, roots: readonly string[]): string | undefined {
  let best: string | undefined;
  for (const dir of roots) if (path.startsWith(dir) && (!best || dir.length > best.length)) best = dir;
  return best;
}

/** Untracked paths (for the 'untracked' status label on worktree baselines). */
async function untrackedSet(root: string): Promise<Set<string>> {
  const result = await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--"]);
  return new Set(result.ok ? nulFields(result.stdout) : []);
}

export async function reviewChanges(root: string, baseline: ReviewBaseline, baseTree?: string | null): Promise<ReviewChanges> {
  const { from, to, toWorktree } = await sides(root, baseline, baseTree);
  const [entries, numstat, untracked] = await Promise.all([
    rawDiff(root, from, to),
    git(root, ["diff-tree", "-r", "-M", "-z", "--numstat", "--relative", from, to, "--"]),
    toWorktree && typeof baseline === "string" ? untrackedSet(root) : Promise.resolve(new Set<string>()),
  ]);
  const roots = untracked.size ? await untrackedRoots(root) : [];
  const counts = numstat.ok ? parseNumstat(numstat.stdout) : new Map<string, { adds: number; dels: number }>();
  const binary = new Set<string>();
  if (numstat.ok) for (const field of nulFields(numstat.stdout)) if (field.startsWith("-\t-\t") && field.length > 4) binary.add(field.slice(4));
  const files: ReviewChange[] = entries.slice(0, MAX_FILES).map(entry => {
    const count = counts.get(entry.path) ?? { adds: 0, dels: 0 };
    const status = entry.status === "added" && untracked.has(entry.path) ? "untracked" : entry.status;
    const untrackedRoot = status === "untracked" ? untrackedRootOf(entry.path, roots) : undefined;
    return {
      ...(untrackedRoot ? { untrackedRoot } : {}),
      path: entry.path, ...(entry.previousPath ? { previousPath: entry.previousPath } : {}), status, adds: count.adds, dels: count.dels,
      ...(binary.has(entry.path) ? { binary: true } : {}),
      ...(entry.oldMode && entry.newMode && entry.oldMode !== entry.newMode ? { oldMode: entry.oldMode, newMode: entry.newMode } : {}),
      beforeHash: entry.oldSha, afterHash: entry.newSha, revision: revisionOf(entry.oldSha, entry.newSha),
    };
  });
  return { baseline, label: baselineLabel(baseline), files, truncated: entries.length > MAX_FILES };
}

interface Located { entry: RawEntry; from: string; to: string; toWorktree: boolean }

async function locate(root: string, path: string, baseline: ReviewBaseline, baseTree?: string | null): Promise<Located> {
  if (!path || path.includes("\0") || path.length > 4096) throw new Error("Invalid path.");
  await resolveInside(root, path);
  const { from, to, toWorktree } = await sides(root, baseline, baseTree);
  const entry = (await rawDiff(root, from, to)).find(item => item.path === path);
  if (entry) return { entry, from, to, toWorktree };
  // Unchanged against this baseline: both sides are the current blob.
  const prefix = await prefixOf(root);
  const [sha, mode] = await Promise.all([
    git(root, ["rev-parse", "--verify", "--quiet", `${to}:${prefix}${path}`]),
    git(root, ["ls-tree", "-z", to, "--", `${prefix}${path}`]).catch(() => undefined),
  ]);
  const current = sha.ok ? sha.stdout.toString("utf8").trim() : "";
  const fileMode = mode?.ok ? mode.stdout.toString("utf8").split(" ")[0] ?? "" : "";
  return { entry: { path, status: current ? "unchanged" : "missing", oldMode: fileMode, newMode: fileMode, oldSha: current, newSha: current }, from, to, toWorktree };
}

export async function reviewFileDiff(root: string, path: string, baseline: ReviewBaseline, baseTree?: string | null): Promise<ReviewFileDiff> {
  return (await readDiff(root, path, baseline, baseTree)).diff;
}

async function readDiff(root: string, path: string, baseline: ReviewBaseline, baseTree?: string | null): Promise<{ diff: ReviewFileDiff; entry: RawEntry }> {
  const { entry } = await locate(root, path, baseline, baseTree);
  const [beforeSize, afterSize] = await Promise.all([blobSize(root, entry.oldSha), blobSize(root, entry.newSha)]);
  const tooLarge = (size: number) => size > GIT_BUFFER - 1024;
  const [beforeBuffer, afterBuffer] = await Promise.all([
    tooLarge(beforeSize) ? Buffer.alloc(0) : blob(root, entry.oldSha),
    tooLarge(afterSize) ? Buffer.alloc(0) : blob(root, entry.newSha),
  ]);
  const binary = looksBinary(beforeBuffer) || looksBinary(afterBuffer);
  const mime = IMAGE_MIME[path.split(".").pop()?.toLowerCase() ?? ""];
  const dataUrl = (buffer: Buffer, size: number) => size && size <= IMAGE_BYTES && buffer.length === size ? `data:${mime};base64,${buffer.toString("base64")}` : undefined;
  const image = mime && (binary || mime === "image/svg+xml") ? { mime, ...(entry.oldSha ? { before: dataUrl(beforeBuffer, beforeSize) } : {}), ...(entry.newSha ? { after: dataUrl(afterBuffer, afterSize) } : {}) } : undefined;
  const truncated = !binary && (beforeSize > MAX_SIDE_BYTES || afterSize > MAX_SIDE_BYTES);
  const text = (buffer: Buffer) => binary ? "" : buffer.subarray(0, MAX_SIDE_BYTES).toString("utf8");
  return { entry, diff: {
    path, ...(entry.previousPath ? { previousPath: entry.previousPath } : {}), status: entry.status,
    before: text(beforeBuffer), after: text(afterBuffer), truncated,
    ...(binary ? { binary: true } : {}), ...(image ? { image } : {}),
    size: { before: beforeSize, after: afterSize },
    ...(entry.oldMode !== entry.newMode && (entry.oldMode || entry.newMode) ? { mode: { ...(entry.oldMode ? { old: entry.oldMode } : {}), ...(entry.newMode ? { new: entry.newMode } : {}) } } : {}),
    beforeHash: entry.oldSha, afterHash: entry.newSha, revision: revisionOf(entry.oldSha, entry.newSha), label: baselineLabel(baseline),
  } };
}

async function toplevel(root: string): Promise<{ top: string; prefix: string }> {
  const [top, prefix] = await Promise.all([git(root, ["rev-parse", "--show-toplevel"]), prefixOf(root)]);
  if (!top.ok) throw new Error(`Not a git repository: ${root}`);
  return { top: await fs.realpath(top.stdout.toString("utf8").trim()), prefix };
}

/** Replace (or with null, delete) a working-tree file atomically, keeping its mode unless `mode` is given. */
async function writeWorktree(root: string, path: string, content: Buffer | string | null, mode?: string): Promise<void> {
  const abs = await resolveInside(root, path);
  if (content === null) { await fs.rm(abs, { force: true }); return; }
  const previous = await fs.stat(abs).catch(() => undefined);
  if (previous && !previous.isFile()) throw new Error(`Not a file: ${path}`);
  await fs.mkdir(dirname(abs), { recursive: true });
  const temp = join(dirname(abs), `.${basename(abs)}.muster-${randomUUID().slice(0, 8)}`);
  const fileMode = mode === "100755" ? 0o755 : mode === "100644" ? 0o644 : previous ? previous.mode & 0o7777 : 0o644;
  try {
    await fs.writeFile(temp, content, { mode: fileMode });
    await fs.chmod(temp, fileMode);
    await fs.rename(temp, abs);
  } catch (error) { await fs.rm(temp, { force: true }); throw error; }
}

/** Point one index entry at new content (null removes it). */
async function writeIndex(root: string, path: string, content: Buffer | string | null, mode: string): Promise<void> {
  const { top, prefix } = await toplevel(root);
  const target = prefix + path;
  if (content === null) {
    const removed = await git(top, ["update-index", "--force-remove", "--", target]);
    if (!removed.ok) throw new Error(removed.stderr || "Git could not update the index.");
    return;
  }
  const hashed = await git(top, ["hash-object", "-w", "--stdin"], { input: content });
  if (!hashed.ok) throw new Error(hashed.stderr || "Git could not store the content.");
  const updated = await git(top, ["update-index", "--add", "--cacheinfo", `${mode === "100755" ? "100755" : "100644"},${hashed.stdout.toString("utf8").trim()},${target}`]);
  if (!updated.ok) throw new Error(updated.stderr || "Git could not update the index.");
}

async function exclusive<T>(root: string, action: () => Promise<T>): Promise<T> {
  const { top } = await toplevel(root);
  return serial(top, action);
}

function stale(diff: ReviewFileDiff, relocatable = false): ReviewWriteResult {
  return { stale: true, current: diff.binary ? "" : diff.after, afterHash: diff.afterHash, relocatable };
}

function hunkOf(before: string, after: string, hunkId: string) {
  return computeHunks(before, after)?.find(hunk => hunk.id === hunkId);
}

/**
 * Reverse-apply one hunk. On the working-tree baselines the file is rewritten;
 * on 'staged' the index entry is (this is how a hunk is unstaged). The write
 * happens only while the side being changed still has `expectedAfterHash`;
 * otherwise the current text comes back for a three-way prompt, and
 * `relocate` places the revert when the hunk's lines occur exactly once.
 */
export async function undoHunk(root: string, input: { path: string; baseline: ReviewBaseline; hunkId: string; expectedAfterHash: string; relocate?: boolean }, baseTree?: string | null): Promise<ReviewWriteResult> {
  return exclusive(root, async () => {
    const { diff, entry } = await readDiff(root, input.path, input.baseline, baseTree);
    if (diff.binary) throw new Error("Binary files can only be undone as a whole file.");
    if (diff.truncated) throw new Error("This file is larger than the in-app review. Undo it with Git.");
    let next: string | null = null;
    if (diff.afterHash !== input.expectedAfterHash) {
      const reviewed = input.expectedAfterHash ? await blob(root, input.expectedAfterHash).catch(() => undefined) : undefined;
      const hunk = reviewed && hunkOf(diff.before, reviewed.toString("utf8"), input.hunkId);
      const placed = hunk ? relocateReverse(diff.after, hunk, diff.before) : null;
      if (!input.relocate || placed === null) return stale(diff, placed !== null);
      next = placed;
    } else {
      const hunk = hunkOf(diff.before, diff.after, input.hunkId);
      if (!hunk) return stale(diff);
      next = reverseHunk(diff.after, hunk);
    }
    const remove = next === "" && !diff.beforeHash;
    if (input.baseline === "staged") await writeIndex(root, input.path, remove ? null : next, entry.newMode);
    else await writeWorktree(root, input.path, remove ? null : next);
    return { stale: false, afterHash: remove ? "" : await blobId(root, next) };
  });
}

/** Restore a whole file (binary safe, renames and modes included) to its baseline side. */
export async function undoFile(root: string, input: { path: string; baseline: ReviewBaseline; expectedAfterHash: string }, baseTree?: string | null): Promise<ReviewWriteResult> {
  return exclusive(root, async () => {
    const { entry } = await locate(root, input.path, input.baseline, baseTree);
    if (entry.newSha !== input.expectedAfterHash) return stale(await reviewFileDiff(root, input.path, input.baseline, baseTree));
    const original = entry.oldSha ? await blob(root, entry.oldSha) : null;
    const restorePath = entry.previousPath ?? input.path;
    if (input.baseline === "staged") {
      if (entry.previousPath) await writeIndex(root, input.path, null, "");
      await writeIndex(root, restorePath, original, entry.oldMode);
    } else {
      if (entry.previousPath) await writeWorktree(root, input.path, null);
      await writeWorktree(root, restorePath, original, entry.oldMode || undefined);
    }
    return { stale: false, afterHash: entry.oldSha };
  });
}

/** Stage one hunk of the unstaged diff into the index, or unstage one hunk of the staged diff. */
export async function stageHunk(root: string, input: { path: string; hunkId: string; expectedBeforeHash: string; expectedAfterHash: string; unstage?: boolean }): Promise<ReviewWriteResult> {
  if (input.unstage) return undoHunk(root, { path: input.path, baseline: "staged", hunkId: input.hunkId, expectedAfterHash: input.expectedAfterHash });
  return exclusive(root, async () => {
    const { diff, entry } = await readDiff(root, input.path, "unstaged");
    if (diff.binary || diff.truncated) throw new Error("Stage this file as a whole; it is binary or larger than the in-app review.");
    if (diff.beforeHash !== input.expectedBeforeHash || diff.afterHash !== input.expectedAfterHash) return stale(diff);
    const hunk = hunkOf(diff.before, diff.after, input.hunkId);
    if (!hunk) return stale(diff);
    const next = applyHunk(diff.before, hunk);
    await writeIndex(root, input.path, next, entry.newMode);
    return { stale: false, afterHash: diff.afterHash };
  });
}

export async function stageAll(root: string): Promise<void> {
  await exclusive(root, async () => {
    const added = await git(root, ["add", "-A", "--", "."]);
    if (!added.ok) throw new Error(added.stderr || "Git could not stage the changes.");
  });
}

async function blobId(root: string, content: string): Promise<string> {
  const result = await git(root, ["hash-object", "--stdin"], { input: content });
  return result.ok ? result.stdout.toString("utf8").trim() : "";
}
