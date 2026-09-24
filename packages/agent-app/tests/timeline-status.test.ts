import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

test('reasoning is sealed before prose and failed commands retain their failure status', async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-status-'));
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow OmniRoute',available:true,identityMasked:'test',models:[{id:'claude/claude-fable-5',name:'Fable'}]}],stop:async()=>true,dispose(){},async run(input){
   input.onReasoning('Checking the file.');input.onDelta('I will inspect it.');
   input.onEvent('item/started',{item:{id:'command1',type:'commandExecution',command:'false'}});
   input.onEvent('item/completed',{item:{id:'command1',type:'commandExecution',command:'false',exitCode:1,aggregatedOutput:'failed'}});
   input.onDelta('The command failed.');return {status:'completed',finalMessage:'The command failed.'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.send',{id:chat.id,text:'Inspect',requestId:'status_test'});
 for(let i=0;i<30;i++){const snapshot=await service.invoke('app.snapshot',undefined);if(snapshot.chats[0].status==='completed')break;await sleep(10);}
 const rows=await service.invoke('chat.select',{id:chat.id});
 assert.deepEqual(rows.filter(row=>row.data?.kind!=='memory-offer').map(row=>[row.kind,row.status]),[['user',undefined],['reasoning','completed'],['assistant','completed'],['tool','failed'],['assistant','completed']]);
});


test('partial completion keeps streamed output and metadata; late output cannot restart a finished command', async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-output-'));
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow OmniRoute',available:true,identityMasked:'test',models:[{id:'claude/claude-fable-5',name:'Fable'}]}],stop:async()=>true,dispose(){},async run(input){
   input.onEvent('item/started',{item:{id:'c',type:'commandExecution',command:'check',cwd:'/fixture'}});
   input.onEvent('item/commandExecution/outputDelta',{itemId:'c',delta:'first\n'});
   input.onEvent('item/commandExecution/outputDelta',{itemId:'c',delta:'last\n'});
   input.onEvent('item/completed',{item:{id:'c',type:'commandExecution',exitCode:0,aggregatedOutput:'last\n'}});
   input.onEvent('item/commandExecution/outputDelta',{itemId:'c',delta:'late'});
   return {status:'completed',finalMessage:''};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.send',{id:chat.id,text:'check',requestId:'output_test'});
 for(let i=0;i<30;i++){if((await service.invoke('app.snapshot',undefined)).chats[0].status==='completed')break;await sleep(10);}
 const tool=(await service.invoke('chat.select',{id:chat.id})).find(row=>row.kind==='tool')!;
 assert.equal(tool.status,'completed');assert.equal(tool.data?.output,'first\nlast\n');
 assert.equal(tool.data?.name,'check');assert.equal(tool.data?.cwd,'/fixture');
});

test('a run orphaned by a restart comes back interrupted with a status check, not failed',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-status-restart-'));
 const {AgentStore}=await import('../src/runtime/store.ts');
 const store=new AgentStore(dataDir);const chat=store.createChat({model:'claude/claude-fable-5',mode:'agent'});store.updateChat(chat.id,{status:'running'});store.close();
 const reopened=new AgentStore(dataDir);t.after(async()=>{reopened.close();await rm(dataDir,{recursive:true,force:true});});
 assert.deepEqual(reopened.recoverOrphanedRuns(),[chat.id]);
 const restored=reopened.chat(chat.id)!;
 assert.equal(restored.status,'interrupted');assert.equal(restored.recovery?.kind,'recovery-needed');assert.match(restored.recovery?.reason??'',/May still be running at the provider/);
});

test('a manual compaction still running when the app closed is settled as failed on restart, not left spinning',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-status-compact-restart-'));
 const {AgentStore}=await import('../src/runtime/store.ts');
 const store=new AgentStore(dataDir);const chat=store.createChat({model:'claude/claude-fable-5',mode:'agent'});
 const row=store.appendItem(chat.id,'notice','Compacting context…','running',{kind:'compaction',status:'running',manual:true});
 store.close();
 const service=createAgentService({dataDir,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const restored=(await service.invoke('chat.select',{id:chat.id})).find(item=>item.id===row.id)!;
 assert.equal(restored.status,'failed');
 assert.match(restored.text,/restarted while it was in progress/);
});

test('thread/compacted appends a compaction row; manual compact records intent then completion or failure',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-status-compact-'));let fail=false;
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'test',models:[{id:'claude/claude-fable-5',name:'Fable'}]}],stop:async()=>true,dispose(){},
  async run(input){input.onEvent('thread/compacted',{threadId:'t'});input.onDelta('Done.');return {status:'completed',finalMessage:'Done.'};},
  async compact(){if(fail)throw new Error('No live provider session holds this thread.');}};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.send',{id:chat.id,text:'long work',requestId:'compact-1'});
 for(let i=0;i<100&&(await service.invoke('app.snapshot',undefined)).chats[0]?.status==='running';i++)await sleep(2);
 const rows=async()=>(await service.invoke('chat.select',{id:chat.id})).filter(item=>item.data?.kind==='compaction').map(item=>`${item.status}:${item.text}`);
 assert.deepEqual(await rows(),['completed:Context automatically compacted']);
 await service.invoke('chat.compact',{id:chat.id});
 assert.deepEqual((await rows()).at(-1),'completed:Context compacted');
 fail=true;
 await assert.rejects(service.invoke('chat.compact',{id:chat.id}),/No live provider session/);
 assert.match((await rows()).at(-1)!,/^failed:Compaction failed: No live provider session/);
});

