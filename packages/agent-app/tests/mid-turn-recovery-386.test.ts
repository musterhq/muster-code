import assert from 'node:assert/strict';
import {test, mock, type TestContext} from 'node:test';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {createProviderAdapter, type ProviderAdapter, type ProviderInput, type ProviderResult} from '../src/runtime/provider.ts';
import {tailStatus, retryLabel} from '../src/renderer/components/turnStatusModel.ts';
import {planSteps} from '../src/renderer/components/toolPresentation.ts';

const info: ProviderAdapter['info'] = () => [{id:'hybrow', name:'Fixture', available:true, identityMasked:'fixture', models:[]}];
const flush = async () => { for (let n=0;n<30;n++) await new Promise(resolve=>setImmediate(resolve)); };
function tool(input: ProviderInput, id='command') {
  input.onEvent('item/completed', {threadId:'thread-386', item:{id, type:'commandExecution', command:'echo checked', exitCode:0}});
}
const failure = (code=503): ProviderResult => ({status:'failed', finalMessage:'', threadId:'thread-386', turnId:'turn-386', dispatchState:'dispatched', errorMessage:`HTTP ${code}: exceeded retry limit`, failure:{kind:'rpc-rejected', statusCode:code}, recovery:{kind:'failed', retryable:false, reason:`The provider attempt failed: HTTP ${code}.`}});
async function setup(t: TestContext, run: ProviderAdapter['run'], provider?: ProviderAdapter) {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-386-'));
  mock.timers.enable({apis:['setTimeout','Date'], now:Date.parse('2026-10-27T00:00:00Z')});
  const service=createAgentService({dataDir, provider:provider ?? {info, run, stop:async()=>true, dispose(){}}, onEvent(){}});
  t.after(async()=>{await service.dispose();mock.timers.reset();await rm(dataDir,{recursive:true,force:true});});
  const chat=await service.invoke('chat.create',{});
  const items=async()=>(await service.invoke('chat.timeline',{id:chat.id})).items;
  const snapshot=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)!;
  const send=async()=>{await service.invoke('chat.send',{id:chat.id,text:'Check the files and finish the task',requestId:'386'});await flush();};
  return {service,chat,items,snapshot,send};
}

// Spec: MUS-SPEC-02-386A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386a)
test('mid-turn 429 and 5xx show failure and countdown then continue the same thread, at most twice', async t=>{
  for(const code of [429,500,503]) await t.test(String(code),async t=>{
    const calls:ProviderInput[]=[];
    const f=await setup(t,async input=>{calls.push(input);input.onTurnAccepted?.({threadId:'thread-386',turnId:`turn-${calls.length}`,dispatchState:'dispatched'});input.onDelta('I will check the files.');tool(input,`command-${calls.length}`);return {...failure(code), ...(code===500?{failure:{kind:'rpc-rejected' as const,statusCode:code,retryAfterMs:12_000}}:{})};});
    await f.send();
    for(let n=1;n<=2;n++) {
      const rows=await f.items(), notice=rows.find(i=>i.data?.kind==='turn-retry'&&i.status==='running');
      assert.ok(notice,'a visible continuation countdown');
      assert.equal(rows.filter(i=>i.kind==='notice'&&i.status==='failed').length,n,'each failed attempt is explained');
      assert.equal(calls.length,n);
      const status=tailStatus(rows), wait=Date.parse(String(notice.data?.retryAt))-Date.now();
      assert.equal(status.kind,'retry');assert.equal(retryLabel(status.retryAt,Date.now()),`Retrying in ${wait/1000}s`);
      mock.timers.tick(wait-1);await flush();assert.equal(calls.length,n);
      mock.timers.tick(1);await flush();assert.equal(calls.length,n+1);
      assert.equal(calls[n]!.chat.providerThreadId,'thread-386');
      assert.match(calls[n]!.prompt,/Continue from where you stopped/);
      assert.doesNotMatch(calls[n]!.prompt,/Current user request|Check the files and finish the task/);
    }
    assert.equal((await f.snapshot()).status,'failed');
    assert.equal((await f.snapshot()).autoResume,undefined,'no second automatic retry system after this bound');
    assert.equal((await f.items()).filter(i=>i.kind==='user').length,1);
    assert.equal((await f.items()).filter(i=>i.kind==='notice'&&i.status==='failed').length,4,'three failures plus the exhausted countdown notice');
    mock.timers.tick(3_600_000);await flush();assert.equal(calls.length,3);
  });
});

