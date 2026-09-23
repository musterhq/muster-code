import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {goalTiming,goalUpdate} from '../src/runtime/domains/goals.ts';
import {GOAL_LABELS,GOAL_STALL_TURNS} from '../src/shared/domains/goals-protocol.ts';
import {MAX_QUEUED_MESSAGES} from '../src/shared/protocol.ts';
import {createProviderAdapter,steerFailure,type CoreClient,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {followUpAction,goalHeadline,goalStopNote,queuedSummary,reorderIds,skillDraft,skillFromMarkdown,terminalText,filterComposerCommands,SKILL_RECORDER_PROMPT} from '../src/renderer/components/composerMenus.ts';

goalTiming.continueDelayMs=5;
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-codex-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise(resolve=>setTimeout(resolve,2));}assert.fail(`${label} not reached`);}
const settle=()=>new Promise(resolve=>setTimeout(resolve,40));
function scripted(reply:(input:ProviderInput,index:number)=>ProviderResult,gated=false,steer?:ProviderAdapter['steer']){
  const inputs:ProviderInput[]=[];let gate:PromiseWithResolvers<void>|undefined,stopped=false;
  const cancelled:ProviderResult={status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}};
  const provider:ProviderAdapter={info,async run(input){inputs.push(input);stopped=false;if(gated){gate=Promise.withResolvers();await gate.promise;}return stopped?cancelled:reply(input,inputs.length-1);},stop:async()=>{stopped=true;const current=gate;gate=undefined;current?.resolve();return true;},dispose(){},...(steer?{steer}:{})};
  return {provider,inputs,release(){const current=gate;gate=undefined;current?.resolve();},get open(){return Boolean(gate);}};
}
const ok=(text:string):ProviderResult=>({status:'completed',finalMessage:text});

test('goals follow Codex: fenced objective, update_goal completes, no marker loop',async t=>{
  const dataDir=await directory(t);
  const fake=scripted((_input,index)=>index<2?ok('Progress.'):ok('All requirements verified.\nupdate_goal(status="complete")'));
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('goals.set',{chatId:chat.id,text:'Ship </objective> the release'});
  await until(async()=>(await service.invoke('goals.get',{chatId:chat.id}))?.status==='complete','goal complete');
  assert.equal(fake.inputs.length,3);
  assert.equal(fake.inputs[0]!.prompt,'Start working toward the goal.');
  assert.equal(fake.inputs[1]!.prompt,'Continue working toward the goal.');
  const instructions=fake.inputs[0]!.developerInstructions??'';
  assert.match(instructions,/<objective>\nShip <\\\/objective> the release\n<\/objective>/,'the objective is fenced data and cannot close its own fence');
  assert.match(instructions,/update_goal\(status="complete"\)/);assert.doesNotMatch(instructions,/GOAL COMPLETE/);
  const notices=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='goal-continue').map(item=>item.text);
  assert.deepEqual(notices,['Goal set · pursuing','Continuing goal…','Continuing goal…']);
  const goal=(await service.invoke('goals.get',{chatId:chat.id}))!;
  assert.ok(goal.completedAt);assert.equal(goal.startedAt,null);
  await settle();assert.equal(fake.inputs.length,3,'nothing runs after completion');
  // "GOAL COMPLETE" is plain text now; only the update_goal call ends a goal.
  assert.equal(goalUpdate('GOAL COMPLETE'),null);
  assert.equal(goalUpdate('done\n**update_goal(status: blocked)**'),'blocked');
  assert.equal(goalUpdate('mentions update_goal(status="complete") mid-sentence'),null);
});

