import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createProviderAdapter, type CoreClient, type ProviderInput, type ProviderResult} from '../src/runtime/provider.ts';
import {networkReconnectGuard, NETWORK_RECONNECT_DEADLINE_MS} from '../src/runtime/network-failure.ts';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';

const input = (): ProviderInput => ({chat: {id: 'network', mode: 'ask', providerId: 'fixture'} as ProviderInput['chat'], cwd: '/unused', prompt: 'hello', onDelta() {}, onReasoning() {}, onEvent() {}, async onRequest() {return undefined;}});
const proxyError = {willRetry: true, error: {message: 'proxy tunnel failed: ECONNREFUSED https://user:secret@proxy.invalid'}};
function failingTransport(settleOnClose = false) {
  let args!: Record<string, unknown>, finish!: (result: ProviderResult) => void;
  let closed = 0;
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    runCodexAppServer(options) { args = options; return new Promise(resolve => {finish = resolve;}); },
    async callCodexConversation() {return {};},
    async interruptActiveCodexTurn() {return false;},
    clearCodexAppServerSessions() {closed++; if (settleOnClose) finish({status: 'failed', finalMessage: '', errorMessage: 'transport closed'});},
  };
  const adapter = createProviderAdapter({core, available: () => true, command: '/unused'});
  return {adapter, closed: () => closed, emit(params = proxyError) {(args.onEvent as ProviderInput['onEvent'])('error', params);}, delta() {(args.onEvent as ProviderInput['onEvent'])('item/agentMessage/delta', {itemId: 'm', delta: 'late'}); (args.onDelta as (text: string) => void)('late');}, finish() {finish({status: 'completed', finalMessage: 'done'});}};
}

// Spec: MUS-SPEC-02-608A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-608a)
test('failing transport stops after three reconnect failures, explains proxy and allows manual retry', async () => {
  const f = failingTransport();
  let events = 0, deltas = 0;
  const run = f.adapter.run({...input(), onEvent() {events++;}, onDelta() {deltas++;}});
  try {
    f.emit(); f.emit();
    assert.equal(f.closed(), 0);
    f.emit();
    const result = await Promise.race([run, new Promise<never>((_, reject) => {setTimeout(() => reject(new Error('reconnect did not stop')), 200).unref();})]);
    assert.equal(result.status, 'failed');
    assert.equal(result.recovery?.kind, 'failed');
    assert.equal(result.recovery?.retryable, true);
    assert.match(result.recovery?.reason ?? '', /HTTPS proxy/);
    assert.doesNotMatch(JSON.stringify(result), /secret|user:/);
    assert.ok(f.closed() > 0);
    f.emit(); f.delta();
    assert.equal(events, 3); assert.equal(deltas, 0);
    const retried = f.adapter.run(input());
    f.finish();
    assert.equal((await retried).status, 'completed');
  } finally { f.finish(); f.adapter.dispose(); }
});

// Spec: MUS-SPEC-02-608B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-608b)
test('stalled reconnect stops by deadline without further transport events', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = failingTransport();
  const run = f.adapter.run(input());
  f.emit();
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS);
  const result = await run;
  assert.equal(result.status, 'failed');
  assert.match(result.recovery?.reason ?? '', /HTTPS proxy/);
  f.adapter.dispose();
});

test('successful progress resets reconnect budget and clears deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = failingTransport();
  const run = f.adapter.run(input());
  f.emit(); f.emit(); f.delta();
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS);
  assert.equal(f.closed(), 0);
  f.emit(); f.emit();
  assert.equal(f.closed(), 0);
  f.finish();
  assert.equal((await run).status, 'completed');
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS);
  assert.equal(f.closed(), 0);
  f.adapter.dispose();
});

test('Stop during a reconnect stays cancelled and clears the network deadline', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = failingTransport(true);
  const run = f.adapter.run(input());
  f.emit();
  const stopped = f.adapter.stop('network');
  t.mock.timers.tick(5_000);
  assert.equal((await run).recovery?.kind, 'cancelled');
  await stopped;
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS);
  f.adapter.dispose();
});