// Spec: MUS-SPEC-02-386B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386b)
test('Stop cancels a mid-turn continuation countdown and does not resend',async t=>{
  let calls=0;
  const f=await setup(t,async input=>{calls++;input.onTurnAccepted?.({threadId:'thread-386',turnId:'turn',dispatchState:'dispatched'});tool(input);return failure();});
  await f.send();assert.ok((await f.items()).some(i=>i.data?.kind==='turn-retry'&&i.status==='running'));
  await f.service.invoke('chat.stop',{id:f.chat.id});await flush();mock.timers.tick(120_000);await flush();
  assert.equal(calls,1);assert.equal((await f.snapshot()).status,'interrupted');
  assert.ok((await f.items()).some(i=>i.data?.kind==='turn-retry'&&i.status==='cancelled'));
});

// Spec: MUS-SPEC-02-386C (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386c)
test('a tool-only completion gets one finish-up continuation and the new final answer is saved',async t=>{
  const calls:ProviderInput[]=[];
  const f=await setup(t,async input=>{calls.push(input);input.onTurnAccepted?.({threadId:'thread-386',turnId:`turn-${calls.length}`,dispatchState:'dispatched'});if(calls.length===1){input.onDelta('Checking now.');tool(input);return {status:'completed',finalMessage:'Checking now.',threadId:'thread-386'};}return {status:'completed',finalMessage:'All checks passed.',threadId:'thread-386'};});
  await f.send();assert.equal(calls.length,2);assert.equal(calls[1]!.chat.providerThreadId,'thread-386');assert.match(calls[1]!.prompt,/reply|summary/i);
  assert.ok((await f.items()).some(i=>i.kind==='assistant'&&i.text==='All checks passed.'));
  assert.equal((await f.items()).filter(i=>i.kind==='user').length,1);assert.equal((await f.snapshot()).status,'completed');
});

// Spec: MUS-SPEC-02-386D (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386d)
test('a second tool-only ending stops visibly instead of looping or claiming completion',async t=>{
  let calls=0;
  const f=await setup(t,async input=>{calls++;input.onTurnAccepted?.({threadId:'thread-386',turnId:`turn-${calls}`,dispatchState:'dispatched'});tool(input,`command-${calls}`);return {status:'completed',finalMessage:'',threadId:'thread-386'};});
  await f.send();assert.equal(calls,2);assert.equal((await f.snapshot()).status,'failed');
  assert.ok((await f.items()).some(i=>i.kind==='notice'&&/Agent stopped without replying/.test(i.text)));
  mock.timers.tick(120_000);await flush();assert.equal(calls,2);
});

// Spec: MUS-SPEC-02-386E (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386e)
test('live native plan updates show one checklist with current steps and ignore a child thread',async t=>{
  const f=await setup(t,async input=>{
    input.onTurnAccepted?.({threadId:'thread-386',turnId:'turn',dispatchState:'dispatched'});
    input.onEvent('turn/plan/updated',{threadId:'thread-386',plan:[{step:'Inspect',status:'in_progress'},{step:'Verify',status:'pending'}]});
    input.onEvent('turn/plan/updated',{threadId:'thread-386',plan:[{step:'Inspect',status:'completed'},{step:'Verify',status:'in_progress'}]});
    input.onEvent('turn/plan/updated',{threadId:'child',plan:[{step:'Child work',status:'pending'}]});
    return {status:'completed',finalMessage:'Finished.'};
  });
  await f.send();const rows=(await f.items()).filter(i=>i.kind==='tool');assert.equal(rows.length,1);
  assert.deepEqual(planSteps(rows[0]!.data),[{text:'Inspect',status:'completed'},{text:'Verify',status:'in_progress'}]);
  assert.equal(rows[0]!.data?.name,'update_plan');
});

