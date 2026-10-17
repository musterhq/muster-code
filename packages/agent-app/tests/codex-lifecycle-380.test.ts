/** #380: Codex-route chats finish work as reliably as Codex itself. Core checks drive the real bundled core against a
 *  fake app-server over stdio; provider and service checks use fakes in the existing style. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {createRequire} from 'node:module';
import {existsSync} from 'node:fs';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,NO_LIVE_SESSION,steerFailure,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';

const bundle=resolve(import.meta.dirname,'../dist/runtime/core-client.cjs');
const skipCore=existsSync(bundle)?false:`${bundle} is missing; run npm run build first`;
type Core={
  runCodexAppServer(input:Record<string,unknown>):Promise<Record<string,unknown>>;
  openCodexConversation(input:Record<string,unknown>):Promise<{threadId:string}>;
  hasLiveCodexConversation(key:string,owner?:string):boolean;
  callCodexConversation(key:string,method:string,params:Record<string,unknown>,options:Record<string,unknown>):Promise<Record<string,unknown>>;
  clearCodexAppServerSessions(owner?:string):void;
};
async function directory(t:TestContext,prefix='muster-380-'){const path=await mkdtemp(join(tmpdir(),prefix));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,what='condition'){for(let i=0;i<400;i++){if(await check())return;await delay(5);}assert.fail(`${what} not reached`);}

/** One fake app-server; FAKE_MODE (sent through the run's env) picks its behaviour. */
async function fakeCodex(t:TestContext){
  const root=await directory(t);
  const server=join(root,'fake-app-server.cjs'),command=join(root,'fake-codex.sh');
  await writeFile(server,`const send=m=>process.stdout.write(JSON.stringify(m)+'\\n');const mode=process.env.FAKE_MODE;let threads=0;
process.stdin.on('end',()=>process.exit(0));
require('readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined||m.method===undefined)return;
  if(m.method==='thread/resume'){if(mode==='missing')return send({id:m.id,error:{code:-32600,message:'no rollout found for thread id '+m.params.threadId}});return send({id:m.id,result:{thread:{id:m.params.threadId}}});}
  if(m.method==='thread/start')return send({id:m.id,result:{thread:{id:'th-new-'+(++threads)}}});
  if(m.method==='thread/compact/start'){send({id:m.id,result:{}});return send({method:'thread/compacted',params:{threadId:m.params.threadId,turnId:'compact-1'}});}
  if(m.method==='turn/start'){const threadId=m.params.threadId,p={threadId,turnId:'tu-1'},text=m.params.input[0].text;send({id:m.id,result:{turn:{id:'tu-1'}}});
    send({method:'turn/started',params:{threadId,turn:{id:'tu-1'}}});
    if(mode==='subagent')send({method:'turn/started',params:{threadId:'child-thread',turn:{id:'child-turn'}}});
    if(mode==='missing')send({method:'error',params:{...p,error:{message:'stream disconnected'},willRetry:true}});
    const answer=mode==='missing'?text:'Done.';
    send({method:'item/agentMessage/delta',params:{...p,itemId:'m1',delta:answer}});
    send({method:'item/completed',params:{...p,item:{type:'agentMessage',id:'m1',text:answer}}});
    return send({method:'turn/completed',params:{threadId,turn:{id:'tu-1',status:'completed'}}});}
  send({id:m.id,result:{}});});`);
  await writeFile(command,`#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(server)} "$@"\n`,{mode:0o700});
  const core=createRequire(join(root,'x.cjs'))(bundle) as Core;
  return {root,command,core};
}

