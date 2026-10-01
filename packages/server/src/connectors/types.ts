import type { ConnectorRecord, ConnectorState } from '../store/types.ts';

export interface Conversation { kind: 'dm' | 'channel' | 'group'; id: string; name?: string; threadId?: string | null }
export interface InboundMessage {
  connectorId: string; messageId: string; externalUserId: string; userName: string; text: string;
  conversation: Conversation;
  /** The bot was @-mentioned (or it is a DM, or a reply in a thread the bot owns). */
  mentioned: boolean;
  /** Workspace guests (Slack restricted users, Mattermost system_guest) are never treated as internal. */
  guest: boolean;
  /** Who can read the reply: everyone in the channel, not only the sender. */
  audience?: { members: number | null; guests: number | null };
}
export interface OutboundMessage { conversation: Conversation; text: string }
export interface WebhookRequest { headers: Record<string, string | string[] | undefined>; body: string }
export interface WebhookResponse { status: number; body: string; contentType?: string }

export interface AdapterContext {
  connector: ConnectorRecord;
  secret(name: string): Promise<string | null>;
  /** Deliver an inbound message to the router. Adapters must not await the agent turn before acknowledging the platform. */
  onMessage(message: InboundMessage): void;
  health(state: ConnectorState, error?: string | null, extra?: { latencyMs?: number; reconnect?: boolean; event?: boolean }): void;
  log(message: string): void;
  publicUrl: string | null;
}
export interface ConnectorAdapter {
  start(): Promise<void>;
  stop(): Promise<void>;
  /** Token/credential probe: Telegram getMe, Slack auth.test, Mattermost users/me. */
  test(): Promise<{ ok: boolean; detail: string; latencyMs: number }>;
  send(message: OutboundMessage): Promise<void>;
  webhook?(request: WebhookRequest): Promise<WebhookResponse>;
}
export interface ConnectorType {
  type: string; label: string; status: 'available' | 'coming-soon';
  modes: readonly string[];
  /** Secret names this type needs, per mode. */
  secrets(mode: string): readonly string[];
  /** Config keys it understands (non-secret). */
  configKeys: readonly string[];
  create?(ctx: AdapterContext): ConnectorAdapter;
  note?: string;
}

export class ConnectorHttpError extends Error {
  constructor(message: string, readonly status: number, readonly platformError?: string) { super(message); this.name = 'ConnectorHttpError'; }
}
/** JSON request with a timeout. Never logs headers (they carry tokens). */
export async function requestJson<T = Record<string, unknown>>(url: string, init: { method?: string; headers?: Record<string, string>; body?: unknown; form?: Record<string, string>; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? 30_000);
  const abort = () => controller.abort();
  init.signal?.addEventListener('abort', abort, { once: true });
  try {
    const headers: Record<string, string> = { accept: 'application/json', ...init.headers };
    let body: string | undefined;
    if (init.form) { headers['content-type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(init.form).toString(); }
    else if (init.body !== undefined) { headers['content-type'] = 'application/json; charset=utf-8'; body = JSON.stringify(init.body); }
    const response = await fetch(url, { method: init.method ?? (body ? 'POST' : 'GET'), headers, body, signal: controller.signal, redirect: 'error' });
    const text = await response.text();
    let json: unknown;
    try { json = text ? JSON.parse(text) : {}; } catch { json = { raw: text.slice(0, 300) }; }
    if (!response.ok) {
      const j = json as Record<string, unknown>;
      throw new ConnectorHttpError(`HTTP ${response.status}${typeof j.description === 'string' ? `: ${j.description}` : typeof j.message === 'string' ? `: ${j.message}` : typeof j.error === 'string' ? `: ${j.error}` : ''}`, response.status, typeof j.error === 'string' ? j.error : undefined);
    }
    return json as T;
  } finally { clearTimeout(timer); init.signal?.removeEventListener('abort', abort); }
}
export const sleep = (ms: number, signal?: AbortSignal) => new Promise<void>(resolve => {
  const t = setTimeout(resolve, ms); t.unref?.();
  signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
});
/** Exponential backoff with jitter, capped. */
export const backoff = (attempt: number, base = 1000, cap = 60_000) => Math.min(cap, base * 2 ** Math.min(attempt, 10)) * (0.75 + Math.random() * 0.5);
/** Platform message limits. */
export function clip(text: string, limit: number): string { return text.length <= limit ? text : `${text.slice(0, limit - 40)}\n… (reply truncated; full answer in Muster)`; }
