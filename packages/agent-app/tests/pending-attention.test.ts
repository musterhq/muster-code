import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {MODEL,type ProviderAdapter,type ProviderInput} from '../src/runtime/provider.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';
const payload={itemId:'reused-provider-id',questions:[{id:'secret',question:'PRIVATE QUESTION',isSecret:true,options:[{label:'PRIVATE OPTION'}]}]};
const adapter=(run:ProviderAdapter['run']):ProviderAdapter=>({info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}],run,stop:async()=>true,dispose(){}});
async function fixture(t:import('node:test').TestContext,run:ProviderAdapter['run']) {
 const dataDir=await mkdtemp(join(tmpdir(),'muster-attention-')),events:AgentEvent[]=[];
 const service=createAgentService({dataDir,provider:adapter(run),onEvent:event=>events.push(event)});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 return {service,dataDir,events};
}
async function until(check:()=>Promise<boolean>) {for(let i=0;i<100;i++){if(await check())return;await delay(2);}throw Error('Expected state did not arrive');}

test('inactive task attention groups live requests with exact IDs and no private provider contents',async t=>{
 const {service,events}=await fixture(t,async input=>{await Promise.all([input.onRequest('item/tool/requestUserInput',payload),input.onRequest('item/commandExecution/requestApproval',{command:'PRIVATE COMMAND'})]);return{status:'completed',finalMessage:'done'};});
 const a=await service.invoke('chat.create',{}),b=await service.invoke('chat.create',{});
 await service.invoke('chat.setPermissionMode',{id:a.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:a.id,text:'ask',requestId:randomUUID()});
 await service.invoke('chat.timeline',{id:b.id,select:true});
 const snapshot=await service.invoke('app.snapshot',undefined),attention=snapshot.attention!;
 assert.equal(snapshot.activeChatId,b.id);assert.equal(attention.totalRequests,2);
 assert.equal(attention.chats[0].chatId,a.id);assert.equal(attention.chats[0].approvalCount,1);assert.equal(attention.chats[0].questionCount,1);
 const items=(await service.invoke('chat.timeline',{id:a.id})).items.filter(item=>['approval','question'].includes(item.kind));
 assert.deepEqual(new Set(attention.chats[0].requests.map(r=>r.itemId)),new Set(items.map(i=>i.id)));
 const question=items.find(i=>i.kind==='question')!;
 await service.invoke('question.respond',{id:question.id,answers:{secret:{answers:['PRIVATE ANSWER']}}});
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,1);
 const approval=items.find(i=>i.kind==='approval')!;
 await service.invoke('approval.respond',{id:approval.id,approved:true});
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,0);
 const summaries=events.flatMap(event=>event.type==='snapshot'?[event.snapshot.attention]:[]);
 assert.ok(summaries.some(a=>a?.totalRequests===2));assert.equal(summaries.at(-1)?.totalRequests,0);
 assert.doesNotMatch(JSON.stringify(summaries),/PRIVATE QUESTION|PRIVATE OPTION|PRIVATE COMMAND|PRIVATE ANSWER/);
});

test('late answer cannot consume a replacement request with the same provider identity',async t=>{
 const {service}=await fixture(t,async input=>{await input.onRequest('item/tool/requestUserInput',payload);await input.onRequest('item/tool/requestUserInput',payload);return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.send',{id:chat.id,text:'ask',requestId:randomUUID()});
 const first=(await service.invoke('app.snapshot',undefined)).attention!.chats[0].requests[0].itemId;
 await service.invoke('question.respond',{id:first,answers:{secret:{answers:['one']}}});
 await until(async()=>!!(await service.invoke('app.snapshot',undefined)).attention?.chats[0]);
 const next=(await service.invoke('app.snapshot',undefined)).attention!.chats[0].requests[0].itemId;assert.notEqual(first,next);
 await assert.rejects(service.invoke('question.respond',{id:first,answers:{secret:{answers:['late']}}}),/no longer pending/);
 assert.equal((await service.invoke('app.snapshot',undefined)).attention!.chats[0].requests[0].itemId,next);
 await service.invoke('chat.stop',{id:chat.id});assert.equal((await service.invoke('app.snapshot',undefined)).attention!.totalRequests,0);
 assert.equal((await service.invoke('chat.timeline',{id:chat.id})).items.find(item=>item.id===next)?.status,'interrupted');
});

test('expiration clears both handler kinds and publishes the empty summary',async t=>{
 const {service,events}=await fixture(t,async input=>{await Promise.all([input.onRequest('item/tool/requestUserInput',payload),input.onRequest('item/commandExecution/requestApproval',{command:'fixture'})]);return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 t.mock.timers.enable({apis:['setTimeout']});
 await service.invoke('chat.send',{id:chat.id,text:'ask',requestId:randomUUID()});
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,2);
 t.mock.timers.tick(600_000);
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,0);
 const items=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(i=>i.kind==='approval'||i.kind==='question');
 assert.deepEqual(items.map(i=>i.status),['expired','expired']);
 assert.equal(events.filter(e=>e.type==='snapshot').at(-1)?.snapshot.attention?.totalRequests,0);
 t.mock.timers.reset();
});

test('restart makes orphan approval and question history unavailable, never actionable',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-attention-restart-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
 const store=new AgentStore(dataDir),chat=store.createChat({model:MODEL,mode:'agent'});
 store.appendItem(chat.id,'approval','old command','pending');store.appendItem(chat.id,'question','old question','pending');store.close();
 const service=createAgentService({dataDir,provider:adapter(async()=>{throw Error('Must not dispatch');}),onEvent(){}});
 try{assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,0);
 const items=(await service.invoke('chat.timeline',{id:chat.id})).items;assert.deepEqual(items.map(i=>i.status),['unavailable','unavailable']);
 await assert.rejects(service.invoke('approval.respond',{id:items[0].id,approved:true}),/no longer pending/);
 }finally{await service.dispose();}
});

test('run completion settles unawaited handlers and refuses later callbacks',async t=>{
 let captured:ProviderInput|undefined;
 const {service}=await fixture(t,async input=>{captured=input;void input.onRequest('item/tool/requestUserInput',payload);return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.send',{id:chat.id,text:'ask',requestId:randomUUID()});
 await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0].status==='completed');
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,0);
 assert.equal(await captured!.onRequest('item/tool/requestUserInput',payload),undefined);
 assert.equal((await service.invoke('chat.timeline',{id:chat.id})).items.filter(i=>i.kind==='question').length,1);
});

test('stop clears approvals and questions before returning and rejects new callbacks from the stopped run',async t=>{
 let late:unknown='not-called';
 const {service,events}=await fixture(t,async input=>{
   await Promise.all([input.onRequest('item/tool/requestUserInput',payload),input.onRequest('item/commandExecution/requestApproval',{command:'fixture'})]);
   late=await input.onRequest('item/tool/requestUserInput',payload);
   return{status:'completed',finalMessage:'done'};
 });
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'ask',requestId:randomUUID()});
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,2);
 await service.invoke('chat.stop',{id:chat.id});
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,0);
 await until(async()=>late!=='not-called');assert.equal(late,undefined);
 const items=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(i=>i.kind==='approval'||i.kind==='question');
 assert.deepEqual(items.map(i=>i.status),['interrupted','interrupted']);
 assert.equal(events.filter(e=>e.type==='snapshot').at(-1)?.snapshot.attention?.totalRequests,0);
});
