/** "Sign in with Paperclip" (#285): the challenge/poll state machine, origin binding, revoke and 401 handling, against a faithful
 *  mock of Paperclip's CLI auth challenge API, a fake clock and fake timers. Nothing here opens a socket. */
import assert from 'node:assert/strict';
import {mkdtemp, readFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {createPaperclipSignIn, SIGNED_OUT_BY_SERVER} from '../src/runtime/paperclip-signin.ts';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {SERVER_SECRET as PAPERCLIP_SECRET_ID} from '../src/runtime/server/config.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {createChallengeMock, mockFetch, MOCK_USER} from './fixtures/paperclip-challenge-mock.ts';

function clock() {
  let t = Date.now();
  const timers = new Map<number, {fn: () => void; at: number}>(); let n = 0;
  return {
    now: () => t, timers,
    api: {setTimeout: ((fn: () => void, ms: number) => { timers.set(++n, {fn, at: t + ms}); return n; }) as unknown as typeof setTimeout, clearTimeout: ((id: number) => { timers.delete(id); }) as unknown as typeof clearTimeout},
    /** Advance time and run every timer that came due, in order, letting promises settle between them. */
    async advance(ms: number) {
      const end = t + ms;
      for (;;) {
        const due = [...timers].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]); t = Math.max(t, due[1].at); due[1].fn();
        for (let i = 0; i < 20; i++) await new Promise(r => setImmediate(r));
      }
      t = end;
    },
    pending: () => [...timers.values()].map(x => x.at - t),
  };
}
function rig(opts: {ttlMs?: number} = {}) {
  const c = clock(), mock = createChallengeMock({now: c.now, ttlMs: opts.ttlMs});
  const events: string[] = [], approvals: {origin: string; baseUrl: string; token: string; user: unknown}[] = [];
  let fetchImpl = mockFetch(mock);
  const calls: {method: string; url: string}[] = [];
  const signIn = createPaperclipSignIn({
    fetch: (input, init) => { calls.push({method: init?.method ?? 'GET', url: input}); return fetchImpl(input, init); },
    now: c.now, timers: c.api, changed: () => events.push('changed'),
    approved: r => { approvals.push(r); },
  });
  return {c, mock, signIn, events, approvals, calls, setFetch: (f: typeof fetchImpl) => { fetchImpl = f; }};
}
const BASE = 'https://paperclip.example.test';

test('approval: the link opens at the typed address, polls once a second while waiting, then stores the key bound to that origin', async () => {
  const r = rig();
  const state = await r.signIn.start(`${BASE}/`);
  assert.equal(state.phase, 'waiting');
  assert.match(state.approvalUrl!, new RegExp(`^${BASE}/cli-auth/[0-9a-f-]+\\?token=`));
  assert.equal(state.expiresAt, new Date(r.c.now() + 5 * 60_000).toISOString());
  assert.deepEqual(r.c.pending(), [1000], 'one timer, at the interval Paperclip suggested');
  const polls = () => r.calls.filter(x => x.method === 'GET' && x.url.includes('/challenges/')).length;
  await r.c.advance(1000); await r.c.advance(1000);
  assert.equal(polls(), 2);
  assert.equal(r.signIn.state().phase, 'waiting');
  r.mock.approve(r.mock.firstId());
  await r.c.advance(1000);
  assert.equal(r.signIn.state().phase, 'signed-in');
  assert.deepEqual(r.signIn.state().user, {name: MOCK_USER.name, email: MOCK_USER.email});
  assert.equal(r.approvals.length, 1);
  assert.equal(r.approvals[0]!.origin, BASE);
  assert.match(r.approvals[0]!.token, /^pcp_board_/);
  const me = r.mock.requests.filter(x => x.path === '/api/cli-auth/me');
  assert.equal(me.length, 1);
  assert.equal(me[0]!.authorization, `Bearer ${r.approvals[0]!.token}`, '/cli-auth/me answered for the new key');
  assert.deepEqual(r.c.pending(), [], 'no timer is left once signed in: nothing polls any more');
  const after = r.calls.length; await r.c.advance(60_000);
  assert.equal(r.calls.length, after);
  const exposed = JSON.stringify(r.signIn.state());
  assert.ok(!exposed.includes(r.approvals[0]!.token), 'the key is never part of the state the UI sees');
});

