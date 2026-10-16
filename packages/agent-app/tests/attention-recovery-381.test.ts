/** #381: chats are never stuck in recovery, and approvals/questions expire as their own status with a stored deadline. */
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import {ATTENTION_REMINDER_LEAD_MS,ATTENTION_WINDOW_MS,MUTE_GRACE_MS,attentionDeadline,pendingStatusAtRead} from '../src/shared/attention-expiry.ts';
import {createAttentionTracker,DEFAULT_NOTIFICATION_PREFS} from '../src/main/chat-notifications.ts';
import type {PendingAttentionSummary} from '../src/shared/attention-protocol.ts';

const MODEL='fixture-model';
const adapter=(run:ProviderAdapter['run']):ProviderAdapter=>({info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}],run,stop:async()=>true,dispose(){}});
async function until(check:()=>Promise<boolean>|boolean) {for(let i=0;i<200;i++){if(await check())return;await delay(3);}throw Error('Expected state did not arrive');}
async function fixture(t:import('node:test').TestContext,run:ProviderAdapter['run'],dataDir?:string) {
 const dir=dataDir??await mkdtemp(join(tmpdir(),'muster-381-'));
 const service=createAgentService({dataDir:dir,provider:adapter(run),onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});});
 return {service,dataDir:dir};
}
const timelineOf=async(service:ReturnType<typeof createAgentService>,id:string)=>(await service.invoke('chat.timeline',{id})).items;

test('deadline: 2h window, extended to the end of a longer mute; read-time status shares one rule',()=>{
 const now=1_000_000;
 assert.equal(ATTENTION_WINDOW_MS,2*60*60_000);
 assert.equal(attentionDeadline(now,null),now+ATTENTION_WINDOW_MS);
 assert.equal(attentionDeadline(now,now+60_000),now+ATTENTION_WINDOW_MS,'a short mute changes nothing');
 const muted=now+5*60*60_000;
 assert.equal(attentionDeadline(now,muted),muted+MUTE_GRACE_MS);
 const past=new Date(now-1).toISOString(),future=new Date(now+1000).toISOString();
 assert.deepEqual(pendingStatusAtRead({status:'pending',data:{expiresAt:past}},now,true),{status:'expired',reason:'timeout'});
 assert.deepEqual(pendingStatusAtRead({status:'pending',data:{expiresAt:future}},now,true),{status:'pending'});
 assert.deepEqual(pendingStatusAtRead({status:'pending',data:{expiresAt:future}},now,false),{status:'unavailable',reason:'restart'});
 assert.deepEqual(pendingStatusAtRead({status:'pending'},now,false),{status:'unavailable',reason:'restart'});
 assert.deepEqual(pendingStatusAtRead({status:'approved',data:{expiresAt:past}},now,true),{status:'approved'});
});

test('an orphan on a route that runs inside Muster is plainly interrupted; a provider-side orphan still needs a check',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-381-store-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const store=new AgentStore(dir);
 const local=store.createChat({model:MODEL,mode:'agent'}),remote=store.createChat({model:MODEL,mode:'agent'});
 store.updateChat(local.id,{providerId:'claude-code',status:'running'});store.updateChat(remote.id,{providerId:'hybrow',status:'running'});
 store.recoverOrphanedRuns(chat=>chat.providerId==='claude-code');
 assert.equal(store.chat(local.id)?.status,'interrupted');assert.equal(store.chat(local.id)?.recovery,undefined);
 assert.match(store.chat(local.id)?.error??'',/Nothing is still running/);
 assert.equal(store.chat(remote.id)?.recovery?.kind,'recovery-needed');
 store.recordSend(local.id,'again-local','hello');// no longer blocked
 assert.throws(()=>store.recordSend(remote.id,'again-remote','hello'),/status checked/);
 store.close();
});

