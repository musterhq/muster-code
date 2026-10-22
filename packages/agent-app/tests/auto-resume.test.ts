/** #448 / #449 / #450: continue after a usage limit resets, continue after a restart, and a queue that survives both. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import {LIMIT_MAX_ATTEMPTS,NATIVE_CONTINUATION,RESTART_CONTINUATION,autoResumeTiming,blockingReset,hasNativeSession,isUsageLimit,limitClass,limitResumeAt,resetFromText} from '../src/runtime/auto-resume.ts';
import {displayStatus} from '../src/renderer/components/runStatus.ts';
import {createUpdateGate,UPDATE_DEFERRED_NOTE} from '../src/main/update-gate.ts';

const MODEL='fixture-model';
const routes=[{id:'hybrow',name:'Hybrow'},{id:'claude-code',name:'Claude Code'},{id:'local-llm',name:'Local'},{id:'backup',name:'Backup'}];
const info:ProviderAdapter['info']=()=>routes.map(route=>({...route,available:true,identityMasked:'fixture',models:[{id:MODEL,name:`${route.name} model`}]}));
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-resume-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,ms=8000){const end=Date.now()+ms;while(Date.now()<end){if(await check())return;await new Promise(resolve=>setTimeout(resolve,5));}assert.fail('condition not reached');}
const settle=(ms=150)=>new Promise(resolve=>setTimeout(resolve,ms));
/** Short waits for the tests; restored after each. */
function fastTiming(t:TestContext){
  const saved=structuredClone({fallbackMs:autoResumeTiming.fallbackMs,backoffMs:autoResumeTiming.backoffMs,minWaitMs:autoResumeTiming.minWaitMs,restartDelayMs:autoResumeTiming.restartDelayMs});
  Object.assign(autoResumeTiming,{fallbackMs:{quota:60,rate:60},backoffMs:{quota:[60,60,60],rate:[60,60,60,60,60]},minWaitMs:0,restartDelayMs:0});
  t.after(()=>{Object.assign(autoResumeTiming,saved);});
}
type Call={prompt:string;threadId?:string;providerId?:string};
/** Each run answers from `script` (by call number), else completes. */
function scripted(script:(call:number,input:ProviderInput)=>ProviderResult|Promise<ProviderResult|undefined>|undefined){
  const calls:Call[]=[];
  const provider:ProviderAdapter={info,stop:async()=>true,dispose(){},run:async input=>{
    calls.push({prompt:input.prompt,...(input.chat.providerThreadId?{threadId:input.chat.providerThreadId}:{}),...(input.chat.providerId?{providerId:input.chat.providerId}:{})});
    return (await script(calls.length,input))??{status:'completed',finalMessage:'done',threadId:'thread-1',turnId:`turn-${calls.length}`};
  }};
  return {provider,calls};
}
const limited=(text:string,extra:Partial<ProviderResult>={}):ProviderResult=>({status:'failed',finalMessage:'',threadId:'thread-1',turnId:'turn-x',dispatchState:'dispatched',errorMessage:text,recovery:{kind:'failed',retryable:false,reason:`The provider attempt failed: ${text}`},...extra});
const snapshotChat=async(service:ReturnType<typeof createAgentService>,id:string)=>(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===id)!;
const items=async(service:ReturnType<typeof createAgentService>,id:string)=>(await service.invoke('chat.timeline',{id})).items;

