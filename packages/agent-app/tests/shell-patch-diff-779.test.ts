import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {collectFileChanges, latestTurnItems} from '../src/renderer/turnFileChanges.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const info: ProviderAdapter['info'] = () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'Hidden', models: []}];
const CWD = '/work/scratch';
const PATCH = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: calculator.py\n+\"\"\"A calculator.\"\"\"\n+\n+def add(a, b):\n+    return a + b\n*** Update File: util.py\n@@ def helper():\n-    return 1\n+    return 2\n*** End Patch\nPATCH\npython3 calculator.py";
/** The command as the zsh wrapper reports it: the inner script double-quoted, so its quotes are escaped. */
const wrapped = (script: string) => `/bin/zsh -lc "${script.replace(/["\\$`]/g, m => '\\' + m)}"`;

async function turn(t: {after(fn: () => Promise<void>): void}, items: Record<string, unknown>[]): Promise<TimelineItem[]> {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-779-'));
  const provider: ProviderAdapter = {info,
    async run(input) { for (const item of items) input.onEvent('item/completed', {item}); return {status: 'completed', finalMessage: 'done'}; },
    async stop() { return true; }, dispose() {},
  };
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'create a python file that does normal arithmetic', requestId: randomUUID()});
  for (let i = 0; i < 200; i++) {
    if ((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status === 'completed') break;
    await delay(5);
  }
  return (await service.invoke('chat.timeline', {id: chat.id})).items;
}
const shellItem = (overrides: Record<string, unknown> = {}) => ({id: 'call_1', type: 'commandExecution', command: wrapped(PATCH), cwd: CWD,
  commandActions: [{type: 'unknown', command: PATCH}], exitCode: 0,
  aggregatedOutput: 'Success. Updated the following files:\nA calculator.py\nM util.py\n', ...overrides});

// Spec: MUS-SPEC-08-779A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-779a)
// Protected: complete inline diff
test('#779 files the model writes with a shell apply_patch show as inline diffs and in the files-changed pill; failed or printed patches do not', async t => {
  const printed = `cat <<'EOF'\n${PATCH.split('\n').slice(1, 11).join('\n')}\nEOF`;
  const rows = await turn(t, [
    shellItem(),
    shellItem({id: 'call_2', exitCode: 1, aggregatedOutput: 'Failed to find expected lines in util.py'}),
    shellItem({id: 'call_3', command: wrapped(printed), commandActions: [{type: 'unknown', command: printed}], aggregatedOutput: '*** Begin Patch\n'}),
  ]);
  const files = collectFileChanges(latestTurnItems(rows));
  assert.deepEqual(files.map(file => [file.path, file.kind, file.adds, file.dels]), [
    [`${CWD}/calculator.py`, 'add', 4, 0],
    [`${CWD}/util.py`, 'update', 1, 1],
  ]);
  const tool = (id: string) => rows.find(item => item.data?.providerItemId === id)?.data;
  assert.equal(tool('call_1')?.type, 'fileChange');
  assert.match(String(tool('call_1')?.output), /Success\. Updated/);
  assert.equal(tool('call_2')?.type, 'commandExecution');
  assert.equal(tool('call_3')?.type, 'commandExecution');
});