test('429 retry handling remains unchanged, including structured HTTP status', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const guard = networkReconnectGuard();
  let failed = false;
  void guard.failed.then(() => { failed = true; });
  guard.observe(proxyError);
  for (const error of [
    {message: 'proxy returned HTTP 429'},
    {message: 'stream disconnected', codexErrorInfo: {httpConnectionFailed: {httpStatusCode: 429}}},
  ]) for (let i = 0; i < 10; i++) guard.observe({willRetry: true, error});
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS * 2);
  await Promise.resolve();
  assert.equal(failed, false);
  guard.dispose();
});

// Spec: MUS-SPEC-02-608C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-608c)
test('HTTP fetch failures explain nested proxy, DNS, TLS and refused causes without credentials', async () => {
  for (const [code, expected] of [['HTTPS_PROXY_FAILED', /HTTPS proxy/], ['ENOTFOUND', /DNS/], ['CERT_HAS_EXPIRED', /TLS certificate/], ['ECONNREFUSED', /connection was refused/]] as const) {
    const error = new TypeError('fetch failed', {cause: Object.assign(new Error('https://user:secret@invalid'), {code})});
    const adapter = openAICompatibleAdapter({endpoint: 'https://invalid/v1', label: 'Example', apiKey: () => 'key', tools: false, fetch: async () => {throw error;}});
    const result = await adapter.run({...input(), model: 'model', permissionMode: 'read-only', signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}} as AdapterRunInput);
    assert.equal(result.status, 'failed');
    assert.equal(result.dispatchState, 'not-dispatched');
    assert.match(result.errorMessage ?? '', expected);
    assert.doesNotMatch(result.errorMessage ?? '', /secret|user:/);
  }
});

test('numbered provider retries reach the provider fallback; the deadline still bounds them', async t => {
  t.mock.timers.enable({apis: ['setTimeout']});
  const f = failingTransport();
  const run = f.adapter.run(input());
  // Codex exhausts WebSockets (n/5) and then falls back to HTTPS on its own: the count must not stop that early.
  for (let n = 1; n <= 5; n++) f.emit({willRetry: true, error: {message: `Reconnecting... ${n}/5 (stream disconnected before completion: Connection refused (os error 61))`}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closed(), 0, 'numbered retries are left to the provider');
  t.mock.timers.tick(NETWORK_RECONNECT_DEADLINE_MS);
  const result = await run;
  assert.equal(result.status, 'failed');
  assert.match(result.recovery?.reason ?? '', /connection was refused/);
  f.adapter.dispose();
});

test('a numbered retry that recovers keeps the turn; open-ended waits are still counted', async () => {
  const f = failingTransport();
  const run = f.adapter.run(input());
  for (let n = 1; n <= 5; n++) f.emit({willRetry: true, error: {message: `Reconnecting... ${n}/5 (stream disconnected before completion: error sending request)`}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closed(), 0, 'numbered retries are left to the provider');
  f.delta();
  for (let i = 0; i < 2; i++) f.emit({willRetry: true, error: {message: 'Reconnecting... waiting for network (Connection failed: error sending request)'}});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.closed(), 0);
  f.emit({willRetry: true, error: {message: 'Reconnecting... waiting for network (Connection failed: error sending request)'}});
  const result = await run;
  assert.equal(result.status, 'failed');
  assert.match(result.recovery?.reason ?? '', /network connection to the provider failed/);
  f.adapter.dispose();
});

test('a host name is not a cause, and unclassified transport text never shows credentials', async () => {
  const {networkFailure} = await import('../src/runtime/network-failure.ts');
  assert.match(networkFailure(new Error('error sending request for url (https://llm-proxy.example/v1/responses): Connection refused')) ?? '', /connection was refused/);
  assert.match(networkFailure(new Error('error sending request for url (https://dnsdemo.example/v1)')) ?? '', /network connection to the provider failed/);
  const error = new Error('unexpected reply from https://user:secret@gateway.invalid/v1');
  const adapter = openAICompatibleAdapter({endpoint: 'https://invalid/v1', label: 'Example', apiKey: () => 'key', tools: false, fetch: async () => {throw error;}});
  const result = await adapter.run({...input(), model: 'model', permissionMode: 'read-only', signal: new AbortController().signal, onThreadReady() {}, onTurnAccepted() {}} as AdapterRunInput);
  assert.match(result.errorMessage ?? '', /Could not reach Example/);
  assert.doesNotMatch(result.errorMessage ?? '', /secret/);
});