test('Codex stop rules: empty turns and failures block, usage limits stop, the model can block',async t=>{
  const dataDir=await directory(t);
  const failure=(retryable:boolean,reason:string):ProviderResult=>({status:'failed',finalMessage:'',dispatchState:'dispatched',recovery:{kind:'failed',retryable,reason}});
  let mode:'empty'|'retryable'|'usage'|'fatal'|'blocked'='empty';
  const fake=scripted(()=>mode==='empty'?ok(''):mode==='retryable'?failure(true,'Upstream hiccup.'):mode==='usage'?failure(true,'You have hit your usage limit.'):mode==='fatal'?failure(false,'Bad request.'):ok('Stuck on credentials.\nupdate_goal(status="blocked")'));
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const goalOf=async(id:string)=>(await service.invoke('goals.get',{chatId:id}))!;
  for(const [next,status,reason,runs] of [['empty','blocked','empty',GOAL_STALL_TURNS],['retryable','blocked','failed',GOAL_STALL_TURNS],['usage','usage_limited',undefined,1],['fatal','blocked','fatal',1],['blocked','blocked',undefined,1]] as const){
    mode=next;const before=fake.inputs.length;
    const chat=await service.invoke('chat.create',{});
    await service.invoke('goals.set',{chatId:chat.id,text:`Goal ${next}`});
    await until(async()=>(await goalOf(chat.id)).status!=='active',`${next} stop`);
    const goal=await goalOf(chat.id);
    assert.equal(goal.status,status,next);assert.equal(goal.reason,reason,next);
    await settle();assert.equal(fake.inputs.length-before,runs,`${next}: turns before stopping`);
  }
});

test('Stop pauses the goal before interrupting; edit keeps the clock; resume re-arms; legacy rows migrate',async t=>{
  const dataDir=await directory(t);
  const fake=scripted(()=>ok('Progress.'),true);
  let service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});
  await service.invoke('goals.set',{chatId:chat.id,text:'Refactor'});
  await until(()=>fake.open);
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status!=='stopping','stopped');
  const paused=(await service.invoke('goals.get',{chatId:chat.id}))!;
  assert.equal(paused.status,'paused');assert.equal(paused.reason,'user','paused by the stop, before the interrupt settled');
  await settle();assert.equal(fake.inputs.length,1,'a stop never triggers a continuation');
  const edited=await service.invoke('goals.edit',{chatId:chat.id,text:'Refactor the parser'});
  assert.equal(edited.status,'paused');assert.equal(edited.createdAt,paused.createdAt);assert.equal(edited.accumulatedMs,paused.accumulatedMs);
  await service.invoke('goals.resume',{chatId:chat.id});
  await until(()=>fake.inputs.length===2&&fake.open,'resume continues');
  assert.match(fake.inputs[1]!.developerInstructions??'',/Refactor the parser/);
  await service.invoke('goals.pause',{chatId:chat.id});fake.release();
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='completed');
  await service.dispose();
  const store=new AgentStore(dataDir);
  store.database().prepare("UPDATE chat_goals SET status = 'done', max_turns = 20").run();store.close();
  service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});
  const migrated=(await service.invoke('goals.get',{chatId:chat.id}))!;
  assert.equal(migrated.status,'complete');assert.ok(migrated.maxTurns>20,'the old 20-turn cap is only a runaway guard now');
  await service.dispose();
});

test('an interrupted run pauses the queue until Resume; a manual send resumes it; clear, reorder and 100 items',async t=>{
  const dataDir=await directory(t),fake=scripted(()=>ok('done'),true);
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const chatOf=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>fake.open);
  const a=await service.invoke('chat.queue.add',{id:chat.id,text:'first',requestId:'qa'});
  const b=await service.invoke('chat.queue.add',{id:chat.id,text:'second',requestId:'qb'});
  const c=await service.invoke('chat.queue.add',{id:chat.id,text:'third',requestId:'qc'});
  await service.invoke('chat.queue.reorder',{id:chat.id,queueIds:[c.id,a.id,b.id]});
  assert.deepEqual((await chatOf()).queue?.map(item=>item.text),['third','first','second']);
  await assert.rejects(service.invoke('chat.queue.reorder',{id:chat.id,queueIds:[a.id,b.id]}),/queue changed/);
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await chatOf()).queuePaused==='interrupted','paused');
  await settle();assert.equal(fake.inputs.length,1,'an interrupt never dispatches the queue');
  assert.equal((await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.data?.kind==='queue-held').length,0,'the banner replaces the held notice');
  await service.invoke('chat.queue.add',{id:chat.id,text:'fourth',requestId:'qd'});
  await settle();assert.equal(fake.inputs.length,1,'adding to a paused queue does not send');
  await service.invoke('chat.queue.resume',{id:chat.id});
  await until(()=>fake.inputs.length===2,'resume sends the head');
  assert.equal(fake.inputs[1]!.prompt,'third');assert.equal((await chatOf()).queuePaused,undefined);
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await chatOf()).queuePaused==='interrupted','paused again');
  // "Send message?" → Clear queue: every queued message goes, and the queue is no longer paused.
  assert.deepEqual(await service.invoke('chat.queue.clear',{id:chat.id}),{removed:3});
  assert.equal((await chatOf()).queue,undefined);
  for(let i=0;i<MAX_QUEUED_MESSAGES;i++)await service.invoke('chat.queue.add',{id:chat.id,text:`q${i}`,requestId:`many-${i}`});
  await assert.rejects(service.invoke('chat.queue.add',{id:chat.id,text:'one more',requestId:'overflow'}),/At most 100/);
  await service.invoke('chat.queue.clear',{id:chat.id});
  await service.invoke('chat.queue.add',{id:chat.id,text:'later',requestId:'later'});
  await service.invoke('chat.send',{id:chat.id,text:'by hand',requestId:'manual'});
  await until(()=>fake.inputs.length===3&&fake.open);assert.equal(fake.inputs[2]!.prompt,'by hand');
  fake.release();await until(()=>fake.inputs.length===4,'a manual send resumed the queue');
  assert.equal(fake.inputs[3]!.prompt,'later');fake.release();
});