// Spec: MUS-SPEC-02-386F (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386f)
test('uncertain, auth, no-activity and normal final replies never get a mid-turn continuation; empty failure gets a notice',async t=>{
  for(const mode of ['uncertain','auth','no-activity','final','empty','unknown','quota']) await t.test(mode,async t=>{
    let calls=0;
    const f=await setup(t,async input=>{calls++;input.onTurnAccepted?.({threadId:'thread-386',turnId:'turn',dispatchState:'dispatched'});if(mode!=='no-activity'&&mode!=='empty')tool(input);
      if(mode==='final'){input.onDelta('Done.');return {status:'completed',finalMessage:'Done.'};}
      if(mode==='empty')return {status:'failed',finalMessage:''};
      return {...failure(mode==='auth'?401:503),...(mode==='unknown'?{dispatchState:'unknown' as const}:{}),...(mode==='quota'?{errorMessage:'HTTP 429: insufficient_quota'}:{}),...(mode==='uncertain'?{recovery:{kind:'recovery-needed' as const,retryable:false,reason:'May still be running.'}}:{})};
    });
    await f.send();assert.equal(calls,1);assert.equal((await f.items()).some(i=>i.data?.kind==='turn-retry'),false);
    if(mode==='uncertain'||mode==='unknown') { assert.equal((await f.snapshot()).autoResume,undefined,'an unresolved outcome must not arm the older limit-resume path'); mock.timers.tick(120_000);await flush();assert.equal(calls,1); }
    if(mode==='empty')assert.ok((await f.items()).some(i=>i.kind==='notice'&&i.status==='recovery-needed'));
  });
});

// Spec: MUS-SPEC-02-386G (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-386g)
test('a terminal native failure is classified and continued through the real provider adapter',async t=>{
  const calls:Record<string,unknown>[]=[];
  const provider=createProviderAdapter({available:()=>true, command:'/unused', core:{
    CODEX_RUN_LIFECYCLE_VERSION:1,
    async runCodexAppServer(args) {
      calls.push(args);
      const identity={threadId:'thread-386',turnId:`native-${calls.length}`,dispatchState:'dispatched' as const};
      (args.onTurnAccepted as NonNullable<ProviderInput['onTurnAccepted']>)(identity);
      const event=args.onEvent as ProviderInput['onEvent'];
      event('turn/started',{threadId:identity.threadId,turn:{id:identity.turnId}});
      event('item/completed',{threadId:identity.threadId,item:{id:`native-tool-${calls.length}`,type:'commandExecution',command:'echo checked',exitCode:0}});
      event('turn/completed',{threadId:identity.threadId,turn:{id:identity.turnId,status:calls.length===1?'failed':'completed'}});
      return calls.length===1 ? {...failure(),...identity,recovery:undefined} : {status:'completed',finalMessage:'Recovered and finished.',...identity};
    },
    async callCodexConversation(){return {};},async interruptActiveCodexTurn(){return false;},clearCodexAppServerSessions(){},
  }});
  const f=await setup(t,async()=>{throw new Error('unused');},provider);
  await f.send();assert.equal(calls.length,1);
  assert.ok((await f.items()).some(i=>i.data?.kind==='turn-retry'&&i.status==='running'));
  mock.timers.tick(5000);await flush();assert.equal(calls.length,2);
  assert.equal(calls[1]!.threadId,'thread-386');assert.match(String(calls[1]!.prompt),/Continue from where you stopped/);
  assert.equal((await f.snapshot()).status,'completed');assert.ok((await f.items()).some(i=>i.text==='Recovered and finished.'));
});
