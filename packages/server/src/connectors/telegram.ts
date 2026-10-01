/** Telegram Bot API: long polling (default, works behind NAT) or webhook with a per-bot secret token. */
import { safeEqual } from '../auth/tokens.ts';
import { backoff, clip, ConnectorHttpError, requestJson, sleep, type AdapterContext, type ConnectorAdapter, type InboundMessage, type OutboundMessage, type WebhookRequest } from './types.ts';

interface TgUser { id: number; is_bot?: boolean; username?: string; first_name?: string; last_name?: string }
interface TgMessage { message_id: number; from?: TgUser; chat: { id: number; type: 'private' | 'group' | 'supergroup' | 'channel'; title?: string; username?: string };
  text?: string; message_thread_id?: number; reply_to_message?: { from?: TgUser; message_id: number }; entities?: Array<{ type: string; offset: number; length: number }> }
interface TgUpdate { update_id: number; message?: TgMessage }

export class TelegramAdapter implements ConnectorAdapter {
  private abort = new AbortController();
  private me?: TgUser;
  private memberCounts = new Map<number, { n: number | null; at: number }>();
  constructor(private readonly ctx: AdapterContext) {}
  private get apiBase() { return String(this.ctx.connector.config.apiBase || 'https://api.telegram.org').replace(/\/+$/, ''); }
  private async token(): Promise<string> {
    const t = await this.ctx.secret('botToken');
    if (!t) throw new ConnectorHttpError('No bot token stored for this connector.', 401);
    return t;
  }
  private async call<T>(method: string, body?: Record<string, unknown>, timeoutMs?: number): Promise<T> {
    const res = await requestJson<{ ok: boolean; result: T; description?: string }>(`${this.apiBase}/bot${await this.token()}/${method}`, { body: body ?? {}, timeoutMs, signal: this.abort.signal });
    if (!res.ok) throw new ConnectorHttpError(`Telegram ${method}: ${res.description ?? 'failed'}`, 400);
    return res.result;
  }
  async test() {
    const t0 = Date.now();
    try { const me = await this.call<TgUser>('getMe'); return { ok: true, detail: `Bot @${me.username ?? me.id}`, latencyMs: Date.now() - t0 }; }
    catch (error) { return { ok: false, detail: error instanceof Error ? error.message : String(error), latencyMs: Date.now() - t0 }; }
  }
  async start() {
    this.abort = new AbortController();
    this.ctx.health('connecting');
    try { this.me = await this.call<TgUser>('getMe'); }
    catch (error) { this.ctx.health(error instanceof ConnectorHttpError && (error.status === 401 || error.status === 404) ? 'unauth' : 'down', String((error as Error).message)); if (!(error instanceof ConnectorHttpError)) void this.retryStart(); return; }
    if (this.ctx.connector.mode === 'webhook') {
      if (!this.ctx.publicUrl) { this.ctx.health('degraded', 'Webhook mode needs the server public URL (muster-server start --public-url https://…).'); return; }
      const secret = await this.ctx.secret('webhookSecret');
      await this.call('setWebhook', { url: `${this.ctx.publicUrl.replace(/\/+$/, '')}/hooks/telegram/${this.ctx.connector.webhookPublicId}`, ...(secret ? { secret_token: secret } : {}), allowed_updates: ['message'] });
      this.ctx.health('ok');
      return;
    }
    await this.call('deleteWebhook', { drop_pending_updates: false }).catch(() => undefined);
    // Authenticated and polling: healthy now, not only after the first long poll (up to 25 s) returns.
    this.ctx.health('ok');
    void this.poll();
  }
  private async retryStart() { await sleep(15_000, this.abort.signal); if (!this.abort.signal.aborted) await this.start(); }
  private async poll() {
    let offset = 0, failures = 0;
    while (!this.abort.signal.aborted) {
      try {
        const t0 = Date.now();
        const updates = await this.call<TgUpdate[]>('getUpdates', { offset, timeout: Number(this.ctx.connector.config.pollTimeoutSec ?? 25), allowed_updates: ['message'] }, 40_000);
        if (failures) this.ctx.health('ok', null, { reconnect: true, latencyMs: Date.now() - t0 }); else this.ctx.health('ok', null, { latencyMs: Date.now() - t0 });
        failures = 0;
        for (const u of updates) { offset = Math.max(offset, u.update_id + 1); if (u.message) await this.handle(u.message); }
      } catch (error) {
        if (this.abort.signal.aborted) return;
        failures++;
        const unauth = error instanceof ConnectorHttpError && (error.status === 401 || error.status === 404);
        this.ctx.health(unauth ? 'unauth' : failures > 3 ? 'down' : 'degraded', String((error as Error).message));
        await sleep(unauth ? 60_000 : backoff(failures), this.abort.signal);
      }
    }
  }
  async webhook(request: WebhookRequest) {
    const secret = await this.ctx.secret('webhookSecret');
    const given = request.headers['x-telegram-bot-api-secret-token'];
    if (secret && (typeof given !== 'string' || !safeEqual(given, secret))) return { status: 401, body: 'bad secret token' };
    let update: TgUpdate;
    try { update = JSON.parse(request.body) as TgUpdate; } catch { return { status: 400, body: 'bad json' }; }
    if (update.message) await this.handle(update.message);
    this.ctx.health('ok', null, { event: true });
    return { status: 200, body: '{}', contentType: 'application/json' };
  }
  private async audience(chatId: number): Promise<number | null> {
    const hit = this.memberCounts.get(chatId);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.n;
    const n = await this.call<number>('getChatMemberCount', { chat_id: chatId }).catch(() => null);
    this.memberCounts.set(chatId, { n, at: Date.now() });
    return n;
  }
  private async handle(m: TgMessage) {
    if (!m.text || !m.from || m.from.is_bot) return;
    this.ctx.health('ok', null, { event: true });
    const dm = m.chat.type === 'private';
    const handle = this.me?.username ? `@${this.me.username}` : null;
    const mentioned = dm || (handle ? m.text.toLowerCase().includes(handle.toLowerCase()) : false) || m.reply_to_message?.from?.id === this.me?.id;
    const text = handle ? m.text.replace(new RegExp(handle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), '').trim() : m.text;
    const message: InboundMessage = {
      connectorId: this.ctx.connector.id, messageId: String(m.message_id), externalUserId: String(m.from.id),
      userName: m.from.username ? `@${m.from.username}` : [m.from.first_name, m.from.last_name].filter(Boolean).join(' ') || String(m.from.id), text,
      conversation: { kind: dm ? 'dm' : 'group', id: String(m.chat.id), name: m.chat.title ?? m.chat.username, threadId: m.message_thread_id ? String(m.message_thread_id) : null },
      mentioned, guest: false,
      audience: dm ? { members: 2, guests: 0 } : { members: await this.audience(m.chat.id), guests: null },
    };
    this.ctx.onMessage(message);
  }
  async send(out: OutboundMessage) {
    await this.call('sendMessage', { chat_id: out.conversation.id, text: clip(out.text, 4000), ...(out.conversation.threadId ? { message_thread_id: Number(out.conversation.threadId) } : {}) });
  }
  async stop() { this.abort.abort(); }
}