test('service restart: claude-code orphan is not blocked at all',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-381-restart-'));
 const store=new AgentStore(dir),chat=store.createChat({model:MODEL,mode:'agent'});
 store.updateChat(chat.id,{providerId:'claude-code',status:'running'});store.close();
 const {service}=await fixture(t,async()=>({status:'completed',finalMessage:'ok'}),dir);
 const restored=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)!;
 assert.equal(restored.status,'interrupted');assert.equal(restored.recovery,undefined);
});

test('Continue anyway clears an unresolvable recovery block, never while running, and the chat can send again',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-381-continue-'));
 const store=new AgentStore(dir),chat=store.createChat({model:MODEL,mode:'agent'});
 store.updateChat(chat.id,{providerId:'hybrow',status:'running',providerThreadId:'t'});store.close();
 let ran=0;
 const {service}=await fixture(t,async()=>{ran++;return {status:'completed',finalMessage:'ok'};},dir);
 assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.recovery?.kind,'recovery-needed');
 await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'hi',requestId:randomUUID()}),/provider|status/i);
 const updated=await service.invoke('chat.continueAnyway',{id:chat.id});
 assert.equal(updated.recovery,undefined);assert.equal(updated.status,'interrupted');
 assert.ok((await timelineOf(service,chat.id)).some(i=>i.data?.kind==='continue-anyway'));
 await service.invoke('chat.send',{id:chat.id,text:'hi',requestId:randomUUID()});
 await until(()=>ran===1);
});

