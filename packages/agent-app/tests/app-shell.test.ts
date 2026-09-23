import assert from 'node:assert/strict';
import {test} from 'node:test';
import {attentionBadge,createCrashTracker,isRendererCrash} from '../src/main/app-shell.ts';

test('dock badge follows pending attention only while the window is not in front',()=>{
  assert.equal(attentionBadge(0,0,false),null);
  assert.deepEqual(attentionBadge(0,2,false),{badge:'2',bounce:true},'new requests badge and bounce');
  assert.deepEqual(attentionBadge(2,3,false),{badge:'3',bounce:true});
  assert.deepEqual(attentionBadge(3,1,false),{badge:'1',bounce:false},'answered requests lower the badge without bouncing');
  assert.deepEqual(attentionBadge(1,0,false),{badge:'',bounce:false});
  assert.equal(attentionBadge(2,2,false),null,'unchanged counts do not re-bounce');
  assert.deepEqual(attentionBadge(2,2,true),{badge:'',bounce:false},'focus clears the badge');
  assert.deepEqual(attentionBadge(0,4,true),{badge:'',bounce:false},'a focused window never badges');
  assert.equal(attentionBadge(0,0,true),null);
});

test('renderer crash policy reloads once and asks on a repeat within a minute',()=>{
  const tracker=createCrashTracker(60_000);
  assert.equal(tracker.record(1_000),'reload');
  assert.equal(tracker.record(30_000),'ask');
  assert.equal(tracker.record(30_000+60_000),'reload','the window is measured from the previous crash');
  assert.equal(isRendererCrash('crashed'),true);
  assert.equal(isRendererCrash('oom'),true);
  assert.equal(isRendererCrash('killed'),true);
  assert.equal(isRendererCrash('clean-exit'),false,'reloads and navigations are not crashes');
});
