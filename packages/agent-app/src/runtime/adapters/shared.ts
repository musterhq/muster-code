import {randomUUID} from 'node:crypto';
import {accessSync, constants, mkdirSync, readFileSync, renameSync, statSync, writeFileSync} from 'node:fs';
import {delimiter, dirname, extname, isAbsolute, join} from 'node:path';
import type {Readable} from 'node:stream';
import type {Validation} from './types.ts';

/** Async capability check with a TTL. current() never blocks: it returns the last
 * result and starts a refresh when stale. A new key (env var changed) resets it.
 * A failed check (cold CLI start, brief network loss) is retried after 30s, not the full TTL. */
export class Validator<T> {
  private state: Validation<T> = {status: 'pending'};
  private key = '';
  private inflight?: Promise<Validation<T>>;
  constructor(private check: () => Promise<T>, private ttlMs = 10 * 60_000, private now: () => number = Date.now) {}
  current(key: string): Validation<T> {
    if (key !== this.key) { this.key = key; this.state = {status: 'pending'}; this.inflight = undefined; }
    if (!this.inflight && (this.state.status === 'pending' || this.now() - (this.state.checkedAt ?? 0) > (this.state.status === 'error' ? Math.min(this.ttlMs, 30_000) : this.ttlMs))) void this.refresh();
    return this.state;
  }
  refresh(): Promise<Validation<T>> {
    if (this.inflight) return this.inflight;
    const key = this.key;
    const run = this.check().then(value => ({status: 'ok' as const, value, checkedAt: this.now()}), (error: unknown) => ({status: 'error' as const, reason: error instanceof Error ? error.message : String(error), checkedAt: this.now()}))
      .then(state => { if (this.key === key && this.inflight === run) { this.state = state; this.inflight = undefined; } return state; });
    this.inflight = run;
    return run;
  }
  /** Resolves once no check is in flight (tests, and a caller that wants settled rows). */
  async settled(): Promise<Validation<T>> { while (this.inflight) await this.inflight; return this.state; }
}

/** Server-sent events from a fetch body. Each line is capped so a hostile endpoint cannot grow memory. */
export async function* sseEvents(body: ReadableStream<Uint8Array>, maxLine = 4 * 1024 * 1024): AsyncGenerator<{event?: string; data: string}> {
  const reader = body.getReader(), decoder = new TextDecoder();
  let buffer = '', event: string | undefined, data: string[] = [];
  try {
    for (;;) {
      const {done, value} = await reader.read();
      buffer += done ? decoder.decode() : decoder.decode(value, {stream: true});
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
        if (!line) { if (data.length) yield {event, data: data.join('\n')}; event = undefined; data = []; continue; }
        if (line.startsWith(':')) continue;
        const colon = line.indexOf(':'), field = colon < 0 ? line : line.slice(0, colon), text = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
        if (field === 'event') event = text; else if (field === 'data') data.push(text);
      }
      if (buffer.length > maxLine) throw new Error('The provider sent an oversized stream event.');
      if (done) { if (data.length) yield {event, data: data.join('\n')}; return; }
    }
  } finally { await reader.cancel().catch(() => {}); }
}

/** A short, secret-free error line from a non-2xx response. */
export async function responseError(response: Response, label: string): Promise<string> {
  let text = '';
  try {
    const reader = response.body?.getReader(), decoder = new TextDecoder();
    if (reader) { try { while (text.length < 8192) { const {done, value} = await reader.read(); if (done) break; text += decoder.decode(value, {stream: true}); } } finally { await reader.cancel().catch(() => {}); } }
  } catch { text = ''; }
  let message = '';
  try { const parsed = JSON.parse(text) as {error?: {message?: unknown} | string; message?: unknown}; const raw = typeof parsed.error === 'string' ? parsed.error : parsed.error?.message ?? parsed.message; if (typeof raw === 'string') message = raw; } catch { message = ''; }
  message = message.replace(/[\x00-\x1f]+/g, ' ').replace(/\b(sk|key|token)[-_][A-Za-z0-9_-]{8,}/gi, '[redacted]').slice(0, 300);
  return `${label} returned HTTP ${response.status}${message ? `: ${message}` : '.'}`;
}

/** Stateless HTTP providers need the prior turns resent. Bounded per conversation; when a
 * directory is given each thread is also saved there (0600) so a restart can continue it. */
