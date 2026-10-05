/** Connected-server (Paperclip) views, against the shapes a real Paperclip 2026.916.1 answers with (captured from an isolated
 *  test-drive instance, trimmed): costs of a server project (B2), a task's run opening the same run as the Ledger (B3), a project's
 *  own Activity (B4) and a server run's tool use (B6). Paperclip is faked; nothing here talks to a real server. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import {mapRun,mapReceipt,mapRows} from '../src/runtime/paperclip-map.ts';
import {toolsFromLog} from '../src/runtime/server/paperclip-run-tools.ts';
import {groupsFromReceipts,buildCosts} from '../src/runtime/insight/costs.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const C='66382a91-1125-4436-90c4-cdcb62bad362';
const AGENT='3d18b75b-aa00-4b01-8671-2f041aba9608';
const P1='d3e14f4a-6d7c-45eb-84e7-2961eeb3801c';
const T1='95249f8e-85b4-4429-ba7e-a05ad0578edf', T2='2200db3f-ef6a-4bde-967c-f8ed93d3b384';
const R_NEW='7e59f0c4-9c5c-4985-8571-ec0dff07eb42', R_OLD='0a0a0a0a-0000-4000-8000-000000000001', R_P1='dde92ee7-3b9a-4a53-8b0e-3d2c7a5c2e11', R_GONE='ffffffff-0000-4000-8000-00000000000f';
const stamp=(minutesAgo:number)=>new Date(Date.now()-minutesAgo*60_000).toISOString();

/** `/companies/:id/heartbeat-runs` rows: `id`, `contextSnapshot`. */
const heartbeat=(id:string,issueId:string,minutesAgo:number,extra:object={})=>({id,companyId:C,agentId:AGENT,invocationSource:'assignment',status:'succeeded',startedAt:stamp(minutesAgo),finishedAt:stamp(minutesAgo-1),createdAt:stamp(minutesAgo),error:null,usageJson:null,resultJson:null,contextSnapshot:{issueId,taskId:issueId,projectId:issueId===T2?P1:undefined},...extra});
/** `/issues/:id/runs` rows: `runId`, `contextIssueId`, no `id`, no `contextSnapshot` (exactly what Paperclip sends). */
const issueRun=(runId:string,issueId:string,minutesAgo:number)=>({runId,runtimeMode:'legacy',status:'succeeded',agentId:AGENT,adapterType:'process',startedAt:stamp(minutesAgo),finishedAt:stamp(minutesAgo-1),createdAt:stamp(minutesAgo),invocationSource:'assignment',errorCode:null,usageJson:null,resultJson:{stopReason:'completed'},contextIssueId:issueId});
const logOf=(...events:object[])=>events.map((e,i)=>JSON.stringify({ts:stamp(1),stream:'stdout',chunk:`${JSON.stringify(e)}\n`,seq:i+1})).join('\n')+'\n';
const CLAUDE_LOG=logOf({type:'system',subtype:'init'},{type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'ls'}},{type:'tool_use',name:'Read',input:{file_path:'a'}}]}},{type:'assistant',message:{content:[{type:'tool_use',name:'Bash',input:{command:'npm test'}}]}},{type:'assistant',message:{content:[{type:'text',text:'done'}]}});

