// Pre-run review baselines (Cursor's "Last agent turn"). Before an agent turn
// starts, the folder's tracked and untracked (non-ignored) files are written
// to a Git tree through a throwaway copy of the index, so the user's real
// index, stash and refs are never touched. The tree id is recorded per run;
// review.ts diffs it against a fresh snapshot of the working tree. Non-Git
// folders record a row with no tree and the reason, so the UI can say so.
import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { ReviewBaselineInfo, ReviewMark, ReviewMarkState } from "../shared/domains/review-protocol.ts";
import { git } from "./review.ts";

/** The empty tree: the baseline side of an unborn repository. */
export const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
/** Run hooks are bounded at 5 s; stay inside that so a slow snapshot is recorded as missing, never taken after the agent starts writing. */
export const SNAPSHOT_TIMEOUT_MS = 4000;
const KEEP_PER_CHAT = 50;

export async function isGitWorkTree(root: string, timeoutMs?: number): Promise<boolean> {
  const inside = await git(root, ["rev-parse", "--is-inside-work-tree"], timeoutMs ? { timeoutMs } : {});
  return inside.ok && inside.stdout.toString("utf8").trim() === "true";
}

/** Untracked files larger than this, or past the total budget, stay out of snapshots so a stray data dump never lands in .git/objects. */
export const UNTRACKED_FILE_LIMIT = 4 * 1024 * 1024;
const UNTRACKED_TOTAL_LIMIT = 64 * 1024 * 1024;
const UNTRACKED_COUNT_LIMIT = 5000;

/**
 * Write the working tree (tracked changes plus bounded untracked, non-ignored
 * files) as a tree object and return its id. The real index is copied first so
 * `add -u` only has to look at already-tracked paths (including anything
 * staged but not yet committed) rather than walking the whole tree; its cached
 * per-entry stat data is then dropped (see the racy-git note below) so every
 * tracked path is still re-hashed from its actual current content.
 */
export async function snapshotTree(root: string, timeoutMs = SNAPSHOT_TIMEOUT_MS): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  const left = () => Math.max(1, deadline - Date.now());
  const timedOut = () => new Error("The working tree snapshot timed out.");
  const indexPath = await git(root, ["rev-parse", "--git-path", "index"], { timeoutMs: left() });
  if (!indexPath.ok) throw new Error(indexPath.stderr || "Not a Git repository.");
  const raw = indexPath.stdout.toString("utf8").trim();
  const temp = join(tmpdir(), `muster-review-${randomUUID()}.index`);
  try {
    const copied = await fs.copyFile(isAbsolute(raw) ? raw : join(root, raw), temp).then(() => true, error => { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; return false; });
    const env = { GIT_INDEX_FILE: temp };
    // Racy git: the copied index carries each entry's cached (mtime, size) from
    // whenever it was last written (e.g. a commit moments ago). `add -u` below
    // trusts that cache -- skips re-hashing -- when a file's current stat still
    // matches it. A file rewritten again within the same filesystem-timestamp
    // second as that cache (same size too, so even the cheap check can't tell)
    // can then read back as "unchanged" even though its content differs: a
    // textbook racy-git false negative, and flaky by construction since it only
    // bites when two writes land in the same clock tick. Rather than lean on
    // git's own (version-dependent, easy to get backwards) racy-timestamp
    // handling, drop the cached stat entirely: write the copied index out as a
    // tree and read that tree straight back in. `read-tree` populates entries
    // with no stat cache at all, so every entry is a guaranteed mismatch against
    // its real file below, forcing `add -u` to re-hash from actual content --
    // correct every time, independent of timing -- while the tree write/read
    // round trip (not HEAD) keeps whatever was already staged, including a file
    // added to the index but not yet committed.
    if (copied) {
      const flattened = await git(root, ["write-tree"], { env, timeoutMs: left() });
      if (flattened.ok) await git(root, ["read-tree", flattened.stdout.toString("utf8").trim()], { env, timeoutMs: left() });
    }
    const [tracked, others] = await Promise.all([
      git(root, ["add", "-u", "--ignore-errors"], { env, timeoutMs: left() }),
      git(root, ["ls-files", "-z", "--others", "--exclude-standard", "--"], { timeoutMs: left() }),
    ]);
    if (Date.now() >= deadline || (!tracked.ok && /timed out|SIGKILL/i.test(tracked.stderr))) throw timedOut();
    const candidates = others.ok ? nulFields(others.stdout).slice(0, UNTRACKED_COUNT_LIMIT) : [];
    const include: string[] = [];
    let total = 0;
    for (let start = 0; start < candidates.length; start += 64) {
      const sizes = await Promise.all(candidates.slice(start, start + 64).map(path => fs.lstat(join(root, path)).then(stat => stat.isFile() || stat.isSymbolicLink() ? stat.size : -1, () => -1)));
      sizes.forEach((size, offset) => { if (size >= 0 && size <= UNTRACKED_FILE_LIMIT && total + size <= UNTRACKED_TOTAL_LIMIT) { total += size; include.push(candidates[start + offset]); } });
    }
    if (include.length) {
      const added = await git(root, ["add", "--ignore-errors", "--pathspec-from-file=-", "--pathspec-file-nul"], { env, input: include.join("\0"), timeoutMs: left() });
      if (!added.ok && Date.now() >= deadline) throw timedOut();
    }
    const tree = await git(root, ["write-tree"], { env, timeoutMs: left() });
    if (!tree.ok) throw Date.now() >= deadline ? timedOut() : new Error(tree.stderr || "Git could not write the snapshot.");
    return tree.stdout.toString("utf8").trim();
  } finally {
    await fs.rm(temp, { force: true });
    await fs.rm(`${temp}.lock`, { force: true });
  }
}

