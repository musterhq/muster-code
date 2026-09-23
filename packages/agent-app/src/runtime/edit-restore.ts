// CHAT-18 "Replace and restore files": put back the files Muster's own agent turns changed after an
// edited message, using the pre-run review baseline tree taken before that message's turn. Only paths
// named by agent file-change items are candidates ("owned"); anything else that differs is listed as
// left alone and never touched. Commands and tool calls that ran are counted, never described as undone.
import { promises as fs } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import type { EditRestoreFile, TimelineItem } from "../shared/protocol.ts";
import { snapshotTree } from "./review-baseline.ts";
import { git } from "./review.ts";

const ZERO = "0000000000000000000000000000000000000000";
/** A preview names at most this many files; a bigger rewind is refused rather than half-shown. */
export const MAX_RESTORE_FILES = 500;
const MAX_LEFT = 200;
const PREVIEW_TIMEOUT_MS = 15_000;

const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

/** Folder-relative paths agent file-change items touched (a move names both ends). Paths outside `roots` are dropped. */
export function ownedPaths(items: readonly TimelineItem[], roots: readonly string[]): string[] {
  const out = new Set<string>();
  const add = (value: unknown) => { const path = typeof value === "string" ? folderRelative(value, roots) : null; if (path) out.add(path); };
  for (const item of items) {
    if (item.kind !== "tool" || !Array.isArray(item.data?.changes)) continue;
    for (const change of item.data.changes) if (isRecord(change)) { add(change.path); add(change.movePath); }
  }
  return [...out].sort();
}

/** ownedPaths, plus absolute paths reported through a symlinked alias of the folder (/var vs /private/var), resolved on disk. */
export async function resolveOwnedPaths(items: readonly TimelineItem[], roots: readonly string[]): Promise<string[]> {
  const out = new Set(ownedPaths(items, roots));
  const strays = new Set<string>();
  for (const item of items) {
    if (item.kind !== "tool" || !Array.isArray(item.data?.changes)) continue;
    for (const change of item.data.changes) if (isRecord(change)) for (const value of [change.path, change.movePath]) if (typeof value === "string" && isAbsolute(value) && !folderRelative(value, roots)) strays.add(value);
  }
  for (const stray of [...strays].slice(0, 500)) {
    const parent = await fs.realpath(dirname(stray)).catch(() => null);
    const path = parent ? folderRelative(join(parent, stray.slice(dirname(stray).length + 1)), roots) : null;
    if (path) out.add(path);
  }
  return [...out].sort();
}

/** Command runs and external tool calls after the edit point: their effects can never be undone by a file restore. */
export function externalActions(items: readonly TimelineItem[]): number {
  return items.filter(item => item.kind === "tool" && (item.data?.type === "commandExecution" || item.data?.type === "mcpToolCall" || item.data?.type === "dynamicToolCall"
    || (typeof item.data?.command === "string" && !Array.isArray(item.data?.changes)))).length;
}

