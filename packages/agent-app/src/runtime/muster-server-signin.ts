/**
 * The Muster Server adapter of ServerAuth: the server's own browser approval (packages/server src/auth/challenges.ts).
 *   POST /api/connect/challenges            -> id, secret, approval page (/connect/<id>)
 *   POST /api/connect/challenges/:id/poll   {secret} -> pending | approved + a token (once) | cancelled | expired | gone
 *   POST /rpc server.me (Bearer)            -> who signed in
 *   POST /api/connect/revoke-current        (Bearer) -> revokes the token this app was given
 * The person signs in on the server's own /login page inside the app window; the app never sees the password.
 */
import { hostname } from 'node:os';
import type { FetchLike } from './paperclip-client.ts';
import { Unreachable, type ChallengeStatus, type ServerAuth, type ServerChallenge } from './server-auth.ts';
import { device } from '../shared/device-noun.ts';

const REQUEST_MS = 10_000;
interface Reply { status: number; json: Record<string, unknown> | null }

export function createMusterServerAuth(fetcher: FetchLike): ServerAuth {
  async function post(url: string, body: unknown, token?: string): Promise<Reply> {
    let response: Response;
    try {
      response = await fetcher(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(REQUEST_MS), headers: { 'content-type': 'application/json', accept: 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    } catch { throw new Unreachable(); }
    const text = await response.text().catch(() => '');
    let json: Record<string, unknown> | null = null;
    try { const parsed = JSON.parse(text) as unknown; if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: response.status, json };
  }
  const originOf = (value: unknown): string => {
    let url: URL;
    try { url = new URL(String(value).trim()); } catch { throw new Error('That is not a valid address. Include https://.'); }
    if (url.username || url.password) throw new Error('Leave the user name and password out of the address.');
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Connect needs an https:// address (plain http is only allowed for a server on '+device().lower+').');
    return url.origin;
  };
  return {
    async start(input) {
      const origin = originOf(input), host = new URL(origin).host;
      let reply: Reply;
      try { reply = await post(`${origin}/api/connect/challenges`, { clientName: `Muster app on ${hostname().slice(0, 40)}` }); }
      catch { throw new Error(`Muster can’t reach ${host}. Check the address and that the server is running.`); }
      const j = reply.json;
      if (reply.status === 429) throw new Error(`${host} is limiting requests. Wait a minute and try again.`);
      if (reply.status !== 200 || !j || j.ok !== true || typeof j.id !== 'string' || typeof j.secret !== 'string' || typeof j.approvalPath !== 'string' || !j.approvalPath.startsWith('/connect/') || typeof j.expiresAt !== 'number') throw new Error(`${host} did not accept the request. Is it a Muster Server of a recent version?`);
      return { baseUrl: origin, origin, challenge: { id: j.id, secret: j.secret, key: '', approvalUrl: `${origin}${j.approvalPath}`, expiresAt: j.expiresAt, pollIntervalMs: typeof j.pollIntervalMs === 'number' ? j.pollIntervalMs : 1000 } };
    },
    async poll(base, c: ServerChallenge): Promise<ChallengeStatus | 'invalid'> {
      const reply = await post(`${base}/api/connect/challenges/${encodeURIComponent(c.id)}/poll`, { secret: c.secret });
      if (reply.status === 404 || reply.status === 400) return 'gone';
      if (reply.status !== 200 || !reply.json) throw new Unreachable();
      const status = reply.json.status;
      if (status === 'approved') { if (typeof reply.json.token !== 'string' || !reply.json.token) return 'gone'; c.key = reply.json.token; return 'approved'; }
      if (status === 'gone') return 'gone';
      return status === 'pending' || status === 'cancelled' || status === 'expired' ? status : 'invalid';
    },
    async cancel(base, c) { await post(`${base}/api/connect/challenges/${encodeURIComponent(c.id)}/cancel`, { secret: c.secret }); },
    async whoami(base, key) {
      const reply = await post(`${base}/rpc`, { command: 'server.me', input: {} }, key);
      const value = reply.json?.value as { user?: { id?: string; username?: string; displayName?: string; email?: string | null; role?: string } } | undefined;
      if (reply.status !== 200 || !value?.user) return null;
      const u = value.user;
      return { name: u.displayName ?? u.username ?? null, email: u.email ?? null, userId: u.id ?? null, ...(u.username ? { username: u.username } : {}), ...(u.role ? { role: u.role } : {}) };
    },
    async revoke(base, key) {
      try {
        const reply = await post(`${base}/api/connect/revoke-current`, {}, key);
        if (reply.status === 200) return { revoked: true };
        if (reply.status === 401 || reply.status === 403) return { revoked: true, message: 'The server had already signed '+device().lower+' out.' };
        return { revoked: false, message: `The server did not confirm the disconnect (${reply.status}). The key was removed from ${device().lower}; remove it from the server’s API tokens too.` };
      } catch { return { revoked: false, message: 'The server could not be reached, so its key could not be revoked. The key was removed from '+device().lower+'; remove it from the server’s API tokens too.' }; }
    },
  };
}
