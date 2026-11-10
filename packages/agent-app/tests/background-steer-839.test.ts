/** #839: a message sent while a chat only runs background work (Codex sub-agents, Claude Code background shells) reaches
 *  the agent now, instead of waiting in the queue until that work ends. A steer during a normal turn is unchanged. */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {claudeCodeAdapter,claudeSteerText,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter,type CoreClient,type ProviderResult} from '../src/runtime/provider.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await tick();}assert.fail(`${label} not reached`);}
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-839-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

/** A Codex app-server double: each turn Muster dispatches waits for `finish`; later notifications go through the
 *  last run's observers, as the warm app-server reports them between runs. */
function codexCore(){
  const runs:Array<{args:Record<string,any>;done:(result:ProviderResult)=>void}>=[];
  const calls:Array<{method:string;params:Record<string,any>}>=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,
    runCodexAppServer:(args:Record<string,any>)=>new Promise(done=>{runs.push({args,done});
      const turnId=`turn-${runs.length}`;args.onThreadReady('thread-1');args.onTurnAccepted({threadId:'thread-1',turnId,dispatchState:'dispatched'});
      args.onEvent('turn/started',{threadId:'thread-1',turn:{id:turnId}});}),
    async callCodexConversation(_key:string,method:string,params:Record<string,any>){calls.push({method,params});return {};},
    async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){},hasLiveCodexConversation(){return true;},
  } as unknown as CoreClient;
  const emit=(method:string,params:Record<string,unknown>)=>runs.at(-1)!.args.onEvent(method,params);
  const finish=()=>{const turnId=`turn-${runs.length}`;emit('turn/completed',{threadId:'thread-1',turn:{id:turnId,status:'completed'}});
    runs.at(-1)!.done({status:'completed',finalMessage:'Started the sub-agent.',dispatchState:'dispatched',threadId:'thread-1',turnId});};
  return {core,runs,calls,emit,finish};
}
async function codexChat(t:TestContext){
  const fake=codexCore();
  const provider=createProviderAdapter({core:fake.core,available:()=>true,command:'/unused'});
  const service=createAgentService({dataDir:await directory(t),provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.selectProvider',{id:chat.id,providerId:'fixture',model:'fixture-model'});
  const snapshot=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!;
  const users=async()=>(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='user').map(item=>item.text);
  // The first turn starts a sub-agent and ends; the sub-agent keeps running in the background.
  await service.invoke('chat.send',{id:chat.id,text:'start a sub-agent',requestId:'first'});
  await until(()=>fake.runs.length===1,'first turn');
  fake.emit('turn/started',{threadId:'child-thread',turn:{id:'child-turn'}});
  fake.finish();
  await until(async()=>(await snapshot()).status==='completed','first turn settled');
  return {fake,provider,service,chat,snapshot,users};
}

// Spec: MUS-SPEC-02-839A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-839a)
test('Codex: with only a sub-agent running, a message starts a new turn on the same thread at once',async t=>{
  const {fake,provider,service,chat,snapshot,users}=await codexChat(t);
  assert.equal(provider.hasActiveWork!(chat.id),true,'the sub-agent is still working');
  await service.invoke('chat.send',{id:chat.id,text:'meanwhile, check the docs',requestId:'second'});
  await until(()=>fake.runs.length===2,'second turn dispatched');
  assert.equal(fake.runs[1]!.args.threadId,'thread-1','same thread');
  assert.equal(fake.runs[1]!.args.prompt,'meanwhile, check the docs');
  assert.equal((await snapshot()).status,'running');
  assert.equal(provider.hasActiveWork!(chat.id),true,'the sub-agent keeps running');
  fake.finish();
  await until(async()=>(await snapshot()).status==='completed','second turn settled');
  assert.deepEqual(await users(),['start a sub-agent','meanwhile, check the docs']);
});

// Spec: MUS-SPEC-02-839B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-839b)
test('Codex: while the app-server runs a parent turn on its own (a sub-agent reporting back), a steer joins that turn',async t=>{
  const {fake,service,chat,snapshot,users}=await codexChat(t);
  // The sub-agent reports back; the app-server starts a parent turn itself and Muster adopts it.
  fake.emit('turn/started',{threadId:'thread-1',turn:{id:'notify-turn'}});
  await until(async()=>(await snapshot()).status==='running','adopted turn');
  const outcome=await service.invoke('chat.steer',{id:chat.id,text:'also update the changelog',requestId:'steer-1'});
  assert.deepEqual(outcome,{steered:true});
  const steer=fake.calls.find(call=>call.method==='turn/steer');
  assert.deepEqual(steer?.params,{threadId:'thread-1',expectedTurnId:'notify-turn',input:[{type:'text',text:'also update the changelog'}]});
  // The app-server records the steer as a user message of that turn: the transcript still shows it once.
  fake.emit('item/started',{threadId:'thread-1',turnId:'notify-turn',item:{type:'userMessage',id:'u-steer',content:[{type:'text',text:'also update the changelog'}]}});
  fake.emit('turn/completed',{threadId:'thread-1',turn:{id:'notify-turn',status:'completed'}});
  await until(async()=>(await snapshot()).status==='completed','adopted turn settled');
  assert.deepEqual(await users(),['start a sub-agent','also update the changelog']);
  assert.equal(fake.runs.length,1,'no second turn was dispatched for it');
});

// Spec: MUS-SPEC-02-839C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-839c)
test('Codex: Steer on a queued message during that turn sends it once and empties the queue',async t=>{
  const {fake,service,chat,snapshot,users}=await codexChat(t);
  fake.emit('turn/started',{threadId:'thread-1',turn:{id:'notify-turn'}});
  await until(async()=>(await snapshot()).status==='running','adopted turn');
  const queued=await service.invoke('chat.queue.add',{id:chat.id,text:'queued while it reported back',requestId:'queued-1'});
  const outcome=await service.invoke('chat.queue.steer',{id:chat.id,queueId:queued.id});
  assert.deepEqual(outcome,{steered:true,started:false});
  assert.equal((await snapshot()).queue,undefined,'the queue is empty');
  assert.equal(fake.calls.filter(call=>call.method==='turn/steer').length,1);
  fake.emit('turn/completed',{threadId:'thread-1',turn:{id:'notify-turn',status:'completed'}});
  await until(async()=>(await snapshot()).status==='completed','adopted turn settled');
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(fake.runs.length,1,'the steered message is not sent again as a turn');
  assert.deepEqual(await users(),['start a sub-agent','queued while it reported back']);
});

/** A Claude Code process double: tests write stream-json lines to stdout and read what was written to stdin. */
function claudeChild(){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill(signal?:string):boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let stdin='',ended=false;child.stdin.on('data',d=>{stdin+=d;});child.stdin.on('finish',()=>{ended=true;});
  return {child,emit:(...lines:unknown[])=>{for(const l of lines)child.stdout.write(JSON.stringify(l)+'\n');},
    close:(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));},
    messages:()=>stdin.trim().split('\n').map(line=>JSON.parse(line).message.content[0].text as string),get ended(){return ended;}};
}
function claudeRun(fake:ReturnType<typeof claudeChild>){
  const adapter=claudeCodeAdapter({binary:'/bin/claude',steerGraceMs:20,spawn:(()=>fake.child as unknown as ChildProcess) as Spawn});
  let send!:(text:string)=>boolean|{refused:string};
  const running=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'start the dev server',model:'claude-code/opus',permissionMode:'workspace',signal:new AbortController().signal,
    onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  return {running,send:(text:string)=>send(text)};
}
const backgroundBash={type:'assistant',message:{id:'m1',content:[{type:'tool_use',id:'bash-1',name:'Bash',input:{command:'npm run dev',run_in_background:true}}]}};
const bashLaunched={type:'user',message:{content:[{type:'tool_result',tool_use_id:'bash-1',content:'Command running in background with ID: shell-1'}]}};

