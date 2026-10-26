/** #400: the pure transcript row model. Every row kind, folding rule and summary is pinned here. */
import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {TimelineItem} from '../src/shared/protocol.ts';
import {ROW_KINDS,deriveRows,foldLabel,groupSentence,groupSources,liveLabel,noticeSeverity,shareRows,subagentCounts,thoughtLine,toolSeverity,type TranscriptRow} from '../src/renderer/transcriptRows.ts';

const at=(s:number)=>new Date(Date.UTC(2026,9,12,10,0,s)).toISOString();
let n=0;
const item=(kind:TimelineItem['kind'],text='',extra:Partial<TimelineItem>={}):TimelineItem=>({id:`${kind}${++n}`,chatId:'c',kind,text,createdAt:at(n),...extra});
const user=(text='Do it',data?:Record<string,unknown>)=>item('user',text,data?{data}:{});
const reply=(text:string,status='completed')=>item('assistant',text,{status});
const thought=(text:string,status='completed')=>item('reasoning',text,{status});
const tool=(data:Record<string,unknown>,status='completed')=>item('tool','',{status,data});
const cmd=(command:string,extra:Record<string,unknown>={},status='completed')=>tool({type:'commandExecution',command,...extra},status);
const edit=(path:string,diff='@@ -1 +1 @@\n-a\n+b')=>tool({type:'fileChange',changes:[{path,kind:'update',diff}]});
const kinds=(rows:readonly TranscriptRow[])=>rows.map(row=>row.kind);
const derive=(items:TimelineItem[],running=false,open?:Record<string,boolean>)=>deriveRows(items,{running,...(open?{turnOpen:new Map(Object.entries(open))}:{})});

test('a settled turn folds to its fold line, the final answer and its changed files',()=>{
  const u=user(),items=[u,thought('Plan'),reply('Interim note.'),cmd('ls'),edit('src/a.ts'),reply('All done.')];
  const {rows,turns}=derive(items);
  assert.deepEqual(kinds(rows),['user','fold','assistant','changed-files']);
  const final=rows[2] as Extract<TranscriptRow,{kind:'assistant'}>;
  assert.equal(final.item.text,'All done.');assert.equal(final.final,true);
  const fold=rows[1] as Extract<TranscriptRow,{kind:'fold'}>;
  assert.equal(fold.open,false);assert.equal(fold.hasDetail,true);assert.equal(fold.state,'settled');
  assert.equal(fold.digest,'Edited 1 file, ran 1 command');
  assert.equal(turns[0]!.folded,true);
  const files=rows[3] as Extract<TranscriptRow,{kind:'changed-files'}>;
  assert.deepEqual(files.files.map(f=>[f.path,f.adds,f.dels]),[['src/a.ts',1,1]]);assert.equal(files.latest,true);
});

test('opening the fold shows every row in order; the digest comes from the runtime when present',()=>{
  const u=user('Go',{turnDigest:'Ran 1 command'}),items=[u,thought('Plan'),reply('Interim.'),cmd('ls'),reply('Done.')];
  const {rows}=derive(items,false,{[u.id]:true});
  assert.deepEqual(kinds(rows),['user','fold','reasoning','assistant','work','assistant','changed-files']);
  const fold=rows[1] as Extract<TranscriptRow,{kind:'fold'}>;assert.equal(fold.open,true);assert.equal(fold.digest,'Ran 1 command');
  const interim=rows[3] as Extract<TranscriptRow,{kind:'assistant'}>;assert.equal(interim.final,false);
});

test('a turn with nothing to hide has no fold line, and the latest one still offers its changed-files card',()=>{
  const {rows}=derive([user(),reply('Hi.')]);
  assert.deepEqual(kinds(rows),['user','assistant','changed-files']);
  const older=derive([user(),reply('Hi.'),user(),reply('Again.')]).rows;
  assert.deepEqual(kinds(older),['user','assistant','user','assistant','changed-files'],'only the latest turn reserves a card for Git-detected edits');
});

test('the active turn never folds and ends in one live row with present tense, then past tense',()=>{
  const u=user(),running=cmd('npm test',{},'running');
  const live=derive([u,thought('Checking the **tests** first.\n\nThen I will run them.'),reply('Running tests.'),running],true);
  assert.deepEqual(kinds(live.rows),['user','reasoning','assistant','work','live']);
  const row=live.rows.at(-1) as Extract<TranscriptRow,{kind:'live'}>;
  assert.equal(row.label,'Running npm test');assert.equal(row.tense,'present');assert.equal(row.thought,'Then I will run them.');assert.equal(row.since,u.createdAt);
  const after=derive([u,{...running,status:'completed'}],true).rows.at(-1) as Extract<TranscriptRow,{kind:'live'}>;
  assert.equal(after.label,'Ran npm test','the step changes tense instead of vanishing');assert.equal(after.tense,'past');
  const waiting=derive([u,item('approval','Allow?',{status:'pending'})],true).rows.at(-1) as Extract<TranscriptRow,{kind:'live'}>;
  assert.equal(waiting.tense,'waiting');assert.equal(waiting.label,'Waiting for approval');
  assert.equal(derive([u],true).rows.at(-1)?.kind,'live','a turn that has said nothing yet still shows the live row');
});