test('a warm app-server whose sub-agent is still running is never closed to make cache room',{skip:skipCore},async t=>{
  const {root,command,core}=await fakeCodex(t),owner=`owner-${randomUUID()}`;
  const previous=process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE='1';
  t.after(()=>{core.clearCodexAppServerSessions(owner);if(previous===undefined)delete process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE;else process.env.MUSTER_NATIVE_SESSION_CACHE_SIZE=previous;});
  const run=(cacheKey:string,mode:string)=>core.runCodexAppServer({prompt:'go',cwd:root,command,model:'m',cacheKey,transportOwner:owner,keepAlive:true,env:{FAKE_MODE:mode},onEvent(){},async onRequest(){return undefined;}});
  assert.equal((await run('chat-a','subagent')).status,'completed');
  assert.ok(core.hasLiveCodexConversation('chat-a',owner));
  // The cache holds one session; chat B needs room, but chat A's sub-agent turn has not completed.
  assert.equal((await run('chat-b','plain')).status,'completed');
  await delay(20);
  assert.ok(core.hasLiveCodexConversation('chat-a',owner),'the busy app-server (and its sub-agent) survives cache pruning');
});

test('a thread that cannot be resumed starts fresh with a seed digest, and willRetry errors reach the host',{skip:skipCore},async t=>{
  const {root,command,core}=await fakeCodex(t);
  const methods:string[]=[];let previousThread='';
  const result=await core.runCodexAppServer({prompt:'next question',cwd:root,command,model:'m',threadId:'th-old',keepAlive:false,env:{FAKE_MODE:'missing'},
    onThreadReset(previous:string){previousThread=previous;return 'Earlier conversation: hello';},onEvent(method:string){methods.push(method);}});
  assert.equal(result.status,'completed');
  assert.equal(previousThread,'th-old');
  assert.equal(result.threadReset,true);
  assert.equal(result.threadId,'th-new-1');
  assert.equal(result.finalMessage,'Earlier conversation: hello\n\nCurrent user request:\nnext question','the fresh thread gets the digest ahead of the prompt');
  assert.ok(methods.includes('error'),'Codex error notifications (willRetry) are forwarded');
});

test('a thread whose app-server idled out is re-opened warm so native compaction works again',{skip:skipCore},async t=>{
  const {root,command,core}=await fakeCodex(t),owner=`owner-${randomUUID()}`;t.after(()=>core.clearCodexAppServerSessions(owner));
  const events:string[]=[];
  assert.equal(core.hasLiveCodexConversation('chat-c',owner),false);
  await assert.rejects(core.callCodexConversation('chat-c','thread/compact/start',{threadId:'th-9'},{transportOwner:owner,requireOwner:true}),/No live app-server owner/);
  const opened=await core.openCodexConversation({cwd:root,command,model:'m',cacheKey:'chat-c',transportOwner:owner,threadId:'th-9',env:{FAKE_MODE:'plain'},onEvent(method:string){events.push(method);}});
  assert.equal(opened.threadId,'th-9');
  assert.ok(core.hasLiveCodexConversation('chat-c',owner));
  await core.callCodexConversation('chat-c','thread/compact/start',{threadId:'th-9'},{transportOwner:owner,requireOwner:true});
  await until(()=>events.includes('thread/compacted'),'thread/compacted observed');
});

const deferred=<T>()=>{let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return {promise,resolve};};
const providerInput=(id:string):ProviderInput=>({chat:{id,mode:'agent',providerId:'fixture'} as ProviderInput['chat'],cwd:'/unused',prompt:'test',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
const complete:ProviderResult={status:'completed',finalMessage:'done',dispatchState:'dispatched',threadId:'thread',turnId:'turn'};
function lifecycleCore(options:{reopen?:boolean}={}){
  const runs:{args:Record<string,unknown>;result:ReturnType<typeof deferred<ProviderResult>>}[]=[];
  const calls:string[]=[],opened:Record<string,unknown>[]=[];let live=true,steerRetries=0,steerError:Error|undefined;
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,
    runCodexAppServer(args){const result=deferred<ProviderResult>();runs.push({args,result});return result.promise;},
    async callCodexConversation(_key,method){if(!live)throw new Error('No live app-server owner for conversation x.');if(method==='turn/steer'&&steerError)throw steerError;calls.push(method);return {};},
    async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},
    async steerActiveCodexTurn(){steerRetries++;return true;},
    hasLiveCodexConversation(){return live;},
    ...(options.reopen===false?{}:{async openCodexConversation(input:Record<string,unknown>){opened.push(input);live=true;return {threadId:String(input.threadId)};}}),
  };
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  return {adapter,runs,calls,opened,setLive(value:boolean){live=value;},failSteer(error:Error){steerError=error;},get steerRetries(){return steerRetries;}};
}

