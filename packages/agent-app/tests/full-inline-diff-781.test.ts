import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {collectFileChanges, laterEdits, laterEditsKey} from '../src/renderer/turnFileChanges.ts';
import {createdFileModel,fileEditorModel,reconstructBefore,type EditorModel} from '../src/renderer/diffEditorModel.ts';
import {normalizeChange} from '../src/renderer/patchModel.ts';
import {shellPatchChanges} from '../src/runtime/shell-patch.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

// Spec: MUS-SPEC-08-781D (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781d)
// Protected: complete inline diff, including unchanged source and every change block.
test('a scratch chat opens a complete multi-edit renamed file without granting arbitrary file reads', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-full-781-'));
  const after='// header\nconst first = 3;\n\n// untouched middle\nconst second = 4;\n// footer\n';
  const patch='*** Begin Patch\n*** Update File: original.ts\n*** Move to: result.ts\n@@\n-const first = 1;\n+const first = 2;\n@@\n-const second = 2;\n+const second = 4;\n*** End Patch';
  const later='*** Begin Patch\n*** Update File: result.ts\n@@\n-const first = 2;\n+const first = 3;\n*** End Patch';
  let cwd='';
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'Hidden',models:[]}],
    async run(input){
      for(const [i,body] of [patch,later].entries()) input.onEvent('item/completed',{item:{id:`edit-${i}`,type:'commandExecution',cwd,command:`apply_patch <<'PATCH'\n${body}\nPATCH`,exitCode:0,aggregatedOutput:'Success. Updated the following files:\nM result.ts\n'}});
      return {status:'completed',finalMessage:'done'};
    },async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  const chat=await service.invoke('chat.create',{});
  const other=await service.invoke('chat.create',{});
  cwd=join(dataDir,'scratch',chat.id);
  await mkdir(cwd,{recursive:true});
  await writeFile(join(cwd,'result.ts'),after);
  await writeFile(join(cwd,'unrelated.ts'),'private');
  await service.invoke('chat.send',{id:chat.id,text:'edit both functions',requestId:randomUUID()});
  for(let i=0;i<200;i++){if((await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.status==='completed')break;await delay(5);}
  const rows=(await service.invoke('chat.timeline',{id:chat.id})).items;
  const entries=collectFileChanges(rows);
  const entry=entries.find(e=>(e.movePath??e.path)===join(cwd,'result.ts'))!;
  assert.ok(entry);
  assert.equal(entries.length,1,'a rename followed by another edit is still one changed file');
  assert.deepEqual([entry.adds,entry.dels],[2,2]);
  const itemId=entry.patches.at(-1)!.itemId;
  const read=await service.invoke('files.chatEdit',{chatId:chat.id,itemId,path:join(cwd,'result.ts')});
  assert.equal(read.text,after);
  const model=fileEditorModel(read.text,entry.patches.map(p=>p.diff));
  assert.ok(model?.complete,'the entire file, not disconnected patch snippets');
  assert.deepEqual(model.lines.filter(r=>r.kind==='line').map(r=>r.text),after.trimEnd().split('\n'));
  assert.deepEqual(model.lines.filter(r=>r.kind==='deleted').map(r=>r.text),['const first = 1;','const second = 2;']);
  assert.equal(model.hunks.length,2);
  await assert.rejects(service.invoke('files.chatEdit',{chatId:other.id,itemId,path:join(cwd,'result.ts')}));
  await assert.rejects(service.invoke('files.chatEdit',{chatId:chat.id,itemId,path:join(cwd,'unrelated.ts')}));
  const outside=join(dataDir,'secret.ts');await writeFile(outside,'outside');
  await rm(join(cwd,'result.ts'));await symlink(outside,join(cwd,'result.ts'));
  await assert.rejects(service.invoke('files.chatEdit',{chatId:chat.id,itemId,path:join(cwd,'result.ts')}));
});

