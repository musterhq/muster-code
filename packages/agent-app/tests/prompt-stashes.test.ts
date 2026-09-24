import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,readdir,rm} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {isCommandName} from '../src/main/commands.ts';
import {STASHES_COMMANDS,defaultStashName,type PromptStash} from '../src/shared/domains/stashes-protocol.ts';

const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-stash-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
const png=Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010806000000','hex');
const pngBase64=Buffer.concat([png,Buffer.alloc(16)]).toString('base64');

test('stash commands are allowlisted for the renderer',()=>{
  for(const command of Object.keys(STASHES_COMMANDS))assert.equal(isCommandName(command),true,command);
});

test('defaultStashName uses the first non-empty line, clipped',()=>{
  assert.equal(defaultStashName('\n  Fix the login bug  \nmore'),'Fix the login bug');
  assert.equal(defaultStashName('   '),'Stashed prompt');
  assert.equal(defaultStashName('x'.repeat(100)).length,60);
});

test('save, list, rename, restore and delete a stash with chips, effort and attachments; it survives a restart',async t=>{
  const dataDir=await directory(t);
  let service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const image=await service.invoke('attachments.stage',{chatId:chat.id,name:'shot.png',mime:'image/png',dataBase64:pngBase64});
  const note=await service.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello').toString('base64')});
  const chips=[{token:'$review',kind:'skill',id:'skill-1',label:'Review'}];
  const context=[{id:'file:1',type:'file',label:'a.ts',source:{path:'a.ts'}}];
  const saved=await call<PromptStash>(service,'stashes.save',{text:'Refactor the parser\nthen test',chatId:chat.id,chips,context,effort:'high',attachmentIds:[image.id,note.id]});
  assert.equal(saved.name,'Refactor the parser');assert.equal(saved.effort,'high');
  assert.deepEqual(saved.chips,chips);assert.deepEqual(saved.context,context);
  assert.deepEqual(saved.attachments.map(file=>file.name),['shot.png','notes.txt']);
  assert.equal((await readdir(join(dataDir,'prompt-stashes',saved.id))).length,2,'files are copied into the stash');

  // The composer clears after stashing: its staged copies go away, the stash keeps its own.
  await service.invoke('attachments.discard',{chatId:chat.id,id:image.id});
  await service.invoke('attachments.discard',{chatId:chat.id,id:note.id});

  const second=await call<PromptStash>(service,'stashes.save',{name:'Plain',text:'just words'});
  assert.equal(second.attachments.length,0);
  await assert.rejects(call(service,'stashes.save',{text:'   '}),/Write something/);
  await assert.rejects(call(service,'stashes.save',{text:'x',effort:'huge'}),/reasoning effort/);
  await assert.rejects(call(service,'stashes.save',{text:'x',attachmentIds:['nope']}),/chat these files/);

  const renamed=await call<PromptStash>(service,'stashes.rename',{id:saved.id,name:'  Parser work  '});
  assert.equal(renamed.name,'Parser work');
  await assert.rejects(call(service,'stashes.rename',{id:saved.id,name:'  '}),/Name the stash/);

  // Persisted runtime-side: a fresh service over the same data dir sees the same stashes.
  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});
  const listed=(await call<{stashes:PromptStash[]}>(service,'stashes.list')).stashes;
  assert.deepEqual(listed.map(stash=>stash.name),['Parser work','Plain'],'most recently updated first');

  const target=await service.invoke('chat.create',{});
  const restored=await call<{stash:PromptStash;attachments:Array<{id:string;name:string;state:string;chatId:string}>}>(service,'stashes.restore',{id:saved.id,chatId:target.id});
  assert.equal(restored.stash.text,'Refactor the parser\nthen test');
  assert.deepEqual(restored.attachments.map(ref=>[ref.name,ref.state,ref.chatId]),[['shot.png','staged',target.id],['notes.txt','staged',target.id]]);
  assert.deepEqual((await service.invoke('attachments.list',{chatId:target.id})).map(ref=>ref.name),['shot.png','notes.txt'],'attachments are restaged into the composer');
  assert.ok(existsSync(join(dataDir,'prompt-stashes',saved.id)),'restoring keeps the stash');

  await call(service,'stashes.delete',{id:saved.id});
  assert.equal(existsSync(join(dataDir,'prompt-stashes',saved.id)),false,'deleting removes the stash files');
  assert.deepEqual((await call<{stashes:PromptStash[]}>(service,'stashes.list')).stashes.map(stash=>stash.id),[second.id]);
  await assert.rejects(call(service,'stashes.restore',{id:saved.id,chatId:target.id}),/no longer exists/);
});

test('a restore whose stash file went missing stages nothing',async t=>{
  const dataDir=await directory(t);
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const a=await service.invoke('attachments.stage',{chatId:chat.id,name:'a.txt',mime:'text/plain',dataBase64:Buffer.from('a').toString('base64')});
  const b=await service.invoke('attachments.stage',{chatId:chat.id,name:'b.txt',mime:'text/plain',dataBase64:Buffer.from('b').toString('base64')});
  const stash=await call<PromptStash>(service,'stashes.save',{text:'two files',chatId:chat.id,attachmentIds:[a.id,b.id]});
  const dir=join(dataDir,'prompt-stashes',stash.id);
  const missing=(await readdir(dir)).find(name=>name.endsWith('b.txt'))!;
  await rm(join(dir,missing));
  const target=await service.invoke('chat.create',{});
  await assert.rejects(call(service,'stashes.restore',{id:stash.id,chatId:target.id}),/b\.txt is missing/);
  assert.deepEqual(await service.invoke('attachments.list',{chatId:target.id}),[]);
});

test('stash ids that are not UUIDs are refused, so delete can never walk out of the stash root',async t=>{
  const dataDir=await directory(t);
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const kept=await call<PromptStash>(service,'stashes.save',{text:'keep me'});
  for(const id of ['..','.','../..','x'])await assert.rejects(call(service,'stashes.delete',{id}),/Choose a stash/,id);
  await assert.rejects(call(service,'stashes.rename',{id:'..',name:'x'}),/Choose a stash/);
  assert.ok(existsSync(dataDir),'the data dir survives');
  assert.deepEqual((await call<{stashes:PromptStash[]}>(service,'stashes.list')).stashes.map(stash=>stash.id),[kept.id]);
});

test('a long multi-byte attachment name still fits the file-name limit and restores',async t=>{
  const dataDir=await directory(t);
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const name=`${'説明書'.repeat(40)}.txt`;// 120 CJK characters: 360 bytes before the cap
  const file=await service.invoke('attachments.stage',{chatId:chat.id,name,mime:'text/plain',dataBase64:Buffer.from('hi').toString('base64')});
  const stash=await call<PromptStash>(service,'stashes.save',{text:'cjk',chatId:chat.id,attachmentIds:[file.id]});
  const [stored]=await readdir(join(dataDir,'prompt-stashes',stash.id));
  assert.ok(Buffer.byteLength(stored!)<=255,`${Buffer.byteLength(stored!)} bytes`);
  const target=await service.invoke('chat.create',{});
  const restored=await call<{attachments:Array<{name:string}>}>(service,'stashes.restore',{id:stash.id,chatId:target.id});
  assert.deepEqual(restored.attachments.map(ref=>ref.name),[file.name]);
});
