import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {AgentStore} from '../src/runtime/store.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {ProviderPreDispatchError,type ProviderAdapter,type ProviderInput,type ProviderResult} from '../src/runtime/provider.ts';
import {reconcileProviderTurn,type ProviderStatusQuery} from '../src/runtime/provider-reconciliation.ts';
import type {Chat,ChatRecovery} from '../src/shared/protocol.ts';

const recovery: ChatRecovery={kind:'recovery-needed',retryable:false,reason:'Provider cancellation could not be confirmed; inspect the existing turn.'};
const info: ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t: TestContext) {const path=await mkdtemp(join(tmpdir(),'muster-recovery-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('send receipt clears prior turn atomically and orphan recovery preserves actual accepted identity',async t=>{
  const dataDir=await directory(t);
  let store=new AgentStore(dataDir);
  const chat=store.createChat({model:'fixture',mode:'agent'});
  store.updateChat(chat.id,{providerThreadId:'thread',providerTurnId:'old-turn'});
  const receipt=store.recordSend(chat.id,'request-one','hello');
  assert.equal(store.chat(chat.id)?.providerTurnId,undefined);
  store.updateChat(chat.id,{providerTurnId:'accepted-turn'});
  assert.deepEqual(store.recordSend(chat.id,'request-one','hello'),{...receipt,replay:true});
  assert.equal(store.chat(chat.id)?.providerTurnId,'accepted-turn');
  store.close(); store=new AgentStore(dataDir);
  assert.deepEqual(store.recoverOrphanedRuns(),[chat.id]);
  const restored=store.chat(chat.id)!;
  assert.equal(restored.providerThreadId,'thread');assert.equal(restored.providerTurnId,'accepted-turn');
  assert.equal(restored.recovery?.kind,'recovery-needed');assert.equal(restored.status,'failed');
  assert.throws(()=>store.recordSend(chat.id,'different-request','hello'),/status checked/);
  assert.equal(store.recordSend(chat.id,'request-one','hello').runId,receipt.runId);
  assert.equal(store.timeline(chat.id).at(-1)?.data?.recovery && true,true);
  store.close();
});

test('older chat database receives additive recovery columns without rewriting saved thread',async t=>{
  const dataDir=await directory(t),db=new DatabaseSync(join(dataDir,'muster-agent.sqlite'));
  db.exec("CREATE TABLE chats (id TEXT PRIMARY KEY,folder_id TEXT,project_id TEXT,title TEXT NOT NULL,pinned INTEGER NOT NULL DEFAULT 0,pin_order INTEGER,archived INTEGER NOT NULL DEFAULT 0,draft TEXT NOT NULL DEFAULT '',status TEXT NOT NULL DEFAULT 'idle',updated_at TEXT NOT NULL,provider_thread_id TEXT,model TEXT NOT NULL,mode TEXT NOT NULL DEFAULT 'agent',error TEXT); INSERT INTO chats (id,title,updated_at,provider_thread_id,model) VALUES ('legacy','Legacy','now','legacy-thread','fixture')");
  db.close();
  const store=new AgentStore(dataDir);
  assert.equal(store.chat('legacy')?.providerThreadId,'legacy-thread');
  store.updateChat('legacy',{providerTurnId:'accepted',recovery});
  assert.equal(store.chat('legacy')?.recovery?.kind,'recovery-needed');store.close();
});

test('reconciliation queries only explicit gateway and requires exact thread/turn terminal proof',async()=>{
  let calls=0;
  let response:Record<string,unknown>={thread:{id:'expected-thread',turns:[{id:'expected-turn',status:'inProgress'}]}};
  const query:ProviderStatusQuery=async(method,params,options)=>{
    calls++;assert.equal(method,'thread/read');assert.deepEqual(params,{threadId:'expected-thread',includeTurns:true});
    assert.equal(options.command,'/fixture/runtime/resources/codex-hybrow-gateway.sh');assert.equal(options.cwd,'/fixture/workspace');assert.equal(options.timeoutMs,5000);
    assert.ok(Object.hasOwn(options.env,'MUSTER_PROVIDER_NODE'));return response;
  };
  const instances=[{info:{id:'hybrow',name:'Hybrow',available:true,bindingId:'fixture',identityMasked:'Hidden',models:[]},command:'/fixture/runtime/resources/codex-hybrow-gateway.sh',env:{MUSTER_PROVIDER_NODE:'node'},sessionsRoot:'/fixture/sessions'}];
  const input={providerId:'hybrow',providerBindingId:'fixture',threadId:'expected-thread',turnId:'expected-turn',cwd:'/fixture/workspace'};
  assert.equal((await reconcileProviderTurn(input,query,'/fixture/runtime',instances)).resolved,false);
  for (const thread of [
    {id:'other-thread',turns:[{id:'expected-turn',status:'completed'}]},
    {id:'expected-thread',status:'idle',turns:[{id:'other-turn',status:'completed'}]},
    {id:'expected-thread',turns:[{id:'expected-turn',status:'unknown'}]},
    {id:'expected-thread',turns:[{id:'expected-turn',status:'completed'},{id:'expected-turn',status:'completed'}]},
  ]) {response={thread};assert.equal((await reconcileProviderTurn(input,query,'/fixture/runtime',instances)).resolved,false);}
  response={thread:{id:'expected-thread',turns:[{id:'expected-turn',status:'interrupted'}]}};
  assert.equal((await reconcileProviderTurn(input,query,'/fixture/runtime',instances)).terminalStatus,'interrupted');
  const before=calls;
  assert.equal((await reconcileProviderTurn({...input,turnId:''},query,'/fixture/runtime',instances)).resolved,false);assert.equal(calls,before);
  const failed=await reconcileProviderTurn(input,async()=>{throw new Error('private credential contents');},'/fixture/runtime',instances);
  assert.equal(failed.resolved,false);assert.doesNotMatch(failed.reason,/private credential/);
});

test('service persists accepted IDs before completion; replay survives block and exact recovery unlocks',async t=>{
  const dataDir=await directory(t),finish=Promise.withResolvers<ProviderResult>(),started=Promise.withResolvers<void>();
  let calls=0,terminal=false,checkCalls=0;
  const waiters:{predicate:(chat:Chat)=>boolean;resolve:(chat:Chat)=>void}[]=[];
  const provider:ProviderAdapter={info,run:async input=>{
    calls++;input.onThreadReady?.('provider-thread');input.onTurnAccepted?.({threadId:'provider-thread',turnId:`turn-${calls}`,dispatchState:'dispatched'});started.resolve();
    return calls===1 ? finish.promise : {status:'completed',finalMessage:'done',threadId:'provider-thread',turnId:`turn-${calls}`};
  },stop:async()=>{finish.resolve({status:'failed',finalMessage:'',threadId:'provider-thread',turnId:'turn-1',recovery});return true;},dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent:event=>{if(event.type==='snapshot')for(const waiter of [...waiters]){const chat=event.snapshot.chats.find(waiter.predicate);if(chat){waiters.splice(waiters.indexOf(waiter),1);waiter.resolve(chat);}}},reconcileProvider:async input=>{
    checkCalls++;assert.deepEqual(input,{threadId:'provider-thread',turnId:'turn-1',cwd:join(dataDir,'scratch',chat.id),providerId:'hybrow',providerBindingId:'hybrow'});
    return terminal ? {resolved:true,terminalStatus:'interrupted',reason:'Saved turn confirmed interrupted.'} : {resolved:false,reason:'Still running at provider.'};
  }});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  const receipt=await service.invoke('chat.send',{id:chat.id,text:'first message',requestId:'request-one'});await started.promise;
  const disk=new AgentStore(dataDir);assert.equal(disk.chat(chat.id)?.providerTurnId,'turn-1');disk.close();
  const settled=new Promise<Chat>(resolve=>waiters.push({predicate:value=>value.id===chat.id&&value.recovery?.kind==='recovery-needed',resolve}));
  await service.invoke('chat.stop',{id:chat.id});const stopped=await settled;
  assert.equal(stopped.status,'failed');assert.match(stopped.error??'',/could not be confirmed/);
  assert.deepEqual(await service.invoke('chat.send',{id:chat.id,text:'first message',requestId:'request-one'}),receipt);
  await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'next',requestId:'request-two'}),/Check its status/);assert.equal(calls,1);
  assert.equal((await service.invoke('chat.reconcile',{id:chat.id})).resolved,false);
  terminal=true;assert.equal((await service.invoke('chat.reconcile',{id:chat.id})).resolved,true);assert.equal(checkCalls,2);
  const second=new Promise<Chat>(resolve=>waiters.push({predicate:value=>value.id===chat.id&&value.status==='completed',resolve}));
  await service.invoke('chat.send',{id:chat.id,text:'next',requestId:'request-two'});await second;assert.equal(calls,2);
});

