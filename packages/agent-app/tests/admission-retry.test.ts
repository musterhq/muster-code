import assert from 'node:assert/strict';
import {test,mock,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderResult} from '../src/runtime/provider.ts';
import {ADMISSION_RETRY_MAX,admissionRetryDelay,admissionRetryText,isSafeAdmissionRejection,withAdmissionRetry} from '../src/runtime/admission-retry.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
const rejected=(retryAfterMs?:number):ProviderResult=>({status:'failed',finalMessage:'',dispatchState:'not-dispatched',errorMessage:'503',recovery:{kind:'admission-rejected',retryable:true,reason:'Provider admission is temporarily unavailable.'},...(retryAfterMs?{failure:{kind:'rpc-rejected',statusCode:503,retryAfterMs}}:{})});
const flush=async(rounds=20)=>{for(let i=0;i<rounds;i++)await new Promise(resolve=>setImmediate(resolve));};
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-admission-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('schedule: 5/10/20/40/60s with ±20% jitter; Retry-After wins and is bounded',()=>{
  assert.deepEqual([1,2,3,4,5].map(n=>admissionRetryDelay(n,undefined,()=>0.5)),[5000,10000,20000,40000,60000]);
  assert.equal(admissionRetryDelay(1,undefined,()=>0),4000);assert.equal(admissionRetryDelay(1,undefined,()=>1),6000);
  assert.equal(admissionRetryDelay(5,undefined,()=>1),72000);
  assert.equal(admissionRetryDelay(2,3000),3000);assert.equal(admissionRetryDelay(2,10),1000);assert.equal(admissionRetryDelay(2,3_600_000),300_000);
  assert.equal(admissionRetryText({attempt:2,max:5,delayMs:9600}),'Provider at capacity. Retrying in 10s (attempt 2/5)');
  assert.equal(isSafeAdmissionRejection(rejected()),true);
  assert.equal(isSafeAdmissionRejection({...rejected(),dispatchState:'unknown'}),false);
  assert.equal(isSafeAdmissionRejection({...rejected(),turnId:'turn'}),false);
  assert.equal(isSafeAdmissionRejection({recovery:{kind:'failed'},dispatchState:'not-dispatched'}),false);
});

test('withAdmissionRetry waits on the timer, stops at five retries, and cancels on abort',async t=>{
  mock.timers.enable({apis:['setTimeout','Date'],now:0});t.after(()=>mock.timers.reset());
  let calls=0;const waits:number[]=[];
  const done=withAdmissionRetry(async()=>{calls++;return calls<3?rejected():{status:'completed' as const,finalMessage:''};},{signal:new AbortController().signal,random:()=>0.5,onWait:wait=>waits.push(wait.delayMs)});
  await flush();assert.equal(calls,1);
  mock.timers.tick(4999);await flush();assert.equal(calls,1);
  mock.timers.tick(1);await flush();assert.equal(calls,2);
  mock.timers.tick(10000);await flush();
  const outcome=await done;assert.equal(calls,3);assert.equal(outcome.retries,2);assert.equal(outcome.cancelled,false);assert.deepEqual(waits,[5000,10000]);

  let always=0;const exhausted=withAdmissionRetry(async()=>{always++;return rejected(1000);},{signal:new AbortController().signal,onWait(){}});
  for(let i=0;i<ADMISSION_RETRY_MAX;i++){await flush();mock.timers.tick(1000);}
  const last=await exhausted;assert.equal(always,ADMISSION_RETRY_MAX+1);assert.equal(last.retries,ADMISSION_RETRY_MAX);assert.equal(last.result.recovery?.kind,'admission-rejected');

  const controller=new AbortController();let once=0;
  const cancelled=withAdmissionRetry(async()=>{once++;return rejected();},{signal:controller.signal,onWait(){}});
  await flush();controller.abort();
  const stopped=await cancelled;assert.equal(once,1);assert.equal(stopped.cancelled,true);
});

test('service retries a not-dispatched 503 with one in-place notice, then completes',async t=>{
  const dataDir=await directory(t);
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-09-23T00:00:00Z')});t.after(()=>mock.timers.reset());
  let calls=0;
  const provider:ProviderAdapter={info,run:async()=>{calls++;return calls<3?rejected(2000):{status:'completed',finalMessage:'answer'};},stop:async()=>false,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'hello'});
  await flush();assert.equal(calls,1);
  let notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='admission-retry');
  assert.equal(notices.length,1);assert.equal(notices[0]!.text,'Provider at capacity. Retrying in 2s (attempt 1/5)');assert.equal(notices[0]!.status,'running');
  assert.equal(notices[0]!.data?.retryAt,'2026-09-23T00:00:02.000Z');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.status,'running');
  mock.timers.tick(2000);await flush();assert.equal(calls,2);
  notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='admission-retry');
  assert.equal(notices.length,1);assert.equal(notices[0]!.data?.attempt,2);
  mock.timers.tick(2000);await flush();assert.equal(calls,3);
  const final=(await service.invoke('app.snapshot',undefined)).chats[0]!;
  assert.equal(final.status,'completed');assert.equal(final.recovery,undefined);
  const items=(await service.invoke('chat.timeline',{id:chat.id})).items;
  const notice=items.find(item=>item.data?.kind==='admission-retry')!;
  assert.equal(notice.status,'completed');assert.equal(notice.text,'Provider at capacity. Sent after 2 retries.');
  assert.equal(items.filter(item=>item.kind==='user').length,1);
  mock.timers.tick(100);await service.dispose();
});

test('chat.stop cancels a pending retry; exhausted retries keep the admission recovery',async t=>{
  const dataDir=await directory(t);
  mock.timers.enable({apis:['setTimeout','Date'],now:0});t.after(()=>mock.timers.reset());
  let calls=0;
  const provider:ProviderAdapter={info,run:async()=>{calls++;return rejected(1000);},stop:async()=>false,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const stopped=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:stopped.id,text:'stop me',requestId:'stop-me'});await flush();
  await service.invoke('chat.stop',{id:stopped.id});await flush();
  mock.timers.tick(5000);await flush();
  assert.equal(calls,1);
  let chat=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===stopped.id)!;
  assert.equal(chat.status,'interrupted');assert.equal(chat.recovery?.kind,'cancelled');assert.equal(chat.draft,'stop me');
  assert.equal((await service.invoke('chat.timeline',{id:stopped.id})).items.find(item=>item.data?.kind==='admission-retry')?.status,'cancelled');

  calls=0;const exhausted=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:exhausted.id,text:'keep trying',requestId:'keep'});
  for(let i=0;i<ADMISSION_RETRY_MAX;i++){await flush();mock.timers.tick(1000);}
  await flush();
  assert.equal(calls,ADMISSION_RETRY_MAX+1);
  chat=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===exhausted.id)!;
  assert.equal(chat.status,'failed');assert.equal(chat.recovery?.kind,'admission-rejected');assert.match(chat.recovery!.reason,/after 5 automatic retries/);assert.equal(chat.draft,'keep trying');
  assert.equal((await service.invoke('chat.timeline',{id:exhausted.id})).items.find(item=>item.data?.kind==='admission-retry')?.status,'failed');
  mock.timers.tick(100);await service.dispose();
});