test('an unanswered approval expires as its own status with a stored deadline, the provider is declined, and Ask again re-asks',async t=>{
 const sent:string[]=[];let decision:unknown,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const {service}=await fixture(t,async input=>{
  if(sent.length===0&&!decision){sent.push(input.prompt);decision=await input.onRequest('item/commandExecution/requestApproval',{command:'rm -rf build'});await gate;return{status:'completed',finalMessage:'done'};}
  sent.push(input.prompt);return{status:'completed',finalMessage:'asked again'};
 });
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 t.mock.timers.enable({apis:['setTimeout']});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 const expiresAt=Date.parse(String(card.data?.expiresAt));
 assert.ok(Math.abs(expiresAt-(Date.now()+ATTENTION_WINDOW_MS))<60_000,'deadline stored on the item');
 const attention=(await service.invoke('app.snapshot',undefined)).attention!.chats[0]!.requests[0]!;
 assert.equal(attention.expiresAt,card.data?.expiresAt);
 t.mock.timers.tick(ATTENTION_WINDOW_MS);
 await until(async()=>(await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.status==='expired');
 t.mock.timers.reset();
 assert.deepEqual(decision,{decision:'decline'},'protocol only has accept/decline');
 const after=await timelineOf(service,chat.id);
 assert.equal(after.find(i=>i.id===card.id)?.data?.expiredReason,'timeout');
 assert.ok(after.some(i=>i.data?.kind==='attention-expired'));
 await assert.rejects(service.invoke('approval.respond',{id:card.id,approved:true}),/no longer pending/);
 await assert.rejects(service.invoke('approval.reask',{id:card.id}),/Wait for the agent/,'still running');
 release();
 await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.status!=='running');
 await service.invoke('approval.reask',{id:card.id});
 await until(()=>sent.length===2);
 assert.match(sent[1]!,/timed out/);assert.match(sent[1]!,/ask again/i);assert.match(sent[1]!,/rm -rf build/);
 await assert.rejects(service.invoke('approval.reask',{id:card.id}),/already asked/);
 assert.ok((await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.data?.reaskedAt);
});

test('approving after the stored deadline is refused and recorded as expired, not as consent',async t=>{
 let decision:unknown;
 const {service}=await fixture(t,async input=>{decision=await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 const realNow=Date.now;Date.now=()=>realNow()+ATTENTION_WINDOW_MS+1000;
 try { await assert.rejects(service.invoke('approval.respond',{id:card.id,approved:true}),/timed out/); } finally { Date.now=realNow; }
 await until(()=>decision!==undefined);
 assert.deepEqual(decision,{decision:'decline'});
 assert.equal((await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.status,'expired');
});

test('stopping a run declines its open approval, so a late click cannot approve it',async t=>{
 let decision:unknown;
 const {service}=await fixture(t,async input=>{decision=await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});await delay(30);return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 // The run ends before the click lands.
 await service.invoke('chat.stop',{id:chat.id});
 await assert.rejects(service.invoke('approval.respond',{id:card.id,approved:true}),/no longer pending/);
 assert.deepEqual(decision,{decision:'decline'});
});

test('a mute window longer than the default pushes the stored deadline past the end of the mute',async t=>{
 const {service}=await fixture(t,async input=>{await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});return{status:'completed',finalMessage:'done'};});
 const mutedUntil=Date.now()+5*60*60_000;
 await service.invoke('settings.set',{key:'notifications.mutedUntil',value:new Date(mutedUntil).toISOString()});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 assert.ok(Date.parse(String(card.data?.expiresAt))>=mutedUntil+MUTE_GRACE_MS-1000);
 await service.invoke('chat.stop',{id:chat.id});
});

test('Full access never raises an approval card',async t=>{
 let decision:unknown;
 const {service}=await fixture(t,async input=>{decision=await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(()=>decision!==undefined);
 assert.deepEqual(decision,{decision:'accept'});
 assert.equal((await timelineOf(service,chat.id)).some(i=>i.kind==='approval'),false);
});

test('after a restart an open request becomes expired (past deadline) or unavailable, and both can be asked again',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'muster-381-rq-'));
 const store=new AgentStore(dir),chat=store.createChat({model:MODEL,mode:'agent'});
 store.updateChat(chat.id,{providerId:'hybrow'});
 const old=store.appendItem(chat.id,'approval','old','pending',{method:'item/commandExecution/requestApproval',kind:'command',expiresAt:new Date(Date.now()-1000).toISOString()});
 const fresh=store.appendItem(chat.id,'question','fresh','pending',{method:'item/tool/requestUserInput',questions:[],expiresAt:new Date(Date.now()+3_600_000).toISOString()});
 store.close();
 const prompts:string[]=[];
 const {service}=await fixture(t,async input=>{prompts.push(input.prompt);return{status:'completed',finalMessage:'ok'};},dir);
 await delay(60);
 const items=await timelineOf(service,chat.id);
 assert.equal(items.find(i=>i.id===old.id)?.status,'expired');assert.equal(items.find(i=>i.id===old.id)?.data?.expiredReason,'timeout');
 assert.equal(items.find(i=>i.id===fresh.id)?.status,'unavailable');assert.equal(items.find(i=>i.id===fresh.id)?.data?.expiredReason,'restart');
 await service.invoke('approval.reask',{id:fresh.id});
 await until(()=>prompts.length===1);assert.match(prompts[0]!,/ask(ed)? .*again|Please ask again/i);
});

test('attention tracker: one toast when raised, one reminder shortly before expiry, silent when muted or watching',()=>{
 const now=Date.parse('2026-10-16T10:00:00Z');
 const summary=(expiresInMs:number,kind:'approval'|'question'='approval'):PendingAttentionSummary=>({totalRequests:1,chats:[{chatId:'c1',chatTitle:'Fix build',approvalCount:kind==='approval'?1:0,questionCount:kind==='question'?1:0,requests:[{itemId:'i1',kind,createdAt:new Date(now).toISOString(),expiresAt:new Date(now+expiresInMs).toISOString(),sourceLabel:kind==='approval'?'Provider approval':'Provider question'}]}]});
 const track=createAttentionTracker(),prefs=DEFAULT_NOTIFICATION_PREFS;
 const first=track(summary(ATTENTION_WINDOW_MS),now,prefs,null);
 assert.deepEqual(first.map(n=>[n.title,n.body,n.reminder]),[['Fix build','Waiting for your approval',false]]);
 assert.equal(track(summary(ATTENTION_WINDOW_MS),now+1000,prefs,null).length,0,'not announced twice');
 const reminder=track(summary(ATTENTION_REMINDER_LEAD_MS-1000),now+2000,prefs,null);
 assert.equal(reminder.length,1);assert.equal(reminder[0]!.reminder,true);assert.match(reminder[0]!.body,/closes in/);
 assert.equal(track(summary(ATTENTION_REMINDER_LEAD_MS-1000),now+3000,prefs,null).length,0,'one reminder only');
 const muted={...prefs,'notifications.mutedUntil':new Date(now+3_600_000).toISOString()};
 assert.equal(createAttentionTracker()(summary(ATTENTION_WINDOW_MS),now,muted,null).length,0,'muted');
 assert.equal(createAttentionTracker()(summary(ATTENTION_WINDOW_MS),now,{...prefs,'notifications.attention':false},null).length,0,'attention alerts off');
 assert.equal(createAttentionTracker()(summary(ATTENTION_WINDOW_MS),now,prefs,'c1').length,0,'already looking at that chat');
 assert.equal(createAttentionTracker()(summary(ATTENTION_WINDOW_MS,'question'),now,prefs,null)[0]!.body,'Has a question for you');
});

test('approving is refused when the step it was for has already finished',async t=>{
 let decision:unknown,release!:()=>void;const gate=new Promise<void>(r=>{release=r;});
 const {service}=await fixture(t,async input=>{
  input.onEvent('item/started',{item:{type:'commandExecution',id:'tool-1',command:'ls',status:'inProgress'}});
  const asked=input.onRequest('item/commandExecution/requestApproval',{command:'ls',itemId:'tool-1'}).then(d=>{decision=d;});
  await gate;
  input.onEvent('item/completed',{item:{type:'commandExecution',id:'tool-1',command:'ls',status:'completed',aggregatedOutput:'',exitCode:0}});
  await Promise.race([asked,delay(2000)]);
  return{status:'completed',finalMessage:'done'};
 });
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 assert.ok(card.data?.toolItemId,'the card is tied to its tool row');
 release();
 await until(async()=>{const tool=(await timelineOf(service,chat.id)).find(i=>i.id===card.data?.toolItemId);return tool?.status==='completed';});
 await assert.rejects(service.invoke('approval.respond',{id:card.id,approved:true}),/already finished/);
 await until(()=>decision!==undefined);
 assert.deepEqual(decision,{decision:'decline'});
});

test('a stale request closes with a stale marker and can be asked again (once, chat idle)',async t=>{
 let release!:()=>void;const gate=new Promise<void>(r=>{release=r;});const prompts:string[]=[];
 const {service}=await fixture(t,async input=>{
  prompts.push(input.prompt);
  if(prompts.length>1)return{status:'completed',finalMessage:'asked again'};
  input.onEvent('item/started',{item:{type:'commandExecution',id:'tool-1',command:'ls',status:'inProgress'}});
  const asked=input.onRequest('item/commandExecution/requestApproval',{command:'ls',itemId:'tool-1'});
  await gate;
  input.onEvent('item/completed',{item:{type:'commandExecution',id:'tool-1',command:'ls',status:'completed',aggregatedOutput:'',exitCode:0}});
  await Promise.race([asked,delay(2000)]);
  return{status:'completed',finalMessage:'done'};
 });
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 release();
 await until(async()=>(await timelineOf(service,chat.id)).find(i=>i.id===card.data?.toolItemId)?.status==='completed');
 await assert.rejects(service.invoke('approval.respond',{id:card.id,approved:true}),/Ask again/);
 const closed=(await timelineOf(service,chat.id)).find(i=>i.id===card.id)!;
 assert.equal(closed.status,'interrupted');assert.equal(closed.data?.expiredReason,'stale');
 await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.status!=='running');
 await service.invoke('approval.reask',{id:card.id});
 await until(()=>prompts.length===2);
 await assert.rejects(service.invoke('approval.reask',{id:card.id}),/already asked/);
});

