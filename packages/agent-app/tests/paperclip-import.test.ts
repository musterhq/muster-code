/** Import from Paperclip (#115, #117) against a recorded, redacted capture of a real company (RagnarDataOps: 2 projects,
 *  18 agents, 16 issues, 80 comments), through the real agent service: GET-only, idempotent, faithful mapping, pending
 *  decisions in the Inbox, nothing running until started, and a started task running in its own worktree. */
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname,join} from 'node:path';
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
  // Paperclip's instruction bundle: an entry file and notes, read file by file.
  const bundle=/^\/agents\/([^/]+)\/instructions-bundle(\/file)?$/.exec(path);
  if(bundle&&raw.bundle){const files:Json=raw.bundle;return bundle[2]?(files[q.get('path')??'']===undefined?undefined:{path:q.get('path'),content:files[q.get('path')??'']}):{entryFile:'AGENTS.md',files:Object.keys(files).map(f=>({path:f}))};}
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
  assert.ok((await service.invoke('paperclip.task',{id:rag1.id})).subtasks.includes(rag15.id),'the imported parent lists its subtasks (S22)');
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
  // C18: CTO's imported runner (Claude Code, claude-opus-5-5) does not exist on this machine. Start stops and asks for a model for CTO
  // instead of quietly running on the project default; nothing is left behind.
  await assert.rejects(()=>service.invoke('paperclip.task.start',{taskId:rag15.id}),/Choose a model for CTO/);
  assert.doesNotMatch(execFileSync('git',['-C',repo,'worktree','list'],{encoding:'utf8'}),/muster\/rag-15/,'a blocked Start leaves no worktree behind');
  assert.equal((await service.invoke('app.snapshot',undefined)).chats.filter(c=>!c.archived).length,0,'and no live chat');
  const project=(await service.invoke('project.list',undefined)).find(p=>p.name==='OSS Manager')!;
  const cto=(await service.invoke('project.members.list',{projectId:project.id})).members.find(m=>m.name==='CTO')!;
  await service.invoke('project.members.update',{projectId:project.id,id:cto.id,runner:{providerId:'hybrow',model:'m'}});
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

test('founder decision: an import never writes into a project you made; each Paperclip project is its own project under its org',async t=>{
  const {raw,service,calls,repo}=await fixture(t);
  // The founder's own projects, one of them with the very folder, name and repository Paperclip's projects use.
  const folder=await service.invoke('folder.add',{path:repo});
  const mine=await service.invoke('project.create',{name:'OSS Manager',goal:'My own goal',folderIds:[folder.id]});
  const named=await service.invoke('project.create',{name:'muster',goal:'Mine',folderIds:[]});
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  assert.equal(plan.company?.name,'RagnarDataOps');assert.equal(plan.local,true);
  assert.ok(plan.projects.every(p=>p.existing==='new'&&!('suggestion' in p)),'nothing is matched to your projects');
  assert.equal(calls.filter(c=>c.method!=='GET').length,0,'planning is GET only');
  const report=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(calls.every(c=>c.method==='GET'),'the importer never writes to Paperclip');
  assert.deepEqual(report.projects,{created:2,updated:0});
  const projects=await service.invoke('project.list',undefined);
  assert.equal(projects.length,4,'two new Paperclip projects beside your two');
  const untouched=projects.find(p=>p.id===mine.id)!;
  assert.equal(untouched.goal,'My own goal');assert.equal(untouched.folderIds.length,1,'your project keeps its folders');
  const snap=await service.invoke('paperclip.snapshot',{});
  assert.equal(snap.tasks.filter(x=>x.projectId===mine.id||x.projectId===named.id).length,0,'no Paperclip task landed in your projects');
  const paperclipProjects=snap.projects.filter(p=>p.org);
  assert.deepEqual(paperclipProjects.map(p=>p.org),['RagnarDataOps','RagnarDataOps'],'both are grouped under their org');
  assert.ok(snap.projects.filter(p=>!p.org).map(p=>p.id).sort().join()===[mine.id,named.id].sort().join(),'your projects carry no org');
  // Re-import updates the same two; still no write into yours.
  const again=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.deepEqual(again.projects,{created:0,updated:2});assert.equal(again.tasks.created,0);
  assert.equal((await service.invoke('project.list',undefined)).length,4);
  // Linked as well as imported: the project shows once (its imported copy), not twice.
  const linked=await service.invoke('paperclip.snapshot',{});
  assert.equal(linked.projects.filter(p=>p.name==='OSS Manager'&&p.org).length,1,'no duplicate of an imported project');
  // 'skip' leaves one out.
  const oss=plan.projects.find(p=>p.name==='OSS Manager')!;
  assert.ok(oss.taskCount>0);
  assert.equal(raw.projects.length,2);
});

