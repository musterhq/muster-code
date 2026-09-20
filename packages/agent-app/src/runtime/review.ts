// Agent Mode review host — read-only full-file change data scoped to the
// selected source root. Baseline is HEAD; untracked files are included and
// deletions/renames are honored. Serves the renderer's review messages with
// full before/after content so it can render real inline/split diffs.
// Never writes; rejects path escapes and symlinks that resolve outside the
// root; bounds per-file text and the change-list length. Git is invoked via
// execFile (no shell) with NUL-delimited output so odd filenames survive.
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import { resolveInside } from './paths.ts';

export interface ReviewFileEntry {
  readonly path: string; // root-relative, "/"-separated (as git reports)
  readonly previousPath?: string; // set for renames/copies
  readonly status: string; // added | modified | deleted | renamed | copied | untracked | …
  readonly adds: number;
  readonly dels: number;
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

interface GitResult {
  readonly ok: boolean;
  readonly stdout: Buffer;
  readonly stderr: string;
}

/**
 * Run git with argv (never a shell) and buffered binary output. Errors are
 * reported via `ok`/`stderr`; stderr is the only text ever surfaced to the
 * user, so environment values cannot leak through messages.
 */
function git(root: string, args: readonly string[]): Promise<GitResult> {
  const { promise, resolve: settle } = Promise.withResolvers<GitResult>();
  execFile(
    "git",
    ["--literal-pathspecs", "-C", root, ...args],
    { maxBuffer: GIT_BUFFER, encoding: "buffer", timeout: GIT_TIMEOUT_MS, env: { ...Object.fromEntries(Object.entries(process.env).filter(([key])=>!key.startsWith('GIT_'))), GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" } },
    (error, stdout, stderr) => {
      settle({ ok: !error, stdout, stderr: stderr.toString("utf8").split("\n")[0] ?? "" });
    },
  );
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
    const untracked = await git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--"]);
    if (!untracked.ok) return { type: "reviewFiles", root, files: [], error: `git ls-files failed: ${untracked.stderr}` };
    const seen = new Set(files.map((file) => file.path));
    for (const path of nulFields(untracked.stdout)) {
      if (seen.has(path)) continue;
      files.push({ path, status: "untracked", adds: await untrackedAdds(root, path), dels: 0 });
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
