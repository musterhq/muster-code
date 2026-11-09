/** #829 part 1, runtime: a visual edited in the chat is a Canvas linked to its chat and visual (original = version 1, each
 *  saved edit a later version), it survives a restart, and the chat's next turn carries the edited source. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../src/runtime/service.ts';
import {CanvasStore} from '../src/runtime/canvases.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {Canvas,CanvasSummary,CanvasVersion} from '../src/shared/domains/artifacts-protocol.ts';

const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
async function directory(t:TestContext,prefix='muster-visual-edit-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
type Service=ReturnType<typeof createAgentService>;
const call=<T>(service:Service,command:string,input?:unknown)=>(service.invoke as unknown as (c:string,i:unknown)=>Promise<T>)(command,input);
const ORIGINAL='flowchart LR\n  Draft-->Review';
const EDITED='flowchart LR\n  Draft-->Review-->Ship';

// Spec: MUS-SPEC-21-829F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829f)
test('a saved visual edit is a canvas linked to its chat and visual, and it survives a restart',async t=>{
  const dataDir=await directory(t);
  let service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const visual={kind:'diagram',key:'diagram:abc123'};
  // The renderer's Save: the original first (version 1), then the edit on top of it (version 2).
  const created=await call<Canvas>(service,'artifacts.canvas.create',{kind:'code',language:'mermaid',title:'Flowchart',content:ORIGINAL,chatId:chat.id,visual,note:'Original from the chat'});
  assert.deepEqual(created.visual,visual,'the canvas knows which visual of the chat it edits');
  const saved=await call<{conflict:boolean;canvas:Canvas}>(service,'artifacts.canvas.update',{id:created.id,content:EDITED,baseVersion:1,note:'Edited in the chat'});
  assert.equal(saved.conflict,false);assert.equal(saved.canvas.version,2);assert.deepEqual(saved.canvas.visual,visual);

  const listed=(await call<{canvases:CanvasSummary[]}>(service,'artifacts.canvas.list',{chatId:chat.id})).canvases;
  assert.equal(listed.length,1);assert.deepEqual(listed[0]!.visual,visual,'the chat list carries the link, so the block finds its edit');
  const versions=(await call<{versions:CanvasVersion[]}>(service,'artifacts.canvas.versions',{id:created.id})).versions;
  assert.deepEqual(versions.map(version=>[version.version,version.note]),[[2,'Edited in the chat'],[1,'Original from the chat']]);
  assert.equal((await call<{content:string}>(service,'artifacts.canvas.version',{id:created.id,version:1})).content,ORIGINAL,'the original stays reachable');

  await assert.rejects(call(service,'artifacts.canvas.create',{kind:'code',content:'x',chatId:chat.id,visual}),/already has an edit/,'one edit canvas per visual');
  await assert.rejects(call(service,'artifacts.canvas.create',{kind:'code',content:'x',visual:{kind:'diagram',key:'diagram:other'}}),/chat/,'a visual edit belongs to a chat');
  await assert.rejects(call(service,'artifacts.canvas.create',{kind:'code',content:'x',chatId:chat.id,visual:{kind:'diagram',key:'../../x'}}),/visual/);
  await assert.rejects(call(service,'artifacts.canvas.create',{kind:'code',content:'x',chatId:chat.id,visual:{kind:'video',key:'video:1'}}),/visual/);
  // A plain canvas is unchanged: no link.
  const plain=await call<Canvas>(service,'artifacts.canvas.create',{title:'Notes',content:'# Notes',chatId:chat.id});
  assert.equal(plain.visual,undefined);

  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});
  const reopened=await call<Canvas>(service,'artifacts.canvas.get',{id:created.id});
  assert.equal(reopened.content,EDITED);assert.equal(reopened.version,2);assert.deepEqual(reopened.visual,visual,'the link survives a restart');
  assert.equal((await call<{content:string}>(service,'artifacts.canvas.version',{id:created.id,version:1})).content,ORIGINAL);

  // A database made before the link existed opens, keeps its canvas and gains the column.
  const db=new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE canvases (id TEXT PRIMARY KEY, title TEXT NOT NULL, kind TEXT NOT NULL, language TEXT, content TEXT NOT NULL, version INTEGER NOT NULL,
    chat_id TEXT, folder_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, updated_by TEXT NOT NULL);
    INSERT INTO canvases VALUES ('11111111-2222-3333-4444-555555555555','Old','markdown',NULL,'# old',1,'c1',NULL,'2026-01-01T00:00:00Z','2026-01-01T00:00:00Z','user');`);
  const store=new CanvasStore(()=>db);
  assert.equal(store.get('11111111-2222-3333-4444-555555555555').content,'# old');
  const linked=store.create({kind:'html',content:'<p>x</p>',chatId:'c1',visual:{kind:'report',key:'report:zz9'}},'user');
  assert.deepEqual(store.get(linked.id).visual,{kind:'report',key:'report:zz9'});
});

// Spec: MUS-SPEC-21-829G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829g)
test('the next turn carries the edited source of a visual, and only in its own chat',async t=>{
  const dataDir=await directory(t);
  const prompts:Array<{chatId:string;prompt:string}>=[];
  let current='';
  const recording:ProviderAdapter={...provider,run:async(input:{prompt:string})=>{prompts.push({chatId:current,prompt:input.prompt});return {status:'completed',finalMessage:'ok'};}} as ProviderAdapter;
  const service=createAgentService({dataDir,provider:recording,onEvent(){}});
  t.after(()=>service.dispose());
  const first=await service.invoke('chat.create',{}),second=await service.invoke('chat.create',{});
  const diagram=await call<Canvas>(service,'artifacts.canvas.create',{kind:'code',language:'mermaid',title:'Release flow',content:ORIGINAL,chatId:first.id,visual:{kind:'diagram',key:'diagram:rel1'}});
  await call(service,'artifacts.canvas.update',{id:diagram.id,content:EDITED,baseVersion:1});
  // Linked but never edited: nothing new for the agent.
  await call<Canvas>(service,'artifacts.canvas.create',{kind:'code',language:'json',title:'Unedited chart',content:'{"type":"bar"}',chatId:first.id,visual:{kind:'chart',key:'chart:c1'}});

  const send=async(chatId:string,text:string)=>{const before=prompts.length;current=chatId;await service.invoke('chat.send',{id:chatId,text,requestId:`send-${chatId}-${before}`} as never);for(let i=0;i<300&&prompts.length===before;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(prompts.length,before+1,'the turn was sent');return prompts.at(-1)!.prompt;};
  const firstPrompt=await send(first.id,'Add a rollback step.');
  const block=/<context source="visual-edits">([\s\S]*?)<\/context>/.exec(firstPrompt);
  assert.ok(block,'the turn carries the edited visuals');
  assert.match(block![1]!,/Release flow/);
  assert.ok(block![1]!.includes(diagram.id),'names the canvas, so an agent-mode chat can canvas_read or canvas_update it');
  assert.match(block![1]!,/version 2/);
  assert.match(block![1]!,/```mermaid\nflowchart LR\n {2}Draft-->Review-->Ship\n```/,'the edited source, in a fence of its kind');
  assert.doesNotMatch(block![1]!,/Unedited chart/,'a visual with no edit is left out');
  assert.match(firstPrompt,/Add a rollback step\./);

  const secondPrompt=await send(second.id,'Hello');
  assert.doesNotMatch(secondPrompt,/visual-edits/,'another chat never sees these edits');
});
