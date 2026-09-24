import test from 'node:test';
import assert from 'node:assert/strict';
import {promises as fs} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {ResourceScheduler,classifyPressure,defaultResourcePolicy,systemResourceSample,type ResourceSample} from '../src/runtime/resource-scheduler.ts';
import {ProcessSessions} from '../src/runtime/process-sessions.ts';
import {ProjectScheduler} from '../src/runtime/project-scheduler.ts';

const GiB=2**30;
function machine(){
  const state:ResourceSample={freeBytes:12*GiB,totalBytes:24*GiB,load1:2,cpus:10};
  return {state,sample:()=>({...state})};
}

test('PER-06: policy is sized from the machine; pressure is memory- and CPU-aware',()=>{
  const policy=defaultResourcePolicy(24*GiB);
  assert.equal(policy.maxAgents,6);assert.equal(policy.maxHeavy,1);
  assert.equal(classifyPressure({freeBytes:12*GiB,totalBytes:24*GiB,load1:2,cpus:10},policy).level,'ok');
  assert.match(classifyPressure({freeBytes:0.5*GiB,totalBytes:24*GiB,load1:2,cpus:10},policy).reason!,/Memory pressure is high \(0\.5 GB of 24\.0 GB/);
  assert.match(classifyPressure({freeBytes:12*GiB,totalBytes:24*GiB,load1:40,cpus:10},policy).reason!,/CPU is saturated/);
  const real=systemResourceSample();
  assert.ok(real.totalBytes>0&&real.freeBytes>0&&real.freeBytes<=real.totalBytes&&real.cpus>=1,'the live sampler reports plausible numbers');
});

test('PER-06 capped stress: 8 concurrent agents + 3 heavy builds on a simulated 24 GB laptop',async()=>{
  const m=machine();let agents=0;
  const scheduler=new ResourceScheduler({sample:m.sample,pollMs:10,countAgents:()=>agents});
  const timeline:string[]=[];let heavyNow=0,heavyPeak=0,agentPeak=0;
  // Agents are admitted by count (runtime-owned), builds by lease.
  const startAgent=async(i:number)=>{while(!scheduler.admits('agent').ok)await delay(5);agents++;agentPeak=Math.max(agentPeak,agents);timeline.push(`agent${i}+`);await delay(30);agents--;scheduler.drain();};
  const build=async(i:number)=>{const lease=await scheduler.acquire('heavy',{label:`build${i}`});heavyNow++;heavyPeak=Math.max(heavyPeak,heavyNow);timeline.push(`build${i}+`);await delay(40);heavyNow--;timeline.push(`build${i}-`);lease.release();};
  const started=Date.now();
  await Promise.all([...Array.from({length:8},(_,i)=>startAgent(i)),...Array.from({length:3},(_,i)=>build(i))]);
  assert.equal(heavyPeak,1,'heavy builds run one at a time');
  assert.ok(agentPeak<=6,`agent slots respected (peak ${agentPeak})`);
  assert.deepEqual(timeline.filter(e=>e.startsWith('build')),['build0+','build0-','build1+','build1-','build2+','build2-'],'FIFO order');
  assert.ok(Date.now()-started<5_000);
  scheduler.dispose();
});

test('PER-06: under memory pressure new work queues, the first job still runs, and the queue drains when pressure clears',async()=>{
  const m=machine();
  const scheduler=new ResourceScheduler({sample:m.sample,pollMs:10,policy:{maxHeavy:4}});
  const first=scheduler.tryAcquire('heavy','first');assert.ok(first);
  m.state.freeBytes=0.4*GiB;
  const reasons:string[]=[];
  const second=scheduler.acquire('heavy',{label:'second',onQueued:reason=>reasons.push(reason)});
  assert.match(reasons[0]!,/Memory pressure is high/);
  assert.equal(scheduler.snapshot().queued.length,1);
  first!.release();
  // Nothing heavy runs now: the progress guarantee admits the queued job even under pressure.
  const lease=await second;assert.equal(lease.label,'second');
  // With one running and pressure high, the next waits until memory frees.
  let admitted=false;const third=scheduler.acquire('heavy',{label:'third'}).then(l=>{admitted=true;return l;});
  await delay(40);assert.equal(admitted,false);
  m.state.freeBytes=10*GiB;
  (await third).release();lease.release();
  // A queued request can be cancelled.
  const blocker=scheduler.tryAcquire('heavy')!;m.state.freeBytes=0.4*GiB;
  const abort=new AbortController();const cancelled=scheduler.acquire('heavy',{signal:abort.signal});abort.abort();
  await assert.rejects(cancelled,/Cancelled while queued/);
  assert.equal(scheduler.snapshot().queued.length,0);blocker.release();
  scheduler.dispose();
});

test('PER-06: a queued build returns at once, shows why it waits, and starts when the running build ends',async()=>{
  const directory=await fs.mkdtemp(join(tmpdir(),'muster-heavy-'));
  const m=machine();const scheduler=new ResourceScheduler({sample:m.sample,pollMs:10});
  const registry=new ProcessSessions(join(directory,'commands.json'),async()=>({cwd:directory,fullAccessAcknowledged:true}),()=>{},undefined,{resources:scheduler});
  try{
    await registry.ready();
    const run=(id:string,ms:number)=>registry.start({chatId:'chat',requestId:id,command:process.execPath,args:['-e',`setTimeout(()=>console.log('${id} done'),${ms})`],label:id,purpose:'build'});
    const a=await run('a',150),b=await run('b',10);
    assert.equal(a.queued,undefined);assert.match(b.queued??'',/Waiting for the running build/);assert.equal(b.status,'starting');
    let rows=(await registry.list({chatId:'chat'})).sessions;
    for(let i=0;i<200&&!rows.every(row=>row.status==='exited');i++){await delay(20);rows=(await registry.list({chatId:'chat'})).sessions;}
    const byLabel=new Map(rows.map(row=>[row.label,row]));
    assert.equal(byLabel.get('a')?.status,'exited');assert.equal(byLabel.get('b')?.status,'exited');
    assert.ok(Date.parse(byLabel.get('b')!.startedAt)<=Date.parse(byLabel.get('a')!.updatedAt));
    // Stop while queued never spawns.
    const c=await run('c',300),d=await run('d',10);assert.ok(d.queued);
    await registry.stop({chatId:'chat',processId:d.processId});
    for(let i=0;i<100&&(await registry.list({chatId:'chat'})).sessions.find(row=>row.label==='d')?.status!=='stopped';i++)await delay(10);
    assert.equal((await registry.list({chatId:'chat'})).sessions.find(row=>row.label==='d')?.status,'stopped');
    await registry.stop({chatId:'chat',processId:c.processId});
    // The durable log pages the finished build's output.
    const page=await registry.outputPage({chatId:'chat',processId:a.processId});
    assert.equal(page.text,'a done\n');
    await assert.rejects(registry.outputPage({chatId:'chat'}),/Choose a command/);
  }finally{await registry.dispose();scheduler.dispose();await fs.rm(directory,{recursive:true,force:true});}
});

test('PER-06: the Project scheduler defers automated dispatch when admission refuses',async()=>{
  const tasks=[{id:'t1',projectId:'p',owner:{kind:'agent',id:'agent'},state:'todo',dependencies:[],priority:1,createdAt:'1',revision:1},{id:'t2',projectId:'p',owner:{kind:'agent',id:'agent'},state:'todo',dependencies:[],priority:2,createdAt:'2',revision:1}];
  const store={schedule:()=>({autoDispatch:true,paused:false,concurrency:4}),isSuspended:()=>false,listTasks:()=>({items:tasks}),leasedTasks:()=>[],acquireLease:()=>true,releaseLease:()=>{}};
  const dispatched:string[]=[],deferred:string[]=[];let slots=1;
  const scheduler=new ProjectScheduler({tasks:store as never,dispatch:async task=>{dispatched.push(task.id);},stop:async()=>{},runnable:()=>true,changed:()=>{},
    admit:()=>slots-->0?{ok:true}:{ok:false,reason:'Memory pressure is high'},deferred:(_p,reason)=>deferred.push(reason)});
  assert.deepEqual(await scheduler.tick('p'),['t1']);
  assert.deepEqual(dispatched,['t1'],'the lower-priority task waits');assert.deepEqual(deferred,['Memory pressure is high']);
});