function nulFields(stdout: Buffer): string[] {
  return stdout.toString("utf8").split("\0").filter(Boolean);
}

/** The real index as a tree (for the staged/unstaged baselines), written through a copy so a held index.lock never blocks review. */
export async function indexTree(root: string): Promise<string> {
  const indexPath = await git(root, ["rev-parse", "--git-path", "index"]);
  if (!indexPath.ok) throw new Error(indexPath.stderr || "Not a Git repository.");
  const raw = indexPath.stdout.toString("utf8").trim();
  const temp = join(tmpdir(), `muster-review-${randomUUID()}.index`);
  try {
    const copied = await fs.copyFile(isAbsolute(raw) ? raw : join(root, raw), temp).then(() => true, error => { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; });
    if (!copied) return EMPTY_TREE;
    const tree = await git(root, ["write-tree"], { env: { GIT_INDEX_FILE: temp } });
    if (!tree.ok) throw new Error(/unmerged/i.test(tree.stderr) ? "Resolve merge conflicts to review staged changes." : tree.stderr || "Git could not read the index.");
    return tree.stdout.toString("utf8").trim();
  } finally { await fs.rm(temp, { force: true }); }
}

interface BaselineRow { run_id: string; chat_id: string; folder_id: string | null; tree_sha: string | null; created_at: string; reason: string | null }
interface MarkRow { run_id: string; path: string; hunk_id: string; state: string; updated_at: string }

/** Baselines and Keep/Undo marks in the app database. */
export class ReviewBaselineStore {
  constructor(private readonly db: DatabaseSync) {
    db.exec(`CREATE TABLE IF NOT EXISTS review_baselines (run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, folder_id TEXT, tree_sha TEXT, created_at TEXT NOT NULL, reason TEXT);
      CREATE INDEX IF NOT EXISTS review_baselines_chat ON review_baselines(chat_id, created_at);
      CREATE TABLE IF NOT EXISTS review_marks (run_id TEXT NOT NULL, path TEXT NOT NULL, hunk_id TEXT NOT NULL, state TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY (run_id, path, hunk_id))`);
  }

