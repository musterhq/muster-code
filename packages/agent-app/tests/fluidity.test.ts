import assert from 'node:assert/strict';
import {test,type TestContext} from 'node:test';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';
import {systemResourceSample} from '../src/runtime/resource-scheduler.ts';
import {createMemoryIdentity} from '../src/runtime/memory-identity.ts';

const info:ProviderAdapter['info']=()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}];
const provider:ProviderAdapter={info,run:async()=>({status:'completed',finalMessage:'ok'}),stop:async()=>false,dispose(){}};
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function directory(t:TestContext){const path=await mkdtemp(join(tmpdir(),'muster-fluidity-'));t.after(()=>rm(path,{recursive:true,force:true}));return path;}

test('F3: a burst of state() calls coalesces into a leading and one trailing snapshot carrying the latest state',async t=>{
  const events:AgentEvent[]=[];
  const service=createAgentService({dataDir:await directory(t),provider,onEvent:event=>events.push(event)});
  t.after(()=>service.dispose());
  const chat=await service.invoke('chat.create',{});
  await sleep(200);
  const before=events.filter(event=>event.type==='snapshot').length;
  await Promise.all(Array.from({length:40},(_,i)=>service.invoke('chat.update',{id:chat.id,title:`title ${i}`})));
  await sleep(250);
  const snapshots=events.slice().filter(event=>event.type==='snapshot').slice(before) as Extract<AgentEvent,{type:'snapshot'}>[];
  assert.ok(snapshots.length>=1&&snapshots.length<=3,`40 updates emit ${snapshots.length} snapshots, not 40`);
  const last=snapshots.at(-1)!.snapshot.chats.find(entry=>entry.id===chat.id)!;
  assert.match(last.title,/^title \d+$/,'the trailing snapshot is the latest state, never an older one');
  assert.equal(last.title,(await service.invoke('app.snapshot',undefined)).chats.find(entry=>entry.id===chat.id)!.title);
});

test('F2a: sampling resources never spawns sysctl synchronously and refreshes the macOS level in the background',async()=>{
  assert.doesNotMatch(await readFile(new URL('../src/runtime/resource-scheduler.ts',import.meta.url),'utf8'),/execFileSync/,'no synchronous process spawn on the main process');
  let reads=0,deliver:((level:number)=>void)|undefined;
  const reader=(on:(level:number)=>void)=>{reads++;deliver=on;};
  const started=Date.now();
  const first=systemResourceSample(Date.now(),reader);
  assert.ok(Date.now()-started<50,'sampling returns without waiting for the reader');
  assert.ok(first.freeBytes>0&&first.totalBytes>0);
  if(process.platform==='darwin'){
    assert.equal(reads,1);systemResourceSample(Date.now(),reader);assert.equal(reads,1,'one refresh in flight at a time');
    deliver!(100);
    assert.equal(systemResourceSample(Date.now(),reader).freeBytes,first.totalBytes,'the cached level lifts the free estimate');
  }
});

test('F2a: git identity is read asynchronously, once per cwd, and never through the blocking reader',async()=>{
  let asyncCalls=0;
  const identity=createMemoryIdentity({env:{},user:()=>'someone@host',git:()=>{throw new Error('the blocking reader must not be used');},
    gitAsync:async(args)=>{asyncCalls++;await sleep(5);return args.includes('user.email')?'me@example.com':'git@github.com:Org/Repo.git';}});
  assert.equal(identity.isWarm('/repo'),false);
  const [a,b]=await Promise.all([identity.folderAsync({id:'f',path:'/repo'}),identity.folderAsync({id:'f',path:'/repo'})]);
  assert.deepEqual(a,b);assert.match(a.id,/^repo-/);
  await identity.personalAsync();
  const calls=asyncCalls;
  await identity.folderAsync({id:'f',path:'/repo'});await identity.personalAsync();
  assert.equal(asyncCalls,calls,'cached per cwd');
  assert.equal(identity.isWarm('/repo'),true);
  assert.deepEqual(identity.folder({id:'f',path:'/repo'}),a,'the sync twin now answers from the cache without git');
});
