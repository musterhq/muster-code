/**
 * Mattermost, native (no bridge service): a bot account's token, REST v4 for replies and lookups, and the /api/v4/websocket event stream.
 * Lessons from the QM bridge built in: protocol pings with a pong deadline and reconnect with backoff (a half-open socket is detected),
 * replies posted to the channel thread so every channel member sees them, `system_guest` users are guests, refusals are posted back.
 */
import { connectWebSocket, keepAlive, type WsConnection } from '../net/ws.ts';
import { backoff, clip, ConnectorHttpError, requestJson, sleep, type AdapterContext, type ConnectorAdapter, type InboundMessage, type OutboundMessage } from './types.ts';

interface MmPost { id: string; user_id: string; channel_id: string; root_id?: string; message: string; type?: string; props?: Record<string, unknown> }

export class MattermostAdapter implements ConnectorAdapter {
  private abort = new AbortController();
  private ws?: WsConnection;
  private me?: { id: string; username: string };
  private users = new Map<string, { guest: boolean; name: string; at: number }>();
  private channels = new Map<string, { name?: string; members: number | null; guests: number | null; at: number }>();
  constructor(private readonly ctx: AdapterContext) {}
  private get base() {
    const url = String(this.ctx.connector.config.url ?? '').replace(/\/+$/, '');
    if (!/^https?:\/\//.test(url)) throw new ConnectorHttpError('Set the Mattermost server URL (config url=https://chat.example.com).', 400);
    return url;
  }
  private async api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const token = await this.ctx.secret('botToken');
    if (!token) throw new ConnectorHttpError('No bot token stored for this connector.', 401);
    return requestJson<T>(`${this.base}/api/v4${path}`, { ...init, headers: { authorization: `Bearer ${token}` }, signal: this.abort.signal });
  }
  async test() {
    const t0 = Date.now();
    try { const me = await this.api<{ id: string; username: string; is_bot?: boolean }>('/users/me'); return { ok: true, detail: `${me.is_bot ? 'Bot' : 'User'} @${me.username}`, latencyMs: Date.now() - t0 }; }
    catch (error) { return { ok: false, detail: (error as Error).message, latencyMs: Date.now() - t0 }; }
  }
  async start() {
    this.abort = new AbortController();
    this.ctx.health('connecting');
    void this.loop();
  }
  private async loop() {
    let attempt = 0;
    while (!this.abort.signal.aborted) {
      try {
        this.me = await this.api<{ id: string; username: string }>('/users/me');
        const token = (await this.ctx.secret('botToken'))!;
        const wsUrl = `${this.base.replace(/^http/, 'ws')}/api/v4/websocket`;
        const ws = await connectWebSocket(wsUrl, { headers: { Authorization: `Bearer ${token}` } });
        this.ws = ws;
        ws.send(JSON.stringify({ seq: 1, action: 'authentication_challenge', data: { token } }));
        const stopPing = keepAlive(ws, Number(this.ctx.connector.config.pingIntervalMs ?? 25_000), Number(this.ctx.connector.config.pongTimeoutMs ?? 10_000));
        const closed = new Promise<string>(resolve => ws.once('close', (_c: number, reason: string) => resolve(reason)));
        ws.on('message', (raw: string) => { void this.onFrame(raw); });
        this.ctx.health('ok', null, attempt ? { reconnect: true } : {});
        attempt = 0;
        const reason = await closed;
        stopPing();
        if (this.abort.signal.aborted) return;
        this.ctx.health('degraded', `WebSocket closed (${reason || 'no reason'}); reconnecting.`);
      } catch (error) {
        if (this.abort.signal.aborted) return;
        const unauth = error instanceof ConnectorHttpError && error.status === 401;
        this.ctx.health(unauth ? 'unauth' : attempt > 3 ? 'down' : 'degraded', (error as Error).message);
        if (unauth) return;
      }
      await sleep(backoff(attempt++), this.abort.signal);
    }
  }
  private async user(id: string) {
    const hit = this.users.get(id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    try {
      const u = await this.api<{ username: string; roles?: string; first_name?: string; last_name?: string }>(`/users/${encodeURIComponent(id)}`);
      const rec = { guest: (u.roles ?? '').split(/\s+/).includes('system_guest'), name: [u.first_name, u.last_name].filter(Boolean).join(' ') || `@${u.username}`, at: Date.now() };
      this.users.set(id, rec); return rec;
    } catch (error) {
      this.ctx.log(`user lookup failed for ${id}: ${(error as Error).message}`);
      return { guest: true, name: id, at: Date.now() };
    }
  }
  private async channel(id: string) {
    const hit = this.channels.get(id);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit;
    const [info, stats] = await Promise.all([
      this.api<{ name?: string; display_name?: string }>(`/channels/${encodeURIComponent(id)}`).catch(() => ({ name: undefined, display_name: undefined })),
      this.api<{ member_count?: number; guest_count?: number }>(`/channels/${encodeURIComponent(id)}/stats`).catch(() => ({ member_count: undefined, guest_count: undefined })),
    ]);
    const rec = { name: info.name ? `~${info.name}` : info.display_name, members: stats.member_count ?? null, guests: stats.guest_count ?? null, at: Date.now() };
    this.channels.set(id, rec); return rec;
  }
  private async onFrame(raw: string) {
    let frame: { event?: string; data?: Record<string, unknown>; broadcast?: Record<string, unknown> };
    try { frame = JSON.parse(raw); } catch { return; }
    if (frame.event === 'hello') { this.ctx.health('ok'); return; }
    if (frame.event !== 'posted' || !frame.data) return;
    let post: MmPost;
    try { post = JSON.parse(String(frame.data.post)) as MmPost; } catch { return; }
    if (!post.message || post.user_id === this.me?.id || (post.type && post.type !== '') || post.props?.from_bot === 'true') return;
    this.ctx.health('ok', null, { event: true });
    const channelType = String(frame.data.channel_type ?? '');
    const dm = channelType === 'D';
    let mentions: string[] = [];
    try { mentions = frame.data.mentions ? JSON.parse(String(frame.data.mentions)) as string[] : []; } catch { mentions = []; }
    const handle = this.me ? `@${this.me.username}` : null;
    const mentioned = dm || (this.me ? mentions.includes(this.me.id) : false) || (handle ? post.message.includes(handle) : false);
    const [user, channel] = await Promise.all([this.user(post.user_id), dm ? Promise.resolve({ name: undefined, members: 2, guests: null }) : this.channel(post.channel_id)]);
    const message: InboundMessage = {
      connectorId: this.ctx.connector.id, messageId: post.id, externalUserId: post.user_id, userName: user.name,
      text: handle ? post.message.split(handle).join('').trim() : post.message,
      conversation: { kind: dm ? 'dm' : channelType === 'G' ? 'group' : 'channel', id: post.channel_id, name: channel.name, threadId: dm ? (post.root_id || null) : (post.root_id || post.id) },
      mentioned, guest: user.guest, audience: { members: channel.members, guests: channel.guests },
    };
    this.ctx.onMessage(message);
  }
  async send(out: OutboundMessage) {
    await this.api('/posts', { method: 'POST', body: { channel_id: out.conversation.id, message: clip(out.text, 15_000), ...(out.conversation.threadId ? { root_id: out.conversation.threadId } : {}) } });
  }
  async stop() { this.abort.abort(); this.ws?.close(1000, 'stopping'); }
}
