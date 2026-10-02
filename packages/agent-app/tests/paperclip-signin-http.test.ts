/** Layer 2 of #285 in CI: the whole "Sign in with Paperclip" flow over real HTTP on loopback with real timers and real fetch, against
 *  a faithful mock of an AUTHENTICATED Paperclip's challenge API (tests/fixtures/paperclip-challenge-mock.ts: same routes, JSON shapes
 *  and status codes as server/src/routes/access.ts; every data route needs the Bearer board key). The real Paperclip (HTTPS, real login
 *  page) is exercised by the local E2E described in the PR; CI uses the mock, which is a stand-in, not Paperclip itself. */
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {createServer, type Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test, type TestContext} from 'node:test';
import {createPaperclipDomain, PAPERCLIP_SECRET_ID} from '../src/runtime/domains/paperclip.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {createChallengeMock, MOCK_USER} from './fixtures/paperclip-challenge-mock.ts';

async function listen(t: TestContext) {
  const mock = createChallengeMock();
  const hits: {path: string; auth?: string}[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      hits.push({path: req.url ?? '', auth: req.headers.authorization});
      const reply = mock.handle(req.method ?? 'GET', req.url ?? '/', {authorization: req.headers.authorization}, raw ? JSON.parse(raw) : undefined);
      res.writeHead(reply.status, {'content-type': 'application/json'}); res.end(JSON.stringify(reply.json ?? {}));
    });
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise<void>(r => { server.closeAllConnections(); server.close(() => r()); }));
  return {mock, hits, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`};
}
async function domain(t: TestContext) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-signin-http-')); t.after(() => rm(dataDir, {recursive: true, force: true}));
  const values = new Map<string, string>();
  const secrets = {status: (id: string) => ({stored: values.has(id), updatedAt: null, secureStorage: true}), get: (id: string) => values.get(id), set(id: string, v: string) { values.set(id, v); return this.status(id); }, clear(id: string) { values.delete(id); return this.status(id); }};
  const context = {dataDir, db: () => { throw new Error('no db'); }, store: {snapshot: () => ({folders: []})}, emit() {}, hooks: {}, async invoke() { throw new Error('unexpected'); }} as unknown as DomainContext;
  const d = createPaperclipDomain(context, {secrets: () => secrets as never});
  t.after(() => d.dispose?.());
  return {values, call: (command: string, input: Record<string, unknown> = {}) => Promise.resolve(d.handlers[command]!(input)) as Promise<any>};
}
const until = async (check: () => Promise<boolean>, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await check()) return; await new Promise(r => setTimeout(r, 100)); } throw new Error('timed out waiting'); };

test('authenticated Paperclip over HTTP: sign in, whoami, test, sign out; the key is revoked and a later request gets 401', async t => {
  const server = await listen(t), d = await domain(t);
  const anon = await d.call('paperclip.test', {mode: 'custom', baseUrl: server.base});
  assert.equal(anon.stage, 'auth', 'authenticated mode: no key, no data');
  const started = await d.call('paperclip.signin.start', {baseUrl: server.base});
  assert.equal(started.phase, 'waiting'); assert.ok(started.approvalUrl.startsWith(`${server.base}/cli-auth/`));
  assert.equal((await d.call('paperclip.config.get')).hasToken, false, 'nothing is stored until you approve');
  server.mock.approve(server.mock.firstId()); // the browser: sign in on Paperclip's page, press Approve
  await until(async () => (await d.call('paperclip.signin.status')).phase === 'signed-in');
  const view = await d.call('paperclip.config.get');
  assert.deepEqual(view.signedIn, {name: MOCK_USER.name, email: MOCK_USER.email}); assert.equal(view.hasToken, true);
  const test = await d.call('paperclip.test', {mode: 'custom', baseUrl: server.base});
  assert.equal(test.ok, true, JSON.stringify(test)); assert.equal(test.companies[0].name, 'MockCo');
  const key = d.values.get(PAPERCLIP_SECRET_ID)!;
  const out = await d.call('paperclip.signin.signout');
  assert.equal(out.revoked, true); assert.equal(d.values.has(PAPERCLIP_SECRET_ID), false);
  const later = await fetch(`${server.base}/api/companies`, {headers: {authorization: `Bearer ${key}`}});
  assert.equal(later.status, 401);
  assert.ok(server.hits.filter(h => h.auth).every(h => h.auth === `Bearer ${key}`), 'only the issued key was ever sent');
});

test('over HTTP: cancel, a key revoked in Paperclip, and a wrong origin never getting the key', async t => {
  const server = await listen(t), other = await listen(t), d = await domain(t);
  await d.call('paperclip.signin.start', {baseUrl: server.base});
  const cancelled = await d.call('paperclip.signin.cancel');
  assert.equal(cancelled.phase, 'cancelled'); assert.equal(server.mock.challenges.values().next().value!.cancelledAt !== undefined, true);
  await d.call('paperclip.signin.start', {baseUrl: server.base});
  server.mock.approve([...server.mock.challenges.keys()].pop()!);
  await until(async () => (await d.call('paperclip.signin.status')).phase === 'signed-in');
  const wrong = await d.call('paperclip.test', {mode: 'custom', baseUrl: other.base});
  assert.equal(wrong.ok, false); assert.ok(other.hits.length > 0 && other.hits.every(h => !h.auth), 'the other host never saw the key');
  server.mock.revokeKeyInPaperclip();
  const revoked = await d.call('paperclip.test', {mode: 'custom', baseUrl: server.base});
  assert.equal(revoked.message, 'Signed out by Muster Server — sign in again.');
  assert.equal(d.values.has(PAPERCLIP_SECRET_ID), false);
});
