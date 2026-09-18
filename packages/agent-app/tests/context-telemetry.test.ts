import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EMPTY_CONTEXT_TELEMETRY,applyProviderEvent,occupancyFromUsage} from '../src/runtime/context-telemetry.ts';
import {AgentStore} from '../src/runtime/store.ts';

const now=()=>'2026-09-18T00:00:00.000Z';

test('occupancy mirrors codex window residency: total minus reasoning, cached never added',()=>{
  assert.equal(occupancyFromUsage({totalTokens:1200,reasoningOutputTokens:200,cachedInputTokens:900}),1000);
  assert.equal(occupancyFromUsage({inputTokens:800,outputTokens:150}),950);
  assert.equal(occupancyFromUsage({inputTokens:-5}),null);
  assert.equal(occupancyFromUsage('garbage'),null);
});

test('tokenUsage updates fold over prior snapshot; unreliable events keep last value, never zero',()=>{
  const first=applyProviderEvent(EMPTY_CONTEXT_TELEMETRY,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:5000},modelContextWindow:200_000}},now);
  assert.deepEqual(first,{usedTokens:5000,windowTokens:200_000,source:'live',compacted:false,updatedAt:now()});
  // Malformed usage carries nothing reliable: caller skips emit, snapshot survives.
  assert.equal(applyProviderEvent(first!,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:-1}}},now),null);
  assert.equal(applyProviderEvent(first!,'unrelated/method',{},now),null);
  // turn/completed usage updates occupancy but retains the known window.
  const second=applyProviderEvent(first!,'turn/completed',{turn:{tokenUsage:{last:{inputTokens:7000,outputTokens:500}}}},now);
  assert.deepEqual(second,{usedTokens:7500,windowTokens:200_000,source:'live',compacted:false,updatedAt:now()});
});

test('compaction is sticky until fresh usage arrives',()=>{
  const base=applyProviderEvent(EMPTY_CONTEXT_TELEMETRY,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:180_000},modelContextWindow:200_000}},now)!;
  const compacted=applyProviderEvent(base,'thread/compacted',{},now)!;
  assert.equal(compacted.compacted,true);
  assert.equal(compacted.usedTokens,180_000);
  const after=applyProviderEvent(compacted,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:30_000}}},now)!;
  assert.equal(after.compacted,false);
  assert.equal(after.usedTokens,30_000);
});

test('persisted telemetry restores as source restored; corrupt rows degrade to unavailable',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-ctx-'));
  const store=new AgentStore(dataDir);
  t.after(async()=>{store.close();await rm(dataDir,{recursive:true,force:true});});
  const chat=store.createChat({model:'test',mode:'agent'});
  assert.deepEqual(store.contextTelemetry(chat.id),EMPTY_CONTEXT_TELEMETRY);
  store.setContextTelemetry(chat.id,{usedTokens:7500,windowTokens:200_000,source:'live',compacted:true,updatedAt:now()});
  assert.deepEqual(store.contextTelemetry(chat.id),{usedTokens:7500,windowTokens:200_000,source:'restored',compacted:true,updatedAt:now()});
  // A zero/negative window written by a corrupt or future schema reads back Unavailable, not zero.
  store.setContextTelemetry(chat.id,{usedTokens:-3,windowTokens:0,source:'live',compacted:false,updatedAt:null});
  const degraded=store.contextTelemetry(chat.id);
  assert.equal(degraded.usedTokens,null);
  assert.equal(degraded.windowTokens,null);
  assert.equal(degraded.source,null);
});
