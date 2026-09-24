import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {EMPTY_CONTEXT_TELEMETRY,applyProviderEvent,occupancyFromUsage} from '../src/runtime/context-telemetry.ts';
import {AgentStore} from '../src/runtime/store.ts';

const now=()=>'2026-09-18T00:00:00.000Z';

test('occupancy mirrors codex window residency: latest total, cached and reasoning never double counted',()=>{
  assert.equal(occupancyFromUsage({totalTokens:1200,reasoningOutputTokens:200,cachedInputTokens:900}),1200);
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

test('telemetry stays live within a session and restores as source restored only after a restart; corrupt rows degrade to unavailable',async t=>{
  const dataDir=await mkdtemp(join(tmpdir(),'muster-ctx-'));
  let store=new AgentStore(dataDir);
  t.after(async()=>{store.close();await rm(dataDir,{recursive:true,force:true});});
  const chat=store.createChat({model:'test',mode:'agent'});
  assert.deepEqual(store.contextTelemetry(chat.id),EMPTY_CONTEXT_TELEMETRY);
  store.setContextTelemetry(chat.id,{usedTokens:7500,windowTokens:200_000,source:'live',compacted:true,updatedAt:now()});
  // Re-reading after a live exchange (a chat switch, a renderer that missed the event) must not claim a restart.
  assert.deepEqual(store.contextTelemetry(chat.id),{usedTokens:7500,windowTokens:200_000,source:'live',compacted:true,updatedAt:now()});
  store.close();store=new AgentStore(dataDir);
  assert.deepEqual(store.contextTelemetry(chat.id),{usedTokens:7500,windowTokens:200_000,source:'restored',compacted:true,updatedAt:now()});
  // A zero/negative window written by a corrupt or future schema reads back Unavailable, not zero.
  store.setContextTelemetry(chat.id,{usedTokens:-3,windowTokens:0,source:'live',compacted:false,updatedAt:null});
  const degraded=store.contextTelemetry(chat.id);
  assert.equal(degraded.usedTokens,null);
  assert.equal(degraded.windowTokens,null);
  assert.equal(degraded.source,null);
});

test('a provider breakdown is kept only when every row is valid',()=>{
  const withRows=applyProviderEvent(EMPTY_CONTEXT_TELEMETRY,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:900},modelContextWindow:10_000,breakdown:[{label:'System',tokens:300},{label:'Chat',tokens:600}]}},now);
  assert.deepEqual(withRows?.breakdown,[{label:'System',tokens:300},{label:'Chat',tokens:600}]);
  const bad=applyProviderEvent(EMPTY_CONTEXT_TELEMETRY,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:900},breakdown:[{label:'System',tokens:-1}]}},now);
  assert.equal(bad?.breakdown,undefined);
});

test('F44: stopping a turn never resets the context meter',()=>{
  const live=applyProviderEvent(EMPTY_CONTEXT_TELEMETRY,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:120_000},modelContextWindow:200_000}},now)!;
  // An interrupted turn completes with the aborted request's (zero or partial) usage: ignored.
  assert.equal(applyProviderEvent(live,'turn/completed',{turn:{status:'interrupted',tokenUsage:{last:{totalTokens:0}}}},now),null);
  assert.equal(applyProviderEvent(live,'turn/completed',{turn:{status:'failed',tokenUsage:{last:{totalTokens:40}}}},now),null);
  // A zero reading while the thread holds context keeps the last value (and the known window).
  const zero=applyProviderEvent(live,'thread/tokenUsage/updated',{tokenUsage:{last:{totalTokens:0},modelContextWindow:200_000}},now)!;
  assert.equal(zero.usedTokens,120_000);
  // A completed turn still updates occupancy normally.
  assert.equal(applyProviderEvent(live,'turn/completed',{turn:{status:'completed',tokenUsage:{last:{totalTokens:125_000}}}},now)!.usedTokens,125_000);
});

test('DF-F16: usage from another (worker) thread never moves the chat meter', async () => {
  const {isForeignThreadEvent} = await import('../src/runtime/context-telemetry.ts');
  assert.equal(isForeignThreadEvent({threadId:'worker'},'main'),true);
  assert.equal(isForeignThreadEvent({threadId:'main'},'main'),false);
  assert.equal(isForeignThreadEvent({},'main'),false);
  assert.equal(isForeignThreadEvent({threadId:'first'},undefined),false);
});
