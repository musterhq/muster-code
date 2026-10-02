/**
 * Paperclip REST client for the Projects workspace (#115). Runs in the runtime only.
 * - Auth: `Authorization: Bearer <board key>` (`paperclipai token board create`). A local_trusted deployment needs none.
 * - Reads are revalidated with the ETag Paperclip sends on every JSON GET (If-None-Match -> 304), so a refresh that
 *   finds nothing new transfers only headers and reuses the parsed body.
 * - Live events: one WebSocket per company at /api/companies/:id/events/ws. The caller opens it only while the Projects
 *   screen is on screen and falls back to visibility-gated polling when the socket is refused.
 */
export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;
type Json = Record<string, unknown>;
export interface PaperclipEndpoint { baseUrl: string; token?: string }
export class PaperclipError extends Error {
  constructor(message: string, readonly status: number, readonly stage: 'network' | 'auth' | 'service') { super(message); this.name = 'PaperclipError'; }
}

const TIMEOUT_MS = 10_000;
const CACHE_MAX = 64;
/** Rows per page when listing issues (Paperclip allows up to 1000) and comments (up to 500). */
export const ISSUE_PAGE = 1000, COMMENT_PAGE = 500;
/** A runaway guard for a server that ignores paging (a page that adds nothing new always stops the loop first). */
const MAX_PAGES = 400;

/** `https://host:port/base` with no trailing slash; refuses anything that is not http(s) or carries credentials. */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Enter the Muster Server URL, for example https://muster.example.com.');
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error('That is not a valid URL. Include http:// or https://.'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('Server URLs start with http:// or https://.');
  if (url.username || url.password) throw new Error('Put the API token in the token field, not in the URL.');
  url.hash = ''; url.search = '';
  return url.toString().replace(/\/+$/, '').replace(/\/api$/, '');
}
export const isLoopback = (baseUrl: string) => { try { return ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(baseUrl).hostname); } catch { return false; } };

export class PaperclipClient {
  private readonly cache = new Map<string, { etag: string; body: unknown }>();
  /** Bumped whenever any GET returned a new body (not a 304), so callers can skip rebuilding views. */
  generation = 0;
  /** `cache: false` keeps no parsed bodies (an importer reads each page once and must not hold a large org in memory). */
  constructor(readonly endpoint: PaperclipEndpoint, readonly fetcher: FetchLike = (input, init) => fetch(input, init), private readonly options: { cache?: boolean; /** A 401: returns the sentence to show instead of the generic one (a key the server revoked). */ onUnauthorized?: (hadToken: boolean, status: number) => string | undefined } = {}) {}

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
      throw new PaperclipError(`Muster Server at ${this.endpoint.baseUrl} ${reason}.`, 0, 'network');
    }
    if (response.status === 401 || response.status === 403) {
      const replaced = this.options.onUnauthorized?.(Boolean(this.endpoint.token), response.status);
      if (replaced) { await response.text().catch(() => ''); throw new PaperclipError(replaced, response.status, 'auth'); }
      const detail = await response.text().catch(() => '');
      throw new PaperclipError(this.endpoint.token ? `Muster Server refused the API token (${response.status}).${detail ? ` ${short(detail)}` : ''}` : 'This Muster Server needs an API token. Create one on the server and paste it in Settings › Integrations.', response.status, 'auth');
    }
    return response;
  }

  async get<T>(path: string): Promise<T> {
    const cached = this.cache.get(path);
    const response = await this.request('GET', path, undefined, cached ? { 'if-none-match': cached.etag } : {});
    if (response.status === 304 && cached) return cached.body as T;
    if (!response.ok) throw new PaperclipError(`Muster Server answered ${response.status} for ${path.split('?')[0]}.${await errorText(response)}`, response.status, 'service');
    const body = await readJson<T>(response, path);
    const etag = response.headers.get('etag');
    // A 200 whose body is what we already hold, apart from a generation timestamp (Paperclip's attention feed stamps every reply), is not a change.
    if (cached && etag && stable(body) === stable(cached.body)) { if (this.options.cache !== false) this.cache.set(path, { etag, body: cached.body }); return cached.body as T; }
    this.generation++;
    if (etag && this.options.cache !== false) {
      if (this.cache.size >= CACHE_MAX) this.cache.delete(this.cache.keys().next().value!);
      this.cache.set(path, { etag, body });
    }
    return body;
  }

  /**
   * Every row of a list, one page at a time (`pageSize` rows per request). `nextPath(page, soFar)` builds the next request from
   * the rows read so far. The loop ends on a short page, on a page that brings nothing new (a server that ignores paging), or
   * at MAX_PAGES. Rows are yielded page by page so a caller can process and drop them.
   */
  async *pages<T extends { id?: unknown }>(firstPath: string, pageSize: number, nextPath: (last: T[], soFar: number) => string): AsyncGenerator<T[]> {
    const seen = new Set<string>();
    let path = firstPath, soFar = 0;
    for (let n = 0; n < MAX_PAGES; n++) {
      const raw = await this.get<unknown>(path);
      const page = (Array.isArray(raw) ? raw : []).filter((row): row is T => Boolean(row) && typeof row === 'object');
      const fresh = page.filter(row => { const key = typeof row.id === 'string' ? row.id : undefined; if (key === undefined) return true; if (seen.has(key)) return false; seen.add(key); return true; });
      if (fresh.length) yield fresh;
      soFar += page.length;
      if (page.length < pageSize || fresh.length === 0) return;
      path = nextPath(page, soFar);
    }
  }
  /** All issues of a company (compact or full), sorted by id and paged by offset. A repeat is dropped; a skipped row is harmless here because deletions are re-checked with a GET. */
  issuePages(companyId: string, query: string, fresh = false): AsyncGenerator<Json[]> {
    // Paperclip keeps a compact issue list for 2 s and a change does not clear it. A read right after a live event asks for one row fewer
    // per page: a different request key, so the server computes the list instead of replaying the old one.
    const limit = fresh ? ISSUE_PAGE - 1 : ISSUE_PAGE;
    const base = `/companies/${encodeURIComponent(companyId)}/issues?${query}${query ? '&' : ''}sortField=id&sortDir=asc&limit=${limit}`;
    return this.pages<Json>(base, limit, (_page, soFar) => `${base}&offset=${soFar}`);
  }
  /** All comments of an issue, oldest first, paged with Paperclip's `after` cursor. */
  commentPages(issueId: string): AsyncGenerator<Json[]> {
    const base = `/issues/${encodeURIComponent(issueId)}/comments?order=asc&limit=${COMMENT_PAGE}`;
    return this.pages<Json>(base, COMMENT_PAGE, page => `${base}&after=${encodeURIComponent(String(page[page.length - 1]!.id))}`);
  }

  async send<T>(method: 'POST' | 'PATCH', path: string, body: unknown = {}): Promise<T> {
    const response = await this.request(method, path, body);
    if (!response.ok) throw new PaperclipError(`Muster Server refused the change (${response.status}).${await errorText(response)}`, response.status, 'service');
    this.cache.clear();
    this.generation++;
    const text = await response.text();
    if (!text) return {} as T;
    try { return JSON.parse(text) as T; } catch { throw badBody(text, path); }
  }

  /** Forget cached bodies (after a live event says something changed, so the next read cannot be served stale). */
  invalidate(prefix?: string): void { if (!prefix) { this.cache.clear(); return; } for (const key of [...this.cache.keys()]) if (key.startsWith(prefix)) this.cache.delete(key); }

  eventsUrl(companyId: string): string {
    const url = new URL(`${this.endpoint.baseUrl}/api/companies/${encodeURIComponent(companyId)}/events/ws`);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    return url.toString();
  }
}

