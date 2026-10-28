import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';
import {collectFileChanges, changeTotals} from '../src/renderer/turnFileChanges.ts';

const cwd = '/work/non git scratch';
const command = "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: calculator.py\n+def add(a, b):\n+    return a + b\n*** Update File: helper.py\n@@\n-return 1\n+return 2\n*** End Patch\nPATCH";
const legacy = {type: 'commandExecution', command, cwd, exitCode: 0,
  output: 'Success. Updated the following files:\nA calculator.py\nM helper.py\n'};

// Spec: MUS-SPEC-08-781A (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781a)
// Protected: complete inline diff
test('reopening a saved shell-edit chat recovers all diffs without rewriting history', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-781-'));
  let store = new AgentStore(dir);
  t.after(async () => { store.close(); await rm(dir, {recursive: true, force: true}); });
  const chat = store.createChat({model: 'fixture', mode: 'agent'});
  const saved = store.appendItem(chat.id, 'tool', command, 'completed', legacy);
  store.upsertSubagentItem(chat.id, 'child', {id: 'child-edit', kind: 'tool', text: command, status: 'completed', data: legacy});
  const raw = store.database().prepare('SELECT data FROM timeline WHERE id = ?').get(saved.id);
  const revision = store.timelineRevision(chat.id);
  store.close();
  store = new AgentStore(dir);
  for (const items of [store.timeline(chat.id), store.timelineSnapshot(chat.id).items,
    store.timelineChanges(chat.id, 0).items, [store.item(saved.id)!], store.subagentItems(chat.id, 'child')]) {
    const changes = collectFileChanges(items);
    assert.deepEqual(changes.map(c => [c.path, c.kind]), [[join(cwd, 'calculator.py'), 'add'], [join(cwd, 'helper.py'), 'update']]);
    assert.deepEqual(changeTotals(changes), {files: 2, adds: 3, dels: 1});
    assert.match(changes[0]!.patches[0]!.diff, /\+    return a \+ b/);
    assert.equal(items[0]!.data?.output, legacy.output);
  }
  assert.deepEqual(store.database().prepare('SELECT data FROM timeline WHERE id = ?').get(saved.id), raw);
  assert.equal(store.timelineRevision(chat.id), revision);
});

// Spec: MUS-SPEC-08-781B (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781b)
// Protected: complete inline diff
test('saved non-edits stay commands and native changes remain intact', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muster-781-negative-'));
  const store = new AgentStore(dir);
  t.after(async () => { store.close(); await rm(dir, {recursive: true, force: true}); });
  const chat = store.createChat({model: 'fixture', mode: 'agent'});
  for (const [status, data] of [
    ['failed', {...legacy, exitCode: 1}],
    ['interrupted', legacy], ['running', legacy], ['cancelled', legacy],
    ['completed', {...legacy, output: 'patch verification failed'}],
    ['completed', {...legacy, command: command.replace('apply_patch', 'cat'), output: '*** Begin Patch\n'}],
  ] as const) {
    const item = store.appendItem(chat.id, 'tool', 'command', status, data);
    assert.equal(store.item(item.id)!.data?.type, 'commandExecution');
    assert.deepEqual(collectFileChanges([store.item(item.id)!]), []);
  }
  const native = {type: 'fileChange', changes: [{path: 'native.py', kind: 'add', diff: 'native\n'}]};
  const item = store.appendItem(chat.id, 'tool', 'native edit', 'completed', native);
  assert.deepEqual(store.item(item.id)!.data, native);
  const actionsOnly = {...legacy, command: undefined, commandActions: [{type: 'unknown', command}]};
  const action = store.appendItem(chat.id, 'tool', 'shell', 'completed', actionsOnly);
  assert.equal(collectFileChanges([store.item(action.id)!]).length, 2);
  const earlierRecovery=store.appendItem(chat.id,'tool','shell','completed',{...legacy,type:'fileChange',changes:[{path:join(cwd,'helper.py'),kind:{type:'update'},diff:'-return 1\n+return 2'}]});
  assert.match(String((store.item(earlierRecovery.id)!.data!.changes as any[])[1].diff),/^@@\n/,'previous recovery retains the original contextual hunk boundaries');
});
