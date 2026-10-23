import assert from 'node:assert/strict';
import {test,mock,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type ProviderAdapter,type ProviderResult} from '../src/runtime/provider.ts';
import {ADMISSION_RETRY_MAX,RETRY_AFTER_CAP_MS,admissionRetryDelay,admissionRetryText,asSentence,isSafeAdmissionRejection,withAdmissionRetry} from '../src/runtime/admission-retry.ts';
import {retryAfterMs} from '../src/runtime/adapters/shared.ts';

import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
const rejected=(retryAfterMs?:number):ProviderResult=>({status:'failed',finalMessage:'',dispatchState:'not-dispatched',errorMessage:'503',recovery:{kind:'admission-rejected',retryable:true,reason:'Provider admission is temporarily unavailable.'},...(retryAfterMs?{failure:{kind:'rpc-rejected',statusCode:503,retryAfterMs}}:{})});
const flush=async(rounds=20)=>{for(let i=0;i<rounds;i++)await new Promise(resolve=>setImmediate(resolve));};
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-admission-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('schedule: 5/10/20/40/60s with ±20% jitter; Retry-After wins without shortening the requested wait',()=>{
  assert.deepEqual([1,2,3,4,5].map(n=>admissionRetryDelay(n,undefined,()=>0.5)),[5000,10000,20000,40000,60000]);
  assert.equal(admissionRetryDelay(1,undefined,()=>0),4000);assert.equal(admissionRetryDelay(1,undefined,()=>1),6000);
  assert.equal(admissionRetryDelay(5,undefined,()=>1),72000);
  assert.equal(admissionRetryDelay(2,3000),3000);assert.equal(admissionRetryDelay(2,10),1000);assert.equal(admissionRetryDelay(2,3_600_000),3_600_000);
  assert.equal(admissionRetryText({attempt:2,max:5,delayMs:9600}),'The provider is temporarily unavailable. Retrying in 10s (attempt 2/5)');
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
  assert.equal(notices.length,1);assert.equal(notices[0]!.text,'The provider is temporarily unavailable. Retrying in 2s (attempt 1/5)');assert.equal(notices[0]!.status,'running');
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
  assert.equal(notice.status,'completed');assert.equal(notice.text,'The provider is temporarily unavailable. Sent after 2 retries.');
  assert.equal(items.filter(item=>item.kind==='user').length,1);
  mock.timers.tick(100);await service.dispose();
});

// Spec: MUS-SPEC-02-479N (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-479n)
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
  assert.equal(chat.status,'failed');assert.equal(chat.recovery?.kind,'admission-rejected');assert.match(chat.recovery!.reason,/after 5 automatic retries/);
  // #448: still unavailable after the in-run retries, the chat waits as rate-limited and re-runs this prompt itself, so it is not also handed back as a draft.
  assert.equal(chat.draft,'');assert.equal(chat.autoResume?.reason,'rate');assert.equal(chat.autoResume?.resume,true);
  assert.equal((await service.invoke('chat.timeline',{id:exhausted.id})).items.find(item=>item.data?.kind==='admission-retry')?.status,'failed');
  mock.timers.tick(100);await service.dispose();
});


test('HTTP 429 honours each Retry-After through the service and keeps final composer copy truthful',async t=>{
  const dataDir=await directory(t);
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-18T00:00:00Z')});t.after(()=>mock.timers.reset());
  const sentAt:number[]=[];
  const delays=[30_000,45_000,RETRY_AFTER_CAP_MS,30_000,30_000];
  const adapter=openAICompatibleAdapter({endpoint:'https://fixture.example/v1',apiKey:()=>undefined,label:'Fixture',tools:false,fetch:async()=>{
    sentAt.push(Date.now());
    const delay=delays[sentAt.length-1]??30_000;
    // Cover both header formats and a wait at the cap.
    const retryAfter=sentAt.length===2?new Date(Date.now()+delay).toUTCString():String(delay/1000);
    return new Response(JSON.stringify({error:{message:'Rate limit reached for mock-model. Please try again later.'}}),{status:429,headers:{'retry-after':retryAfter}});
  }});
  const provider=createProviderAdapter({instances:()=>[{info:info()[0]!,command:'',env:{},sessionsRoot:'',adapter}]});
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'rate-limit'});
  for(let i=0;i<delays.length;i++){
    await flush();assert.equal(sentAt.length,i+1);
    const notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='admission-retry');
    assert.equal(notices.length,1);
    const notice=notices[0]!;
    assert.match(notice.text,/Rate limited by Fixture \(429\): Rate limit reached for mock-model/);
    assert.match(notice.text,/Retrying at /);
    assert.doesNotMatch(notice.text,/admission|dispatched|at capacity|composer/);
    assert.equal(notice.data?.retryAt,new Date(Date.now()+delays[i]!).toISOString());
    // Preserve a newer draft instead of claiming the failed message is in the composer.
    if(i===0)await service.invoke('chat.update',{id:chat.id,draft:'next message'});
    mock.timers.tick(delays[i]!-1);await flush();assert.equal(sentAt.length,i+1);
    mock.timers.tick(1);
  }
  await flush();assert.equal(sentAt.length,6);
  assert.deepEqual(sentAt.slice(1).map((at,i)=>at-sentAt[i]!),delays);
  const final=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
  assert.equal(final.status,'failed');assert.equal(final.draft,'next message');
  assert.match(final.recovery!.reason,/Rate limited by Fixture \(429\): Rate limit reached/);
  assert.match(final.recovery!.reason,/after 5 automatic retries/);
  const items=(await service.invoke('chat.timeline',{id:chat.id})).items;
  assert.equal(items.filter(item=>item.kind==='user').length,1);
  for(const copy of [final.error!,final.recovery!.reason,...items.filter(item=>item.status==='failed').map(item=>item.text)]){
    assert.doesNotMatch(copy,/admission|dispatched|back in the composer|at capacity/);
  }
  mock.timers.tick(100);
});

