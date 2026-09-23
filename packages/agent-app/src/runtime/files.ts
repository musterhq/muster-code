/** Scoped folder browsing: bounded listings and bounded text reads. */
import { promises as fs, type Dir } from 'node:fs';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { join, relative } from 'node:path';
import type { FileEntry } from '../shared/protocol.ts';
import { resolveInside } from './paths.ts';

const MAX_ENTRIES = 2_000;
/** Directory entries inspected before a listing stops; sorting happens over everything inspected. */
const MAX_SCANNED = 50_000;
const naturalOrder = new Intl.Collator(undefined, {numeric: true, sensitivity: 'base'});
const MAX_TEXT_BYTES = 512 * 1024;
const MAX_TABLE_BYTES = 4 * 1024 * 1024;
const OFFICE_EXTENSIONS = /\.(?:docx?|dotx?|xlsx?|xlsm|xlsb|pptx?|potx?|ppsx|od[tp])$/i;

function isOfficeOwnerFile(name: string): boolean {
  return name.startsWith('~$') && OFFICE_EXTENSIONS.test(name.slice(2));
}

function looksBinary(buffer: Buffer): boolean {
  const probe = buffer.subarray(0, 8_192);
  return probe.includes(0);
}

/** True when `buffer` contains a byte sequence that is not valid UTF-8 (a non-fatal decode would silently replace it). */
function hasInvalidUtf8(buffer: Buffer): boolean {
  try { new TextDecoder('utf-8', {fatal: true}).decode(buffer); return false; }
  catch { return true; }
}

function fileRevision(stat: {mtimeMs: number; size: number}): string {
  return `${stat.mtimeMs.toString(36)}:${stat.size.toString(36)}`;
}

/** Left out of the tree by default, as VS Code's `files.exclude` does: version-control internals and OS
 *  litter. Every other dotfile (.env, .github, .eslintrc…) is real project content and always listed.
 *  The Files tab's "Show .git and system files" toggle lists these too (WRK-06). */
export const DEFAULT_HIDDEN_NAMES: ReadonlySet<string> = new Set(['.git', '.svn', '.hg', 'CVS', '.DS_Store', 'Thumbs.db']);

export async function listFiles(root: string, rel: string, options: { showHidden?: boolean } = {}): Promise<FileEntry[]> {
  const abs = await resolveInside(root, rel);
  const realRoot = await fs.realpath(root);
  const logicalPath = relative(realRoot,abs);
  const dirents = await fs.opendir(abs);
  const entries: FileEntry[] = [];
  let scanned = 0;
  for await (const dirent of dirents) {
    if (++scanned > MAX_SCANNED) break;
    if (!options.showHidden && DEFAULT_HIDDEN_NAMES.has(dirent.name)) continue;
    // Office creates a small `~$...` lock/owner file while a workbook or
    // document is open. It is implementation noise, not a user document.
    if (isOfficeOwnerFile(dirent.name)) continue;
    if (!dirent.isFile() && !dirent.isDirectory() && !dirent.isSymbolicLink()) continue;
    let kind: FileEntry['kind'] = dirent.isDirectory() ? 'directory' : 'file';
    if (dirent.isSymbolicLink()) {
      // Only symlinks that stay inside the root are shown, typed by their target.
      try {
        const real = await resolveInside(root, join(rel, dirent.name));
        kind = (await fs.stat(real)).isDirectory() ? 'directory' : 'file';
      } catch {
        continue;
      }
    }
    entries.push({ name: dirent.name, path: join(logicalPath,dirent.name), kind });
  }
  // Sort before truncating so a large directory shows its first entries, not an arbitrary subset:
  // directories first, then files, each in natural order (file2 before file10).
  entries.sort((a, b) => (a.kind === b.kind ? naturalOrder.compare(a.name, b.name) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0) : a.kind === 'directory' ? -1 : 1));
  return entries.slice(0, MAX_ENTRIES);
}