// Spec: MUS-SPEC-02-839D (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-839d)
test('Claude Code: after the turn ends with a background shell running, a steer still reaches the open session',async()=>{
  const fake=claudeChild(),run=claudeRun(fake);
  await tick();
  fake.emit({type:'system',subtype:'init',session_id:'s'},backgroundBash,
    {type:'system',subtype:'background_tasks_changed',tasks:[{task_id:'shell-1',task_type:'local_bash',description:'npm run dev'}]},bashLaunched,
    {type:'result',subtype:'success',result:'The dev server is starting.'});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(fake.ended,false,'stdin stays open while the CLI lists a background task');
  assert.equal(run.send('now open the settings page'),true);
  assert.deepEqual(fake.messages(),['start the dev server',claudeSteerText('now open the settings page')]);
  fake.emit({type:'assistant',message:{id:'m2',content:[{type:'text',text:'Opening it.'}]}},{type:'result',subtype:'success',result:'Opened.'});
  await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(fake.ended,false,'the shell is still listed');
  fake.emit({type:'system',subtype:'background_tasks_changed',tasks:[]});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fake.ended,true,'stdin closes once no background task is left');
  fake.close(0);
  assert.equal((await run.running).status,'completed');
});

// Spec: MUS-SPEC-02-839E (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-839e)
test('Claude Code: when the session can no longer take a message during a background shell, the steer says why',async()=>{
  const fake=claudeChild(),run=claudeRun(fake);
  await tick();
  // An older CLI that does not list its background tasks: stdin closes after the result while the shell keeps the process alive.
  fake.emit({type:'system',subtype:'init',session_id:'s'},backgroundBash,bashLaunched,{type:'result',subtype:'success',result:'The dev server is starting.'});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(fake.ended,true);
  const outcome=run.send('now open the settings page');
  assert.equal(typeof outcome,'object','a refusal with a reason, not a silent false');
  assert.match((outcome as {refused:string}).refused,/background command/);
  fake.close(0);
  assert.equal((await run.running).status,'completed');
});