test('cancelled in the browser, expired by the clock, expired by Paperclip, and a request Paperclip forgot', async () => {
  let r = rig();
  await r.signIn.start(BASE); r.mock.cancelInBrowser(r.mock.firstId()); await r.c.advance(1000);
  assert.equal(r.signIn.state().phase, 'cancelled'); assert.match(r.signIn.state().message!, /cancelled on the server/); assert.deepEqual(r.c.pending(), []);

  r = rig({ttlMs: 3500});
  await r.signIn.start(BASE); await r.c.advance(3000);
  assert.equal(r.signIn.state().phase, 'waiting');
  await r.c.advance(1000);
  assert.equal(r.signIn.state().phase, 'expired'); assert.match(r.signIn.state().message!, /expired/); assert.equal(r.approvals.length, 0); assert.deepEqual(r.c.pending(), []);

  r = rig();
  await r.signIn.start(BASE);
  r.setFetch(async (_i, init) => new Response(JSON.stringify(init?.method === 'POST' ? {} : {id: 'x', status: 'expired'}), {status: 200}));
  await r.c.advance(1000); assert.equal(r.signIn.state().phase, 'expired');

  r = rig();
  await r.signIn.start(BASE); r.mock.challenges.clear(); await r.c.advance(1000);
  assert.equal(r.signIn.state().phase, 'failed'); assert.match(r.signIn.state().message!, /no longer knows/);
});

test('the Cancel button tells Paperclip, stops waiting and leaves no timer', async () => {
  const r = rig();
  await r.signIn.start(BASE);
  const state = await r.signIn.cancel();
  assert.equal(state.phase, 'cancelled'); assert.equal(state.message, 'Sign-in cancelled.');
  assert.ok(r.calls.some(c => c.method === 'POST' && /\/cancel$/.test(c.url)));
  assert.equal([...r.mock.challenges.values()][0]!.cancelledAt !== undefined, true);
  assert.deepEqual(r.c.pending(), []);
  assert.equal(r.approvals.length, 0);
  r.mock.approve(r.mock.firstId()); await r.c.advance(10_000);
  assert.equal(r.signIn.state().phase, 'cancelled', 'an approval after Cancel changes nothing');
  assert.equal(r.approvals.length, 0);
});

test('polling backs off while Paperclip is not answering and gives up with a sentence; it recovers if it answers again', async () => {
  const r = rig();
  await r.signIn.start(BASE);
  const good = mockFetch(r.mock);
  r.setFetch(async () => { throw new TypeError('fetch failed'); });
  const before = r.calls.length;
  await r.c.advance(1000); // fail 1 -> next wait 2 s
  assert.deepEqual(r.c.pending(), [2000]);
  await r.c.advance(2000); // fail 2 -> 4 s
  assert.deepEqual(r.c.pending(), [4000]);
  assert.equal(r.calls.length - before, 2);
  r.setFetch(good);
  r.mock.approve(r.mock.firstId());
  await r.c.advance(4000);
  assert.equal(r.signIn.state().phase, 'signed-in', 'a hiccup does not lose the sign-in');

  const down = rig();
  await down.signIn.start(BASE);
  down.setFetch(async () => { throw new TypeError('fetch failed'); });
  await down.c.advance(120_000);
  assert.equal(down.signIn.state().phase, 'failed'); assert.match(down.signIn.state().message!, /lost contact with paperclip\.example\.test/);
  assert.deepEqual(down.c.pending(), []);
  assert.ok(down.calls.length <= 8, `bounded polling, saw ${down.calls.length} requests`);
});