interface Server {calls:string[];fail:Set<string>;fetch:(input:string,init?:RequestInit)=>Promise<Response>}
function server():Server{
  const calls:string[]=[],fail=new Set<string>();
  const issues=[
    {id:T1,identifier:'BOR-1',title:'Invite request',status:'in_progress',priority:'medium',projectId:null,assigneeAgentId:AGENT,createdAt:stamp(90),updatedAt:stamp(30)},
    {id:T2,identifier:'BOR-2',title:'Wire up onboarding',status:'in_progress',priority:'medium',projectId:P1,assigneeAgentId:AGENT,createdAt:stamp(80),updatedAt:stamp(20)},
  ];
  const recent=[heartbeat(R_NEW,T2,10,{usageJson:{inputTokens:1200,outputTokens:300,costUsd:0.02,model:'gpt-5.1-codex-mini',provider:'codex'}}),heartbeat(R_P1,T2,12,{usageJson:{inputTokens:800,outputTokens:100,model:'gpt-5.1-codex-mini',provider:'codex'}}),heartbeat('b1b1b1b1-0000-4000-8000-000000000002',T1,15,{usageJson:{inputTokens:5000,outputTokens:900,costUsd:0.5}})];
  const audit=[
    {id:'ev-1',action:'issue.updated',entityType:'issue',entityId:T2,actorType:'agent',actorId:AGENT,createdAt:stamp(5),details:{}},
    {id:'ev-2',action:'environment.lease_released',entityType:'environment_lease',entityId:'lease',actorType:'agent',actorId:AGENT,createdAt:stamp(6),details:{issueId:T1}},
    {id:'ev-3',action:'invite.created',entityType:'invite',entityId:'inv',actorType:'user',actorId:'local-board',createdAt:stamp(7),details:{}},
    {id:'ev-4',action:'project.updated',entityType:'project',entityId:P1,actorType:'user',actorId:'local-board',createdAt:stamp(8),details:{}},
  ];
  const routes:Record<string,()=>unknown>={
    '/api/health':()=>({status:'ok',version:'2026.916.1',deploymentMode:'local_trusted'}),
    '/api/companies':()=>[{id:C,name:'B26Org',issuePrefix:'BOR',status:'active'}],
    [`/api/companies/${C}/issues`]:()=>issues,[`/api/companies/${C}/agents`]:()=>[{id:AGENT,name:'Atlas',role:'engineer',status:'idle',reportsTo:null,adapterType:'process',adapterConfig:{}}],
    [`/api/companies/${C}/projects`]:()=>[{id:P1,name:'Onboarding',status:'in_progress',codebase:{effectiveLocalFolder:'/paperclip/instances/default/projects/x/_default'}}],
    [`/api/companies/${C}/goals`]:()=>[],[`/api/companies/${C}/approvals`]:()=>[],[`/api/companies/${C}/labels`]:()=>[],[`/api/companies/${C}/live-runs`]:()=>[],[`/api/companies/${C}/attention`]:()=>({items:[]}),
    [`/api/companies/${C}/heartbeat-runs`]:()=>recent,[`/api/companies/${C}/activity`]:()=>audit,
    [`/api/issues/${T2}`]:()=>issues[1],[`/api/issues/${T2}/comments`]:()=>[],[`/api/issues/${T2}/runs`]:()=>[issueRun(R_NEW,T2,10),issueRun(R_OLD,T2,500)],
    [`/api/heartbeat-runs/${R_OLD}`]:()=>heartbeat(R_OLD,T2,500,{usageJson:{inputTokens:10,outputTokens:5}}),
    [`/api/heartbeat-runs/${R_OLD}/log`]:()=>({runId:R_OLD,store:'local_file',content:CLAUDE_LOG}),
    [`/api/heartbeat-runs/${R_NEW}`]:()=>recent[0],[`/api/heartbeat-runs/${R_NEW}/log`]:()=>({runId:R_NEW,store:'local_file',content:logOf({type:'system'})}),
    [`/api/heartbeat-runs/${R_P1}`]:()=>recent[1],[`/api/heartbeat-runs/${R_P1}/log`]:()=>{throw new Error('log not readable');},
  };
  const fetch=async(input:string)=>{
    const url=new URL(input);calls.push(url.pathname+url.search);
    if(fail.has(url.pathname))return new Response('{"error":"Internal server error"}',{status:500});
    const route=routes[url.pathname];
    if(!route)return new Response('{"error":"not found"}',{status:404});
    try{return new Response(JSON.stringify(route()),{status:200,headers:{'content-type':'application/json'}});}catch{return new Response('{"error":"nope"}',{status:500});}
  };
  return {calls,fail,fetch};
}