test('a failed turn never folds; a stopped turn folds and says who stopped it',()=>{
  const failed=derive([user(),cmd('make'),item('notice','The provider attempt failed.',{status:'failed',data:{recovery:{kind:'failed'}}})]);
  assert.deepEqual(kinds(failed.rows),['user','work','notice','changed-files']);
  assert.equal(failed.turns[0]!.state,'failed');
  assert.equal((failed.rows[2] as Extract<TranscriptRow,{kind:'notice'}>).severity,'severe');
  const stopped=derive([user(),cmd('make'),item('notice','Stopped.',{status:'cancelled',data:{recovery:{kind:'cancelled'}}})]);
  assert.deepEqual(kinds(stopped.rows),['user','fold','notice','changed-files']);
  const fold=stopped.rows[1] as Extract<TranscriptRow,{kind:'fold'}>;assert.equal(fold.state,'stopped');
  assert.match(foldLabel(fold.state,12_000),/^You stopped after 12s$/);
  const quiet=derive([user(),item('notice','Stopped.',{status:'cancelled',data:{recovery:{kind:'cancelled'}}})]);
  const quietFold=quiet.rows[1] as Extract<TranscriptRow,{kind:'fold'}>;
  assert.equal(quietFold.kind,'fold');assert.equal(quietFold.hasDetail,false,'a stopped turn with no work still says so, without a disclosure');
});

test('a steer joins the turn: earlier attempts are superseded and only the answer after it is final',()=>{
  const u=user(),first=reply('Working on A.'),steer=user('Do B instead',{steered:true}),after=reply('B is done.');
  const open=derive([u,first,cmd('ls'),steer,after],false,{[u.id]:true}).rows;
  assert.deepEqual(kinds(open),['user','fold','assistant','work','steer','assistant','changed-files']);
  const superseded=open[2] as Extract<TranscriptRow,{kind:'assistant'}>;assert.equal(superseded.superseded,true);assert.equal(superseded.final,false);
  assert.equal((open[5] as Extract<TranscriptRow,{kind:'assistant'}>).final,true);
  assert.deepEqual(kinds(derive([u,first,cmd('ls'),steer,after]).rows),['user','fold','steer','assistant','changed-files'],'folded, the steer stays visible');
  const turns=derive([u,first,steer,after]).turns;assert.equal(turns.length,1,'a steer never starts a turn');
});

test('sub-agent rows collapse into one card per group, replacing the delegation rows',()=>{
  const spawn=(id:string,name:string,state:string)=>tool({type:'collabAgentToolCall',tool:'spawn_agent',subagentGroup:'g1',receiverThreadIds:[id],agentsStates:{[id]:{status:state}},receiverAgents:[{threadId:id,name}]});
  const {rows}=derive([user(),spawn('t1','Scout','running'),cmd('ls'),spawn('t2','Reader','completed'),spawn('t3','Writer','failed'),reply('Done.')],false,{});
  const cards=rows.filter(row=>row.kind==='subagents') as Extract<TranscriptRow,{kind:'subagents'}>[];
  assert.equal(cards.length,1,'one card for the run');
  assert.equal(rows.some(row=>row.kind==='work'&&row.items.some(i=>i.data?.type==='collabAgentToolCall')),false,'no delegation tool rows remain');
  assert.equal(cards[0]!.card.members.length,3);
  assert.equal(subagentCounts({working:2,done:1,failed:0,members:[]}),'2 working · 1 done');
  assert.equal(subagentCounts({working:0,done:0,failed:0,members:[{id:'a',name:'A',state:'idle'}]}),'1 agent');
  assert.deepEqual(kinds(derive([user(),spawn('t1','Scout','completed'),cmd('ls'),reply('Done.')]).rows),['user','fold','subagents','assistant','changed-files'],'the card stays visible when the turn folds');
});

test('group sentences: edits and commands lead, at most two categories, then a count of the rest',()=>{
  assert.equal(groupSentence([edit('a.ts'),edit('b.ts'),edit('a.ts'),cmd('npm test'),cmd('ls'),tool({type:'fileRead',path:'c.ts'}),tool({type:'webSearch',query:'x'})]),'Changed 2 files and ran 2 commands, and 2 other actions');
  assert.equal(groupSentence([tool({type:'fileRead',path:'c.ts'})]),'Read 1 file');
  assert.equal(groupSentence([tool({type:'webSearch',query:'x'}),tool({type:'webSearch',query:'y'})]),'Searched the web 2 times');
  assert.equal(groupSentence([cmd('npm test',{},'running')]),'Running npm test','a running group says what runs now');
});