  record(info: Omit<ReviewBaselineInfo, "at"> & { at?: string }): ReviewBaselineInfo {
    const at = info.at ?? new Date().toISOString();
    this.db.prepare("INSERT OR REPLACE INTO review_baselines (run_id, chat_id, folder_id, tree_sha, created_at, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .run(info.runId, info.chatId, info.folderId, info.treeSha, at, info.reason ?? null);
    const stale = this.db.prepare("SELECT run_id FROM review_baselines WHERE chat_id = ? ORDER BY created_at DESC LIMIT -1 OFFSET ?").all(info.chatId, KEEP_PER_CHAT) as { run_id: string }[];
    for (const row of stale) {
      this.db.prepare("DELETE FROM review_baselines WHERE run_id = ?").run(row.run_id);
      this.db.prepare("DELETE FROM review_marks WHERE run_id = ?").run(row.run_id);
    }
    return { runId: info.runId, chatId: info.chatId, folderId: info.folderId, treeSha: info.treeSha, at, ...(info.reason ? { reason: info.reason } : {}) };
  }

  /** Oldest first, so the last entry is the latest turn. */
  list(chatId: string): ReviewBaselineInfo[] {
    return (this.db.prepare("SELECT * FROM review_baselines WHERE chat_id = ? ORDER BY created_at, rowid").all(chatId) as unknown as BaselineRow[]).map(toInfo);
  }

  get(runId: string): ReviewBaselineInfo | undefined {
    const row = this.db.prepare("SELECT * FROM review_baselines WHERE run_id = ?").get(runId) as unknown as BaselineRow | undefined;
    return row ? toInfo(row) : undefined;
  }

  marks(runId: string): ReviewMark[] {
    return (this.db.prepare("SELECT * FROM review_marks WHERE run_id = ? ORDER BY updated_at").all(runId) as unknown as MarkRow[])
      .map(row => ({ runId: row.run_id, path: row.path, hunkId: row.hunk_id, state: row.state as ReviewMarkState, at: row.updated_at }));
  }

  mark(runId: string, path: string, hunkIds: readonly string[], state: ReviewMarkState): void {
    const at = new Date().toISOString();
    const statement = this.db.prepare("INSERT INTO review_marks (run_id, path, hunk_id, state, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(run_id, path, hunk_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at");
    for (const hunkId of hunkIds) statement.run(runId, path, hunkId, state, at);
  }
}

function toInfo(row: BaselineRow): ReviewBaselineInfo {
  return { runId: row.run_id, chatId: row.chat_id, folderId: row.folder_id, treeSha: row.tree_sha, at: row.created_at, ...(row.reason ? { reason: row.reason } : {}) };
}

/** Take a run's baseline: a tree for Git folders, otherwise a row that says why there is none. Never throws. */
export async function captureBaseline(store: ReviewBaselineStore, run: { runId: string; chatId: string; folderId: string | null; cwd: string; startedAt?: number }): Promise<ReviewBaselineInfo> {
  const base = { runId: run.runId, chatId: run.chatId, folderId: run.folderId };
  // One budget for the whole capture, so a slow repository check cannot push the snapshot past the point the agent starts writing.
  const deadline = (run.startedAt ?? Date.now()) + SNAPSHOT_TIMEOUT_MS;
  try {
    if (!(await isGitWorkTree(run.cwd, Math.max(1, deadline - Date.now())))) return store.record({ ...base, treeSha: null, reason: Date.now() >= deadline ? "The working tree snapshot timed out." : "This folder is not a Git repository, so agent turns have no review baseline." });
    const left = deadline - Date.now();
    if (left <= 0) throw new Error("The working tree snapshot timed out.");
    return store.record({ ...base, treeSha: await snapshotTree(run.cwd, left) });
  } catch (error) {
    return store.record({ ...base, treeSha: null, reason: error instanceof Error ? error.message : String(error) });
  }
}