test('limits are classified and the reset time is read from usage windows, the provider’s words, or a backoff',()=>{
  assert.equal(limitClass('You\'ve hit your usage limit. Upgrade to Pro or try again in 2 hours 5 minutes.'),'quota');
  assert.equal(limitClass('Claude AI usage limit reached|1760000000'),'quota');
  assert.equal(limitClass('5-hour limit reached ∙ resets 3pm'),'quota');
  assert.equal(limitClass('429 Too Many Requests'),'rate');
  assert.equal(limitClass('upstream 503: model overloaded'),'rate');
  assert.equal(isUsageLimit('This model’s maximum context length is 200000 tokens; the token limit of the model was exceeded'),false);
  assert.equal(isUsageLimit('permission denied'),false);
  const now=Date.parse('2026-10-17T12:00:00Z');
  assert.equal(resetFromText('try again in 2 hours 5 minutes',now),now+2*3_600_000+5*60_000);
  assert.equal(resetFromText('Rate limited. Resets in 12 min.',now),now+12*60_000);
  assert.equal(resetFromText('Claude AI usage limit reached|1760000000',now),1_760_000_000_000);
  assert.equal(resetFromText('limit reached; retry after 2026-10-17T15:30:00Z',now),Date.parse('2026-10-17T15:30:00Z'));
  assert.equal(resetFromText('Retry-After: 90',now),now+90_000);
  const clock=resetFromText('5-hour limit reached ∙ resets 3pm',now)!;
  assert.equal(new Date(clock).getHours(),15);assert.ok(clock>now&&clock-now<=86_400_000);
  assert.equal(resetFromText('usage limit reached',now),undefined);
  const usage={providerId:'codex',source:'live' as const,updatedAt:'',primary:{usedPercent:100,windowMinutes:300,resetsAt:new Date(now+40*60_000).toISOString()},secondary:{usedPercent:40,windowMinutes:10080,resetsAt:new Date(now+3*86_400_000).toISOString()}};
  assert.equal(blockingReset([usage],now),now+40*60_000,'the exhausted window decides, not the half-used weekly one');
  assert.deepEqual(limitResumeAt({text:'usage limit',usage:[usage],attempts:0,now}),{at:now+40*60_000,source:'usage'});
  assert.deepEqual(limitResumeAt({text:'usage limit. try again in 10 minutes',attempts:0,now}),{at:now+10*60_000,source:'provider'});
  assert.deepEqual(limitResumeAt({text:'usage limit',attempts:0,now}),{at:now+autoResumeTiming.fallbackMs.quota,source:'backoff'});
  // Refused again at its own reset time: the provider's word is not trusted twice.
  assert.deepEqual(limitResumeAt({text:'usage limit. resets in 1 min',attempts:1,now}),{at:now+autoResumeTiming.backoffMs.quota[0]!,source:'backoff'});
  assert.equal(limitResumeAt({text:'429',attempts:0,now}).at,now+autoResumeTiming.fallbackMs.rate,'a rate limit retries sooner than a usage window');
  assert.equal(LIMIT_MAX_ATTEMPTS.quota,3);assert.equal(LIMIT_MAX_ATTEMPTS.rate,5);
  assert.equal(hasNativeSession({providerThreadId:'t',providerId:'hybrow'}),true,'Codex threads resume natively');
  assert.equal(hasNativeSession({providerThreadId:'s',providerId:'claude-code'}),true,'Claude Code resumes its session');
  assert.equal(hasNativeSession({providerThreadId:'h',providerId:'local-llm'}),false,'an HTTP route gets the continuation message');
  assert.equal(hasNativeSession({providerId:'claude-code'}),false,'no session id, nothing to resume');
});

test('a usage limit shows Limited with its reset, queued messages wait, and the turn continues at reset in order',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const {provider,calls}=scripted(async call=>{
    if(call===1){gate=Promise.withResolvers();return gate.promise;}
    return undefined;
  });
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'build it',requestId:'first'});
  await until(()=>!!gate);
  await service.invoke('chat.queue.add',{id:chat.id,text:'then test it',requestId:'q-1'});
  await service.invoke('chat.queue.add',{id:chat.id,text:'then ship it',requestId:'q-2'});
  gate!.resolve(limited('You\'ve hit your usage limit. Try again in 1 seconds.'));
  await until(async()=>!!(await snapshotChat(service,chat.id)).autoResume);
  const waiting=await snapshotChat(service,chat.id);
  assert.equal(waiting.autoResume?.resume,true,'on by default');assert.equal(waiting.autoResume?.reason,'usage');
  const at=Date.parse(waiting.autoResume!.resumeAt!);assert.ok(at>Date.now()&&at<=Date.now()+1500,'reset time from the provider’s words');
  assert.equal(displayStatus(waiting,[]),'limited');
  assert.equal(waiting.queuePaused,'limited','queued messages wait for the reset');
  assert.equal(calls.length,1);
  await until(()=>calls.length>=4);
  // Same thread (Codex resumes natively), then the queue in order.
  assert.deepEqual(calls.slice(1).map(call=>call.prompt),[NATIVE_CONTINUATION,'then test it','then ship it']);
  assert.equal(calls[1]!.threadId,'thread-1');
  const done=await snapshotChat(service,chat.id);
  assert.equal(done.autoResume,undefined);assert.equal(done.status,'completed');assert.equal(done.queue,undefined);
  await settle();assert.equal(calls.length,4,'nothing is sent twice');
});

