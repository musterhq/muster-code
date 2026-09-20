import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';
import {TimelineReplica} from '../src/renderer/timeline-replica.ts';

test('runtime streams changed rows and the renderer replica matches durable history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-stream-'));
  const events: AgentEvent[] = [];
  let finish!: () => void;
  const completed = new Promise<void>(resolve => { finish = resolve; });
  const provider: ProviderAdapter = {
    info: () => [{id: 'test', name: 'test', available: true, identityMasked: 'test', models: []}],
    stop: async () => true, dispose() {},
    async run(input) {
      input.onDelta('Before command.');
      input.onEvent('item/started', {item: {id: 'tool', type: 'commandExecution', command: 'fixture'}});
      await delay(40);
      input.onEvent('item/commandExecution/outputDelta', {itemId: 'tool', delta: 'first\n'});
      await delay(40);
      input.onEvent('item/completed', {item: {id: 'tool', type: 'commandExecution', exitCode: 0, aggregatedOutput: 'first\nlast\n'}});
      input.onDelta('After command.');
      finish();
      return {status: 'completed', finalMessage: 'After command.'};
    },
  };
  const service = createAgentService({dataDir, provider, onEvent: event => events.push(event)});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const chat = await service.invoke('chat.create', {});
  const replica = new TimelineReplica();
  replica.snapshot(await service.invoke('chat.timeline', {id: chat.id}));
  await service.invoke('chat.send', {id: chat.id, text: 'Run fixture', requestId: 'stream-fixture'});
  await completed;
  await delay(10);
  const patches = events.filter((event): event is Extract<AgentEvent, {type: 'timelinePatch'}> => event.type === 'timelinePatch');
  assert.ok(patches.length >= 3);
  for (const event of patches) replica.patch(event.patch);
  const authoritative = await service.invoke('chat.timeline', {id: chat.id});
  assert.equal(replica.needsSnapshot, false);
  assert.deepEqual(replica.value, authoritative);
  assert.equal(events.some(event => event.type === 'timeline'), false);
  assert.ok(patches.slice(1).every(event => !event.patch.items.some(item => item.kind === 'user')));
  assert.equal(authoritative.items.find(item => item.kind === 'tool')?.data?.output, 'first\nlast\n');
});
