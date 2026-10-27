import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, symlink, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {collectFileChanges} from '../src/renderer/turnFileChanges.ts';
import {fileEditorModel,reconstructBefore} from '../src/renderer/diffEditorModel.ts';

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
