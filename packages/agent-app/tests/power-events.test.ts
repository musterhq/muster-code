import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createPowerEvents,type ResumeInfo} from '../src/runtime/power-events.ts';
import {RepoPoller,type RepoEvent,type RepoSnapshot} from '../src/runtime/repo-triggers.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {automationTiming} from '../src/runtime/domains/automations.ts';
import {createProviderAdapter,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';

const at=(value:string)=>Date.parse(value);
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await pause(2);}assert.fail(`${label} not reached`);}
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-power-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('coordinator: suspend then resume reports the sleep; repeats and lock/unlock are no-ops; a failing hook never blocks the rest',async()=>{
  let clock=1_000;const log:string[]=[];const resumes:ResumeInfo[]=[];
  const power=createPowerEvents({now:()=>clock,log:message=>log.push(message),participants:[
    {name:'broken',suspend(){throw new Error('boom');},resume(){throw new Error('boom');}},
    {name:'timers',suspend:()=>{log.push('paused');},resume:info=>{resumes.push(info);}},
  ]});
  const suspended=await power.handle('suspend');
  assert.equal(suspended.handled,true);assert.deepEqual(suspended.failures.map(f=>f.name),['broken']);assert.ok(log.includes('paused'),'later participants still run');
  assert.equal(power.suspended(),true);
  clock+=10;assert.equal((await power.handle('suspend')).handled,false,'a repeated suspend keeps the first instant');
  assert.equal((await power.handle('lock-screen')).handled,false);
  clock=1_000+8*3_600_000;
  const resumed=await power.handle('resume');
  assert.equal(resumed.handled,true);assert.equal(resumed.sleptMs,8*3_600_000);
  assert.deepEqual(resumes,[{at:clock,suspendedAt:1_000,sleptMs:8*3_600_000}]);
  assert.equal((await power.handle('resume')).handled,false,'a duplicate resume fires nothing again');
  assert.equal((await power.handle('unlock-screen')).handled,false);
  assert.equal(resumes.length,1);
  // Resume without suspend (dark wake / missed event), well after the last one, still re-checks once.
  clock+=60_000;const lone=await power.handle('resume');
  assert.equal(lone.handled,true);assert.equal(lone.sleptMs,0);assert.equal(resumes.at(-1)!.suspendedAt,null);
  await assert.rejects(power.handle('hibernate' as never),/Unknown power state/);
});

test('coordinator: resume waits for slow suspend hooks, so transitions never interleave',async()=>{
  const order:string[]=[];let release!:()=>void;
  const power=createPowerEvents({participants:[{name:'slow',suspend:()=>new Promise<void>(resolve=>{release=()=>{order.push('suspended');resolve();};}),resume:()=>{order.push('resumed');}}]});
  const s=power.handle('suspend'),r=power.handle('resume');
  await pause(5);assert.deepEqual(order,[]);
  release();await Promise.all([s,r]);
  assert.deepEqual(order,['suspended','resumed']);
});

test('repo triggers: sleep pauses polling; wake takes a fresh baseline instead of replaying the gap',async()=>{
  const snap=(head:string):RepoSnapshot=>({pulls:{},branch:'main',branchHead:head,failed:[]});
  let current=snap('m1');const received:RepoEvent[][]=[];
  const timers=new Map<number,()=>void>();let next=0;
  const poller=new RepoPoller({read:async()=>current,onEvents:(_w,events)=>received.push(events),baseMs:100,maxMs:1000,
    setTimer:fn=>{timers.set(++next,fn);return next;},clearTimer:handle=>{timers.delete(handle as number);}});
  // Fires every armed poll timer, as the event loop would.
  const fire=async()=>{const due=[...timers.entries()];timers.clear();for(const [,fn] of due)fn();await pause(1);};
  poller.watch({folderId:'f',checks:false});const key=poller.keys()[0]!;
  await fire();assert.equal(received.length,0,'baseline');
  assert.equal(timers.size,1,'the next poll is armed');
  poller.suspend();
  assert.equal(timers.size,0,'no poll is armed while asleep');
  current=snap('m2');
  await poller.poll(key);assert.equal(received.length,0,'a stray poll while asleep does nothing');
  assert.equal(timers.size,0);
  poller.resume();
  assert.equal(timers.size,1,'one immediate re-check on wake');
  await fire();
  assert.equal(received.length,0,'the commit made during the sleep is the new baseline, not a replayed event');
  current=snap('m3');await fire();
  assert.deepEqual(received.map(events=>events[0]!.kind),['push'],'changes after wake are seen again');
  poller.dispose();
});

