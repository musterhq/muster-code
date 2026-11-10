/**
 * The desktop's one outbound WebSocket to the phone relay (#326, docs/mobile/DESIGN.md §2). It registers this computer's
 * route with the route secret, then carries each phone connection's base64 frames. It reconnects with backoff while running.
 * It never sees plaintext: sessions are encrypted end to end above it.
 */
export type RelayLinkState = 'connecting' | 'online' | 'offline';
export interface RelayLinkHandlers {
  open(conn: number): void;
  data(conn: number, data: string): void;
  closed(conn: number): void;
  state(state: RelayLinkState, error: string | null): void;
}
interface Socket {
  send(data: string): void; close(code?: number, reason?: string): void;
  onopen: ((event: unknown) => void) | null; onmessage: ((event: {data: unknown}) => void) | null;
  onclose: ((event: {code: number; reason: string}) => void) | null; onerror: ((event: unknown) => void) | null;
}
const BACKOFF_MS = [500, 1000, 2000, 5000, 10_000, 30_000];

export class RelayLink {
  state: RelayLinkState = 'connecting';
  error: string | null = null;
  private socket: Socket | null = null;
  private stopped = false;
  private attempt = 0;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private waiters: Array<{resolve: () => void; reject: (error: Error) => void}> = [];
  constructor(private readonly url: string, private readonly secret: string, private readonly handlers: RelayLinkHandlers) { this.connect(); }

  private setState(state: RelayLinkState, error: string | null) {
    this.state = state; this.error = error;
    this.handlers.state(state, error);
    if (state === 'online') { for (const w of this.waiters.splice(0)) w.resolve(); }
  }
  private connect() {
    if (this.stopped) return;
    const Ctor = (globalThis as unknown as {WebSocket?: new (url: string) => Socket}).WebSocket;
    if (!Ctor) { this.setState('offline', 'This version of Muster cannot open WebSockets.'); return; }
    let socket: Socket;
    try { socket = new Ctor(`${this.url.replace(/\/+$/, '')}/v1/desktop`); } catch (error) { this.setState('offline', (error as Error).message); this.schedule(); return; }
    this.socket = socket;
    this.setState('connecting', null);
    socket.onopen = () => socket.send(JSON.stringify({t: 'register', secret: this.secret}));
    socket.onerror = () => undefined;
    socket.onmessage = event => {
      if (typeof event.data !== 'string') return;
      let message: {t?: string; c?: unknown; d?: unknown};
      try { message = JSON.parse(event.data); } catch { return; }
      if (message.t === 'registered') { this.attempt = 0; this.setState('online', null); return; }
      if (typeof message.c !== 'number') return;
      if (message.t === 'open') this.handlers.open(message.c);
      else if (message.t === 'data' && typeof message.d === 'string') this.handlers.data(message.c, message.d);
      else if (message.t === 'closed') this.handlers.closed(message.c);
    };
    socket.onclose = event => {
      if (this.socket !== socket) return;
      this.socket = null;
      if (this.stopped) return;
      this.setState('offline', event.code === 1006 || !event.reason ? 'Can’t reach the relay.' : `The relay closed the connection (${event.reason}).`);
      this.schedule();
    };
  }
  private schedule() {
    if (this.stopped || this.retry) return;
    const wait = BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]!;
    this.retry = setTimeout(() => { this.retry = undefined; this.connect(); }, wait);
    this.retry.unref?.();
  }
  /** Resolves once registered; rejects after `timeoutMs` (the link keeps retrying). */
  ready(timeoutMs = 10_000): Promise<void> {
    if (this.state === 'online') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const waiter = {resolve: () => { clearTimeout(timer); resolve(); }, reject};
      const timer = setTimeout(() => { this.waiters = this.waiters.filter(w => w !== waiter); reject(new Error(this.error ?? 'Can’t reach the relay.')); }, timeoutMs);
      timer.unref?.();
      this.waiters.push(waiter);
    });
  }
  send(conn: number, data: string): void { this.socket?.send(JSON.stringify({t: 'data', c: conn, d: data})); }
  closePhone(conn: number, code: number, reason: string): void { this.socket?.send(JSON.stringify({t: 'close', c: conn, code, reason})); }
  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    this.retry = undefined;
    for (const w of this.waiters.splice(0)) w.reject(new Error('Phone access was turned off.'));
    const socket = this.socket; this.socket = null;
    try { socket?.close(1000, 'stopped'); } catch { /* already closed */ }
  }
}