export async function readFile(root: string, rel: string): Promise<{ path: string; text: string; truncated: boolean; revision: string; encodingWarning: boolean }> {
  const abs = await resolveInside(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
  const handle = await fs.open(abs, 'r');
  try {
    const table = /\.(csv|tsv)$/i.test(rel);
    const limit = table ? MAX_TABLE_BYTES : MAX_TEXT_BYTES;
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const shown = buffer.subarray(0, Math.min(bytesRead, limit));
    // Excel Unicode Text exports have a UTF-16 BOM. Never guess binary encoding.
    const utf16 = table && shown.length >= 2 && (shown[0] === 255 && shown[1] === 254 ? 'utf-16le' : shown[0] === 254 && shown[1] === 255 ? 'utf-16be' : '');
    if (!utf16 && looksBinary(shown)) throw new Error(`Binary file (no text preview): ${rel}`);
    const text = utf16 ? new TextDecoder(utf16).decode(shown) : shown.toString('utf8');
    return { path: rel, text, truncated: bytesRead > limit, revision: fileRevision(stat), encodingWarning: !utf16 && hasInvalidUtf8(shown) };

  } finally {
    await handle.close();
  }
}

/** Full-file read up to 10MB, for "Load full file" on a truncated preview. Never renders binary. */
export async function readFileFull(root: string, rel: string): Promise<{ path: string; text: string; truncated: boolean; revision: string; encodingWarning: boolean }> {
  const abs = await resolveInside(root, rel);
  const stat = await fs.stat(abs);
  if (!stat.isFile()) throw new Error(`Not a file: ${rel}`);
  const limit = 10 * 1024 * 1024;
  const handle = await fs.open(abs, 'r');
  try {
    const buffer = Buffer.alloc(Math.min(stat.size, limit + 1));
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
      if (!chunk.bytesRead) break;
      bytesRead += chunk.bytesRead;
    }
    const shown = buffer.subarray(0, Math.min(bytesRead, limit));
    if (looksBinary(shown)) throw new Error(`Binary file (no text preview): ${rel}`);
    return { path: rel, text: shown.toString('utf8'), truncated: bytesRead > limit, revision: fileRevision(stat), encodingWarning: hasInvalidUtf8(shown) };
  } finally {
    await handle.close();
  }
}

/** Atomic write via a temp file and rename; refuses when `expectedRevision` no longer matches the file on disk. */
export async function writeFile(root: string, rel: string, text: string, expectedRevision?: string): Promise<{ conflict: true } | { conflict: false; revision: string }> {
  const abs = await resolveInside(root, rel);
  if (expectedRevision !== undefined) {
    let current: string | undefined;
    try { current = fileRevision(await fs.stat(abs)); } catch { current = undefined; }
    if (current !== expectedRevision) return { conflict: true };
  }
  const tmp = `${abs}.muster-tmp-${randomBytes(6).toString('hex')}`;
  await fs.writeFile(tmp, text, 'utf8');
  try { await fs.rename(tmp, abs); }
  catch (error) { await fs.rm(tmp, {force: true}).catch(() => {}); throw error; }
  return { conflict: false, revision: fileRevision(await fs.stat(abs)) };
}

/** Bounded on-demand search; never indexes the workspace in the background. */
export async function searchFiles(root: string, rel: string, query: string): Promise<{entries: FileEntry[]; truncated: boolean}> {
  if (!query.trim() || query.length > 256) throw new Error('Enter a file name of 1–256 characters.');
  await resolveInside(root, rel);
  const pending = [rel], entries: FileEntry[] = [];
  const needle = query.trim().toLowerCase();
  let inspected = 0, directories = 0, partial = false;
  while (pending.length && directories < 200 && inspected < 10_000) {
    const path = pending.shift()!;
    let directory: Dir;
    try {directory = await fs.opendir(await resolveInside(root,path));}
    catch (error) {if (!directories) throw error; partial = true; continue;}
    directories++;
    for await (const entry of directory) {
      if (++inspected > 10_000) return {entries,truncated:true};
      if (entry.name === '.git') continue;
      if (isOfficeOwnerFile(entry.name)) continue;
      // Do not walk symlinks: no cycles or unexpected traversal during search.
      if (entry.isSymbolicLink()) {partial = true; continue;}
      const child = join(path,entry.name);
      if (entry.isDirectory()) {if(pending.length < 200) pending.push(child); else partial = true;}
      else if (entry.isFile() && child.toLowerCase().includes(needle)) {
        entries.push({name:entry.name,path:child,kind:'file'});
        if (entries.length === 100) return {entries,truncated:true};
      }
    }
  }
  return {entries,truncated:partial || pending.length > 0};
}

