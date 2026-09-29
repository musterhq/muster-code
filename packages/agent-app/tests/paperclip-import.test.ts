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
import {gitIdentity,runnerFor} from '../src/runtime/paperclip-import.ts';
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
  if(path===`${base}/issues`)return raw.issues;
  if(path===`${base}/goals`)return raw.goals;
  if(path===`${base}/approvals`)return raw.approvals;
  const m=/^\/issues\/([^/]+)\/(comments|interactions|approvals)$/.exec(path);
  if(m)return raw.perIssue[decodeURIComponent(m[1])]?.[m[2]]??[];
  void q;return undefined;
}

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
});