async function harness(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-connected-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const srv=server();
  const {DatabaseSync}=await import('node:sqlite');const memory=new DatabaseSync(':memory:');t.after(()=>memory.close());
  const context={dataDir,db:()=>memory,store:{snapshot:()=>({folders:[],projects:[]}),project:()=>null},emit:()=>{},hooks:{},
    async invoke(command:string){if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];
      if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const values=new Map<string,string>();
  const secrets={status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set:(id:string,v:string)=>{values.set(id,v);},delete:(id:string)=>{values.delete(id);}};
  const timers={setTimeout:((fn:()=>void,ms:number)=>0) as unknown as typeof setTimeout,clearTimeout:(()=>{}) as unknown as typeof clearTimeout};
  const domain=createPaperclipDomain(context,{fetch:srv.fetch as never,secrets:()=>secrets as never,timers:timers as never,socket:()=>{throw new Error('no socket');},remoteOf:async()=>undefined});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  await call('paperclip.config.set',{mode:'local',companyId:C});
  return {srv,call};
}

// B3 — the identity/shape mismatch: an issue's run row and a heartbeat run row describe the same run in different fields.
test('B3: a task’s run row maps to the same run id and task as the global heartbeat row',()=>{
  const fromTask=mapRun(issueRun(R_NEW,T2,10) as never),fromGlobal=mapRun(heartbeat(R_NEW,T2,10) as never);
  assert.equal(fromTask.id,R_NEW,'/issues/:id/runs carries `runId`, not `id`');
  assert.equal(fromTask.id,fromGlobal.id);assert.equal(fromTask.taskId,T2,'the task is `contextIssueId` there, not contextSnapshot.issueId');assert.equal(fromTask.taskId,fromGlobal.taskId);
  assert.equal(mapReceipt(issueRun(R_NEW,T2,10) as never,new Map()).runId,R_NEW);
});

test('B3: a task’s runs are the snapshot’s runs, and a run the snapshot no longer lists is fetched by id',async t=>{
  const h=await harness(t);
  const snap=await h.call('paperclip.snapshot'),detail=await h.call('paperclip.task',{id:T2});
  const listed=new Set(snap.runs.map((r:any)=>r.id));
  assert.ok(detail.runs.length===2&&detail.runs.every((r:any)=>r.id&&r.id!=='undefined'),`task runs have real ids: ${detail.runs.map((r:any)=>r.id)}`);
  assert.ok(listed.has(detail.runs[0].id),'the task’s newest run is the one the global list opens');
  assert.ok(!listed.has(R_OLD),'the older run is outside the snapshot’s recent list');
  const view=await h.call('paperclip.run',{id:R_OLD});
  assert.equal(view.missing,false);assert.equal(view.run.id,R_OLD);assert.equal(view.run.taskId,T2);assert.ok(h.srv.calls.some(c=>c==='/api/heartbeat-runs/'+R_OLD),'fetched by id from the server');
  const gone=await h.call('paperclip.run',{id:R_GONE});
  assert.equal(gone.missing,true,'only the server’s 404 means missing');assert.equal(gone.run,null);
  h.srv.fail.add('/api/heartbeat-runs/'+R_P1);
  const listedRun=await h.call('paperclip.run',{id:R_NEW});assert.equal(listedRun.missing,false);
  h.srv.fail.add('/api/heartbeat-runs/'+R_OLD);
  await assert.rejects(()=>h.call('paperclip.run',{id:R_OLD}),/500/,'a server error is an error, never "missing"');
});

// B6 — tool use from the run's own log; "not fetched" is not "none recorded".
test('B6: a server run’s tools come from its log, the receipt is matched by run id, and unread tools say so',async t=>{
  const h=await harness(t);
  const view=await h.call('paperclip.run',{id:R_OLD});
  assert.deepEqual(view.receipt.tools,[{name:'Bash',count:2},{name:'Read',count:1}]);assert.equal(view.receipt.tests,1);assert.equal(view.receipt.toolsState,undefined);assert.equal(view.receipt.runId,R_OLD);
  assert.match(view.links.run,new RegExp(`/BOR/agents/${AGENT}/runs/${R_OLD}$`));assert.match(view.links.task,/\/BOR\/issues\/BOR-2$/);
  const none=await h.call('paperclip.run',{id:R_NEW});
  assert.deepEqual(none.receipt.tools,[]);assert.equal(none.receipt.toolsState,undefined,'the log was read and had no tool calls: none recorded');
  const unread=await h.call('paperclip.run',{id:R_P1});
  assert.deepEqual(unread.receipt.tools,[]);assert.equal(unread.receipt.toolsState,'unfetched','the log could not be read: not fetched');
  const ledger=await h.call('paperclip.ledger',{limit:50});
  const remote=ledger.entries.filter((e:any)=>e.source==='paperclip');
  assert.ok(remote.length>=3&&remote.every((e:any)=>e.toolsState==='unfetched'),'list receipts carry no tool data: not fetched');
});

test('B6: tool calls are counted from Claude stream-json and Codex --json logs; anything else is none',()=>{
  assert.deepEqual(toolsFromLog(CLAUDE_LOG),{tools:[{name:'Bash',count:2},{name:'Read',count:1}],tests:1});
  const codex=logOf({type:'thread.started'},{type:'item.started',item:{type:'command_execution',command:'ls'}},{type:'item.completed',item:{type:'command_execution',command:'pnpm test'}},{type:'item.completed',item:{type:'mcp_tool_call',server:'gh',tool:'pr'}},{type:'item.completed',item:{type:'agent_message',text:'x'}});
  assert.deepEqual(toolsFromLog(codex),{tools:[{name:'gh.pr',count:1},{name:'Shell command',count:1}],tests:1});
  assert.deepEqual(toolsFromLog('{"stream":"stdout","chunk":"hello\\n"}\nnot json'),{tools:[],tests:0});
});

// B2 — costs of a server project come from the server; the local project store is never asked.
test('B2: a connected project’s costs are built from the server’s run records, for that project only',async t=>{
  const h=await harness(t);
  const view=await h.call('paperclip.costs',{projectId:P1,days:30});
  assert.equal(view.note,null);assert.ok(view.report,'a report, not "that project no longer exists"');
  assert.equal(view.report.entries,2,'BOR-1 has no project: its run is not this project’s');
  assert.equal(view.report.totals.inputTokens,2000);assert.equal(view.report.totals.outputTokens,400);
  assert.equal(view.report.totals.costUsd,0.02);assert.equal(view.report.totals.unpricedTurns,1,'a run the server reported no cost for is unpriced, not $0');
  assert.deepEqual(view.report.byAgent.map((b:any)=>b.label),['Atlas']);
  const unknown=await h.call('paperclip.costs',{projectId:'00000000-0000-4000-8000-0000000000aa'});
  assert.equal(unknown.report,null);assert.doesNotMatch(unknown.note,/no longer exists|deleted/i);
});

test('B2: with no server connected the costs say so honestly',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'off'});
  const view=await h.call('paperclip.costs',{projectId:P1});
  assert.equal(view.report,null);assert.match(view.note,/Costs for server projects come from the server; not available here yet/);
});