test('a turn refused before it started re-runs its own prompt once, without a second copy in the transcript',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const {provider,calls}=scripted(call=>call===1?{status:'failed',finalMessage:'',dispatchState:'not-dispatched',errorMessage:'Claude AI usage limit reached. Try again in 1 seconds.',recovery:{kind:'failed',retryable:true,reason:'The provider attempt failed: Claude AI usage limit reached. Try again in 1 seconds.'}}:undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'write the report',requestId:'first'});
  await until(()=>calls.length===2);
  assert.equal(calls[1]!.prompt,'write the report');
  await until(async()=>(await snapshotChat(service,chat.id)).status==='completed');
  assert.equal((await items(service,chat.id)).filter(item=>item.kind==='user').length,1);
  assert.equal((await snapshotChat(service,chat.id)).draft,'','the restored draft was the prompt that ran');
});

test('a limited turn that never started waits as Limited without handing its prompt back as a draft, then re-runs it at reset',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  // Not retryable: the transient admission retry does not take it, so the usage-limit continuation does.
  const {provider,calls}=scripted(call=>call===1?{status:'failed',finalMessage:'',dispatchState:'not-dispatched',errorMessage:'Claude AI usage limit reached. Try again in 1 seconds.',recovery:{kind:'failed',retryable:false,reason:'The provider attempt failed: Claude AI usage limit reached. Try again in 1 seconds.'}}:undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'write the report',requestId:'first'});
  await until(async()=>(await snapshotChat(service,chat.id)).autoResume?.resume===true);
  assert.equal((await snapshotChat(service,chat.id)).draft,'','the prompt re-runs at reset, so it is not also put back in the composer (it would be sent twice)');
  await until(()=>calls.length===2);
  assert.equal(calls[1]!.prompt,'write the report');
  await until(async()=>(await snapshotChat(service,chat.id)).status==='completed');
  assert.equal((await items(service,chat.id)).filter(item=>item.kind==='user').length,1);
});

test('a provider that still refuses backs off, says so once, and gives up instead of looping',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const {provider,calls}=scripted(()=>limited('You\'ve hit your usage limit.'));
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'first'});
  await until(async()=>!!(await snapshotChat(service,chat.id)).autoResume?.gaveUp);
  assert.equal(calls.length,1+LIMIT_MAX_ATTEMPTS.quota,'the first run plus the bounded automatic tries');
  assert.deepEqual(calls.slice(1).map(call=>call.prompt),Array(LIMIT_MAX_ATTEMPTS.quota).fill(NATIVE_CONTINUATION));
  const notes=(await items(service,chat.id)).filter(item=>item.data?.kind==='auto-resume');
  assert.equal(notes.length,1,'one line, updated in place');assert.match(notes[0]!.text,/stopped continuing/);
  const limitedChat=await snapshotChat(service,chat.id);
  assert.notEqual(displayStatus(limitedChat,[]),'limited','after giving up the chat no longer reads as waiting');
  await settle(400);assert.equal(calls.length,1+LIMIT_MAX_ATTEMPTS.quota,'never loops');
});

test('Don’t resume and the Settings switch keep the chat Limited without continuing',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const {provider,calls}=scripted(call=>call===1||call===2?limited('usage limit reached. Try again in 1 seconds.'):undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'first'});
  await until(async()=>!!(await snapshotChat(service,chat.id)).autoResume);
  const off=await service.invoke('chat.autoResume',{id:chat.id,resume:false});
  assert.equal(off.autoResume?.resume,false);
  await settle(1300);assert.equal(calls.length,1,'this chat does not resume');
  await service.invoke('settings.set',{key:'chats.resumeAfterLimit',value:false});
  await service.invoke('chat.send',{id:chat.id,text:'again',requestId:'second'});
  await until(async()=>!!(await snapshotChat(service,chat.id)).autoResume);
  assert.equal((await snapshotChat(service,chat.id)).autoResume?.resume,false,'the setting off makes Don’t resume the default');
  await settle(1300);assert.equal(calls.length,2);
});

