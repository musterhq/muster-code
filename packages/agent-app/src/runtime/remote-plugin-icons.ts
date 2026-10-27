/** #729: installed remote plugins that ship no logo on disk (Atlassian) get the logo Codex lists for them in `plugin/list`.
 *  The images are downloaded in the background, kept under the data dir and read back through the same checks as a
 *  plugin's own icon files; a plugin with nothing usable keeps its monogram. A plugin from another marketplace with no
 *  logo borrows the one an OpenAI catalog lists under its exact name (brandIconFiles). */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appBundleBinaries, locateCli } from './adapters/shared.ts';

export interface RemoteIconFiles { dir: string; light?: string; dark?: string }
interface IndexEntry { light?: { url: string; file: string }; dark?: { url: string; file: string } }
/** `brands` holds logos borrowed by name from the OpenAI catalogs; `brandsChecked` every name already looked up there. */
interface IconIndex { version: 1; checkedAt: number; icons: Record<string, IndexEntry>; brands?: Record<string, IndexEntry>; brandsChecked?: string[] }
/** `delayMs`: first refresh after start; `topUpDelayMs`: a lookup of newly asked brand names after that. */
export interface RemoteIconOptions { delayMs?: number; topUpDelayMs?: number; listPlugins?: () => Promise<unknown>; fetch?: typeof fetch; now?: () => number }

const REFRESH_MS = 7 * 24 * 60 * 60 * 1000;
const RETRY_MS = 6 * 60 * 60 * 1000;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MAX_PLUGINS = 200;
const LIST_TIMEOUT_MS = 90_000;
const FETCH_TIMEOUT_MS = 15_000;
/** Brand names ever looked up. Past this, new names are not queued (never evicted, so nothing is looked up twice). */
const MAX_BRANDS = 1024;
const BRAND_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

let store: string | undefined;
let index: IconIndex | null = null;

const wanted = new Set<string>();
let onWanted: (() => void) | null = null;

export function setRemoteIconStore(dir: string | undefined): void { store = dir; index = null; wanted.clear(); }
/** Called when a plugin with no logo asks for a brand name nobody has looked up yet. */
export function onBrandWanted(callback: (() => void) | null): void { onWanted = callback; }

function loadIndex(): IconIndex | null {
  if (!store) return null;
  if (index) return index;
  try {
    const parsed = JSON.parse(readFileSync(join(store, 'index.json'), 'utf8')) as IconIndex;
    if (parsed?.version === 1 && parsed.icons && typeof parsed.icons === 'object') index = parsed;
  } catch { /* No cache yet. */ }
  return index;
}

/** The cached logo files for `<plugin>@<provenance>`, or null. Files are read back with readIcon, which validates them. */
export function remoteIconFiles(pluginName: string, provenance: string): RemoteIconFiles | null {
  const entry = loadIndex()?.icons[`${pluginName}@${provenance}`];
  if (!store || !entry || (!entry.light && !entry.dark)) return null;
  return { dir: store, ...(entry.light ? { light: entry.light.file } : {}), ...(entry.dark ? { dark: entry.dark.file } : {}) };
}

/**
 * #729: a plugin from another marketplace that ships no logo (the Claude marketplace's linear, gitlab, firebase) uses the
 * one an OpenAI catalog lists under the same name. A name not looked up yet is queued for the next refresh.
 */
export function brandIconFiles(pluginName: string): RemoteIconFiles | null {
  const name = pluginName.toLowerCase(), current = loadIndex();
  if (!store || !BRAND_NAME.test(name)) return null;
  const entry = current?.brands?.[name];
  if (entry && (entry.light || entry.dark)) return { dir: store, ...(entry.light ? { light: entry.light.file } : {}), ...(entry.dark ? { dark: entry.dark.file } : {}) };
  if (!current?.brandsChecked?.includes(name) && !wanted.has(name) && (current?.brandsChecked?.length ?? 0) + wanted.size < MAX_BRANDS) { wanted.add(name); onWanted?.(); }
  return null;
}

const httpsUrl = (value: unknown): string | undefined => {
  if (typeof value !== 'string' || value.length > 4096) return undefined;
  try { return new URL(value).protocol === 'https:' ? value : undefined; } catch { return undefined; }
};
const record = (value: unknown): Record<string, unknown> | null => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

