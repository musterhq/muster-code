import assert from 'node:assert/strict';
import {test} from 'node:test';
import {displayStatus, executePlan, planCardContent, planCardId, planCardText} from '../src/renderer/components/runStatus.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';

const item=(kind:TimelineItem['kind'],status?:string,id='x'):TimelineItem=>({id,chatId:'c',kind,text:'',status,createdAt:'2026-01-01T00:00:00.000Z'});
/** Same shape as `item`, but lets a test set real text and/or tool `data` (for planCardText). */
const full=(kind:TimelineItem['kind'],id:string,text='',data?:Record<string,unknown>):TimelineItem=>({id,chatId:'c',kind,text,status:'completed',createdAt:'2026-01-01T00:00:00.000Z',...(data?{data}:{})});

test('displayStatus: an open approval or question outranks a running status', () => {
  assert.equal(displayStatus({status:'running',queue:[]}, [item('approval','pending')]), 'waiting');
  assert.equal(displayStatus({status:'stopping',queue:[]}, [item('question','pending')]), 'waiting');
  // A settled approval no longer counts.
  assert.equal(displayStatus({status:'running',queue:[]}, [item('approval','approved')], true), 'reconnecting');
});

test('displayStatus: a stall reads as reconnecting only while live and nothing is pending', () => {
  assert.equal(displayStatus({status:'running',queue:[]}, [], true), 'reconnecting');
  assert.equal(displayStatus({status:'completed',queue:[]}, [], true), 'completed');
});

test('displayStatus: queued follow-ups show only for an idle chat that is not failed or interrupted', () => {
  assert.equal(displayStatus({status:'completed',queue:[{} as never]}, []), 'queued');
  assert.equal(displayStatus({status:'idle',queue:[{} as never]}, []), 'queued');
  assert.equal(displayStatus({status:'failed',queue:[{} as never]}, []), 'failed');
  assert.equal(displayStatus({status:'interrupted',queue:[{} as never]}, []), 'interrupted');
  assert.equal(displayStatus({status:'completed',queue:[]}, []), 'completed');
});

test('planCardId: nothing outside Plan mode or while a turn is live', () => {
  const items=[item('assistant','completed')];
  assert.equal(planCardId(items,false,false), undefined);
  assert.equal(planCardId(items,true,true), undefined);
});

test('planCardId: the latest completed assistant answer is the plan, unless a user message follows unanswered', () => {
  assert.equal(planCardId([item('user'),item('assistant','completed','a1')],true,false), 'a1');
  assert.equal(planCardId([item('assistant','completed','a1'),item('user')],true,false), undefined);
  assert.equal(planCardId([item('assistant','running','a1')],true,false), undefined);
});

test('planCardId: intervening tool and reasoning rows do not hide the completed answer behind them', () => {
  const items=[item('user'),item('assistant','completed','a1'),item('tool','completed'),item('reasoning','completed')];
  assert.equal(planCardId(items,true,false), 'a1');
});

test('planCardText: the assistant\'s own text is the plan when no tool call submitted one', () => {
  const items=[full('user','u1','Draft a plan'),full('assistant','a1','1. Do X\n2. Do Y')];
  assert.equal(planCardText(items,'a1'), '1. Do X\n2. Do Y');
});

test('planCardText: an ExitPlanMode/native plan tool call\'s own text wins over a short trailing remark', () => {
  const planMarkdown='## Plan\n1. Add the route\n2. Add a test\n3. Wire it into the router';
  const items=[
    full('user','u1','Draft a plan'),
    full('tool','t1','',{type:'plan',plan:planMarkdown}),
    full('assistant','a1','Confirm to proceed.'),
  ];
  assert.equal(planCardText(items,'a1'), planMarkdown);
});

test('planCardText: an ExitPlanMode tool call carried in `arguments` JSON is still found', () => {
  const planMarkdown='Ship the redirect fix, then add a regression test.';
  const items=[
    full('user','u1','Draft a plan'),
    full('tool','t1','',{name:'ExitPlanMode',arguments:JSON.stringify({plan:planMarkdown})}),
    full('assistant','a1','Ready when you are.'),
  ];
  assert.equal(planCardText(items,'a1'), planMarkdown);
});

test('planCardText: only the current turn is searched — an earlier turn\'s plan tool call is ignored', () => {
  const items=[
    full('user','u0','First ask'),
    full('tool','t0','',{type:'plan',plan:'Old plan from a previous turn, quite long indeed'}),
    full('assistant','a0','Old answer'),
    full('user','u1','Draft a plan'),
    full('assistant','a1','A short new answer'),
  ];
  assert.equal(planCardText(items,'a1'), 'A short new answer');
});

test('planCardText: empty when neither the assistant nor a plan tool call left anything', () => {
  const items=[full('user','u1','Draft a plan'),full('assistant','a1','')];
  assert.equal(planCardText(items,'a1'), '');
});

test('planCardContent: the tool plan wins even when the assistant wrote more, and a real note is kept under it', () => {
  const planMarkdown='1. Add the route';
  const note='Before I start: this touches the public API, so the version needs a minor bump. Confirm and I will proceed.';
  const items=[full('user','u1','Draft a plan'),full('tool','t1','',{type:'plan',plan:planMarkdown}),full('assistant','a1',note)];
  assert.deepEqual(planCardContent(items,'a1'), {plan:planMarkdown,note});
});

test('planCardContent: an assistant message that merely repeats the plan is not shown twice', () => {
  const planMarkdown='## Plan\n1. Add the route\n2. Add a test';
  const items=[full('user','u1','Draft a plan'),full('tool','t1','',{type:'plan',plan:planMarkdown}),full('assistant','a1','## Plan\n1. Add the route\n2.  Add a test')];
  assert.deepEqual(planCardContent(items,'a1'), {plan:planMarkdown});
});

test('executePlan: success switches to agent and sends once', async () => {
  const modes:string[]=[];
  const error=await executePlan({previousMode:'plan',setMode:async mode=>{modes.push(mode);},send:async()=>true,sendError:()=>undefined});
  assert.equal(error, undefined);
  assert.deepEqual(modes, ['agent']);
});

test('executePlan: a failed send reverts to the previous mode and surfaces the send error', async () => {
  const modes:string[]=[];
  const error=await executePlan({previousMode:'plan',setMode:async mode=>{modes.push(mode);},send:async()=>false,sendError:()=>'Provider is offline.'});
  assert.equal(error, 'Provider is offline.');
  assert.deepEqual(modes, ['agent','plan']);
});

test('executePlan: a thrown send reverts too; a failed mode switch never sends', async () => {
  const modes:string[]=[];
  const thrown=await executePlan({previousMode:'plan',setMode:async mode=>{modes.push(mode);},send:async()=>{throw new Error('boom');},sendError:()=>undefined});
  assert.equal(thrown, 'boom');
  assert.deepEqual(modes, ['agent','plan']);
  let sent=false;
  const blocked=await executePlan({previousMode:'plan',setMode:async()=>{throw new Error('locked');},send:async()=>{sent=true;return true;},sendError:()=>undefined});
  assert.equal(blocked, 'locked');
  assert.equal(sent, false);
});