test('an older import that filled one of your projects: that project is left alone and the Paperclip project is imported separately, with a note',async t=>{
  const {service,repo}=await fixture(t);
  const mine=await service.invoke('project.create',{name:'OSSMANAGER',goal:'My own goal',folderIds:[]});
  const ossId=JSON.parse(await readFile(new URL('./fixtures/paperclip-rag/company.json',import.meta.url),'utf8')).projects.find((p:Json)=>p.name==='OSS Manager').id as string;
  // What 0.2.9 left behind: the Paperclip project mapped to your own project (no origin recorded).
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const {DatabaseSync}=await import('node:sqlite');
  const db=new DatabaseSync(join(dirname(repo),'muster-agent.sqlite'));t.after(()=>db.close());
  const store=new SqliteImportStore(db);
  store.setMap('project',ossId,mine.id,'RAG',{name:'OSS Manager',companyId:COMPANY});
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  assert.equal(plan.projects.find(p=>p.id===ossId)!.existing,'detached');
  const report=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(report.notes.some(n=>/earlier import filled your project “OSSMANAGER”.*left alone/.test(n)),JSON.stringify(report.notes));
  const projects=await service.invoke('project.list',undefined);
  assert.equal(projects.find(p=>p.id===mine.id)!.goal,'My own goal');
  assert.equal((await service.invoke('paperclip.snapshot',{})).tasks.filter(x=>x.projectId===mine.id).length,0);
  assert.equal(projects.filter(p=>p.name==='OSS Manager').length,1,'the Paperclip project got its own project');
});

test('an imported agent gets its instruction bundle and its git identity applied (G11, S87)',async t=>{
  const {raw,service,calls}=await fixture(t);
  raw.bundle={'AGENTS.md':'You are the imported agent.','HEARTBEAT.md':'1. check the queue','notes/skip.txt':'ignored','TOOLS.md':'use rg'};
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(calls.every(c=>c.method==='GET'),'GET only');
  const project=(await service.invoke('project.list',undefined)).find(p=>!p.archived)!;
  const agent=(await service.invoke('project.members.list',{projectId:project.id})).members.find(m=>m.kind==='agent'&&m.id!=='agent')!;
  const view=await service.invoke('project.agent.gov.get',{projectId:project.id,memberId:agent.id});
  assert.equal(view.files.find(f=>f.name==='AGENTS.md')!.text,'You are the imported agent.');
  assert.equal(view.files.find(f=>f.name==='HEARTBEAT.md')!.text,'1. check the queue');
  assert.equal(view.files.find(f=>f.name==='TOOLS.md')!.text,'use rg');
  assert.ok(view.governance.gitIdentity?.email.endsWith('.local'),'the recorded identity is applied');
  const before=view.revisions.length;
  await service.invoke('project.agent.files.save',{projectId:project.id,memberId:agent.id,name:'SOUL.md',text:'local edit'});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  const again=await service.invoke('project.agent.gov.get',{projectId:project.id,memberId:agent.id});
  assert.equal(again.files.find(f=>f.name==='SOUL.md')!.text,'local edit','a re-import keeps a bundle you edited');
  assert.ok(again.revisions.length>=before);
});

test('an instruction file the import cannot keep is counted in the report, not dropped silently',async t=>{
  const {raw,service}=await fixture(t);
  raw.bundle={'AGENTS.md':'You are the imported agent.','HUGE.md':'x'.repeat(40_000),'notes/odd name!.md':'text'};
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const report=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.ok(report.notes.some(n=>/instruction files were skipped/.test(n)),JSON.stringify(report.notes));
});

