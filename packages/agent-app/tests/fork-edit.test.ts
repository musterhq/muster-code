import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {transcriptDigest,FORK_DIGEST_BYTES} from '../src/runtime/chat-fork.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {AgentEvent,TimelineItem} from '../src/shared/protocol.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-fork-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}
/** Every run answers at once with `reply-<n>`; a run's input is kept for inspection. */
function scripted(){
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);input.onThreadReady?.(`thread-${inputs.length}`);input.onDelta?.(`reply-${inputs.length}`);return {status:'completed',finalMessage:`reply-${inputs.length}`} as ProviderResult;},async stop(){return true;},dispose(){}};
  return {provider,inputs};
}
async function setup(t:TestContext){
  const dataDir=await directory(t),run=scripted(),events:AgentEvent[]=[];
  const service=createAgentService({dataDir,provider:run.provider,onEvent(event){events.push(event);}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const settled=async(id:string,turns:number)=>until(async()=>{const snap=await service.invoke('app.snapshot',undefined),c=snap.chats.find(x=>x.id===id)!;return c.status==='completed'&&(await service.invoke('chat.timeline',{id})).items.filter(i=>i.kind==='assistant').length>=turns;});
  return {service,run,events,chat,settled,items:async(id:string)=>(await service.invoke('chat.timeline',{id})).items};
}

test('fork copies history through the chosen item, links its origin, and seeds the first send with a digest',async t=>{
  const {service,run,chat,settled,items}=await setup(t);
  await service.invoke('chat.update',{id:chat.id,mode:'plan'});
  await service.invoke('chat.send',{id:chat.id,text:'first question',requestId:'s1'});await settled(chat.id,1);
  await service.invoke('chat.send',{id:chat.id,text:'second question',requestId:'s2'});await settled(chat.id,2);
  const origin=await items(chat.id),firstReply=origin.find(i=>i.kind==='assistant')!;
  const fork=await service.invoke('chat.fork',{id:chat.id,fromItemId:firstReply.id});
  assert.notEqual(fork.id,chat.id);
  assert.equal(fork.originChatId,chat.id);assert.equal(fork.originItemId,firstReply.id);
  assert.equal(fork.mode,'plan');assert.equal(fork.model,'claude/claude-fable-5');
  assert.equal(fork.providerThreadId,undefined,'a fork starts with no provider thread');
  const copied=await items(fork.id);
  assert.deepEqual(copied.map(i=>i.text),['first question','reply-1']);
  assert.ok(copied.every(i=>i.data?.forked===true),'copied rows are marked forked');
  assert.ok(copied.every(i=>!origin.some(o=>o.id===i.id)),'copies get their own ids');
  assert.equal((await items(chat.id)).length,origin.length,'the origin is untouched');
  assert.equal((await service.invoke('app.snapshot',undefined)).activeChatId,fork.id);

  await service.invoke('chat.send',{id:fork.id,text:'branch here',requestId:'f1'});await settled(fork.id,2);
  const seeded=run.inputs.at(-1)!.prompt;
  assert.match(seeded,/Earlier conversation \(forked\)/);assert.match(seeded,/User: first question/);assert.match(seeded,/Assistant: reply-1/);
  assert.doesNotMatch(seeded,/second question/,'nothing after the fork point leaks in');
  assert.match(seeded,/branch here$/);
  await service.invoke('chat.send',{id:fork.id,text:'and again',requestId:'f2'});await settled(fork.id,3);
  assert.equal(run.inputs.at(-1)!.prompt,'and again','only the first send in the fork carries the digest');
  await assert.rejects(service.invoke('chat.fork',{id:chat.id,fromItemId:copied[0]!.id}),/no longer in this chat/,'an item from another chat is refused');
});

test('edit-and-resend forks from the item before by default; replace drops the edited turn and what followed',async t=>{
  const {service,run,chat,settled,items}=await setup(t);
  await service.invoke('chat.send',{id:chat.id,text:'draft a plan',requestId:'e1'});await settled(chat.id,1);
  await service.invoke('chat.send',{id:chat.id,text:'implement it',requestId:'e2'});await settled(chat.id,2);
  const before=await items(chat.id),second=before.filter(i=>i.kind==='user')[1]!;
  const options=await service.invoke('chat.editOptions',{id:chat.id,itemId:second.id});
  assert.equal(options.canReplace,true);assert.equal(options.dirtyFiles,0);
  const result=await service.invoke('chat.editResend',{id:chat.id,itemId:second.id,text:'implement it in Rust',requestId:'edit-1'});
  assert.equal(result.forked,true);assert.notEqual(result.chatId,chat.id);
  await settled(result.chatId,2);
  assert.deepEqual((await items(result.chatId)).map(i=>i.text),['draft a plan','reply-1','implement it in Rust','reply-3']);
  assert.deepEqual((await items(chat.id)).map(i=>i.text),before.map(i=>i.text),'the original keeps every turn');
  assert.deepEqual(await service.invoke('chat.editResend',{id:chat.id,itemId:second.id,text:'implement it in Rust',requestId:'edit-1'}),result,'the same requestId never forks twice');
  assert.equal(run.inputs.length,3);

  // Replace in this chat: drops the prompt and what followed, starts a fresh provider conversation seeded with the rest.
  const replaced=await service.invoke('chat.editResend',{id:chat.id,itemId:second.id,text:'implement it in Go',requestId:'edit-2',mode:'replace'});
  assert.deepEqual(replaced,{chatId:chat.id,runId:replaced.runId,forked:false});
  await settled(chat.id,2);
  assert.deepEqual((await items(chat.id)).map(i=>i.text),['draft a plan','reply-1','implement it in Go','reply-4']);
  assert.match(run.inputs.at(-1)!.prompt,/Earlier conversation \(forked\)[\s\S]*User: draft a plan[\s\S]*implement it in Go$/);
  assert.equal(run.inputs.at(-1)!.chat.providerThreadId,undefined,'replace never continues the old provider thread');

  const firstPrompt=(await items(chat.id)).find(i=>i.kind==='user')!;
  assert.equal((await service.invoke('chat.editOptions',{id:chat.id,itemId:firstPrompt.id})).canReplace,true,'no later work edited files');
});

test('replace is blocked by a later file change, and a dirty checkout is reported',async t=>{
  const dataDir=await directory(t),inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);input.onThreadReady?.('thread');
    input.onEvent?.('item/completed',{item:{id:'fc1',type:'fileChange',status:'completed',changes:[{path:'a.ts',kind:'update'}]}});
    return {status:'completed',finalMessage:'edited'};},async stop(){return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folderPath=join(dataDir,'repo');await mkdir(folderPath);
  execFileSync('git',['init','-q'],{cwd:folderPath});await writeFile(join(folderPath,'a.ts'),'changed');
  const folder=await service.invoke('folder.add',{path:folderPath});
  const chat=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.send',{id:chat.id,text:'edit a.ts',requestId:'x1'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)!.status==='completed');
  const prompt=(await service.invoke('chat.timeline',{id:chat.id})).items.find(i=>i.kind==='user')!;
  const options=await service.invoke('chat.editOptions',{id:chat.id,itemId:prompt.id});
  assert.equal(options.canReplace,false);assert.match(options.replaceBlockedReason!,/not be rewound/);
  assert.equal(options.dirtyFiles,1,'uncommitted changes are counted so the editor can warn');
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'edit b.ts',requestId:'x2',mode:'replace'}),/fork instead/);
  const forked=await service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'edit b.ts',requestId:'x3'});
  assert.equal(forked.forked,true);
  await until(async()=>inputs.length===2);
  assert.equal(inputs[1]!.prompt,'edit b.ts','editing the first message forks with no history to carry');
  const reply=(await service.invoke('chat.timeline',{id:chat.id})).items.find(i=>i.kind==='assistant')!;
  await assert.rejects(service.invoke('chat.editOptions',{id:chat.id,itemId:reply.id}),/Only your own messages/);
});

