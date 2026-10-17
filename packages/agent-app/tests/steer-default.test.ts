import assert from 'node:assert/strict';
import {test} from 'node:test';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import type {ChildProcess} from 'node:child_process';
import {claudeCodeAdapter,claudeSteerText,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import {openAICompatibleAdapter} from '../src/runtime/adapters/http-chat.ts';
import {createProviderAdapter,type CoreClient,type ProviderInput} from '../src/runtime/provider.ts';
import {followUpAction} from '../src/renderer/components/composerMenus.ts';

const tick=()=>new Promise(resolve=>setImmediate(resolve));

// ---- Enter while running: Steer by default, Queue opt-in; Cmd/Ctrl+Enter does the other one ----
// The store's default (Steer with nothing stored) is checked by tests/composer-components.tsx, which loads the renderer.
test('Cmd/Ctrl+Enter does the opposite of the setting for one message',()=>{
  assert.equal(followUpAction('steer',false),'steer');assert.equal(followUpAction('steer',true),'queue');
  assert.equal(followUpAction('queue',false),'queue');assert.equal(followUpAction('queue',true),'steer');
});

// ---- Claude Code: a steer is framed so the model folds it in and keeps working ----
function fakeChild(){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill():boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  let stdin='';child.stdin.on('data',d=>{stdin+=d;});
  return {child,emit:(...lines:unknown[])=>{for(const l of lines)child.stdout.write(JSON.stringify(l)+'\n');},close:(code:number)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));},stdin:()=>stdin};
}
test('Claude Code: a steer tells the model to continue the current task, and the run stays open until the work after it ends',async()=>{
  const fake=fakeChild();let ended=false;fake.child.stdin.on('finish',()=>{ended=true;});
  const adapter=claudeCodeAdapter({binary:'/bin/claude',steerGraceMs:30,spawn:(()=>fake.child as unknown as ChildProcess) as Spawn});
  let send!:(text:string)=>boolean;
  const running=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'build the page',model:'claude-code/opus',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  await tick();fake.emit({type:'system',subtype:'init',session_id:'s'},{type:'assistant',message:{content:[{type:'text',text:'working'}]}});
  assert.equal(send('use blue, not red'),true);
  const steer=JSON.parse(fake.stdin().trim().split('\n')[1]).message.content[0].text as string;
  assert.equal(steer,claudeSteerText('use blue, not red'));
  assert.match(steer,/continue the current task/);assert.match(steer,/do not stop after acknowledging it/);assert.ok(steer.endsWith('use blue, not red'));
  // The steer's result arrives, then the task keeps going (another turn): stdin must stay open through it.
  fake.emit({type:'result',subtype:'success',result:'Switched to blue.'});await tick();
  assert.equal(ended,false,'not closed on the steer’s result');
  fake.emit({type:'assistant',message:{content:[{type:'text',text:'continuing the page'}]}});await new Promise(resolve=>setTimeout(resolve,60));
  assert.equal(ended,false,'work after the result keeps the run open past the grace window');
  fake.emit({type:'result',subtype:'success',result:'Page done in blue.'});await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(ended,true);fake.close(0);
  assert.deepEqual([(await running).status,(await running).finalMessage],['completed','Page done in blue.']);
});

