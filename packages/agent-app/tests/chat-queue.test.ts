import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {queueActionAfter,queuePausedLabel} from '../src/runtime/chat-queue.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-queue-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}
function gatedProvider(steer?:ProviderAdapter['steer']){
  const prompts:string[]=[];let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const provider:ProviderAdapter={info,run:async input=>{prompts.push(input.prompt);gate=Promise.withResolvers();return gate.promise;},stop:async()=>true,dispose(){},...(steer?{steer}:{})};
  return {provider,prompts,finish(result:ProviderResult={status:'completed',finalMessage:'done'}){const current=gate!;gate=undefined;current.resolve(result);},get open(){return !!gate;}};
}

test('queued follow-ups persist, reorder, and dispatch in order only after a completed run',async t=>{
  const dataDir=await directory(t),fake=gatedProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  const chatOf=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});
  await until(()=>fake.open);
  const a=await service.invoke('chat.queue.add',{id:chat.id,text:'first',requestId:'q-first'});
  const b=await service.invoke('chat.queue.add',{id:chat.id,text:'second',requestId:'q-second'});
  const c=await service.invoke('chat.queue.add',{id:chat.id,text:'third',requestId:'q-third'});
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'dup',requestId:'q-first'}),/already queued/);
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'sent',requestId:'start'}),/already sent/);
  assert.equal((await service.invoke('chat.queue.update',{id:chat.id,queueId:b.id,text:'second, edited'})).text,'second, edited');
  await service.invoke('chat.queue.move',{id:chat.id,queueId:c.id,direction:'up'});
  await service.invoke('chat.queue.move',{id:chat.id,queueId:a.id,direction:'up'});
  await service.invoke('chat.queue.remove',{id:chat.id,queueId:a.id});
  assert.deepEqual((await chatOf()).queue?.map(item=>item.text),['third','second, edited']);
  fake.finish();
  await until(()=>fake.prompts.length===2);
  assert.equal(fake.prompts[1],'third');
  assert.deepEqual((await chatOf()).queue?.map(item=>item.requestId),['q-second']);
  // Same requestId replays the receipt instead of sending twice.
  const runs=fake.prompts.length;await service.invoke('chat.send',{id:chat.id,text:'third',requestId:'q-third'});assert.equal(fake.prompts.length,runs);
  fake.finish({status:'failed',finalMessage:'',dispatchState:'not-dispatched',recovery:{kind:'failed',retryable:false,reason:'Provider failed.'}});
  await until(async()=>(await chatOf()).status==='failed');
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal(fake.prompts.length,2);
  assert.deepEqual((await chatOf()).queue?.map(item=>item.text),['second, edited']);
  // A run that does not complete pauses the queue (Codex); the paused reason drives the renderer's banner.
  const held=await chatOf();
  assert.equal(held.queuePaused,'failed');
  assert.equal(queuePausedLabel(held.queuePaused!),'Queue paused because the last run did not finish');
  await service.dispose();
  const store=new AgentStore(dataDir);
  assert.deepEqual(store.queue(chat.id).map(item=>[item.text,item.requestId]),[['second, edited','q-second']]);
  store.close();
});

test('adding to the queue of an idle chat sends immediately; the store caps the queue at 20',async t=>{
  const dataDir=await directory(t),fake=gatedProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.queue.add',{id:chat.id,text:'go now',requestId:'now'});
  await until(()=>fake.prompts.length===1);assert.equal(fake.prompts[0],'go now');
  fake.finish();await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  await service.dispose();
  const store=new AgentStore(dataDir);
  for(let i=0;i<20;i++)store.enqueue(chat.id,{id:`q${i}`,text:'x',requestId:`r${i}`,attachmentIds:[],createdAt:new Date().toISOString()},20);
  assert.throws(()=>store.enqueue(chat.id,{id:'q20',text:'x',requestId:'r20',attachmentIds:[],createdAt:new Date().toISOString()},20),/At most 20/);
  store.close();
  assert.equal(queueActionAfter('completed'),'dispatch');
  for(const status of ['failed','interrupted','idle'] as const)assert.equal(queueActionAfter(status),'hold');
});

test('steer joins the live turn once per request and reports false when nothing runs',async t=>{
  const dataDir=await directory(t);const steers:string[]=[];let live=false;
  const fake=gatedProvider(async(_chatId,text)=>{if(!live)return false;steers.push(text);return true;});
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'idle',requestId:'s0'}),{steered:false});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>fake.open);
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'too early',requestId:'s1'}),{steered:false});
  live=true;
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'focus on tests',requestId:'s2'}),{steered:true});
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'focus on tests',requestId:'s2'}),{steered:true});
  assert.deepEqual(steers,['focus on tests']);
  const item=(await service.invoke('chat.timeline',{id:chat.id})).items.at(-1)!;
  assert.equal(item.kind,'user');assert.equal(item.text,'focus on tests');assert.equal(item.data?.steered,true);
  fake.finish();await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  await service.dispose();
});

