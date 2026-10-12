import assert from 'node:assert/strict';
import {test} from 'node:test';
import {describeTurns} from '../src/renderer/components/turnStatusModel.ts';
import {groupActivity} from '../src/renderer/components/activityGrouping.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const iso=(offsetSeconds:number)=>new Date(Date.UTC(2026,8,1,10,0,offsetSeconds)).toISOString();
const item=(id:string,kind:TimelineItem['kind'],createdAt:string,extra:Partial<TimelineItem>={}):TimelineItem=>({id,kind,chatId:'c',text:id,createdAt,...extra});

test('an import notice stamped weeks later does not stretch the last turn',()=>{
  const rows=groupActivity([
    item('u1','user',iso(0)),item('t1','tool',iso(5),{status:'completed'}),item('a1','assistant',iso(30)),
    item('n','notice',iso(30+614*3600),{status:'completed',data:{kind:'imported'}}),
  ]);
  assert.equal(describeTurns(rows,false).turns.get('u1')!.durationMs,30000);
});
