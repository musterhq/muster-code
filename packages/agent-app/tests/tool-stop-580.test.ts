import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {classifyTool,commandOutcome,toolState} from '../src/renderer/components/toolPresentation.ts';

async function until(check:()=>Promise<boolean>) {
  for(let i=0;i<200;i++){if(await check())return;await delay(5);}
  throw new Error('Expected tool state did not arrive');
}
const deferred=()=>{let resolve!:()=>void;const promise=new Promise<void>(r=>{resolve=r;});return {promise,resolve};};
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'Hidden',models:[]}];

test('#580 Stop persists unfinished tools as Stopped, retaining output and completed tools',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-580-'));
  const gate=deferred(),started=deferred();
  const provider:ProviderAdapter={info,
    async run(input){
      input.onEvent('item/completed',{item:{id:'done',type:'commandExecution',command:'echo done',exitCode:0}});
      input.onEvent('item/started',{item:{id:'active',type:'commandExecution',command:'long command'}});
      input.onEvent('item/commandExecution/outputDelta',{itemId:'active',delta:'tick-1\ntick-2\n'});
      started.resolve();await gate.promise;
      // The stopped process supplies no item/completed for the active tool.
      return {status:'failed',finalMessage:'',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}};
    },
    async stop(){gate.resolve();return true;},dispose(){gate.resolve();},
  };
  let service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{gate.resolve();await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});await started.promise;
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.status==='interrupted');
  const check=async()=>{
    const rows=(await service.invoke('chat.timeline',{id:chat.id})).items;
    const active=rows.find(i=>i.data?.providerItemId==='active')!;
    assert.equal(active.status,'interrupted');
    assert.equal(toolState(active,classifyTool(active.data)),'Stopped');
    assert.equal(active.data?.output,'tick-1\ntick-2\n');
    assert.equal(typeof active.data?.durationMs,'number');
    assert.equal(rows.find(i=>i.data?.providerItemId==='done')?.status,'completed');
  };
  await check();await service.dispose();
  service=createAgentService({dataDir,provider,onEvent(){}});await check();
});

test('#580 denied commands say Did not run when the provider reports cancelled',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-580-deny-'));
  const provider:ProviderAdapter={info,
    async run(input){
      input.onEvent('item/started',{item:{id:'denied',type:'commandExecution',command:'printf outside'}});
      assert.deepEqual(await input.onRequest('item/commandExecution/requestApproval',{itemId:'denied',command:'printf outside'}),{decision:'decline'});
      input.onEvent('item/completed',{item:{id:'denied',type:'commandExecution',command:'printf outside',status:'cancelled'}});
      return {status:'completed',finalMessage:'done'};
    },
    async stop(){return true;},dispose(){},
  };
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
  const rows=async()=>(await service.invoke('chat.timeline',{id:chat.id})).items;
  await until(async()=>(await rows()).some(i=>i.kind==='approval'));
  const tool=(await rows()).find(i=>i.kind==='tool')!;
  assert.equal(toolState(tool,classifyTool(tool.data)),'Waiting for approval');
  await service.invoke('approval.respond',{id:(await rows()).find(i=>i.kind==='approval')!.id,approved:false});
  await until(async()=>(await rows()).find(i=>i.kind==='tool')?.status==='cancelled');
  const denied=(await rows()).find(i=>i.kind==='tool')!;
  assert.equal(denied.data?.executionDenied,true);
  assert.equal(toolState(denied,classifyTool(denied.data)),'Did not run');
  assert.equal(commandOutcome(denied.data,denied.status).suffix,'denied');
  assert.equal(toolState({status:'completed'},classifyTool(denied.data)),'Ran');
  assert.equal(toolState({status:'interrupted'},classifyTool(denied.data)),'Stopped');
});