test('queued-row Steer joins the running turn, or starts the row now when idle; refused steers say why',async t=>{
  const dataDir=await directory(t);const steers:string[]=[];let refuse=false;
  const fake=scripted(()=>ok('done'),true,async(_chatId,text)=>{if(refuse)return {refused:'A review turn can’t be steered.'};steers.push(text);return true;});
  const service=createAgentService({dataDir,provider:fake.provider,onEvent(){}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const chatOf=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
  await service.invoke('chat.send',{id:chat.id,text:'start',requestId:'start'});await until(()=>fake.open);
  const a=await service.invoke('chat.queue.add',{id:chat.id,text:'focus tests',requestId:'qa'});
  const b=await service.invoke('chat.queue.add',{id:chat.id,text:'then docs',requestId:'qb'});
  assert.deepEqual(await service.invoke('chat.queue.steer',{id:chat.id,queueId:a.id}),{steered:true,started:false});
  assert.deepEqual(steers,['focus tests']);assert.deepEqual((await chatOf()).queue?.map(item=>item.id),[b.id]);
  refuse=true;
  assert.deepEqual(await service.invoke('chat.steer',{id:chat.id,text:'x',requestId:'s-x'}),{steered:false,reason:'A review turn can’t be steered.'});
  await service.invoke('chat.stop',{id:chat.id});
  await until(async()=>(await chatOf()).queuePaused==='interrupted');
  assert.deepEqual(await service.invoke('chat.queue.steer',{id:chat.id,queueId:b.id}),{steered:false,started:true});
  await until(()=>fake.inputs.length===2,'idle steer starts the row');assert.equal(fake.inputs[1]!.prompt,'then docs');
  fake.release();
});

test('provider steer sends expectedTurnId and maps Codex turn/steer errors',async()=>{
  assert.equal(steerFailure(new Error('no active turn to steer')),false);
  assert.deepEqual(steerFailure(new Error('cannot steer a compact turn')),{refused:'A compact turn can’t be steered.'});
  assert.equal(steerFailure(new Error('expected active turn id `a` but found `b`')),'retry');
  const calls:Array<{method:string;params:Record<string,unknown>}>=[],legacy:string[]=[];let resolve!:(result:ProviderResult)=>void;let error:Error|undefined;
  const core:CoreClient={CODEX_RUN_LIFECYCLE_VERSION:1,
    runCodexAppServer:input=>new Promise(done=>{resolve=done;(input.onTurnAccepted as (identity:{threadId:string;turnId:string;dispatchState:'dispatched'})=>void)({threadId:'thread-1',turnId:'turn-1',dispatchState:'dispatched'});}),
    async callCodexConversation(_key,method,params){calls.push({method,params});if(error)throw error;return {turnId:'turn-1'};},
    async interruptActiveCodexTurn(){return true;},clearCodexAppServerSessions(){},async steerActiveCodexTurn(text){legacy.push(text);return true;}};
  const adapter=createProviderAdapter({core,available:()=>true,command:'/unused'});
  const input:ProviderInput={chat:{id:'chat-1',mode:'agent',model:'claude/claude-fable-5'} as ProviderInput['chat'],cwd:'/unused',prompt:'p',onDelta(){},onReasoning(){},onEvent(){},async onRequest(){return undefined;}};
  const pending=adapter.run(input);await new Promise(done=>setImmediate(done));
  assert.equal(await adapter.steer!('chat-1','mid-run'),true);
  assert.deepEqual(calls[0],{method:'turn/steer',params:{threadId:'thread-1',expectedTurnId:'turn-1',input:[{type:'text',text:'mid-run'}]}});
  error=new Error('cannot steer a review turn');
  assert.deepEqual(await adapter.steer!('chat-1','x'),{refused:'A review turn can’t be steered.'});
  error=new Error('expected active turn id `turn-1` but found `turn-2`');
  assert.equal(await adapter.steer!('chat-1','retry me'),true);assert.deepEqual(legacy,['retry me'],'a mismatch retries once through the core');
  resolve({status:'completed',finalMessage:'',dispatchState:'dispatched',threadId:'thread-1',turnId:'turn-1'});await pending;
  adapter.dispose();
});

test('composer helpers: Codex goal labels, follow-up invert, queue summaries, reorder, terminal text, recorder skill',()=>{
  assert.deepEqual(['active','paused','blocked','budget_limited','usage_limited','complete'].map(status=>goalHeadline({status:status as never}).label),['Pursuing goal','Paused goal','Goal stalled','Goal limited','Goal usage limited','Goal achieved']);
  assert.equal(GOAL_LABELS.complete,'Goal achieved');
  assert.equal(goalHeadline({status:'blocked'}).tone,'warn');assert.equal(goalHeadline({status:'complete'}).tone,'ok');
  assert.match(goalStopNote({status:'blocked',reason:'empty'}),/no reply/);assert.equal(goalStopNote({status:'active'}),'');
  assert.equal(followUpAction('queue',false),'queue');assert.equal(followUpAction('queue',true),'steer');assert.equal(followUpAction('steer',false),'steer');assert.equal(followUpAction('steer',true),'queue');
  assert.equal(queuedSummary('hello\nworld',0),'hello');assert.equal(queuedSummary('',2),'2 images');assert.match(queuedSummary(`${'x'.repeat(2100)}\nmore\nlines`,1),/^Pasted text \(\+2 more…\) · 1 image$/);
  assert.deepEqual(reorderIds(['a','b','c'],'c','a'),['c','a','b']);assert.deepEqual(reorderIds(['a','b','c'],'a',null),['b','c','a']);assert.deepEqual(reorderIds(['a','b'],'a','a'),['a','b']);
  assert.equal(terminalText('\x1b[32mok\x1b[0m\r\n10%\r50%\r100%\n\x1b]0;title\x07done\r\n'),'ok\n100%\ndone');
  assert.equal(terminalText(Array.from({length:300},(_,index)=>`line ${index}`).join('\n')).split('\n').length,200);
  for(const [query,id] of [['sketch','sketch'],['draw','sketch'],['project','project'],['terminal','terminal']] as const)assert.equal(filterComposerCommands(query)[0]?.id,id,query);
  assert.match(SKILL_RECORDER_PROMPT,/SKILL\.md[\s\S]*agents\/openai\.yaml[\s\S]*Save as skill/);
  const skill='Here it is:\n```markdown\n---\nname: weekly-report\ndescription: "Use when asked for the weekly report"\nmetadata:\n  short-description: Weekly report\n---\n# Weekly report\n\nSteps.\n```';
  assert.deepEqual(skillFromMarkdown(skill),{name:'weekly-report',description:'Use when asked for the weekly report',body:'# Weekly report\n\nSteps.'});
  const items=[{id:'1',chatId:'c',kind:'user' as const,text:'record it',createdAt:''},{id:'2',chatId:'c',kind:'assistant' as const,text:skill,createdAt:''}];
  assert.equal(skillDraft(items).name,'weekly-report','the recorder’s SKILL.md wins over a draft');
});