test('/compact after the idle timer resumes the thread and compacts natively; without a resumable core it maps to NO_LIVE_SESSION',async t=>{
  const fake=lifecycleCore();t.after(()=>fake.adapter.dispose());
  const running=fake.adapter.run(providerInput('chat'));
  await until(()=>fake.runs.length===1);fake.runs[0]!.result.resolve(complete);await running;
  fake.setLive(false);
  await fake.adapter.compact!('chat');
  assert.equal(fake.opened.length,1,'the thread is re-opened on a fresh app-server');
  assert.equal(fake.opened[0]!.threadId,'thread');
  assert.equal(fake.opened[0]!.cacheKey,fake.runs[0]!.args.cacheKey,'same conversation, same launch');
  assert.equal(fake.opened[0]!.developerInstructions,fake.runs[0]!.args.developerInstructions);
  assert.equal(typeof fake.opened[0]!.onRequest,'function','approvals on the re-opened thread still reach the chat');
  assert.deepEqual(fake.calls,['thread/compact/start']);

  const legacy=lifecycleCore({reopen:false});t.after(()=>legacy.adapter.dispose());
  const legacyRun=legacy.adapter.run(providerInput('chat'));
  await until(()=>legacy.runs.length===1);legacy.runs[0]!.result.resolve(complete);await legacyRun;
  legacy.setLive(false);
  await assert.rejects(legacy.adapter.compact!('chat'),(error:Error)=>error.message===NO_LIVE_SESSION,'the service then compacts from the saved transcript');
});

test('background turns of an app-server that has exited no longer block release or a provider switch',async t=>{
  const fake=lifecycleCore();t.after(()=>fake.adapter.dispose());
  const running=fake.adapter.run(providerInput('chat'));
  await until(()=>fake.runs.length===1);
  const onEvent=fake.runs[0]!.args.onEvent as (method:string,params:Record<string,unknown>)=>void;
  onEvent('turn/started',{threadId:'child-thread',turn:{id:'child-turn'}});
  fake.runs[0]!.result.resolve(complete);await running;
  assert.equal(fake.adapter.hasActiveWork!('chat'),true,'a live sub-agent is active work');
  await assert.rejects(fake.adapter.release!('chat'),/background agents/);
  fake.setLive(false);
  assert.equal(fake.adapter.hasActiveWork!('chat'),false,'a dead app-server holds no work');
  await fake.adapter.release!('chat');
});

