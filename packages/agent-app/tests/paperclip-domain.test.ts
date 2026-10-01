/** Projects workspace domain (#115): Paperclip mapping, auth, ETag reuse, the live channel's cost rules, writes, the local
 *  source over Muster's own Projects, "Create your own" organisations and memory recall. Paperclip is faked; nothing
 *  here talks to a real server. */
import assert from 'node:assert/strict';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createPaperclipDomain,isLoopback,rankMemories,PAPERCLIP_SECRET_ID} from '../src/runtime/domains/paperclip.ts';
import {normalizeBaseUrl} from '../src/runtime/paperclip-client.ts';
import {SqliteImportStore} from '../src/runtime/paperclip-import.ts';
import {buildInbox,mapAttention,mapInteraction,mapIssue,mapRoutine} from '../src/runtime/paperclip-map.ts';
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
    [`/api/companies/${COMPANY}/goals`]:()=>[],[`/api/companies/${COMPANY}/approvals`]:()=>[],[`/api/companies/${COMPANY}/labels`]:()=>[],[`/api/companies/${COMPANY}/heartbeat-runs`]:()=>runs,[`/api/companies/${COMPANY}/live-runs`]:()=>[],
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

async function harness(t:TestContext,options:{socket?:SocketFactory;invoke?:(command:string,input:any)=>unknown;folders?:{id:string;name:string;path:string}[];fetch?:(input:string,init?:RequestInit)=>Promise<Response>}={}){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-paperclip-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const server=paperclip(),secrets=secretsFake(),timers=fakeTimers(),events:any[]=[],invoked:{command:string;input:any}[]=[];
  const {DatabaseSync}=await import('node:sqlite');const memory=new DatabaseSync(':memory:');t.after(()=>memory.close());
  const context={dataDir,db:()=>memory,store:{snapshot:()=>({folders:options.folders??[]})},emit:(e:unknown)=>events.push(e),hooks:{},
    async invoke(command:string,input:any){invoked.push({command,input});if(options.invoke){const r=options.invoke(command,input);if(r!==undefined)return r;}
      if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};if(command==='project.list')return [];
      if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const domain=createPaperclipDomain(context,{fetch:(options.fetch??server.fetch) as never,secrets:()=>secrets.store as never,timers,socket:options.socket??(()=>{throw new Error('no socket');}),remoteOf:async path=>path.endsWith('oss')?'git@github.com:hybrowlabs/OSS-Manager.git':undefined});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  return {dataDir,server,secrets,timers,events,invoked,call,memory};
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

test('the stored token is sent only to the origin it was saved for; a new origin or This Mac never gets it',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://pc.example.com',token:'pcp_board_abc'});
  const auth=async(input:Record<string,unknown>)=>{const from=h.server.calls.length;await h.call('paperclip.test',input);return h.server.calls.slice(from).map(c=>c.headers.authorization??'none');};
  assert.deepEqual([...new Set(await auth({mode:'custom',baseUrl:'https://pc.example.com/api'}))],['Bearer pcp_board_abc'],'same origin, another path: the stored token');
  assert.deepEqual([...new Set(await auth({mode:'custom',baseUrl:'https://other.example.net'}))],['none'],'Test connection on another host never sends the stored token');
  assert.deepEqual([...new Set(await auth({mode:'custom',baseUrl:'http://pc.example.com'}))],['none'],'another scheme is another origin');
  assert.deepEqual([...new Set(await auth({mode:'custom',baseUrl:'https://other.example.net',token:'pcp_typed'}))],['Bearer pcp_typed'],'a token typed for the test is used as given');
  const moved=await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://other.example.net'});
  assert.equal(moved.hasToken,false);assert.equal(h.secrets.values.has(PAPERCLIP_SECRET_ID),false,'changing the origin without a new token forgets the old one');
  assert.match(await readFile(join(h.dataDir,'paperclip.json'),'utf8'),/"tokenOrigin": null/);
  const kept=await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://other.example.net',token:'pcp_new'});
  assert.equal(kept.hasToken,true);
  assert.equal((await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://other.example.net/'})).hasToken,true,'same origin: the token stays');
  assert.match(await readFile(join(h.dataDir,'paperclip.json'),'utf8'),/"tokenOrigin": "https:\/\/other.example.net"/);
  h.secrets.values.clear();
  const local=await h.call('paperclip.config.set',{mode:'local',token:'pcp_ignored'});
  assert.equal(local.hasToken,false);assert.equal(h.secrets.values.size,0,'This Mac never stores a token');
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
  assert.equal(snap.inbox.find((i:any)=>i.id==='att-1').why,'An agent is waiting for your answer in the thread.','Paperclip’s whyNow is replaced by Muster’s words for its kind');
  assert.ok(snap.inbox.every((i:any)=>!/board/i.test(i.why)),'no Paperclip board vocabulary in the Inbox');
  const before=h.server.calls.length;
  const again=await h.call('paperclip.snapshot');
  assert.deepEqual(again.tasks,snap.tasks,'nothing changed, nothing rebuilt');
  assert.ok(h.server.calls.slice(before).filter(c=>c.url!=='/api/companies').every(c=>c.headers['if-none-match']),'every refresh is conditional');
});

test('an unreachable Paperclip says whether a last copy is shown; a fresh profile has none',async t=>{
  let down=true;const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>{if(down)throw new TypeError('fetch failed');return server.fetch(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  const fresh=await h.call('paperclip.snapshot');
  assert.ok(fresh.paperclip.stale);assert.equal(fresh.paperclip.cached,false,'nothing was ever read');
  down=false;await h.call('paperclip.snapshot');
  down=true;const later=await h.call('paperclip.snapshot',{refresh:true});
  assert.ok(later.paperclip.stale);assert.equal(later.paperclip.cached,true,'the last good copy is shown');
  assert.ok(later.tasks.some((x:any)=>x.source==='paperclip'));
});

test('the thread renders comments (deleted ones hidden) and the composer addresses the assignee; writes hit the documented endpoints',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  const detail=await h.call('paperclip.task',{id:'RAG-12'});
  assert.equal(detail.comments.length,2);assert.equal(detail.comments[0].author.label,'CTO');assert.equal(detail.comments[1].author.label,'You');
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

test('Resume all wakes only the Paperclip agents Pause all paused, never one you had paused on purpose',async t=>{
  const saved=agents.map(a=>({...a}));t.after(()=>{agents.forEach((a,i)=>Object.assign(a,saved[i]));});
  const server=paperclip();
  // Paperclip's agents really change status on pause/resume, and its ETags move with them.
  const fetch=async(input:string,init:RequestInit={})=>{
    const m=/\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(new URL(input).pathname);
    if(m&&init.method==='POST'){const a=agents.find(x=>x.id===m[1]);if(a)a.status=m[2]==='pause'?'paused':'idle';server.bump();}
    return server.fetch(input,init);
  };
  const h=await harness(t,{fetch});
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  assert.equal(agents.find(a=>a.id==='a-old')!.status,'paused','Old was paused before Pause all');
  assert.deepEqual(await h.call('paperclip.pauseAll',{source:'paperclip'}),{changed:3});
  assert.ok(agents.every(a=>a.status==='paused'));
  assert.deepEqual(await h.call('paperclip.resumeAll',{source:'paperclip'}),{changed:3});
  const resumed=server.calls.filter(c=>c.method==='POST'&&c.url.endsWith('/resume')).map(c=>c.url);
  assert.deepEqual(resumed.sort(),['/api/agents/a-ceo/resume','/api/agents/a-cto/resume','/api/agents/a-qa/resume']);
  assert.equal(agents.find(a=>a.id==='a-old')!.status,'paused','the agent paused on purpose stays paused');
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
  assert.deepEqual([...h.timers.live.values()].map(x=>x.ms).sort((a,b)=>a-b),[1000,2400],'two events: one pending emit, and one settle read for Paperclip’s 2 s list cache');
  await h.timers.fire();
  assert.equal(h.events.length,1);
  assert.deepEqual(h.events[0].taskIds.sort(),['i-12','i-4']);
  await h.timers.fire();
  assert.deepEqual(h.events[1].scopes.sort(),['inbox','tasks'],'then the settle re-read tells the screens once more');
  h.events.length=0;h.timers.live.clear();
  sockets[0].onclose();
  assert.deepEqual([...h.timers.live.values()].map(x=>x.ms).sort((a,b)=>a-b),[1000,15000],'socket down while visible: tell the screens, and fall back to a poll');
  const poll=[...h.timers.live.entries()].find(([,x])=>x.ms===15000)!;h.timers.live.delete(poll[0]);
  await h.timers.fire();
  assert.deepEqual(h.events.map(e=>e.scopes),[['config']],'the socket dropping is announced at once');
});

test('going offline and coming back are announced at once, without a reload (S8)',async t=>{
  let down=false;const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>{if(down)throw new TypeError('fetch failed');return server.fetch(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  await h.timers.fire();h.events.length=0;
  down=true;
  assert.ok((await h.call('paperclip.snapshot',{refresh:true})).paperclip.stale);
  await h.timers.fire();
  assert.equal(h.events.length,1,'ok → stale emits');assert.ok(h.events[0].scopes.includes('config'));
  await h.call('paperclip.snapshot',{refresh:true});
  await h.timers.fire();
  assert.equal(h.events.length,1,'still offline: nothing new to say');
  down=false;
  assert.equal((await h.call('paperclip.snapshot',{refresh:true})).paperclip.stale,undefined);
  await h.timers.fire();
  assert.equal(h.events.length,2,'stale → ok emits');assert.ok(h.events[1].scopes.includes('config'));
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
  const task=(id:string,state:string,extra:object={})=>({id,projectId:'p1',title:`Task ${id}`,status:'todo',state,dependencies:[],acceptance:'Done when green',evidence:[],revision:3,createdAt:`2026-09-2${id}T00:00:00.000Z`,updatedAt:now,owner:{kind:'agent',id:'m1'},priority:1,artifacts:['docs/plan.md'],attempts:[],verification:null,permissionMode:null,budgetMinutes:null,blockedBy:null,ready:false,verificationStale:false,waitingChatId:null,...extra});
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
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'2',status:'done'}),/Move it to In Review first/);
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

test('turn ledger: a fresh database has the baselines table, and a files error never drops the Receipt (S42)',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {TurnLedger,attachTurnLedger}=await import('../src/runtime/turn-ledger.ts');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const ledger=new TurnLedger(db),appended:any[]=[],hooks:any={};
  assert.ok(db.prepare("SELECT name FROM sqlite_master WHERE name='review_baselines'").get(),'created with the ledger, before any capture');
  const context={db:()=>db,hooks:{onRunStarted:(fn:any)=>{hooks.start=fn;return()=>{};},onRunSettled:(fn:any)=>{hooks.settle=fn;return()=>{};},onProviderEvent:(fn:any)=>{hooks.event=fn;return()=>{};}}} as unknown as DomainContext;
  const off=attachTurnLedger(context,()=>ledger,e=>appended.push(e));t.after(off);
  // A 0 ms project turn with no baseline captured yet: the Receipt is kept, with no file list.
  await hooks.start({chat:{id:'c1',title:'Run',projectId:'p1'},runId:'r0',cwd:'/nonexistent'});
  await hooks.settle({chat:{id:'c1',title:'Run',projectId:'p1'},runId:'r0',status:'completed'});
  // Even if the table is gone, the entry is still written.
  db.exec('DROP TABLE review_baselines');
  await hooks.start({chat:{id:'c1',title:'Run',projectId:'p1'},runId:'r1',cwd:'/nonexistent'});
  await hooks.settle({chat:{id:'c1',title:'Run',projectId:'p1'},runId:'r1',status:'completed'});
  assert.deepEqual(appended.map(e=>`${e.runId}:${e.files}`),['r0:null','r1:null']);
  assert.equal(ledger.verify().entries,2);
});

test('turn ledger: only project and task runs diff the tree; everyday chats pay nothing new',async t=>{
  const {DatabaseSync}=await import('node:sqlite');
  const {TurnLedger,attachTurnLedger}=await import('../src/runtime/turn-ledger.ts');
  const {snapshotTree}=await import('../src/runtime/review-baseline.ts');
  const {mkdtemp,writeFile,rm}=await import('node:fs/promises');const {execFileSync}=await import('node:child_process');
  const repo=await mkdtemp(join(tmpdir(),'muster-ledger-'));t.after(()=>rm(repo,{recursive:true,force:true}));
  execFileSync('git',['init','-q'],{cwd:repo});await writeFile(join(repo,'a.txt'),'one\n');
  const db=new DatabaseSync(':memory:');t.after(()=>db.close());
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
  const items=buildActivity({chats:[chat('a','running'),chat('b','failed',{error:'Rate limited',unread:true}),chat('c','completed',{unread:true}),chat('d','idle'),chat('e','waiting',{unread:true})] as any,folders:[],projects:[],attention:{totalRequests:1,chats:[{chatId:'a',chatTitle:'Chat a',approvalCount:1,questionCount:0,requests:[{itemId:'x',kind:'approval',createdAt:now,sourceLabel:'Provider approval'}]}]}},
    {inbox:[{id:'m',kind:'mail',title:'Builder: Which DB?',why:'Sent you a message.',severity:'low',at:now,taskId:null,agentId:null,runId:null,group:'Launch',source:'local'},{id:'r',kind:'review',title:'X-1',why:'Review',severity:'medium',at:now,taskId:'t',agentId:null,runId:null,group:'Launch',source:'paperclip'}]} as any);
  const by=Object.fromEntries(items.map(i=>[i.id,i.bucket]));
  assert.deepEqual(by,{'chat-needs:a':'needs','chat-problem:b':'problems','chat-done:c':'done','chat-needs:e':'needs','ws:m':'mentions','ws:r':'review'});
  assert.equal(badgeCount(items),3);
  assert.equal(items.find(i=>i.id==='chat-problem:b')!.why,'Rate limited');
});

test('a project task’s run chat is counted once: the task row stands for it in the Inbox and the badge',async t=>{
  const {buildActivity,badgeCount}=await import('../src/renderer/inboxModel.ts');
  const chat=(id:string,status:string)=>({id,title:`Chat ${id}`,status,archived:false,updatedAt:now,pinned:false,draft:'',model:'m',mode:'agent',unread:true});
  const app={chats:[chat('run1','failed'),chat('solo','failed')],folders:[],projects:[],attention:{totalRequests:0,chats:[]}} as any;
  const failedTask={id:'task:t1',kind:'failed_run',title:'LP-1 · Build',why:'tests failed',severity:'medium',at:now,taskId:'t1',agentId:null,runId:'at1',group:'Launch',source:'local',chatIds:['run1']};
  const items=buildActivity(app,{inbox:[failedTask]} as any);
  assert.deepEqual(items.map(i=>i.id).sort(),['chat-problem:solo','ws:task:t1']);
  assert.equal(badgeCount(items),2);
  // The sidebar has no workspace snapshot: it leaves out the chats the badge already counted.
  assert.equal(badgeCount(buildActivity(app,null,Date.now(),['run1'])),1);
  // The runtime badge reports those chats.
  const task=(id:string,state:string,extra:object={})=>({id,projectId:'p1',title:`Task ${id}`,status:'todo',state,dependencies:[],acceptance:'',evidence:[],revision:1,createdAt:now,updatedAt:now,owner:{kind:'agent',id:'agent'},priority:2,artifacts:[],attempts:[],verification:null,permissionMode:null,budgetMinutes:null,blockedBy:null,ready:false,verificationStale:false,waitingChatId:null,...extra});
  const h=await harness(t,{invoke:command=>{
    if(command==='project.list')return [{id:'p1',name:'Launch',goal:'Ship',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null}];
    if(command==='project.work')return {tasks:{items:[task('1','failed',{attempts:[{id:'at1',chatId:'run1',runId:'r',trigger:'user',startedAt:now,endedAt:now,status:'failed',contextVersion:1}]})],truncated:false},decisions:{items:[]},activity:{items:[]},scheduler:{paused:false}};
    if(command==='project.members.list')return {members:[]};
  }});
  const badge=await h.call('paperclip.badge');
  assert.equal(badge.inbox,1);assert.deepEqual(badge.chatIds,['run1']);
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
  // S34: once RAG-4 is imported, its Muster copy stands for it; the linked Paperclip rows are not listed or badged again.
  new SqliteImportStore(h.memory as never).setMap('task','i-4','lt1','RAG-4',{});
  const after=await h.call('paperclip.snapshot');
  assert.deepEqual(after.inbox.filter((i:any)=>i.source==='paperclip'&&i.taskId==='i-4'),[],'no duplicate rows for an imported task');
  assert.equal((await h.call('paperclip.badge')).inbox,2,'the blocked row and the failed run on RAG-4 no longer count twice');
});

test('the Inbox badge is a light read: it never browses project memory; the full snapshot still counts it',async t=>{
  const h=await harness(t,{folders:[{id:'f1',name:'launch',path:'/work/launch'}],invoke:command=>{
    if(command==='project.list')return [{id:'p1',name:'Launch',goal:'Ship',folderIds:['f1'],primaryFolderId:'f1',archived:false,archivedAt:null}];
    if(command==='project.work')return {tasks:{items:[],truncated:false},decisions:{items:[]},activity:{items:[]},scheduler:{paused:false}};
    if(command==='project.members.list')return {members:[]};
  }});
  await h.call('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const badge=await h.call('paperclip.badge');
  assert.equal(badge.connected,true);
  assert.equal(h.invoked.filter(c=>c.command==='memory.browse').length,0,'no memory.browse for the badge');
  const snap=await h.call('paperclip.snapshot');
  assert.ok(h.invoked.some(c=>c.command==='memory.browse'),'the full snapshot counts each project’s memories');
  assert.deepEqual(snap.projects.find((p:any)=>p.id==='p1').memory,{label:'launch',count:0});
});

test('a Paperclip confirmation is answered from Muster: accept, or reject with a reason',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  await h.call('paperclip.interaction.respond',{taskId:'RAG-1',interactionId:'int-1',accept:true});
  await h.call('paperclip.interaction.respond',{taskId:'RAG-1',interactionId:'int-2',accept:false,reason:'Keep the old flow'});
  assert.deepEqual(h.server.calls.filter(c=>c.method==='POST').map(c=>`${c.url} ${JSON.stringify(c.body)}`),['/api/issues/RAG-1/interactions/int-1/accept {}','/api/issues/RAG-1/interactions/int-2/reject {"reason":"Keep the old flow"}']);
});

test('the linked view reads Paperclip blockers from blockedBy[].id and asks for them (S22)',async t=>{
  const issue={id:'i-5',identifier:'RAG-5',title:'x',status:'blocked',blockedBy:[{id:'i-4',identifier:'RAG-4',title:'Docs',status:'blocked'},{id:'i-3'}]};
  assert.deepEqual(mapIssue(issue as any,new Map(),new Set()).blockedByIds,['i-4','i-3']);
  assert.deepEqual(mapIssue({...issue,blockedBy:undefined,blockedByIssueIds:['i-9']} as any,new Map(),new Set()).blockedByIds,['i-9'],'older payloads still work');
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  assert.ok(h.server.calls.some(c=>/\/issues\?.*includeBlockedBy=true/.test(c.url)),'the snapshot asks Paperclip for blockers');
});

test('a Custom URL on loopback is a Paperclip on this Mac (its folders are linked on import); other hosts are remote (S79)',()=>{
  for(const url of ['http://127.0.0.1:3101','http://localhost:3100','http://[::1]:3100','http://127.1.2.3'])assert.equal(isLoopback(url),true,url);
  for(const url of ['https://pc.example.com','http://10.0.0.5:3100','http://localhost.evil.com','not a url'])assert.equal(isLoopback(url),false,url);
});

test('a Paperclip question set (ask_user_questions) is answerable in place through its respond endpoint (S13)',async t=>{
  const pending={id:'int-q',kind:'ask_user_questions',status:'pending',createdAt:now,createdByAgentId:'a-cto',payload:{version:1,submitLabel:'Send',questions:[
    {id:'scope',prompt:'Which scope?',selectionMode:'single',allowOther:true,options:[{id:'mig',label:'Migration only'},{id:'all',label:'Everything'}]},
    {id:'envs',prompt:'Which environments?',selectionMode:'multi',options:[{id:'dev',label:'Dev'},{id:'prod',label:'Prod'}]}]}};
  const card=mapInteraction(pending as any,new Map([['a-cto',{name:'CTO'} as any]])) as any;
  assert.equal(card.interactionId,'int-q','answerable, not display-only');
  assert.equal(card.from,'CTO');assert.equal(card.submitLabel,'Send');
  assert.deepEqual(card.questions.map((q:any)=>`${q.id}:${q.multi}:${q.allowOther}:${q.options.map((o:any)=>o.id).join('/')}`),['scope:false:true:mig/all','envs:true:false:dev/prod']);
  assert.equal((mapInteraction({...pending,status:'answered'} as any,new Map()) as any).questions,undefined,'an answered set is history');
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  assert.equal(h.server.calls.filter(c=>c.method!=='GET').length,0,'nothing is written until you answer');
  await h.call('paperclip.interaction.respond',{taskId:'RAG-12',interactionId:'int-q',accept:true,answers:[{questionId:'scope',optionIds:[],otherText:'Only the wizard'},{questionId:'envs',optionIds:['dev','prod']}]});
  assert.deepEqual(h.server.calls.filter(c=>c.method==='POST').map(c=>`${c.url} ${JSON.stringify(c.body)}`),['/api/issues/RAG-12/interactions/int-q/respond {"answers":[{"questionId":"scope","optionIds":[],"otherText":"Only the wizard"},{"questionId":"envs","optionIds":["dev","prod"]}]}']);
  await assert.rejects(()=>h.call('paperclip.interaction.respond',{taskId:'RAG-12',interactionId:'int-q',accept:true,answers:[{questionId:'scope',optionIds:[]}]}),/Answer every question/);
});

test('inbox dismissals persist by item id and time; a dismissed Paperclip or project item leaves the runtime badge until it changes',async t=>{
  const h=await harness(t);
  assert.deepEqual(await h.call('paperclip.inbox.dismissed'),{items:[]});
  assert.deepEqual(await h.call('paperclip.inbox.dismiss',{id:'chat-problem:c1',at:'2026-09-24T10:00:00.000Z'}),{ok:true});
  await h.call('paperclip.inbox.dismiss',{id:'chat-problem:c1',at:'2026-09-25T10:00:00.000Z'});
  assert.deepEqual((await h.call('paperclip.inbox.dismissed')).items,[{id:'chat-problem:c1',at:'2026-09-25T10:00:00.000Z'}],'one row per item: the latest time wins');
  await assert.rejects(async()=>h.call('paperclip.inbox.dismiss',{id:'bad id with spaces',at:now}),/Unknown item/);
  await assert.rejects(async()=>h.call('paperclip.inbox.dismiss',{id:'x'}),/Unknown item/);
  await h.call('paperclip.config.set',{mode:'custom',baseUrl:'https://pc.example.com/',token:'pcp_board_abc',companyId:COMPANY});
  const snap=await h.call('paperclip.snapshot');
  const urgent=snap.inbox.find((i:any)=>['question','approval','blocked','failed_run','agent_error','budget'].includes(i.kind));
  assert.ok(urgent,'the fake Paperclip has an urgent item');
  const before=(await h.call('paperclip.badge')).inbox;
  await h.call('paperclip.inbox.dismiss',{id:`ws:${urgent.id}`,at:urgent.at});
  assert.equal((await h.call('paperclip.badge')).inbox,before-1,'dismissed: off the badge');
  await h.call('paperclip.inbox.dismiss',{id:`ws:${urgent.id}`,at:'1999-01-01T00:00:00.000Z'});
  assert.equal((await h.call('paperclip.badge')).inbox,before,'a different time is a new item: it counts again');
});

test('the Ledger imports history in the background after the first badge read, and on demand; the chain still verifies',async t=>{
  const h=await harness(t);
  await h.call('paperclip.badge');
  assert.ok([...h.timers.live.values()].some(x=>x.ms===0),'the import waits for a later tick, off the startup path');
  await h.timers.fire();
  const result=await h.call('paperclip.ledger.backfill');
  assert.deepEqual(result,{chats:0,turns:0},'no chat tables in this bare database: nothing to import, nothing fails');
  const view=await h.call('paperclip.ledger',{limit:10});
  assert.deepEqual(view.chain,{ok:true,entries:0,head:'0'.repeat(64),brokenAt:null});
});

test('A3: a URL that answers with a web page is reported as "not a Paperclip API", never a JSON parse error',async t=>{
  const html=async()=>new Response('<!DOCTYPE html><html><body>Welcome to nginx</body></html>',{status:200,headers:{'content-type':'text/html'}});
  const h=await harness(t,{fetch:html});
  const result=await h.call('paperclip.test',{mode:'custom',baseUrl:'https://pc.example.com/nope'});
  assert.equal(result.ok,false);assert.equal(result.stage,'service');
  assert.match(result.message,/isn’t a Paperclip API/);assert.doesNotMatch(result.message,/Unexpected token|<!DOCTYPE|is not valid/);
  const notFound=await harness(t,{fetch:async()=>new Response('<html>404</html>',{status:404})});
  const missing=await notFound.call('paperclip.test',{mode:'custom',baseUrl:'https://pc.example.com'});
  assert.match(missing.message,/answered 404/);assert.doesNotMatch(missing.message,/<html/);
});

test('A4: a token that would travel over plain http to another machine is warned about; https and loopback are not',async t=>{
  const h=await harness(t);
  const plain=await h.call('paperclip.test',{mode:'custom',baseUrl:'http://paperclip.example.com',token:'pcp_x'});
  assert.match(plain.warning,/plain http/);assert.match(plain.warning,/Your API token/);
  assert.equal((await h.call('paperclip.test',{mode:'custom',baseUrl:'https://paperclip.example.com',token:'pcp_x'})).warning,undefined);
  for(const url of ['http://127.0.0.1:3100','http://localhost:3100','http://[::1]:3100'])assert.equal((await h.call('paperclip.test',{mode:'custom',baseUrl:url,token:'pcp_x'})).warning,undefined,url);
  assert.equal((await h.call('paperclip.test',{mode:'local'})).warning,undefined);
});

test('D4/D5: priority and assignee changes are forwarded to Paperclip as exactly the fields you changed (user-initiated)',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.task.update',{taskId:'RAG-12',priority:'low'});
  await h.call('paperclip.task.update',{taskId:'RAG-12',assigneeId:'a-qa'});
  await h.call('paperclip.task.update',{taskId:'RAG-12',assigneeId:null});
  await h.call('paperclip.task.update',{taskId:'RAG-12',assigneeId:'user:local',status:'todo',priority:'critical'});
  assert.deepEqual(h.server.calls.filter(c=>c.method!=='GET').map(c=>`${c.method} ${c.url} ${JSON.stringify(c.body)}`),[
    'PATCH /api/issues/RAG-12 {"priority":"low"}','PATCH /api/issues/RAG-12 {"assigneeAgentId":"a-qa"}','PATCH /api/issues/RAG-12 {"assigneeAgentId":null}',
    'PATCH /api/issues/RAG-12 {"status":"todo","priority":"critical","assigneeAgentId":null}',
  ]);
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'RAG-12',priority:'urgent'}),/Unknown priority/);
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'RAG-12',assigneeId:'../x'}),/Unknown item/);
  await assert.rejects(()=>h.call('paperclip.task.update',{taskId:'RAG-12'}),/Nothing to change/);
});