async function importTwice(t:TestContext,mutate:(raw:Json)=>void){
  const ctx=await fixture(t);
  await ctx.service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const first=await ctx.service.invoke('paperclip.import',{companyId:COMPANY});
  const oss=(await ctx.service.invoke('project.list',undefined)).find(p=>p.name==='OSS Manager')!;
  const work=async()=>(await ctx.service.invoke('project.work',{projectId:oss.id})).tasks.items;
  return {...ctx,first,oss,work,again:async()=>{mutate(ctx.raw);return ctx.service.invoke('paperclip.import',{companyId:COMPANY});}};
}

test('C10/C11: a re-import keeps what you changed in Muster, applies the rest, and reports the conflicts',async t=>{
  const h=await importTwice(t,raw=>{
    const project=raw.projects.find((p:Json)=>p.name==='OSS Manager');project.name='OSS Manager (Paperclip rename)';project.description='Paperclip goal v2';
    raw.issues.find((i:Json)=>i.identifier==='RAG-11').title='RAG-11 retitled in Paperclip';
    raw.issues.find((i:Json)=>i.identifier==='RAG-12').title='RAG-12 retitled in Paperclip';
    raw.issues.find((i:Json)=>i.identifier==='RAG-12').priority='critical';
  });
  // The founder renames and re-goals the project, edits one task, and moves another by hand.
  await h.service.invoke('project.update',{id:h.oss.id,name:'Ops Dashboard',goal:'My goal'});
  const meta=new Map<string,string>();void meta;
  const ws=await h.service.invoke('paperclip.snapshot',{});
  const t11=ws.tasks.find(x=>x.key==='RAG-11')!,t12=ws.tasks.find(x=>x.key==='RAG-12')!,t13=ws.tasks.find(x=>x.key==='RAG-13')!;
  const item=(await h.work()).find(x=>x.id===t11.id)!;
  await h.service.invoke('project.tasks.edit',{projectId:h.oss.id,id:t11.id,revision:item.revision,patch:{title:'Founder renamed this task',priority:0}});
  const item13=(await h.work()).find(x=>x.id===t13.id)!;
  await h.service.invoke('project.tasks.setState',{projectId:h.oss.id,id:t13.id,revision:item13.revision,state:'review'});
  const report=await h.again();
  const project=(await h.service.invoke('project.list',undefined)).find(p=>p.id===h.oss.id)!;
  assert.equal(project.name,'Ops Dashboard','your project name stays');assert.equal(project.goal,'My goal','your goal stays');
  const tasks=await h.work();
  assert.equal(tasks.find(x=>x.id===t11.id)!.title,'Founder renamed this task','your task edit stays');
  assert.equal(tasks.find(x=>x.id===t11.id)!.priority,0);
  assert.equal(tasks.find(x=>x.id===t12.id)!.title,'RAG-12 retitled in Paperclip','an untouched task follows Paperclip');
  assert.equal(tasks.find(x=>x.id===t12.id)!.priority,0,'critical');
  assert.equal(tasks.find(x=>x.id===t13.id)!.state,'review','a status you set here stays');
  const fields=report.conflicts.map(c=>`${c.scope}:${c.field}`).sort();
  assert.ok(fields.includes('project:name')&&fields.includes('project:goal')&&fields.includes('task:title'),JSON.stringify(report.conflicts));
  assert.equal(report.conflicts.find(c=>c.field==='title')!.kept,'Founder renamed this task');
  // And a second re-import with nothing new reports the same kept edits but creates nothing.
  const third=await h.service.invoke('paperclip.import',{companyId:COMPANY});
  assert.equal(third.tasks.created,0);
  assert.equal((await h.service.invoke('project.list',undefined)).find(p=>p.id===h.oss.id)!.name,'Ops Dashboard');
  const snap=await h.service.invoke('paperclip.snapshot',{});
  assert.equal(snap.projects.find(p=>p.id===h.oss.id)!.editedHere,true,'the project says it was edited here');
});

