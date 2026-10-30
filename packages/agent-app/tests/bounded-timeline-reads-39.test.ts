/** #39 bounded memory: the runtime never reads a chat's whole history to answer a question about a few rows.
 *  On a real 100-chat database (186k rows, 730 MB) each whole-history read peaked the main process at 0.9–1.2 GB. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, mkdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import type {ProviderAdapter, ProviderResult} from '../src/runtime/provider.ts';

const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Hybrow', available: true, identityMasked: 'Hidden', bindingId: 'gateway', models: [{id: 'fixture-model', name: 'Fixture'}]}];
const idle: ProviderAdapter = {info, async run() { return {status: 'completed', finalMessage: 'ok'} as ProviderResult; }, async stop() { return true; }, dispose() {}};
const bulky = 'x'.repeat(8_000);
/** A long chat: many finished shell commands with large output, the rows that dominate real databases. */
function longHistory(store: AgentStore, chatId: string, rows = 400): void {
  for (let i = 0; i < rows; i++) store.appendItem(chatId, 'tool', `cmd ${i}`, 'completed', {type: 'commandExecution', command: `ls ${i}`, exitCode: 0, aggregatedOutput: bulky});
}
async function until(check: () => boolean | Promise<boolean>) { for (let i = 0; i < 500; i++) { if (await check()) return; await delay(3); } assert.fail('condition not reached'); }

test('#39 restart: open cards and an unfinished compaction settle without reading any chat\'s whole history', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-39-boot-'));
  const store = new AgentStore(dataDir);
  const busy = store.createChat({model: 'fixture-model', mode: 'agent'}), waiting = store.createChat({model: 'fixture-model', mode: 'agent'});
  longHistory(store, busy.id);
  const card = store.appendItem(busy.id, 'approval', 'run it?', 'pending', {method: 'item/commandExecution/requestApproval', kind: 'command', expiresAt: new Date(Date.now() + 3_600_000).toISOString()});
  const compaction = store.appendItem(busy.id, 'notice', 'Compacting…', 'running', {kind: 'compaction'});
  longHistory(store, waiting.id, 50);
  const question = store.appendItem(waiting.id, 'question', 'which?', 'pending', {method: 'item/tool/requestUserInput', questions: [], expiresAt: new Date(Date.now() + 3_600_000).toISOString()});
  store.updateChat(waiting.id, {providerId: 'hybrow', status: 'running'});
  store.close();

  const whole = t.mock.method(AgentStore.prototype, 'timeline');
  const prompts: string[] = [];
  const provider: ProviderAdapter = {...idle, async run(input) { prompts.push(input.prompt); return {status: 'completed', finalMessage: 'ok'} as ProviderResult; }};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  await delay(80);
  assert.equal(whole.mock.callCount(), 0, 'starting Muster reads no chat\'s whole history');

  const reread = new AgentStore(dataDir);
  t.after(() => reread.close());
  const row = (id: string) => reread.item(id)!;
  assert.equal(row(card.id).status, 'unavailable', 'an approval left open by the quit can no longer be answered');
  assert.equal(row(card.id).data?.expiredReason, 'restart');
  assert.equal(row(compaction.id).status, 'failed', 'the compaction nobody will finish is marked failed');
  assert.deepEqual(row(compaction.id).data?.actions, ['retry', 'fresh']);
  assert.equal(row(question.id).status, 'unavailable', 'a provider question left open by the quit is closed the same way');
  assert.equal(prompts.length, 0, 'a chat waiting on the user is never continued automatically');
});

test('#39 Changes: edit owners come from edit rows only, including old shell patches', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-39-owners-'));
  t.after(() => rm(dataDir, {recursive: true, force: true}));
  const root = join(dataDir, 'repo'); await mkdir(join(root, 'src'), {recursive: true});
  const service = createAgentService({dataDir, provider: idle, onEvent() {}});
  t.after(() => service.dispose());
  const folder = await service.invoke('folder.add', {path: root});
  const one = await service.invoke('chat.create', {folderId: folder.id}), two = await service.invoke('chat.create', {folderId: folder.id});
  await service.dispose();

  const store = new AgentStore(dataDir);
  longHistory(store, one.id); longHistory(store, two.id);
  store.appendItem(one.id, 'tool', 'edit', 'completed', {type: 'fileChange', changes: [{path: join(root, 'src/a.ts'), kind: {type: 'update'}}]});
  const patch = '*** Begin Patch\n*** Update File: b.ts\n@@\n-old\n+new\n*** End Patch';
  store.appendItem(two.id, 'tool', 'apply_patch', 'completed', {type: 'commandExecution', cwd: root, command: `apply_patch <<'PATCH'\n${patch}\nPATCH`, exitCode: 0, aggregatedOutput: 'Success. Updated the following files:\nM b.ts\n'});
  store.close();

  const reopened = createAgentService({dataDir, provider: idle, onEvent() {}});
  t.after(() => reopened.dispose());
  await delay(30);
  const whole = t.mock.method(AgentStore.prototype, 'timeline');
  const owners = await reopened.invoke('chat.editOwners', {folderId: folder.id});
  assert.deepEqual(owners.map(o => `${o.path}:${o.chatId === one.id ? 'one' : 'two'}`).sort(), ['b.ts:two', 'src/a.ts:one'], 'a file-change row and an older shell patch both count');
  assert.equal(whole.mock.callCount(), 0, 'the folder\'s chats are not loaded whole to find their edits');
});

test('#39 a quiet running chat is checked by revision, and its history is downloaded only when it changed', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-39-probe-'));
  let release!: () => void;
  const provider: ProviderAdapter = {...idle, async run(input) {
    await new Promise<void>(resolve => { release = resolve; });
    input.onDelta('Finished after a long command.');
    return {status: 'completed', finalMessage: 'Finished after a long command.'} as ProviderResult;
  }};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const calls: string[] = [];
  (globalThis as {window?: unknown}).window = {muster: {invoke: (command: string, input: never) => { calls.push(command); return service.invoke(command as never, input); }, subscribe: () => () => {}}};
  t.after(() => { delete (globalThis as {window?: unknown}).window; });
  // The renderer store is browser code (extensionless imports): bundle it the way the renderer suites do.
  const here = dirname(fileURLToPath(import.meta.url)), outfile = join(here, '../dist/tests/bounded-timeline-store-39.mjs');
  await build({entryPoints: [join(here, '../src/renderer/store.ts')], outfile, bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent'});
  const {probeTimeline} = await import(pathToFileURL(outfile).href) as typeof import('../src/renderer/store.ts');

  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'run the long command', requestId: 'r1'});
  await until(() => typeof release === 'function');
  assert.equal(await probeTimeline(chat.id), 'resynced', 'the first probe fills an empty view');
  calls.length = 0;
  assert.equal(await probeTimeline(chat.id), 'live');
  assert.equal(await probeTimeline(chat.id), 'live');
  assert.deepEqual(calls, ['chat.timelineRevision', 'chat.timelineRevision'], 'silence costs one revision read per probe, never the history');

  release();
  await until(async () => (await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status === 'completed');
  calls.length = 0;
  assert.equal(await probeTimeline(chat.id), 'resynced', 'a newer revision still brings the missed rows');
  assert.deepEqual(calls, ['chat.timelineRevision', 'chat.timeline']);
});
