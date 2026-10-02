/** A faithful stand-in for Paperclip's CLI auth challenge API (server/src/routes/access.ts, #285). Used by the unit tests (behind a fake
 *  fetch) and by the CI test (behind a real HTTP server). Same routes, same JSON shapes, same status codes as Paperclip:
 *  POST /api/cli-auth/challenges, GET .../:id?token=, POST .../:id/approve|cancel (the browser session), GET /api/cli-auth/me,
 *  POST /api/cli-auth/revoke-current, GET /api/health, GET /api/companies (Bearer board key required, like authenticated mode). */
import {randomBytes, randomUUID} from 'node:crypto';

export interface MockReply {status: number; json?: unknown; text?: string}
interface Challenge {id: string; secret: string; key: string; keyId: string; expiresAt: number; cancelledAt?: number; approvedAt?: number; approvedBy?: string}
export const MOCK_USER = {id: 'user-0001', name: 'Test Founder', email: 'founder@example.test'};

export function createChallengeMock(options: {now?: () => number; ttlMs?: number; origin?: string} = {}) {
  const now = options.now ?? Date.now, ttl = options.ttlMs ?? 5 * 60_000;
  const challenges = new Map<string, Challenge>();
  const keys = new Map<string, {id: string; revoked: boolean}>();
  const requests: {method: string; path: string; authorization?: string}[] = [];
  const status = (c: Challenge) => c.cancelledAt ? 'cancelled' : c.expiresAt <= now() ? 'expired' : c.approvedAt ? 'approved' : 'pending';
  const bearer = (header?: string) => { const m = /^Bearer (.+)$/.exec(header ?? ''); const key = m && keys.get(m[1]!); return key && !key.revoked ? key : null; };
  function handle(method: string, url: string, headers: {authorization?: string} = {}, body: unknown = undefined): MockReply {
    const u = new URL(url, 'http://mock.invalid'), path = u.pathname;
    requests.push({method, path, authorization: headers.authorization});
    if (method === 'GET' && path === '/api/health') return {status: 200, json: {status: 'ok', version: '2026.mock', deploymentMode: 'authenticated', authReady: true}};
    if (method === 'POST' && path === '/api/cli-auth/challenges') {
      const b = (body ?? {}) as {command?: unknown};
      if (typeof b.command !== 'string' || !b.command) return {status: 400, json: {error: 'Validation error'}};
      const c: Challenge = {id: randomUUID(), secret: randomBytes(24).toString('hex'), key: `pcp_board_${randomBytes(24).toString('hex')}`, keyId: randomUUID(), expiresAt: now() + ttl};
      challenges.set(c.id, c);
      const approvalPath = `/cli-auth/${c.id}?token=${encodeURIComponent(c.secret)}`;
      return {status: 201, json: {id: c.id, token: c.secret, boardApiToken: c.key, approvalPath, approvalUrl: options.origin ? `${options.origin}${approvalPath}` : null, pollPath: `/cli-auth/challenges/${c.id}`, expiresAt: new Date(c.expiresAt).toISOString(), suggestedPollIntervalMs: 1000}};
    }
    const one = /^\/api\/cli-auth\/challenges\/([^/]+)(\/approve|\/cancel)?$/.exec(path);
    if (one) {
      const c = challenges.get(one[1]!);
      const token = method === 'GET' ? u.searchParams.get('token') : (body as {token?: string} | undefined)?.token;
      if (!c || !token || token !== c.secret) return {status: 404, json: {error: 'CLI auth challenge not found'}};
      if (method === 'GET' && !one[2]) return {status: 200, json: {id: c.id, status: status(c), command: 'muster', clientName: 'Muster Agent', requestedAccess: 'board', requestedCompanyId: null, requestedCompanyName: null, approvedAt: c.approvedAt ? new Date(c.approvedAt).toISOString() : null, cancelledAt: c.cancelledAt ? new Date(c.cancelledAt).toISOString() : null, expiresAt: new Date(c.expiresAt).toISOString(), approvedByUser: c.approvedBy ? MOCK_USER : null, requiresSignIn: true, canApprove: false, currentUserId: null}};
      if (method === 'POST' && one[2] === '/cancel') { if (status(c) === 'pending') c.cancelledAt = now(); return {status: 200, json: {status: status(c), cancelled: status(c) === 'cancelled'}}; }
    }
    if (method === 'GET' && path === '/api/cli-auth/me') {
      const key = bearer(headers.authorization);
      if (!key) return {status: 401, json: {error: 'Board authentication required'}};
      return {status: 200, json: {user: MOCK_USER, userId: MOCK_USER.id, isInstanceAdmin: true, companyIds: [], memberships: [], source: 'board_key', keyId: key.id}};
    }
    if (method === 'POST' && path === '/api/cli-auth/revoke-current') {
      const key = bearer(headers.authorization);
      if (!key) return {status: 400, json: {error: 'Current board API key context is required'}};
      key.revoked = true; return {status: 200, json: {revoked: true, keyId: key.id}};
    }
    if (method === 'GET' && path === '/api/companies') {
      if (!bearer(headers.authorization)) return {status: 401, json: {error: 'Board access required'}};
      return {status: 200, json: [{id: 'c0000000-0000-4000-8000-000000000001', name: 'MockCo', issuePrefix: 'MCK', status: 'active'}]};
    }
    return {status: 404, json: {error: 'API route not found'}};
  }
  return {
    handle, requests, challenges, keys,
    /** What the browser does on Paperclip's approval page, after you sign in: POST .../approve from the session. */
    approve(id: string) { const c = challenges.get(id)!; if (status(c) !== 'pending') return status(c); c.approvedAt = now(); c.approvedBy = MOCK_USER.id; keys.set(c.key, {id: c.keyId, revoked: false}); return 'approved'; },
    cancelInBrowser(id: string) { const c = challenges.get(id)!; if (status(c) === 'pending') c.cancelledAt = now(); },
    revokeKeyInPaperclip() { for (const key of keys.values()) key.revoked = true; },
    firstId: () => [...challenges.keys()][0]!,
  };
}
export type ChallengeMock = ReturnType<typeof createChallengeMock>;
/** `fetch` over the mock, for tests that need no sockets. */
export const mockFetch = (mock: ChallengeMock) => async (input: string, init: RequestInit = {}): Promise<Response> => {
  const headers = Object.fromEntries(Object.entries((init.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
  const reply = mock.handle(init.method ?? 'GET', input, headers, init.body ? JSON.parse(String(init.body)) : undefined);
  return new Response(reply.text ?? JSON.stringify(reply.json ?? {}), {status: reply.status, headers: {'content-type': 'application/json'}});
};
