import {createHash} from 'node:crypto';
import {promises as fs} from 'node:fs';
import {join} from 'node:path';

/**
 * Site icons for the transcript's source stacks. HTTPS only, one small image per host, never more than
 * `maxBytes`. Answers come from memory, then disk, then one network fetch per host at a time; a miss is
 * remembered for a while so a dead site is not asked again on every render. The renderer shows a letter
 * tile until (and unless) an icon arrives, so nothing here ever blocks a paint.
 */
export const FAVICON_MAX_BYTES = 64 * 1024;
const MISS_TTL_MS = 60 * 60 * 1000;
const TIMEOUT_MS = 5000;
const IMAGE_TYPES = /^image\/(?:png|x-icon|vnd\.microsoft\.icon|svg\+xml|gif|jpeg|webp)\b/i;

export interface FaviconCacheOptions {
  dir: string;
  fetch?: typeof globalThis.fetch;
  maxBytes?: number;
  memoryEntries?: number;
  diskEntries?: number;
  now?: () => number;
}

/** The host of an https URL (or a bare host name), lower-cased; null for anything else. */
export function faviconHost(input: string): string | null {
  const raw = input.trim();
  if (!raw || raw.length > 2048) return null;
  let url: URL;
  try { url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const host = url.hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(host) || !host.includes('.') || host === 'localhost' || /^[\d.]+$/.test(host)) return null;
  return host;
}

export class FaviconCache {
  private readonly memory = new Map<string, string | null>();
  private readonly misses = new Map<string, number>();
  private readonly inflight = new Map<string, Promise<string | null>>();
  private readonly fetcher: typeof globalThis.fetch;
  private readonly maxBytes: number;
  private readonly memoryEntries: number;
  private readonly diskEntries: number;
  private readonly now: () => number;
  constructor(private readonly options: FaviconCacheOptions) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.maxBytes = options.maxBytes ?? FAVICON_MAX_BYTES;
    this.memoryEntries = options.memoryEntries ?? 256;
    this.diskEntries = options.diskEntries ?? 1024;
    this.now = options.now ?? Date.now;
  }

  /** A data URL for the site's icon, or null (not https, no icon, too big, offline). Never throws. */
  async get(input: string): Promise<string | null> {
    const host = faviconHost(input);
    if (!host) return null;
    if (this.memory.has(host)) { const value = this.memory.get(host)!; this.remember(host, value); return value; }
    const missed = this.misses.get(host);
    if (missed !== undefined && this.now() - missed < MISS_TTL_MS) return null;
    const running = this.inflight.get(host);
    if (running) return running;
    const task = this.load(host).finally(() => this.inflight.delete(host));
    this.inflight.set(host, task);
    return task;
  }

  private remember(host: string, value: string | null) {
    this.memory.delete(host); this.memory.set(host, value);
    while (this.memory.size > this.memoryEntries) this.memory.delete(this.memory.keys().next().value!);
  }
  private file(host: string) { return join(this.options.dir, `${createHash('sha256').update(host).digest('hex').slice(0, 32)}.icon`); }

  private async load(host: string): Promise<string | null> {
    const file = this.file(host);
    try {
      const stored = await fs.readFile(file, 'utf8');
      if (stored.startsWith('data:image/')) { this.remember(host, stored); void fs.utimes(file, new Date(), new Date()).catch(() => {}); return stored; }
    } catch { /* not cached on disk yet */ }
    const value = await this.download(host);
    if (!value) { this.misses.set(host, this.now()); return null; }
    this.remember(host, value);
    try { await fs.mkdir(this.options.dir, {recursive: true, mode: 0o700}); await fs.writeFile(file, value, {mode: 0o600}); await this.prune(); } catch { /* memory still has it */ }
    return value;
  }

  private async download(host: string): Promise<string | null> {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await this.fetcher(`https://${host}/favicon.ico`, {signal: controller.signal, redirect: 'follow', headers: {accept: 'image/*'}});
      if (!response.ok || !response.url.startsWith('https://')) return null;
      const type = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
      if (!IMAGE_TYPES.test(type)) return null;
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > this.maxBytes) return null;
      const reader = response.body?.getReader();
      if (!reader) return null;
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const {done, value} = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > this.maxBytes) { await reader.cancel().catch(() => {}); return null; }
        chunks.push(value);
      }
      if (!size) return null;
      return `data:${type};base64,${Buffer.concat(chunks).toString('base64')}`;
    } catch { return null; }
    finally { clearTimeout(timer); }
  }

  /** Disk LRU: the least recently used icons go once the folder holds more than `diskEntries`. */
  private async prune() {
    const names = (await fs.readdir(this.options.dir)).filter(name => name.endsWith('.icon'));
    if (names.length <= this.diskEntries) return;
    const stats = await Promise.all(names.map(async name => ({name, at: (await fs.stat(join(this.options.dir, name)).catch(() => undefined))?.mtimeMs ?? 0})));
    stats.sort((a, b) => a.at - b.at);
    await Promise.all(stats.slice(0, names.length - this.diskEntries).map(entry => fs.rm(join(this.options.dir, entry.name), {force: true})));
  }
}
