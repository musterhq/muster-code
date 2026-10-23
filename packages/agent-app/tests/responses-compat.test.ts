// The loopback bridge that fills missing usage counters for configured Responses gateways (#678).
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {createServer, type IncomingMessage} from 'node:http';
import type {AddressInfo} from 'node:net';
import {createRequire} from 'node:module';

const require = createRequire(import.meta.url);
const {startResponsesCompatibility} = require('../resources/responses-compat.cjs') as {startResponsesCompatibility: (url: string) => Promise<{baseUrl: string; close(): void}>};

async function upstream(t: TestContext) {
  const seen: Array<{url: string; auth?: string}> = [];
  const server = createServer((req: IncomingMessage, res) => {
    seen.push({url: req.url ?? '', auth: req.headers.authorization});
    res.writeHead(200, {'content-type': 'application/json'});
    res.end('{"ok":true}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return {base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, seen};
}

// Spec: MUS-SPEC-03-1C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-1c)
test('router bridge: a request without the private path prefix is refused and never forwarded', async t => {
  const up = await upstream(t);
  const bridge = await startResponsesCompatibility(up.base);
  t.after(() => bridge.close());
  const origin = new URL(bridge.baseUrl).origin;
  const refused = await fetch(`${origin}/v1/responses`, {method: 'POST', headers: {authorization: 'Bearer sk-fixture'}, body: '{}'});
  assert.equal(refused.status, 404);
  assert.equal(up.seen.length, 0, 'nothing reached the router');
  const allowed = await fetch(`${bridge.baseUrl}/responses`, {method: 'POST', headers: {authorization: 'Bearer sk-fixture'}, body: '{}'});
  assert.equal(allowed.status, 200);
  assert.deepEqual(up.seen, [{url: '/v1/responses', auth: 'Bearer sk-fixture'}], 'the real request keeps its path and credentials');
});

// Spec: MUS-SPEC-03-1D (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-1d)
test('router bridge: when the router cannot be reached the 502 says why, without the address or credentials', async t => {
  const closed = createServer();
  await new Promise<void>(resolve => closed.listen(0, '127.0.0.1', resolve));
  const port = (closed.address() as AddressInfo).port;
  await new Promise<void>(resolve => closed.close(() => resolve()));
  const bridge = await startResponsesCompatibility(`http://127.0.0.1:${port}/v1`);
  t.after(() => bridge.close());
  const response = await fetch(`${bridge.baseUrl}/responses`, {method: 'POST', headers: {authorization: 'Bearer sk-fixture-secret'}, body: '{}'});
  assert.equal(response.status, 502);
  const body: unknown = await response.json();
  assert.ok(body && typeof body === 'object' && 'error' in body && body.error && typeof body.error === 'object' && 'message' in body.error && typeof body.error.message === 'string', 'a JSON error body');
  const message = body.error.message;
  assert.match(message, /ECONNREFUSED/, 'the cause is kept');
  assert.doesNotMatch(message, /sk-fixture-secret|127\.0\.0\.1|:\d{2,5}\b/, 'no credentials or address leak');
});
