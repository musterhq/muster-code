import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import type {ProviderAdapter, ProviderResult} from '../src/runtime/provider.ts';
import {classifyTool, toolState} from '../src/renderer/components/toolPresentation.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

async function until(check: () => Promise<boolean>) {
  for (let i = 0; i < 200; i++) { if (await check()) return; await delay(5); }
  throw new Error('Expected state did not arrive');
}
const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'Hidden', models: []}];

/** A turn whose provider finishes one command, starts another and ends the turn without ever closing it. */
async function settled(t: {after(fn: () => Promise<void>): void}, result: ProviderResult): Promise<TimelineItem[]> {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-387-'));
  const provider: ProviderAdapter = {info,
    async run(input) {
      input.onEvent('item/completed', {item: {id: 'done', type: 'commandExecution', command: 'echo done', exitCode: 0}});
      input.onEvent('item/started', {item: {id: 'open', type: 'commandExecution', command: 'long command'}});
      input.onEvent('item/commandExecution/outputDelta', {itemId: 'open', delta: 'tick\n'});
      return result;
    },
    async stop() { return true; }, dispose() {},
  };
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'go', requestId: randomUUID()});
  await until(async () => ['completed', 'failed'].includes((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status ?? ''));
  return (await service.invoke('chat.timeline', {id: chat.id})).items;
}

function assertSwept(rows: TimelineItem[]) {
  const open = rows.find(i => i.data?.providerItemId === 'open')!;
  assert.equal(open.status, 'interrupted');
  assert.equal(toolState(open, classifyTool(open.data)), 'Stopped');
  assert.equal(open.data?.output, 'tick\n');
  assert.equal(typeof open.data?.durationMs, 'number');
  assert.equal(rows.find(i => i.data?.providerItemId === 'done')?.status, 'completed');
  assert.equal(rows.filter(i => i.kind === 'tool' && i.status === 'running').length, 0);
}

// Spec: MUS-SPEC-02-387A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-387a)
test('#387 a tool the provider never closed is shown as Stopped once a completed turn settles', async t => {
  assertSwept(await settled(t, {status: 'completed', finalMessage: 'done'}));
});

// Spec: MUS-SPEC-02-387B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-387b)
test('#387 a tool the provider never closed is shown as Stopped once a failed turn settles', async t => {
  assertSwept(await settled(t, {status: 'failed', finalMessage: '', errorMessage: 'The connection dropped.'}));
});

// Spec: MUS-SPEC-02-387C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-387c)
test('#387 a tool row left running when Muster closed is Stopped after restart', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-387-restart-'));
  const store = new AgentStore(dataDir), chat = store.createChat({model: 'm', mode: 'agent'});
  store.updateChat(chat.id, {providerId: 'hybrow', status: 'running'});
  store.appendItem(chat.id, 'tool', 'echo done', 'completed', {providerItemId: 'done', type: 'commandExecution'});
  store.appendItem(chat.id, 'tool', 'long command', 'running', {providerItemId: 'open', type: 'commandExecution', output: 'tick\n'});
  store.close();
  const provider: ProviderAdapter = {info, async run() { throw new Error('must not run'); }, async stop() { return true; }, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const rows = (await service.invoke('chat.timeline', {id: chat.id})).items;
  assert.equal((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status, 'interrupted');
  const open = rows.find(i => i.data?.providerItemId === 'open')!;
  assert.equal(open.status, 'interrupted');
  assert.equal(toolState(open, classifyTool(open.data)), 'Stopped');
  assert.equal(rows.find(i => i.data?.providerItemId === 'done')?.status, 'completed');
});
