// #845: an automation that runs once at a set date and time, in the automation's time zone. Driven through the real
// service with the scheduler's injectable clock (automationTiming.now) and a fake provider.
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {automationTiming} from '../src/runtime/domains/automations.ts';
import {describeSchedule,nextOccurrence,validateSchedule} from '../src/runtime/automation-schedule.ts';
import {scheduledDetail} from '../src/renderer/scheduledAutomations.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {AutomationSaveInput,AutomationSchedule} from '../src/shared/domains/automations-protocol.ts';

const at=(value:string)=>Date.parse(value);
const iso=(ms:number|null)=>ms===null?null:new Date(ms).toISOString();
const NY='America/New_York';
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-once-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
function fakeProvider(){
  const inputs:ProviderInput[]=[];
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);return {status:'completed',finalMessage:'Done.'} satisfies ProviderResult;},stop:async()=>true,dispose(){}};
  return {provider,inputs};
}
let clock=at('2026-09-18T10:00:00Z');
automationTiming.now=()=>clock;automationTiming.tickMs=5;automationTiming.firstTickMs=5;
const once=(when:string,extra:Partial<AutomationSaveInput>={}):AutomationSaveInput=>({name:'Ship notes',prompt:'Write the release notes.',target:{kind:'new',mode:'agent'},schedule:{kind:'once',at:when} as AutomationSchedule,timezone:NY,permissionMode:'workspace',overlap:'skip',catchUp:'one',...extra});
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));

// Spec: MUS-SPEC-14-845A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845a)
test('a once automation runs at its local date and time, then shows as done with its run linked',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  // 3:00 PM in New York (EDT, UTC-4) is 19:00 UTC.
  const created=await service.invoke('automations.create',once('2026-09-18T15:00'));
  assert.equal(created.nextRunAt,'2026-09-18T19:00:00.000Z');
  assert.equal(created.summary,'Once on Fri, Sep 18, 2026 at 3:00 PM (America/New_York)');
  assert.equal(created.done,undefined);
  clock=at('2026-09-18T18:59:00Z');await settle();
  assert.equal((await service.invoke('automations.runs',{id:created.id})).length,0,'nothing before the set time');
  clock=at('2026-09-18T19:00:05Z');
  await until(async()=>(await service.invoke('automations.runs',{id:created.id})).some(run=>run.status==='completed'),'the one run');
  // Days later it has still run exactly once.
  clock=at('2026-09-21T12:00:00Z');await settle();
  const runs=await service.invoke('automations.runs',{id:created.id});
  assert.equal(runs.length,1);assert.equal(runs[0]!.trigger,'schedule');assert.equal(runs[0]!.scheduledFor,'2026-09-18T19:00:00.000Z');
  assert.ok(runs[0]!.chatId,'the run links its chat');
  assert.equal(fake.inputs.length,1);
  const view=(await service.invoke('automations.list',undefined)).find(entry=>entry.id===created.id)!;
  assert.equal(view.done,true,'kept, as done');assert.equal(view.nextRunAt,undefined);
  assert.equal(view.lastRun?.chatId,runs[0]!.chatId);
  assert.equal(scheduledDetail(view,clock),'Done');
  // A done automation can still be renamed: its own past time is not re-checked, and it does not run again.
  const renamed=await service.invoke('automations.update',{...once('2026-09-18T15:00',{name:'Ship notes (done)'}),id:created.id});
  assert.equal(renamed.done,true);await settle();
  assert.equal((await service.invoke('automations.runs',{id:created.id})).length,1);
});

// Spec: MUS-SPEC-14-845B (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845b)
test('a once time that has already passed is refused at save, and the preview says so',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  // 05:59 in New York is 09:59 UTC: one minute ago.
  await assert.rejects(service.invoke('automations.create',once('2026-09-18T05:59')),/already passed.*future/);
  await assert.rejects(service.invoke('automations.create',once('2026-02-30T09:00')),/date and time/);
  await assert.rejects(service.invoke('automations.create',once('tomorrow 9am')),/date and time/);
  const preview=await service.invoke('automations.preview',{schedule:{kind:'once',at:'2026-09-18T05:59'},timezone:NY});
  assert.deepEqual(preview.next,[]);assert.match(preview.issues.join(' '),/already passed/);
  const future=await service.invoke('automations.preview',{schedule:{kind:'once',at:'2026-09-18T07:00'},timezone:NY});
  assert.deepEqual(future.next,['2026-09-18T11:00:00.000Z']);assert.deepEqual(future.issues,[]);
  // Moving a pending one to a past time is refused too.
  const pending=await service.invoke('automations.create',once('2026-09-19T09:00'));
  await assert.rejects(service.invoke('automations.update',{...once('2026-09-17T09:00'),id:pending.id}),/already passed/);
  assert.equal((await service.invoke('automations.runs',{id:pending.id})).length,0);
});

