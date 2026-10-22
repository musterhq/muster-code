/** #591: a chat opened from another chat (a new worktree) keeps that chat's model, effort and access. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {DomainFactory} from '../src/runtime/domains/types.ts';

const models=[{id:'fast',name:'Fast'},{id:'deep',name:'Deep',reasoningEfforts:['low','medium','high']}];
async function fixture(t:TestContext,options:{domains?:DomainFactory[]}={}) {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-591-'));
  const state={signedIn:true},runs:{chatId:string;effort?:string}[]=[];
  const provider:ProviderAdapter={
    info:()=>[{id:'alpha',name:'Alpha',available:true,identityMasked:'Hidden',models},{id:'beta',name:'Beta',available:state.signedIn,identityMasked:'Hidden',models}],
    run:async input=>{runs.push({chatId:input.chat.id,effort:input.reasoningEffort});return {status:'completed',finalMessage:'ok'};},stop:async()=>true,dispose(){},
  };
  const service=createAgentService({dataDir,provider,onEvent(){},...(options.domains?{domains:options.domains}:{})});
  t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  const settle=async(id:string)=>{for(let i=0;i<200;i++){const chat=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===id);if(chat?.status!=='running')return;await delay(5);}throw new Error('Run did not settle');};
  return {service,state,settle,runs};
}

test('#591 a worktree chat keeps the parent chat\'s provider, model, effort and access',async t=>{
  const {service,settle,runs}=await fixture(t);
  const parent=await service.invoke('chat.create',{});
  await service.invoke('chat.selectProvider',{id:parent.id,providerId:'beta',model:'deep'});
  await service.invoke('chat.setPermissionMode',{id:parent.id,permissionMode:'full',acknowledgeFullAccess:true});
  await service.invoke('chat.send',{id:parent.id,text:'hi',requestId:randomUUID(),effort:'high'});await settle(parent.id);
  const child=await service.invoke('chat.create',{inheritFrom:parent.id});
  assert.equal(child.providerId,'beta');assert.equal(child.model,'deep');assert.equal(child.permissionMode,'full');
  await service.invoke('chat.send',{id:child.id,text:'go',requestId:randomUUID()});await settle(child.id);
  assert.equal(runs.find(run=>run.chatId===child.id)?.effort,'high','the parent\'s reasoning effort carries over');
  const plain=await service.invoke('chat.create',{});
  assert.notEqual(plain.permissionMode,'full','a chat without a parent never starts with Full access');
});

test('#591 inheritance never raises access above the parent\'s',async t=>{
  // A defaults resolver that asks for Full access is ignored; only a chat where the user confirmed it passes it on.
  const domain:DomainFactory=context=>{context.hooks.setChatDefaults(()=>({permissionMode:'full'}));return {handlers:{}};};
  const {service}=await fixture(t,{domains:[domain]});
  const fromDefaults=await service.invoke('chat.create',{});
  assert.notEqual(fromDefaults.permissionMode,'full');
  const parent=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:parent.id,permissionMode:'read-only'});
  const child=await service.invoke('chat.create',{inheritFrom:parent.id});
  assert.equal(child.permissionMode,'read-only');
});

test('#591 inheritFrom must be a well-formed id; an unknown chat inherits nothing',async t=>{
  const {service}=await fixture(t);
  for(const bad of ['../x','',{},42,'a'.repeat(200)])await assert.rejects(service.invoke('chat.create',{inheritFrom:bad as string}),/Invalid id|id/);
  for(const missing of ['__proto__','constructor','no-such-chat']){
    const chat=await service.invoke('chat.create',{inheritFrom:missing});
    assert.equal(chat.providerId,'alpha');assert.notEqual(chat.permissionMode,'full');
  }
});

test('#591 a parent whose provider is unavailable passes on its access, not its model',async t=>{
  const {service,state}=await fixture(t);
  const parent=await service.invoke('chat.create',{});
  await service.invoke('chat.selectProvider',{id:parent.id,providerId:'beta',model:'deep'});
  await service.invoke('chat.setPermissionMode',{id:parent.id,permissionMode:'read-only'});
  state.signedIn=false;
  const child=await service.invoke('chat.create',{inheritFrom:parent.id});
  assert.equal(child.providerId,'alpha','a runnable provider instead of the signed-out one');
  assert.equal(child.permissionMode,'read-only');
});