test('a stored resume survives an app restart and is re-armed at launch',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const first=scripted(()=>limited('usage limit reached. Try again in 1 hours.'));
  const service=createAgentService({dataDir,provider:first.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'first'});
  await until(async()=>!!(await snapshotChat(service,chat.id)).autoResume);
  await service.dispose();
  // The reset time comes closer while Muster is closed.
  const db=new DatabaseSync(join(dataDir,'muster-agent.sqlite'));
  db.prepare('UPDATE chat_auto_resume SET resume_at = ?').run(new Date(Date.now()+300).toISOString());db.close();
  const second=scripted(()=>undefined);
  const again=createAgentService({dataDir,provider:second.provider,onEvent(){}});t.after(()=>again.dispose());
  assert.equal((await snapshotChat(again,chat.id)).autoResume?.resume,true,'still Limited after the restart');
  await until(()=>second.calls.length===1);
  assert.equal(second.calls[0]!.prompt,NATIVE_CONTINUATION);
});

test('an opt-in fallback model continues a limited chat at once',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const {provider,calls}=scripted(call=>call===1?limited('usage limit reached. Try again in 5 hours.'):undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  assert.equal((await snapshotChat(service,chat.id)).fallbacks,undefined,'off by default');
  await service.invoke('chat.fallbacks',{id:chat.id,fallbacks:[{providerId:'backup',model:MODEL}]});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'first'});
  await until(()=>calls.length===2);
  assert.equal(calls[1]!.providerId,'backup');assert.equal(calls[1]!.threadId,undefined,'a fresh conversation on the fallback');
  assert.ok(calls[1]!.prompt.includes(NATIVE_CONTINUATION),'continues where it stopped, with the earlier conversation as a summary');
  assert.ok(!calls[1]!.prompt.includes(RESTART_CONTINUATION));
  assert.ok((await items(service,chat.id)).some(item=>item.data?.reason==='fallback'));
});

test('chats working when Muster crashed continue: native sessions resume, HTTP routes get the message, approvals are left alone',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const store=new AgentStore(dataDir);
  const seed=(providerId:string,thread?:string)=>{const chat=store.createChat({model:MODEL,mode:'agent',providerId});store.updateChat(chat.id,{providerId,providerBindingId:providerId,status:'running',...(thread?{providerThreadId:thread,providerThreadProviderId:providerId,providerThreadBindingId:providerId}:{})});return chat.id;};
  const cli=seed('claude-code','session-1'),http=seed('local-llm'),asking=seed('claude-code','session-2'),stopping=seed('claude-code','session-3');
  store.appendItem(asking,'approval','Run rm -rf build?','pending',{kind:'command'});
  store.updateChat(stopping,{status:'stopping'});
  store.close();
  const {provider,calls}=scripted(()=>undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  await until(()=>calls.length===2);await settle();
  assert.equal(calls.length,2,'the chat waiting on an approval and the one being stopped are not continued');
  const byThread=new Map(calls.map(call=>[call.threadId??call.providerId,call]));
  assert.equal(byThread.get('session-1')?.prompt,NATIVE_CONTINUATION,'Claude Code resumes the same session');
  assert.equal(byThread.get('local-llm')?.prompt,RESTART_CONTINUATION);
  for(const id of [cli,http])await until(async()=>(await snapshotChat(service,id)).status==='completed');
  assert.equal((await snapshotChat(service,asking)).status,'interrupted');
});

