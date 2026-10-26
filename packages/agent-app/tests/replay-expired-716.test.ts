// #716: a router keeps Claude replay state only for a while. Resuming a provider thread started days earlier is then refused
// with HTTP 409 "replay state expired or is unavailable" before the turn starts, and every retry resumed the same thread.
// These tests drive the real service and provider adapter with a fake Codex client.
import assert from 'node:assert/strict';
import {test, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type CoreClient, type ProviderResult} from '../src/runtime/provider.ts';
import type {ProviderInstance} from '../src/runtime/provider-instances.ts';

const EXPIRED = 'unexpected status 409 Conflict: claude/claude-opus-5-5: model — Claude replay state expired or is unavailable. Start a new conversation. (HTTP 409); url: http://127.0.0.1:58419/token/responses, request id: req-1';
const failed = (errorMessage: string, extra: Partial<ProviderResult> = {}): ProviderResult => ({status: 'failed', finalMessage: '', errorMessage, dispatchState: 'unknown', failure: {kind: 'rpc-rejected', method: 'turn/start', statusCode: 409}, ...extra});
const ok = (n: number): ProviderResult => ({status: 'completed', finalMessage: `answer ${n}`, threadId: `thread-${n}`, turnId: `turn-${n}`, dispatchState: 'dispatched'});

type Call = {prompt: string; threadId: string | undefined};
/** `script` answers each Codex run by its number (1 = the first run of the test). */
async function harness(t: TestContext, script: (call: Call, n: number, input: Record<string, unknown>) => ProviderResult) {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-716-'));
  const calls: Call[] = [];
  const core: CoreClient = {
    CODEX_RUN_LIFECYCLE_VERSION: 1,
    async runCodexAppServer(input) {
      const call = {prompt: String(input.prompt), threadId: input.threadId as string | undefined};
      calls.push(call);
      const result = script(call, calls.length, input);
      if (result.turnId && result.threadId) (input.onTurnAccepted as ((id: unknown) => void) | undefined)?.({threadId: result.threadId, turnId: result.turnId, dispatchState: 'dispatched'});
      if (result.status === 'completed') (input.onDelta as (text: string) => void)(result.finalMessage);
      return result;
    },
    async callCodexConversation() { return {}; }, async interruptActiveCodexTurn() { return true; }, clearCodexAppServerSessions() {},
  };
  const route: ProviderInstance = {
    info: {id: 'gw', name: 'Gateway', driver: 'codex-app-server', available: true, bindingId: 'gw-binding', identityMasked: 'hidden', codex: {modelProvider: 'gw', kind: 'gateway'},
      models: ['intelligent-planner'].map(id => ({id, name: id}))},
    command: '/unused', env: {}, sessionsRoot: join(dataDir, 'sessions'),
  };
  const provider = createProviderAdapter({core, instances: () => [route]});
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); provider.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const created = await service.invoke('chat.create', {});
  await service.invoke('chat.selectProvider', {id: created.id, providerId: 'gw', model: 'intelligent-planner'});
  await service.invoke('chat.setPermissionMode', {id: created.id, permissionMode: 'workspace'});
  const items = async () => (await service.invoke('chat.timeline', {id: created.id})).items;
  const snapshot = async () => (await service.invoke('app.snapshot', undefined)).chats.find(entry => entry.id === created.id)!;
  async function send(text: string) {
    const before = (await items()).filter(item => item.kind === 'user').length;
    await service.invoke('chat.send', {id: created.id, text, requestId: randomUUID()});
    for (let i = 0; i < 600; i++) {
      const chat = await snapshot();
      if ((await items()).filter(item => item.kind === 'user').length > before && chat.status !== 'running' && chat.status !== 'stopping') return;
      await delay(10);
    }
    assert.fail('the turn did not settle');
  }
  return {calls, items, snapshot, send};
}

// Spec: MUS-SPEC-03-716A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-716a)
test('a resumed router thread whose replay state expired starts one fresh conversation with a summary', async t => {
  const h = await harness(t, (call, n) => n === 1 ? ok(1) : call.threadId ? failed(EXPIRED) : ok(2));
  await h.send('Capital of France?');
  assert.equal((await h.snapshot()).providerThreadId, 'thread-1');
  await h.send('Population?');

  assert.equal(h.calls.length, 3, 'the first turn, the refused resume, and one fresh attempt');
  assert.equal(h.calls[1]!.threadId, 'thread-1', 'the second message first tries to resume the saved thread');
  assert.equal(h.calls[2]!.threadId, undefined, 'the retry resumes nothing');
  assert.match(h.calls[2]!.prompt, /^[\s\S]*User: Capital of France\?[\s\S]*Assistant: answer 1[\s\S]*Current user request:\nPopulation\?$/);
  assert.ok(!h.calls[2]!.prompt.slice(0, h.calls[2]!.prompt.indexOf('Current user request:')).includes('Population?'), 'the new message is sent once, after the summary');
  assert.equal(h.calls.filter(call => call.prompt.includes('Population?')).length, 2, 'the message reaches the provider twice at most');

  const chat = await h.snapshot();
  assert.equal(chat.status, 'completed');
  assert.equal(chat.providerThreadId, 'thread-2', 'the chat now continues on the new thread');
  const items = await h.items();
  const notices = items.filter(item => item.data?.kind === 'thread-reset');
  assert.equal(notices.length, 1);
  assert.match(notices[0]!.text, /could no longer continue the earlier conversation.*fresh one started with a summary/i);
  assert.ok(items.some(item => item.kind === 'assistant' && item.text.includes('answer 2')));
  assert.ok(!items.some(item => /replay state/i.test(item.text)), 'the expired-state error is not shown');
});

// Spec: MUS-SPEC-03-716B (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-716b)
test('when the fresh conversation is refused with the same 409 there is no third attempt and the error is shown', async t => {
  const h = await harness(t, (_call, n) => n === 1 ? ok(1) : failed(EXPIRED));
  await h.send('Capital of France?');
  await h.send('Population?');

  assert.equal(h.calls.length, 3, 'one resume and one fresh attempt, never a third');
  assert.equal((await h.snapshot()).status, 'failed');
  const items = await h.items();
  const last = items[items.length - 1]!;
  assert.equal(last.kind, 'notice');
  assert.equal((last.data as {recovery?: {kind: string}} | undefined)?.recovery?.kind, 'recovery-needed', 'the failure is reported through the usual recovery notice, as before');
  assert.equal(items.filter(item => item.data?.kind === 'thread-reset').length, 1, 'one notice for the one fresh attempt');
});

// Spec: MUS-SPEC-03-716C (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-716c)
test('a 409 with other text, or after the turn produced output, does not start a fresh conversation', async t => {
  const other = await harness(t, (_call, n) => n === 1 ? ok(1) : failed('unexpected status 409 Conflict: model — Another request is in progress. (HTTP 409)'));
  await other.send('Capital of France?');
  await other.send('Population?');
  assert.equal(other.calls.length, 2, 'no retry for a different 409');
  assert.equal((await other.items()).filter(item => item.data?.kind === 'thread-reset').length, 0);

  const produced = await harness(t, (_call, n, input) => {
    if (n === 1) return ok(1);
    (input.onDelta as (text: string) => void)('partial');
    return failed(EXPIRED, {threadId: 'thread-1', turnId: 'turn-2', dispatchState: 'dispatched'});
  });
  await produced.send('Capital of France?');
  await produced.send('Population?');
  assert.equal(produced.calls.length, 2, 'no retry once the turn produced output');
  assert.equal((await produced.items()).filter(item => item.data?.kind === 'thread-reset').length, 0);
});
