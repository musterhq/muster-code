import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {providerAccessPolicy} from '../src/runtime/provider-run-lifecycle.ts';
import type {ProviderAdapter, ProviderInput} from '../src/runtime/provider.ts';

const info: ProviderAdapter['info'] = () => [{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}];
const completed = {status:'completed' as const,finalMessage:'done'};
const flush = () => new Promise<void>(resolve=>setImmediate(resolve));

test('access maps to real sandbox/approval values and Ask/Plan always remain read-only', () => {
  assert.deepEqual(providerAccessPolicy({mode:'agent'}),{permissionMode:'workspace',sandbox:'workspace-write',approvalPolicy:'on-request',networkAccess:false});
  assert.deepEqual(providerAccessPolicy({mode:'agent',permissionMode:'full'}),{permissionMode:'full',sandbox:'danger-full-access',approvalPolicy:'never',networkAccess:true});
  for (const mode of ['agent','ask','plan'] as const) {
    const policy=providerAccessPolicy({mode,permissionMode:mode==='agent'?'read-only':'full'});
    assert.equal(policy.sandbox,'read-only'); assert.equal(policy.approvalPolicy,'never'); assert.equal(policy.networkAccess,false);
  }
  assert.throws(()=>providerAccessPolicy({mode:'agent',permissionMode:'invalid' as never}),/Invalid/);
});

test('explicit access selection persists across restart, controls real sends, and preserves drafts on invalid choices', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-access-'));
  const calls: ProviderInput['chat'][]=[];
  const provider: ProviderAdapter={info,run:async input=>{calls.push(input.chat);return completed;},stop:async()=>true,dispose(){}};
  let service=createAgentService({dataDir,provider,onEvent(){}});
  try {
    const chat=await service.invoke('chat.create',{});
    await service.invoke('chat.update',{id:chat.id,draft:'keep this draft'});
    assert.equal(chat.permissionMode,undefined);
    for (const permissionMode of ['invalid',null,7]) await assert.rejects(service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode} as never),/Invalid access/);
    await assert.rejects(service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full'}),/Confirm unrestricted/);
    await assert.rejects(service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:'yes'} as never),/Invalid full-access/);
    let current=(await service.invoke('app.snapshot',undefined)).chats[0]!;
    assert.equal(current.permissionMode,undefined); assert.equal(current.draft,'keep this draft');
    current=await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
    assert.equal(current.permissionMode,'full');
    await service.invoke('chat.send',{id:chat.id,text:'full run',requestId:randomUUID()}); await flush();
    assert.equal(providerAccessPolicy(calls[0]!).sandbox,'danger-full-access');
    await service.invoke('chat.update',{id:chat.id,mode:'plan'});
    await service.invoke('chat.send',{id:chat.id,text:'plan only',requestId:randomUUID()}); await flush();
    assert.equal(calls[1]!.permissionMode,'full'); assert.equal(providerAccessPolicy(calls[1]!).sandbox,'read-only');
    await service.dispose();
    service=createAgentService({dataDir,provider,onEvent(){}});
    current=(await service.invoke('app.snapshot',undefined)).chats[0]!;
    assert.equal(current.permissionMode,'full'); assert.equal(current.mode,'plan');
    assert.equal(providerAccessPolicy(current).sandbox,'read-only');
    await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.permissionMode,'workspace');
  } finally {await service.dispose();await rm(dataDir,{recursive:true,force:true});}
});

test('access changes are rejected during a run; read-only Agent declines expansion requests', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-access-running-'));
  let release!:()=>void; const held=new Promise<void>(resolve=>{release=resolve;});
  let approval: unknown='not requested';
  const provider: ProviderAdapter={info,run:async input=>{
    approval=await input.onRequest('item/commandExecution/requestApproval',{command:'mutating operation'});
    await held; return completed;
  },stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  try {
    const chat=await service.invoke('chat.create',{});
    await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'read-only'});
    await service.invoke('chat.send',{id:chat.id,text:'inspect',requestId:randomUUID()});
    await assert.rejects(service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true}),/Stop this run/);
    assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.permissionMode,'read-only');
    assert.equal(approval,undefined);
    assert.equal((await service.invoke('chat.select',{id:chat.id})).some(item=>item.kind==='approval'),false);
  } finally {release();await service.dispose();await rm(dataDir,{recursive:true,force:true});}
});

test('legacy stores migrate without silently granting Full access', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-access-migrate-'));
  let store=new AgentStore(dataDir);
  try {
    const chat=store.createChat({model:'test',mode:'agent'}); store.close();
    const old=new DatabaseSync(join(dataDir,'muster-agent.sqlite')); old.exec('ALTER TABLE chats DROP COLUMN permission_mode'); old.close();
    store=new AgentStore(dataDir);
    assert.equal(store.chat(chat.id)!.permissionMode,undefined);
    assert.equal(providerAccessPolicy(store.chat(chat.id)!).sandbox,'workspace-write');
  } finally {store.close();await rm(dataDir,{recursive:true,force:true});}
});

test('a policy changed during asynchronous send preflight governs the accepted turn', async () => {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-access-preflight-'));
  let dispatched: ProviderInput['chat'] | undefined;
  const provider: ProviderAdapter={info,run:async input=>{dispatched=input.chat;return completed;},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  try {
    const chat=await service.invoke('chat.create',{});
    await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
    const send=service.invoke('chat.send',{id:chat.id,text:'inspect now',requestId:randomUUID()});
    await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'read-only'});
    await send; await flush();
    assert.equal(dispatched?.permissionMode,'read-only');
    assert.equal(providerAccessPolicy(dispatched!).sandbox,'read-only');
  } finally {await service.dispose();await rm(dataDir,{recursive:true,force:true});}
});