test('a quit keeps the live turn and continues it after launch, once; the setting turns it off',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const hold=(input:ProviderInput)=>{gate=Promise.withResolvers();input.onThreadReady?.('thread-q');input.onTurnAccepted?.({threadId:'thread-q',turnId:'turn-q',dispatchState:'dispatched'});return gate.promise;};
  const stopOnDispose=(provider:ProviderAdapter):ProviderAdapter=>({...provider,dispose(){gate?.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',threadId:'thread-q',turnId:'turn-q',recovery:{kind:'cancelled',retryable:false,reason:'Stopped. The provider process for this turn was shut down.'}});}});
  const one=scripted((_,input)=>hold(input));
  const service=createAgentService({dataDir,provider:stopOnDispose(one.provider),onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'refactor',requestId:'first'});
  await until(()=>!!gate);
  await service.dispose();
  let store=new AgentStore(dataDir);
  assert.equal(store.chat(chat.id)?.status,'interrupted');
  const ended=store.timeline(chat.id).filter(item=>item.kind==='notice').map(item=>item.text).join('\n');
  assert.match(ended,/Muster quit while this was working\. It continues when Muster starts again\./);
  assert.doesNotMatch(ended,/will not resume|^Stopped\./m,'a quit is not a Stop');
  store.close();
  // Launch: the same thread continues. Quit again during that continuation: the next launch does not continue it again.
  gate=undefined;
  const two=scripted((_,input)=>hold(input));
  const again=createAgentService({dataDir,provider:stopOnDispose(two.provider),onEvent(){}});
  await until(()=>two.calls.length===1&&!!gate);
  assert.equal(two.calls[0]!.prompt,NATIVE_CONTINUATION);assert.equal(two.calls[0]!.threadId,'thread-q');
  await again.dispose();
  const three=scripted(()=>undefined);
  const third=createAgentService({dataDir,provider:three.provider,onEvent(){}});
  await settle(300);
  assert.equal(three.calls.length,0,'a continuation cut short is never continued a second time');
  assert.ok((await items(third,chat.id)).some(item=>item.data?.reason==='restart-again'));
  await third.dispose();
  // Setting off: a quit is still a neutral ending, and nothing continues.
  const four=scripted((_,input)=>hold(input));gate=undefined;
  const fourth=createAgentService({dataDir,provider:stopOnDispose(four.provider),onEvent(){}});
  await fourth.invoke('settings.set',{key:'chats.resumeAfterRestart',value:false});
  await fourth.invoke('chat.send',{id:chat.id,text:'more',requestId:'fourth'});
  await until(()=>!!gate);await fourth.dispose();
  const five=scripted(()=>undefined);
  const fifth=createAgentService({dataDir,provider:five.provider,onEvent(){}});t.after(()=>fifth.dispose());
  await settle(300);assert.equal(five.calls.length,0);
  assert.ok((await items(fifth,chat.id)).some(item=>/Send a message to continue/.test(item.text)));
});

test('the queue survives a quit in order with its files and chips, sends each message once, and drops one already sent',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const one=scripted(()=>{gate=Promise.withResolvers();return gate.promise;});
  const service=createAgentService({dataDir,provider:{...one.provider,dispose(){gate?.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});}},onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});
  await until(()=>!!gate);
  const file=await service.invoke('attachments.stage',{chatId:chat.id,name:'notes.txt',mime:'text/plain',dataBase64:Buffer.from('hello').toString('base64')});
  await service.invoke('chat.queue.add',{id:chat.id,text:'with a file',requestId:'q-file',attachmentIds:[file.id],effort:'high'});
  await service.invoke('chat.queue.add',{id:chat.id,text:'second',requestId:'q-second'});
  await service.invoke('chat.queue.add',{id:chat.id,text:'already sent',requestId:'q-sent'});
  await service.dispose();
  const store=new AgentStore(dataDir);
  assert.deepEqual(store.queue(chat.id).map(item=>[item.text,item.attachmentIds]),[['with a file',[file.id]],['second',[]],['already sent',[]]]);
  // Sent just before the quit (its receipt exists): it must never go out again.
  store.database().prepare('INSERT INTO receipts (request_id, chat_id, run_id, created_at, fingerprint) VALUES (?, ?, ?, ?, ?)').run('q-sent',chat.id,'run-x',new Date().toISOString(),'x');
  store.close();
  const two=scripted(()=>undefined);
  const again=createAgentService({dataDir,provider:two.provider,onEvent(){}});t.after(()=>again.dispose());
  await until(()=>two.calls.length===3);await settle();
  assert.equal(two.calls[0]!.prompt.includes('Continue from where you stopped')||two.calls[0]!.prompt.includes('Muster restarted'),true,'the interrupted turn continues first');
  assert.ok(two.calls[1]!.prompt.includes('with a file'),'then the queue, in order');assert.ok(two.calls[1]!.prompt.includes('notes.txt'),'with its file');
  assert.equal(two.calls[2]!.prompt,'second');
  assert.equal(two.calls.length,3,'the already-sent message is dropped, never resent');
  assert.equal((await snapshotChat(again,chat.id)).queue,undefined);
});

test('a queued message leaves the queue only with its send receipt; a racing dispatch never sends it twice',async t=>{
  const dataDir=await directory(t);
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const {provider,calls}=scripted(()=>{gate=Promise.withResolvers();return gate.promise;});
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>{gate?.resolve({status:'completed',finalMessage:''});return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>!!gate);
  await service.invoke('chat.queue.add',{id:chat.id,text:'next',requestId:'q-next'});
  await service.invoke('chat.stop',{id:chat.id});gate!.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});
  await until(async()=>(await snapshotChat(service,chat.id)).queuePaused==='interrupted');
  gate=undefined;
  await Promise.all([service.invoke('chat.queue.resume',{id:chat.id}),service.invoke('chat.queue.resume',{id:chat.id})]);
  await until(()=>!!gate);await settle();
  assert.deepEqual(calls.map(call=>call.prompt),['start','next']);
  const store=new AgentStore(dataDir);
  assert.equal(store.queue(chat.id).length,0);assert.ok(store.receipt('q-next'));store.close();
});

