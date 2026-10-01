/**
 * Slack: Socket Mode (app-level token, outbound WebSocket, works behind NAT) or the Events API (signed HTTPS webhook).
 * Each connector row is its own app/workspace, so several Slack workspaces run side by side.
 * Lessons built in: protocol-ping liveness with reconnect, `disconnect` envelopes honoured, platform errors surfaced (never a silent
 * drop), replies go to the channel thread (everyone in the channel sees them), restricted/ultra-restricted users are guests.
 */
import { createHmac } from 'node:crypto';
import { safeEqual } from '../auth/tokens.ts';
import { connectWebSocket, keepAlive, type WsConnection } from '../net/ws.ts';
import { backoff, clip, ConnectorHttpError, requestJson, sleep, type AdapterContext, type ConnectorAdapter, type InboundMessage, type OutboundMessage, type WebhookRequest } from './types.ts';

interface SlackEvent { type: string; subtype?: string; channel?: string; channel_type?: string; user?: string; bot_id?: string; text?: string; ts?: string; thread_ts?: string; event_ts?: string }

export class SlackAdapter implements ConnectorAdapter {
  private abort = new AbortController();
  private ws?: WsConnection;
  private botUserId?: string;
  private seen = new Map<string, number>();
  private users = new Map<string, { guest: boolean; name: string; at: number }>();
  private channels = new Map<string, { name?: string; members: number | null; at: number }>();
  constructor(private readonly ctx: AdapterContext) {}
  private get apiBase() { return String(this.ctx.connector.config.apiBase || 'https://slack.com/api').replace(/\/+$/, ''); }
  private async api<T extends Record<string, unknown>>(method: string, body: Record<string, unknown> = {}, token?: string | null): Promise<T> {
    const bearer = token ?? await this.ctx.secret('botToken');
    if (!bearer) throw new ConnectorHttpError('No bot token stored for this connector.', 401);
    const res = await requestJson<T & { ok: boolean; error?: string }>(`${this.apiBase}/${method}`, { headers: { authorization: `Bearer ${bearer}` }, body, signal: this.abort.signal });
    if (!res.ok) throw new ConnectorHttpError(`Slack ${method}: ${res.error ?? 'failed'}`, ['invalid_auth', 'not_authed', 'account_inactive', 'token_revoked'].includes(res.error ?? '') ? 401 : 400, res.error);
    return res;
  }
  async test() {
    const t0 = Date.now();
    try { const r = await this.api<{ user?: string; team?: string; user_id?: string }>('auth.test'); return { ok: true, detail: `Bot ${r.user ?? r.user_id} in ${r.team ?? 'workspace'}`, latencyMs: Date.now() - t0 }; }
    catch (error) { return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - t0 }; }
  }
  async start() {
    this.abort = new AbortController();
    this.ctx.health('connecting');
    try { this.botUserId = (await this.api<{ user_id?: string }>('auth.test')).user_id; }
    catch (error) { this.ctx.health(error instanceof ConnectorHttpError && error.status === 401 ? 'unauth' : 'down', (error as Error).message); return; }
    if (this.ctx.connector.mode === 'events') {
      this.ctx.health(this.ctx.publicUrl ? 'ok' : 'degraded', this.ctx.publicUrl ? null : 'Events API mode needs a public HTTPS URL for /hooks/slack/<id>; use Socket Mode behind NAT.');
      return;
    }
    void this.socketLoop();
  }
  private async socketLoop() {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      try {
        const appToken = await this.ctx.secret('appToken');
        if (!appToken) { this.ctx.health('unauth', 'Socket Mode needs an app-level token (xapp-…) with connections:write.'); return; }
        const { url } = await this.api<{ url: string }>('apps.connections.open', {}, appToken);
        const ws = await connectWebSocket(url);
        this.ws = ws;
        const stopPing = keepAlive(ws, Number(this.ctx.connector.config.pingIntervalMs ?? 25_000), Number(this.ctx.connector.config.pongTimeoutMs ?? 10_000));
        const closed = new Promise<string>(resolve => ws.once('close', (_c: number, reason: string) => resolve(reason)));
        ws.on('message', (raw: string) => { void this.onEnvelope(ws, raw); });
        this.ctx.health('ok', null, attempt ? { reconnect: true } : {});
        attempt = 0;
        const reason = await closed;
        stopPing();
        if (this.abort.signal.aborted) return;
        this.ctx.health('degraded', `Socket closed (${reason || 'no reason'}); reconnecting.`);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        const unauth = error instanceof ConnectorHttpError && error.status === 401;
        this.ctx.health(unauth ? 'unauth' : attempt > 3 ? 'down' : 'degraded', (error as Error).message);
        if (unauth) return;
      }
      await sleep(backoff(attempt++), this.abort.signal);
    }
  }
  private async onEnvelope(ws: WsConnection, raw: string) {
    let env: { envelope_id?: string; type?: string; payload?: { event?: SlackEvent }; reason?: string };
    try { env = JSON.parse(raw); } catch { return; }
    if (env.envelope_id) ws.send(JSON.stringify({ envelope_id: env.envelope_id })); // ack first: Slack retries unacked envelopes after 3 s
    if (env.type === 'disconnect') { ws.close(1000, `slack disconnect: ${env.reason ?? ''}`); return; }
    if (env.type === 'hello') { this.ctx.health('ok'); return; }
    if (env.type === 'events_api' && env.payload?.event) await this.onEvent(env.payload.event);
  }
  async webhook(request: WebhookRequest) {
    const secret = await this.ctx.secret('signingSecret');
    if (!secret) return { status: 503, body: 'connector has no signing secret' };
    const ts = String(request.headers['x-slack-request-timestamp'] ?? ''), sig = String(request.headers['x-slack-signature'] ?? '');
    if (!/^\d+$/.test(ts) || Math.abs(Date.now() / 1000 - Number(ts)) > 300) return { status: 401, body: 'stale request' };
    const expected = `v0=${createHmac('sha256', secret).update(`v0:${ts}:${request.body}`).digest('hex')}`;
    if (!safeEqual(sig, expected)) return { status: 401, body: 'bad signature' };
    let body: { type?: string; challenge?: string; event?: SlackEvent };
    try { body = JSON.parse(request.body); } catch { return { status: 400, body: 'bad json' }; }
    if (body.type === 'url_verification') return { status: 200, body: JSON.stringify({ challenge: body.challenge }), contentType: 'application/json' };
    if (body.type === 'event_callback' && body.event) void this.onEvent(body.event);
    this.ctx.health('ok', null, { event: true });
    return { status: 200, body: '' };
  }
  private async user(id: string) {
    const hit = this.users.get(id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    try {
      const r = await this.api<{ user?: { name?: string; real_name?: string; is_restricted?: boolean; is_ultra_restricted?: boolean; is_stranger?: boolean } }>('users.info', { user: id });
      const u = { guest: Boolean(r.user?.is_restricted || r.user?.is_ultra_restricted || r.user?.is_stranger), name: r.user?.real_name || r.user?.name || id, at: Date.now() };
      this.users.set(id, u); return u;
    } catch (error) {
      // Unknown status is treated as a guest: never grant internal access on a failed lookup.
      this.ctx.log(`users.info failed for ${id}: ${(error as Error).message}`);
      return { guest: true, name: id, at: Date.now() };
    }
  }
  private async channel(id: string) {
    const hit = this.channels.get(id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    const r = await this.api<{ channel?: { name?: string; num_members?: number } }>('conversations.info', { channel: id, include_num_members: true }).catch(() => ({ channel: undefined }));
    const c = { name: r.channel?.name, members: typeof r.channel?.num_members === 'number' ? r.channel.num_members : null, at: Date.now() };
    this.channels.set(id, c); return c;
  }
  private async onEvent(e: SlackEvent) {
    if ((e.type !== 'message' && e.type !== 'app_mention') || !e.user || e.bot_id || (e.subtype && e.subtype !== 'thread_broadcast') || !e.text || !e.channel || !e.ts) return;
    if (e.user === this.botUserId) return;
    // A mention in a channel arrives as both `message` and `app_mention`: handle it once.
    const key = `${e.channel}:${e.ts}`;
    if (this.seen.has(key)) return;
    this.seen.set(key, Date.now());
    if (this.seen.size > 5000) for (const [k, at] of this.seen) if (Date.now() - at > 600_000) this.seen.delete(k);
    this.ctx.health('ok', null, { event: true });
    const dm = e.channel_type === 'im';
    const mention = this.botUserId ? `<@${this.botUserId}>` : null;
    const mentioned = dm || e.type === 'app_mention' || (mention ? e.text.includes(mention) : false);
    const [user, channel] = await Promise.all([this.user(e.user), dm ? Promise.resolve({ name: undefined, members: 2 }) : this.channel(e.channel)]);
    const message: InboundMessage = {
      connectorId: this.ctx.connector.id, messageId: e.ts, externalUserId: e.user, userName: user.name,
      text: mention ? e.text.split(mention).join('').trim() : e.text,
      conversation: { kind: dm ? 'dm' : 'channel', id: e.channel, name: channel.name ? `#${channel.name}` : undefined, threadId: dm ? (e.thread_ts ?? null) : (e.thread_ts ?? e.ts) },
      mentioned, guest: user.guest, audience: { members: channel.members, guests: null },
    };
    this.ctx.onMessage(message);
  }
  async send(out: OutboundMessage) {
    await this.api('chat.postMessage', { channel: out.conversation.id, text: clip(out.text, 3900), ...(out.conversation.threadId ? { thread_ts: out.conversation.threadId } : {}), unfurl_links: false });
  }
  async stop() { this.abort.abort(); this.ws?.close(1000, 'stopping'); }
}