// ---------------------------------------------------------------------------
// Content search (WRK-08): ripgrep when present, a bounded JS walk otherwise.

export interface ContentMatch { path: string; line: number; text: string }
export interface ContentSearchResult { matches: ContentMatch[]; truncated: boolean }
export interface ContentSearchOptions { regex?: boolean; caseSensitive?: boolean; glob?: string; requestId?: string }

const SEARCH_CAP = 500;
const SEARCH_TIMEOUT_MS = 5_000;
const EXCLUDED_DIRS = new Set(['node_modules', '.git', 'dist', 'build']);
const searchControllers = new Map<string, AbortController>();

/** Cancels an in-flight `searchContent` call started with the same `requestId`. */
export function cancelContentSearch(requestId: string): void {
  searchControllers.get(requestId)?.abort();
}

let ripgrepAvailable: boolean | undefined;
async function hasRipgrep(): Promise<boolean> {
  if (ripgrepAvailable !== undefined) return ripgrepAvailable;
  ripgrepAvailable = await new Promise<boolean>(resolvePromise => {
    try {
      const probe = spawn('rg', ['--version'], {stdio: 'ignore'});
      probe.on('error', () => resolvePromise(false));
      probe.on('exit', code => resolvePromise(code === 0));
    } catch { resolvePromise(false); }
  });
  return ripgrepAvailable;
}

function searchWithRipgrep(base: string, query: string, options: ContentSearchOptions, signal: AbortSignal): Promise<ContentSearchResult> {
  const args = ['--line-number', '--no-heading', '--color', 'never', '-m', String(SEARCH_CAP)];
  if (!options.caseSensitive) args.push('-i');
  if (!options.regex) args.push('--fixed-strings');
  if (options.glob) args.push('--glob', options.glob);
  args.push('--', query, '.');
  return new Promise((resolvePromise, rejectPromise) => {
    let child: ReturnType<typeof spawn>;
    try { child = spawn('rg', args, {cwd: base, signal, timeout: SEARCH_TIMEOUT_MS}); }
    catch (error) { rejectPromise(error); return; }
    let buffered = '';
    const matches: ContentMatch[] = [];
    let truncated = false;
    child.stdout?.on('data', (chunk: Buffer) => {
      buffered += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffered.indexOf('\n')) >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        const match = /^(.*?):(\d+):(.*)$/.exec(line);
        if (!match) continue;
        if (matches.length < SEARCH_CAP) matches.push({path: match[1], line: Number(match[2]), text: match[3].slice(0, 500)});
        else truncated = true;
      }
    });
    child.on('error', error => { if ((error as NodeJS.ErrnoException).code === 'ABORT_ERR') resolvePromise({matches, truncated: true}); else rejectPromise(error); });
    child.on('close', (code, signalName) => {
      if (signalName) truncated = true;
      resolvePromise({matches, truncated: truncated || matches.length >= SEARCH_CAP});
    });
  });
}

async function searchWithJs(base: string, query: string, options: ContentSearchOptions, signal: AbortSignal): Promise<ContentSearchResult> {
  const deadline = Date.now() + SEARCH_TIMEOUT_MS;
  let pattern: RegExp | null = null;
  try { pattern = options.regex ? new RegExp(query, options.caseSensitive ? 'g' : 'gi') : null; } catch { throw new Error('Invalid regular expression.'); }
  const needle = options.caseSensitive ? query : query.toLowerCase();
  const matches: ContentMatch[] = [];
  let truncated = false, inspected = 0;
  const pending = [''];
  while (pending.length && matches.length < SEARCH_CAP) {
    if (signal.aborted || Date.now() > deadline) { truncated = true; break; }
    const dir = pending.shift()!;
    let entries;
    try { entries = await fs.readdir(await resolveInside(base, dir), {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name === '.git') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { pending.push(rel); continue; }
      if (!entry.isFile()) continue;
      if (++inspected > 20_000) { truncated = true; break; }
      let text: string;
      try {
        const buffer = await fs.readFile(join(base, rel));
        if (looksBinary(buffer)) continue;
        text = buffer.toString('utf8');
      } catch { continue; }
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const found = pattern ? (pattern.lastIndex = 0, pattern.test(lines[i])) : lines[i].toLowerCase().includes(needle);
        if (!found) continue;
        matches.push({path: rel, line: i + 1, text: lines[i].slice(0, 500)});
        if (matches.length >= SEARCH_CAP) { truncated = true; break; }
      }
      if (matches.length >= SEARCH_CAP || Date.now() > deadline) { truncated = true; break; }
    }
  }
  return {matches, truncated: truncated || pending.length > 0};
}