function folderRelative(path: string, roots: readonly string[]): string | null {
  let rel = path;
  if (isAbsolute(path)) {
    const root = roots.find(candidate => path === candidate || path.startsWith(candidate.endsWith(sep) ? candidate : candidate + sep));
    if (!root) return null;
    rel = relative(root, path);
  }
  rel = rel.split(sep).join("/").replace(/^\.\//, "");
  if (!rel || rel === "." || rel.split("/").some(part => part === ".." || part === "") || rel.startsWith(".git/") || rel === ".git") return null;
  return rel;
}

interface RawChange { path: string; oldSha: string; newSha: string }
function parseRaw(stdout: Buffer): RawChange[] {
  const fields = stdout.toString("utf8").split("\0");
  const out: RawChange[] = [];
  for (let i = 0; i + 1 < fields.length; i += 2) {
    const meta = fields[i]!, path = fields[i + 1]!;
    if (!meta.startsWith(":")) break;
    const [, , oldSha, newSha] = meta.slice(1).split(" ");
    if (oldSha && newSha && path) out.push({ path, oldSha, newSha });
  }
  return out;
}

export interface RestorePlan { files: EditRestoreFile[]; left: string[] }

/** Compare the baseline tree with a fresh snapshot of the working tree. `owned` paths that differ become restore/delete rows. */
export async function planRestore(root: string, baselineTree: string, owned: readonly string[]): Promise<RestorePlan> {
  const current = await snapshotTree(root, PREVIEW_TIMEOUT_MS);
  const raw = await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--raw", baselineTree, current]);
  if (!raw.ok) throw new Error(raw.stderr || "Git could not compare the snapshot.");
  const changes = parseRaw(raw.stdout), mine = new Set(owned);
  const restore = changes.filter(change => mine.has(change.path));
  if (restore.length > MAX_RESTORE_FILES) throw new Error(`More than ${MAX_RESTORE_FILES} files would change; resend as a fork instead.`);
  const counts = new Map<string, { adds: number; dels: number }>();
  if (restore.length) {
    // Restoring runs current → baseline, so adds/dels describe what the restore itself does.
    const numstat = await git(root, ["diff-tree", "-r", "-z", "--no-renames", "--numstat", current, baselineTree, "--", ...restore.map(change => change.path)]);
    if (numstat.ok) for (const entry of numstat.stdout.toString("utf8").split("\0")) {
      const match = /^(\d+|-)\t(\d+|-)\t(.+)$/s.exec(entry);
      if (match) counts.set(match[3]!, { adds: match[1] === "-" ? 0 : Number(match[1]), dels: match[2] === "-" ? 0 : Number(match[2]) });
    }
  }
  return {
    files: restore.map(change => ({ path: change.path, action: change.oldSha === ZERO ? "delete" as const : "restore" as const, afterHash: change.newSha, ...(counts.get(change.path) ?? { adds: 0, dels: 0 }) })),
    left: changes.filter(change => !mine.has(change.path)).slice(0, MAX_LEFT).map(change => change.path),
  };
}

/** Resolve `path` under `root`, refusing anything that escapes it through `..` or a symlinked parent directory. */
async function inside(root: string, path: string): Promise<string> {
  const real = await fs.realpath(root);
  const absolute = join(real, ...path.split("/"));
  if (!absolute.startsWith(real + sep)) throw new Error(`${path} is outside the folder.`);
  let parent = dirname(absolute);
  // The nearest existing ancestor must still be inside the folder.
  for (;;) {
    const resolved = await fs.realpath(parent).catch(() => null);
    if (resolved) { if (resolved !== real && !resolved.startsWith(real + sep)) throw new Error(`${path} is outside the folder.`); break; }
    const up = dirname(parent); if (up === parent) break; parent = up;
  }
  return absolute;
}

/** Git blob id of what is on disk now (ZERO when absent), hashed the way the snapshot tree hashed it. */
async function diskHash(root: string, absolute: string, path: string): Promise<string> {
  const stat = await fs.lstat(absolute).catch(() => null);
  if (!stat) return ZERO;
  if (stat.isDirectory()) return "directory";
  // A regular file goes through the same clean filters `git add` applied to the snapshot; a link hashes its target text.
  const hashed = stat.isSymbolicLink()
    ? await git(root, ["hash-object", "--stdin", "--no-filters"], { input: Buffer.from(await fs.readlink(absolute)) })
    : await git(root, ["hash-object", "--", path]);
  if (!hashed.ok) throw new Error(hashed.stderr || "Git could not hash a file.");
  return hashed.stdout.toString("utf8").trim();
}

/**
 * Restore exactly the previewed files. Every file is checked against its previewed hash before anything is
 * written, so a file that changed since the preview refuses the whole restore and nothing is touched.
 */
export async function applyRestore(root: string, baselineTree: string, files: readonly EditRestoreFile[]): Promise<string[]> {
  const targets = await Promise.all(files.map(async file => ({ file, absolute: await inside(root, file.path) })));
  const changed: string[] = [];
  for (const { file, absolute } of targets) {
    const now = await diskHash(root, absolute, file.path);
    if (now !== file.afterHash) changed.push(file.path);
  }
  if (changed.length) throw new Error(`${changed.length === 1 ? `${changed[0]} changed` : `${changed.length} files changed`} after the preview. Nothing was restored; review the list again.`);
  const restored: string[] = [];
  for (const { file, absolute } of targets) {
    if (file.action === "delete") { await fs.rm(absolute, { force: true }); restored.push(file.path); continue; }
    const entry = await git(root, ["ls-tree", "-z", baselineTree, "--", file.path]);
    const match = entry.ok ? /^(\d+) blob ([0-9a-f]+)\t/.exec(entry.stdout.toString("utf8")) : null;
    if (!match) throw new Error(`The snapshot no longer has ${file.path}. ${restored.length ? `${restored.length} file${restored.length === 1 ? " was" : "s were"} already restored.` : "Nothing was restored."}`);
    const blob = await git(root, ["cat-file", "blob", match[2]!]);
    if (!blob.ok) throw new Error(`Could not read ${file.path} from the snapshot.`);
    await fs.mkdir(dirname(absolute), { recursive: true });
    await fs.rm(absolute, { force: true });
    if (match[1] === "120000") await fs.symlink(blob.stdout.toString("utf8"), absolute);
    else await fs.writeFile(absolute, blob.stdout, { mode: match[1] === "100755" ? 0o755 : 0o644 });
    restored.push(file.path);
  }
  return restored;
}