type LogoUrls = { light?: string; dark?: string };
/** Every plugin row of a `plugin/list` result with an https logo, with its marketplace. */
function* logoRows(listing: unknown): Generator<{ id: string; marketplace: string; installed: boolean; urls: LogoUrls }> {
  const marketplaces = record(listing)?.marketplaces;
  for (const market of Array.isArray(marketplaces) ? marketplaces : []) {
    const marketplace = record(market)?.name, plugins = record(market)?.plugins;
    for (const value of Array.isArray(plugins) ? plugins : []) {
      const row = record(value), face = record(row?.interface);
      if (!row || typeof row.id !== 'string' || !/^[^@/\\\0]{1,200}@[^@/\\\0]{1,200}$/.test(row.id) || !face) continue;
      const light = httpsUrl(face.composerIconUrl) ?? httpsUrl(face.logoUrl), dark = httpsUrl(face.logoUrlDark);
      if (light || dark) yield { id: row.id, marketplace: typeof marketplace === 'string' ? marketplace : row.id.slice(row.id.indexOf('@') + 1), installed: row.installed === true, urls: { ...(light ? { light } : {}), ...(dark ? { dark } : {}) } };
    }
  }
}

/** Installed plugins in a `plugin/list` result with an https logo, keyed `<name>@<marketplace>`. */
export function remoteIconUrls(listing: unknown): Map<string, LogoUrls> {
  const urls = new Map<string, LogoUrls>();
  for (const row of logoRows(listing)) {
    if (!row.installed) continue;
    urls.set(row.id, row.urls);
    if (urls.size >= MAX_PLUGINS) break;
  }
  return urls;
}

/** For each wanted name, the logo an OpenAI catalog (`openai-*`) lists for a plugin of exactly that name, installed or not. */
export function brandIconUrls(listing: unknown, names: ReadonlySet<string>): Map<string, LogoUrls> {
  const urls = new Map<string, LogoUrls>();
  for (const row of logoRows(listing)) {
    const name = row.id.slice(0, row.id.indexOf('@')).toLowerCase();
    if (row.marketplace.startsWith('openai-') && names.has(name) && !urls.has(name)) urls.set(name, row.urls);
  }
  return urls;
}

/** The image type from its first bytes; anything else is refused. */
function imageExtension(bytes: Buffer): string | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return '.png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return '.jpg';
  if (bytes.subarray(0, 4).toString('latin1') === 'GIF8') return '.gif';
  if (bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP') return '.webp';
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(bytes.subarray(0, 1024).toString('utf8'))) return '.svg';
  return null;
}

async function download(url: string, fetchImpl: typeof fetch): Promise<{ bytes: Buffer; ext: string } | null> {
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok || !response.body) return null;
    if (response.url && !response.url.startsWith('https:')) return null;
    if (Number(response.headers.get('content-length') ?? 0) > MAX_DOWNLOAD_BYTES) return null;
    const chunks: Buffer[] = []; let size = 0;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.length;
      if (size > MAX_DOWNLOAD_BYTES) return null;
      chunks.push(Buffer.from(chunk));
    }
    const bytes = Buffer.concat(chunks), ext = imageExtension(bytes);
    return ext ? { bytes, ext } : null;
  } catch { return null; }
}

/** One `plugin/list` call over a short-lived `codex app-server`. */
function listOver(cli: string, env: NodeJS.ProcessEnv): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const child = spawn(cli, ['app-server'], { env, stdio: ['pipe', 'pipe', 'ignore'] });
    let buffer = '', settled = false;
    const finish = (error: Error | null, value?: unknown) => { if (settled) return; settled = true; clearTimeout(timer); child.kill(); if (error) reject(error); else resolve(value); };
    const timer = setTimeout(() => finish(new Error('plugin/list timed out')), LIST_TIMEOUT_MS);
    timer.unref?.();
    const send = (message: Record<string, unknown>) => { try { child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', ...message })}\n`); } catch (error) { finish(error as Error); } };
    child.on('error', error => finish(error));
    child.on('exit', code => finish(new Error(`codex app-server exited (${code})`)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 64 * 1024 * 1024) return finish(new Error('plugin/list answer is too large'));
      let at: number;
      while ((at = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, at); buffer = buffer.slice(at + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error('initialize failed'));
          send({ method: 'initialized' });
          send({ id: 2, method: 'plugin/list', params: {} });
        } else if (message.id === 2) {
          return message.error ? finish(new Error('plugin/list failed')) : finish(null, message.result);
        }
      }
    });
    send({ id: 1, method: 'initialize', params: { clientInfo: { name: 'muster', title: 'Muster', version: '0' }, capabilities: { experimentalApi: true } } });
  });
}