export async function searchContent(root: string, rel: string, query: string, options: ContentSearchOptions = {}): Promise<ContentSearchResult> {
  if (!query || query.length > 512) throw new Error('Enter a search of 1–512 characters.');
  const base = await resolveInside(root, rel);
  const controller = new AbortController();
  if (options.requestId) searchControllers.set(options.requestId, controller);
  try {
    return await (await hasRipgrep() ? searchWithRipgrep(base, query, options, controller.signal) : searchWithJs(base, query, options, controller.signal));
  } finally {
    if (options.requestId) searchControllers.delete(options.requestId);
  }
}

// ---------------------------------------------------------------------------
// Quick open (WRK-08): a cached file list per root, scored fzf-style.

const QUICK_OPEN_TTL_MS = 30_000;
const QUICK_OPEN_MAX_FILES = 20_000;
const quickOpenCache = new Map<string, {files: string[]; expires: number}>();

async function listAllFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [''];
  while (pending.length && files.length < QUICK_OPEN_MAX_FILES) {
    const dir = pending.shift()!;
    let entries;
    try { entries = await fs.readdir(await resolveInside(root, dir), {withFileTypes: true}); } catch { continue; }
    for (const entry of entries) {
      if (EXCLUDED_DIRS.has(entry.name) || entry.name === '.git') continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) { pending.push(rel); continue; }
      if (entry.isFile()) files.push(rel);
      if (files.length >= QUICK_OPEN_MAX_FILES) break;
    }
  }
  return files;
}

/** fzf-like subsequence scoring: rewards contiguous runs and matches at word/path boundaries. Returns null when `query` is not a subsequence of `path`. */
export function scoreQuickOpen(path: string, query: string): number | null {
  if (!query) return 0;
  const hay = path;
  let cursor = 0, score = 0, streak = 0;
  for (let i = 0; i < query.length; i++) {
    const needleChar = query[i].toLowerCase();
    let found = -1;
    for (let scan = cursor; scan < hay.length; scan++) {
      if (hay[scan].toLowerCase() === needleChar) { found = scan; break; }
    }
    if (found === -1) return null;
    const exact = hay[found] === query[i];
    const boundary = found === 0 || /[/_.\-\s]/.test(hay[found - 1]);
    const contiguous = found === cursor;
    streak = contiguous ? streak + 1 : 0;
    score += 1 + (exact ? 1 : 0) + (boundary ? 3 : 0) + streak;
    cursor = found + 1;
  }
  // Shorter paths, and matches that land in the filename, rank higher.
  score += Math.max(0, 20 - hay.length * 0.05);
  const name = hay.slice(hay.lastIndexOf('/') + 1);
  if (name.toLowerCase().includes(query.toLowerCase())) score += 10;
  return score;
}

export async function quickOpen(root: string, query: string): Promise<Array<{path: string; score: number}>> {
  const cached = quickOpenCache.get(root);
  const files = cached && cached.expires > Date.now() ? cached.files : await listAllFiles(root).then(list => { quickOpenCache.set(root, {files: list, expires: Date.now() + QUICK_OPEN_TTL_MS}); return list; });
  const needle = query.trim();
  if (!needle) return files.slice(0, 50).map(path => ({path, score: 0}));
  const scored: Array<{path: string; score: number}> = [];
  for (const path of files) {
    const score = scoreQuickOpen(path, needle);
    if (score !== null) scored.push({path, score});
  }
  scored.sort((a, b) => b.score - a.score || a.path.length - b.path.length);
  return scored.slice(0, 50);
}
