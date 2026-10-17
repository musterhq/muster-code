/** A long streamed reply must not rewrite its whole text in SQLite on every delta (O(n²) bytes for one reply). */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const info:ProviderAdapter['info']=()=>[{id:'fx',name:'Fixture',available:true,identityMasked:'fx',models:[{id:'m',name:'M'}]}];

test('2000 deltas in one burst are stored with a handful of writes, and the final text is complete',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-stream-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  let release!:()=>void;const finished=new Promise<void>(resolve=>{release=resolve;});
  const provider:ProviderAdapter={info,stop:async()=>false,dispose(){},run:async input=>{
    input.onThreadReady('th');input.onTurnAccepted({threadId:'th',turnId:'tu'});
    for(let i=0;i<2000;i++)input.onDelta(`${i} `);
    await new Promise(resolve=>setTimeout(resolve,50));
    release();
    return {status:'completed',finalMessage:'',threadId:'th',turnId:'tu',dispatchState:'dispatched'};
  }};
  let revision=0;
  const service=createAgentService({dataDir,provider,onEvent(event){if(event.type==='timelinePatch')revision=Math.max(revision,event.patch.revision);}});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'r1'});
  await finished;
  for(let i=0;i<100&&(await service.invoke('app.snapshot',undefined)).chats[0]!.status==='running';i++)await new Promise(resolve=>setTimeout(resolve,10));
  const items=(await service.invoke('chat.timeline',{id:chat.id})).items;
  const reply=items.find(item=>item.kind==='assistant');
  assert.equal(reply?.text,Array.from({length:2000},(_,i)=>`${i} `).join(''));
  assert.equal(reply?.status,'completed');
  // Each row write moves the timeline revision; one per delta would put it above 2000.
  assert.ok(revision<50,`timeline revision ${revision} after one streamed reply`);
});