/** The Codex CLI first, then the app-bundled ones: a PATH wrapper can point at a binary that is gone. */
async function listInstalledPlugins(): Promise<unknown> {
  const home = homedir();
  const candidates = [...new Set([process.env.MUSTER_CODEX_COMMAND || locateCli('codex', process.env, home), ...appBundleBinaries('codex', home)].filter((path): path is string => !!path && existsSync(path)))];
  let last: unknown = new Error('The Codex CLI was not found.');
  for (const cli of candidates) {
    try { return await listOver(cli, process.env); } catch (error) { last = error; }
  }
  throw last;
}

let running: Promise<boolean> | null = null, again = false;
/**
 * Refresh the cache when it is older than a week, or look up brand names asked for since (not within six hours of a
 * failed try). A call while one runs makes it go round once more. True when any logo changed.
 */
export function refreshRemotePluginIcons(options: RemoteIconOptions = {}): Promise<boolean> {
  if (running) { again = true; return running; }
  running = (async () => {
    let changed = false;
    do { again = false; changed = await refresh(options) || changed; } while (again);
    return changed;
  })().finally(() => { running = null; });
  return running;
}

async function refresh(options: RemoteIconOptions): Promise<boolean> {
  const dir = store;
  if (!dir) return false;
  const now = options.now?.() ?? Date.now();
  const current = loadIndex();
  let failedAt = 0;
  try { failedAt = Number(await fs.readFile(join(dir, 'failed-at'), 'utf8')) || 0; } catch { /* Never failed. */ }
  const stale = !current || now - current.checkedAt >= REFRESH_MS;
  const pending = [...wanted].filter(name => !current?.brandsChecked?.includes(name));
  if ((!stale && !pending.length) || now - failedAt < RETRY_MS) return false;
  await fs.mkdir(dir, { recursive: true });
  let listing: unknown;
  try { listing = await (options.listPlugins ?? listInstalledPlugins)(); }
  catch { await fs.writeFile(join(dir, 'failed-at'), String(now)).catch(() => undefined); return false; }
  const fetchImpl = options.fetch ?? fetch;
  let changed = false;
  const fill = async (key: string, variants: LogoUrls, prior: IndexEntry | undefined): Promise<IndexEntry> => {
    const entry: IndexEntry = {};
    for (const variant of ['light', 'dark'] as const) {
      const url = variants[variant];
      if (!url) continue;
      const before = prior?.[variant];
      if (before?.url === url && existsSync(join(dir, before.file))) { entry[variant] = before; continue; }
      const image = await download(url, fetchImpl);
      if (!image) continue;
      const file = `${createHash('sha256').update(`${key}\0${variant}`).digest('hex').slice(0, 32)}${image.ext}`;
      const temp = join(dir, `.${file}.${process.pid}.tmp`);
      await fs.writeFile(temp, image.bytes); await fs.rename(temp, join(dir, file));
      entry[variant] = { url, file }; changed = true;
    }
    return entry;
  };
  // A weekly refresh redoes every installed plugin and every name looked up before; a top-up only the new names.
  const icons: Record<string, IndexEntry> = stale ? {} : { ...current.icons };
  if (stale) for (const [key, variants] of remoteIconUrls(listing)) {
    const entry = await fill(key, variants, current?.icons[key]);
    if (entry.light || entry.dark) icons[key] = entry;
  }
  const checked = [...new Set([...(current?.brandsChecked ?? []), ...pending])];
  const brands: Record<string, IndexEntry> = stale ? {} : { ...(current.brands ?? {}) };
  for (const [name, variants] of brandIconUrls(listing, new Set(stale ? checked : pending))) {
    const entry = await fill(`brand:${name}`, variants, current?.brands?.[name]);
    if (entry.light || entry.dark) brands[name] = entry;
  }
  const kept = new Set([...Object.values(icons), ...Object.values(brands)].flatMap(entry => [entry.light?.file, entry.dark?.file]).filter(Boolean));
  for (const [table, next] of [[current?.icons, icons], [current?.brands, brands]] as const) {
    for (const [key, entry] of Object.entries(table ?? {})) {
      if (!next[key]) changed = true;
      for (const file of [entry.light?.file, entry.dark?.file]) if (file && !kept.has(file)) await fs.rm(join(dir, file), { force: true });
    }
  }
  for (const name of pending) wanted.delete(name);
  const next: IconIndex = { version: 1, checkedAt: stale ? now : current.checkedAt, icons, brands, brandsChecked: checked };
  const temp = join(dir, `.index.${process.pid}.tmp`);
  await fs.writeFile(temp, JSON.stringify(next)); await fs.rename(temp, join(dir, 'index.json'));
  await fs.rm(join(dir, 'failed-at'), { force: true });
  index = next;
  return changed;
}
