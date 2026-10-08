import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm,mkdir,writeFile,copyFile,readdir,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {awaitProviderListing,configuredProviderInstances,invalidateProviderInstances,LISTING_BACKOFF_MS,providerListingsSettled,rescanProviderListings,resetProviderListings,setListingScheduler,setProviderListingStore} from '../src/runtime/provider-instances.ts';
import type {ProviderAdapter,ProviderInput} from '../src/runtime/provider.ts';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';

const BASE='https://router.example.test/v1';
const listBody=(...ids:string[])=>JSON.stringify({data:ids.map(id=>({id,owned_by:id.startsWith('intelligent')?'combo':'x',capabilities:{tool_calling:true}}))});
/** A fetcher the test settles by hand; every call is recorded. Never reaches a network. */
function fakeFetch() {
  const calls:Array<{resolve:(body:string)=>void;reject:(reason:string)=>void}>=[];
  const fetcher=((_url:string)=>new Promise<Response>((resolve,reject)=>{calls.push({resolve:body=>resolve(new Response(body)),reject:reason=>reject(new Error(reason))});})) as unknown as typeof fetch;
  return {fetcher,calls};
}
async function fixture(t:{after(fn:()=>Promise<void>):void},catalog=false) {
  const home=await mkdtemp(join(tmpdir(),'muster-listing-'));
  const directory=join(home,'runtime'),codexHome=join(home,'codex'),cli=join(home,'cli'),store=join(home,'store');
  await mkdir(join(directory,'resources'),{recursive:true});await mkdir(codexHome);
  await writeFile(cli,'#!/bin/sh\nexit 1\n',{mode:0o700});
  await copyFile(join(import.meta.dirname,'../resources/codex-profile.cjs'),join(directory,'resources/codex-profile.cjs'));
  await writeFile(join(directory,'resources','codex-launch.sh'),'#!/bin/sh\nexit 1\n',{mode:0o700});
  const cat=join(home,'catalog.json');await writeFile(cat,JSON.stringify({models:[{slug:'claude/claude-fable-5'}]}));
  await writeFile(join(codexHome,'hybrow.config.toml'),`model_provider="hybrow"\n${catalog?`model_catalog_json=${JSON.stringify(cat)}\n`:''}[model_providers.hybrow]\nname="Hybrow OmniRoute"\nbase_url="${BASE}"\nwire_api="responses"\n`);
  invalidateProviderInstances();resetProviderListings();setProviderListingStore(store);
  const timers:Array<{fn:()=>void;ms:number;live:boolean}>=[];
  setListingScheduler({set:(fn,ms)=>{const timer={fn,ms,live:true};timers.push(timer);return timer;},clear:handle=>{(handle as {live:boolean}).live=false;}});
  t.after(async()=>{resetProviderListings();setListingScheduler();setProviderListingStore(undefined);invalidateProviderInstances();await rm(home,{recursive:true,force:true});});
  const make=(fetcher:typeof fetch)=>({directory,home,env:{CODEX_HOME:codexHome,MUSTER_CODEX_COMMAND:cli},fetch:fetcher});
  const route=(fetcher:typeof fetch)=>configuredProviderInstances(make(fetcher)).find(row=>row.info.id==='hybrow')!;
  const fire=()=>{const next=timers.find(timer=>timer.live);assert.ok(next,'a retry is scheduled');next.live=false;next.fn();return next.ms;};
  return {route,store,timers,fire,home};
}
const tick=()=>new Promise<void>(resolve=>setTimeout(resolve,5));

test('a pending listing reports loading, then becomes ready when the fetch answers',async t=>{
  const f=await fixture(t),net=fakeFetch();
  const first=f.route(net.fetcher);await tick();
  assert.equal(first.info.listing,'loading');assert.equal(first.info.available,false);assert.match(first.info.detail!,/Loading models from Hybrow OmniRoute/);
  net.calls[0]!.resolve(listBody('intelligent-planner','gpt-x'));await providerListingsSettled();await tick();
  const ready=f.route(net.fetcher);
  assert.equal(ready.info.listing,'live');assert.ok(ready.info.available);assert.ok(ready.info.models.some(model=>model.id==='intelligent-planner'));
});

