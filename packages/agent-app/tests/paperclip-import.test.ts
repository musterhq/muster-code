/** Import from Paperclip (#115, #117) against a recorded, redacted capture of a real company (RagnarDataOps: 2 projects,
 *  18 agents, 16 issues, 80 comments), through the real agent service: GET-only, idempotent, faithful mapping, pending
 *  decisions in the Inbox, nothing running until started, and a started task running in its own worktree. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import {gitIdentity,runnerFor,SqliteImportStore} from '../src/runtime/paperclip-import.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const COMPANY='0436ce61-f1eb-44c3-96a9-eb171b93a49a';
type Json=Record<string,any>;

async function fixture(t:TestContext){
  const raw=JSON.parse(await readFile(new URL('./fixtures/paperclip-rag/company.json',import.meta.url),'utf8')) as Json;
  const dataDir=await mkdtemp(join(tmpdir(),'muster-pc-import-'));
  // The OSS Manager checkout, stood in for by a real git repository with a `dev` branch.
  const repo=join(dataDir,'redis-automation');
  execFileSync('git',['init','-q','-b','dev',repo]);execFileSync('git',['-C',repo,'config','user.email','t@t']);execFileSync('git',['-C',repo,'config','user.name','t']);
  await writeFile(join(repo,'README.md'),'oss manager\n');execFileSync('git',['-C',repo,'add','.']);execFileSync('git',['-C',repo,'commit','-qm','init']);
  for(const p of raw.projects)if(p.codebase?.localFolder)p.codebase.localFolder=repo;
  const calls:{method:string;path:string}[]=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(input:string|URL,init:RequestInit={})=>{
    const url=new URL(String(input)),path=url.pathname.replace(/^\/api/,''),method=init.method??'GET';
    calls.push({method,path:path+url.search});
    if(method!=='GET')return new Response('{"error":"writes are not allowed in this test"}',{status:405});
    const body=route(raw,path,url.searchParams);
    return body===undefined?new Response('{"error":"not found"}',{status:404}):new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json',etag:`W/"${path}"`}});
  }) as typeof fetch;
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:'m',name:'m'}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'done'};}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{globalThis.fetch=realFetch;await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  return {raw,service,calls,repo};
}
function route(raw:Json,path:string,q:URLSearchParams):unknown{
  if(path==='/companies')return raw.companies;
  const base=`/companies/${COMPANY}`;
  if(path===`${base}/projects`)return raw.projects;
  if(path===`${base}/agents`)return raw.agents;
  // Like Paperclip: blockers come back as `blockedBy: [{id,…}]`, and only when asked for.
  if(path===`${base}/issues`)return q.get('includeBlockedBy')==='true'?raw.issues.map((i:Json)=>({...i,blockedBy:(raw.blockers?.[i.identifier]??[]).map((key:string)=>{const b=raw.issues.find((x:Json)=>x.identifier===key);return {id:b.id,identifier:key,title:b.title,status:b.status};})})):raw.issues;
  if(path===`${base}/goals`)return raw.goals;
  if(path===`${base}/approvals`)return raw.approvals;
  const m=/^\/issues\/([^/]+)\/(comments|interactions|approvals)$/.exec(path);
  if(m)return raw.perIssue[decodeURIComponent(m[1])]?.[m[2]]??[];
  void q;return undefined;
}

test('blockers survive the import: includeBlockedBy and blockedBy[].id (S79)',async t=>{
  const {raw,service,calls}=await fixture(t);
  raw.blockers={'RAG-16':['RAG-15'],'RAG-5':['RAG-4','RAG-6']};
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(calls.some(c=>/\/issues\?.*includeBlockedBy=true/.test(c.path)),'blockers are asked for');
  await service.invoke('paperclip.config.set',{mode:'off'});
  const ws=await service.invoke('paperclip.snapshot',{});
  const mine=(key:string)=>ws.tasks.find(x=>x.key===key)!;
  assert.deepEqual(mine('RAG-16').blockedByIds,[mine('RAG-15').id],'the imported task keeps its blocker');
  assert.deepEqual(mine('RAG-5').blockedByIds.sort(),[mine('RAG-4').id,mine('RAG-6').id].sort());
});

test('runner and git identity mapping: Claude Code keeps its model, Codex keeps its provider and model',()=>{
  assert.deepEqual(runnerFor({adapterType:'claude_local',adapterConfig:{model:'claude-opus-5-5'}}),{runtime:'Claude Code',providerId:'claude-code',model:'claude-opus-5-5',modelProvider:null});
  assert.deepEqual(runnerFor({adapterType:'codex_local',adapterConfig:{model:'x'}},()=>({provider:'hybrow',model:'intelligent-planner'})),{runtime:'Codex',providerId:'codex',model:'intelligent-planner',modelProvider:'hybrow'});
  assert.deepEqual(gitIdentity('Implementer A','RagnarDataOps'),{name:'Implementer A (RagnarDataOps agent)',email:'implementer-a@agents.ragnardataops.local'});
});

test('importing a real company: GET only, projects, roster, tasks with keys, parents and threads, decisions; nothing runs',async t=>{
  const {raw,service,calls}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const report=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(calls.every(c=>c.method==='GET'),'the importer never writes to Paperclip');
  assert.equal(report.company,'RagnarDataOps');
  assert.deepEqual(report.projects,{created:2,updated:0});
  assert.equal(report.tasks.created,raw.issues.filter((i:Json)=>i.projectId).length);
  const comments=Object.values(raw.perIssue as Json).reduce((n:number,x:any)=>n+(x.comments??[]).filter((c:Json)=>!c.deletedAt).length,0);
  assert.equal(report.comments>=comments,true,'every comment is carried over');
  const projects=await service.invoke('project.list',undefined);
  assert.deepEqual(projects.map(p=>p.name).sort(),['Muster','OSS Manager']);
  const oss=projects.find(p=>p.name==='OSS Manager')!;
  assert.equal(oss.folderIds.length,1,'the OSS Manager folder is linked');
  const sources=await service.invoke('project.sources.list',{projectId:oss.id});
  assert.equal(sources.sources[0].ref,'https://github.com/hybrowlabs/OSS-Manager');
  // Nothing starts on its own.
  const snapshot=await service.invoke('app.snapshot',undefined);
  assert.equal(snapshot.chats.length,0,'no chats and no runs were started');
  const scheduler=(await service.invoke('project.work',{projectId:oss.id})).scheduler;
  assert.equal(scheduler.autoDispatch,false);
  // The merged workspace: keys, parents, owners, statuses, the Roster, the thread.
  await service.invoke('paperclip.config.set',{mode:'off'});
  const ws=await service.invoke('paperclip.snapshot',{});
  const rag15=ws.tasks.find(x=>x.key==='RAG-15')!, rag1=ws.tasks.find(x=>x.key==='RAG-1')!;
  assert.ok(rag15&&rag1);
  assert.equal(rag15.parentId,rag1.id,'RAG-15 is a child of RAG-1');
  assert.equal(rag15.assigneeLabel,'CTO');assert.equal(rag15.priority,'critical');
  assert.equal(ws.tasks.find(x=>x.key==='RAG-8')!.status,'done','done issues arrive verified');
  assert.equal(ws.tasks.find(x=>x.key==='RAG-11')!.status,'todo','backlog becomes todo');
  const roster=ws.agents.filter(a=>a.id.startsWith('member:')&&ws.tasks.some(x=>x.projectId===oss.id));
  const cto=roster.find(a=>a.name==='CTO')!, ceo=roster.find(a=>a.name==='CEO')!;
  assert.equal(cto.title,'Chief Technology Officer');assert.equal(cto.model,'claude-opus-5-5');assert.equal(cto.adapter,'Claude Code');
  assert.ok(roster.some(a=>a.reportsTo===ceo.id),'reporting lines survive');
  const detail=await service.invoke('paperclip.task',{id:rag15.id});
  const sourceComments=(raw.perIssue[raw.issues.find((i:Json)=>i.identifier==='RAG-15').id].comments as Json[]).filter(c=>!c.deletedAt);
  const imported=detail.comments.filter(c=>c.id.startsWith('pc:'));
  assert.equal(imported.length,sourceComments.length);
  assert.deepEqual(imported.map(c=>c.createdAt),sourceComments.map(c=>c.createdAt),'in order, with their times');
  assert.equal(imported[0].author.label,sourceComments[0].authorAgentId?raw.agents.find((a:Json)=>a.id===sourceComments[0].authorAgentId).name:'You');
  // Decisions: answered ones are history; pending human-only ones are Needs you and stay unresolved.
  const pendingSource=Object.values(raw.perIssue as Json).flatMap((x:any)=>x.interactions??[]).filter((i:Json)=>i.status==='pending').length+Object.values(raw.perIssue as Json).flatMap((x:any)=>x.approvals??[]).filter((a:Json)=>a.status==='pending').length;
  assert.equal(report.needsYou,pendingSource);
  assert.equal(ws.inbox.filter(i=>i.id.startsWith('import:')).length,pendingSource);
  // Idempotent: a second run updates, never duplicates.
  const membersBefore=(await service.invoke('project.members.list',{projectId:oss.id})).members.filter(m=>!m.revokedAt).length;
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const again=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.deepEqual(again.projects,{created:0,updated:2});
  assert.equal(again.tasks.created,0);assert.equal(again.comments,0,'comments already carried over are not added twice');
  assert.equal((await service.invoke('project.list',undefined)).length,2);
  const members=(await service.invoke('project.members.list',{projectId:oss.id})).members.filter(m=>!m.revokedAt);
  assert.equal(members.length,membersBefore,'no duplicate roster members');
  assert.ok(raw.agents.filter((a:Json)=>a.status!=='terminated').every((a:Json)=>members.some(m=>m.name===a.name)),'every active agent is on the Roster');
});

test('a started task runs in its own worktree of the project folder, never the checkout itself',async t=>{
  const {service,repo}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  await service.invoke('paperclip.config.set',{mode:'off'});
  const ws=await service.invoke('paperclip.snapshot',{});
  const rag15=ws.tasks.find(x=>x.key==='RAG-15')!;
  // RAG-8 is done, so its dispatch is refused: Start fails, and takes back the worktree and folder it made.
  const rag8=ws.tasks.find(x=>x.key==='RAG-8')!;
  const foldersBefore=(await service.invoke('app.snapshot',undefined)).folders.length;
  await assert.rejects(()=>service.invoke('paperclip.task.start',{taskId:rag8.id}));
  assert.doesNotMatch(execFileSync('git',['-C',repo,'worktree','list'],{encoding:'utf8'}),/muster\/rag-8/,'a failed Start leaves no worktree behind');
  assert.equal((await service.invoke('app.snapshot',undefined)).folders.length,foldersBefore,'nor a linked folder');
  // RAG-15 is blocked in Paperclip; the founder moves it back to todo before starting it.
  await service.invoke('paperclip.task.update',{taskId:rag15.id,status:'todo'});
  const started=await service.invoke('paperclip.task.start',{taskId:rag15.id});
  assert.equal(started.branch,'muster/rag-15');
  assert.notEqual(started.worktree,repo,'not the checkout');
  const chat=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===started.chatId)!;
  const folder=(await service.invoke('app.snapshot',undefined)).folders.find(f=>f.id===chat.folderId)!;
  assert.equal(folder.path,started.worktree,'the run works in the worktree');
  const branches=execFileSync('git',['-C',repo,'worktree','list'],{encoding:'utf8'});
  assert.match(branches,/muster\/rag-15/);
  // Starting again reuses the task's worktree instead of failing on the checked-out branch; the dispatch refusal is what surfaces.
  await assert.rejects(()=>service.invoke('paperclip.task.start',{taskId:rag15.id}),(e:Error)=>!/already checked out/.test(e.message));
  assert.match(execFileSync('git',['-C',repo,'worktree','list'],{encoding:'utf8'}),/muster\/rag-15/,'a reused worktree is kept when a Start fails');
});

test('a company-wide approval that is also an issue approval keeps its task and project',async()=>{
  const {DatabaseSync}=await import('node:sqlite');
  const store=new SqliteImportStore(new DatabaseSync(':memory:'));
  const row={sourceId:'approval:a1',kind:'approval:hire',title:'Hire QA',status:'pending',detail:'',at:'2026-09-29T00:00:00.000Z',pending:true};
  store.putHistory({...row,taskId:'task-7',projectId:'project-b'});
  store.putHistory({...row,taskId:null,projectId:'project-a',status:'approved',detail:'ok',pending:false});
  assert.deepEqual(store.history().map(h=>[h.taskId,h.projectId,h.status,h.pending]),[['task-7','project-b','approved',false]],'the later company row updates the status only');
  store.putHistory({...row,sourceId:'approval:a2',taskId:null,projectId:'project-a'});
  store.putHistory({...row,sourceId:'approval:a2',taskId:null,projectId:null});
  assert.equal(store.history().find(h=>h.sourceId==='approval:a2')!.projectId,'project-a','a missing project never clears one');
});

test('a remote Paperclip never makes Muster link or read a local path; the report says to link it yourself',async t=>{
  const {service,calls}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'custom',baseUrl:'https://pc.example.com',companyId:COMPANY});
  const report=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(calls.every(c=>c.method==='GET'));
  const projects=await service.invoke('project.list',undefined);
  assert.ok(projects.every(p=>p.folderIds.length===0),'no folder from the server is added');
  assert.equal((await service.invoke('app.snapshot',undefined)).folders.length,0);
  assert.ok(report.notes.some(n=>/OSS Manager: its folder .* is on the Paperclip server.*Link your own checkout/.test(n)));
});

test('import into an existing project: the plan matches OSSMANAGER by its folder (and by name), the import fills it, GET only and idempotent',async t=>{
  const {raw,service,calls,repo}=await fixture(t);
  // The founder's own project: three folders, one of them the checkout Paperclip's OSS Manager works in; 0 tasks.
  const extra1=await mkdtemp(join(tmpdir(),'muster-extra-')),extra2=await mkdtemp(join(tmpdir(),'muster-extra-'));
  t.after(async()=>{await rm(extra1,{recursive:true,force:true});await rm(extra2,{recursive:true,force:true});});
  const folders=[await service.invoke('folder.add',{path:extra1}),await service.invoke('folder.add',{path:repo}),await service.invoke('folder.add',{path:extra2})];
  const mine=await service.invoke('project.create',{name:'OSSMANAGER',goal:'',folderIds:folders.map(f=>f.id)});
  const named=await service.invoke('project.create',{name:'muster',goal:'Mine',folderIds:[]});
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  assert.equal(plan.company?.name,'RagnarDataOps');
  const oss=plan.projects.find(p=>p.name==='OSS Manager')!,muster=plan.projects.find(p=>p.name==='Muster')!;
  assert.deepEqual(oss.suggestion,{projectId:mine.id,reason:'folder'});
  assert.equal(oss.taskCount,raw.issues.filter((i:Json)=>i.projectId===oss.id).length);
  assert.deepEqual(muster.suggestion,{projectId:named.id,reason:'name'});
  assert.equal(calls.filter(c=>c.method!=='GET').length,0,'planning is GET only');
  const report=await service.invoke('paperclip.import',{companyId:COMPANY,targets:{[oss.id]:mine.id,[muster.id]:'skip'}});
  assert.ok(calls.every(c=>c.method==='GET'),'the importer never writes to Paperclip');
  assert.deepEqual(report.projects,{created:0,updated:1});
  assert.deepEqual(report.filled,[{paperclip:'OSS Manager',muster:'OSSMANAGER'}]);
  const projects=await service.invoke('project.list',undefined);
  assert.deepEqual(projects.map(p=>p.name).sort(),['OSSMANAGER','muster'],'no project was created');
  const filled=projects.find(p=>p.id===mine.id)!;
  assert.equal(filled.name,'OSSMANAGER','your name is kept');
  assert.ok(filled.goal.length>0,'an empty goal takes Paperclip’s description');
  assert.equal(filled.folderIds.length,3,'the checkout was already linked: nothing is added twice');
  const snap=await service.invoke('paperclip.snapshot',{});
  const tasks=snap.tasks.filter(x=>x.projectId===mine.id);
  assert.equal(tasks.length,oss.taskCount);
  assert.ok(tasks.some(x=>x.key==='RAG-1'));
  const roster=snap.agents.filter(a=>a.projectId===mine.id);
  assert.ok(roster.length>5,'the Roster is filled');
  assert.ok(roster.every(a=>a.name!=='Agents'),'no generic Agents row');
  const cto=roster.find(a=>a.name==='CTO')!;
  assert.ok(cto.title,'titles come across onto the members');
  assert.ok(roster.some(a=>a.reportsTo===cto.id),'reporting lines come across');
  assert.equal(snap.tasks.filter(x=>x.projectId===named.id).length,0,'the skipped project is left alone');
  // Safe to repeat: the same targets update what the first run made.
  const again=await service.invoke('paperclip.import',{companyId:COMPANY,targets:{[oss.id]:mine.id,[muster.id]:'skip'}});
  assert.equal(again.tasks.created,0); assert.equal(again.tasks.updated,oss.taskCount);
  assert.equal((await service.invoke('paperclip.snapshot',{})).tasks.filter(x=>x.projectId===mine.id).length,oss.taskCount);
  // Once imported, the plan remembers where it went.
  assert.deepEqual((await service.invoke('paperclip.import.plan',{companyId:COMPANY})).projects.find(p=>p.id===oss.id)!.suggestion,{projectId:mine.id,reason:'imported'});
});
