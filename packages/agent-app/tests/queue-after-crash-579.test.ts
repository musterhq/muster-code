import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import {NativeUnavailableError} from '../src/runtime/codex-native.ts';
import type {ProviderAdapter,ProviderInput,ProviderResult} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',bindingId:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-579-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}
async function until(check:()=>boolean|Promise<boolean>,label='condition'){for(let i=0;i<1500;i++){if(await check())return;await new Promise<void>(resolve=>setImmediate(resolve));}assert.fail(`${label} not reached`);}

/**
 * One Codex app-server per process, sharing the thread's saved queue across relaunches (the app-server persists it with the thread). It holds the follow-ups queued through thread/queue/add and, like the real one, starts the head
 * itself when a turn ends. `sent` is what the model received, from Muster's own run() and from the app-server's own queue.
 */
function codexProcess(held=new Map<string,string>(),ids={next:0}){
  const sent:string[]=[];let live=false,gate:PromiseWithResolvers<ProviderResult>|undefined,hold=false;
  const provider:ProviderAdapter={info,
    async run(input:ProviderInput){sent.push(input.prompt);live=true;input.onThreadReady?.('thread-1');input.onTurnAccepted?.({threadId:'thread-1',turnId:`turn-${sent.length}`,dispatchState:'dispatched'});
      if(hold){gate=Promise.withResolvers();return gate.promise;}
      return {status:'completed',finalMessage:'done',threadId:'thread-1',turnId:`turn-${sent.length}`};},
    stop:async()=>true,dispose(){},
    nativeThread:()=>live?{threadId:'thread-1',providerId:'hybrow',bindingId:'fixture'}:undefined,
    async nativeCall(_chat,method,params){
      if(!live)throw new NativeUnavailableError();
      if(method==='thread/queue/add'){const id=`sub-${++ids.next}`;held.set(id,String((params.input as {text:string}[])[0]!.text));return {queuedSubmission:{id}};}
      if(method==='thread/queue/delete'){held.delete(String(params.queuedSubmissionId));return {};}
      if(method==='thread/queue/list')return {data:[...held.keys()].map(id=>({id})),nextCursor:null};
      return {};
    }};
  return {provider,sent,held,hold(on:boolean){hold=on;},get open(){return Boolean(gate);},
    finish(){const current=gate;gate=undefined;current?.resolve({status:'completed',finalMessage:'done',threadId:'thread-1',turnId:'turn-x'});},
    /** The app-server's own dispatch when the thread goes idle: it sends whatever it still holds. */
    drainOwnQueue(){for(const [id,text] of [...held]){held.delete(id);sent.push(text);}}};
}

// Spec: MUS-SPEC-02-579A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-579a)
test('a message queued before a crash is sent once after Continue anyway and Steer',async t=>{
  const dataDir=await directory(t);
  // Process one: a Codex turn is running and a follow-up is queued (and handed to the app-server). Then kill -9: nothing is disposed.
  const before=codexProcess();before.hold(true);
  const doomed=createAgentService({dataDir,provider:before.provider,onEvent(){}});
  const chat=await doomed.invoke('chat.create',{});
  await doomed.invoke('chat.send',{id:chat.id,text:'run the long command',requestId:'first-request'});
  await until(()=>before.open,'turn running');
  const queued=await doomed.invoke('chat.queue.add',{id:chat.id,text:'Queued after kill: reply QUEUED-SURVIVED.',requestId:'queued-request'});
  await until(()=>before.held.size===1,'mirrored into the app-server');

  // Process two: relaunch over the same data directory with a fresh app-server.
  const after=codexProcess(before.held);
  const service=createAgentService({dataDir,provider:after.provider,onEvent(){}});t.after(()=>service.dispose());
  const restored=(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!;
  assert.equal(restored.recovery?.kind,'recovery-needed','the banner offers Continue anyway');
  assert.deepEqual(restored.queue?.map(item=>item.id),[queued.id],'the queue survived the crash');

  await service.invoke('chat.continueAnyway',{id:chat.id});
  await service.invoke('chat.queue.steer',{id:chat.id,queueId:queued.id});
  await until(()=>after.sent.length>=1,'the queued message reached the provider');
  // The thread goes idle: whatever the app-server still holds for this thread starts now.
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!.status==='completed','turn settled');
  after.drainOwnQueue();

  assert.deepEqual(after.sent,['Queued after kill: reply QUEUED-SURVIVED.'],'the provider received the queued text exactly once');
  const users=(await service.invoke('chat.timeline',{id:chat.id})).items.filter(item=>item.kind==='user'&&item.text.includes('QUEUED-SURVIVED'));
  assert.equal(users.length,1,'the transcript has one copy');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!.queue,undefined,'the queue is empty');
});