test('errors in plain words: not a server, not Paperclip, plain http to a remote host, and a server that is not there', async () => {
  const r = rig();
  r.setFetch(async () => new Response('<!doctype html><html></html>', {status: 200}));
  await assert.rejects(r.signIn.start(BASE), /does not look like a Muster Server/);
  r.setFetch(async () => new Response('{"error":"nope"}', {status: 404}));
  await assert.rejects(r.signIn.start(BASE), /does not look like a Muster Server/);
  r.setFetch(async () => new Response(JSON.stringify({id: 'abc', token: 'x'}), {status: 201}));
  await assert.rejects(r.signIn.start(BASE), /does not look like a Muster Server/, 'a reply without the challenge fields is not Paperclip');
  r.setFetch(async () => { throw new TypeError('fetch failed'); });
  await assert.rejects(r.signIn.start(BASE), /cannot reach the server at paperclip\.example\.test/);
  const before = r.calls.length;
  await assert.rejects(r.signIn.start('http://paperclip.example.test'), /will not sign in over plain http to paperclip\.example\.test/);
  assert.equal(r.calls.length, before, 'refused before any request');
  await assert.rejects(r.signIn.start('ftp://x'), /http/);
  await assert.rejects(r.signIn.start('https://user:pw@x.test'), /token field/);
  assert.equal(r.signIn.state().phase, 'idle'); assert.deepEqual(r.c.pending(), []);
  // loopback http is allowed (a Paperclip on this Mac)
  const loop = rig(); const s = await loop.signIn.start('http://127.0.0.1:3100'); assert.equal(s.phase, 'waiting');
  assert.ok(s.approvalUrl!.startsWith('http://127.0.0.1:3100/cli-auth/'));
});

test('a proxy that advertises another address never decides where the key goes or where you sign in', async () => {
  const c = clock(), mock = createChallengeMock({now: c.now, origin: 'https://evil.example.net'});
  const seen: string[] = [];
  const signIn = createPaperclipSignIn({fetch: (i, init) => { seen.push(new URL(i).origin); return mockFetch(mock)(i, init); }, now: c.now, timers: c.api, changed() {}, approved() {}});
  const state = await signIn.start(BASE);
  assert.ok(state.approvalUrl!.startsWith(`${BASE}/cli-auth/`));
  mock.approve(mock.firstId()); await c.advance(1000);
  assert.equal(signIn.state().phase, 'signed-in');
  assert.deepEqual([...new Set(seen)], [BASE]);
});

test('a second sign-in replaces the first: the old request is cancelled and only the new one can complete', async () => {
  const r = rig();
  await r.signIn.start(BASE); const first = r.mock.firstId();
  await r.signIn.start(BASE);
  assert.equal(r.mock.challenges.get(first)!.cancelledAt !== undefined, true);
  assert.equal(r.c.pending().length, 1);
  const second = [...r.mock.challenges.keys()][1]!;
  r.mock.approve(second); await r.c.advance(1000);
  assert.equal(r.approvals.length, 1);
});

// ---- the domain: storing the key, origin binding, sign out, and a key revoked in Paperclip --------------------------------
async function domainRig(t: TestContext, extra: {pasted?: boolean} = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-signin-')); t.after(() => rm(dataDir, {recursive: true, force: true}));
  const c = clock(), mock = createChallengeMock({now: c.now});
  const values = new Map<string, string>();
  const secrets = {status: (id: string) => ({stored: values.has(id), updatedAt: null, secureStorage: true}), get: (id: string) => values.get(id), set(id: string, v: string) { values.set(id, v); return this.status(id); }, clear(id: string) { values.delete(id); return this.status(id); }};
  const events: unknown[] = [], seen: {url: string; auth?: string}[] = [];
  const base = mockFetch(mock);
  const fetchLike = async (input: string, init?: RequestInit) => { const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v])); seen.push({url: input, auth: h.authorization}); return base(input, init); };
  const context = {dataDir, db: () => { throw new Error('no db'); }, store: {snapshot: () => ({folders: []})}, emit: (e: unknown) => events.push(e), hooks: {}, async invoke() { throw new Error('unexpected'); }} as unknown as DomainContext;
  const domain = createPaperclipDomain(context, {fetch: fetchLike as never, secrets: () => secrets as never, timers: c.api, socket: () => { throw new Error('no socket'); }});
  t.after(() => domain.dispose?.());
  const call = (command: string, input: Record<string, unknown> = {}) => Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  const signInNow = async () => { await call('paperclip.signin.start', {baseUrl: BASE}); mock.approve([...mock.challenges.keys()].pop()!); await c.advance(1000); };
  return {dataDir, c, mock, values, seen, events, call, signInNow};
}

