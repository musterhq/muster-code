import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogEfforts} from '../src/runtime/provider-instances.ts';

test('provider-reported reasoning levels and per-model default effort come from the catalog',()=>{
  assert.deepEqual(catalogEfforts({supported_reasoning_levels:[{effort:'high',description:'Deep'},{effort:'low'},{effort:'max'}],default_reasoning_level:'high'}),{efforts:['low','high'],defaultEffort:'high'});
  assert.deepEqual(catalogEfforts({reasoningEfforts:['medium','xhigh'],defaultReasoningEffort:'low'}),{efforts:['medium','xhigh']},'a default outside the supported set is ignored');
  assert.deepEqual(catalogEfforts({default_reasoning_level:'medium'}),{defaultEffort:'medium'});
  assert.deepEqual(catalogEfforts({}),{},'unknown stays unknown: the composer falls back to every level');
});