test('reasoning streams into its own rows: parts separated, a completion-only summary still arrives, never duplicated', async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-reasoning-'));
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow OmniRoute',available:true,identityMasked:'test',models:[{id:'claude/claude-fable-5',name:'Fable'}]}],stop:async()=>true,dispose(){},async run(input){
   // Codex order: onEvent fires for every notification, then the summary delta is routed to onReasoning.
   const delta=(itemId:string,text:string)=>{input.onEvent('item/reasoning/summaryTextDelta',{itemId,delta:text});input.onReasoning(text);};
   input.onEvent('item/started',{item:{id:'r1',type:'reasoning'}});
   input.onEvent('item/reasoning/summaryPartAdded',{itemId:'r1',summaryIndex:0});delta('r1','**Plan**');
   input.onEvent('item/reasoning/summaryPartAdded',{itemId:'r1',summaryIndex:1});delta('r1','Read the file.');
   input.onEvent('item/completed',{item:{id:'r1',type:'reasoning',summary:['**Plan**','Read the file.']}});
   input.onEvent('item/started',{item:{id:'r2',type:'reasoning'}});
   input.onEvent('item/completed',{item:{id:'r2',type:'reasoning',summary:[{type:'summary_text',text:'Only reported at the end.'}]}});
   input.onDelta('Done.');return {status:'completed',finalMessage:'Done.'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.send',{id:chat.id,text:'Think',requestId:'reasoning_test'});
 for(let i=0;i<30;i++){if((await service.invoke('app.snapshot',undefined)).chats[0].status==='completed')break;await sleep(10);}
 const rows=(await service.invoke('chat.select',{id:chat.id})).filter(row=>row.kind==='reasoning');
 assert.deepEqual(rows.map(row=>[row.text,row.status]),[['**Plan**\n\nRead the file.','completed'],['Only reported at the end.','completed']]);
});

test('TRN-18: review readiness runs working → preparing → ready and ignores out-of-order events', async () => {
  const {advanceReviewReadiness, REVIEW_READINESS_LABEL} = await import('../src/renderer/components/turnStatusModel.ts');
  let phase = advanceReviewReadiness(undefined, 'live');
  assert.equal(phase, 'working');
  phase = advanceReviewReadiness(phase, 'settled');
  assert.equal(phase, 'preparing'); assert.equal(REVIEW_READINESS_LABEL[phase], 'Preparing review…');
  phase = advanceReviewReadiness(phase, 'prepared');
  assert.equal(phase, 'ready'); assert.equal(REVIEW_READINESS_LABEL[phase], 'Ready to review');
  assert.equal(advanceReviewReadiness(undefined, 'settled'), undefined, 'a turn never seen running shows no phase');
  assert.equal(advanceReviewReadiness('working', 'prepared'), 'working', 'a stale preparation does not end a live run');
  assert.equal(advanceReviewReadiness('ready', 'live'), 'working', 'the next turn starts over');
});

test('TRN-18: a failed review preparation is an error state with Retry, never "Ready to review"', async () => {
  const {advanceReviewReadiness, REVIEW_READINESS_LABEL} = await import('../src/renderer/components/turnStatusModel.ts');
  let phase = advanceReviewReadiness(advanceReviewReadiness(undefined, 'live'), 'settled');
  assert.equal(phase, 'preparing');
  phase = advanceReviewReadiness(phase, 'failed');
  assert.equal(phase, 'failed');
  assert.equal(REVIEW_READINESS_LABEL[phase], 'Couldn’t prepare review');
  assert.notEqual(REVIEW_READINESS_LABEL[phase], REVIEW_READINESS_LABEL.ready);
  assert.equal(advanceReviewReadiness(phase, 'prepared'), 'failed', 'a late success from the failed attempt does not flip to ready');
  phase = advanceReviewReadiness(phase, 'retry');
  assert.equal(phase, 'preparing', 'Retry re-enters Preparing review…');
  assert.equal(advanceReviewReadiness(phase, 'prepared'), 'ready', 'a successful retry is Ready to review');
  assert.equal(advanceReviewReadiness('ready', 'failed'), 'ready', 'a stale failure does not undo a ready review');
  assert.equal(advanceReviewReadiness('ready', 'retry'), 'ready');
  const source = (await import('node:fs')).readFileSync(new URL('../src/renderer/components/TurnChanges.tsx', import.meta.url), 'utf8');
  assert.match(source, /prepareTurnReview\(chatId,folder\.id\)\.then\(done,failed\)/, 'rejection goes to failed, not done');
  assert.match(source, /changes-pill-retry/, 'the failed state renders a Retry button');
});
