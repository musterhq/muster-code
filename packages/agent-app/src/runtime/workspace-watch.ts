/**
 * Bounded per-folder change watcher. One recursive fs.watch per distinct
 * folder id (macOS FSEvents backs `recursive: true`); re-watching an id
 * replaces the old root only after the new watcher opened. Bursts coalesce
 * into a single trailing notification (~150ms): each root holds at most one
 * pending timer and no event queue, so memory stays O(active roots), which is
 * capped at MAX_WATCHED_ROOTS with an explicit error beyond it.
 *
 * Noise from node_modules/build output and .git internals is dropped, but
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
import { sep } from 'node:path';

export const MAX_WATCHED_ROOTS = 32;
export const COALESCE_MS = 150;

/** Any path containing one of these segments is dropped (dir or file). */
const IGNORED_SEGMENTS: Record<string, true> = {
  node_modules: true,
  '.DS_Store': true,
};
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
}

function isRelevant(filename: string | Buffer | null): boolean {
  if (filename === null) return true; // platform gave no path: refresh conservatively
  const name = typeof filename === 'string' ? filename : filename.toString();
  const segments = name.split(sep);
  if (segments[0] === '.git') {
    return (
      (segments.length === 2 && GIT_REVIEW_FILES[segments[1]] === true) ||
      (segments.length > 2 && segments[1] === 'refs')
    );
  }
  return !segments.some((segment) => IGNORED_SEGMENTS[segment] === true);
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
    const entry: WatchEntry = { watcher, timer: null };
    watcher.on('change', (_event, filename) => {
      if (this.#disposed || this.#entries.get(folderId) !== entry || entry.timer !== null || !isRelevant(filename)) return; // coalesce: one pending trailing notify
      entry.timer = setTimeout(() => {
        entry.timer = null;
        if (!this.#disposed && this.#entries.get(folderId) === entry) this.#onChanged(folderId);
      }, COALESCE_MS);
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
