import test from 'node:test';
import assert from 'node:assert/strict';
import { getSubagentActivity, hasSubagentActivity, projectSubagentActivity, subagentState } from '../src/renderer/subagentActivity.ts';
import type { TimelineItem } from '../src/shared/protocol.ts';

const item = (id: string, data: Record<string, unknown>, createdAt = '2026-01-01T00:00:00Z'): TimelineItem => ({id, chatId:'chat', kind:'tool', text:'', createdAt, data});

test('projects named agents and keeps lifecycle state optional', () => {
  const rows = projectSubagentActivity([item('a', {
    type:'collabAgentToolCall', receiverThreadIds:['thread-123456789'], receiverAgents:JSON.stringify([{threadId:'thread-123456789',name:'Reviewer',role:'review'}]), agentsStates:JSON.stringify({'thread-123456789':{status:'inProgress'}}), model:'codex/model', prompt:'Review it',
  })]);
  assert.deepEqual(rows[0], {id:'thread-123456789',threadId:'thread-123456789',name:'Reviewer',state:'inProgress',model:'codex/model',role:'review',prompt:'Review it'});
});

test('merges repeated and out-of-order reports without duplicate rows', () => {
  const rows = projectSubagentActivity([
    item('later', {type:'collabAgentToolCall', receiverThreadIds:['b','a'], agentsStates:JSON.stringify({a:'completed'})}),
    item('earlier', {type:'collabAgentToolCall', receiverThreadIds:['a'], receiverAgents:[{threadId:'a',name:'Planner'}], prompt:'plan'}),
  ]);
  assert.deepEqual(rows.map(row => row.id), ['b','a']);
  assert.equal(rows[0].name, 'b');
  assert.equal(rows[1].name, 'Planner');
  assert.equal(rows[1].state, 'completed');
  assert.equal(rows.length, 2);
});

test('uses real agent identity and keyed child state, never generic tool names or parent status', () => {
  const rows = projectSubagentActivity([
    item('old', {type:'collabAgentToolCall', tool:'spawnAgent', status:'inProgress', receiverThreadIds:['child'], agentNickname:'', agentRole:'research', agentsStates:{child:{status:'completed', message:'done'}}}, '2026-01-01T00:00:00Z'),
    item('new', {type:'collabAgentToolCall', tool:'sendMessage', status:'inProgress', receiverThreadIds:['child'], agentNickname:'Reviewer', agentRole:'research', agentsStates:{child:{status:'running'}}}, '2026-01-01T00:00:01Z'),
  ]);
  assert.equal(rows[0].name, 'Reviewer');
  assert.equal(rows[0].role, 'research');
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].result, 'done');
});

test('does not assign parallel records to the wrong explicit child id', () => {
  const rows = projectSubagentActivity([item('ids', {
    type:'collabAgentToolCall', receiverThreadIds:['a','b'], status:'completed',
    receiverAgents:[{threadId:'a', agentNickname:'Alpha'}, {threadId:'other', agentNickname:'Wrong'}],
    agentsStates:{a:{status:'completed'}, b:{status:'failed'}},
  })]);
  assert.equal(rows.find(row => row.id === 'a')?.name, 'Alpha');
  assert.equal(rows.find(row => row.id === 'b')?.name, 'b');
  assert.equal(rows.find(row => row.id === 'b')?.state, 'failed');
});

test('orders lifecycle chronologically and keeps a resumed child working after completion', () => {
  const rows = projectSubagentActivity([
    item('resume', {type:'collabAgentToolCall', receiverThreadIds:['child'], agentsStates:{child:{status:'running'}}}, '2026-01-01T00:00:03Z'),
    item('spawn', {type:'collabAgentToolCall', receiverThreadIds:['child'], agentNickname:'Research', prompt:'Find evidence', agentsStates:{child:{status:'pendingInit'}}}, '2026-01-01T00:00:01Z'),
    item('finish', {type:'collabAgentToolCall', receiverThreadIds:['child'], agentsStates:{child:{status:'completed',message:'Evidence found'}}}, '2026-01-01T00:00:02Z'),
  ]);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].name, 'Research');
  assert.equal(rows[0].result, 'Evidence found', 'previous result remains available as the last reported result');
});

