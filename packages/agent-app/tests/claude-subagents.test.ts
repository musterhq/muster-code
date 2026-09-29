import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {existsSync,mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {ChildProcess} from 'node:child_process';
import {claudeCodeAdapter,claudeTaskState,claudeToolItem,type Spawn} from '../src/runtime/adapters/claude-code.ts';
import type {AdapterRunInput} from '../src/runtime/adapters/types.ts';
import {claudeChildTranscript} from '../src/runtime/domains/subagents.ts';
import {claudeChildRow,claudeChildThread} from '../src/runtime/subagent-rows.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {schemaVersion} from '../src/runtime/schema-migrations.ts';
import type {TimelineItem} from '../src/shared/protocol.ts';
import {getSubagentActivity} from '../src/renderer/subagentActivity.ts';

/** Real `claude -p --output-format stream-json --verbose` runs (Claude Code 2.1.x), redacted. */
const fixture=(name:string)=>readFileSync(new URL(`./fixtures/${name}`,import.meta.url),'utf8').trim().split('\n').map(line=>JSON.parse(line) as Record<string,any>);

type Ev={method:string;params:Record<string,any>};
function harness(options:{backgroundTimeoutMs?:number}={}){
  const child=new EventEmitter() as EventEmitter&{stdout:PassThrough;stderr:PassThrough;stdin:PassThrough;kill():boolean};
  child.stdout=new PassThrough();child.stderr=new PassThrough();child.stdin=new PassThrough();child.kill=()=>true;
  const events:Ev[]=[];let deltas='';let sessionId='';
  const input:AdapterRunInput={chat:{id:'chat',mode:'agent'} as AdapterRunInput['chat'],cwd:'/work',prompt:'go',model:'claude-code/sonnet',permissionMode:'full',signal:new AbortController().signal,
    onThreadReady:id=>{sessionId=id;},onTurnAccepted:()=>{},onDelta:t=>{deltas+=t;},onReasoning:()=>{},onEvent:(method,params)=>events.push({method,params})};
  const spawn:Spawn=()=>child as unknown as ChildProcess;
  const running=claudeCodeAdapter({binary:'/bin/claude',spawn,...options}).run(input);
  const emit=(...lines:unknown[])=>{for(const line of lines)child.stdout.write(JSON.stringify(line)+'\n');};
  const tick=()=>new Promise(resolve=>setTimeout(resolve,15));
  const close=(code=0)=>{child.stdout.end();child.stderr.end();setImmediate(()=>child.emit('close',code));};
  return {events,emit,tick,close,running,child,deltas:()=>deltas,session:()=>sessionId};
}
const collab=(events:Ev[])=>events.filter(e=>e.params.item?.type==='collabAgentToolCall');
const state=(e:Ev)=>Object.values(JSON.parse(JSON.stringify(e.params.item.agentsStates)))[0] as {status:string;message?:string};

test('a foreground Task becomes a child thread with its own transcript; the parent stays clean',async()=>{
  const h=harness();
  h.emit(...fixture('claude-subagent-foreground.jsonl'));h.close();
  const result=await h.running;assert.equal(result.status,'completed');
  const sid=h.session(),toolId=fixture('claude-subagent-foreground.jsonl').find(e=>e.type==='assistant'&&e.message.content[0].name==='Agent')!.message.content[0].id as string;
  const childId=`${sid}:${toolId}`;
  const spawns=collab(h.events);
  assert.equal(spawns[0]!.method,'item/started');assert.equal(spawns[0]!.params.threadId,sid,'the spawn report belongs to the parent');
  assert.deepEqual(spawns[0]!.params.item.receiverThreadIds,[childId],'child id derives from the Task tool_use id');
  assert.equal(spawns[0]!.params.item.receiverAgents[0].role,'general-purpose');
  assert.equal(state(spawns[0]!).status,'running');assert.ok(!spawns[0]!.params.item.background);
  const done=spawns.at(-1)!;
  assert.equal(done.method,'item/completed');assert.equal(done.params.item.status,'completed');assert.equal(state(done).status,'completed');
  assert.match(state(done).message!,/a\.txt/);assert.doesNotMatch(state(done).message!,/Subagent hand-back|agentId/,'the harness frame is stripped');
  const forChild=h.events.filter(e=>e.params.threadId===childId&&!e.params.item?.type?.startsWith('collab'));
  assert.deepEqual(forChild.map(e=>e.method),['subagent/message','item/started','item/completed'],'prompt, tool call, tool result');
  assert.equal(forChild[0]!.params.role,'user');assert.match(forChild[0]!.params.text,/Run ls/);
  assert.equal(forChild[2]!.params.item.aggregatedOutput,'a.txt\nb.md');
  // Nothing of the child leaks onto the parent thread except the collab report itself.
  const onParent=h.events.filter(e=>e.params.threadId===sid&&e.params.item&&e.params.item.type!=='collabAgentToolCall');
  assert.deepEqual(onParent.map(e=>e.params.item.type),[],'the parent has no child tool rows');
  assert.match(h.deltas(),/two files/,'only the parent\'s own text streams into the chat');
});

test('a background Task stays running after its launch result and settles from task_notification; stdin waits for it',async()=>{
  const lines=fixture('claude-subagent-background.jsonl');
  const at=lines.findIndex(e=>e.subtype==='task_notification');
  const h=harness();
  h.emit(...lines.slice(0,at));
  // The turn's own result arrives while the child still runs: the CLI must not be told stdin is done yet.
  h.emit({type:'result',subtype:'success',is_error:false,result:'launched'});await h.tick();
  assert.equal(h.child.stdin.writableEnded,false,'stdin stays open while a background agent runs');
  const spawns=collab(h.events);
  const launched=spawns.at(-1)!;
  assert.equal(launched.method,'item/completed','the launching tool call is done');
  assert.equal(launched.params.item.background,true);
  assert.equal(state(launched).status,'running','but the child is not');
  assert.ok(spawns.some(e=>e.params.item.background===true&&e.method==='item/started'),'flagged background from the start');
  h.emit(...lines.slice(at));await h.tick();
  const done=collab(h.events).at(-1)!;
  assert.equal(state(done).status,'completed');assert.match(state(done).message!,/a\.txt/);assert.equal(done.params.item.status,'completed');
  assert.equal(h.child.stdin.writableEnded,true,'closed once nothing is left to wait for');
  // The background child kept streaming after the launch result: its rows still went to the child.
  const childId=launched.params.item.receiverThreadIds[0];
  assert.ok(h.events.some(e=>e.params.threadId===childId&&e.method==='item/completed'&&e.params.item.aggregatedOutput==='a.txt\nb.md'));
  assert.ok(h.events.some(e=>e.params.threadId===childId&&e.method==='subagent/message'&&e.params.role==='assistant'&&/two files/.test(e.params.text)),'the child\'s own answer is in its transcript');
  h.close();await h.running;
});

test('failed, stopped and orphaned children get the right terminal state',async()=>{
  const spawn=(id:string,extra:Record<string,unknown>={})=>({type:'assistant',message:{id:`m${id}`,content:[{type:'tool_use',id,name:'Task',input:{description:'d',subagent_type:'Explore',prompt:'p',...extra}}]}});
  const h=harness();
  h.emit({type:'system',subtype:'init',session_id:'s'},spawn('t1'),spawn('t2',{run_in_background:true}),spawn('t3',{run_in_background:true}),spawn('t4'));
  h.emit({type:'system',subtype:'task_started',task_id:'k2',tool_use_id:'t2',is_backgrounded:true});
  h.emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t1',content:'boom',is_error:true}]}});
  h.emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t2',content:'Async agent launched'}]}});
  h.emit({type:'user',message:{content:[{type:'tool_result',tool_use_id:'t3',content:'Async agent launched'}]}});
  h.emit({type:'system',subtype:'task_notification',task_id:'k2',tool_use_id:'t2',status:'killed',summary:'Stopped by user'});
  await h.tick();
  const last=(id:string)=>collab(h.events).filter(e=>e.params.item.id===id).at(-1)!;
  assert.equal(state(last('t1')).status,'failed');assert.equal(last('t1').params.item.status,'failed');assert.equal(state(last('t1')).message,'boom');
  assert.equal(state(last('t2')).status,'interrupted');
  h.close(1);await h.running;
  assert.equal(state(last('t3')).status,'interrupted','a background child still running when the run ends is not left running');
  assert.equal(state(last('t4')).status,'interrupted','so is a foreground one');
  assert.equal(claudeTaskState('failed'),'failed');assert.equal(claudeTaskState('stopped'),'interrupted');assert.equal(claudeTaskState('weird'),undefined);
});

test('a nested Task and child text/reasoning route by their own parent_tool_use_id',async()=>{
  const h=harness();
  h.emit({type:'system',subtype:'init',session_id:'s'},
    {type:'assistant',message:{id:'a',content:[{type:'tool_use',id:'outer',name:'Agent',input:{prompt:'outer'}}]}},
    {type:'assistant',parent_tool_use_id:'outer',message:{id:'b',content:[{type:'thinking',thinking:'hmm'},{type:'text',text:'child says hi'},{type:'tool_use',id:'inner',name:'Agent',input:{prompt:'inner'}}]}},
    {type:'assistant',parent_tool_use_id:'inner',message:{id:'c',content:[{type:'text',text:'grandchild'}]}});
  await h.tick();
  const sid=h.session(),byThread=(t:string)=>h.events.filter(e=>e.params.threadId===t&&e.method==='subagent/message').map(e=>`${e.params.role}:${e.params.text}`);
  assert.deepEqual(byThread(`${sid}:outer`),['user:outer','reasoning:hmm','assistant:child says hi']);
  assert.deepEqual(byThread(`${sid}:inner`),['user:inner','assistant:grandchild']);
  assert.deepEqual(collab(h.events).map(e=>e.params.threadId),[sid,sid],'both spawns are listed under the parent chat');
  h.close(1);await h.running;
});

test('claudeToolItem keeps the legacy shape without a child id and names the receiver with one',()=>{
  assert.deepEqual((claudeToolItem('t','Task',{subagent_type:'Plan',description:'x'},'/w').receiverAgents as any[])[0],{name:'Plan'});
  const item=claudeToolItem('t','Agent',{subagent_type:'Plan',description:'Map it',prompt:'Do the map',run_in_background:true,model:'haiku'},'/w','s:t');
  assert.deepEqual(item.receiverThreadIds,['s:t']);assert.equal(item.background,true);assert.equal(item.prompt,'Do the map');
  assert.deepEqual(item.receiverAgents,[{threadId:'s:t',name:'Map it',role:'Plan',prompt:'Do the map',model:'haiku'}]);
});

test('child events become transcript rows; only children of this chat are recognised',()=>{
  assert.equal(claudeChildThread({threadId:'p:t'},'p'),'p:t');assert.equal(claudeChildThread({threadId:'p'},'p'),undefined);assert.equal(claudeChildThread({threadId:'q:t'},'p'),undefined);assert.equal(claudeChildThread({threadId:'p:t'},undefined),undefined);
  assert.deepEqual(claudeChildRow('subagent/message',{threadId:'p:t',id:'p:t:m:0',role:'assistant',text:'hi'}),{id:'p:t:m:0',kind:'assistant',text:'hi',status:'completed'});
  assert.equal(claudeChildRow('subagent/message',{threadId:'p:t',id:'x',role:'system',text:'no'}),undefined);
  const running=claudeChildRow('item/started',{threadId:'p:t',item:{id:'b1',type:'commandExecution',command:'ls'}})!;
  assert.equal(running.id,'p:t:b1');assert.equal(running.status,'running');assert.equal(running.data!.threadId,'p:t');
  const done=claudeChildRow('item/completed',{threadId:'p:t',item:{id:'b1',type:'commandExecution',command:'ls',status:'completed',aggregatedOutput:'\u001b[1ma\u001b[0m'}})!;
  assert.equal(done.text,'ls\na');assert.equal(done.status,'completed');
});

test('schema v2 adds subagent transcripts to an existing database; rows persist, upsert in place, and go with the chat',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-subagents-'));
  try{
    const first=new AgentStore(dir);
    assert.equal(schemaVersion(first.database()),2);
    // Simulate a 0.2.5 database: version 1, no subagent_items table.
    first.database().exec('DROP TABLE subagent_items; PRAGMA user_version = 1');first.close();
    const store=new AgentStore(dir);
    assert.deepEqual(store.schemaMigration.applied,['2:subagent transcripts']);assert.ok(store.schemaMigration.backup&&existsSync(store.schemaMigration.backup));
    const chat=store.createChat({model:'claude-code/sonnet',providerId:'claude-code',mode:'agent'});
    store.upsertSubagentItem(chat.id,'s:t',{id:'s:t:prompt',kind:'user',text:'do it',status:'completed'});
    store.upsertSubagentItem(chat.id,'s:t',{id:'s:t:b1',kind:'tool',text:'ls',status:'running',data:{name:'ls'}});
    store.upsertSubagentItem(chat.id,'s:other',{id:'s:other:x',kind:'assistant',text:'elsewhere'});
    store.upsertSubagentItem(chat.id,'s:t',{id:'s:t:b1',kind:'tool',text:'ls\nok',status:'completed'});
    const rows=store.subagentItems(chat.id,'s:t');
    assert.deepEqual(rows.map(r=>[r.id,r.kind,r.status]),[['s:t:prompt','user','completed'],['s:t:b1','tool','completed']],'the repeat updated in place and kept its position');
    assert.deepEqual(rows[1]!.data,{name:'ls'},'an update without data keeps the earlier details');
    store.upsertSubagentItem(chat.id,'s:t',{id:'s:t:b2',kind:'tool',text:'sleep',status:'running'});
    store.settleSubagentItems(chat.id);
    assert.equal(store.subagentItems(chat.id,'s:t').at(-1)!.status,'interrupted');
    assert.equal(store.timeline(chat.id).length,0,'the parent timeline never sees child rows');
    store.close();
    const reopened=new AgentStore(dir);
    assert.equal(reopened.subagentItems(chat.id,'s:t').length,3,'persisted across restarts');
    reopened.deleteChat(chat.id);
    assert.equal(reopened.subagentItems(chat.id,'s:t').length,0);assert.equal(reopened.subagentItems(chat.id,'s:other').length,0);
    reopened.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a Claude child transcript combines saved rows with the state its spawn report last gave it',()=>{
  const report=(status:string):TimelineItem=>({id:'r',chatId:'chat',kind:'tool',text:'',createdAt:'2026-01-01T00:00:00Z',status:'completed',data:{type:'collabAgentToolCall',receiverThreadIds:['s:t'],
    agentsStates:JSON.stringify({'s:t':{status}}),receiverAgents:JSON.stringify([{threadId:'s:t',name:'Map it',role:'Plan',model:'haiku'}])}});
  const rows:TimelineItem[]=[{id:'s:t:prompt',chatId:'chat',kind:'user',text:'go',createdAt:''}];
  const running=claudeChildTranscript('chat','s:t',[report('running')],rows);
  assert.equal(running.status,'running');assert.equal(running.name,'Map it');assert.equal(running.role,'Plan');assert.equal(running.items.length,1);assert.equal(running.source,'live');
  assert.equal(claudeChildTranscript('chat','s:t',[report('completed')],rows).status,'completed');
  assert.equal(claudeChildTranscript('chat','s:t',[report('interrupted')],rows).status,'interrupted');
  assert.equal(claudeChildTranscript('chat','s:t',[],rows).status,'unknown');
  void DatabaseSync;
});

test('a finished child reports its own start and end from the stream, so elapsed is not 0s',async()=>{
  const h=harness();
  h.emit(...fixture('claude-subagent-foreground.jsonl'));h.close();await h.running;
  const info=(e:Ev)=>Object.values(JSON.parse(JSON.stringify(e.params.item.agentsStates)))[0] as {startedAt:string;endedAt?:string};
  const spawns=collab(h.events),first=info(spawns[0]!),done=info(spawns.at(-1)!);
  assert.equal(first.endedAt,undefined,'a running child has no end yet');
  assert.equal(Date.parse(done.endedAt!)-Date.parse(done.startedAt),4812,'the notification\'s duration_ms');
  const report=(agentsStates:unknown,createdAt:string):TimelineItem=>({id:'r'+createdAt,chatId:'chat',kind:'tool',text:'',createdAt,status:'completed',data:{type:'collabAgentToolCall',receiverThreadIds:['s:t'],agentsStates:JSON.stringify(agentsStates)}});
  const items=[report({'s:t':{status:'running',startedAt:done.startedAt}},'2026-01-01T00:00:00Z'),report({'s:t':{status:'completed',startedAt:done.startedAt,endedAt:done.endedAt}},'2026-01-01T00:00:00Z')];
  const row=getSubagentActivity(items).agents[0]!;
  assert.equal(Date.parse(row.updatedAt!)-Date.parse(row.startedAt!),4812,'both reports share one created_at, yet elapsed is the real duration');
  const transcript=claudeChildTranscript('chat','s:t',items.map(i=>({...i,data:{...i.data,receiverThreadIds:['s:t']}})),[]);
  assert.equal(Date.parse(transcript.updatedAt!)-Date.parse(transcript.startedAt!),4812);
});

test('a child persisted as running is interrupted when the app restarts after a crash',()=>{
  const dir=mkdtempSync(join(tmpdir(),'muster-crash-'));
  try{
    const first=new AgentStore(dir);
    const chat=first.createChat({model:'claude-code/sonnet',providerId:'claude-code',mode:'agent'});
    first.updateChat(chat.id,{status:'running'} as never);
    for(const text of [true,false]){
      const states={'s:t':{status:'running',startedAt:'2026-01-01T00:00:00.000Z'},'s:d':{status:'completed'}};
      first.appendItem(chat.id,'tool','spawn','running',{type:'collabAgentToolCall',receiverThreadIds:['s:t','s:d'],agentsStates:text?JSON.stringify(states):states});
    }
    first.close();
    const store=new AgentStore(dir);
    assert.deepEqual(store.recoverOrphanedRuns(),[chat.id]);
    for(const item of store.timeline(chat.id).filter(i=>i.data?.type==='collabAgentToolCall')){
      const states=typeof item.data!.agentsStates==='string'?JSON.parse(item.data!.agentsStates):item.data!.agentsStates;
      assert.equal(states['s:t'].status,'interrupted');assert.ok(states['s:t'].endedAt);assert.equal(states['s:d'].status,'completed');
      assert.equal(item.status,'interrupted');
    }
    assert.equal(getSubagentActivity(store.timeline(chat.id)).agents.find(a=>a.threadId==='s:t')!.state,'interrupted');
    store.close();
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('a background child that never reports back is interrupted after the timeout and stdin is released',async()=>{
  const lines=fixture('claude-subagent-background.jsonl');
  const at=lines.findIndex(e=>e.subtype==='task_notification');
  const h=harness({backgroundTimeoutMs:40});
  h.emit(...lines.slice(0,at));
  h.emit({type:'result',subtype:'success',is_error:false,result:'launched'});await h.tick();
  assert.equal(h.child.stdin.writableEnded,false,'still waiting inside the bound');
  await new Promise(resolve=>setTimeout(resolve,80));
  assert.equal(h.child.stdin.writableEnded,true,'stdin released after the bound');
  const last=collab(h.events).at(-1)!;
  assert.equal(state(last).status,'interrupted');assert.match(state(last).message!,/Timed out/);assert.equal(last.method,'item/completed');
  h.close();await h.running;
});