// ---- HTTP route: a steer the loop can no longer read is refused (so it queues), never accepted and dropped ----
const enc=new TextEncoder();
const sse=(...events:unknown[])=>new Response(new ReadableStream({start(c){for(const e of events)c.enqueue(enc.encode(`data: ${JSON.stringify(e)}\n\n`));c.enqueue(enc.encode('data: [DONE]\n\n'));c.close();}}),{status:200});
test('HTTP route: at the turn’s tool-call cap, accepted steers reach the closing request and later ones are refused',async()=>{
  let send!:(text:string)=>boolean;const bodies:any[]=[];let rounds=0,lateSteer:boolean|undefined,acceptedSteer:boolean|undefined;
  const calls=Array.from({length:16},(_,i)=>({index:i,id:`c${i}`,function:{name:'nope',arguments:'{}'}}));
  const adapter=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'k',label:'Example',tools:true,
    fetch:async(_url,init)=>{const body=JSON.parse(String(init?.body));bodies.push(body);
      if(!body.tools){lateSteer=send('too late');return sse({choices:[{delta:{content:'Status: done so far.'}}]});}
      rounds++;
      // 63 rounds of 16 calls reach the 1000-call cap; a steer during the last tool round is already accepted.
      if(rounds===63)acceptedSteer=send('also check the footer');
      return sse({choices:[{delta:{tool_calls:calls}}]});}});
  const result=await adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'go',model:'m',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  assert.equal(result.status,'completed');
  assert.equal(acceptedSteer,true);
  assert.equal(lateSteer,false,'a steer during the closing status can never be read: refused so it queues');
  const closing=bodies.at(-1);assert.ok(!closing.tools);
  assert.ok(closing.messages.some((m:any)=>m.role==='user'&&m.content==='also check the footer'),'the accepted steer is in the last request');
  assert.equal(send('after'),false);
});
test('HTTP route: once the final stream has finished, a steer is refused',async()=>{
  let send!:(text:string)=>boolean;let release!:()=>void;
  const adapter=openAICompatibleAdapter({endpoint:'https://llm.example/v1',apiKey:()=>'k',label:'Example',tools:false,
    fetch:async()=>new Response(new ReadableStream({start(c){c.enqueue(enc.encode(`data: ${JSON.stringify({choices:[{delta:{content:'hi'}}]})}\n\n`));release=()=>{c.enqueue(enc.encode('data: [DONE]\n\n'));c.close();};}}),{status:200})});
  const running=adapter.run({chat:{id:'c'} as any,cwd:'/w',prompt:'go',model:'m',permissionMode:'workspace',signal:new AbortController().signal,onThreadReady(){},onTurnAccepted(){},onDelta(){},onReasoning(){},onEvent(){},onSteerable:fn=>{send=fn;}});
  for(let i=0;i<200&&!release;i++)await tick();
  release();const result=await running;
  assert.equal(result.status,'completed');assert.equal(send('late'),false);
});

// ---- Codex: steer errors surface as a reason (the message queues) instead of being swallowed ----
function codex(core:Partial<CoreClient>&{steerActiveCodexTurn?:CoreClient['steerActiveCodexTurn']}){
  let resolve!:(r:any)=>void;
  const full={CODEX_RUN_LIFECYCLE_VERSION:1,runCodexAppServer:(launch:any)=>new Promise(done=>{resolve=done;launch.onThreadReady('th');launch.onTurnAccepted({threadId:'th',turnId:'turn-1',dispatchState:'dispatched'});}),
    async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){},...core} as unknown as CoreClient;
  const adapter=createProviderAdapter({core:full,available:()=>true,command:'/unused'});
  const pending=adapter.run({chat:{id:'x',mode:'agent',providerId:'fixture',model:'fixture-model'},cwd:'/w',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}} as unknown as ProviderInput);
  return {adapter,async done(){resolve({status:'completed',finalMessage:'',dispatchState:'dispatched',threadId:'th',turnId:'turn-1'});await pending;adapter.dispose();}};
}
test('Codex: when the fallback steer throws, the reason comes back and the message is not reported as steered',async()=>{
  const run=codex({async callCodexConversation(){throw new Error('expected turn mismatch');},async steerActiveCodexTurn(){throw new Error('app-server connection closed');}} as any);
  await tick();
  const outcome=await run.adapter.steer!('x','also this');
  assert.deepEqual(outcome,{refused:'The agent couldn’t take this message mid-run (app-server connection closed).'});
  await run.done();
});
test('Codex: a transport error with no fallback is surfaced too; "no active turn" still queues quietly',async()=>{
  const run=codex({async callCodexConversation(){throw new Error('socket hang up.');},steerActiveCodexTurn:undefined} as any);
  await tick();
  assert.deepEqual(await run.adapter.steer!('x','also this'),{refused:'The agent couldn’t take this message mid-run (socket hang up).'});
  await run.done();
  const idle=codex({async callCodexConversation(){throw new Error('no active turn to steer');}} as any);
  await tick();
  assert.equal(await idle.adapter.steer!('x','also this'),false);
  await idle.done();
});
test('Codex: a fallback that answers false after a failed steer reports the first error',async()=>{
  const run=codex({async callCodexConversation(){throw new Error('expected turn mismatch');},async steerActiveCodexTurn(){return false;}} as any);
  await tick();
  assert.deepEqual(await run.adapter.steer!('x','hi'),{refused:'The agent couldn’t take this message mid-run (expected turn mismatch).'});
  await run.done();
});
