// #668: the user's window, the observed-usage floor, and no proactive compaction on a guessed window.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {DEFAULT_CONTEXT_WINDOW,effectiveContextWindow,musterCompactAt,proactiveCompaction,withUserWindow} from '../src/shared/context-window.ts';
import {normalizeModelPolicy,parseTokenCount,validateContextWindow} from '../src/shared/model-catalog.ts';
import {contextView} from '../src/renderer/contextView.ts';

const telemetry=(usedTokens:number|null,windowTokens:number|null=null)=>({usedTokens,windowTokens,source:'live' as const,compacted:false,updatedAt:null});

// Spec: MUS-SPEC-04-1A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-1a)
test('#668 resolver order: override > catalog > listing > reported > observed > default',()=>{
  const all={contextWindow:200_000,contextWindowSource:'catalog' as const,userContextWindow:1_000_000};
  assert.deepEqual(effectiveContextWindow(all,64_000,900_000),{tokens:1_000_000,source:'override'},'your window beats everything, even observed usage');
  assert.deepEqual(effectiveContextWindow({contextWindow:200_000,contextWindowSource:'catalog'},64_000),{tokens:200_000,source:'catalog'});
  assert.deepEqual(effectiveContextWindow({contextWindow:200_000,contextWindowSource:'listing'},64_000),{tokens:200_000,source:'listing'});
  assert.deepEqual(effectiveContextWindow({},64_000),{tokens:64_000,source:'reported'});
  assert.deepEqual(effectiveContextWindow({},null,300_000),{tokens:300_000,source:'observed'});
  assert.deepEqual(effectiveContextWindow(undefined,null),{tokens:DEFAULT_CONTEXT_WINDOW,source:'default'});
});

// Spec: MUS-SPEC-04-1B (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-1b)
test('#668 observed usage only raises a guess: it never lowers a window and never overrides a declared one',()=>{
  assert.equal(effectiveContextWindow(undefined,null,100_000).source,'default','usage under the guess changes nothing');
  assert.equal(effectiveContextWindow({contextWindow:128_000,contextWindowSource:'listing'},null,300_000).source,'observed','a listed window below accepted usage is raised');
  assert.equal(effectiveContextWindow({contextWindow:200_000,contextWindowSource:'catalog'},null,300_000).source,'catalog','a catalog window is not second-guessed');
  assert.equal(effectiveContextWindow({},500_000,900_000).source,'reported');
});

// Spec: MUS-SPEC-04-2A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-2a)
test('#668 a default or observed window never starts a proactive compaction; a declared one does',()=>{
  const combo=musterCompactAt('http-chat',undefined,null,299_984);
  assert.equal(combo.window.source,'observed');
  assert.equal(combo.at,Infinity,'300K accepted tokens on a combo with no listed window does not compact');
  assert.equal(musterCompactAt('http-chat',undefined,null,120_000).at,Infinity,'the 128K guess alone never compacts');
  assert.equal(proactiveCompaction({tokens:1,source:'default'}),false);
  assert.equal(proactiveCompaction({tokens:1,source:'override'}),true);
  const set=musterCompactAt('http-chat',withUserWindow(undefined,1_000_000),null,299_984);
  assert.equal(set.window.source,'override');
  assert.equal(set.at,850_000,'your 1M window compacts at 85%');
  assert.equal(musterCompactAt('http-chat',withUserWindow(undefined,100_000),null,95_000).at,85_000,'your smaller window compacts once it is over');
});

// Spec: MUS-SPEC-04-2B (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-2b)
test('#668 the meter and the trigger resolve the same window',()=>{
  const model=withUserWindow({contextWindow:128_000,contextWindowSource:'listing'},1_000_000);
  const view=contextView(telemetry(299_984),model),trigger=musterCompactAt('http-chat',model,null,299_984);
  assert.equal(view.windowTokens,trigger.window.tokens);
  assert.equal(view.windowSource,'override');
  assert.equal(view.compactAt,trigger.threshold.tokens);
  assert.equal(view.compactAt,850_000);
  assert.equal(view.percent,30);
  assert.match(view.source,/set by you/);
});

// Spec: MUS-SPEC-04-3A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-3a)
test('#668 meter: observed usage reads "at least N" with no percentage; a default estimate is labelled and never compacts',()=>{
  const observed=contextView(telemetry(299_984),undefined);
  assert.equal(observed.windowSource,'observed');
  assert.equal(observed.windowTokens,299_984);
  assert.equal(observed.percent,null,'not stuck at 100%');
  assert.equal(observed.remaining,null);
  assert.equal(observed.compactAt,null);
  assert.match(observed.source,/observed \(at least 299,984\)/);
  const guess=contextView(telemetry(40_000),undefined);
  assert.equal(guess.windowSource,'default');
  assert.equal(guess.percent,31);
  assert.equal(guess.compactAt,null);
  assert.match(guess.source,/estimate/);
});

// Spec: MUS-SPEC-04-4A (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-4a)
test('#668 the policy keeps valid windows per model and drops the rest',()=>{
  const policy=normalizeModelPolicy({contextWindows:{'omni::intelligent-planner':1_000_000,'omni::tiny':5,'bad key':200_000,'omni::frac':1.5}});
  assert.deepEqual(policy.contextWindows,{'omni::intelligent-planner':1_000_000});
  assert.deepEqual(normalizeModelPolicy({hidden:[]}).contextWindows,{});
  assert.equal(validateContextWindow(1_000_000),1_000_000);
  assert.throws(()=>validateContextWindow(Number.NaN),/whole number of tokens/);
  assert.throws(()=>validateContextWindow(999),/whole number of tokens/);
});

// Spec: MUS-SPEC-04-4B (docs/spec/clauses/04-context-window-and-compaction.md#mus-spec-04-4b)
test('#668 the Settings field reads 1M, 200k and 1,000,000',()=>{
  assert.equal(parseTokenCount('1M'),1_000_000);
  assert.equal(parseTokenCount('1.5m'),1_500_000);
  assert.equal(parseTokenCount('200k'),200_000);
  assert.equal(parseTokenCount('1,000,000'),1_000_000);
  assert.ok(Number.isNaN(parseTokenCount('lots')));
  assert.ok(Number.isNaN(parseTokenCount('')));
});