test('an interrupted request without the stale marker (a stopped run) cannot be asked again',async t=>{
 const {service}=await fixture(t,async input=>{await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});await delay(30);return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 await service.invoke('chat.stop',{id:chat.id});
 assert.equal((await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.status,'interrupted');
 await assert.rejects(service.invoke('approval.reask',{id:card.id}),/still open or was already answered/);
});

test('attention tracker: a deadline a mute pushed out still gets its reminder; a request raised in a mute is announced after it',()=>{
 const now=Date.parse('2026-10-16T10:00:00Z'),prefs=DEFAULT_NOTIFICATION_PREFS;
 const summary=(expiresAt:number):PendingAttentionSummary=>({totalRequests:1,chats:[{chatId:'c1',chatTitle:'Fix build',approvalCount:1,questionCount:0,requests:[{itemId:'i1',kind:'approval',createdAt:new Date(now).toISOString(),expiresAt:new Date(expiresAt).toISOString(),sourceLabel:'Provider approval'}]}]});
 const mutedPrefs={...prefs,'notifications.mutedUntil':new Date(now+3_600_000).toISOString()};
 const track=createAttentionTracker();
 // Raised and nearly due while muted: nothing shown, nothing consumed.
 assert.equal(track(summary(now+ATTENTION_REMINDER_LEAD_MS-1000),now,mutedPrefs,null).length,0);
 // The mute pushes the deadline out; once it ends the request is announced once...
 const later=now+3_700_000,extended=later+10*60_000;
 assert.deepEqual(track(summary(extended),later,prefs,null).map(n=>n.reminder),[false]);
 // ...and the new deadline's final window still gets exactly one reminder.
 const near=extended-ATTENTION_REMINDER_LEAD_MS+1000;
 assert.deepEqual(track(summary(extended),near,prefs,null).map(n=>n.reminder),[true]);
 assert.equal(track(summary(extended),near+1000,prefs,null).length,0);
 // An already-reminded request whose deadline moves again is reminded for the new deadline.
 const moved=extended+60*60_000;
 assert.equal(track(summary(moved),moved-1000,prefs,null).filter(n=>n.reminder).length,1);
});

test('sweep expires every pending request past its stored deadline (as after a sleep), so cards close before a click',async t=>{
 let decision:unknown;
 const {service}=await fixture(t,async input=>{decision=await input.onRequest('item/commandExecution/requestApproval',{command:'ls'});return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 assert.deepEqual(await service.invoke('attention.sweep',{}),{expired:0},'nothing due yet');
 assert.equal((await service.invoke('app.snapshot',undefined)).attention?.totalRequests,1);
 const realNow=Date.now;Date.now=()=>realNow()+ATTENTION_WINDOW_MS+1000;
 try { assert.deepEqual(await service.invoke('attention.sweep',{}),{expired:1}); } finally { Date.now=realNow; }
 await until(()=>decision!==undefined);
 assert.deepEqual(decision,{decision:'decline'});
 assert.equal((await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.status,'expired');
 assert.ok(!(await service.invoke('app.snapshot',undefined)).attention?.totalRequests,'badge source is empty');
});

test('a late Deny on an expired approval closes quietly; a late Approve still errors',async t=>{
 const decisions:unknown[]=[];
 const {service}=await fixture(t,async input=>{decisions.push(await input.onRequest('item/commandExecution/requestApproval',{command:'ls'}));return{status:'completed',finalMessage:'done'};});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 await until(async()=>(await timelineOf(service,chat.id)).some(i=>i.kind==='approval'));
 const card=(await timelineOf(service,chat.id)).find(i=>i.kind==='approval')!;
 const realNow=Date.now;Date.now=()=>realNow()+ATTENTION_WINDOW_MS+1000;
 try { await service.invoke('approval.respond',{id:card.id,approved:false}); } finally { Date.now=realNow; }
 await until(()=>decisions.length===1);
 assert.deepEqual(decisions[0],{decision:'decline'});
 assert.equal((await timelineOf(service,chat.id)).find(i=>i.id===card.id)?.status,'expired','recorded as expired, not declined');
});