test('retry resends the latest turn with a new requestId and refuses older turns',async t=>{
  const {service,run,chat,settled,items}=await setup(t);
  await service.invoke('chat.send',{id:chat.id,text:'one',requestId:'r1'});await settled(chat.id,1);
  await service.invoke('chat.send',{id:chat.id,text:'two',requestId:'r2'});await settled(chat.id,2);
  const timeline=await items(chat.id),answers=timeline.filter(i=>i.kind==='assistant');
  const retried=await service.invoke('chat.retry',{id:chat.id,itemId:answers[1]!.id});
  assert.notEqual(retried.requestId,'r2');
  await settled(chat.id,3);
  assert.equal(run.inputs.at(-1)!.prompt,'two');
  await assert.rejects(service.invoke('chat.retry',{id:chat.id,itemId:answers[0]!.id}),/latest turn/);
  const again=(await items(chat.id)).filter(i=>i.kind==='assistant').at(-1)!;
  const second=await service.invoke('chat.retry',{id:chat.id,itemId:again.id});
  assert.notEqual(second.requestId,retried.requestId,'every retry is its own request');
  await settled(chat.id,4);
  assert.equal(run.inputs.length,4);
  // F46: retry re-runs the original prompt; the transcript never gains a copy of it.
  const users=(await items(chat.id)).filter(i=>i.kind==='user').map(i=>i.text);
  assert.deepEqual(users,['one','two']);
});