test('approval stores the key encrypted and bound to the origin; the config file and the view carry no key', async t => {
  const h = await domainRig(t);
  await h.signInNow();
  const view = await h.call('paperclip.config.get');
  assert.equal(view.mode, 'custom'); assert.equal(view.baseUrl, BASE); assert.equal(view.hasToken, true);
  assert.deepEqual(view.signedIn, {name: MOCK_USER.name, email: MOCK_USER.email});
  const key = h.values.get(PAPERCLIP_SECRET_ID)!; assert.match(key, /^pcp_board_/);
  const file = await readFile(join(h.dataDir, 'server.json'), 'utf8');
  assert.ok(!file.includes(key)); assert.match(file, /"tokenOrigin": "https:\/\/paperclip\.example\.test"/);
  assert.ok(!JSON.stringify(view).includes(key));
  const test = await h.call('paperclip.test', {mode: 'custom', baseUrl: BASE});
  assert.equal(test.ok, true, JSON.stringify(test));
  assert.equal(test.companies[0].name, 'MockCo');
});

test('the key goes only to its own origin: another host never receives it, and moving to one forgets it and the sign-in', async t => {
  const h = await domainRig(t);
  await h.signInNow();
  const key = h.values.get(PAPERCLIP_SECRET_ID)!;
  h.seen.length = 0;
  const other = await h.call('paperclip.test', {mode: 'custom', baseUrl: 'https://other.example.net'});
  assert.equal(other.ok, false);
  assert.ok(h.seen.length > 0 && h.seen.every(s => !s.auth), 'no Authorization header went to the other host');
  const moved = await h.call('paperclip.config.set', {mode: 'custom', baseUrl: 'https://other.example.net'});
  assert.equal(moved.hasToken, false); assert.equal(moved.signedIn, null); assert.equal(h.values.has(PAPERCLIP_SECRET_ID), false);
  assert.ok(h.seen.every(s => s.auth !== `Bearer ${key}` || s.url.startsWith(BASE)));
});

test('Sign out revokes the key at Paperclip (a later request gets 401) and clears it here', async t => {
  const h = await domainRig(t);
  await h.signInNow();
  const key = h.values.get(PAPERCLIP_SECRET_ID)!;
  const out = await h.call('paperclip.signin.signout');
  assert.equal(out.revoked, true); assert.equal(out.config.hasToken, false); assert.equal(out.config.signedIn, null);
  assert.equal(h.values.has(PAPERCLIP_SECRET_ID), false);
  const revoke = h.mock.requests.find(x => x.path === '/api/cli-auth/revoke-current')!;
  assert.equal(revoke.authorization, `Bearer ${key}`);
  const later = await mockFetch(h.mock)(`${BASE}/api/companies`, {headers: {authorization: `Bearer ${key}`}});
  assert.equal(later.status, 401, 'the revoked key no longer works');
  await assert.rejects(h.call('paperclip.signin.signout'), /not signed in/);
});

test('Sign out still clears the key here when Paperclip cannot be reached, and says the revoke was not confirmed', async t => {
  const h = await domainRig(t);
  await h.signInNow();
  const original = h.mock.handle;
  h.mock.handle = ((m: string, u: string, ...rest: unknown[]) => { if (u.includes('revoke-current')) throw new TypeError('fetch failed'); return (original as any)(m, u, ...rest); }) as never;
  const out = await h.call('paperclip.signin.signout');
  assert.equal(out.revoked, false); assert.match(out.message, /could not be reached/); assert.equal(h.values.has(PAPERCLIP_SECRET_ID), false);
});

