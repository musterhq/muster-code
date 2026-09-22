import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTimelineProjection,findTranscriptMatches,summarizeTurns,turnAtRow,railWindow,MAX_RAIL_TURNS} from '../src/renderer/components/timeline-navigation-model.ts';
import {groupActivity} from '../src/renderer/components/activityGrouping.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
const item=(id:string,kind:TimelineItem['kind'],text:string):TimelineItem=>({id,kind,text,chatId:'chat',createdAt:'2026-09-19T10:00:00Z'});
test('only real user turns are anchors and previews contain assistant prose, never tools or reasoning',()=>{
  const rows=groupActivity([item('orphan','assistant','Before any user'),item('u1','user','First\n request'),item('r','reasoning','Private reasoning'),item('t1','tool','Command'),item('t2','tool','Output'),item('a1','assistant','First answer'),item('u2','user','Second'),item('t3','tool','No prose')]);
  const turns=summarizeTurns(rows);
  assert.deepEqual(turns,[{id:'u1',rowIndex:1,prompt:'First request',response:'First answer'},{id:'u2',rowIndex:5,prompt:'Second',response:''}]);
  assert.equal(turnAtRow(turns,0),undefined);assert.equal(turnAtRow(turns,4),'u1');assert.equal(turnAtRow(turns,6),'u2');
  assert.deepEqual(summarizeTurns([item('assistant','assistant','No user rows')]),[]);
});
test('streaming reuses stable completed summaries and bounds live previews without text-sized parsing',()=>{
  const first=[item('u1','user','One'),item('a1','assistant','Finished'),item('u2','user','Two'),item('a2','assistant','x'.repeat(300))];
  const before=summarizeTurns(first);
  const after=summarizeTurns([...first.slice(0,3),item('a2','assistant','x'.repeat(1000000))],before);
  assert.equal(before,after);assert.equal(after[1].response.length,240);
  const changed=summarizeTurns([...first.slice(0,3),item('a2','assistant','Different')],after);
  assert.equal(changed[0],before[0]);assert.notEqual(changed[1],before[1]);
});
test('large histories keep every turn reachable while bounding the rail window',()=>{
  const turns=summarizeTurns(Array.from({length:10000},(_,i)=>item('u'+i,'user','Turn '+i)));
  for(const index of [0,1,32,100,5000,9999]){const range=railWindow(turns.length,index);assert.ok(range.end-range.start<=MAX_RAIL_TURNS);assert.ok(range.start<=index&&range.end>index);assert.equal(turnAtRow(turns,index),'u'+index);}
  assert.deepEqual(railWindow(0,0),{start:0,end:0});assert.deepEqual(railWindow(2,0),{start:0,end:2});
});
test('conversation search finds loaded user, assistant, and grouped activity rows case-insensitively',()=>{
  const rows=groupActivity([item('u','user','Find me here'),item('a','assistant','Answer has Find'),item('t1','tool','first FIND'),item('t2','tool','also find')]);
  assert.deepEqual(findTranscriptMatches(rows,'find'),[{rowIndex:0,offset:0},{rowIndex:1,offset:11},{rowIndex:2,offset:6}]);
  assert.deepEqual(findTranscriptMatches(rows,'  absent  '),[]);assert.deepEqual(findTranscriptMatches(rows,'  '),[]);
});
test('the combined projection reuses immutable previews/indexes and correctly rebuilds historical edits',()=>{
  const project=createTimelineProjection();let reads=0;
  const done=item('a1','assistant','');Object.defineProperty(done,'text',{get(){reads++;return 'Completed prose';}});
  const rows=[item('u1','user','One'),done,item('t1','tool','Tool one'),item('t2','tool','Tool two'),item('u2','user','Two'),item('a2','assistant','x'.repeat(300))];
  const first=project(rows);assert.equal(reads,1);assert.deepEqual(first.rows,groupActivity(rows));
  // Compare against a baseline without reading the cached item's text again.
  reads=0;
  const streamed=project([...rows.slice(0,-1),item('a2','assistant','x'.repeat(1000000))]);
  assert.equal(reads,0,'completed previews are not reparsed on every token');assert.equal(streamed.turns,first.turns);assert.equal(streamed.rowIndexes,first.rowIndexes);
  const edited=project([rows[0],item('a1','assistant','Edited old answer'),...rows.slice(2)]);
  assert.equal(edited.turns[0].response,'Edited old answer');assert.equal(edited.turns[1],first.turns[1]);
  const regrouped=project([rows[0],done,rows[2],item('notice','notice','Boundary'),...rows.slice(3)]);
  assert.equal(regrouped.turns[1].rowIndex,5);assert.notEqual(regrouped.rowIndexes,edited.rowIndexes);
});