test('tool rows left running settle as interrupted on stop and at launch',async t=>{
  const dataDir=await directory(t);
  const store=new AgentStore(dataDir);
  const idle=store.createChat({model:MODEL,mode:'agent'});
  const stuck=store.appendItem(idle.id,'tool','npm test','running',{type:'commandExecution'});
  store.close();
  let gate:PromiseWithResolvers<ProviderResult>|undefined;
  const {provider}=scripted((_,input)=>{gate=Promise.withResolvers();input.onEvent('item/started',{item:{id:'cmd-1',type:'commandExecution',command:'sleep 100',status:'inProgress'}});return gate.promise;});
  const service=createAgentService({dataDir,provider:{...provider,stop:async()=>{gate?.resolve({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}});return true;}},onEvent(){}});t.after(()=>service.dispose());
  assert.equal((await items(service,idle.id)).find(item=>item.id===stuck.id)?.status,'interrupted','a row from an earlier session no longer spins');
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'run it',requestId:'run'});
  await until(async()=>(await items(service,chat.id)).some(item=>item.kind==='tool'&&item.status==='running'));
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await snapshotChat(service,chat.id)).status!=='stopping');
  assert.deepEqual((await items(service,chat.id)).filter(item=>item.kind==='tool').map(item=>item.status),['interrupted']);
});

test('an update install waits for running work, says so once, and installs when it finishes',async()=>{
  let running=2,installs=0;const notes:string[]=[];
  const gate=createUpdateGate({running:()=>running,install:async()=>{installs++;return 'ok';},notify:message=>notes.push(message)});
  assert.equal(await gate.install(),undefined);assert.equal(await gate.install(),undefined);
  assert.deepEqual(notes,[UPDATE_DEFERRED_NOTE]);assert.equal(installs,0);assert.equal(gate.waiting,true);
  running=1;gate.idle();assert.equal(installs,0);
  running=0;gate.idle();await settle(10);assert.equal(installs,1);assert.equal(gate.waiting,false);
  gate.idle();assert.equal(installs,1,'one install per request');
  assert.equal(await gate.install(),'ok','idle: installs at once');
});

test('#579: after a crash, Continue anyway and then Steer on the queued message send it exactly once',async t=>{
  fastTiming(t);
  const dataDir=await directory(t);
  const store=new AgentStore(dataDir);
  const seeded=store.createChat({model:MODEL,mode:'agent',providerId:'hybrow'});
  store.updateChat(seeded.id,{providerId:'hybrow',providerBindingId:'hybrow',status:'running',providerThreadId:'thread-k',providerThreadProviderId:'hybrow',providerThreadBindingId:'hybrow',providerTurnId:'turn-k'});
  store.enqueue(seeded.id,{id:'queued-1',text:'Queued after kill: reply QUEUED-SURVIVED.',requestId:'q-kill',attachmentIds:[],createdAt:new Date().toISOString()},20);
  store.close();
  const {provider,calls}=scripted(()=>undefined);
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  await until(async()=>(await snapshotChat(service,seeded.id)).recovery?.kind==='recovery-needed');await settle();
  assert.equal(calls.length,0,'a turn that may still be running at the provider is never continued or followed by the queue');
  await service.invoke('chat.continueAnyway',{id:seeded.id});await settle();
  assert.equal(calls.length,0,'Continue anyway does not send the queued message by itself');
  // Steer clicked twice in a row on the idle chat's queued row.
  await Promise.all([service.invoke('chat.queue.steer',{id:seeded.id,queueId:'queued-1'}),service.invoke('chat.queue.steer',{id:seeded.id,queueId:'queued-1'}).catch(()=>undefined)]);
  await until(()=>calls.length>=1);await settle(300);
  assert.deepEqual(calls.map(call=>call.prompt),['Queued after kill: reply QUEUED-SURVIVED.']);
  assert.equal((await items(service,seeded.id)).filter(item=>item.kind==='user'&&item.text.includes('QUEUED-SURVIVED')).length,1);
  assert.equal((await snapshotChat(service,seeded.id)).queue,undefined);
});