test('a key revoked in Paperclip: the next request is a 401, which signs you out with one clear sentence and forgets the dead key', async t => {
  const h = await domainRig(t);
  await h.signInNow();
  assert.equal((await h.call('paperclip.test', {mode: 'custom', baseUrl: BASE})).ok, true);
  h.mock.revokeKeyInPaperclip();
  const result = await h.call('paperclip.test', {mode: 'custom', baseUrl: BASE});
  assert.equal(result.ok, false); assert.equal(result.stage, 'auth'); assert.equal(result.message, SIGNED_OUT_BY_SERVER);
  assert.equal(SIGNED_OUT_BY_SERVER, 'Signed out by Muster Server — sign in again.');
  const view = await h.call('paperclip.config.get');
  assert.equal(view.hasToken, false); assert.equal(view.signedIn, null); assert.equal(view.signInNotice, SIGNED_OUT_BY_SERVER);
  assert.equal(h.values.has(PAPERCLIP_SECRET_ID), false);
  const next = await h.call('paperclip.test', {mode: 'custom', baseUrl: BASE});
  assert.equal(next.message, SIGNED_OUT_BY_SERVER, 'every later request says the same thing, not "needs an API token"');
  // signing in again clears the notice
  await h.signInNow();
  const again = await h.call('paperclip.config.get');
  assert.equal(again.signInNotice, null); assert.equal(again.hasToken, true);
});

test('a pasted token that gets a 401 is not "signed out": only a key from Sign in with Paperclip is', async t => {
  const h = await domainRig(t);
  await h.call('paperclip.config.set', {mode: 'custom', baseUrl: BASE, token: 'pcp_board_pasted_and_wrong'});
  const result = await h.call('paperclip.test', {mode: 'custom', baseUrl: BASE});
  assert.equal(result.ok, false); assert.match(result.message, /refused the API token/);
  assert.equal(h.values.get(PAPERCLIP_SECRET_ID), 'pcp_board_pasted_and_wrong', 'a pasted token is left for you to fix');
  assert.equal((await h.call('paperclip.config.get')).signInNotice, null);
});

test('the challenge secret and the key never appear in what the runtime emits or logs', async t => {
  const h = await domainRig(t);
  const logged: string[] = [];
  const spies = (['log', 'error', 'warn', 'info', 'debug'] as const).map(k => { const orig = console[k]; console[k] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); }; return () => { console[k] = orig; }; });
  t.after(() => spies.forEach(u => u()));
  const started = await h.call('paperclip.signin.start', {baseUrl: BASE});
  const secret = [...h.mock.challenges.values()][0]!.secret, key = [...h.mock.challenges.values()][0]!.key;
  h.mock.approve(h.mock.firstId()); await h.c.advance(1000);
  assert.equal((await h.call('paperclip.signin.status')).phase, 'signed-in');
  const surface = JSON.stringify([h.events, await h.call('paperclip.config.get'), await h.call('paperclip.signin.status'), logged]);
  assert.ok(!surface.includes(key), 'key'); assert.ok(!surface.includes(secret), 'challenge secret');
  assert.ok(started.approvalUrl!.includes(secret), 'only the approval link carries the secret, for the browser');
});

test('the seam: the controller runs any ServerAuth adapter (a Muster Server adapter plugs in here), not only Paperclip', async () => {
  const {createServerSignIn} = await import('../src/runtime/server-auth.ts');
  const c = clock(); let status: 'pending' | 'approved' = 'pending'; const calls: string[] = [];
  const adapter = {
    async start() { calls.push('start'); return {baseUrl: 'https://ms.example.test', origin: 'https://ms.example.test', challenge: {id: 'c1', secret: 's', key: 'k-issued', approvalUrl: 'https://ms.example.test/approve/c1', expiresAt: c.now() + 60_000, pollIntervalMs: 2000}}; },
    async poll() { calls.push('poll'); return status; },
    async cancel() { calls.push('cancel'); },
    async whoami(_b: string, key: string) { calls.push(`whoami:${key}`); return {name: 'Ada', email: 'ada@ms.test', userId: 'u1'}; },
    async revoke() { calls.push('revoke'); return {revoked: true}; },
  };
  const got: unknown[] = [];
  const s = createServerSignIn(adapter, {now: c.now, timers: c.api, changed() {}, approved: r => { got.push(r); }});
  const started = await s.start('https://ms.example.test');
  assert.equal(started.approvalUrl, 'https://ms.example.test/approve/c1'); assert.deepEqual(c.pending(), [2000], 'polls at the adapter\'s interval');
  await c.advance(2000); status = 'approved'; await c.advance(2000);
  assert.equal(s.state().phase, 'signed-in'); assert.deepEqual(calls, ['start', 'poll', 'poll', 'whoami:k-issued']);
  assert.equal((got[0] as {token: string}).token, 'k-issued');
});