test('a steer that timed out is treated as delivered: never retried, never queued',async t=>{
  assert.equal(steerFailure(new Error('codex app-server method turn/steer timed out')),'uncertain');
  assert.equal(steerFailure(new Error('no active turn to steer')),false);
  const fake=lifecycleCore();t.after(()=>fake.adapter.dispose());
  const running=fake.adapter.run(providerInput('chat'));
  await until(()=>fake.runs.length===1);
  (fake.runs[0]!.args.onTurnAccepted as (identity:Record<string,unknown>)=>void)({threadId:'thread',turnId:'turn',dispatchState:'dispatched'});
  fake.failSteer(new Error('codex app-server method turn/steer timed out'));
  assert.equal(await fake.adapter.steer!('chat','also run the tests'),true);
  assert.equal(fake.steerRetries,0,'no second turn/steer');
  fake.runs[0]!.result.resolve(complete);await running;
});

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function serviceWith(t:TestContext,run:ProviderAdapter['run'],extra:Partial<ProviderAdapter>={}){
  const dataDir=await directory(t,'muster-380-service-');
  const service=createAgentService({dataDir,provider:{info,run,stop:async()=>true,dispose(){},...extra},onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
  const items=()=>service.invoke('chat.select',{id:chat.id});
  const status=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!.status;
  return {service,chat,items,status};
}

test('approvals asked after the turn ended (background sub-agents) get a card instead of a silent decline',async t=>{
  let captured:ProviderInput|undefined;let during:Promise<Record<string,unknown>|undefined>|undefined;
  const {service,chat,items,status}=await serviceWith(t,async input=>{
    captured=input;
    during=input.onRequest('item/commandExecution/requestApproval',{command:'npm test',threadId:'child-thread'});
    await delay(5);
    return {status:'completed',finalMessage:'done',dispatchState:'dispatched'};
  },{hasActiveWork:()=>true});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
  await until(async()=>await status()==='completed','run settled');
  const pending=(await items()).find(item=>item.kind==='approval');
  assert.equal(pending?.status,'pending','a sub-agent card asked during the turn stays answerable after it ends');
  const after=captured!.onRequest('item/fileChange/requestApproval',{itemId:'edit',threadId:'child-thread'});
  let card;await until(async()=>!!(card=(await items()).find(item=>item.kind==='approval'&&item.id!==pending!.id)),'idle approval card');
  await service.invoke('approval.respond',{id:pending!.id,approved:true,decision:'accept'});
  await service.invoke('approval.respond',{id:card!.id,approved:true,decision:'accept'});
  assert.deepEqual(await during,{decision:'accept'});
  assert.deepEqual(await after,{decision:'accept'});
});

test('a final answer that arrives only on item/completed is kept even after an earlier message streamed',async t=>{
  const {service,chat,items,status}=await serviceWith(t,async input=>{
    input.onEvent('item/agentMessage/delta',{itemId:'m1',delta:'Looking into it.'});input.onDelta('Looking into it.');
    input.onEvent('item/completed',{item:{type:'agentMessage',id:'m1',text:'Looking into it.'}});
    input.onEvent('item/completed',{item:{type:'agentMessage',id:'m2',text:'The fix is in place.'}});
    return {status:'completed',finalMessage:'The fix is in place.',dispatchState:'dispatched'};
  });
  await service.invoke('chat.send',{id:chat.id,text:'fix it',requestId:randomUUID()});
  await until(async()=>await status()==='completed','run settled');
  assert.deepEqual((await items()).filter(item=>item.kind==='assistant').map(item=>item.text),['Looking into it.','The fix is in place.']);
});

test('willRetry errors show Reconnecting… until the stream resumes',async t=>{
  const {service,chat,items,status}=await serviceWith(t,async input=>{
    input.onEvent('error',{error:{message:'stream disconnected before completion'},willRetry:true});
    input.onEvent('error',{error:{message:'stream disconnected before completion'},willRetry:true});
    input.onEvent('item/agentMessage/delta',{itemId:'m1',delta:'Back.'});input.onDelta('Back.');
    return {status:'completed',finalMessage:'Back.',dispatchState:'dispatched'};
  });
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
  await until(async()=>await status()==='completed','run settled');
  const notices=(await items()).filter(item=>item.data?.kind==='reconnecting');
  assert.equal(notices.length,1,'one row, updated in place');
  assert.equal(notices[0]!.text,'Reconnected.');
  assert.equal(notices[0]!.status,'completed');
});

test('a resume that falls back to a fresh thread says so and seeds the earlier conversation',async t=>{
  let seed:string|undefined;let turn=0;
  const {service,chat,items,status}=await serviceWith(t,async input=>{
    turn++;
    if(turn===2)seed=input.onThreadReset?.('thread-1');
    return {status:'completed',finalMessage:turn===1?'Paris.':'About 2 million.',dispatchState:'dispatched',threadId:`thread-${turn}`,turnId:`turn-${turn}`,...(turn===2?{threadReset:true}:{})};
  });
  await service.invoke('chat.send',{id:chat.id,text:'Capital of France?',requestId:randomUUID()});
  await until(async()=>await status()==='completed','first run');
  await service.invoke('chat.send',{id:chat.id,text:'Population?',requestId:randomUUID()});
  await until(async()=>(await items()).filter(item=>item.kind==='assistant').length===2,'second run');
  assert.match(seed??'',/User: Capital of France\?[\s\S]*Assistant: Paris\./);
  assert.doesNotMatch(seed??'',/Population\?/,'the current request is sent once, after the digest');
  assert.ok((await items()).some(item=>item.data?.kind==='thread-reset'),'the user is told the provider conversation restarted');
});
