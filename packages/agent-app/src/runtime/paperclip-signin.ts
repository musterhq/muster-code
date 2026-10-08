/**
 * The Paperclip adapter of ServerAuth (#285): Paperclip's own browser-approval flow (its CLI auth challenge).
 *   POST /api/cli-auth/challenges -> id, challenge secret, pending board key, approval page
 *   GET  /api/cli-auth/challenges/:id?token=... -> pending | approved | cancelled | expired
 *   GET  /api/cli-auth/me (Bearer: the new key) -> who signed in
 *   POST /api/cli-auth/revoke-current (Bearer) -> revokes it
 * Paperclip's approval page offers Approve and Cancel only, so a decline arrives as `cancelled`.
 * A Muster Server adapter is a sibling of this file implementing the same ServerAuth calls.
 */
import type { FetchLike } from './paperclip-client.ts';
import { isLoopback, normalizeBaseUrl } from './paperclip-client.ts';
import { createServerSignIn, Unreachable, type ChallengeStatus, type ServerAuth, type ServerChallenge, type SignInDeps } from './server-auth.ts';
import { device } from '../shared/device-noun.ts';

export { SIGNED_OUT_BY_SERVER } from './server-auth.ts';
export type { SignedInUser } from './server-auth.ts';

const REQUEST_MS = 10_000, DEFAULT_POLL_MS = 1_000;
const isUuidLike = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f-]{8,64}$/i.test(v);
const notServer = (host: string) => new Error(`${host} does not look like a Muster Server. Check the address, and use the server’s own URL.`);
interface Reply { status: number; json: Record<string, unknown> | null; page: boolean }

export function createPaperclipAuth(fetcher: FetchLike): ServerAuth {
  async function call(method: 'GET' | 'POST', url: string, opts: { token?: string; body?: unknown } = {}): Promise<Reply> {
    let response: Response;
    try {
      response = await fetcher(url, {
        method, redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS),
        headers: { accept: 'application/json', ...(opts.body !== undefined ? { 'content-type': 'application/json' } : {}), ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      });
    } catch { throw new Unreachable(); }
    const text = await response.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try { const parsed = JSON.parse(text) as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* a web page or empty body */ }
    return { status: response.status, json, page: /^\s*</.test(text) };
  }
  return {
    async start(input) {
      const base = normalizeBaseUrl(input), url = new URL(base);
      if (url.protocol === 'http:' && !isLoopback(base)) throw new Error(`Muster will not sign in over plain http to ${url.host}: the key would travel readable by anyone on the network. Use an https:// address.`);
      let reply: Reply;
      try { reply = await call('POST', `${base}/api/cli-auth/challenges`, { body: { command: 'Muster Agent: link Projects', clientName: 'Muster Agent', requestedAccess: 'board' } }); }
      catch { throw new Error(`Muster cannot reach the server at ${url.host}. Check the address and your connection.`); }
      const j = reply.json;
      if (reply.status === 404 || reply.status === 405 || reply.page || !j) throw notServer(url.host);
      if (reply.status === 429) throw new Error(`The server at ${url.host} is limiting requests. Wait a moment and try again.`);
      if (reply.status !== 200 && reply.status !== 201) throw new Error(`The server at ${url.host} refused to start a sign-in (${reply.status}).`);
      const id = j.id, secret = j.token, key = j.boardApiToken, path = j.approvalPath, expiresAt = typeof j.expiresAt === 'string' ? Date.parse(j.expiresAt) : NaN;
      if (!isUuidLike(id) || typeof secret !== 'string' || secret.length < 16 || typeof key !== 'string' || !key || typeof path !== 'string' || !path.startsWith('/cli-auth/') || !Number.isFinite(expiresAt)) throw notServer(url.host);
      const suggested = typeof j.suggestedPollIntervalMs === 'number' && j.suggestedPollIntervalMs > 0 ? j.suggestedPollIntervalMs : DEFAULT_POLL_MS;
      // The link always points at the address you typed: a proxy's idea of its own address never decides where you sign in.
      return { baseUrl: base, origin: url.origin, challenge: { id, secret, key, approvalUrl: `${base}${path}`, expiresAt, pollIntervalMs: suggested } };
    },
    async poll(base, c): Promise<ChallengeStatus | 'invalid'> {
      const reply = await call('GET', `${base}/api/cli-auth/challenges/${encodeURIComponent(c.id)}?token=${encodeURIComponent(c.secret)}`);
      if (reply.status === 404 || reply.status === 400) return 'gone';
      if (reply.status !== 200 && reply.status !== 304) throw new Unreachable(); // 5xx, 429...: back off and ask again
      const status = reply.json?.status;
      if (typeof status !== 'string') return 'invalid';
      return status === 'pending' || status === 'approved' || status === 'cancelled' || status === 'expired' ? status : 'invalid';
    },
    async cancel(base, c) { await call('POST', `${base}/api/cli-auth/challenges/${encodeURIComponent(c.id)}/cancel`, { body: { token: c.secret } }); },
    async whoami(base, key) {
      const me = await call('GET', `${base}/api/cli-auth/me`, { token: key });
      if (me.status !== 200 || !me.json) return null;
      const user = (me.json.user && typeof me.json.user === 'object' ? me.json.user : {}) as Record<string, unknown>;
      return { name: typeof user.name === 'string' ? user.name : null, email: typeof user.email === 'string' ? user.email : null, userId: typeof me.json.userId === 'string' ? me.json.userId : null };
    },
    async revoke(base, key) {
      try {
        const reply = await call('POST', `${normalizeBaseUrl(base)}/api/cli-auth/revoke-current`, { token: key, body: {} });
        if (reply.status === 200) return { revoked: true };
        if (reply.status === 401 || reply.status === 403) return { revoked: true, message: 'The server had already signed '+device().lower+' out.' };
        return { revoked: false, message: `The server did not confirm the sign-out (${reply.status}). The key was removed from ${device().lower}; remove it from the server’s API keys too.` };
      } catch { return { revoked: false, message: 'The server could not be reached, so its key could not be revoked. The key was removed from '+device().lower+'; remove it from the server’s API keys too.' }; }
    },
  };
}

/** The controller wired to Paperclip. */
export const createPaperclipSignIn = (deps: SignInDeps & { fetch: FetchLike }) => createServerSignIn(createPaperclipAuth(deps.fetch), deps);
