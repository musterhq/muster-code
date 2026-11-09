/**
 * #829 part 3: office previews refresh by themselves. An office file shown in the chat (an office_render result) or in
 * the file viewer redraws when the file changes on disk, whoever changed it (Excel, Numbers, Word, PowerPoint, the agent).
 *
 *  - Bounded: a file is watched only while a preview of it is on screen (the renderer adds and removes it), with at most
 *    MAX_LIVE_FILES files at once. Each file gets one fs.watch on its folder (not the file: a save that writes a temp
 *    file and renames it over the original replaces the inode a file watch would follow), filtered to its name.
 *  - Debounced: a refresh runs LIVE_DEBOUNCE_MS after the last change, so a burst of writes is one refresh.
 *  - One at a time per file: a change during a refresh gives exactly one more refresh after it.
 *  - No loops: a refresh runs only when the content changed (size and mtime first, then a SHA-256 of the bytes), so a
 *    render that reads or touches the file never triggers another.
 *  - office_render results re-render with the LibreOffice already there (never a download) into <renders>/live, one
 *    LibreOffice conversion at a time across all files; a failed render keeps the last pages.
 */
import { createHash } from 'node:crypto';
import { promises as fs, watch as fsWatch } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import type { RenderOfficeResult } from './office-render.ts';
import type { OfficeLiveSource, OfficeLiveState } from '../shared/domains/office-protocol.ts';

export const LIVE_DEBOUNCE_MS = 1000;
export const MAX_LIVE_FILES = 16;
/** Previews whose last state (and refreshed pages) are kept after they leave the screen, so a remount shows them. */
const MAX_LIVE_STATES = 64;
const MAX_LIVE_PAGES = 8;

/** Watches one folder (not recursive); `onEvent` gets the changed entry's name, or null when the platform gives none. */
export type DirWatch = (dir: string, onEvent: (filename: string | null) => void, onError: (error: Error) => void) => { close(): void };
export const watchDirectory: DirWatch = (dir, onEvent, onError) => {
  const watcher = fsWatch(dir, { persistent: false }, (_event, filename) => onEvent(filename === null ? null : String(filename)));
  watcher.on('error', onError);
  return watcher;
};

interface Signature { size: number; mtimeMs: number; ino: number; hash: string }
async function signature(file: string, previous: Signature | null): Promise<Signature | null> {
  try {
    const stat = await fs.stat(file);
    if (!stat.isFile()) return null;
    if (previous && previous.size === stat.size && previous.mtimeMs === stat.mtimeMs && previous.ino === stat.ino) return previous;
    const hash = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    return { size: stat.size, mtimeMs: stat.mtimeMs, ino: stat.ino, hash };
  } catch { return null; }
}

interface FileEntry {
  readonly file: string;
  readonly ids: Set<string>;
  handle: { close(): void } | null;
  timer: ReturnType<typeof setTimeout> | null;
  running: boolean;
  again: boolean;
  /** Ids whose preview may be older than the file: refreshed on the next run even when the content looks unchanged. */
  readonly stale: Set<string>;
  baseline: Signature | null;
  ready: Promise<void>;
  closed: boolean;
}

export interface OfficeFileWatchOptions {
  /** Runs once per settled change of `file` for the previews watching it; never twice at once for one file. */
  onChange(file: string, ids: readonly string[]): Promise<void>;
  /** The folder watch failed: the file is no longer watched. */
  onError?(file: string, ids: readonly string[], error: Error): void;
  watch?: DirWatch;
  debounceMs?: number;
  maxFiles?: number;
}

