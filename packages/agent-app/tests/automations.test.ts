import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {automationTiming} from '../src/runtime/domains/automations.ts';
import {describeSchedule,dueBetween,nextOccurrence,parseCron,upcoming,validateSchedule,zonedInstant} from '../src/runtime/automation-schedule.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';
import type {AutomationSaveInput} from '../src/shared/domains/automations-protocol.ts';

const iso=(ms:number|null)=>ms===null?null:new Date(ms).toISOString();
const at=(value:string)=>Date.parse(value);
const NY='America/New_York';

test('cron parsing: lists, ranges, steps, names and Sunday as 7',()=>{
  const fields=parseCron('*/15 9-17 * jan,jul mon-fri');
  assert.deepEqual(fields.minutes,[0,15,30,45]);assert.deepEqual(fields.hours,[9,10,11,12,13,14,15,16,17]);
  assert.deepEqual([...fields.months].sort((a,b)=>a-b),[1,7]);assert.deepEqual([...fields.weekdays].sort(),[1,2,3,4,5]);
  assert.deepEqual([...parseCron('0 0 * * 7').weekdays],[0]);
  assert.deepEqual([...parseCron('0 0 * * 5-7').weekdays].sort(),[0,5,6]);
  assert.throws(()=>parseCron('0 9 * *'),/5 fields/);
  assert.throws(()=>parseCron('61 9 * * *'),/out of range/);
  assert.throws(()=>validateSchedule({kind:'cron',expr:'* * * * *'}),/every 5 minutes/);
  assert.throws(()=>validateSchedule({kind:'interval',minutes:1}),/5 minutes/);
  assert.throws(()=>validateSchedule({kind:'daily',time:'9am',days:[1]}),/09:00/);
});

test('daily and cron occurrences follow the time zone, weekdays and day-of-month OR day-of-week',()=>{
  // Friday 2026-09-18 10:00 in New York (EDT, UTC-4): the next weekday 09:00 is Monday.
  const after=at('2026-09-18T14:00:00Z');
  assert.equal(iso(nextOccurrence({kind:'daily',time:'09:00',days:[1,2,3,4,5]},NY,after)),'2026-09-21T13:00:00.000Z');
  assert.equal(iso(nextOccurrence({kind:'cron',expr:'0 9 * * 1-5'},'Asia/Kolkata',after)),'2026-09-21T03:30:00.000Z');
  // 1st of the month OR a Sunday.
  assert.equal(iso(nextOccurrence({kind:'cron',expr:'0 12 1 * 0'},'UTC',after)),'2026-09-20T12:00:00.000Z');
  assert.deepEqual(upcoming({kind:'interval',minutes:60},'UTC',after,3,after).map(iso),['2026-09-18T15:00:00.000Z','2026-09-18T16:00:00.000Z','2026-09-18T17:00:00.000Z']);
  assert.equal(nextOccurrence({kind:'cron',expr:'0 0 30 2 *'},'UTC',after),null,'Feb 30 never happens');
  assert.equal(describeSchedule({kind:'daily',time:'09:00',days:[5,1,2,3,4]}),'Weekdays at 9:00 AM');
  assert.equal(describeSchedule({kind:'interval',minutes:60}),'Every hour');
});

test('DST: a skipped wall time runs at the shifted instant and a repeated one runs once',()=>{
  // 2026-03-08 02:30 does not exist in New York; it runs at 03:30 EDT (07:30Z).
  assert.equal(iso(zonedInstant(Date.UTC(2026,2,8,2,30),NY)),'2026-03-08T07:30:00.000Z');
  const spring=upcoming({kind:'daily',time:'02:30',days:[0,1,2,3,4,5,6]},NY,at('2026-03-07T12:00:00Z'),3);
  assert.deepEqual(spring.map(iso),['2026-03-08T07:30:00.000Z','2026-03-09T06:30:00.000Z','2026-03-10T06:30:00.000Z']);
  // 2026-11-01 01:30 happens twice; only the first (EDT, 05:30Z) runs.
  const fall=upcoming({kind:'daily',time:'01:30',days:[0,1,2,3,4,5,6]},NY,at('2026-10-31T12:00:00Z'),3);
  assert.deepEqual(fall.map(iso),['2026-11-01T05:30:00.000Z','2026-11-02T06:30:00.000Z','2026-11-03T06:30:00.000Z']);
  // Hourly across the fall-back hour: every instant is distinct and increasing.
  const hourly=upcoming({kind:'cron',expr:'0 * * * *'},NY,at('2026-11-01T03:30:00Z'),5);
  assert.deepEqual(hourly.map(iso),['2026-11-01T04:00:00.000Z','2026-11-01T05:00:00.000Z','2026-11-01T07:00:00.000Z','2026-11-01T08:00:00.000Z','2026-11-01T09:00:00.000Z']);
  // Missed occurrences coalesce: count plus the latest only.
  assert.deepEqual(dueBetween({kind:'interval',minutes:60},'UTC',at('2026-09-18T00:00:00Z'),at('2026-09-18T05:30:00Z'),at('2026-09-18T00:00:00Z')),{latest:at('2026-09-18T05:00:00Z'),count:5});
});

// ---------------------------------------------------------------------------
// Scheduler through the real service

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-automations-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
function fakeProvider(gated=false){
  const inputs:ProviderInput[]=[];let gate:PromiseWithResolvers<void>|undefined;
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);if(gated){gate=Promise.withResolvers();await gate.promise;}return {status:'completed',finalMessage:'Done.'} satisfies ProviderResult;},stop:async()=>true,dispose(){}};
  return {provider,inputs,release(){const current=gate;gate=undefined;current?.resolve();},get open(){return Boolean(gate);}};
}
let clock=at('2026-09-18T10:00:00Z');
automationTiming.now=()=>clock;automationTiming.tickMs=5;automationTiming.firstTickMs=5;
const hourly=(extra:Partial<AutomationSaveInput>={}):AutomationSaveInput=>({name:'Triage',prompt:'Triage new issues.',target:{kind:'new',mode:'agent'},schedule:{kind:'interval',minutes:60},timezone:'UTC',permissionMode:'workspace',overlap:'skip',catchUp:'one',...extra});