test('C4: an issue deleted in Paperclip is cancelled and flagged "Removed in Paperclip" on re-import, and the report says so',async t=>{
  const h=await importTwice(t,raw=>{raw.issues=raw.issues.filter((i:Json)=>i.identifier!=='RAG-13');});
  const ws=await h.service.invoke('paperclip.snapshot',{});
  const gone=ws.tasks.find(x=>x.key==='RAG-13')!;
  const report=await h.again();
  assert.equal(report.removed,1);assert.ok(report.notes.some(n=>/deleted in Paperclip/.test(n)));
  const after=(await h.service.invoke('paperclip.snapshot',{})).tasks.find(x=>x.id===gone.id)!;
  assert.equal(after.status,'cancelled');assert.equal(after.removedInPaperclip,true);
  assert.equal((await h.service.invoke('paperclip.task',{id:gone.id})).task.removedInPaperclip,true);
  // Idempotent: it is not counted twice.
  assert.equal((await h.service.invoke('paperclip.import',{companyId:COMPANY})).removed,0);
});

test('C4 safety: an issue Paperclip merely stops listing (but still serves) is never cancelled',async t=>{
  const h=await importTwice(t,()=>undefined);
  const hidden=h.raw.issues.find((i:Json)=>i.identifier==='RAG-13') as Json;
  h.raw.issues=h.raw.issues.filter((i:Json)=>i!==hidden);
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(input:string|URL,init?:RequestInit)=>new URL(String(input)).pathname===`/api/issues/${hidden.id}`?new Response(JSON.stringify(hidden),{status:200}):realFetch(input,init)) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  const report=await h.service.invoke('paperclip.import',{companyId:COMPANY});
  assert.equal(report.removed,0);
});

test('C15: an agent waiting for hire approval is not imported as an active Roster member; the report says why',async t=>{
  const h=await importTwice(t,()=>undefined);
  void h;
  const ctx=await fixture(t);
  ctx.raw.agents.push({id:'agent-nova',name:'Nova',role:'engineer',title:'Data Engineer',status:'pending_approval',reportsTo:ctx.raw.agents[0].id,adapterType:'process',adapterConfig:{}});
  await ctx.service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const report=await ctx.service.invoke('paperclip.import',{companyId:COMPANY});
  for(const project of await ctx.service.invoke('project.list',undefined))assert.ok(!(await ctx.service.invoke('project.members.list',{projectId:project.id})).members.some(m=>m.name==='Nova'),'Nova is not a member');
  assert.ok(report.notes.some(n=>/Nova is waiting for approval in Paperclip/.test(n)),JSON.stringify(report.notes));
});

test('C16: the importer writes no "Edited…" or "Task: todo → …" entries into task threads',async t=>{
  const h=await importTwice(t,raw=>{raw.issues.find((i:Json)=>i.identifier==='RAG-12').title='retitled';});
  await h.again();
  const ws=await h.service.invoke('paperclip.snapshot',{});
  for(const task of ws.tasks.filter(x=>x.projectId===h.oss.id)){
    const detail=await h.service.invoke('paperclip.task',{id:task.id});
    assert.deepEqual(detail.comments.filter(c=>!c.id.startsWith('pc:')),[],`${task.key}: only imported comments`);
  }
});