export class OfficeFileWatch {
  readonly #files = new Map<string, FileEntry>();
  readonly #fileOf = new Map<string, string>();
  readonly #options: OfficeFileWatchOptions;
  #disposed = false;
  constructor(options: OfficeFileWatchOptions) { this.#options = options; }

  /**
   * Watch `file` for the preview `id`. `since` is when the preview's pages were made: a file changed after it is
   * refreshed at once (it changed while nothing watched it). Rejects beyond the file cap.
   */
  async add(id: string, file: string, since?: number): Promise<void> {
    if (this.#disposed) throw new Error('Live previews are closed.');
    if (this.#fileOf.get(id) !== file) this.remove(id);
    let entry = this.#files.get(file);
    if (!entry) {
      if (this.#files.size >= (this.#options.maxFiles ?? MAX_LIVE_FILES)) throw new Error(`Too many live previews (${this.#options.maxFiles ?? MAX_LIVE_FILES} files); scroll some out of view.`);
      const created: FileEntry = { file, ids: new Set(), handle: null, timer: null, running: false, again: false, stale: new Set(), baseline: null, ready: Promise.resolve(), closed: false };
      entry = created;
      const name = basename(file);
      created.handle = (this.#options.watch ?? watchDirectory)(dirname(file), filename => {
        if (created.closed || (filename !== null && filename !== name)) return;
        this.#schedule(created);
      }, error => {
        if (created.closed) return;
        const ids = [...created.ids];
        this.#close(created);
        this.#options.onError?.(file, ids, error);
      });
      created.ready = signature(file, null).then(value => { created.baseline = value; });
      this.#files.set(file, created);
    }
    entry.ids.add(id);
    this.#fileOf.set(id, file);
    await entry.ready;
    if (since === undefined || entry.closed || !entry.ids.has(id)) return;
    const mtime = await fs.stat(file).then(stat => stat.mtimeMs, () => 0);
    if (mtime > since) { entry.stale.add(id); void this.#settle(entry); }
  }

  /** Stop watching for `id`; the folder watch closes with the file's last preview. */
  remove(id: string): void {
    const file = this.#fileOf.get(id);
    if (file === undefined) return;
    this.#fileOf.delete(id);
    const entry = this.#files.get(file);
    if (!entry) return;
    entry.ids.delete(id); entry.stale.delete(id);
    if (!entry.ids.size) this.#close(entry);
  }

  dispose(): void {
    this.#disposed = true;
    for (const entry of [...this.#files.values()]) this.#close(entry);
    this.#fileOf.clear();
  }

  #close(entry: FileEntry): void {
    entry.closed = true;
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
    entry.handle?.close(); entry.handle = null;
    for (const id of entry.ids) if (this.#fileOf.get(id) === entry.file) this.#fileOf.delete(id);
    if (this.#files.get(entry.file) === entry) this.#files.delete(entry.file);
  }

  #schedule(entry: FileEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => { entry.timer = null; void this.#settle(entry); }, this.#options.debounceMs ?? LIVE_DEBOUNCE_MS);
    entry.timer.unref?.();
  }

  async #settle(entry: FileEntry): Promise<void> {
    if (entry.closed) return;
    if (entry.running) { entry.again = true; return; }
    entry.running = true;
    try {
      do {
        entry.again = false;
        await entry.ready;
        const next = await signature(entry.file, entry.baseline);
        if (entry.closed) return;
        // Missing mid-save: the write that brings it back reports again.
        const changed = next !== null && next.hash !== entry.baseline?.hash;
        if (next) entry.baseline = next;
        const ids = changed ? [...entry.ids] : next ? [...entry.stale].filter(id => entry.ids.has(id)) : [];
        entry.stale.clear();
        if (!ids.length) continue;
        try { await this.#options.onChange(entry.file, ids); } catch { /* the handler reports its own failures */ }
      } while (entry.again && !entry.closed);
    } finally { entry.running = false; }
  }
}

export const LIVE_EXTS: Record<string, true> = { '.pdf': true, '.doc': true, '.docx': true, '.ppt': true, '.pptx': true, '.xls': true, '.xlsx': true, '.odt': true, '.odp': true, '.ods': true };

export interface OfficeLivePreviewsOptions {
  /** The absolute file a preview shows. Throws for an unknown chat or folder, or a path outside its folder. */
  resolve(source: OfficeLiveSource): Promise<string>;
  /** Renders with the LibreOffice already there; never downloads it. */
  render(file: string, outDir: string, maxPages: number): Promise<RenderOfficeResult>;
  /** <agent-data>/office-renders/live: refreshed pages, removed at start and on dispose. */
  dir: string;
  emit(state: OfficeLiveState): void;
  watch?: DirWatch;
  debounceMs?: number;
}

interface PreviewState { source: OfficeLiveSource; file: string; state: OfficeLiveState }
interface RenderedFile { dir: string; pages: string[]; pageCount: number }

/** The office domain's live previews: which preview shows which file, the refreshed pages and the events. */
export class OfficeLivePreviews {
  readonly #options: OfficeLivePreviewsOptions;
  readonly #watch: OfficeFileWatch;
  readonly #previews = new Map<string, PreviewState>();
  readonly #rendered = new Map<string, RenderedFile>();
  /** One LibreOffice conversion at a time across every file. */
  #queue: Promise<unknown> = Promise.resolve();
  #sequence = 0;
  #cleared: Promise<void>;
  constructor(options: OfficeLivePreviewsOptions) {
    this.#options = options;
    this.#cleared = fs.rm(options.dir, { recursive: true, force: true }).catch(() => undefined);
    this.#watch = new OfficeFileWatch({
      watch: options.watch, debounceMs: options.debounceMs,
      onChange: (file, ids) => this.#refresh(file, ids),
      onError: (_file, ids, error) => { for (const id of ids) this.#update(id, { phase: 'failed', error: `Stopped watching: ${error.message}` }); },
    });
  }

  async watch(id: string, source: OfficeLiveSource, since?: number): Promise<OfficeLiveState> {
    const file = await this.#options.resolve(source);
    if (!(extname(file).toLowerCase() in LIVE_EXTS)) throw new Error(`Cannot preview ${extname(file) || 'this file'}: supported are pdf, doc, docx, ppt, pptx, xls, xlsx, odt, odp, ods.`);
    const known = this.#previews.get(id);
    const preview: PreviewState = known && known.file === file ? { ...known, source } : { source, file, state: { id, phase: 'watching', version: 0 } };
    this.#previews.delete(id); this.#previews.set(id, preview);
    this.#trim();
    await this.#watch.add(id, file, since);
    return preview.state;
  }

  unwatch(id: string): void { this.#watch.remove(id); }

  /** The refreshed pages of an office_render preview as data URLs; empty until its first refresh. */
  async pages(id: string): Promise<{ pages: string[]; pageCount: number; version: number }> {
    const preview = this.#previews.get(id);
    const rendered = preview && preview.source.kind === 'render' && preview.state.version > 0 ? this.#rendered.get(preview.file) : undefined;
    if (!preview || !rendered || preview.source.kind !== 'render') return { pages: [], pageCount: 0, version: preview?.state.version ?? 0 };
    const pages: string[] = [];
    for (const page of rendered.pages.slice(0, livePages(preview.source.pages))) pages.push(`data:image/png;base64,${(await fs.readFile(page)).toString('base64')}`);
    return { pages, pageCount: rendered.pageCount, version: preview.state.version };
  }

  dispose(): void {
    this.#watch.dispose();
    this.#previews.clear(); this.#rendered.clear();
    void this.#cleared.then(() => fs.rm(this.#options.dir, { recursive: true, force: true })).catch(() => undefined);
  }

  #update(id: string, change: Partial<OfficeLiveState>): void {
    const preview = this.#previews.get(id);
    if (!preview) return;
    const { error: _previous, ...rest } = preview.state;
    preview.state = { ...rest, ...change, id };
    this.#options.emit(preview.state);
  }

  async #refresh(file: string, ids: readonly string[]): Promise<void> {
    const renders = ids.filter(id => this.#previews.get(id)?.source.kind === 'render');
    // The file viewer reads the file itself; it only needs to hear that it changed.
    for (const id of ids) if (!renders.includes(id)) { const version = (this.#previews.get(id)?.state.version ?? 0) + 1; this.#update(id, { phase: 'updated', version, updatedAt: new Date().toISOString() }); }
    if (!renders.length) return;
    for (const id of renders) this.#update(id, { phase: 'rendering' });
    const maxPages = Math.max(...renders.map(id => { const source = this.#previews.get(id)?.source; return source?.kind === 'render' ? livePages(source.pages) : 1; }));
    const job = this.#queue.then(async () => {
      await this.#cleared;
      const outDir = join(this.#options.dir, `${Date.now().toString(36)}-${(++this.#sequence).toString(36)}`);
      try {
        const result = await this.#options.render(file, outDir, maxPages);
        const previous = this.#rendered.get(file);
        this.#rendered.set(file, { dir: outDir, pages: result.pages, pageCount: result.pageCount });
        if (previous) void fs.rm(previous.dir, { recursive: true, force: true }).catch(() => undefined);
        const updatedAt = new Date().toISOString();
        for (const id of renders) this.#update(id, { phase: 'updated', version: (this.#previews.get(id)?.state.version ?? 0) + 1, updatedAt, pageCount: result.pageCount });
      } catch (error) {
        await fs.rm(outDir, { recursive: true, force: true }).catch(() => undefined);
        const message = error instanceof Error ? error.message : String(error);
        for (const id of renders) this.#update(id, { phase: 'failed', error: message });
      }
    });
    this.#queue = job.catch(() => undefined);
    await job;
  }

  /** Forget the oldest previews beyond the bound, and the pages no kept preview shows. */
  #trim(): void {
    while (this.#previews.size > MAX_LIVE_STATES) {
      const oldest = this.#previews.keys().next().value as string;
      this.#watch.remove(oldest);
      this.#previews.delete(oldest);
    }
    const shown = new Set([...this.#previews.values()].map(preview => preview.file));
    for (const [file, rendered] of this.#rendered) if (!shown.has(file)) { this.#rendered.delete(file); void fs.rm(rendered.dir, { recursive: true, force: true }).catch(() => undefined); }
  }
}

const livePages = (pages: number) => Math.min(MAX_LIVE_PAGES, Math.max(1, Number.isInteger(pages) ? pages : 1));