test('Retry-After parsing: delta-seconds, HTTP-date, retry-after-ms; junk, negative and NaN ignored; absurd values saturate',()=>{
  const now=Date.parse('2026-10-18T00:00:00Z');
  const h=(value:Record<string,string>)=>new Headers(value);
  assert.equal(retryAfterMs(h({'retry-after':'30'}),now),30_000);
  assert.equal(retryAfterMs(h({'retry-after':' 30 '}),now),30_000);
  assert.equal(retryAfterMs(h({'retry-after':'1.5'}),now),1_500);
  assert.equal(retryAfterMs(h({'retry-after':'0'}),now),0);
  assert.equal(retryAfterMs(h({'retry-after':'Sun, 18 Oct 2026 00:00:45 GMT'}),now),45_000);
  assert.equal(retryAfterMs(h({'retry-after':'Sunday, 18-Oct-26 00:01:00 GMT'}),now),60_000,'obsolete RFC 850 date');
  assert.equal(retryAfterMs(h({'retry-after':'Sat, 17 Oct 2026 23:00:00 GMT'}),now),0,'a past date means now');
  for(const junk of ['-5','-1','abc','NaN','Infinity','1e3','0x10','5 minutes','1.5.2030','2030-01-01',''])assert.equal(retryAfterMs(h({'retry-after':junk}),now),undefined,junk);
  assert.equal(retryAfterMs(h({}),now),undefined);
  assert.equal(retryAfterMs(h({'retry-after':'9'.repeat(400)}),now),Number.MAX_SAFE_INTEGER,'an absurd number saturates and hits the cap');
  assert.equal(retryAfterMs(h({'retry-after-ms':'1500','retry-after':'30'}),now),1_500,'retry-after-ms is more precise');
  assert.equal(retryAfterMs(h({'retry-after-ms':'-1','retry-after':'30'}),now),30_000);
  assert.equal(asSentence('Rate limited by X (429): try later'),'Rate limited by X (429): try later.');assert.equal(asSentence('Done.'),'Done.');
});

test('a Retry-After beyond the cap stops at once with the time to retry, never an early or overflowing retry',async()=>{
  for(const wait of [RETRY_AFTER_CAP_MS+1,3_600_000,2_147_483_648,Number.MAX_SAFE_INTEGER]){
    let calls=0;
    const outcome=await withAdmissionRetry(async()=>{calls++;return rejected(wait);},{signal:new AbortController().signal,now:()=>0,onWait(){assert.fail('must not hold the run for '+wait);}});
    assert.equal(calls,1);assert.equal(outcome.retries,0);assert.equal(outcome.cancelled,false);
    assert.equal(outcome.retryAt,new Date(Math.min(wait,8.64e15)).toISOString());
  }
  // A wait exactly at the cap is scheduled in full (stopped here before it elapses).
  const stop=new AbortController();let waited=0;
  const capped=await withAdmissionRetry(async()=>rejected(RETRY_AFTER_CAP_MS),{signal:stop.signal,onWait(wait){waited=wait.delayMs;stop.abort();}});
  assert.equal(waited,RETRY_AFTER_CAP_MS,'a wait at the cap is honoured in full');assert.equal(capped.cancelled,true);assert.equal(capped.retryAt,undefined);
});

test('service: an HTTP 429 asking for an hour ends the run now and says when to try again',async t=>{
  const dataDir=await directory(t);
  mock.timers.enable({apis:['setTimeout','Date'],now:Date.parse('2026-10-18T00:00:00Z')});t.after(()=>mock.timers.reset());
  let calls=0;
  const adapter=openAICompatibleAdapter({endpoint:'https://fixture.example/v1',apiKey:()=>undefined,label:'Fixture',tools:false,fetch:async()=>{calls++;return new Response(JSON.stringify({error:{message:'Rate limit reached for mock-model'}}),{status:429,headers:{'retry-after':'3600'}});}});
  const provider=createProviderAdapter({instances:()=>[{info:info()[0]!,command:'',env:{},sessionsRoot:'',adapter}]});
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'long-wait'});
  await flush();
  const final=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
  assert.equal(calls,1,'no automatic retry earlier than the provider asked');
  assert.equal(final.status,'failed');
  assert.match(final.recovery!.reason,/^Rate limited by Fixture \(429\): Rate limit reached for mock-model\. The request was not accepted\./);
  assert.match(final.recovery!.reason,/The provider asked to wait until /);
  assert.equal((await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='admission-retry').length,0);
  mock.timers.tick(100);
});