export type ChatMessage = {role: 'user' | 'assistant'; content: string};
export class ConversationMemory {
  private threads = new Map<string, ChatMessage[]>();
  constructor(private maxThreads = 64, private maxChars = 400_000, private dir: () => string | undefined = () => undefined) {}
  private file(threadId: string): string | undefined { const dir = this.dir(); return dir && /^[a-f0-9-]{36}$/.test(threadId) ? join(dir, `${threadId}.json`) : undefined; }
  /** The saved turns for `threadId`, or a fresh thread when it is unknown. */
  open(threadId?: string): {threadId: string; history: ChatMessage[]; resumed: boolean} {
    let known = threadId ? this.threads.get(threadId) : undefined;
    const file = threadId && !known ? this.file(threadId) : undefined;
    if (file) try {
      if (statSync(file).size <= 2 * this.maxChars + 65536) { const parsed = JSON.parse(readFileSync(file, 'utf8')) as unknown; if (Array.isArray(parsed)) known = parsed.filter((m): m is ChatMessage => !!m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string'); }
    } catch { known = undefined; }
    return known ? {threadId: threadId!, history: [...known], resumed: true} : {threadId: randomUUID(), history: [], resumed: false};
  }
  /** Saves the thread, trimmed to the newest 80 messages / `maxChars`. Returns how many user turns the saved
   *  history still holds, so the caller can tell which earlier turns (and the context they carried) fell out. */
  commit(threadId: string, messages: ChatMessage[]): {retainedUserTurns: number; trimmed: boolean} {
    let kept = messages.slice(-80), size = kept.reduce((n, m) => n + m.content.length, 0);
    while (kept.length > 2 && size > this.maxChars) { size -= kept[0]!.content.length + kept[1]!.content.length; kept = kept.slice(2); }
    this.threads.delete(threadId); this.threads.set(threadId, kept);
    while (this.threads.size > this.maxThreads) this.threads.delete(this.threads.keys().next().value!);
    const file = this.file(threadId);
    if (file) try { mkdirSync(dirname(file), {recursive: true, mode: 0o700}); const temp = `${file}.tmp`; writeFileSync(temp, JSON.stringify(kept), {mode: 0o600}); renameSync(temp, file); } catch { /* memory copy still serves this session */ }
    return {retainedUserTurns: kept.filter(message => message.role === 'user').length, trimmed: kept.length < messages.length};
  }
}

const IMAGE_TYPES: Record<string, string> = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp'};
/** Local attachment images as base64, capped at 8 images of 8 MiB each. */
export function loadImages(paths: string[] = []): {mediaType: string; data: string}[] {
  return paths.slice(0, 8).flatMap(path => {
    const mediaType = IMAGE_TYPES[extname(path).toLowerCase()];
    if (!mediaType || !isAbsolute(path)) return [];
    try { if ((statSync(path).size) > 8 * 1024 * 1024) return []; return [{mediaType, data: readFileSync(path).toString('base64')}]; } catch { return []; }
  });
}

/** Newline-delimited JSON from a child stream. Lines over `maxLine` are dropped, not buffered. */
export function jsonLines(stream: Readable, onValue: (value: Record<string, unknown>) => void, maxLine = 16 * 1024 * 1024): void {
  let buffer = '', skipping = false;
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (skipping) { skipping = false; continue; }
      if (!line.trim()) continue;
      try { const value = JSON.parse(line) as unknown; if (value && typeof value === 'object' && !Array.isArray(value)) onValue(value as Record<string, unknown>); } catch { /* non-JSON log line */ }
    }
    if (buffer.length > maxLine) { buffer = ''; skipping = true; }
  });
  stream.on('end', () => { const line = buffer; buffer = ''; if (!skipping && line.trim()) try { const value = JSON.parse(line) as unknown; if (value && typeof value === 'object' && !Array.isArray(value)) onValue(value as Record<string, unknown>); } catch { /* partial line */ } });
}

/** First executable named `name` in explicit candidates, then PATH (plus common user bin dirs Electron's PATH lacks). */
export function findBinary(name: string, env: NodeJS.ProcessEnv, home: string, candidates: string[] = []): string | undefined {
  const dirs = [...(env.PATH ?? '').split(delimiter).filter(Boolean), join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', join(home, '.npm-global/bin'), join(home, '.bun/bin'), join(home, '.local/share/mise/shims')];
  for (const file of [...candidates, ...dirs.map(dir => join(dir, name))]) {
    if (!isAbsolute(file)) continue;
    try { accessSync(file, constants.X_OK); if (statSync(file).isFile()) return file; } catch { /* next */ }
  }
  return undefined;
}

export const text = (value: unknown): string => typeof value === 'string' ? value : '';
