import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {NO_LIVE_SESSION,type ProviderAdapter} from '../src/runtime/provider.ts';
import {isCompactCommand} from '../src/shared/compact-command.ts';
import {fetchModelList} from '../src/runtime/adapters/http-chat.ts';
import {catalogModels,routerAgents} from '../src/runtime/provider-instances.ts';
import {contextView} from '../src/renderer/contextView.ts';
import {cleanIpcError} from '../src/renderer/components/resourceErrors.ts';

function setup(live:{value:boolean},prompts:string[]) {
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'test',models:[{id:'intelligent-planner',name:'Planner'}]}],stop:async()=>true,dispose(){},
    async run(input){prompts.push(input.prompt);input.onDelta('ok');return {status:'completed',finalMessage:'ok',threadId:'thread-1'};},
    async compact(){if(!live.value)throw new Error(NO_LIVE_SESSION);}};
  return provider;
}
async function make(t:{after:(fn:()=>Promise<void>)=>void},live:{value:boolean},prompts:string[]) {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-project-compact-'));
  const service=createAgentService({dataDir,provider:setup(live,prompts),onEvent(){}});
  t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  const project=await service.invoke('project.create',{name:'OssMgr',goal:'',folderIds:[]} as never) as {id:string};
  const chat=await service.invoke('chat.create',{projectId:project.id} as never);
  await service.invoke('chat.send',{id:chat.id,text:'long work',requestId:'r1'});
  for(let i=0;i<100&&(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='running';i++)await sleep(2);
  return {service,chat};
}

test('project chat: compact with a live session compacts the provider thread',async t=>{
  const live={value:true},prompts:string[]=[];const {service,chat}=await make(t,live,prompts);
  await service.invoke('chat.compact',{id:chat.id});
  const rows=(await service.invoke('chat.select',{id:chat.id})).filter(i=>i.data?.kind==='compaction');
  assert.equal(rows.at(-1)?.text,'Context compacted');
});

test('project chat: with no live session compaction restarts from the stored transcript with a digest',async t=>{
  const live={value:false},prompts:string[]=[];const {service,chat}=await make(t,live,prompts);
  await service.invoke('chat.compact',{id:chat.id});
  const rows=(await service.invoke('chat.select',{id:chat.id})).filter(i=>i.data?.kind==='compaction');
  assert.equal(rows.at(-1)?.status,'completed');assert.match(rows.at(-1)!.text,/saved transcript/);
  const after=(await service.invoke('app.snapshot',undefined)).chats[0]!;
  assert.equal(after.providerThreadId??null,null);
  await service.invoke('chat.send',{id:chat.id,text:'next',requestId:'r2'});
  for(let i=0;i<100&&(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='running';i++)await sleep(2);
  assert.match(prompts.at(-1)!,/long work/);
});

test('/compact is intercepted by Muster and never reaches the model',async t=>{
  const live={value:false},prompts:string[]=[];const {service,chat}=await make(t,live,prompts);
  const before=prompts.length;
  await service.invoke('chat.send',{id:chat.id,text:'/compact',requestId:'r3'});
  assert.equal(prompts.length,before);
  assert.equal(isCompactCommand(' /compact'),false);assert.equal(isCompactCommand('/compact '),true);assert.equal(isCompactCommand('/compact now'),false);
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'/compact',requestId:'r4'}),/not queued/);
});

test('router context_length becomes the model window',async()=>{
  const body=JSON.stringify({data:[{id:'intelligent-planner',owned_by:'combo',context_length:872000},{id:'x',max_input_tokens:128000},{id:'y'}]});
  const listed=await fetchModelList('http://r/v1/models',{},'Router',async()=>new Response(body));
  assert.equal(listed[0]!.contextWindow,872000);assert.equal(listed[1]!.contextWindow,128000);assert.equal(listed[2]!.contextWindow,undefined);
  assert.equal(routerAgents(listed)[0]!.contextWindow,872000);
  assert.equal(catalogModels('gateway',[{slug:'a',context_window:1000}]).models[0]!.contextWindow,1000);
  const view=contextView({usedTokens:337,windowTokens:null,source:'live',compacted:false,updatedAt:null},872000);
  assert.equal(view.windowTokens,872000);assert.equal(view.remaining,872000-337);
  assert.equal(contextView({usedTokens:337,windowTokens:200000,source:'live',compacted:false,updatedAt:null},872000).windowTokens,200000);
});

test('errors lose the IPC prefix',()=>{
  assert.equal(cleanIpcError(new Error("Error invoking remote method 'muster:invoke': Error: No live provider session holds this thread.")),'No live provider session holds this thread.');
});
