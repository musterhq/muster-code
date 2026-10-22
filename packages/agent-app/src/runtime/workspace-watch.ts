/**
 * Bounded per-folder change watcher. One recursive fs.watch per distinct
 * folder id (macOS FSEvents backs `recursive: true`); re-watching an id
 * replaces the old root only after the new watcher opened. Bursts coalesce
 * into a single trailing notification (~150ms): each root holds at most one
 * pending timer and no event queue, so memory stays O(active roots), which is
 * capped at MAX_WATCHED_ROOTS with an explicit error beyond it.
 *
 * Noise from node_modules, always-generated caches, git-ignored build output
 * (dist/, target/, … only when git ignores them) and .git internals is dropped, but
 * git state the review host reads (index, HEAD, refs, packed-refs) still
 * notifies. A recursive-watch-unsupported platform makes watch() reject —
 * never a silent no-op — and runtime watcher failures tear the root down and
 * surface through the typed onError callback.
 *
 * Standalone by design: the parent wires it to the service/store (e.g. call
 * watch() when a folder is opened, map onChanged to a files/review refresh
 * push, unwatch() on folder close, dispose() on app quit). This module never
 * touches service.ts, the protocol, or the store.
 */
import { watch as fsWatch, promises as fs, type FSWatcher } from 'node:fs';
import { execFile } from 'node:child_process';
import { sep } from 'node:path';

export const MAX_WATCHED_ROOTS = 32;
export const COALESCE_MS = 150;

/** Any path containing one of these segments is dropped (dir or file). */
const IGNORED_SEGMENTS: Record<string, true> = {
  node_modules: true,
  // Always generated: a compile writes thousands of files here and would refresh the file tree every 150 ms.
  '.next': true,
  '.turbo': true,
  __pycache__: true,
  '.DS_Store': true,
};
/**
 * Usual build-output folders. Some repos commit them (a GitHub Action's `dist/`, a library's `build/`), so a change
 * under one is dropped only when git ignores that folder; a committed one keeps refreshing the file tree and review.
 */
const BUILD_OUTPUT_SEGMENTS: Record<string, true> = {
  dist: true,
  target: true,
  build: true,
  out: true,
};
/** Per-root cache bound for git check-ignore answers (one entry per build-output folder seen). */
const MAX_IGNORE_ENTRIES = 256;
/** Direct `.git/` children whose changes matter to review; plus `.git/refs/**`. */
const GIT_REVIEW_FILES: Record<string, true> = {
  index: true,
  HEAD: true,
  MERGE_HEAD: true,
  ORIG_HEAD: true,
  'packed-refs': true,
};

export type ChangeHandler = (folderId: string) => void;
export type WatchErrorHandler = (folderId: string, error: Error) => void;

interface WatchEntry {
  readonly watcher: FSWatcher;
  timer: NodeJS.Timeout | null;
  /** Build-output folder -> whether git ignores it (a promise while the check runs). Cleared when ignore rules change. */
  readonly ignored: Map<string, boolean | Promise<boolean>>;
}

const pathName = (filename: string | Buffer): string => typeof filename === 'string' ? filename : filename.toString();

function isRelevant(filename: string | Buffer | null): boolean {
  if (filename === null) return true; // platform gave no path: refresh conservatively
  const segments = pathName(filename).split(sep);
  if (segments[0] === '.git') {
    return (
      (segments.length === 2 && GIT_REVIEW_FILES[segments[1]] === true) ||
      (segments.length > 2 && segments[1] === 'refs')
    );
  }
  return !segments.some((segment) => IGNORED_SEGMENTS[segment] === true);
}

/** The folder (relative to the root, `/`-separated) of the first build-output segment in a changed path, if any. */
function buildOutputFolder(filename: string | Buffer | null): string | undefined {
  if (filename === null) return undefined;
  const segments = pathName(filename).split(sep);
  // The last segment is the changed entry itself: a file named "dist" or the folder being created is not inside it.
  const at = segments.slice(0, -1).findIndex((segment) => BUILD_OUTPUT_SEGMENTS[segment] === true);
  return at < 0 ? undefined : segments.slice(0, at + 1).join('/');
}

/** A change that can alter what git ignores: drop the cached answers for the root. */
function changesIgnoreRules(filename: string | Buffer | null): boolean {
  if (filename === null) return true;
  const segments = pathName(filename).split(sep);
  return segments[segments.length - 1] === '.gitignore' || (segments[0] === '.git' && segments[1] === 'info' && segments[2] === 'exclude');
}

/** Whether git ignores `folder` under `root`. Async (never blocks the caller); not a repo or no git means not ignored. */
function gitIgnores(root: string, folder: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile('git', ['-c', 'core.fsmonitor=false', 'check-ignore', '-q', '--', `${folder}/`], { cwd: root, windowsHide: true, timeout: 5000 }, (error) => {
      resolve(!error); // exit 0: ignored; 1: not ignored; 128 or spawn failure: treat as not ignored
    });
  });
}

