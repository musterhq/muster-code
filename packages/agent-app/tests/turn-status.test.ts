import assert from 'node:assert/strict';
import {test} from 'node:test';
import {announcements,createThrottledAnnouncer,describeTurns,formatDuration,retryLabel,tailStatus,thoughtLabel,elapsed} from '../src/renderer/components/turnStatusModel.ts';
import {groupActivity} from '../src/renderer/components/activityGrouping.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
const at=(s:number)=>new Date(Date.UTC(2026,8,22,10,0,s)).toISOString();
const item=(id:string,kind:TimelineItem['kind'],seconds:number,extra:Partial<TimelineItem>={}):TimelineItem=>({id,kind,chatId:'c',text:id,createdAt:at(seconds),...extra});

test('durations read like Codex',()=>{
  assert.equal(formatDuration(26400),'26s');assert.equal(formatDuration(72000),'1m 12s');assert.equal(formatDuration(3723000),'1h 2m');
  assert.equal(thoughtLabel('completed',1500),'Thought briefly');assert.equal(thoughtLabel('completed',9000),'Thought for 9s');
  assert.equal(thoughtLabel('completed',null),'Thought');assert.equal(thoughtLabel('running',null),'Thinking');
  assert.equal(elapsed('',at(1)),null,'invalid timestamps never produce a duration');assert.equal(elapsed(at(5),at(1)),null);
});

test('turns span a user row to the next; worked-for runs to the last item and only completed turns fold',()=>{
  const rows=groupActivity([item('u1','user',0),item('r1','reasoning',1,{status:'completed'}),item('t1','tool',3,{status:'completed'}),item('t2','tool',20,{status:'completed'}),item('a1','assistant',26),
    item('u2','user',40),item('a2','assistant',41),
    item('u3','user',50),item('t3','tool',55,{status:'running'})]);
  const model=describeTurns(rows,true);
  const one=model.turns.get('u1')!;assert.equal(one.durationMs,26000);assert.equal(one.complete,true);assert.equal(one.work,2);
  assert.equal(model.turns.get('u2')!.work,0,'a prose-only turn has no work to fold');
  assert.equal(model.turns.get('u3')!.complete,false,'the live tail turn is never complete');
  assert.equal(model.last,'u3');assert.deepEqual(model.rowTurn,['u1','u1','u1','u1','u2','u2','u3','u3']);
  assert.equal(describeTurns(rows,false).turns.get('u3')!.complete,false,'a still-running tool keeps its turn open');
  const pending=describeTurns(groupActivity([item('u','user',0),item('t','tool',1,{status:'completed'}),item('ap','approval',2,{status:'pending'})]),false);
  assert.equal(pending.turns.get('u')!.complete,false,'awaiting approval is not finished');
});

test('tail says Thinking until something streams, then the live action, approval, or retry countdown',()=>{
  assert.deepEqual(tailStatus([item('u','user',0)]),{label:'Thinking',kind:'thinking',since:at(0)});
  const tool=item('t','tool',2,{status:'running',data:{type:'commandExecution',command:'npm test'}});
  assert.equal(tailStatus([item('u','user',0),tool]).label,'Running npm test');
  assert.equal(tailStatus([item('u','user',0),item('e','tool',1,{status:'running',data:{type:'fileChange',changes:[{path:'src/deep/Foo.tsx'}]}})]).label,'Editing Foo.tsx');
  assert.equal(tailStatus([item('old','user',0),tool,item('u','user',9)]).label,'Thinking','only the current turn counts');
  assert.equal(tailStatus([item('u','user',0),item('ap','approval',1,{status:'pending'})]).kind,'approval');
  const retry=tailStatus([item('u','user',0),item('n','notice',1,{status:'running',data:{kind:'admission-retry',retryAt:at(30)}})]);
  assert.equal(retry.kind,'retry');assert.equal(retryLabel(retry.retryAt,Date.parse(at(18))),'Retrying in 12s');assert.equal(retryLabel(retry.retryAt,Date.parse(at(31))),'Retrying now');
});

test('announcements seed silently, then report status, approvals and new tools',()=>{
  const first=announcements(null,'idle',[item('u','user',0)]);assert.deepEqual(first.messages,[]);
  const started=announcements(first.next,'running',[item('u','user',0),item('t','tool',1,{status:'running',data:{type:'commandExecution',command:'ls'}}),item('ap','approval',2,{status:'pending'})]);
  assert.deepEqual(started.messages,[{text:'Agent started',important:true},{text:'Running ls',important:false},{text:'Needs approval',important:true}]);
  assert.deepEqual(announcements(started.next,'failed',[]).messages,[{text:'Agent failed',important:true}]);
});

test('the live region speaks at most once per 3s and never lets routine news bury an important one',()=>{
  let clock=0;const spoken:string[]=[];const timers:{fn:()=>void;at:number}[]=[];
  const announcer=createThrottledAnnouncer(text=>spoken.push(text),{now:()=>clock,setTimer:(fn,ms)=>{const timer={fn,at:clock+ms};timers.push(timer);return timer;},clearTimer:timer=>{timers.splice(timers.indexOf(timer as never),1);}});
  const advance=(ms:number)=>{clock+=ms;for(const timer of [...timers])if(timer.at<=clock){timers.splice(timers.indexOf(timer),1);timer.fn();}};
  announcer.push({text:'Agent started',important:true});assert.deepEqual(spoken,['Agent started']);
  announcer.push({text:'Running a',important:false});announcer.push({text:'Needs approval',important:true});announcer.push({text:'Running b',important:false});
  advance(1000);assert.deepEqual(spoken,['Agent started']);
  advance(2000);assert.deepEqual(spoken,['Agent started','Needs approval']);
  announcer.push({text:'Running c',important:false});advance(2999);assert.equal(spoken.length,2);advance(1);assert.equal(spoken.at(-1),'Running c');
  announcer.push({text:'late',important:false});announcer.dispose();advance(5000);assert.equal(spoken.at(-1),'Running c','disposed announcer is silent');
});

test('F60: a tool row blocked on an approval reads "Waiting for approval", never "Running"',async()=>{
  const {summarizeActivity}=await import('../src/renderer/components/activityGrouping.ts');
  const {awaitingApproval}=await import('../src/renderer/components/toolPresentation.ts');
  const blocked=item('t','tool',1,{status:'running',data:{type:'commandExecution',command:'npm view hono version',awaitingApproval:'a1'}});
  assert.equal(awaitingApproval(blocked),true);
  assert.equal(tailStatus([item('u','user',0),blocked]).label,'Waiting for approval');
  assert.match(summarizeActivity([blocked]),/^Waiting for approval /);
  // Once the card is answered the runtime clears the flag and the row is really running.
  const approved={...blocked,data:{type:'commandExecution',command:'npm view hono version'}};
  assert.equal(awaitingApproval(approved),false);
  assert.doesNotMatch(summarizeActivity([approved]),/Waiting/);
});
