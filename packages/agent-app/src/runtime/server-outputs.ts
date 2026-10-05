/**
 * Outputs of a connected server project on this Mac. The server lists documents, attachments and work products; this file holds the
 * parts that need no network: the private per-server cache (a folder per origin, mode 0700; files 0600; names sanitised), the 50 MB cap,
 * the type of a file, and the rule for finding the same file in the folder bound for Work locally.
 */
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { basename, extname, isAbsolute, join, posix, resolve, sep } from 'node:path';
import { resolveInside } from './paths.ts';

/** The most one output may weigh (what the server says, and what actually arrives). */
export const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;
export const PREVIEW_TEXT_BYTES = 2 * 1024 * 1024, PREVIEW_IMAGE_BYTES = 10 * 1024 * 1024;

/** A name that is safe as one file name in the cache: no separators, no control characters, no leading dots, bounded. */
export function sanitizeOutputName(name: unknown, fallback = 'output'): string {
  let text = typeof name === 'string' ? name : '';
  text = basename(text.replace(/\\/g, '/')).normalize('NFC').replace(/[\u0000-\u001f\u007f<>:"|?*\\/]/g, '_').replace(/\s+/g, ' ').trim().replace(/^\.+/, '').replace(/[. ]+$/, '');
  if (!text || text === '_') text = fallback;
  if (text.length > 120) { const ext = extname(text).slice(0, 12); text = `${text.slice(0, 120 - ext.length)}${ext}`; }
  return text;
}

const EXT: Record<string, string> = { 'text/markdown': '.md', 'text/plain': '.txt', 'text/html': '.html', 'text/csv': '.csv', 'application/json': '.json', 'application/pdf': '.pdf', 'image/png': '.png', 'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp', 'image/svg+xml': '.svg', 'video/mp4': '.mp4' };
const MIME: Record<string, string> = Object.fromEntries(Object.entries(EXT).map(([mime, ext]) => [ext, mime]).concat([['.jpeg', 'image/jpeg'], ['.markdown', 'text/markdown'], ['.log', 'text/plain'], ['.yml', 'text/yaml'], ['.yaml', 'text/yaml'], ['.ts', 'text/plain'], ['.tsx', 'text/plain'], ['.js', 'text/plain'], ['.py', 'text/plain'], ['.xml', 'application/xml'], ['.mov', 'video/quicktime']]));

/** The type of a file: the server's own (without parameters) unless it is generic, else the name's extension. */
export function outputMime(header: string | null | undefined, name: string): string {
  const declared = (header ?? '').split(';')[0]!.trim().toLowerCase();
  if (declared && declared !== 'application/octet-stream') return declared;
  return MIME[extname(name).toLowerCase()] ?? 'application/octet-stream';
}
/** A name that carries an extension for its type (a document called "Plan" is saved as Plan.md). */
export function nameWithExtension(name: string, mime: string): string {
  const ext = EXT[mime];
  return ext && !extname(name) ? `${name}${ext}` : name;
}
const isText = (mime: string) => mime.startsWith('text/') || /(^application\/(json|xml|yaml|markdown|x-yaml)|\+(json|xml)$)/.test(mime);
export const previewKind = (mime: string): 'text' | 'image' | 'binary' => isText(mime) ? 'text' : /^image\/(png|jpeg|gif|webp)$/.test(mime) ? 'image' : 'binary';

/** `<data dir>/server-outputs/<origin hash>`: one private folder per server, so one server's files are never another's. */
export function outputCacheRoot(dataDir: string, origin: string): string {
  return join(dataDir, 'server-outputs', createHash('sha256').update(origin).digest('hex').slice(0, 16));
}
async function privateDir(dir: string): Promise<void> { await fs.mkdir(dir, { recursive: true, mode: 0o700 }); await fs.chmod(dir, 0o700).catch(() => undefined); }

/** Writes an output into the origin's cache (dirs 0700, file 0600) and returns the path. One folder per output id, so two outputs with one name never collide. */
export async function storeOutput(root: string, id: string, name: string, bytes: Uint8Array, maxBytes = MAX_OUTPUT_BYTES): Promise<string> {
  if (bytes.byteLength > maxBytes) throw new OutputTooLarge(bytes.byteLength, maxBytes);
  const folder = join(root, createHash('sha256').update(id).digest('hex').slice(0, 24));
  await privateDir(join(root, '..')); await privateDir(root); await privateDir(folder);
  const file = join(folder, sanitizeOutputName(name));
  await fs.writeFile(file, bytes, { mode: 0o600 });
  await fs.chmod(file, 0o600).catch(() => undefined);
  return file;
}
/** A cached copy of an output made earlier, if any (the first file in its folder). */
export async function cachedOutput(root: string, id: string): Promise<string | null> {
  const folder = join(root, createHash('sha256').update(id).digest('hex').slice(0, 24));
  const names = await fs.readdir(folder).catch(() => [] as string[]);
  const first = names.sort()[0];
  return first ? join(folder, first) : null;
}
export class OutputTooLarge extends Error {
  constructor(readonly size: number, readonly limit: number) { super(`This output is ${(size / 1048576).toFixed(size >= 10485760 ? 0 : 1)} MB, over the ${Math.round(limit / 1048576)} MB Muster opens. Use Open on server instead.`); this.name = 'OutputTooLarge'; }
}

/** The project-relative part of a path a server work product names, or null when it cannot be told. `workspaceRoots`: the project's own folders on the server. */
export function projectRelativePath(openPath: string, workspaceRoots: readonly string[]): string | null {
  if (!openPath || openPath.includes('\0') || /^[a-z][a-z0-9+.-]*:\/\//i.test(openPath) || openPath.length > 4096) return null;
  const clean = (rel: string): string | null => {
    const normal = posix.normalize(rel.replace(/\\/g, '/')).replace(/^\.\//, '').replace(/^\/+/, '');
    return !normal || normal === '.' || normal.split('/').includes('..') ? null : normal;
  };
  const path = openPath.replace(/\\/g, '/');
  if (!path.startsWith('/')) return clean(path);
  for (const root of workspaceRoots) {
    const base = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (base && path.startsWith(`${base}/`)) return clean(path.slice(base.length + 1));
  }
  // A server's own managed workspace: .../workspaces/<id>/<project-relative path>.
  const managed = /\/workspaces\/[^/]+\/(.+)$/.exec(path);
  return managed ? clean(managed[1]!) : null;
}

/** The same file in the bound local folder, or null when it is not there. Symlink and `..` escapes never resolve. */
export async function localOutput(bound: string, rel: string): Promise<{ path: string; size: number } | null> {
  let real: string;
  try { real = await resolveInside(bound, rel); } catch { return null; }
  const stat = await fs.stat(real).catch(() => null);
  return stat?.isFile() ? { path: real, size: stat.size } : null;
}

/** Reads a cached output for the viewer. Only a file inside this origin's cache can be read; nothing is written. */
export async function previewOutput(roots: readonly string[], path: string): Promise<{ kind: 'text' | 'image' | 'binary'; name: string; mime: string; size: number; text?: string; dataUrl?: string; truncated?: boolean }> {
  if (typeof path !== 'string' || !path || path.includes('\0') || !isAbsolute(path)) throw new Error('Choose an output to view.');
  const target = resolve(path);
  const root = roots.find(r => target.startsWith(resolve(r) + sep));
  if (!root) throw new Error('Only files Muster downloaded from the server can be viewed here.');
  const real = await resolveInside(root, target.slice(resolve(root).length + 1)).catch(() => { throw new Error('This file is no longer in the cache. Open it again.'); });
  const stat = await fs.stat(real).catch(() => null);
  if (!stat?.isFile()) throw new Error('This file is no longer in the cache. Open it again.');
  const name = basename(real), mime = outputMime(null, name), kind = previewKind(mime);
  if (kind === 'text') {
    const handle = await fs.open(real, 'r');
    try {
      const length = Math.min(stat.size, PREVIEW_TEXT_BYTES), buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      const bytes = buffer.subarray(0, bytesRead);
      if (!bytes.subarray(0, 8192).includes(0)) return { kind, name, mime, size: stat.size, text: bytes.toString('utf8'), truncated: stat.size > PREVIEW_TEXT_BYTES };
    } finally { await handle.close(); }
    return { kind: 'binary', name, mime, size: stat.size };
  }
  if (kind === 'image' && stat.size <= PREVIEW_IMAGE_BYTES) return { kind, name, mime, size: stat.size, dataUrl: `data:${mime};base64,${(await fs.readFile(real)).toString('base64')}` };
  return { kind: 'binary', name, mime, size: stat.size };
}