// Spec: MUS-SPEC-08-781I (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781i)
// Protected: complete inline diff for a file the agent edited outside the chat's folder (a worktree, another checkout).
test('a chat in one folder opens the whole file it edited in a worktree outside that folder, and nothing else there', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-781-outside-'));
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const folder = join(dataDir, 'project'), worktree = join(dataDir, 'worktrees', 'task-1');
  await mkdir(folder, {recursive: true}); await mkdir(worktree, {recursive: true});
  const after = 'export const one = 1;\nexport const two = 22;\nexport const three = 3;\n';
  await writeFile(join(worktree, 'values.ts'), after);
  await writeFile(join(worktree, 'secret.ts'), 'private');
  const patch = '*** Begin Patch\n*** Update File: values.ts\n@@\n export const one = 1;\n-export const two = 2;\n+export const two = 22;\n*** End Patch';
  const provider: ProviderAdapter = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'Hidden', models: []}],
    async run(input) {
      input.onEvent('item/completed', {item: {id: 'edit-0', type: 'commandExecution', cwd: worktree, command: `apply_patch <<'PATCH'\n${patch}\nPATCH`, exitCode: 0, aggregatedOutput: 'Success. Updated the following files:\nM values.ts\n'}});
      return {status: 'completed', finalMessage: 'done'};
    }, async stop() { return true; }, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  const added = await service.invoke('folder.add', {path: folder});
  const chat = await service.invoke('chat.create', {folderId: added.id});
  await service.invoke('chat.send', {id: chat.id, text: 'change two', requestId: randomUUID()});
  for (let i = 0; i < 200; i++) { if ((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status === 'completed') break; await delay(5); }
  const entry = collectFileChanges((await service.invoke('chat.timeline', {id: chat.id})).items)[0]!;
  assert.equal(entry.path, join(worktree, 'values.ts'), 'the edit is recorded at its real place, outside the chat folder');
  const itemId = entry.patches[0]!.itemId;
  const read = await service.invoke('files.chatEdit', {chatId: chat.id, itemId, path: entry.path});
  assert.equal(read.text, after, 'the whole edited file is read even though it is outside the chat folder');
  const model = fileEditorModel(read.text, entry.patches.map(p => normalizeChange({path: entry.path, diff: p.diff})?.patch ?? p.diff));
  assert.deepEqual(model?.lines.filter(r => r.kind === 'line').map(r => r.text), after.trimEnd().split('\n'));
  await assert.rejects(service.invoke('files.chatEdit', {chatId: chat.id, itemId, path: join(worktree, 'secret.ts')}), 'a file next to it that no edit recorded stays unreadable');
  await rm(join(worktree, 'values.ts')); await symlink(join(worktree, 'secret.ts'), join(worktree, 'values.ts'));
  await assert.rejects(service.invoke('files.chatEdit', {chatId: chat.id, itemId, path: entry.path}), 'a link swapped in for the edited file is refused, even to a file next to it');
});