test('F: a reply that is cut off or not JSON becomes a plain sentence, and the last good copy stays',async t=>{
  let broken=false;
  const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>{if(broken&&new URL(input).pathname.endsWith('/issues'))return new Response('[{\"id\":\"i-1\",',{status:200});return server.fetch(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  assert.ok((await h.call('paperclip.snapshot')).tasks.length>0);
  broken=true;h.server.bump();
  const snap=await h.call('paperclip.snapshot',{refresh:true});
  assert.match(snap.paperclip.stale,/could not read/);assert.doesNotMatch(snap.paperclip.stale,/Unexpected|JSON input/);
  assert.equal(snap.paperclip.cached,true);assert.ok(snap.tasks.length>0,'the last good copy stays');
});

test('D16: a task created in a Paperclip project carries its labels, goal and blockers; priority, parent and owner as before',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local'});
  await h.call('paperclip.snapshot');
  await h.call('paperclip.task.create',{title:'New',description:'d',projectId:'p-oss',assigneeId:'a-cto',priority:'high',parentId:'i-11',labelIds:['l-bug','l-bug','l-infra'],goalId:'g-1',blockedByIds:['i-4']});
  const post=h.server.calls.find(c=>c.method==='POST'&&/\/issues$/.test(c.url))!;
  assert.deepEqual(post.body,{title:'New',status:'todo',description:'d',projectId:'p-oss',priority:'high',parentId:'i-11',assigneeAgentId:'a-cto',labelIds:['l-bug','l-infra'],goalId:'g-1',blockedByIssueIds:['i-4']});
  await assert.rejects(()=>h.call('paperclip.task.create',{title:'x',description:'',projectId:'p-oss',assigneeId:null,labelIds:['../x']}),/Unknown item/);
});

const approvalRows=[{id:'ap-hire',type:'hire_agent',status:'pending',requestedByAgentId:'a-cto',payload:{name:'Nova',title:'Data Engineer',role:'engineer',agentId:'a-nova',adapterType:'process'},createdAt:now},
  {id:'ap-strategy',type:'approve_ceo_strategy',status:'pending',requestedByUserId:'local-board',payload:{title:'FY strategy',plan:'Prioritize uptime'},createdAt:now},{id:'ap-old',type:'hire_agent',status:'approved',payload:{name:'Old'},createdAt:now}];
function withApprovals(){const server=paperclip();return async(input:string,init:RequestInit={})=>{const url=new URL(input);if(url.pathname===`/api/companies/${COMPANY}/approvals`)return new Response(JSON.stringify(approvalRows),{status:200,headers:{'content-type':'application/json'}});
  if(init.method==='POST'&&/^\/api\/approvals\//.test(url.pathname))return new Response(JSON.stringify({ok:true}),{status:200});
  return server.fetch(input,init);};}

test('D9: pending approvals are in the snapshot and decided only by you, through Paperclip’s approval endpoints',async t=>{
  const calls:{method:string;url:string;body?:unknown}[]=[];const base=withApprovals();
  const h=await harness(t,{fetch:async(input,init)=>{calls.push({method:init?.method??'GET',url:new URL(input).pathname,body:init?.body?JSON.parse(String(init.body)):undefined});return base(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  const snap=await h.call('paperclip.snapshot');
  assert.deepEqual(snap.approvals.map((a:any)=>[a.id,a.title,a.requestedBy]),[['ap-hire','Hire Nova as Data Engineer','CTO'],['ap-strategy','FY strategy','You']],'only the pending ones, with their requester');
  assert.equal(calls.filter(c=>c.method==='POST').length,0,'nothing is decided by reading');
  await h.call('paperclip.approval.decide',{id:'ap-hire',decision:'approve'});
  await h.call('paperclip.approval.decide',{id:'ap-strategy',decision:'reject',note:'Not now'});
  await h.call('paperclip.approval.decide',{id:'ap-strategy',decision:'request_revision',note:'Add a budget'});
  assert.deepEqual(calls.filter(c=>c.method==='POST').map(c=>`${c.url} ${JSON.stringify(c.body)}`),['/api/approvals/ap-hire/approve {"decisionNote":null}','/api/approvals/ap-strategy/reject {"decisionNote":"Not now"}','/api/approvals/ap-strategy/request-revision {"decisionNote":"Add a budget"}']);
  await assert.rejects(()=>h.call('paperclip.approval.decide',{id:'ap-strategy',decision:'request_revision'}),/Say what should change/);
  await assert.rejects(()=>h.call('paperclip.approval.decide',{id:'ap-strategy',decision:'delete'}),/Unknown decision/);
  await assert.rejects(()=>h.call('paperclip.approval.decide',{id:'../x',decision:'approve'}),/Unknown item/);
});

test('D9: the Inbox row of an approval carries its id and the decisions Paperclip offers; an approval on a task is a card with actions',async t=>{
  const attention={items:[{id:'att-ap',sourceKind:'approval',subject:{kind:'approval',id:'ap-hire',title:'Data Engineer'},decisionVerbs:[{id:'approve'},{id:'reject'}],whyNow:'x',severity:'high',activityAt:now}]};
  const base=withApprovals();
  const h=await harness(t,{fetch:async(input,init)=>new URL(input).pathname.endsWith('/attention')?new Response(JSON.stringify(attention),{status:200}):new URL(input).pathname==='/api/issues/RAG-12/approvals'?new Response(JSON.stringify([approvalRows[0],approvalRows[2]]),{status:200}):base(input,init)});
  await h.call('paperclip.config.set',{mode:'local'});
  const snap=await h.call('paperclip.snapshot');
  const row=snap.inbox.find((i:any)=>i.approvalId==='ap-hire');
  assert.deepEqual(row.approvalVerbs,['approve','reject'],'only what Paperclip offers');
  const detail=await h.call('paperclip.task',{id:'RAG-12'});
  const cards=detail.cards.filter((c:any)=>c.kind==='approval');
  assert.deepEqual(cards.map((c:any)=>[c.approvalId??null,c.status]),[['ap-hire','pending'],[null,'approved']],'only a pending approval can be decided');
  assert.equal(cards[0].title,'Hire Nova as Data Engineer');
});

test('D15: Pause then Resume (company-wide) leaves agents paused on purpose and agents waiting for approval exactly as they were',async t=>{
  const agentsNow=[{id:'a-1',name:'One',status:'idle'},{id:'a-2',name:'Two',status:'active'},{id:'a-purposely',name:'Purposely',status:'paused'},{id:'a-new',name:'New',status:'pending_approval'},{id:'a-gone',name:'Gone',status:'terminated'}];
  const status=new Map(agentsNow.map(a=>[a.id,a.status]));const posts:string[]=[];
  const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>{const url=new URL(input);
    if(url.pathname===`/api/companies/${COMPANY}/agents`)return new Response(JSON.stringify(agentsNow.map(a=>({...a,status:status.get(a.id),role:'general',adapterConfig:{}}))),{status:200});
    const m=/^\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(url.pathname);if(m&&init?.method==='POST'){posts.push(`${m[2]} ${m[1]}`);status.set(m[1],m[2]==='pause'?'paused':'idle');return new Response('{}',{status:200});}
    return server.fetch(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  assert.deepEqual((await h.call('paperclip.snapshot')).agentCounts,{active:2,paused:1,resumable:{paperclip:0,local:0,projects:{}}},'the label counts the company’s agents that Pause would stop, not a pending hire');
  assert.deepEqual(await h.call('paperclip.pauseAll',{source:'paperclip'}),{changed:2});
  assert.deepEqual(posts,['pause a-1','pause a-2'],'the purposely paused, pending and terminated agents are not touched');
  posts.length=0;
  assert.deepEqual(await h.call('paperclip.resumeAll',{source:'paperclip'}),{changed:2});
  assert.deepEqual(posts,['resume a-1','resume a-2'],'only what Pause paused wakes');
  assert.equal(status.get('a-purposely'),'paused');assert.equal(status.get('a-new'),'pending_approval');
});

test('D15: a project Roster’s Pause and Resume on Muster agents touch only that project’s agents that were running, and resume only those',async t=>{
  const paused=new Set<string>(['m-purposely']);const calls:string[]=[];
  const members=[{id:'m-1',name:'One',kind:'agent',role:'agent',title:null,runner:null,instructions:'',createdAt:now},{id:'m-2',name:'Two',kind:'agent',role:'agent',title:null,runner:null,instructions:'',createdAt:now},{id:'m-purposely',name:'Purposely',kind:'agent',role:'agent',title:null,runner:null,instructions:'',createdAt:now},{id:'m-pending',name:'Pending',kind:'agent',role:'agent',title:null,runner:null,instructions:'',createdAt:now,pendingAt:now}];
  const h=await harness(t,{invoke:(command,input)=>{
    if(command==='project.list')return [{id:'p1',name:'Launch',goal:'Ship',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null}];
    if(command==='project.work')return {tasks:{items:[],truncated:false},decisions:{items:[]},activity:{items:[]},scheduler:{paused:false}};
    if(command==='project.members.list')return {members:members.map(m=>({...m,pausedAt:paused.has(m.id)?now:null})),settings:undefined};
    if(command==='project.members.pause'){calls.push(`${input.paused?'pause':'resume'} ${input.id}`);if(input.paused)paused.add(input.id);else paused.delete(input.id);return {};}
  }});
  assert.deepEqual(await h.call('paperclip.pauseAll',{source:'local',projectId:'p1'}),{changed:2});
  assert.deepEqual(calls,['pause m-1','pause m-2']);calls.length=0;
  assert.deepEqual(await h.call('paperclip.resumeAll',{source:'local',projectId:'p1'}),{changed:2});
  assert.deepEqual(calls,['resume m-1','resume m-2'],'Purposely stays paused; the pending hire is never touched');
  assert.ok(paused.has('m-purposely'));
});

test('B14: Paperclip budget policies (company, project, agent) with utilisation and incidents are read into the Dashboard',async t=>{
  const overview={policies:[{policyId:'b1',scopeType:'project',scopeId:'p-oss',scopeName:'OSS Manager',metric:'billed_cents',amount:100000,observedAmount:25000,utilizationPercent:25,warnPercent:80,hardStopEnabled:false,isActive:true,status:'ok',paused:false},
    {policyId:'b2',scopeType:'agent',scopeId:'a-cto',scopeName:'CTO',metric:'billed_cents',amount:50000,observedAmount:50000,utilizationPercent:100,warnPercent:80,hardStopEnabled:true,isActive:true,status:'hard_stop',paused:true},
    {policyId:'b3',scopeType:'company',scopeId:COMPANY,scopeName:'RagnarDataOps',metric:'billed_cents',amount:250000,observedAmount:1000,utilizationPercent:0.4,warnPercent:80,hardStopEnabled:false,isActive:true,status:'ok',paused:false},
    {policyId:'b4',scopeType:'company',scopeId:COMPANY,metric:'tokens',amount:9,isActive:true}],activeIncidents:[{id:'inc'}]};
  const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>new URL(input).pathname.endsWith('/budgets/overview')?new Response(JSON.stringify(overview),{status:200}):server.fetch(input,init)});
  await h.call('paperclip.config.set',{mode:'local'});await h.call('paperclip.snapshot');
  const data=await h.call('paperclip.dashboard',{});
  assert.deepEqual(data.budgets.policies.map((p:any)=>[p.scope,p.name,p.limitUsd,p.observedUsd,p.status,p.hardStop,p.paused]),[['project','OSS Manager',1000,250,'ok',false,false],['agent','CTO',500,500,'hard_stop',true,true],['company','RagnarDataOps',2500,10,'ok',false,false]],'dollar policies only, in dollars');
  assert.equal(data.budgets.incidents,1);assert.equal(data.budgets.company,'RagnarDataOps');
});

test('review S1: Resume with no recorded Pause wakes nothing, so an agent paused on purpose stays paused; the snapshot says how many Pause can resume',async t=>{
  const status=new Map([['a-1','idle'],['a-purposely','paused']]);const posts:string[]=[];const server=paperclip();
  const h=await harness(t,{fetch:async(input,init)=>{const url=new URL(input);
    if(url.pathname===`/api/companies/${COMPANY}/agents`)return new Response(JSON.stringify([...status].map(([id,s])=>({id,name:id,status:s,role:'general',adapterConfig:{}}))),{status:200});
    const m=/^\/api\/agents\/([^/]+)\/(pause|resume)$/.exec(url.pathname);if(m&&init?.method==='POST'){posts.push(`${m[2]} ${m[1]}`);status.set(m[1],m[2]==='pause'?'paused':'idle');return new Response('{}',{status:200});}
    return server.fetch(input,init);}});
  await h.call('paperclip.config.set',{mode:'local'});
  assert.deepEqual((await h.call('paperclip.snapshot')).agentCounts,{active:1,paused:1,resumable:{paperclip:0,local:0,projects:{}}},'nothing recorded: nothing to resume');
  assert.deepEqual(await h.call('paperclip.resumeAll',{source:'paperclip'}),{changed:0});
  assert.deepEqual(posts,[],'no agent was woken');
  await h.call('paperclip.pauseAll',{source:'paperclip'});
  assert.equal((await h.call('paperclip.snapshot',{refresh:true})).agentCounts.resumable.paperclip,1,'only what Pause stopped');
  posts.length=0;await h.call('paperclip.resumeAll',{source:'paperclip'});
  assert.deepEqual(posts,['resume a-1']);assert.equal(status.get('a-purposely'),'paused');
  assert.deepEqual(await h.call('paperclip.resumeAll',{source:'paperclip'}),{changed:0},'a second Resume has nothing left to wake');
});
