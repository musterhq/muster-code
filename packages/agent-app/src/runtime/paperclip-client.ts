/**
 * Paperclip REST client for the Projects workspace (#115). Runs in the runtime only.
 * - Auth: `Authorization: Bearer <board key>` (`paperclipai token board create`). A local_trusted deployment needs none.
 * - Reads are revalidated with the ETag Paperclip sends on every JSON GET (If-None-Match -> 304), so a refresh that
 *   finds nothing new transfers only headers and reuses the parsed body.
 * - Live events: one WebSocket per company at /api/companies/:id/events/ws. The caller opens it only while the Projects
 *   screen is on screen and falls back to visibility-gated polling when the socket is refused.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
export interface PaperclipEndpoint { baseUrl: string; token?: string }
export class PaperclipError extends Error {
  constructor(message: string, readonly status: number, readonly stage: 'network' | 'auth' | 'service') { super(message); this.name = 'PaperclipError'; }
}

const TIMEOUT_MS = 10_000;
const CACHE_MAX = 64;

/** `https://host:port/base` with no trailing slash; refuses anything that is not http(s) or carries credentials. */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter the Paperclip URL, for example https://paperclip.example.com.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('That is not a valid URL. Include http:// or https://.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Paperclip URLs start with http:// or https://.');
  if (url.username || url.password) throw new Error('Put the API token in the token field, not in the URL.');
  url.hash = ''; url.search = '';
  return url.toString().replace(/\/+$/, '').replace(/\/api$/, '');
}
export const isLoopback = (baseUrl: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname); } catch { return false; } };

export class PaperclipClient {
  private readonly cache = new Map<string, { etag: string; body: unknown }>();
  /** Bumped whenever any GET returned a new body (not a 304), so callers can skip rebuilding views. */
  generation = 0;
  constructor(readonly endpoint: PaperclipEndpoint, private readonly fetcher: FetchLike = (input, init) => fetch(input, init)) {}

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { accept: 'application/json', ...(this.endpoint.token ? { authorization: `Bearer ${this.endpoint.token}` } : {}), ...extra };
  }

  private async request(method: string, path: string, body?: unknown, headers: Record<string, string> = {}): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.endpoint.baseUrl}/api${path}`, {
        method, headers: this.headers(body === undefined ? headers : { ...headers, 'content-type': 'application/json' }),
        body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS), redirect: 'error',
      });
    } catch (cause) {
      const reason = cause instanceof Error && cause.name === 'TimeoutError' ? 'timed out' : 'is not reachable';
      throw new PaperclipError(`Paperclip at ${this.endpoint.baseUrl} ${reason}.`, 0, 'network');
    }
    if (response.status === 401 || response.status === 403) {
      const detail = await response.text().catch(() => '');
      throw new PaperclipError(this.endpoint.token ? `Paperclip refused the API token (${response.status}).${detail ? ` ${short(detail)}` : ''}` : 'This Paperclip needs an API token. Create one with `paperclipai token board create` and paste it in Settings.', response.status, 'auth');
    }
    return response;
  }

  async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);
    const response = await this.request('GET', path, undefined, cached ? { 'if-none-match': cached.etag } : {});
    if (response.status === 304 && cached) return cached.body as T;
    if (!response.ok) throw new PaperclipError(`Paperclip answered ${response.status} for ${path.split('?')[0]}.${await errorText(response)}`, response.status, 'service');
    const body = await readJson<T>(response, path);
    const etag = response.headers.get('etag');
    this.generation++;
    if (etag) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, { etag, body });
    }
    return body;
  }

  async send<T>(method: 'POST' | 'PATCH', path: string, body: unknown = {}): Promise<T> {
    const response = await this.request(method, path, body);
    if (!response.ok) throw new PaperclipError(`Paperclip refused the change (${response.status}).${await errorText(response)}`, response.status, 'service');
    this.cache.clear();
    this.generation++;
    const text = await response.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { throw notPaperclip(path); }
  }

  /** Forget cached bodies (after a live event says something changed, so the next read cannot be served stale). */
  invalidate(prefix?: string): void { if (!prefix) { this.cache.clear(); return; } for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key); }

  eventsUrl(companyId: string): string {
    const url = new URL(`${this.endpoint.baseUrl}/api/companies/${encodeURIComponent(companyId)}/events/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
}

/** A 200 that is not JSON (a web page, a proxy's login screen) means the URL is not a Paperclip API. */
const notPaperclip = (path: string) => new PaperclipError(`This URL isn’t a Paperclip API: ${path.split('?')[0]} answered with a web page, not JSON. Check the address (use the Paperclip server’s own URL, for example https://paperclip.example.com).`, 200, 'service');
async function readJson<T>(response: Response, path: string): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw notPaperclip(path); }
}
const short = (text: string) => { const plain = text.replace(/\s+/g, ' ').trim(); if (/^<(!doctype|html|\?xml)/i.test(plain)) return ''; try { const parsed = JSON.parse(plain) as { error?: string; message?: string }; return (parsed.error ?? parsed.message ?? '').slice(0, 200); } catch { return plain.slice(0, 200); } };
async function errorText(response: Response): Promise<string> { const text = await response.text().catch(() => ''); const detail = text ? short(text) : ''; return detail ? ` ${detail}` : ''; }

export interface LiveSocket { close(): void }
export type SocketFactory = (url: string, token: string | undefined) => { onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close(): void };
/** Node's WebSocket (undici) accepts headers; the token rides in Authorization, never in the URL. */
export const nodeSocket: SocketFactory = (url, token) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string, init?: unknown) => ReturnType<SocketFactory> }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is unavailable in this runtime.');
  return token ? new Ctor(url, { headers: { authorization: `Bearer ${token}` } }) : new Ctor(url);
};

/** Opens the company's live-event socket. `onEvent` gets each parsed event type; `onDown` fires once when it closes or fails. */
export function openLiveEvents(client: PaperclipClient, companyId: string, handlers: { onOpen(): void; onEvent(type: string, payload: Record<string, unknown>): void; onDown(): void }, factory: SocketFactory = nodeSocket): LiveSocket {
  let closed = false, down = false;
  const fail = () => { if (!down && !closed) { down = true; handlers.onDown(); } };
  let socket: ReturnType<SocketFactory>;
  try { socket = factory(client.eventsUrl(companyId), client.endpoint.token); } catch { queueMicrotask(fail); return { close() { closed = true; } }; }
  socket.onopen = () => handlers.onOpen();
  socket.onmessage = event => {
    try {
      const parsed = JSON.parse(typeof event.data === 'string' ? event.data : Buffer.from(event.data as ArrayBuffer).toString('utf8')) as { type?: unknown; payload?: unknown };
      if (typeof parsed.type === 'string') handlers.onEvent(parsed.type, parsed.payload && typeof parsed.payload === 'object' ? parsed.payload as Record<string, unknown> : {});
    } catch { /* a malformed frame is ignored */ }
  };
  socket.onerror = fail;
  socket.onclose = fail;
  return { close() { closed = true; try { socket.close(); } catch { /* already closed */ } } };
}