test('missing accepted turn cannot unlock; tagged predispatch rejection does not block future sends',async t=>{
  const dataDir=await directory(t);let called=0;
  const provider:ProviderAdapter={info,run:async()=>{called++;throw new ProviderPreDispatchError('Capacity reached before dispatch.');},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){},reconcileProvider:async()=>{assert.fail('missing identity must not query');}});t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'one',requestId:'one'});
  await new Promise(resolve=>setImmediate(resolve));
  assert.equal((await service.invoke('app.snapshot',undefined)).chats[0]?.recovery?.kind,'failed');
  await service.invoke('chat.send',{id:chat.id,text:'two',requestId:'two'});await new Promise(resolve=>setImmediate(resolve));assert.equal(called,2);
  const store=new AgentStore(dataDir);store.updateChat(chat.id,{recovery,providerTurnId:null});store.close();
  const checked=await service.invoke('chat.reconcile',{id:chat.id});assert.equal(checked.resolved,false);assert.match(checked.reason,/identity/);
});

test('dispose waits for owned callbacks before closing DB and prevents fresh dispatch',async t=>{
  const dataDir=await directory(t),started=Promise.withResolvers<void>(),finish=Promise.withResolvers<ProviderResult>();
  let input:ProviderInput|undefined;
  const provider:ProviderAdapter={info,run:async value=>{input=value;started.resolve();return finish.promise;},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  const chat=await service.invoke('chat.create',{});await service.invoke('chat.send',{id:chat.id,text:'pending',requestId:'pending'});await started.promise;
  let disposed=false;const disposal=service.dispose().then(()=>{disposed=true;});await new Promise(resolve=>setImmediate(resolve));assert.equal(disposed,false);
  await assert.rejects(service.invoke('chat.send',{id:chat.id,text:'new',requestId:'new'}),/stopping/);
  input!.onThreadReady?.('late-thread');input!.onTurnAccepted?.({threadId:'late-thread',turnId:'late-turn',dispatchState:'dispatched'});
  finish.resolve({status:'failed',finalMessage:'',threadId:'late-thread',turnId:'late-turn',recovery});await disposal;
  const store=new AgentStore(dataDir);assert.equal(store.chat(chat.id)?.providerTurnId,'late-turn');assert.equal(store.chat(chat.id)?.recovery?.kind,'recovery-needed');store.close();
});

test('unresolved provider work blocks another chat in the same folder but preserves its draft',async t=>{
  const dataDir=await directory(t);let calls=0;
  const provider:ProviderAdapter={info,run:async()=>{calls++;return {status:'completed',finalMessage:'done'};},stop:async()=>true,dispose(){}};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const folder=await service.invoke('folder.add',{path:dataDir});
  const first=await service.invoke('chat.create',{folderId:folder.id}),second=await service.invoke('chat.create',{folderId:folder.id});
  await service.invoke('chat.update',{id:second.id,draft:'keep this draft'});
  const store=new AgentStore(dataDir);store.updateChat(first.id,{status:'failed',providerThreadId:'remote-thread',providerTurnId:'remote-turn',recovery});store.close();
  await assert.rejects(service.invoke('chat.send',{id:second.id,text:'new work',requestId:'new-work'}),/Another chat in this folder/);
  assert.equal(calls,0);assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===second.id)?.draft,'keep this draft');
});