test('provider: wake marks idle warm app-servers stale; the next send replaces the process and resumes the same thread',async()=>{
  const cleared:string[]=[],resumed:unknown[]=[];
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,
    async runCodexAppServer(args){resumed.push((args as {threadId?:unknown}).threadId);return {status:'completed',finalMessage:'ok',dispatchState:'dispatched',threadId:'thread-1',turnId:'turn'};},
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(owner){cleared.push(owner);}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const input=(threadId?:string):ProviderInput=>({chat:{id:'chat-1',mode:'agent',model:'claude/claude-fable-5',...(threadId?{providerThreadId:threadId,providerThreadProviderId:'hybrow',providerThreadBindingId:'fixture-hybrow'}:{})} as ProviderInput['chat'],cwd:'/unused',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}});
  await adapter.run(input());await adapter.run(input('thread-1'));
  assert.equal(cleared.length,0,'an unchanged config keeps the warm app-server');
  assert.equal(adapter.markStale!(),1);
  await adapter.run(input('thread-1'));
  assert.equal(cleared.length,1,'the stale app-server is closed before the next send');
  assert.equal(resumed.at(-1),'thread-1','the fresh app-server resumes the same thread');
  await adapter.run(input('thread-1'));
  assert.equal(cleared.length,1,'only the first send after wake re-checks');
  adapter.dispose();
});

test('service: suspend → 5.5 h clock jump → resume runs one catch-up, wakes a due snooze once and re-probes providers',async t=>{
  let clock=at('2026-09-18T10:00:00Z');
  automationTiming.now=()=>clock;automationTiming.firstTickMs=5;automationTiming.tickMs=3_600_000;
  const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
  let dispatched=0,staleMarks=0;
  const provider:ProviderAdapter={info,async run(){dispatched++;return {status:'completed',finalMessage:'Done.'} satisfies ProviderResult;},stop:async()=>true,dispose(){},markStale(){staleMarks++;return 1;}};
  const events:AgentEvent[]=[];
  const service=createAgentService({dataDir:await directory(t),provider,onEvent:event=>events.push(event)});t.after(()=>service.dispose());
  const automation=await service.invoke('automations.create',{name:'Triage',prompt:'Triage new issues.',target:{kind:'new',mode:'agent'},schedule:{kind:'interval',minutes:60},timezone:'UTC',permissionMode:'workspace',overlap:'skip',catchUp:'one'});
  assert.equal(automation.nextRunAt,'2026-09-18T11:00:00.000Z');
  await pause(30);// the first tick has run: nothing due yet
  const sleeper=await service.invoke('chat.create',{});
  await service.invoke('chat.snooze',{id:sleeper.id,until:new Date(Date.now()+120).toISOString()});

  const suspended=await service.power({state:'suspend'});
  assert.equal(suspended.handled,true);assert.deepEqual(suspended.failures,[]);
  clock=at('2026-09-18T15:30:00Z');
  await pause(250);// the snooze falls due in real time while asleep
  const woke=()=>events.filter(event=>event.type==='chatWoke'&&event.chatId===sleeper.id).length;
  assert.equal(woke(),0,'no snooze wakes while the Mac sleeps');
  assert.equal((await service.invoke('automations.runs',{id:automation.id})).length,0,'no automation runs while the Mac sleeps');
  assert.equal(staleMarks,0);

  const resumed=await service.power({state:'resume'});
  assert.equal(resumed.handled,true);assert.deepEqual(resumed.failures,[]);
  assert.equal(staleMarks,1,'warm provider sessions are marked for re-check');
  assert.equal(woke(),1,'the due snooze wakes once');
  await until(async()=>(await service.invoke('automations.runs',{id:automation.id})).some(run=>run.status==='completed'),'catch-up run');
  // Duplicate resume, then another quick sleep/wake with no new occurrence due: nothing replays.
  assert.equal((await service.power({state:'resume'})).handled,false);
  await service.power({state:'suspend'});await service.power({state:'resume'});
  assert.equal((await service.power({state:'lock-screen'})).handled,false);
  await pause(30);
  const runs=await service.invoke('automations.runs',{id:automation.id});
  assert.equal(runs.length,1,'five missed hourly runs coalesce into one catch-up run, never a burst');
  assert.equal(runs[0]!.trigger,'catch-up');assert.match(runs[0]!.reason??'',/5 missed runs/);
  assert.equal(dispatched,1);
  assert.equal(woke(),1,'the snooze is not woken twice');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===sleeper.id)?.snoozedUntil ?? null,null);
  await assert.rejects(service.power({state:'nap' as never}),/Unknown power state/);
});