test('C14: labels, documents with revisions, work products and routines come across; a task with no project is reported, never skipped silently',async t=>{
  const ctx=await fixture(t);
  const rag12=ctx.raw.issues.find((i:Json)=>i.identifier==='RAG-12');
  rag12.labels=[{id:'l1',name:'bug',color:'#e11d48'}];
  ctx.raw.issues.push({...ctx.raw.issues[0],id:'orphan-1',identifier:'RAG-99',projectId:null,parentId:null,title:'No project',status:'todo'});
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(input:string|URL,init?:RequestInit)=>{
    const url=new URL(String(input)),path=url.pathname.replace(/^\/api/,'');
    const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
    if(path===`/issues/${rag12.id}/documents`)return json([{id:'d1',key:'plan',title:'Q4 plan',format:'markdown',body:'# Plan v3',latestRevisionNumber:3,updatedAt:'2026-09-30T00:00:00.000Z',createdAt:'2026-09-29T00:00:00.000Z'}]);
    if(path===`/issues/${rag12.id}/documents/plan/revisions`)return json([{revisionNumber:3,changeSummary:'add dashboard',createdAt:'2026-09-30T00:00:00.000Z'},{revisionNumber:2,changeSummary:'add ship',createdAt:'2026-09-29T12:00:00.000Z'},{revisionNumber:1,changeSummary:'first draft',createdAt:'2026-09-29T00:00:00.000Z'}]);
    if(path===`/issues/${rag12.id}/work-products`)return json([{id:'w1',type:'pull_request',provider:'github',title:'PR #12',url:'https://github.com/x/y/pull/12',status:'ready_for_review',summary:'Kafka',createdAt:'2026-09-30T00:00:00.000Z'}]);
    if(path===`/companies/${COMPANY}/routines`)return json([{id:'rt1',projectId:ctx.raw.projects[0].id,title:'Weekly digest',description:'Summarise',status:'active',concurrencyPolicy:'coalesce_if_active',catchUpPolicy:'skip_missed',triggers:[{kind:'schedule',enabled:true,cronExpression:'0 9 * * 1',timezone:'UTC'}]}]);
    return realFetch(input,init);
  }) as typeof fetch;
  t.after(()=>{globalThis.fetch=realFetch;});
  await ctx.service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const report=await ctx.service.invoke('paperclip.import',{companyId:COMPANY});
  assert.equal(report.noProject,1);assert.ok(report.notes.some(n=>/1 issue has no project in Paperclip \(RAG-99\)/.test(n)),JSON.stringify(report.notes));
  await ctx.service.invoke('paperclip.config.set',{mode:'off'});
  const ws=await ctx.service.invoke('paperclip.snapshot',{});
  const task=ws.tasks.find(x=>x.key==='RAG-12')!;
  assert.deepEqual(task.labels,[{name:'bug',color:'#e11d48'}]);
  const detail=await ctx.service.invoke('paperclip.task',{id:task.id});
  const doc=detail.cards.find(c=>c.kind==='document')!;
  assert.ok(doc&&doc.kind==='document'&&doc.key==='plan'&&doc.revision===3&&doc.body==='# Plan v3'&&doc.revisions.length===3);
  const wp=detail.cards.find(c=>c.kind==='workproduct')!;
  assert.ok(wp&&wp.kind==='workproduct'&&wp.type==='pull_request'&&wp.url==='https://github.com/x/y/pull/12');
  const automations=await ctx.service.invoke('automations.list',undefined);
  const routine=automations.find(a=>a.name==='Weekly digest')!;
  assert.ok(routine&&routine.paused,'the routine is an automation, paused');
  const again=await ctx.service.invoke('paperclip.import',{companyId:COMPANY});void again;
  assert.equal((await ctx.service.invoke('automations.list',undefined)).filter(a=>a.name==='Weekly digest').length,1,'idempotent');
});

test('A9: a Custom URL on loopback is a Paperclip on this Mac: its folders are linked (a symlinked path finds the folder already added); a remote one never is',async t=>{
  const {raw,service,repo}=await fixture(t);
  const {symlinkSync}=await import('node:fs');
  const link=join(dirname(repo),'checkout-link');symlinkSync(repo,link);
  for(const p of raw.projects)if(p.codebase?.localFolder)p.codebase.localFolder=link;
  const known=await service.invoke('folder.add',{path:repo});
  await service.invoke('paperclip.config.set',{mode:'custom',baseUrl:'http://127.0.0.1:3101',companyId:COMPANY});
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  assert.equal(plan.local,true,'the plan knows the folders are this Mac’s');
  await service.invoke('paperclip.import',{companyId:COMPANY});
  const oss=(await service.invoke('project.list',undefined)).find(p=>p.name==='OSS Manager')!;
  assert.deepEqual(oss.folderIds,[known.id],'the symlinked path resolves to the folder you already added, not a second one');
  assert.equal((await service.invoke('app.snapshot',undefined)).folders.length,1);
  await service.invoke('paperclip.config.set',{mode:'custom',baseUrl:'https://pc.example.com',companyId:COMPANY});
  assert.equal((await service.invoke('paperclip.import.plan',{companyId:COMPANY})).local,false,'a remote server’s folders are not this Mac’s');
});