test('awaitProviderListing waits for a pending listing and returns once it lands',async t=>{
  const f=await fixture(t),net=fakeFetch();
  const key=f.route(net.fetcher).listingKey;assert.ok(key);await tick();
  let done=false;const waiting=awaitProviderListing(key,5_000).then(()=>{done=true;});
  await tick();assert.equal(done,false);
  net.calls[0]!.resolve(listBody('intelligent-planner'));await waiting;
  assert.equal(f.route(net.fetcher).info.available,true);
});

test('awaitProviderListing gives up at the timeout and the route still reports loading',async t=>{
  const f=await fixture(t),net=fakeFetch();
  const key=f.route(net.fetcher).listingKey;
  await awaitProviderListing(key,20);
  assert.equal(f.route(net.fetcher).info.listing,'loading');
});

test('the last good listing is persisted without secrets and used immediately after a restart, marked stale',async t=>{
  const f=await fixture(t),net=fakeFetch();
  f.route(net.fetcher);await tick();net.calls[0]!.resolve(listBody('intelligent-planner'));await providerListingsSettled();await tick();
  const files=await readdir(f.store);assert.equal(files.filter(name=>name.endsWith('.json')).length,1);
  const raw=await readFile(join(f.store,files.find(name=>name.endsWith('.json'))!),'utf8');assert.doesNotMatch(raw,/token|secret|password/i);
  // Simulated restart: memory is empty, the next listing never answers.
  resetProviderListings();invalidateProviderInstances();
  const restarted=fakeFetch(),route=f.route(restarted.fetcher);await tick();
  assert.equal(route.info.listing,'stale');assert.ok(route.info.available);assert.ok(route.info.models.some(model=>model.id==='intelligent-planner'));
  // A fresh answer replaces it and clears the stale mark.
  restarted.calls[0]!.resolve(listBody('intelligent-planner','new-model'));await providerListingsSettled();await tick();
  const fresh=f.route(restarted.fetcher);assert.equal(fresh.info.listing,'live');assert.ok(fresh.info.models.some(model=>model.id==='new-model'));
});

test('a transient failure keeps serving the persisted list, marked stale with the reason',async t=>{
  const f=await fixture(t),net=fakeFetch();
  f.route(net.fetcher);await tick();net.calls[0]!.resolve(listBody('intelligent-planner'));await providerListingsSettled();await tick();
  resetProviderListings();invalidateProviderInstances();
  const down=fakeFetch();f.route(down.fetcher);await tick();down.calls[0]!.reject('socket hang up');await providerListingsSettled();await tick();
  const route=f.route(down.fetcher);
  assert.equal(route.info.listing,'stale');assert.ok(route.info.available);assert.match(route.info.listingError!,/Hybrow OmniRoute didn’t answer: .*Retry\.$/);
});

test('a failed listing retries with 2s, 5s, 15s, 60s backoff and Scan again forces it',async t=>{
  const f=await fixture(t),net=fakeFetch();
  f.route(net.fetcher);await tick();
  const delays:number[]=[];
  for(let attempt=0;attempt<5;attempt++){
    net.calls[attempt]!.reject('HTTP 503');await providerListingsSettled();await tick();
    delays.push(f.fire());await tick();
  }
  assert.deepEqual(delays,[...LISTING_BACKOFF_MS,60_000]);
  assert.equal(net.calls.length,6);
  // Scan again retries now and resets the backoff.
  net.calls[5]!.reject('HTTP 503');await providerListingsSettled();await tick();
  rescanProviderListings();await tick();assert.equal(net.calls.length,7);
  net.calls[6]!.resolve(listBody('intelligent-planner'));await providerListingsSettled();await tick();
  assert.equal(f.route(net.fetcher).info.listing,'live');
});