/** A 200 that is a web page (a SPA, a proxy's login screen) means the URL is not a Paperclip API; one that is cut off or is not JSON
 *  at all means Paperclip answered with something Muster cannot read. Either way: a sentence, never a parse error. */
const notPaperclip = (path: string) => new PaperclipError(`This URL isn’t a Muster Server API: ${path.split('?')[0]} answered with a web page, not JSON. Check the address (use the server’s own URL, for example https://muster.example.com).`, 200, 'service');
const unreadable = (path: string) => new PaperclipError(`Muster Server sent a reply for ${path.split('?')[0]} that Muster could not read (it was cut off or damaged on the way). The last good copy stays on screen; it will refresh when the server answers properly.`, 200, 'service');
const badBody = (text: string, path: string) => /^\s*</.test(text) ? notPaperclip(path) : unreadable(path);
async function readJson<T>(response: Response, path: string): Promise<T> {
  const text = await response.text();
  try { return JSON.parse(text) as T; } catch { throw badBody(text, path); }
}
const short = (text: string) => { const plain = text.replace(/\s+/g, ' ').trim(); if (/^<(!doctype|html|\?xml)/i.test(plain)) return ''; try { const parsed = JSON.parse(plain) as { error?: string; message?: string }; return (parsed.error ?? parsed.message ?? '').slice(0, 200); } catch { return plain.slice(0, 200); } };
async function errorText(response: Response): Promise<string> { const text = await response.text().catch(() => ''); const detail = text ? short(text) : ''; return detail ? ` ${detail}` : ''; }

const stable = (value: unknown): string => JSON.stringify(value, (key, v) => key === 'generatedAt' ? undefined : v);
export interface LiveSocket { close(): void }
export type SocketFactory = (url: string, token: string | undefined, headers?: Record<string, string>) => { onopen: (() => void) | null; onmessage: ((event: { data: unknown }) => void) | null; onclose: (() => void) | null; onerror: (() => void) | null; close(): void };
/** Node's WebSocket (undici) accepts headers; the token rides in Authorization, never in the URL. */
export const nodeSocket: SocketFactory = (url, token, headers) => {
  const Ctor = (globalThis as unknown as { WebSocket?: new (url: string, init?: unknown) => ReturnType<SocketFactory> }).WebSocket;
  if (!Ctor) throw new Error('WebSocket is unavailable in this runtime.');
  // A hosted server accepts a browser session (Cookie) on this socket, never a board key: with a session the key is not sent at all.
  if (headers && Object.keys(headers).length) return new Ctor(url, { headers });
  return token ? new Ctor(url, { headers: { authorization: `Bearer ${token}` } }) : new Ctor(url);
};

/** Opens the company's live-event socket. `onEvent` gets each parsed event type; `onDown` fires once when it closes or fails. */
export function openLiveEvents(client: PaperclipClient, companyId: string, handlers: { onOpen(): void; onEvent(type: string, payload: Record<string, unknown>): void; onDown(): void }, factory: SocketFactory = nodeSocket, session?: { cookie: string; origin: string }): LiveSocket {
  let closed = false, down = false;
  const fail = () => { if (!down && !closed) { down = true; handlers.onDown(); } };
  let socket: ReturnType<SocketFactory>;
  try { socket = session ? factory(client.eventsUrl(companyId), undefined, { cookie: session.cookie, origin: session.origin }) : factory(client.eventsUrl(companyId), client.endpoint.token); } catch { queueMicrotask(fail); return { close() { closed = true; } }; }
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