test('a due occurrence starts a new chat once; overlap skips; run now is deduped per instant',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider(true);
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const automation=await service.invoke('automations.create',hourly({permissionMode:'read-only',target:{kind:'new',mode:'plan'}}));
  assert.equal(automation.nextRunAt,'2026-09-18T11:00:00.000Z');assert.equal(automation.summary,'Every hour');assert.equal(automation.version,1);
  clock=at('2026-09-18T11:00:10Z');
  await until(()=>fake.open,'scheduled dispatch');
  const runs=await service.invoke('automations.runs',{id:automation.id});
  assert.equal(runs.length,1);assert.equal(runs[0]!.status,'running');assert.equal(runs[0]!.trigger,'schedule');
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===runs[0]!.chatId)!;
  assert.equal(chat.title,'Triage');assert.equal(chat.mode,'plan');assert.equal(chat.permissionMode,'read-only');
  assert.equal(fake.inputs[0]!.prompt.includes('Triage new issues.'),true);
  // Still working when the next hour comes due: skipped with a reason, nothing dispatched.
  clock=at('2026-09-18T12:00:05Z');
  await until(async()=>(await service.invoke('automations.runs',{id:automation.id})).length===2,'overlap entry');
  const skipped=(await service.invoke('automations.runs',{id:automation.id}))[0]!;
  assert.equal(skipped.status,'skipped');assert.match(skipped.reason??'',/still working/);
  assert.equal(fake.inputs.length,1);
  fake.release();
  await until(async()=>(await service.invoke('automations.runs',{id:automation.id})).some(run=>run.status==='completed'),'settled');
  // Run now twice at the same instant: one run.
  const manual=await service.invoke('automations.runNow',{id:automation.id});
  assert.equal(manual.trigger,'manual');
  await assert.rejects(service.invoke('automations.runNow',{id:automation.id}),/already exists/);
  await until(()=>fake.open,'manual dispatch');fake.release();
  await until(async()=>(await service.invoke('automations.list',undefined))[0]!.lastRun?.trigger==='manual','manual settled');
  assert.equal(fake.inputs.length,2);
});

test('missed runs coalesce into one catch-up run, or one missed entry; pause and resume never backfill',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const one=await service.invoke('automations.create',hourly());
  const none=await service.invoke('automations.create',hourly({name:'Skip missed',catchUp:'none'}));
  // The Mac slept for five hours.
  clock=at('2026-09-18T15:20:00Z');
  await until(async()=>(await service.invoke('automations.runs',{id:one.id})).some(run=>run.status==='completed'),'catch-up');
  const caught=await service.invoke('automations.runs',{id:one.id});
  assert.equal(caught.length,1);assert.equal(caught[0]!.trigger,'catch-up');assert.match(caught[0]!.reason??'',/5 missed runs/);
  assert.equal(caught[0]!.scheduledFor,'2026-09-18T15:00:00.000Z');
  const missed=await service.invoke('automations.runs',{id:none.id});
  assert.equal(missed.length,1);assert.equal(missed[0]!.status,'missed');
  assert.equal(fake.inputs.length,1);
  await service.invoke('automations.pause',{id:one.id});
  assert.equal((await service.invoke('automations.list',undefined)).find(entry=>entry.id===one.id)!.nextRunAt,undefined);
  clock=at('2026-09-18T18:30:00Z');
  const resumed=await service.invoke('automations.resume',{id:one.id});
  assert.equal(resumed.nextRunAt,'2026-09-18T19:00:00.000Z');
  await new Promise(resolve=>setTimeout(resolve,40));
  assert.equal((await service.invoke('automations.runs',{id:one.id})).length,1,'nothing replayed from the paused hours');
  const updated=await service.invoke('automations.update',{...hourly({prompt:'Triage and label.'}),id:one.id});
  assert.equal(updated.version,2);
});

test('authority: a chat target cannot be run with more access than saved, and Full access needs confirmation',async t=>{
  clock=at('2026-09-18T10:00:00Z');
  const dataDir=await directory(t),fake=fakeProvider();
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  await assert.rejects(service.invoke('automations.create',hourly({permissionMode:'full'})),/Confirm unrestricted/);
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
  await assert.rejects(service.invoke('automations.create',hourly({target:{kind:'chat',chatId:chat.id}})),/more access/);
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
  const automation=await service.invoke('automations.create',hourly({target:{kind:'chat',chatId:chat.id}}));
  // Raised after saving: the run is refused with the reason, and the chat never receives the prompt.
  await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'full',acknowledgeFullAccess:true});
  assert.match((await service.invoke('automations.list',undefined))[0]!.issues[0]??'',/more access/);
  const run=await service.invoke('automations.runNow',{id:automation.id});
  await until(async()=>(await service.invoke('automations.runs',{id:automation.id}))[0]!.status==='failed','refused');
  assert.equal(run.chatId===undefined||run.chatId===chat.id,true);
  assert.equal(fake.inputs.length,0);
  const preview=await service.invoke('automations.preview',{schedule:{kind:'daily',time:'09:00',days:[1,2,3,4,5]},timezone:'UTC',target:{kind:'chat',chatId:chat.id},permissionMode:'workspace'});
  assert.equal(preview.next.length,3);assert.equal(preview.summary,'Weekdays at 9:00 AM');assert.match(preview.issues[0]??'',/more access/);
});