test('failures are graded by severity',()=>{
  assert.equal(toolSeverity(cmd('npm test',{exitCode:1},'failed')),'routine');
  assert.equal(toolSeverity(tool({type:'mcpToolCall',error:'boom'},'failed')),'severe');
  assert.equal(toolSeverity(cmd('grep x',{exitCode:1})),'routine');
  assert.equal(toolSeverity(cmd('ls',{},'interrupted')),'routine');
  assert.equal(toolSeverity(cmd('ls',{exitCode:0})),'none');
  const work=derive([user(),cmd('npm test',{exitCode:1},'failed'),tool({type:'mcpToolCall',error:'x'},'failed'),reply('Done.')],false,{});
  assert.equal(noticeSeverity(item('notice','x',{status:'failed'})),'routine');
  const opened=derive([user(),cmd('npm test',{exitCode:1},'failed'),cmd('ls'),reply('Done.')],false,{[work.turns[0]!.id]:true});
  void opened;
  const group=derive([user(),cmd('npm test',{exitCode:1},'failed'),tool({type:'mcpToolCall',error:'x'},'failed')],true).rows.find(row=>row.kind==='work') as Extract<TranscriptRow,{kind:'work'}>;
  assert.equal(group.severity,'severe','a group takes its worst row');
});

test('sources: sites from browser steps and files from reads, edits and searches, deduplicated',()=>{
  const icons=groupSources([
    tool({type:'mcpToolCall',tool:'navigate',arguments:JSON.stringify({url:'https://www.pytest.org/en/'})}),
    tool({type:'mcpToolCall',tool:'navigate',arguments:JSON.stringify({url:'https://pytest.org/other'})}),
    tool({type:'fileRead',path:'src/store.py'}),edit('src/app.ts'),
    cmd('chrome-devtools-axi open https://docs.python.org/3/'),
  ]);
  assert.deepEqual(icons.map(icon=>icon.key),['site:pytest.org','file:src/store.py','file:src/app.ts','site:docs.python.org']);
});

test('consecutive thoughts merge into one row; thoughts read as one plain line',()=>{
  const u=user();
  const {rows}=derive([u,thought('A'),thought('B'),cmd('ls'),thought('C'),reply('Done.')],false,{[u.id]:true});
  const thoughts=rows.filter(row=>row.kind==='reasoning') as Extract<TranscriptRow,{kind:'reasoning'}>[];
  assert.deepEqual(thoughts.map(row=>row.items.length),[2,1]);
  assert.equal(thoughtLine('**Bold** start\n\n# Next _step_ here'),'Next step here');
  assert.equal(thoughtLine('x'.repeat(200)).length,140);
});

test('live labels name files by basename and fall back to Thinking',()=>{
  assert.deepEqual(liveLabel([tool({type:'fileRead',path:'/a/b/store.py'},'running')]),{label:'Reading store.py',tense:'present'});
  assert.deepEqual(liveLabel([thought('',`running`)]),{label:'Thinking',tense:'present'});
  assert.deepEqual(liveLabel([]),{label:'Thinking',tense:'present'});
});

test('rows before the first prompt belong to no turn',()=>{
  const {rows,turns}=derive([item('notice','Imported',{data:{kind:'imported'}}),user(),reply('Hi.')]);
  assert.equal(rows[0]!.kind,'notice');assert.equal(rows[0]!.turnId,undefined);assert.equal(turns.length,1);
});

test('every row kind is produced somewhere above, and shareRows keeps unchanged rows by identity',()=>{
  const u=user(),done=[u,thought('Plan'),cmd('ls'),edit('a.ts'),reply('Done.'),item('approval','ok',{status:'accepted'}),item('question','q',{status:'answered'})];
  const second=user();
  const all=[...done,second,tool({type:'collabAgentToolCall',subagentGroup:'g',receiverThreadIds:['t'],agentsStates:{t:{status:'running'}}},'running'),item('notice','note'),user('steer',{steered:true}),reply('streaming','running')];
  const first=derive(all,true,{[u.id]:true}).rows;
  assert.deepEqual([...new Set(kinds(first))].sort(),[...ROW_KINDS].sort());
  // Streaming: only the tail changes. Every settled row keeps its object.
  const grown=all.map(entry=>entry.status==='running'&&entry.kind==='assistant'?{...entry,text:entry.text+' more'}:entry);
  const next=shareRows(first,derive(grown,true,{[u.id]:true}).rows);
  const changed=next.filter((row,index)=>row!==first[index]).map(row=>row.kind);
  assert.deepEqual(changed,['assistant'],'only the streaming reply is a new row object');
  assert.equal(shareRows(next,derive(grown,true,{[u.id]:true}).rows),next,'an identical derivation returns the same array');
});