test('transcript digest keeps the newest 30 items within 24 KB, oldest first, and skips tool output',()=>{
  const item=(n:number,kind:TimelineItem['kind'],text:string):TimelineItem=>({id:`i${n}`,chatId:'c',kind,text,createdAt:'2026-01-01T00:00:00.000Z',...(kind==='tool'?{status:'completed',data:{name:'npm test',output:'SECRET OUTPUT'}}:{})});
  const many=Array.from({length:40},(_,n)=>item(n,n%2?'assistant':'user',`message ${n}`));
  const digest=transcriptDigest(many);
  assert.doesNotMatch(digest,/message 9\b/);assert.match(digest,/message 10\b/);assert.match(digest,/message 39\b/);
  assert.ok(digest.indexOf('message 10')<digest.indexOf('message 39'));
  assert.ok(Buffer.byteLength(transcriptDigest(Array.from({length:30},(_,n)=>item(n,'user','x'.repeat(5000)))))<=FORK_DIGEST_BYTES+400);
  const tools=transcriptDigest([item(1,'tool','npm test\nSECRET OUTPUT')]);
  assert.match(tools,/Tool \(completed\): npm test/);assert.doesNotMatch(tools,/SECRET/);
  assert.equal(transcriptDigest([]),'');
});

test('an edit refused before dispatch leaves no empty fork behind, and a refused replace keeps the text in the composer',async t=>{
  const run=scripted();let available=true;
  const provider:ProviderAdapter={...run.provider,info:()=>info().map(entry=>({...entry,available}))};
  const service=createAgentService({dataDir:await directory(t),provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'first',requestId:'r1'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.status==='completed');
  const prompt=(await service.invoke('chat.timeline',{id:chat.id})).items.find(i=>i.kind==='user')!;
  available=false;
  const count=async()=>(await service.invoke('app.snapshot',undefined)).chats.length,before=await count();
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'second',requestId:'r2'}));
  assert.equal(await count(),before,'the refused fork was removed');
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'second',requestId:'r2'}));
  assert.equal(await count(),before,'trying again never piles up forks');
  await assert.rejects(service.invoke('chat.editResend',{id:chat.id,itemId:prompt.id,text:'third',requestId:'r3',mode:'replace'}));
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.draft,'third','the replaced prompt survives in the composer');
});
