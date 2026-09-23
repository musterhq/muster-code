import assert from 'node:assert/strict';
import {test} from 'node:test';
import {groupActivity,segmentActivity,subagentRowLabel,summarizeActivity} from '../src/renderer/components/activityGrouping.ts';
import {agentHue} from '../src/renderer/agentIdentity.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
const item=(id:string,data:Record<string,unknown>,status='completed'):TimelineItem=>({id,chatId:'chat',kind:'tool',text:'',createdAt:'',status,data});
const spawn=(id:string,child:string,name:string,status='completed')=>item(id,{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:[child],agentNickname:name,agentsStates:{[child]:{status:'running'}}},status);
const read=(id:string)=>item(id,{type:'commandExecution',command:'cat a.ts',commandActions:[{type:'read',path:`${id}.ts`}]});
const cmd=(id:string)=>item(id,{type:'commandExecution',command:'npm test'});
const rows=(items:TimelineItem[])=>segmentActivity(items).map(row=>row.kind==='tools'?`tools:${row.items.map(i=>i.id).join(',')}`:subagentRowLabel(row));

test('subagent lifecycle becomes ordered started/finished rows between tool groups',()=>{
  const items=[read('r1'),spawn('s1','c1','Screen continuity'),spawn('s2','c2','Streaming performance'),read('r2'),cmd('c'),
    item('w1',{type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['c1','c2'],agentsStates:{c1:{status:'completed'},c2:{status:'running'}}}),
    item('w2',{type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['c1','c2'],agentsStates:{c1:{status:'completed'},c2:{status:'errored'}}}),
    item('w3',{type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['c1','c2'],agentsStates:{c1:'completed',c2:'failed'}},'running'),read('r3')];
  assert.deepEqual(rows(items),['tools:r1','Screen continuity and Streaming performance started working','tools:r2,c','Screen continuity finished','Streaming performance failed','tools:w3,r3']);
  const started=segmentActivity(items)[1];
  assert.ok(started.kind==='subagents');assert.equal(started.chatId,'chat');
  assert.deepEqual(started.agents.map(a=>a.state),['idle','idle'],'final projected states settle the started glyphs');
  const finished=segmentActivity(items).filter(row=>row.kind==='subagents'&&row.event!=='started');
  assert.deepEqual(finished.map(row=>row.kind==='subagents'&&row.agents[0].state),['done','failed']);
});

test('a live spawn pulses and a spawn without a child id yet still gets a named row',()=>{
  const live=segmentActivity([spawn('s','c','Mira','running')])[0];
  assert.ok(live.kind==='subagents');assert.equal(live.agents[0].state,'working');
  assert.deepEqual(rows([item('p',{type:'collabAgentToolCall',tool:'spawn_agent',agentNickname:'Nova'},'running')]),['Nova started working']);
  assert.deepEqual(rows([item('p',{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['x']},'failed')]),['x failed']);
  assert.deepEqual(rows([spawn('a','c1','A'),spawn('b','c2','B'),spawn('c','c3','C')]),['A, B and C started working']);
});

test('non-subagent tool grouping is unchanged',()=>{
  const items=[read('r1'),cmd('c1'),read('r2'),item('m',{type:'mcpToolCall',server:'s',tool:'t'})];
  assert.deepEqual(rows(items),['tools:r1,c1,r2,m']);
  const grouped=groupActivity(items);assert.equal(grouped.length,1);
  assert.equal(summarizeActivity(items),'Read 2 files, ran 1 command, 1 tool call');
  const send=item('send',{type:'collabAgentToolCall',tool:'sendInput',receiverThreadIds:['c1']});
  assert.deepEqual(rows([read('r1'),send]),['tools:r1,send'],'agent actions without lifecycle news stay grouped');
});

test('agent hue is deterministic and matches the shared palette',()=>{
  assert.equal(agentHue('Screen continuity'),agentHue('Screen continuity'));
  let h=0;for(const c of 'Reviewer')h=(h*31+c.charCodeAt(0))>>>0;
  assert.equal(agentHue('Reviewer'),[212,12,38,152,280,330,190][h%7]);
});

test('DOGFOOD F51: a failed worker row carries the provider\'s reason, or says none was given',async()=>{
  const {subagentRowReason}=await import('../src/renderer/components/activityGrouping.ts');
  const failedState=item('w',{type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['c1'],agentsStates:{c1:{status:'errored',message:'Sandbox denied network access'}}});
  const segments=segmentActivity([spawn('s','c1','Builder'),failedState]).filter(row=>row.kind==='subagents');
  const failed=segments.find(row=>row.kind==='subagents'&&row.event==='failed');
  assert.ok(failed&&failed.kind==='subagents');
  assert.equal(failed.agents[0].reason,'Sandbox denied network access');
  assert.equal(subagentRowReason(failed),'Sandbox denied network access');
  const spawnFailed=segmentActivity([item('sf',{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['c2'],agentNickname:'Tester',error:{message:'agent limit reached'}},'failed')]).find(row=>row.kind==='subagents');
  assert.ok(spawnFailed&&spawnFailed.kind==='subagents');
  assert.equal(subagentRowReason(spawnFailed),'agent limit reached');
  const silent=segmentActivity([spawn('s2','c3','Quiet'),item('w2',{type:'collabAgentToolCall',tool:'wait',receiverThreadIds:['c3'],agentsStates:{c3:'failed'}})]).find(row=>row.kind==='subagents'&&row.event==='failed');
  assert.ok(silent&&silent.kind==='subagents');
  assert.equal(subagentRowReason(silent),'No reason reported by the provider');
  assert.equal(subagentRowReason({event:'started',agents:[{reason:'x'}]}),undefined);
});
