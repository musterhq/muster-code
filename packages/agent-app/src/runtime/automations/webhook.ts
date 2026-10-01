/**
 * The signed webhook trigger (G20). One HTTP listener on the loopback interface only, started while at least one
 * automation has its webhook turned on and stopped when none does. A request must carry
 *   x-muster-timestamp: <unix seconds, within five minutes>
 *   x-muster-signature: sha256=<hex HMAC-SHA256 of "<timestamp>.<raw body>" with the automation's secret>
 * and is POSTed to /hooks/<automation id>. The JSON body's top-level scalar fields fill the automation's variables. Secrets are
 * never logged or returned except once, when they are made.
 *
 *   curl -X POST http://127.0.0.1:PORT/hooks/ID -H "x-muster-timestamp: $T" -H "x-muster-signature: sha256=$SIG" -d '{"ticket":"ABC-1"}'
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export const WEBHOOK_LIMITS = { bodyBytes: 64 * 1024, skewSec: 300, perMinute: 30, replayMemoryMs: 10 * 60_000 } as const;
export const newWebhookSecret = (): string => `whsec_${randomBytes(32).toString('hex')}`;
export const signWebhook = (secret: string, timestamp: string | number, body: string): string => `sha256=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
export function verifyWebhook(secret: string, timestamp: string | undefined, signature: string | undefined, body: string, nowMs: number): 'ok' | 'stale' | 'bad' {
  const t = Number(timestamp);
  if (!timestamp || !Number.isFinite(t) || Math.abs(nowMs / 1000 - t) > WEBHOOK_LIMITS.skewSec) return 'stale';
  const want = Buffer.from(signWebhook(secret, timestamp, body)), got = Buffer.from(signature ?? '');
  return want.length === got.length && timingSafeEqual(want, got) ? 'ok' : 'bad';
}
/** Top-level string, number and boolean fields of a JSON object body, as strings. Anything else is ignored. */
export function variablesFromBody(body: string): Record<string, string> {
  try { const raw = JSON.parse(body) as unknown; if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}; const out: Record<string, string> = {}; for (const [k, v] of Object.entries(raw)) if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k.toLowerCase()] = String(v); return out; } catch { return {}; }
}

export interface WebhookDeps {
  now(): number;
  /** The secret of an automation whose webhook is on and that is not paused, or undefined. */
  secret(automationId: string): string | undefined;
  /** Fires the automation. The result is the answer the caller gets. */
  /** The replay memory: kept by the caller, so it outlives the listener (stop, restart) and the app. Bounded to the replay window. */
  replay: { has(signature: string): boolean; add(signature: string, at: number): void };
  fire(automationId: string, variables: Record<string, string>): Promise<{ status: 'started' | 'queued' | 'awaiting' | 'skipped' | 'failed'; reason?: string }>;
}
export class WebhookListener {
  private server: http.Server | null = null;
  private hits = new Map<string, number[]>();
  private starting: Promise<number | null> | null = null;
  constructor(private deps: WebhookDeps, private preferredPort: number) {}
  get port(): number | null { const a = this.server?.address(); return a && typeof a === 'object' ? (a as AddressInfo).port : null; }
  /** Starts the listener (idempotent). Tries the preferred port, then any free one. Resolves to the port, or null when it could not listen. */
  start(): Promise<number | null> {
    if (this.server?.listening) return Promise.resolve(this.port);
    this.starting ??= new Promise<number | null>(resolve => {
      const make = (port: number, retry: boolean) => {
        const server = http.createServer((req, res) => { void this.handle(req, res); });
        server.once('error', () => { server.close(); if (retry) make(0, false); else { this.server = null; resolve(null); } });
        server.listen(port, '127.0.0.1', () => { this.server = server; server.unref(); resolve(this.port); });
      };
      make(this.preferredPort, this.preferredPort !== 0);
    }).finally(() => { this.starting = null; });
    return this.starting;
  }
  stop(): void { this.server?.close(); this.server?.closeAllConnections?.(); this.server = null; this.hits.clear(); }
  private reply(res: http.ServerResponse, status: number, body: Record<string, unknown>) { res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); }
  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const match = /^\/hooks\/([A-Za-z0-9_-]{1,128})$/.exec((req.url ?? '').split('?')[0]!);
      if (!match) return this.reply(res, 404, { error: 'Not found.' });
      if (req.method !== 'POST') return this.reply(res, 405, { error: 'Use POST.' });
      const id = match[1]!, now = this.deps.now();
      // An oversized body is read and thrown away (up to a hard cap) so the sender gets its answer instead of a reset.
      const chunks: Buffer[] = []; let size = 0, over = false;
      for await (const c of req) { size += (c as Buffer).length; if (size > 4 * WEBHOOK_LIMITS.bodyBytes) { res.writeHead(413, { connection: 'close' }); res.end(JSON.stringify({ error: 'The body is too large.' })); req.destroy(); return; } if (size > WEBHOOK_LIMITS.bodyBytes) over = true; else chunks.push(c as Buffer); }
      if (over) return this.reply(res, 413, { error: 'The body is too large.' });
      const body = Buffer.concat(chunks).toString('utf8');
      const secret = this.deps.secret(id);
      // An unknown automation, a paused one, a bad signature and a bad timestamp all answer the same, so ids cannot be probed.
      if (!secret) return this.reply(res, 401, { error: 'Not authorised.' });
      const verdict = verifyWebhook(secret, header(req, 'x-muster-timestamp'), header(req, 'x-muster-signature'), body, now);
      if (verdict !== 'ok') return this.reply(res, 401, { error: 'Not authorised.' });
      const sig = header(req, 'x-muster-signature')!;
      if (this.deps.replay.has(sig)) return this.reply(res, 409, { error: 'This request was already received.' });
      const recent = (this.hits.get(id) ?? []).filter(t => now - t < 60_000);
      if (recent.length >= WEBHOOK_LIMITS.perMinute) return this.reply(res, 429, { error: 'Too many requests. Try again in a minute.' });
      this.hits.set(id, [...recent, now]); this.deps.replay.add(sig, now);
      const result = await this.deps.fire(id, variablesFromBody(body));
      return this.reply(res, result.status === 'failed' ? 422 : 202, { status: result.status, ...(result.reason ? { reason: result.reason } : {}) });
    } catch { try { this.reply(res, 500, { error: 'Something went wrong.' }); } catch { /* the socket is gone */ } }
  }
}
const header = (req: http.IncomingMessage, name: string): string | undefined => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };
