import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {classifyNativeError,createNativeThreadBridge,NativeUnavailableError,parseNativeGoal,tokensFromUsage} from '../src/runtime/codex-native.ts';
import {goalTiming} from '../src/runtime/domains/goals.ts';
import {goalTokenProgress} from '../src/shared/domains/goals-protocol.ts';

goalTiming.continueDelayMs=5;
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',bindingId:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-native-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
const rpcMissing=()=>Object.assign(new Error('Method not found'),{code:-32601});

/**
 * A provider whose chats hold a live "app-server" thread after their first run. `handle` answers
 * native calls; `emit` delivers an app-server notification the way provider.ts does (idle
 * listeners while no Muster run is in flight, then the last run's onEvent).
 */
function nativeProvider(handle:(method:string,params:Record<string,unknown>)=>Record<string,unknown>|Promise<Record<string,unknown>>){
  const calls:Array<[string,Record<string,unknown>]>=[],inputs:ProviderInput[]=[];
  const idle=new Set<(chatId:string,method:string,params:Record<string,unknown>)=>void>();
  const threads=new Map<string,string>();let active=false;let gate:PromiseWithResolvers<ProviderResult>|undefined;let gated=false;
  let last:ProviderInput|undefined;
  const provider:ProviderAdapter={info,
    async run(input){inputs.push(input);last=input;active=true;threads.set(input.chat.id,'thread-1');input.onThreadReady?.('thread-1');
      try{if(gated){gate=Promise.withResolvers();return await gate.promise;}return {status:'completed',finalMessage:'Worked.',threadId:'thread-1',turnId:`turn-${inputs.length}`};}finally{active=false;}},
    stop:async()=>true,dispose(){},
    nativeThread:chatId=>threads.has(chatId)?{threadId:threads.get(chatId)!,providerId:'hybrow',bindingId:'fixture'}:undefined,
    async nativeCall(chatId,method,params){if(!threads.has(chatId))throw new NativeUnavailableError();calls.push([method,params]);return handle(method,params);},
    onIdleEvent(listener){idle.add(listener);return()=>idle.delete(listener);},
  };
  return {provider,calls,inputs,
    gate(on:boolean){gated=on;},
    release(result:ProviderResult={status:'completed',finalMessage:'Worked.',threadId:'thread-1',turnId:'turn-x'}){const current=gate;gate=undefined;current?.resolve(result);},
    get open(){return Boolean(gate);},
    emit(chatId:string,method:string,params:Record<string,unknown>){if(!active)for(const listener of idle)listener(chatId,method,params);last?.onEvent(method,params);},
    methods(){return calls.map(([method])=>method);}};
}
const goalOf=(objective:string,status='active',extra:Record<string,unknown>={})=>({threadId:'thread-1',objective,status,tokenBudget:null,tokensUsed:0,timeUsedSeconds:0,createdAt:1,updatedAt:1,...extra});

test('capability probe: method-not-found is cached per binding, a disabled feature or no session is retried',async()=>{
  assert.equal(classifyNativeError(rpcMissing()),'missing');
  assert.equal(classifyNativeError(new Error('unknown variant `thread/goal/get`')),'missing');
  assert.equal(classifyNativeError(new Error('goals feature is disabled')),'disabled');
  assert.equal(classifyNativeError(new Error('socket closed')),'other');
  let calls=0,mode:'missing'|'disabled'|'ok'='disabled',thread:{threadId:string;providerId:string;bindingId:string}|undefined;
  const bridge=createNativeThreadBridge({thread:()=>thread,async call(){calls++;if(mode==='missing')throw rpcMissing();if(mode==='disabled')throw new Error('goals feature is disabled');return {goal:null};}});
  assert.equal(await bridge.supports('c','goals'),false,'no live session');assert.equal(calls,0);
  thread={threadId:'t',providerId:'p',bindingId:'b'};
  assert.equal(await bridge.supports('c','goals'),false,'feature off for this launch');
  mode='ok';assert.equal(await bridge.supports('c','goals'),true,'retried and now supported');
  assert.equal(await bridge.supports('c','goals'),true);assert.equal(calls,2,'supported is cached');
  mode='missing';assert.equal(await bridge.supports('c','queue'),false);assert.equal(await bridge.supports('c','queue'),false);assert.equal(calls,3,'missing is cached');
  assert.equal(await bridge.supports('c','projects'),false,'host probe needs query');
});

test('native goal payloads and provider token usage parse defensively',()=>{
  assert.deepEqual(parseNativeGoal({objective:'x',status:'budgetLimited',tokenBudget:500,tokensUsed:612.4,timeUsedSeconds:3}),{objective:'x',status:'budget_limited',tokenBudget:500,tokensUsed:612,timeUsedSeconds:3});
  assert.equal(parseNativeGoal({status:'nonsense'}),undefined);
  assert.deepEqual(tokensFromUsage({tokenUsage:{last:{inputTokens:10,outputTokens:5},total:{totalTokens:900}}}),{last:15,total:900});
  assert.equal(goalTokenProgress({tokensUsed:12_300,tokenBudget:50_000}),'12.3k / 50k tokens');
  assert.equal(goalTokenProgress({tokensUsed:0,tokenBudget:null}),'');
});

test('provider: native calls go to the chat-owned session; app-server-started turns reach idle listeners and stop natively',async()=>{
  const calls:Array<[string,string,Record<string,unknown>]>=[];let resolve!:(result:ProviderResult)=>void;let input!:Record<string,unknown>;
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,runCodexAppServer:value=>{input=value;return new Promise(done=>{resolve=done;});},
    async callCodexConversation(key,method,params){calls.push([key,method,params]);return {ok:true};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const events:string[]=[];adapter.onIdleEvent!((chatId,method)=>events.push(`${chatId}:${method}`));
  const run:ProviderInput={chat:{id:'chat-1',mode:'agent',model:'claude/claude-fable-5'} as ProviderInput['chat'],cwd:'/unused',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}};
  assert.equal(adapter.nativeThread!('chat-1'),undefined);
  await assert.rejects(adapter.nativeCall!('chat-1','thread/goal/get',{}),NativeUnavailableError);
  const pending=adapter.run(run);await new Promise(done=>setImmediate(done));
  const on=input.onEvent as (method:string,params:Record<string,unknown>)=>void;
  (input.onTurnAccepted as (identity:Record<string,unknown>)=>void)({threadId:'thread-1',turnId:'turn-1',dispatchState:'dispatched'});
  on('turn/started',{threadId:'thread-1',turn:{id:'turn-1'}});
  assert.equal(events.length,0,'the run’s own turn is not an idle event');
  on('turn/completed',{threadId:'thread-1',turn:{id:'turn-1',status:'completed'}});
  // The app-server starts the queued follow-up before Muster's run has settled.
  on('turn/started',{threadId:'thread-1',turn:{id:'turn-2'}});
  assert.deepEqual(events,['chat-1:turn/started']);
  resolve({status:'completed',finalMessage:'',dispatchState:'dispatched',threadId:'thread-1',turnId:'turn-1'});await pending;
  assert.deepEqual(adapter.nativeThread!('chat-1'),{threadId:'thread-1',providerId:'hybrow',bindingId:'fixture-hybrow'});
  await adapter.nativeCall!('chat-1','thread/goal/get',{threadId:'thread-1'});
  assert.deepEqual(calls.at(-1)!.slice(0,2),['agent:chat-1:hybrow:fixture-hybrow','thread/goal/get']);
  on('thread/goal/updated',{threadId:'thread-1',goal:{}});
  assert.ok(events.includes('chat-1:thread/goal/updated'),'between runs every notification is routed');
  assert.equal(await adapter.stop('chat-1'),true);
  assert.deepEqual(calls.at(-1)!.slice(1),['turn/interrupt',{threadId:'thread-1',turnId:'turn-2'}],'the adopted turn is interrupted natively');
  adapter.dispose();
});

test('goals delegate to thread/goal/* when supported: the app-server owns status, continuation and token accounting',async t=>{
  const dataDir=await directory(t);let current=goalOf('Ship it');
  const fake=nativeProvider((method,params)=>{
    if(method==='thread/goal/get')return {goal:null};
    if(method==='thread/goal/set'){current={...current,...(params.objective?{objective:String(params.objective)}:{}),...(params.status?{status:String(params.status)}:{}),...('tokenBudget' in params?{tokenBudget:params.tokenBudget as null}:{})};return {goal:current};}
    if(method==='thread/goal/clear')return {cleared:true};
    return {};
  });
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>{fake.gate(false);fake.release();return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'r1'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.status==='completed','first run');
  const goal=await service.invoke('goals.set',{chatId:chat.id,text:'Ship it',tokenBudget:50_000});
  assert.equal(goal.native,true);assert.equal(goal.status,'active');assert.equal(goal.tokenBudget,50_000);
  assert.deepEqual(fake.calls.find(([method])=>method==='thread/goal/set')![1],{threadId:'thread-1',objective:'Ship it',status:'active',tokenBudget:50_000});
  assert.equal(fake.inputs.length,1,'Muster does not dispatch the kickoff: the app-server starts it');
  // The app-server starts the continuation itself; Muster adopts and renders it.
  fake.emit(chat.id,'turn/started',{threadId:'thread-1',turn:{id:'native-1'}});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.status,'running');
  await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'collide',requestId:'r2'}),/./,'a send waits behind the adopted turn');
  fake.emit(chat.id,'item/agentMessage/delta',{threadId:'thread-1',itemId:'m1',delta:'Pushed the '});
  fake.emit(chat.id,'item/agentMessage/delta',{threadId:'thread-1',itemId:'m1',delta:'release.'});
  fake.emit(chat.id,'thread/goal/updated',{threadId:'thread-1',turnId:'native-1',goal:goalOf('Ship it','complete',{tokenBudget:50_000,tokensUsed:12_300,timeUsedSeconds:95})});
  fake.emit(chat.id,'turn/completed',{threadId:'thread-1',turn:{id:'native-1',status:'completed'}});
  const snapshot=(await service.invoke('app.snapshot',undefined)).chats[0]!;
  assert.equal(snapshot.status,'completed');
  assert.equal(snapshot.goal?.status,'complete');assert.equal(snapshot.goal?.tokensUsed,12_300);assert.equal(snapshot.goal?.accumulatedMs,95_000);
  const texts=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='assistant').map(item=>item.text);
  assert.ok(texts.includes('Pushed the release.'));
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(fake.inputs.length,1,'no Muster continuation for a native goal');
  await service.invoke('goals.clear',{chatId:chat.id});
  assert.ok(fake.methods().includes('thread/goal/clear'));
});

test('goals fall back to Muster’s loop without native support, count provider-reported tokens, stop at the user budget, and enable Codex goal tools',async t=>{
  const dataDir=await directory(t);
  const fake=nativeProvider(method=>{if(method.startsWith('thread/goal/'))throw rpcMissing();return {};});
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>{fake.gate(false);fake.release();return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  fake.gate(true);
  const goal=await service.invoke('goals.set',{chatId:chat.id,text:'Refactor',tokenBudget:1000});
  assert.equal(goal.native,undefined);
  await until(()=>fake.open,'kickoff');
  assert.equal(fake.inputs[0]!.prompt,'Start working toward the goal.');
  assert.equal((fake.inputs[0]!.configOverrides as Record<string,unknown>)['features.goals'],true);
  assert.match(fake.inputs[0]!.developerInstructions??'',/Token budget: 0 of 1000 tokens used/);
  fake.emit(chat.id,'thread/tokenUsage/updated',{threadId:'thread-1',tokenUsage:{last:{totalTokens:400},total:{totalTokens:400}}});
  fake.emit(chat.id,'thread/tokenUsage/updated',{threadId:'thread-1',tokenUsage:{last:{totalTokens:700},total:{totalTokens:1100}}});
  assert.equal((await service.invoke('goals.get',{chatId:chat.id}))!.tokensUsed,1100);
  fake.release();
  await until(async()=>(await service.invoke('goals.get',{chatId:chat.id}))?.status==='budget_limited','budget stop');
  assert.equal(fake.inputs.length,1,'no continuation after the budget is spent');
  const raised=await service.invoke('goals.budget',{chatId:chat.id,tokenBudget:5000});
  assert.equal(raised.tokenBudget,5000);
  await assert.rejects(service.invoke('goals.budget',{chatId:chat.id,tokenBudget:-1}),/whole number/);
});

test('a local goal moves to the app-server once the chat’s session supports thread/goal/*',async t=>{
  const dataDir=await directory(t);let supported=false;
  const fake=nativeProvider((method,params)=>{
    if(!supported&&method.startsWith('thread/goal/'))throw new Error('goals feature is disabled');
    if(method==='thread/goal/set')return {goal:goalOf(String(params.objective),String(params.status))};
    return {goal:null};
  });
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>{fake.gate(false);fake.release();return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  fake.gate(true);
  await service.invoke('goals.set',{chatId:chat.id,text:'Migrate me'});
  await until(()=>fake.open,'local kickoff');
  supported=true;
  fake.release();
  await until(async()=>(await service.invoke('goals.get',{chatId:chat.id}))?.native===true,'migrated');
  assert.deepEqual(fake.calls.filter(([method])=>method==='thread/goal/set').at(-1)![1],{threadId:'thread-1',objective:'Migrate me',status:'active',tokenBudget:null});
  await new Promise(resolve=>setTimeout(resolve,30));
  assert.equal(fake.inputs.length,1,'Muster stops continuing once the app-server owns the goal');
  // Pause goes to the app-server first.
  const paused=await service.invoke('goals.pause',{chatId:chat.id});
  assert.equal(paused.status,'paused');assert.equal(paused.reason,'user');
  assert.equal(fake.calls.at(-1)![1].status,'paused');
});

test('follow-ups queued on a native-capable chat go to thread/queue/*; the app-server dispatches and Muster drops sent rows',async t=>{
  const dataDir=await directory(t);const held:string[]=[];let next=0;
  const fake=nativeProvider((method,params)=>{
    if(method==='thread/queue/list')return {data:held.map(id=>({id})),nextCursor:null};
    if(method==='thread/queue/add'){const id=`sub-${++next}`;held.push(id);return {queuedSubmission:{id,input:params.input,clientUserMessageId:params.clientUserMessageId}};}
    if(method==='thread/queue/update')return {};
    if(method==='thread/queue/reorder'){held.splice(0,held.length,...(params.queuedSubmissionIds as string[]));return {};}
    if(method==='thread/queue/delete'){held.splice(held.indexOf(String(params.queuedSubmissionId)),1);return {deleted:true};}
    if(method==='thread/queue/start')return {turn:{id:'q-turn'}};
    return {};
  });
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>{fake.gate(false);fake.release();return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'warm up',requestId:'w'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.status==='completed','warm');
  fake.gate(true);
  await service.invoke('chat.send',{id:chat.id,text:'long task',requestId:'long'});
  await until(()=>fake.open,'running');
  const a=await service.invoke('chat.queue.add',{id:chat.id,text:'first follow-up',requestId:'qa'});
  const b=await service.invoke('chat.queue.add',{id:chat.id,text:'second follow-up',requestId:'qb'});
  await until(()=>held.length===2,'mirrored');
  assert.deepEqual(fake.calls.find(([method])=>method==='thread/queue/add')![1],{threadId:'thread-1',input:[{type:'text',text:'first follow-up',text_elements:[]}],clientUserMessageId:'qa'});
  await service.invoke('chat.queue.update',{id:chat.id,queueId:b.id,text:'second, edited'});
  assert.equal(fake.calls.find(([method])=>method==='thread/queue/update')![1].queuedSubmissionId,'sub-2');
  await service.invoke('chat.queue.move',{id:chat.id,queueId:b.id,direction:'up'});
  assert.deepEqual(fake.calls.find(([method])=>method==='thread/queue/reorder')![1].queuedSubmissionIds,['sub-2','sub-1']);
  fake.release();
  await until(()=>fake.methods().includes('thread/queue/start'),'native start');
  assert.equal(fake.inputs.length,2,'Muster did not send the queued row itself');
  // The app-server runs the head: its turn is adopted and the row disappears on thread/queue/changed.
  held.shift();
  fake.emit(chat.id,'turn/started',{threadId:'thread-1',turn:{id:'q-turn'}});
  fake.emit(chat.id,'item/started',{threadId:'thread-1',item:{type:'userMessage',id:'u1',content:[{type:'text',text:'second, edited'}]}});
  fake.emit(chat.id,'thread/queue/changed',{threadId:'thread-1'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.queue?.length===1,'sent row dropped');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.queue![0]!.id,a.id);
  fake.emit(chat.id,'turn/completed',{threadId:'thread-1',turn:{id:'q-turn',status:'completed'}});
  const items=(await service.invoke('chat.timeline',{id:chat.id})).items;
  assert.ok(items.some(item=>item.kind==='user'&&item.text==='second, edited'));
  await service.invoke('chat.queue.remove',{id:chat.id,queueId:a.id});
  assert.ok(fake.methods().includes('thread/queue/delete'));
  assert.equal(fake.inputs.length,2);
});

test('the queue stays Muster’s when the app-server lacks thread/queue/*',async t=>{
  const dataDir=await directory(t);
  const fake=nativeProvider(method=>{if(method.startsWith('thread/queue/'))throw rpcMissing();return {};});
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>{fake.gate(false);fake.release();return service.dispose();});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'warm up',requestId:'w'});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]!.status==='completed','warm');
  fake.gate(true);
  await service.invoke('chat.send',{id:chat.id,text:'long task',requestId:'long'});
  await until(()=>fake.open,'running');
  await service.invoke('chat.queue.add',{id:chat.id,text:'follow-up',requestId:'qa'});
  await new Promise(resolve=>setTimeout(resolve,20));
  fake.release();
  await until(()=>fake.inputs.length===3,'Muster dispatched it');
  assert.equal(fake.inputs[2]!.prompt,'follow-up');
  fake.release();
});