test('provider steer targets the chat-owned core session and stops after settlement',async()=>{
  const calls:Array<[string,string,string|undefined]>=[];let resolve!:(result:ProviderResult)=>void;
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,runCodexAppServer:()=>new Promise(done=>{resolve=done;}),async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){},
    async steerActiveCodexTurn(text,owner,key){calls.push([text,owner,key]);return true;}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const input:ProviderInput={chat:{id:'chat-1',mode:'agent',model:'claude/claude-fable-5'} as ProviderInput['chat'],cwd:'/unused',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}};
  assert.equal(await adapter.steer!('chat-1','early'),false);
  const pending=adapter.run(input);await new Promise(done=>setImmediate(done));
  assert.equal(await adapter.steer!('chat-1','mid-run'),true);
  assert.equal(calls.length,1);assert.equal(calls[0]![0],'mid-run');assert.match(calls[0]![1],/chat-1/);assert.equal(calls[0]![2],'agent:chat-1:hybrow:fixture-hybrow');
  resolve({status:'completed',finalMessage:'',dispatchState:'dispatched',threadId:'t',turnId:'u'});await pending;
  assert.equal(await adapter.steer!('chat-1','late'),false);
  adapter.dispose();
});

test('queued and steered messages keep their skill, plugin and effort chips',async t=>{
  const dataDir=await directory(t),home=await directory(t);
  const previous=process.env.HOME;process.env.HOME=home;t.after(()=>{process.env.HOME=previous;});
  const {mkdir,writeFile}=await import('node:fs/promises');
  const skillDir=join(home,'.codex','skills','pdf');await mkdir(skillDir,{recursive:true});await writeFile(join(skillDir,'SKILL.md'),'Use the pdf checklist.');
  const pluginDir=join(home,'.codex','plugins','cache','openai-curated','gmail','0.1.0');
  await mkdir(join(pluginDir,'.codex-plugin'),{recursive:true});await writeFile(join(pluginDir,'.codex-plugin','plugin.json'),JSON.stringify({name:'gmail',interface:{displayName:'Gmail'}}));
  const inputs:ProviderInput[]=[],steers:string[]=[];let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const provider:ProviderAdapter={info,run:async input=>{inputs.push(input);gate=Promise.withResolvers();return gate.promise;},stop:async()=>true,dispose(){},async steer(_chatId,text){steers.push(text);return true;}};
  let service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  const [skill]=await service.invoke('plugins.list',{}),gmail=(await service.invoke('plugins.inventory',undefined)).find(entry=>entry.name==='gmail')!;
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>Boolean(gate));
  const queued=await service.invoke('chat.queue.add',{id:chat.id,text:'Summarise $pdf via @gmail',requestId:'chips',skillIds:[skill!.id],pluginIds:[gmail.id],effort:'high'});
  assert.deepEqual([queued.skillIds,queued.pluginIds,queued.effort],[[skill!.id],[gmail.id],'high']);
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'x',requestId:'bad',skillIds:[join(home,'nope')]}),/skill is unavailable/);
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'x',requestId:'bad2',effort:'max' as never}),/Invalid reasoning effort/);
  // Snapshot queues carry the chips so the composer can draw them.
  const snapshotQueue=async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.queue!;
  assert.deepEqual((await snapshotQueue())[0]!.pluginIds,[gmail.id]);
  // Steer carries chip instructions into the live turn; effort waits for the next turn.
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'also check $pdf',requestId:'steer',skillIds:[skill!.id],effort:'low'}),{steered:true});
  assert.match(steers[0]!,/Use the pdf checklist\.[\s\S]*Current user request:\nalso check \$pdf/);
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'with file',requestId:'steer-file',attachmentIds:['att-1']}),{steered:false},'files cannot steer');
  const steered=(await service.invoke('chat.timeline',{id:chat.id})).items.at(-1)!;assert.equal(steered.text,'also check $pdf');assert.deepEqual(steered.data?.skillIds,[skill!.id]);
  gate!.resolve({status:'completed',finalMessage:'ok'});
  await until(()=>inputs.length===2);
  assert.equal(inputs[1]!.reasoningEffort,'high','the queued item keeps its own effort');
  assert.match(inputs[1]!.prompt,/Use the pdf checklist\.[\s\S]*invoked the Gmail plugin[\s\S]*Current user request:\nSummarise \$pdf via @gmail/);
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.queue,undefined);
  gate!.resolve({status:'completed',finalMessage:'ok'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});
  await service.invoke('chat.send',{id:chat.id,text:'next',requestId:'next'});await until(()=>inputs.length===3);
  assert.equal(inputs[2]!.reasoningEffort,undefined,'steer effort is session state, not persisted');
  gate!.resolve({status:'completed',finalMessage:'ok'});
  await service.dispose();
});
