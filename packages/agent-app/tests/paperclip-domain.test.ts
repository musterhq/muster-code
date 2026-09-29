/** Projects workspace domain (#115): Paperclip mapping, auth, ETag reuse, the live channel's cost rules, writes, the local
 *  source over Muster's own Projects, "Create your own" organisations and memory recall. Paperclip is faked; nothing
 *  here talks to a real server. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain,rankMemories,PAPERCLIP_SECRET_ID} from '../src/runtime/domains/paperclip.ts';
import {normalizeBaseUrl} from '../src/runtime/paperclip-client.ts';
import {buildInbox,mapAttention,mapIssue,mapRoutine} from '../src/runtime/paperclip-map.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import type {SocketFactory} from '../src/runtime/paperclip-client.ts';

const COMPANY='c0000000-0000-4000-8000-000000000001';
const agents=[
  {id:'a-ceo',name:'CEO',role:'ceo',title:'Chief',status:'idle',reportsTo:null,adapterType:'claude_local',adapterConfig:{model:'claude-opus-5-5'}},
  {id:'a-cto',name:'CTO',role:'cto',status:'active',reportsTo:'a-ceo',adapterType:'claude_local',adapterConfig:{model:'claude-opus-5-5'}},
  {id:'a-qa',name:'QA',role:'qa',status:'error',errorReason:'continuation_task_ownership_changed',reportsTo:'a-cto',adapterConfig:{}},
  {id:'a-old',name:'Old',role:'general',status:'paused',reportsTo:'a-ceo',adapterConfig:{}},
];
const issues=[
  {id:'i-12',identifier:'RAG-12',title:'Remediate 66 observability regressions',status:'in_progress',priority:'high',projectId:'p-oss',parentId:'i-11',assigneeAgentId:'a-cto',createdByAgentId:'a-ceo',createdAt:'2026-09-29T07:00:00.000Z',updatedAt:'2026-09-29T08:00:00.000Z',activeRun:{id:'r-1'}},
  {id:'i-11',identifier:'RAG-11',title:'Fix the 66 failing tests',status:'in_review',priority:'critical',projectId:'p-oss',assigneeAgentId:'a-cto',createdByUserId:'local-board',createdAt:'2026-09-29T06:00:00.000Z',updatedAt:'2026-09-29T07:30:00.000Z'},
  {id:'i-4',identifier:'RAG-4',title:'Docs',status:'blocked',priority:'medium',projectId:'p-oss',assigneeAgentId:'a-qa',createdAt:'2026-09-28T06:00:00.000Z',updatedAt:'2026-09-28T07:30:00.000Z'},
  {id:'i-3',identifier:'RAG-3',title:'Shipped',status:'done',priority:'low',projectId:'p-oss',createdAt:'2026-09-27T06:00:00.000Z',updatedAt:'2026-09-27T07:30:00.000Z'},
];
const now=new Date().toISOString();
const runs=[{id:'r-1',agentId:'a-cto',status:'running',invocationSource:'assignment',startedAt:now,createdAt:now,contextSnapshot:{issueId:'i-12'}},{id:'r-0',agentId:'a-qa',status:'failed',error:'boom',createdAt:now,finishedAt:now,contextSnapshot:{issueId:'i-4'}},{id:'r-x',agentId:'a-ceo',status:'failed',createdAt:now,finishedAt:now,contextSnapshot:{issueId:'i-3'}}];
const projects=[{id:'p-oss',name:'OSS Manager',status:'in_progress',codebase:{repoUrl:'https://github.com/hybrowlabs/OSS-Manager',effectiveLocalFolder:'/work/oss'}}];
const attention={items:[{id:'att-1',sourceKind:'issue_thread_interaction',subject:{kind:'interaction',id:'x',title:'Plan approval'},relatedIssue:{id:'i-11',identifier:'RAG-11',title:'Fix the 66 failing tests'},whyNow:'Waiting for the board.',severity:'high',activityAt:now},{id:'att-2',sourceKind:'agent_error_alert',subject:{kind:'agent',id:'a-qa',title:'QA'},whyNow:'Agent is in error status.',severity:'high',activityAt:now}]};
const comments=[{id:'m1',issueId:'i-12',body:'**Draft fix** committed.',authorAgentId:'a-cto',authorType:'agent',createdAt:'2026-09-29T08:00:00.000Z'},{id:'m2',issueId:'i-12',body:'Parked by founder',authorUserId:'local-board',authorType:'user',createdAt:'2026-09-29T08:05:00.000Z'},{id:'m3',issueId:'i-12',body:'gone',deletedAt:now,createdAt:now}];

interface Call {method:string;url:string;headers:Record<string,string>;body?:unknown}
function paperclip(){
  const calls:Call[]=[];let version=1;
  const routes:Record<string,()=>unknown>={
    '/api/health':()=>({status:'ok',version:'2026.916.1',deploymentMode:'authenticated'}),
    '/api/companies':()=>[{id:COMPANY,name:'RagnarDataOps',issuePrefix:'RAG',status:'active'}],
    [`/api/companies/${COMPANY}/issues`]:()=>issues,[`/api/companies/${COMPANY}/agents`]:()=>agents,[`/api/companies/${COMPANY}/projects`]:()=>projects,
    [`/api/companies/${COMPANY}/goals`]:()=>[],[`/api/companies/${COMPANY}/heartbeat-runs`]:()=>runs,[`/api/companies/${COMPANY}/live-runs`]:()=>[],
    [`/api/companies/${COMPANY}/attention`]:()=>attention,'/api/issues/RAG-12':()=>issues[0],'/api/issues/RAG-12/comments':()=>comments,'/api/issues/RAG-12/runs':()=>[runs[0]],
    [`/api/companies/${COMPANY}/routines`]:()=>[{id:'rt',title:'Nightly triage',status:'active',projectId:'p-oss',concurrencyPolicy:'always_enqueue',catchUpPolicy:'skip_missed',triggers:[{kind:'schedule',enabled:true,cronExpression:'0 9 * * 1-5',timezone:'UTC',nextRunAt:'2026-09-30T09:00:00.000Z'}],lastRun:{status:'failed',createdAt:now}}],
  };
  const fetch=async(input:string,init:RequestInit={})=>{
    const url=new URL(input),headers=Object.fromEntries(Object.entries((init.headers??{}) as Record<string,string>).map(([k,v])=>[k.toLowerCase(),v]));
    calls.push({method:init.method??'GET',url:url.pathname+url.search,headers,body:init.body?JSON.parse(String(init.body)):undefined});
    if(init.method&&init.method!=='GET')return new Response(JSON.stringify(url.pathname.endsWith('/comments')?{id:'new',body:(JSON.parse(String(init.body)) as {body:string}).body,authorUserId:'local-board',createdAt:now}:url.pathname.startsWith('/api/issues/')?{...issues[0],...(JSON.parse(String(init.body)) as object)}:{}),{status:200});
    const route=routes[url.pathname];
    if(!route)return new Response('{"error":"not found"}',{status:404});
    const etag=`W/"${url.pathname}-${version}"`;
    if(headers['if-none-match']===etag)return new Response(null,{status:304,headers:{etag}});
    return new Response(JSON.stringify(route()),{status:200,headers:{etag,'content-type':'application/json'}});
  };
  return {calls,fetch,bump(){version++;}};
}
function secretsFake(){const values=new Map<string,string>();return {values,store:{status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}}};}
function fakeTimers(){const live=new Map<number,{fn:()=>void;ms:number}>();let n=0;return {live,setTimeout:((fn:()=>void,ms:number)=>{live.set(++n,{fn,ms});return n;}) as unknown as typeof setTimeout,clearTimeout:((id:number)=>{live.delete(id);}) as unknown as typeof clearTimeout,async fire(){const all=[...live];live.clear();for(const [,t] of all)await t.fn();}};}

async function harness(t:TestContext,options:{socket?:SocketFactory;invoke?:(command:string,input:any)=>unknown;folders?:{id:string;name:string;path:string}[]}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-paperclip-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const server=paperclip(),secrets=secretsFake(),timers=fakeTimers(),events:any[]=[],invoked:{command:string;input:any}[]=[];
  const {DatabaseSync}=await import('node:sqlite');const memory=new DatabaseSync(':memory:');t.after(()=>memory.close());
  const context={dataDir,db:()=>memory,store:{snapshot:()=>({folders:options.folders??[]})},emit:(e:unknown)=>events.push(e),hooks:{},
    async invoke(command:string,input:any){invoked.push({command,input});if(options.invoke){const r=options.invoke(command,input);if(r!==undefined)return r;}
      if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];
      if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const domain=createPaperclipDomain(context,{fetch:server.fetch as never,secrets:()=>secrets.store as never,timers,socket:options.socket??(()=>{throw new Error('no socket');}),remoteOf:async path=>path.endsWith('oss')?'git@github.com:hybrowlabs/OSS-Manager.git':undefined});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  return {dataDir,server,secrets,timers,events,invoked,call};
}

test('a custom deployment sends its board token as a Bearer header; the token lives in the secret store, never in the config file',async t=>{
  const h=await harness(t);
  const view=await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://pc.example.com/',token:'pcp_board_abc',companyId:COMPANY});
  assert.equal(view.baseUrl,'https://pc.example.com');assert.equal(view.hasToken,true);assert.equal('token' in view,false);
  assert.equal(h.secrets.values.get(PAPERCLIP_SECRET_ID),'pcp_board_abc');
  const file=await readFile(join(h.dataDir,'paperclip.json'),'utf8');
  assert.doesNotMatch(file,/pcp_board/);
  await h.call('paperclip.snapshot');
  assert.ok(h.server.calls.length>5);
  for(const c of h.server.calls)assert.equal(c.headers.authorization,'Bearer pcp_board_abc');
  const result=await h.call('paperclip.test',{mode:'custom',baseUrl:'https://pc.example.com'});
  assert.equal(result.ok,true);assert.equal(result.companies[0].prefix,'RAG');assert.equal(result.deploymentMode,'authenticated');
});

test('This Mac needs no token and never sends one; bad URLs are refused before any request',async t=>{
  const h=await harness(t);
  h.secrets.values.set(PAPERCLIP_SECRET_ID,'pcp_board_should_not_leak');
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  assert.ok(h.server.calls.every(c=>c.url.startsWith('/api/')&&!c.headers.authorization));
  assert.throws(()=>normalizeBaseUrl('ftp://x'),/http/);
  assert.throws(()=>normalizeBaseUrl('https://user:pw@x.com'),/token field/);
  const bad=await h.call('paperclip.test',{mode:'custom',baseUrl:'not a url'});
  assert.equal(bad.ok,false);assert.equal(bad.stage,'config');
});

test('the snapshot maps Paperclip into the workspace shapes, and an unchanged refresh is served from ETag 304s',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const snap=await h.call('paperclip.snapshot');
  assert.equal(snap.paperclip.company.name,'RagnarDataOps');assert.equal(snap.paperclip.origin,'This Mac');assert.ok(snap.tasks.every((t:any)=>t.source==='paperclip'));
  const rag12=snap.tasks.find((x:any)=>x.key==='RAG-12');
  assert.equal(rag12.live,true);assert.equal(rag12.assigneeLabel,'CTO');assert.equal(rag12.origin,'CEO');assert.equal(rag12.parentId,'i-11');
  assert.equal(snap.agents.find((a:any)=>a.id==='a-cto').status,'running','an active agent with a running run is working');
  assert.equal(snap.agents.find((a:any)=>a.id==='a-cto').model,'claude-opus-5-5');
  assert.equal(snap.projects[0].repo,'github.com/hybrowlabs/oss-manager');
  assert.equal(snap.counts.liveRuns,1);
  const kinds=snap.inbox.map((i:any)=>i.kind).sort();
  assert.deepEqual(kinds,['agent_error','blocked','failed_run','question'].sort(),'attention + blocked task + failed run; the in-review task is covered by its question; failures on done work are dropped');
  assert.ok(snap.inbox.every((i:any)=>i.source==='paperclip'&&i.group));
  const before=h.server.calls.length;
  const again=await h.call('paperclip.snapshot');
  assert.deepEqual(again.tasks,snap.tasks,'nothing changed, nothing rebuilt');
  assert.ok(h.server.calls.slice(before).filter(c=>c.url!=='/api/companies').every(c=>c.headers['if-none-match']),'every refresh is conditional');
});

test('the thread renders comments (deleted ones hidden) and the composer addresses the assignee; writes hit the documented endpoints',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  const detail=await h.call('paperclip.task',{id:'RAG-12'});
  assert.equal(detail.comments.length,2);assert.equal(detail.comments[0].author.label,'CTO');assert.equal(detail.comments[1].author.label,'Board');
  assert.deepEqual(detail.addressee,{id:'a-cto',label:'CTO'});
  await h.call('paperclip.comment',{taskId:'RAG-12',body:'Please rebase.'});
  await h.call('paperclip.task.update',{taskId:'RAG-12',status:'in_review'});
  await h.call('paperclip.run.cancel',{id:'r-1'});
  await h.call('paperclip.pauseAll',{source:'paperclip'});
  const writes=h.server.calls.filter(c=>c.method!=='GET').map(c=>`${c.method} ${c.url} ${JSON.stringify(c.body)}`);
  assert.deepEqual(writes,[
    'POST /api/issues/RAG-12/comments {"body":"Please rebase."}','PATCH /api/issues/RAG-12 {"status":"in_review"}','POST /api/heartbeat-runs/r-1/cancel {}',
    'POST /api/agents/a-ceo/pause {}','POST /api/agents/a-cto/pause {}','POST /api/agents/a-qa/pause {}',
  ],'Pause all skips agents already paused');
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'RAG-12',status:'shipped'}),/Unknown status/);
  await assert.rejects(()=>h.call('paperclip.comment',{taskId:'../../x',body:'x'}),/Unknown item/);
});

test('live updates cost nothing while hidden: a refused socket polls only while visible, and hiding clears every timer',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.timers.fire();
  await h.call('paperclip.snapshot');
  assert.equal((await h.call('paperclip.watch',{visible:false})).live,'off');
  assert.equal([...h.timers.live.values()].length,0,'hidden and no socket: no timers');
  await h.call('paperclip.watch',{visible:true});
  const polls=[...h.timers.live.values()];
  assert.equal(polls.length,1);assert.ok(polls[0].ms>=15_000,'polls no faster than every 15 s');
  await h.call('paperclip.watch',{visible:false});
  assert.equal(h.timers.live.size,0,'hiding the screen clears the poll');
});

test('socket events are filtered and coalesced; run-log noise never wakes the renderer',async t=>{
  const sockets:any[]=[];
  const h=await harness(t,{socket:()=>{const s:any={onopen:null,onmessage:null,onclose:null,onerror:null,close(){s.closed=true;}};sockets.push(s);return s;}});
  await h.call('paperclip.config.set',{mode:'local'});
  await h.timers.fire();h.events.length=0;
  await h.call('paperclip.snapshot');
  assert.equal(sockets.length,1);
  sockets[0].onopen();
  await h.call('paperclip.watch',{visible:true});
  assert.equal(h.timers.live.size,0,'a live socket needs no poll');
  for(let i=0;i<50;i++)sockets[0].onmessage({data:JSON.stringify({type:'heartbeat.run.log',payload:{}})});
  assert.equal(h.timers.live.size,0,'log frames are dropped');
  sockets[0].onmessage({data:JSON.stringify({type:'heartbeat.run.status',payload:{issueId:'i-12'}})});
  sockets[0].onmessage({data:JSON.stringify({type:'activity.logged',payload:{entityType:'issue',entityId:'i-4'}})});
  assert.equal(h.timers.live.size,1,'two events, one pending emit');
  assert.equal([...h.timers.live.values()][0].ms,1000);
  await h.timers.fire();
  assert.equal(h.events.length,1);
  assert.deepEqual(h.events[0].taskIds.sort(),['i-12','i-4']);
  sockets[0].onclose();
  assert.equal(h.timers.live.size,1,'socket down while visible: fall back to a poll');
});

test('Paperclip routines map onto the automation model',()=>{
  const row=mapRoutine({id:'rt',title:'Nightly triage',status:'paused',projectId:'p',concurrencyPolicy:'always_enqueue',catchUpPolicy:'skip_missed',triggers:[{kind:'schedule',enabled:true,cronExpression:'0 9 * * 1-5',timezone:'UTC',nextRunAt:'2026-09-30T09:00:00.000Z'}],lastRun:{status:'failed',createdAt:now}});
  assert.equal(row.paused,true);assert.equal(row.overlap,'queue');assert.equal(row.catchUp,'none');assert.equal(row.nextRunAt,'2026-09-30T09:00:00.000Z');assert.match(row.detail,/Cron 0 9 \* \* 1-5 \(UTC\)/);assert.equal(row.lastRun?.status,'failed');
});

test('inbox helpers: attention kinds, review/blocked tasks, recent failed runs once per agent and task',()=>{
  const agentsMap=new Map([['a',{id:'a',name:'A'} as any]]);
  const tasks=[mapIssue({id:'t',identifier:'X-1',title:'T',status:'in_review'},agentsMap,new Set())];
  const items=buildInbox([mapAttention({id:'q',sourceKind:'approval',subject:{kind:'approval',title:'Hire'},severity:'low',activityAt:now})],tasks,[{id:'r1',agentId:'a',taskId:'t',status:'failed',createdAt:now,finishedAt:now,startedAt:null,error:null,trigger:null,cancellable:false,source:'paperclip'},{id:'r2',agentId:'a',taskId:'t',status:'failed',createdAt:now,finishedAt:now,startedAt:null,error:null,trigger:null,cancellable:false,source:'paperclip'}],agentsMap);
  assert.deepEqual(items.map(i=>i.kind).sort(),['approval','failed_run','review'],'one failed run per agent and task');
  assert.equal(items.at(-1)!.kind,'approval','low severity sorts last');
});

test('local source: Muster Projects become tasks, agents and an inbox; writes go through the existing commands',async t=>{
  const task=(id:string,state:string,extra:object={})=>({id,projectId:'p1',title:`Task ${id}`,status:'todo',state,dependencies:[],acceptance:'Done when green',evidence:[],revision:3,createdAt:`2026-09-2${id}T00:00:00.000Z`,updatedAt:now,owner:{kind:'agent',id:'agent'},priority:1,artifacts:['docs/plan.md'],attempts:[],verification:null,permissionMode:null,budgetMinutes:null,blockedBy:null,ready:false,verificationStale:false,waitingChatId:null,...extra});
  const work={tasks:{items:[task('1','running',{attempts:[{id:'at1',chatId:'chat1',runId:'run',trigger:'user',startedAt:now,endedAt:null,status:'running',contextVersion:1}]}),task('2','needs-input'),task('3','verified'),task('4','failed',{runError:'tests failed'})],truncated:false},decisions:{items:[],truncated:false},activity:{items:[{id:'act',projectId:'p1',actor:'You',kind:'task.status',summary:'Task moved to running',refId:'1',createdAt:'2026-09-21T00:00:00.000Z'}],truncated:false},scheduler:{paused:false},instructions:{},context:{},coordinator:{},dispatching:[]};
  const h=await harness(t,{invoke:(command,input)=>{
    if(command==='project.list')return [{id:'p1',name:'Launch Plan',goal:'Ship',folderIds:['f1'],primaryFolderId:'f1',archived:false,archivedAt:null}];
    if(command==='project.work')return work;if(command==='project.members.list')return {members:[{id:'m1',kind:'agent',name:'Builder',revokedAt:null}]};
    if(command==='mailbox.list')return {messages:[{id:'mail1',seq:1,kind:'request',sender:{kind:'taskRun',id:'2',label:'Builder'},recipient:{kind:'user',id:'user'},projectId:'p1',body:'Which DB?',createdAt:now,state:'delivered',reply:'awaiting',deliveries:[]}],unacked:1,pending:0};
    if(command==='mailbox.send')return {id:'mail2',seq:2,kind:'message',sender:{kind:'user',id:'user'},recipient:input.to,projectId:'p1',body:input.body,createdAt:now,state:'pending',reply:'none',deliveries:[]};
    if(command==='project.tasks.setState'||command==='project.scheduler.set'||command==='chat.stop')return {};
  },folders:[{id:'f1',name:'launch',path:'/work/launch'}]});
  const snap=await h.call('paperclip.snapshot');
  assert.equal(snap.paperclip,null);assert.ok(snap.tasks.every((t:any)=>t.source==='local'));
  assert.deepEqual(snap.tasks.map((x:any)=>`${x.key}:${x.status}`),['LP-1:in_progress','LP-2:in_review','LP-3:done','LP-4:blocked']);
  assert.equal(snap.tasks[0].assigneeLabel,'Builder');assert.equal(snap.counts.liveRuns,1);
  assert.deepEqual(snap.agents.map((a:any)=>`${a.name}>${a.reportsTo}`),['You>null','Builder>user:local']);
  assert.deepEqual(snap.inbox.map((i:any)=>i.kind).sort(),['failed_run','question','question'],'needs-input task, a question by mail, the failed task');
  assert.ok(snap.inbox.every((i:any)=>i.group==='Launch Plan'));
  const detail=await h.call('paperclip.task',{id:'1'});
  assert.equal(detail.description,'Done when green');assert.equal(detail.comments[0].body,'Task moved to running');assert.equal(detail.addressee.label,'Builder');
  await h.call('paperclip.comment',{taskId:'1',body:'Use Postgres'});
  assert.deepEqual(h.invoked.find(c=>c.command==='mailbox.send')!.input,{to:{kind:'taskRun',id:'1',projectId:'p1'},body:'Use Postgres'});
  await h.call('paperclip.task.update',{taskId:'2',status:'blocked'});
  assert.deepEqual(h.invoked.find(c=>c.command==='project.tasks.setState')!.input,{projectId:'p1',id:'2',revision:3,state:'blocked'});
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'2',status:'done'}),/verifying/);
  await h.call('paperclip.pauseAll',{source:'local'});
  assert.deepEqual(h.invoked.find(c=>c.command==='project.scheduler.set')!.input,{projectId:'p1',paused:true});
  await h.call('paperclip.run.cancel',{id:'at1'});
  assert.deepEqual(h.invoked.find(c=>c.command==='chat.stop')!.input,{id:'chat1'});
  await h.timers.fire();
  assert.equal((await h.call('paperclip.watch',{visible:true})).live,'events');
  assert.equal(h.timers.live.size,0,'local mode never polls');
  const artifacts=await h.call('paperclip.list',{kind:'artifacts'});
  assert.equal(artifacts.rows[0].title,'plan.md');
  assert.equal(h.server.calls.length,0,'Paperclip off: no network');
});

test('memory: a task recalls from the Muster folder whose git remote matches its project repository',async t=>{
  const records=[{id:'1',source:'local',text:'Observability regressions come from the recovery symlink check',kind:'fact',scope:{kind:'folder',id:'f',label:'oss'},provenance:[],deletable:true,observedAt:'2026-09-01T00:00:00.000Z'},{id:'2',source:'local',text:'Unrelated note about billing',kind:'fact',scope:{kind:'folder',id:'f',label:'oss'},provenance:[],deletable:true}];
  const h=await harness(t,{folders:[{id:'f-other',name:'other',path:'/work/other'},{id:'f-oss',name:'oss',path:'/clone/oss'}],invoke:(command)=>command==='memory.browse'?{records,status:{connection:'not-configured'}}:undefined});
  await h.call('paperclip.config.set',{mode:'local'});
  const memory=await h.call('paperclip.memory',{taskId:'i-12'});
  assert.deepEqual(h.invoked.find(c=>c.command==='memory.browse')!.input,{folderId:'f-oss'});
  assert.equal(memory.scope.kind,'repository');assert.equal(memory.records.length,1);assert.match(memory.records[0].text,/Observability/);
  assert.match(memory.note,/github.com\/hybrowlabs\/oss-manager/);
  assert.deepEqual(rankMemories(records as never,'the and for'),[]);
});

test('turn ledger: entries chain by hash, verify catches an edited entry, and files come from the review baseline',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {TurnLedger,filesChanged}=await import('../src/runtime/turn-ledger.ts');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const ledger=new TurnLedger(db);
  const body=(n:number)=>({id:`c:r${n}`,chatId:'c',runId:`r${n}`,taskId:null,projectId:'p',trigger:'chat',agent:'Builder',provider:'codex',model:'gpt-6',tokens:{input:100*n,cached:0,output:10*n,reasoning:0},costUsd:null,tools:[{name:'shell',count:n}],approvals:0,tests:0,files:[],startedAt:now,endedAt:new Date(Date.now()+n).toISOString(),durationMs:1000,outcome:'completed'});
  const a=ledger.append(body(1)),b=ledger.append(body(2));
  assert.equal(a.prevHash,'0'.repeat(64));assert.equal(b.prevHash,a.hash);
  assert.deepEqual(ledger.verify(),{ok:true,entries:2,head:b.hash,brokenAt:null});
  assert.deepEqual(ledger.list({chatIds:['c']}).map(e=>e.runId),['r2','r1']);
  db.prepare("UPDATE turn_ledger SET body=replace(body,'\"input\":100','\"input\":1') WHERE seq=1").run();
  const broken=ledger.verify();
  assert.equal(broken.ok,false);assert.equal(broken.brokenAt,1);
  // Files: a real repository, baseline tree vs working tree.
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
  const repo=await mkdtemp(join(tmpdir(),'muster-ledger-'));t.after(()=>rm(repo,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:repo});await writeFile(join(repo,'a.txt'),'one\n');
  const {snapshotTree}=await import('../src/runtime/review-baseline.ts');
  const before=await snapshotTree(repo);
  await writeFile(join(repo,'a.txt'),'two\n');await writeFile(join(repo,'b.txt'),'new\n');
  const files=await filesChanged(repo,before);
  assert.deepEqual(files!.map(f=>`${f.status}:${f.path}:${Boolean(f.before)}:${Boolean(f.after)}:+${f.added}-${f.removed}`).sort(),['added:b.txt:false:true:+1-0','modified:a.txt:true:true:+1-1']);
  assert.equal(await filesChanged(repo,null),null,'no baseline, no file claims');
});

test('turn ledger: only project and task runs diff the tree; everyday chats pay nothing new',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {TurnLedger,attachTurnLedger}=await import('../src/runtime/turn-ledger.ts');
  const {snapshotTree}=await import('../src/runtime/review-baseline.ts');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
  const repo=await mkdtemp(join(tmpdir(),'muster-ledger-'));t.after(()=>rm(repo,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:repo});await writeFile(join(repo,'a.txt'),'one\n');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  db.exec('CREATE TABLE review_baselines (run_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, folder_id TEXT, tree_sha TEXT, created_at TEXT NOT NULL, reason TEXT)');
  const ledger=new TurnLedger(db),appended:any[]=[];
  const hooks:any={};
  const context={db:()=>db,hooks:{onRunStarted:(fn:any)=>{hooks.start=fn;return()=>{};},onRunSettled:(fn:any)=>{hooks.settle=fn;return()=>{};},onProviderEvent:(fn:any)=>{hooks.event=fn;return()=>{};}}} as unknown as DomainContext;
  const off=attachTurnLedger(context,()=>ledger,e=>appended.push(e));t.after(off);
  const turn=async(chat:object,runId:string)=>{
    db.prepare('INSERT INTO review_baselines VALUES (?,?,?,?,?,?)').run(runId,(chat as any).id,null,await snapshotTree(repo),now,null);
    await hooks.start({chat,runId,cwd:repo});
    await writeFile(join(repo,`${runId}.txt`),'new\n');
    await hooks.settle({chat,runId,status:'completed'});
  };
  await turn({id:'everyday',title:'Chat'},'r-chat');
  await turn({id:'task-run',title:'Builder',projectId:'p1'},'r-task');
  assert.equal(appended.length,2);
  assert.equal(appended[0].files,null,'an everyday chat never snapshots the tree at settle');
  assert.deepEqual(appended[1].files.map((f:any)=>`${f.status}:${f.path}`),['added:r-task.txt'],'a project run records the files it changed');
});

test('inbox activity: chats that ask or fail are Needs you / Problems; finished chats are Done; the badge counts only the first two',async()=>{
  const {buildActivity,badgeCount}=await import('../src/renderer/inboxModel.ts');
  const chat=(id:string,status:string,extra:object={})=>({id,title:`Chat ${id}`,status,archived:false,updatedAt:now,pinned:false,draft:'',model:'m',mode:'agent',...extra});
  const items=buildActivity({chats:[chat('a','running'),chat('b','failed',{error:'Rate limited'}),chat('c','completed',{unread:true}),chat('d','idle'),chat('e','waiting')] as any,folders:[],projects:[],attention:{totalRequests:1,chats:[{chatId:'a',chatTitle:'Chat a',approvalCount:1,questionCount:0,requests:[{itemId:'x',kind:'approval',createdAt:now,sourceLabel:'Provider approval'}]}]}},
    {inbox:[{id:'m',kind:'mail',title:'Builder: Which DB?',why:'Sent you a message.',severity:'low',at:now,taskId:null,agentId:null,runId:null,group:'Launch',source:'local'},{id:'r',kind:'review',title:'X-1',why:'Review',severity:'medium',at:now,taskId:'t',agentId:null,runId:null,group:'Launch',source:'paperclip'}]} as any);
  const by=Object.fromEntries(items.map(i=>[i.id,i.bucket]));
  assert.deepEqual(by,{'chat-needs:a':'needs','chat-problem:b':'problems','chat-done:c':'done','chat-needs:e':'needs','ws:m':'mentions','ws:r':'review'});
  assert.equal(badgeCount(items),3);
  assert.equal(items.find(i=>i.id==='chat-problem:b')!.why,'Rate limited');
});

test('one snapshot merges Muster and the linked Paperclip; writes route to whichever side owns the task',async t=>{
  const localTask={id:'lt1',projectId:'p1',title:'Muster task',status:'todo',state:'todo',dependencies:[],acceptance:'',evidence:[],revision:1,createdAt:now,updatedAt:now,owner:{kind:'agent',id:'agent'},priority:2,artifacts:[],attempts:[],verification:null,permissionMode:null,budgetMinutes:null,blockedBy:null,ready:true,verificationStale:false,waitingChatId:null};
  const h=await harness(t,{invoke:(command,input)=>{
    if(command==='project.list')return [{id:'p1',name:'Launch',goal:'Ship',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null}];
    if(command==='project.work')return {tasks:{items:[localTask],truncated:false},decisions:{items:[]},activity:{items:[]},scheduler:{paused:false}};
    if(command==='project.members.list')return {members:[]};
    if(command==='mailbox.send')return {id:'m',seq:1,kind:'message',sender:{kind:'user',id:'user'},recipient:input.to,projectId:'p1',body:input.body,createdAt:now,state:'pending',reply:'none',deliveries:[]};
  }});
  await h.call('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const snap=await h.call('paperclip.snapshot');
  assert.deepEqual([...new Set(snap.tasks.map((x:any)=>x.source))].sort(),['local','paperclip']);
  assert.deepEqual(snap.projects.map((p:any)=>`${p.source}:${p.name}`),['local:Launch','paperclip:OSS Manager']);
  await h.call('paperclip.comment',{taskId:'lt1',body:'local please'});
  await h.call('paperclip.comment',{taskId:'RAG-12',body:'paperclip please'});
  assert.equal(h.invoked.filter(c=>c.command==='mailbox.send').length,1,'the Muster task goes through the mailbox');
  assert.deepEqual(h.server.calls.filter(c=>c.method==='POST').map(c=>c.url),['/api/issues/RAG-12/comments'],'the Paperclip task goes to Paperclip, and only it');
  const badge=await h.call('paperclip.badge');
  assert.equal(badge.connected,true);assert.equal(badge.inbox,4,'blocked, question, agent error and the failed run; reviews and mail never badge');
});

test('a Paperclip confirmation is answered from Muster: accept, or reject with a reason',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  await h.call('paperclip.interaction.respond',{taskId:'RAG-1',interactionId:'int-1',accept:true});
  await h.call('paperclip.interaction.respond',{taskId:'RAG-1',interactionId:'int-2',accept:false,reason:'Keep the old flow'});
  assert.deepEqual(h.server.calls.filter(c=>c.method==='POST').map(c=>`${c.url} ${JSON.stringify(c.body)}`),['/api/issues/RAG-1/interactions/int-1/accept {}','/api/issues/RAG-1/interactions/int-2/reject {"reason":"Keep the old flow"}']);
});
