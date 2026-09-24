import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[
  {id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',bindingId:'gateway',models:[{id:'claude/claude-fable-5',name:'Fable'},{id:'codex/gpt-5.6-terra',name:'Terra'}]},
  {id:'openai-direct',name:'OpenAI Direct',available:true,identityMasked:'Hidden',bindingId:'direct',models:[{id:'gpt-5.6-terra',name:'Terra'}]},
];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-midrun-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>){for(let i=0;i<500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail('condition not reached');}

test('access and model change mid-run apply to the next (queued) turn and never mutate the live one',async t=>{
  const dataDir=await directory(t);
  const inputs:ProviderInput[]=[],approvals:unknown[]=[];let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);gate=Promise.withResolvers();
    if(inputs.length===1)approvals.push(await input.onRequest('item/commandExecution/requestApproval',{command:'rm -rf build'}));
    return gate.promise;},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'read-only'});
  await service.invoke('chat.send',{id:chat.id,text:'inspect',requestId:'first'});
  await until(()=>Boolean(gate)&&approvals.length===1);
  // The live read-only turn declines expansion without prompting, even after access changes.
  assert.equal(approvals[0],undefined);
  await assert.rejects(service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full'}),/Confirm unrestricted/,'Full access still needs the acknowledgement');
  assert.equal((await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true})).permissionMode,'full');
  assert.equal((await service.invoke('chat.selectProvider',{id:chat.id,providerId:'hybrow',model:'codex/gpt-5.6-terra'})).model,'codex/gpt-5.6-terra','same-account model switch is accepted mid-run');
  await assert.rejects(service.invoke('chat.selectProvider',{id:chat.id,providerId:'openai-direct',model:'gpt-5.6-terra'}),/Wait/,'switching provider accounts still waits for the run');
  assert.equal(inputs[0]!.chat.permissionMode,'read-only');assert.equal(inputs[0]!.chat.model,'claude/claude-fable-5');
  await service.invoke('chat.queue.add',{id:chat.id,text:'now edit',requestId:'second'});
  gate!.resolve({status:'completed',finalMessage:'done'});
  await until(()=>inputs.length===2);
  assert.equal(inputs[1]!.chat.permissionMode,'full','the next turn runs with the new access');
  assert.equal(inputs[1]!.chat.model,'codex/gpt-5.6-terra','and the new model');
  assert.equal(inputs[0]!.chat.permissionMode,'read-only','the settled turn input was never mutated');
  gate!.resolve({status:'completed',finalMessage:'done'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
});

test('a new chat adopts the Project folder; one with messages keeps its folder, which joins the Project',async t=>{
  const dataDir=await directory(t),folder=await directory(t);
  const provider:ProviderAdapter={info,run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const added=await service.invoke('folder.add',{path:folder});
  const project=await service.invoke('project.create',{name:'Launch',goal:'Ship it',folderIds:[added.id]});
  const chat=await service.invoke('chat.create',{});
  const moved=await service.invoke('chat.update',{id:chat.id,projectId:project.id});
  assert.equal(moved.projectId,project.id);assert.equal(moved.folderId,added.id,'the chat adopts the Project folder');
  await assert.rejects(service.invoke('chat.update',{id:chat.id,projectId:'missing'}),/Project not found/);
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'hello'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  const out=await service.invoke('chat.update',{id:chat.id,projectId:null});
  assert.equal(out.projectId,undefined);assert.equal(out.folderId,added.id,'history keeps its folder');
  const other=await directory(t),second=await service.invoke('folder.add',{path:other});
  const chat2=await service.invoke('chat.create',{folderId:second.id});
  await service.invoke('chat.send',{id:chat2.id,text:'hi',requestId:'hi'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.every(c=>c.status==='completed'));
  const into=await service.invoke('chat.update',{id:chat2.id,projectId:project.id});
  assert.equal(into.folderId,second.id,'a chat with history keeps its folder');
  assert.deepEqual((await service.invoke('app.snapshot',undefined)).projects[0]!.folderIds,[added.id,second.id],'and the folder is linked to the Project');
});
