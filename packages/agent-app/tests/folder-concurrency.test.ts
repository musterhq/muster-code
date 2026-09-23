import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderResult} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-folder-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setImmediate(resolve));}assert.fail('condition not reached');}
function gatedProvider(){
  const gates=new Map<string,PromiseWithResolvers<ProviderResult>>(),cwds=new Map<string,string>();
  const provider:ProviderAdapter={info,run:async input=>{const gate=Promise.withResolvers<ProviderResult>();gates.set(input.chat.id,gate);cwds.set(input.chat.id,input.cwd);return gate.promise;},stop:async()=>true,dispose(){}};
  return {provider,gates,cwds};
}

test('two chats in the same folder run at the same time',async t=>{
  const dataDir=await directory(t),{provider,gates,cwds}=gatedProvider();
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const folder=await service.invoke('folder.add',{path:dataDir});
  const first=await service.invoke('chat.create',{folderId:folder.id}),second=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.send',{id:first.id,text:'one',requestId:'first-one'});
  await service.invoke('chat.send',{id:second.id,text:'two',requestId:'second-one'});
  await until(()=>gates.size===2);
  const running=(await service.invoke('app.snapshot',undefined)).chats.filter(chat=>chat.status==='running').map(chat=>chat.id).sort();
  assert.deepEqual(running,[first.id,second.id].sort());
  assert.equal(cwds.get(first.id),cwds.get(second.id));
  for(const gate of gates.values())gate.resolve({status:'completed',finalMessage:'done'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.every(chat=>chat.status==='completed'));
  await service.dispose();
});

test('an unconfirmed sibling attempt adds one notice instead of blocking the folder',async t=>{
  const dataDir=await directory(t),{provider,gates}=gatedProvider();
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const folder=await service.invoke('folder.add',{path:dataDir});
  const stuck=await service.invoke('chat.create',{folderId:folder.id}),chat=await service.invoke('chat.create',{folderId:folder.id});
  const store=new AgentStore(dataDir);store.updateChat(stuck.id,{status:'failed',providerThreadId:'thread',providerTurnId:'turn',recovery:{kind:'recovery-needed',retryable:false,reason:'Unconfirmed.'}});store.close();
  for(const round of [1,2]){
    await service.invoke('chat.send',{id:chat.id,text:`round ${round}`,requestId:`round-${round}`});
    await until(()=>gates.has(chat.id));
    gates.get(chat.id)!.resolve({status:'completed',finalMessage:'ok'});gates.delete(chat.id);
    await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)?.status==='completed');
  }
  const notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='folder-unresolved');
  assert.equal(notices.length,1);assert.equal(notices[0]!.data?.chatId,stuck.id);assert.equal(notices[0]!.kind,'notice');
  await service.dispose();
});