test('a failure with nothing saved says who did not answer and why',async t=>{
  const f=await fixture(t),net=fakeFetch();
  f.route(net.fetcher);await tick();net.calls[0]!.reject('boom');await providerListingsSettled();await tick();
  const route=f.route(net.fetcher);
  assert.equal(route.info.listing,'failed');assert.match(route.info.error!,/^Hybrow OmniRoute didn’t answer: .+\. Retry\.$/);
});

test('catalog providers are unchanged: no persisted or stale list, the catalog alone while pending',async t=>{
  const f=await fixture(t,true),net=fakeFetch();
  const route=f.route(net.fetcher);await tick();
  assert.equal(route.info.listing,undefined);assert.ok(route.info.available);assert.deepEqual(route.info.models.map(model=>model.id),['claude/claude-fable-5']);assert.equal(route.listingKey,undefined);
  net.calls[0]!.resolve(listBody('intelligent-planner'));await providerListingsSettled();await tick();
  resetProviderListings();invalidateProviderInstances();
  const again=fakeFetch(),after=f.route(again.fetcher);await tick();
  assert.deepEqual(after.info.models.map(model=>model.id),['claude/claude-fable-5']);
});

/** chat.send through the real service against a provider whose model list is the fixture's state. */
async function sendFixture(t:{after(fn:()=>Promise<void>):void},info:()=>ReturnType<ProviderAdapter['info']>,awaitListing?:ProviderAdapter['awaitListing']) {
  const dataDir=await mkdtemp(join(tmpdir(),'muster-listing-send-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const store=new AgentStore(dataDir);const chat=store.createChat({model:'intelligent-planner',mode:'agent'});store.updateChat(chat.id,{providerId:'hybrow'});store.close();
  let runs=0;
  const provider:ProviderAdapter={info,async run(input:ProviderInput){runs++;input.onTurnAccepted?.({threadId:'th',turnId:'tu',dispatchState:'dispatched'});return {status:'completed',finalMessage:'ok',threadId:'th',turnId:'tu'};},async stop(){return true;},dispose(){},...(awaitListing?{awaitListing}:{})};
  const service=createAgentService({dataDir,provider,onEvent(){}});t.after(()=>service.dispose());
  const send=()=>service.invoke('chat.send',{id:chat.id,text:'hello',requestId:randomUUID()});
  return {send,runs:()=>runs};
}
const row=(extra:Record<string,unknown>)=>[{id:'hybrow',name:'Hybrow OmniRoute',available:false,identityMasked:'Hidden',models:[],...extra}] as ReturnType<ProviderAdapter['info']>;

test('chat.send waits for a pending listing, then validates and runs',async t=>{
  let ready=false,waited=0;
  const info=()=>ready?row({available:true,listing:'live',bindingId:'b',models:[{id:'intelligent-planner',name:'Planner'}]}):row({listing:'loading',status:'configured'});
  const s=await sendFixture(t,info,async(id,ms)=>{waited++;assert.equal(id,'hybrow');assert.equal(ms,15_000);await tick();ready=true;});
  await s.send();assert.equal(waited,1);
  for(let i=0;i<20&&!s.runs();i++)await tick();assert.equal(s.runs(),1);
});

test('chat.send names the exact problem instead of "unavailable"',async t=>{
  const pending=await sendFixture(t,()=>row({listing:'loading',status:'configured'}),async()=>{});
  await assert.rejects(pending.send(),/^Error: Still loading models from Hybrow OmniRoute\. Try again in a moment\.$/);
  const failed=await sendFixture(t,()=>row({listing:'failed',status:'error',listingError:'Hybrow OmniRoute didn’t answer: HTTP 503. Retry.'}));
  await assert.rejects(failed.send(),/^Error: Hybrow OmniRoute didn’t answer: HTTP 503\. Retry\.$/);
  const absent=await sendFixture(t,()=>row({available:true,listing:'live',models:[{id:'other',name:'Other'}]}));
  await assert.rejects(absent.send(),/^Error: intelligent-planner isn’t offered by Hybrow OmniRoute any more\. Pick another model\.$/);
  const plain=await sendFixture(t,()=>row({available:true,models:[{id:'other',name:'Other'}]}));
  await assert.rejects(plain.send(),/is unavailable through the configured provider/);
});
