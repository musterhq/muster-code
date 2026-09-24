import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {goalTiming} from '../src/runtime/domains/goals.ts';
import {GOAL_MAX_AUTO_TURNS} from '../src/shared/domains/goals-protocol.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';

goalTiming.continueDelayMs=5;
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-goals-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
/** Each run waits for `release`; `reply` decides the final message. */
function fakeProvider(reply:(input:ProviderInput,index:number)=>ProviderResult,gated=false){
  const inputs:ProviderInput[]=[];let gate:PromiseWithResolvers<void>|undefined;
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);if(gated){gate=Promise.withResolvers();await gate.promise;}return reply(input,inputs.length-1);},stop:async()=>true,dispose(){}};
  return {provider,inputs,release(){const current=gate;gate=undefined;current?.resolve();},get open(){return Boolean(gate);}};
}
const progress:ProviderResult={status:'completed',finalMessage:'Made progress.'};

test('a goal kicks off, auto-continues, and stops on update_goal(status="complete"); it survives a restart',async t=>{
  const dataDir=await directory(t);
  const fake=fakeProvider((_input,index)=>index<2?progress:{status:'completed',finalMessage:'All done.\nupdate_goal(status="complete")'});
  let service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  const goal=await service.invoke('goals.set',{chatId:chat.id,text:'Ship the release'});
  assert.equal(goal.status,'active');assert.equal(goal.maxTurns,GOAL_MAX_AUTO_TURNS);
  await until(async()=>(await service.invoke('goals.get',{chatId:chat.id}))?.status==='complete','goal done');
  assert.equal(fake.inputs.length,3,'kickoff plus two continuations');
  // Goal turns carry only a short request; the objective travels as developer instructions instead.
  assert.equal(fake.inputs[0].prompt,'Start working toward the goal.');
  assert.equal(fake.inputs[1].prompt,'Continue working toward the goal.');
  assert.match(fake.inputs[0].developerInstructions??'',/keep pursuing it[\s\S]*Ship the release[\s\S]*update_goal\(status="complete"\)/);
  const done=(await service.invoke('app.snapshot',undefined)).chats[0]!.goal!;
  assert.equal(done.status,'complete');assert.equal(done.turns,2);assert.ok(done.completedAt);assert.equal(done.startedAt,null);
  const notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='goal-continue').map(item=>item.text);
  // No turn count in the continuation notice either -- there's no cap to count turns against.
  assert.deepEqual(notices,['Goal set · pursuing','Continuing goal…','Continuing goal…']);
  await settle();assert.equal(fake.inputs.length,3,'nothing runs after completion');
  await service.dispose();
  service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.goal?.text,'Ship the release','restored from the runtime store');
  await service.invoke('goals.clear',{chatId:chat.id});
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]!.goal,undefined);
  await service.dispose();
});

// Superseded: this used to assert the loop auto-paused at GOAL_MAX_AUTO_TURNS ('budget_limited').
// Muster imposes no turn cap of its own -- only the user, or a provider-reported usage/budget
// limit, stops a goal -- so the cap enforcement was removed from goals.ts. This now asserts the
// opposite: turns keep counting past the old cap with no automatic pause, and only an explicit
// user pause stops it.
test('the goal loop has no automatic turn cap; only an explicit pause stops it',async t=>{
  const dataDir=await directory(t),fake=fakeProvider(()=>progress);
  let service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.dispose();
  // Seed a goal already well past the old GOAL_MAX_AUTO_TURNS cap, merely 'paused' (not
  // 'budget_limited'/'complete', which reset the turn count on resume) -- exercises exactly the
  // `goal.turns >= goal.maxTurns` check that used to halt the loop, without needing to actually
  // run 100+ real turns through the full service pipeline first (slow, and load-sensitive).
  const now=new Date().toISOString();
  const store=new AgentStore(dataDir);
  store.database().prepare('INSERT INTO chat_goals (chat_id, text, status, reason, created_at, started_at, accumulated_ms, turns, max_turns, updated_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(chat.id,'Never finishes','paused','user',now,null,0,GOAL_MAX_AUTO_TURNS+5,GOAL_MAX_AUTO_TURNS,now,null);
  store.close();
  service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const resumed=await service.invoke('goals.resume',{chatId:chat.id});
  assert.equal(resumed.status,'active');assert.equal(resumed.turns,GOAL_MAX_AUTO_TURNS+5,'resuming a paused (not limited) goal keeps its turns count');
  await until(()=>fake.inputs.length>=1,'auto-continues past the old cap');
  const goal=(await service.invoke('goals.get',{chatId:chat.id}))!;
  assert.equal(goal.status,'active','no automatic pause even though turns exceeds the old cap');
  assert.ok(goal.turns>GOAL_MAX_AUTO_TURNS,'turns keep counting past the old cap');
  const paused=await service.invoke('goals.pause',{chatId:chat.id});
  assert.equal(paused.status,'paused');assert.equal(paused.reason,'user','only an explicit pause stops it');
});

test('pause prevents dispatch; a queued user message goes before the continuation; failures pause',async t=>{
  const dataDir=await directory(t),fake=fakeProvider((_input,index)=>index>=3?{status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'failed',retryable:true,reason:'Upstream error.'}}:progress,true);
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});
  await until(()=>fake.open);
  // Set while running: no kickoff; the goal is picked up when this turn settles.
  await service.invoke('goals.set',{chatId:chat.id,text:'Refactor'});
  assert.equal(fake.inputs.length,1);
  const paused=await service.invoke('goals.pause',{chatId:chat.id});
  assert.equal(paused.status,'paused');assert.equal(paused.reason,'user');
  fake.release();await settle();
  assert.equal(fake.inputs.length,1,'a paused goal never dispatches');
  await service.invoke('goals.resume',{chatId:chat.id});
  await until(()=>fake.open&&fake.inputs.length===2,'resume');
  assert.equal(fake.inputs[1].prompt,'Continue working toward the goal.');
  await service.invoke('chat.queue.add',{id:chat.id,text:'user follow-up',requestId:'follow'});
  fake.release();
  await until(()=>fake.inputs.length===3,'queued message');
  assert.equal(fake.inputs[2].prompt,'user follow-up','the queue wins over the goal loop');
  fake.release();
  await until(()=>fake.inputs.length===4,'continuation after the queue');
  assert.equal(fake.inputs[3].prompt,'Continue working toward the goal.');
  // One retryable failure alone no longer blocks the goal -- GOAL_STALL_TURNS consecutive failures
  // does (each success in between resets the counter, exercised above by the queued follow-up).
  fake.release();
  await until(()=>fake.inputs.length===5,'first failing continuation retries');
  fake.release();
  await until(()=>fake.inputs.length===6,'second failing continuation retries');
  fake.release();
  await until(async()=>(await service.invoke('goals.get',{chatId:chat.id}))?.status==='blocked','third failure blocks the goal');
  assert.equal((await service.invoke('goals.get',{chatId:chat.id}))!.reason,'failed');
  await settle();assert.equal(fake.inputs.length,6);
  await assert.rejects(service.invoke('goals.set',{chatId:chat.id,text:'  '}),/Describe the goal/);
  await assert.rejects(service.invoke('goals.pause',{chatId:'missing'}),/no goal/);
});