test('does not promote parent tools, status, output, or sender into child activity', () => {
  const rows = projectSubagentActivity([
    item('shell', {type:'commandExecution', receiverThreadIds:['fake'], status:'running'}),
    item('collab', {type:'collabAgentToolCall', senderThreadId:'parent', receiverThreadIds:['parent','child'], status:'completed', result:'Parent acknowledgement', agentsStates:{parent:{status:'running'}}}),
  ]);
  assert.deepEqual(rows, [{id:'child',threadId:'child',name:'child'}]);
});

test('keyed state-only reports create exact identities and override stale receiver state', () => {
  const id = 'provider/child:' + 'x'.repeat(33000);
  const rows = projectSubagentActivity([item('report', {
    type:'collabAgentToolCall', receiverAgents:{[id]:{name:'Long identity',status:'completed'}}, agentsStates:{[id]:{status:'running'}},
  })]);
  assert.equal(rows[0].id, id);
  assert.equal(rows[0].threadId, id);
  assert.equal(rows[0].state, 'running');
});

test('broadcast metadata is not attributed to every parallel child', () => {
  const rows = projectSubagentActivity([item('broadcast', {
    type:'collabAgentToolCall', receiverThreadIds:['a','b'], agentNickname:'Parent nickname', model:'parent-model', agentRole:'parent-role', prompt:'Wait for everyone', result:'All done',
    agentsStates:{a:{status:'running'}, b:{status:'queued'}},
  })]);
  assert.deepEqual(rows, [
    {id:'a',threadId:'a',name:'a',state:'running'},
    {id:'b',threadId:'b',name:'b',state:'queued'},
  ]);
});

test('handles invalid retained JSON and states without inventing success', () => {
  const rows = projectSubagentActivity([item('truncated', {
    type:'collabAgentToolCall', receiverThreadIds:['child','child'], receiverAgents:'[{[Details truncated]', agentsStates:'{"child":', status:'completed',
  })]);
  assert.deepEqual(rows, [{id:'child',threadId:'child',name:'child'}]);
});

test('anonymous record matching keeps original positions when sender is excluded', () => {
  const rows = projectSubagentActivity([item('anonymous', {
    type:'collabAgentToolCall', senderThreadId:'parent', receiverThreadIds:['parent','child'], receiverAgents:[{name:'Parent'}, {name:'Child'}], agentsStates:{extra:{status:'queued'}},
  })]);
  assert.equal(rows.find(row => row.id === 'child')?.name, 'Child');
  assert.equal(rows.find(row => row.id === 'extra')?.name, 'extra');
});

test('equal and unavailable timestamps remain deterministic', () => {
  const rows = projectSubagentActivity([
    item('late', {type:'collabAgentToolCall', agentsStates:{child:'running'}}, '2026-01-01T00:00:03Z'),
    item('undated', {type:'collabAgentToolCall', receiverThreadIds:['child'], agentNickname:'Reviewer'}, ''),
    item('early', {type:'collabAgentToolCall', agentsStates:{child:'completed'}}, '2026-01-01T00:00:01Z'),
  ]);
  assert.equal(rows[0].state, 'running');
  assert.equal(rows[0].name, 'Reviewer');
});


test('aggregates explicit lifecycle states and shares immutable timeline projections', () => {
  const items = [item('states', {type:'collabAgentToolCall', agentsStates:{a:'inProgress', b:'pendingInit', c:'waiting', d:'completed', e:'failed', f:'incomplete', g:'cancelled', h:'shutdown'}})];
  const summary = getSubagentActivity(items);
  assert.deepEqual(summary.counts, {working:1,waiting:2,done:1,failed:2,unknown:2});
  assert.equal(getSubagentActivity(items), summary);
  assert.equal(projectSubagentActivity(items), summary.agents);
  assert.equal(hasSubagentActivity(items), true);
  assert.equal(subagentState('incomplete').kind, 'unknown');
  assert.equal(subagentState('pendingInit').label, 'Queued');
  assert.equal(subagentState('shutdown').kind, 'unknown', 'closing an agent does not prove task success');
  const next = getSubagentActivity([...items, item('resumed', {type:'collabAgentToolCall', agentsStates:{d:'running'}}, '2026-01-01T00:00:01Z')]);
  assert.equal(next.counts.working, 2);
  assert.equal(next.counts.done, 0);
  assert.equal(summary.counts.done, 1, 'new snapshots cannot mutate old cached results');
});