// Spec: MUS-SPEC-08-781K (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781k)
// Protected: complete inline diff for a file renamed more than once after an edit.
test('the first edit of a file renamed twice afterwards reads the file under its final name, and only that', async t => {
  const dataDir = await mkdtemp(join(tmpdir(), 'muster-781-chain-'));
  const cwd = join(dataDir, 'work');
  await mkdir(cwd, {recursive: true});
  const body = (from: string, to: string | undefined, line: string) => `*** Begin Patch\n*** Update File: ${from}\n${to ? `*** Move to: ${to}\n` : ''}@@\n-const v = ${line};\n+const v = ${Number(line) + 1};\n*** End Patch`;
  const steps = [body('a.ts', undefined, '1'), body('a.ts', 'b.ts', '2'), body('b.ts', 'c.ts', '3')];
  const provider: ProviderAdapter = {info: () => [{id: 'hybrow', name: 'Fixture', available: true, identityMasked: 'Hidden', models: []}],
    async run(input) {
      for (const [i, patch] of steps.entries()) input.onEvent('item/completed', {item: {id: `edit-${i}`, type: 'commandExecution', cwd, command: `apply_patch <<'PATCH'\n${patch}\nPATCH`, exitCode: 0, aggregatedOutput: 'Success. Updated the following files:\nM x\n'}});
      return {status: 'completed', finalMessage: 'done'};
    }, async stop() { return true; }, dispose() {}};
  const service = createAgentService({dataDir, provider, onEvent() {}});
  t.after(async () => { await service.dispose(); await rm(dataDir, {recursive: true, force: true}); });
  const chat = await service.invoke('chat.create', {});
  await service.invoke('chat.send', {id: chat.id, text: 'bump it', requestId: randomUUID()});
  for (let i = 0; i < 200; i++) { if ((await service.invoke('app.snapshot', undefined)).chats.find(c => c.id === chat.id)?.status === 'completed') break; await delay(5); }
  await writeFile(join(cwd, 'c.ts'), 'const v = 4;\n');
  await writeFile(join(cwd, 'other.ts'), 'private');
  const rows = (await service.invoke('chat.timeline', {id: chat.id})).items.filter(row => row.data?.type === 'fileChange');
  assert.equal(rows.length, 3);
  const now = laterEdits(rows).get(laterEditsKey(rows[0]!.id, join(cwd, 'a.ts')));
  assert.equal(now?.path, join(cwd, 'c.ts'), 'the renderer follows both renames from the first edit');
  const read = await service.invoke('files.chatEdit', {chatId: chat.id, itemId: rows[0]!.id, path: now!.path});
  assert.equal(read.text, 'const v = 4;\n', 'the service follows the same chain to the file as it is now');
  await assert.rejects(service.invoke('files.chatEdit', {chatId: chat.id, itemId: rows[0]!.id, path: join(cwd, 'other.ts')}), 'a file no edit named stays unreadable');
  const other = await service.invoke('chat.create', {});
  await assert.rejects(service.invoke('files.chatEdit', {chatId: other.id, itemId: rows[0]!.id, path: now!.path}), 'another chat cannot use this chat’s edit');
});

// Spec: MUS-SPEC-08-781E (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781e)
// Protected: complete inline diff; never invent omitted or ambiguous source.
test('contextual shell hunks retain all source and refuse stale or ambiguous placement',()=>{
  const patch='@@\n-old\n+new\n@@\n tail\n-gone\n end';
  const after='head\nnew\nmiddle\ntail\nend\n';
  const model=fileEditorModel(after,[patch]);
  assert.ok(model?.complete);
  assert.deepEqual(model.lines.filter(r=>r.kind==='line').map(r=>r.text),['head','new','middle','tail','end']);
  assert.deepEqual(model.lines.filter(r=>r.kind==='deleted').map(r=>r.text),['old','gone']);
  assert.equal(fileEditorModel(after.replace('new','changed'),[patch]),undefined);
  assert.equal(fileEditorModel('new\nnew\n',['@@\n-old\n+new']),undefined);
  assert.equal(fileEditorModel('head\ntail\n',['@@\n-deleted']),undefined);
  assert.equal(fileEditorModel('new\n',['@@ @@\n-old\n+new']),undefined);
  const large=Array(130000).fill('x').join('\n');
  assert.equal(reconstructBefore(large+'\nnew\n',['@@\n'+Array(130000).fill(' x').join('\n')+'\n-old\n+new']),large+'\nold\n','large context inside the 512 KB file limit does not exceed the argument stack');
});

/** A stored shell `apply_patch` row, recovered the way the store reads it (rowToItem), as a fileChange row. */
function shellEdit(id: string, cwd: string, patch: string): TimelineItem {
  const data = {type: 'commandExecution', cwd, command: `/bin/zsh -lc "apply_patch <<'PATCH'\n${patch}\nPATCH"`, exitCode: 0, aggregatedOutput: 'Success. Updated the following files:\n'};
  return {id, chatId: 'chat', kind: 'tool', text: 'apply_patch', status: 'completed', createdAt: '', data: {...data, type: 'fileChange', changes: shellPatchChanges(data)}};
}
/** What the transcript renders for one row: the row's own patch as FileChangeView normalises it, and the chat's later edits to that file. */
function rowView(items: TimelineItem[], id: string) {
  const entry = collectFileChanges(items.filter(item => item.id === id))[0]!;
  const diffs = entry.patches.map(patch => normalizeChange({path: entry.path, diff: patch.diff, kind: entry.kind})?.patch ?? patch.diff);
  const history = laterEdits(items).get(laterEditsKey(id, entry.patches[0]!.path));
  const later = (history?.patches ?? []).map(diff => normalizeChange({path: entry.path, diff})?.patch ?? diff);
  return {entry, diffs, later, now: history?.path};
}
const visible = (model: EditorModel | undefined) => model!.lines.filter(row => row.kind === 'line').map(row => row.text);