/** A provider whose runs wait until they are stopped, so a task stays running while the test stops it. */
async function slowFixture(t:TestContext){
  const ctx=await fixture(t);
  const waiting=new Map<string,()=>void>();
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:'m',name:'m'}]}],
    stop:async chatId=>{waiting.get(chatId)?.();return true;},dispose(){},
    async run(input){input.onTurnAccepted?.({threadId:`thr-${input.chat.id}`,turnId:'t1',dispatchState:'dispatched'});await new Promise<void>(resolve=>{waiting.set(input.chat.id,resolve);});return {status:'completed',finalMessage:'stopped',dispatchState:'dispatched'};}};
  const dataDir=dirname(ctx.repo);
  await ctx.service.dispose();
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(()=>service.dispose());
  return {...ctx,service};
}
const until=async<T>(fn:()=>Promise<T|undefined|false>,label:string)=>{for(let i=0;i<200;i++){const v=await fn();if(v)return v as T;await new Promise(r=>setTimeout(r,30));}throw new Error(`timed out waiting for ${label}`);};

test('E6: the stop variants work on tasks of an imported project: Stop keeps it blocked, Stop and cancel cancels, Stop and mark done goes to review, never straight to Done',async t=>{
  const {service}=await slowFixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  const oss=(await service.invoke('project.list',undefined)).find(p=>p.name==='OSS Manager')!;
  for(const member of (await service.invoke('project.members.list',{projectId:oss.id})).members.filter(m=>m.kind==='agent'&&m.id!=='agent'))await service.invoke('project.members.update',{projectId:oss.id,id:member.id,runner:{providerId:'hybrow',model:'m'}});
  const ws=await service.invoke('paperclip.snapshot',{});
  const state=async(id:string)=>(await service.invoke('project.work',{projectId:oss.id})).tasks.items.find(x=>x.id===id)!.state;
  const run=async(key:string)=>{const task=ws.tasks.find(x=>x.key===key)!;await service.invoke('paperclip.task.update',{taskId:task.id,status:'todo'});await service.invoke('paperclip.task.start',{taskId:task.id});await until(async()=>(await state(task.id))==='running','running');return task;};
  const stop=(id:string,mode:string)=>service.invoke('project.tasks.stop',{projectId:oss.id,id,mode} as never);
  const settled=async(id:string)=>until(async()=>{const s=await state(id);return s!=='running'&&s!=='needs-input'?s:false;},'settled');
  const keep=await run('RAG-12');await stop(keep.id,'keep');assert.equal(await settled(keep.id),'blocked');
  const cancel=await run('RAG-13');await stop(cancel.id,'cancel');assert.equal(await settled(cancel.id),'cancelled');
  const done=await run('RAG-11');await stop(done.id,'done');
  const final=await settled(done.id);assert.ok(final==='implemented'||final==='review',`went to ${final}, never verified`);
});

test('E9: delegated child tasks show as Delegated cards on an imported parent, and a comment on an imported task is kept for its next run',async t=>{
  const {service,raw}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  await service.invoke('paperclip.import',{companyId:COMPANY});
  await service.invoke('paperclip.config.set',{mode:'off'});
  const ws=await service.invoke('paperclip.snapshot',{});
  const parent=ws.tasks.find(x=>x.key==='RAG-1')!,child=ws.tasks.find(x=>x.key==='RAG-15')!;
  assert.equal(child.parentId,parent.id);
  const detail=await service.invoke('paperclip.task',{id:parent.id});
  const card=detail.cards.find(c=>c.kind==='delegated'&&c.taskId===child.id)!;
  assert.ok(card&&card.kind==='delegated'&&card.key==='RAG-15'&&card.from===parent.assigneeLabel&&card.to===child.assigneeLabel,'who handed which piece to whom');
  // The comment backstop: no run is live, so the comment is kept in the project mailbox for the owner's next run, not lost.
  const comment=await service.invoke('paperclip.comment',{taskId:child.id,body:'Please rebase first.'});
  assert.match(comment.body,/Please rebase first\./);
  const project=(await service.invoke('project.list',undefined)).find(p=>p.name==='OSS Manager')!;
  const mail=await service.invoke('mailbox.list',{projectId:project.id,limit:50});
  assert.ok(mail.messages.some(m=>/Please rebase first\./.test(m.body)&&m.state!=='acked'),'kept in the mailbox');
  void raw;
});
