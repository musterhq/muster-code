/** #762: a streamed assistant reply is reconciled with the provider's completed text. The run drives the real service
 *  with a fake provider that sends the same events the coding client sends (agentMessage deltas, then item/completed). */
import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';

async function until(check:()=>boolean|Promise<boolean>,what='condition'){for(let i=0;i<400;i++){if(await check())return;await delay(5);}assert.fail(`${what} not reached`);}
const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];

async function replies(t:TestContext,events:(input:ProviderInput)=>void){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-762-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const service=createAgentService({dataDir,provider:{info,stop:async()=>true,dispose(){},run:async input=>{events(input);return {status:'completed',finalMessage:'',dispatchState:'dispatched'};}},onEvent(){}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
  await until(async()=>(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!.status==='completed','run settled');
  return (await service.invoke('chat.select',{id:chat.id})).filter(item=>item.kind==='assistant').map(item=>item.text);
}
const delta=(input:ProviderInput,text:string,itemId?:string)=>{input.onEvent('item/agentMessage/delta',itemId?{itemId,delta:text}:{delta:text});input.onDelta(text);};
const completed=(input:ProviderInput,id:string,text:string)=>input.onEvent('item/completed',{item:{type:'agentMessage',id,text}});

// Spec: MUS-SPEC-02-762A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-762a)
test('a reply whose stream stops partway is saved with the full completed text, once', async t=>{
  const saved=await replies(t,input=>{
    delta(input,'The migration ','m1');delta(input,'ran on ','m1');
    completed(input,'m1','The migration ran on all three databases and the counts match.');
  });
  assert.deepEqual(saved,['The migration ran on all three databases and the counts match.']);
});

// Spec: MUS-SPEC-02-762B (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-762b)
test('a piece with no item id does not stop later completed replies from being saved', async t=>{
  const saved=await replies(t,input=>{
    delta(input,'Checking the logs.');
    completed(input,'m1','Checking the logs.');
    completed(input,'m2','The log shows the timeout came from the router.');
  });
  assert.deepEqual(saved,['Checking the logs.','The log shows the timeout came from the router.']);
});