// Spec: MUS-SPEC-08-781G (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781g)
// Protected: complete inline diff for a file a turn created, after a later turn changed it again.
test('a file created in one turn and edited in a later one still opens whole in the first turn', () => {
  const cwd = '/work';
  const items = [
    shellEdit('create', cwd, '*** Begin Patch\n*** Add File: calc.py\n+def calc(a, op, b):\n+    if op == "+":\n+        return a + b\n+    raise ValueError(op)\n*** End Patch'),
    shellEdit('power', cwd, '*** Begin Patch\n*** Update File: calc.py\n@@\n         return a + b\n+    if op == "**":\n+        return a ** b\n     raise ValueError(op)\n*** End Patch'),
  ];
  const created = rowView(items, 'create');
  assert.equal(created.entry.kind, 'add');
  const first = createdFileModel(created.diffs);
  assert.ok(first, 'the first turn shows its whole created file, without reading the disk');
  assert.deepEqual(visible(first), ['def calc(a, op, b):', '    if op == "+":', '        return a + b', '    raise ValueError(op)']);
  const now = 'def calc(a, op, b):\n    if op == "+":\n        return a + b\n    if op == "**":\n        return a ** b\n    raise ValueError(op)\n';
  const power = rowView(items, 'power');
  assert.deepEqual(visible(fileEditorModel(now, power.diffs, {later: power.later})), now.trimEnd().split('\n'), 'the later turn shows the whole file');
  assert.equal(fileEditorModel(now, ['@@ -0,0 +1,1 @@\n+other']), undefined, 'an update that no longer applies is still refused');
});

// Spec: MUS-SPEC-08-781H (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781h)
// Protected: complete inline diff for every edit of a file the chat edited several times, renamed or not.
test('every edit of a file the chat edited again later opens as the whole file, also across a rename', () => {
  const cwd = '/work';
  const items = [
    shellEdit('one', cwd, '*** Begin Patch\n*** Update File: app.ts\n@@\n const a = 1;\n-const b = 1;\n+const b = 2;\n const c = 1;\n*** End Patch'),
    shellEdit('two', cwd, '*** Begin Patch\n*** Update File: app.ts\n*** Move to: main.ts\n@@\n-const a = 1;\n+const a = 2;\n const b = 2;\n*** End Patch'),
    shellEdit('three', cwd, '*** Begin Patch\n*** Update File: main.ts\n@@\n const b = 2;\n-const c = 1;\n+const c = 2;\n*** End Patch'),
  ];
  const today = 'const a = 2;\nconst b = 2;\nconst c = 2;\nconst d = 1;\n';
  const one = rowView(items, 'one');
  assert.equal(one.now, '/work/main.ts', 'the first edit reads the file under the name it has now');
  assert.equal(one.later.length, 2, 'both later edits, including the rename, are undone first');
  const first = fileEditorModel(today, one.diffs, {later: one.later});
  assert.ok(first, 'the first of three edits opens as the whole file, not only its changed lines');
  assert.deepEqual(visible(first), ['const a = 1;', 'const b = 2;', 'const c = 1;', 'const d = 1;']);
  assert.deepEqual(first.lines.filter(row => row.kind === 'deleted').map(row => row.text), ['const b = 1;']);
  const two = rowView(items, 'two');
  assert.deepEqual(visible(fileEditorModel(today, two.diffs, {later: two.later})), ['const a = 2;', 'const b = 2;', 'const c = 1;', 'const d = 1;']);
  const three = rowView(items, 'three');
  assert.equal(three.later.length, 0);
  assert.deepEqual(visible(fileEditorModel(today, three.diffs, {later: three.later})), today.trimEnd().split('\n'));
  assert.equal(fileEditorModel(today, one.diffs), undefined, 'without the later edits the first one cannot be placed: this is the snippet-only bug');
});
