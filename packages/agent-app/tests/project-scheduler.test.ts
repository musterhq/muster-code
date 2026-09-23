import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {ProjectTaskStore} from '../src/runtime/project-tasks.ts';
import {ProjectScheduler} from '../src/runtime/project-scheduler.ts';

function fixture(){const dir=mkdtempSync(join(tmpdir(),'muster-scheduler-'));const store=new ProjectTaskStore(dir);return {dir,store,close(){store.close();rmSync(dir,{recursive:true,force:true})}}}
const create=(store:ProjectTaskStore,projectId:string,title:string,opts:{dependencies?:string[];owner?:'user'|'agent'}={})=>store.createTask({projectId,title,acceptance:'done',dependencies:opts.dependencies??[],owner:{kind:opts.owner??'agent',id:opts.owner??'agent'}});

test('scheduler dispatches only ready, agent-owned tasks up to the concurrency limit, and leases stop double-dispatch',async()=>{
 const f=fixture();try{
  f.store.setSchedule('p',{autoDispatch:true,paused:false,concurrency:2,budgetMinutes:30,permissionMode:'workspace'});
  const dep=create(f.store,'p','Dependency'),unverifiedDep=create(f.store,'p','Unverified dependency',{owner:'user'});
  f.store.updateTaskStatus({projectId:'p',id:dep.id,status:'implemented',revision:0});
  f.store.updateTaskStatus({projectId:'p',id:dep.id,status:'verified',revision:1,evidence:['checked']});
  const ready1=create(f.store,'p','Ready 1');
  const ready2=create(f.store,'p','Ready 2');
  // Depends on a user-owned task that never gets verified in this test, so it stays un-ready (and its
  // dependency, being user-owned, is itself excluded) regardless of creation-time tie-breaks.
  const blocked=create(f.store,'p','Blocked',{dependencies:[unverifiedDep.id]});
  const userOwned=create(f.store,'p','User task',{owner:'user'});
  const dispatched:string[]=[];
  const scheduler=new ProjectScheduler({tasks:f.store,dispatch:async task=>{dispatched.push(task.id);},stop:async()=>{},runnable:()=>true,changed:()=>{}});
  // Only the two ready, agent-owned tasks are planned; dependency-blocked and user-owned tasks are excluded.
  const planned=scheduler.plan('p').map(t=>t.id);
  assert.deepEqual(new Set(planned),new Set([ready1.id,ready2.id]));
  assert.ok(!planned.includes(blocked.id));assert.ok(!planned.includes(userOwned.id));
  await scheduler.tick('p');
  assert.deepEqual(new Set(dispatched),new Set([ready1.id,ready2.id]));
  // A held lease keeps the plan from double-dispatching the same task on an overlapping tick.
  assert.ok(f.store.acquireLease('p',ready1.id,'other-holder',60_000));
  assert.ok(!f.store.acquireLease('p',ready1.id,'another-holder',60_000));
 }finally{f.close()}
});

test('scheduler respects the concurrency limit against already-running attempts, and enforceBudgets stops overrun runs',async()=>{
 const f=fixture();try{
  f.store.setSchedule('p',{autoDispatch:true,paused:false,concurrency:1,budgetMinutes:10,permissionMode:'workspace'});
  const a=create(f.store,'p','A'),b=create(f.store,'p','B');
  f.store.startTask({projectId:'p',id:a.id,revision:0,requestId:'r1',chatId:'chat-a'});
  const scheduler=new ProjectScheduler({tasks:f.store,dispatch:async()=>{},stop:async()=>{},runnable:()=>true,changed:()=>{}});
  assert.deepEqual(scheduler.plan('p'),[],'concurrency 1 is already used by the running task');
  f.store.settleRunForChat('chat-a','completed');
  assert.deepEqual(scheduler.plan('p').map(t=>t.id),[b.id]);
  // A run older than its budget is stopped and annotated, once per chat.
  f.store.startTask({projectId:'p',id:b.id,revision:0,requestId:'r2',chatId:'chat-b'});
  f.store.beginAttempt({chatId:'chat-b',runId:'run-b'});
  const db=(f.store as unknown as {db:{prepare(sql:string):{run(...args:unknown[]):void}}}).db;
  db.prepare("UPDATE attempts SET started_at=? WHERE chat_id='chat-b'").run(new Date(Date.now()-11*60_000).toISOString());
  const stopped:string[]=[];
  const budgetScheduler=new ProjectScheduler({tasks:f.store,dispatch:async()=>{},stop:async chatId=>{stopped.push(chatId);},runnable:()=>true,changed:()=>{}});
  const result=await budgetScheduler.enforceBudgets();
  assert.deepEqual(result,['chat-b']);assert.deepEqual(stopped,['chat-b']);
  assert.match(budgetScheduler.takeBudgetReason('chat-b')??'',/10-minute run budget/);
  assert.equal(budgetScheduler.takeBudgetReason('chat-b'),undefined,'the reason is consumed once');
 }finally{f.close()}
});

test('reopening a verified dependency marks its dependent blocked again, so the scheduler stops planning it',async()=>{
 const f=fixture();try{
  f.store.setSchedule('p',{autoDispatch:true,paused:false,concurrency:5,budgetMinutes:30,permissionMode:'workspace'});
  const dep=create(f.store,'p','Dependency'),dependent=create(f.store,'p','Dependent',{dependencies:[dep.id]});
  f.store.updateTaskStatus({projectId:'p',id:dep.id,status:'implemented',revision:0});
  f.store.updateTaskStatus({projectId:'p',id:dep.id,status:'verified',revision:1,evidence:['checked']});
  const scheduler=new ProjectScheduler({tasks:f.store,dispatch:async()=>{},stop:async()=>{},runnable:()=>true,changed:()=>{}});
  assert.deepEqual(scheduler.plan('p').map(t=>t.id),[dependent.id]);
  f.store.setState({projectId:'p',id:dep.id,revision:2,state:'todo'});
  assert.equal(f.store.getTask(dependent.id)?.status,'blocked');
  // The dependency itself is ready again (no dependencies of its own); its reopened dependent is not.
  assert.deepEqual(scheduler.plan('p').map(t=>t.id),[dep.id]);
 }finally{f.close()}
});

test('needs-input is not dispatch-eligible, and a paused or non-runnable project plans nothing',async()=>{
 const f=fixture();try{
  f.store.setSchedule('p',{autoDispatch:true,paused:false,concurrency:5,budgetMinutes:30,permissionMode:'workspace'});
  const t=create(f.store,'p','Chatty');
  f.store.startTask({projectId:'p',id:t.id,revision:0,requestId:'r1',chatId:'chat-1'});
  f.store.markNeedsInput('chat-1',true);
  const scheduler=new ProjectScheduler({tasks:f.store,dispatch:async()=>{},stop:async()=>{},runnable:()=>true,changed:()=>{}});
  assert.deepEqual(scheduler.plan('p'),[]);
  f.store.setSchedule('p',{paused:true});
  const other=create(f.store,'p','Ready');
  assert.deepEqual(scheduler.plan('p'),[],'paused scheduler plans nothing even with a ready task');
  f.store.setSchedule('p',{paused:false});
  assert.deepEqual(scheduler.plan('p').map(x=>x.id),[other.id]);
  const suspended=new ProjectScheduler({tasks:f.store,dispatch:async()=>{},stop:async()=>{},runnable:()=>false,changed:()=>{}});
  assert.deepEqual(suspended.plan('p'),[],'a Project the runtime reports as not runnable plans nothing');
 }finally{f.close()}
});