// Spec: MUS-SPEC-14-845C (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845c)
test('closed at the set time: it runs once at the next start and says it ran late, or records one missed entry when catch-up is off',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const first=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const late=await first.invoke('automations.create',once('2026-09-18T15:00'));
  const skip=await first.invoke('automations.create',once('2026-09-18T15:00',{name:'Skip if missed',catchUp:'none'}));
  first.dispose();
  // Muster was closed from before 19:00 UTC until 22:30 UTC.
  clock=at('2026-09-18T22:30:00Z');
  const second=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>second.dispose());
  await until(async()=>(await second.invoke('automations.runs',{id:late.id})).some(run=>run.status==='completed'),'late run');
  await until(async()=>(await second.invoke('automations.runs',{id:skip.id})).length===1,'missed entry');
  clock=at('2026-09-19T08:00:00Z');await settle();
  const ran=await second.invoke('automations.runs',{id:late.id});
  assert.equal(ran.length,1);assert.equal(ran[0]!.trigger,'catch-up');assert.equal(ran[0]!.scheduledFor,'2026-09-18T19:00:00.000Z');
  assert.match(ran[0]!.reason??'',/^Ran late\. It was due Fri, Sep 18, 2026 at 3:00 PM \(America\/New_York\)/);
  const missed=await second.invoke('automations.runs',{id:skip.id});
  assert.equal(missed.length,1);assert.equal(missed[0]!.status,'missed');assert.match(missed[0]!.reason??'',/did not run/);
  assert.equal(fake.inputs.length,1,'only the catch-up one sent a prompt');
  const views=await second.invoke('automations.list',undefined);
  assert.equal(views.find(v=>v.id===late.id)!.done,true);assert.equal(views.find(v=>v.id===skip.id)!.done,true);
});

// Spec: MUS-SPEC-14-845D (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845d)
test('a scheduled once automation moved to another chat before its time runs in the new chat only, at the same time',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const from=await service.invoke('chat.create',{}),to=await service.invoke('chat.create',{});
  const created=await service.invoke('automations.create',once('2026-09-18T15:00',{target:{kind:'chat',chatId:from.id}}));
  clock=at('2026-09-18T12:00:00Z');
  const moved=await service.invoke('automations.update',{...once('2026-09-18T15:00',{target:{kind:'chat',chatId:to.id}}),id:created.id});
  assert.equal(moved.nextRunAt,'2026-09-18T19:00:00.000Z','moving keeps the set time');
  assert.deepEqual(moved.target,{kind:'chat',chatId:to.id});
  clock=at('2026-09-18T19:00:05Z');
  await until(async()=>(await service.invoke('automations.runs',{id:created.id})).some(run=>run.status==='completed'),'run in the new chat');
  const runs=await service.invoke('automations.runs',{id:created.id});
  assert.equal(runs.length,1);assert.equal(runs[0]!.chatId,to.id);
  const notices=(id:string)=>service.invoke('chat.timeline',{id}).then(timeline=>JSON.stringify(timeline).includes('automation-run'));
  assert.equal(await notices(to.id),true);assert.equal(await notices(from.id),false,'the old chat gets nothing');
  assert.equal(fake.inputs.length,1);
});

// Spec: MUS-SPEC-14-845E (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845e)
test('once times are wall-clock times in their zone, DST included, and malformed ones are refused',()=>{
  const once=(value:string):AutomationSchedule=>({kind:'once',at:value} as AutomationSchedule);
  const after=at('2026-01-01T00:00:00Z');
  assert.equal(iso(nextOccurrence(once('2026-09-21T09:00'),'Asia/Kolkata',after)),'2026-09-21T03:30:00.000Z');
  assert.equal(iso(nextOccurrence(once('2026-12-01T09:00'),NY,after)),'2026-12-01T14:00:00.000Z','EST in winter');
  // 02:30 on 2026-03-08 does not exist in New York: it runs at 03:30 EDT, like daily schedules.
  assert.equal(iso(nextOccurrence(once('2026-03-08T02:30'),NY,after)),'2026-03-08T07:30:00.000Z');
  // 01:30 on 2026-11-01 happens twice: it runs at the first.
  assert.equal(iso(nextOccurrence(once('2026-11-01T01:30'),NY,after)),'2026-11-01T05:30:00.000Z');
  assert.equal(nextOccurrence(once('2026-09-21T09:00'),'UTC',at('2026-09-21T09:00:00Z')),null,'nothing after its time');
  assert.equal(describeSchedule(once('2026-09-21T09:05'),'Asia/Kolkata'),'Once on Mon, Sep 21, 2026 at 9:05 AM (Asia/Kolkata)');
  assert.equal(describeSchedule(once('2026-09-21T21:00')),'Once on Mon, Sep 21, 2026 at 9:00 PM');
  for (const bad of ['2026-09-21','2026-09-21T24:00','2026-13-01T09:00','2026-02-29T09:00','',' 2026-09-21T09:00']) assert.throws(()=>validateSchedule(once(bad)),/date and time/,bad);
  assert.doesNotThrow(()=>validateSchedule(once('2028-02-29T09:00')));
});