function closeEntry(entry: WatchEntry): void {
  if (entry.timer !== null) clearTimeout(entry.timer);
  entry.timer = null;
  entry.watcher.close();
}

export class WorkspaceWatchService {
  readonly #onChanged: ChangeHandler;
  readonly #onError: WatchErrorHandler;
  readonly #entries = new Map<string, WatchEntry>();
  #disposed = false;
  readonly #pending = new Map<string, symbol>();

  constructor(
    onChanged: ChangeHandler,
    onError: WatchErrorHandler = (folderId, error) => {
      console.error(`workspace-watch: watcher for folder ${folderId} failed`, error);
    },
  ) {
    this.#onChanged = onChanged;
    this.#onError = onError;
  }

  /**
   * Start (or re-root) watching `folderId`. Rejects when disposed, the root
   * is missing / not a directory, the root cap is hit, or recursive watching
   * is unavailable on this platform.
   */
  async watch(folderId: string, root: string): Promise<void> {
    if (this.#disposed) throw new Error('WorkspaceWatchService is disposed.');
    const roots = new Set([...this.#entries.keys(), ...this.#pending.keys()]);
    if (!roots.has(folderId) && roots.size >= MAX_WATCHED_ROOTS) throw new Error(`Watch limit of ${MAX_WATCHED_ROOTS} roots reached`);
    const token = Symbol(folderId);
    this.#pending.set(folderId, token);
    try {
    const real = await fs.realpath(root); // canonical: rejects dangling paths, resolves symlinks
    if (!(await fs.stat(real)).isDirectory()) throw new Error(`Watch root is not a directory: ${root}`);
    if (this.#disposed || this.#pending.get(folderId) !== token) throw new Error('Watch was cancelled.');
    if (!this.#entries.has(folderId) && this.#entries.size >= MAX_WATCHED_ROOTS) {
      throw new Error(`Watch limit of ${MAX_WATCHED_ROOTS} roots reached; unwatch a folder first.`);
    }
    let watcher: FSWatcher;
    try {
      watcher = fsWatch(real, { recursive: true, persistent: false });
    } catch (error) {
      throw new Error(`Recursive fs.watch unavailable for ${real}: ${(error as Error).message}`);
    }
    const previous = this.#entries.get(folderId);
    if (previous) closeEntry(previous); // replace only after the new watcher opened
    const entry: WatchEntry = { watcher, timer: null, ignored: new Map() };
    const live = () => !this.#disposed && this.#entries.get(folderId) === entry;
    const schedule = () => {
      if (!live() || entry.timer !== null) return; // coalesce: one pending trailing notify
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (live()) this.#onChanged(folderId);
      }, COALESCE_MS);
    };
    watcher.on('change', (_event, filename) => {
      if (!live()) return;
      if (changesIgnoreRules(filename)) entry.ignored.clear();
      if (!isRelevant(filename)) return;
      const folder = buildOutputFolder(filename);
      if (folder === undefined) { schedule(); return; }
      const known = entry.ignored.get(folder);
      if (known === true) return;
      if (known === false) { schedule(); return; }
      if (known === undefined) {
        if (entry.ignored.size >= MAX_IGNORE_ENTRIES) entry.ignored.clear();
        const check = gitIgnores(real, folder);
        entry.ignored.set(folder, check);
        void check.then((ignored) => {
          if (entry.ignored.get(folder) === check) entry.ignored.set(folder, ignored);
          if (!ignored) schedule();
        });
        return;
      }
      // A check is still running for this folder: notify once it says the folder is not ignored.
      void known.then((ignored) => { if (!ignored) schedule(); });
    });
    watcher.on('error', (error) => {
      if (this.#entries.get(folderId) === entry) this.#entries.delete(folderId);
      closeEntry(entry);
      this.#onError(folderId, error); // explicit: watching has stopped for this folder
    });
    this.#entries.set(folderId, entry);
    } finally { if (this.#pending.get(folderId) === token) this.#pending.delete(folderId); }
  }

  /** Stop watching `folderId`; drops any pending coalesced notification. No-op for unknown ids. */
  unwatch(folderId: string): void {
    this.#pending.delete(folderId);
    const entry = this.#entries.get(folderId);
    if (!entry) return;
    this.#entries.delete(folderId);
    closeEntry(entry);
  }

  /** Close every watcher and timer; the instance rejects further watch() calls. Idempotent. */
  dispose(): void {
    this.#disposed = true;
    this.#pending.clear();
    for (const entry of this.#entries.values()) closeEntry(entry);
    this.#entries.clear();
  }
}