test('B2: receipts group into the costs report the Ledger builds (priced, unpriced, per day)',()=>{
  const e=(cost:number|null,tokens:number|null)=>({projectId:'p',agent:'A',provider:'x',model:'m',tokens:tokens===null?null:{input:tokens,cached:0,output:1,reasoning:0},costUsd:cost,endedAt:new Date().toISOString(),outcome:'succeeded'});
  const report=buildCosts(groupsFromReceipts([e(0.1,100),e(null,50),e(null,null)],0),{days:7,offsetMin:0,now:Date.now(),projectNames:new Map([['p','P']]),windows:[],ledgerSince:null});
  assert.equal(report.entries,3);assert.equal(report.totals.costUsd,0.1);assert.equal(report.totals.unpricedTurns,2);assert.equal(report.totals.inputTokens,150);
});

// B4 — the server's activity feed is company-wide; its rows must say which project they belong to.
test('B4: audit rows carry their task and project so a project’s Activity can show only its own',async t=>{
  const rows=mapRows('audit',[{id:'a',action:'issue.updated',entityType:'issue',entityId:T2,actorType:'agent',actorId:'x',createdAt:stamp(1),details:{}}]);
  assert.equal(rows[0]!.taskId,T2);
  const h=await harness(t);await h.call('paperclip.snapshot');
  const list=await h.call('paperclip.list',{kind:'audit'});
  const by=(id:string)=>list.rows.find((r:any)=>r.id===id);
  assert.equal(by('ev-1').projectId,P1,'an event on BOR-2 belongs to BOR-2’s project');
  assert.equal(by('ev-2').projectId??null,null,'an event for BOR-1 (no project) belongs to no project');
  assert.equal(by('ev-3').projectId??null,null,'an invite is organisation-wide');
  assert.equal(by('ev-4').projectId,P1,'a project event is its project’s');
});
