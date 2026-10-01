// Manual probe of the upgrade path: run phase 1 on a checkout of release/0.3.0 (the old "import into your project" flow), then phase 2 on this branch,
// against the same data dir. The permanent version of these checks is "upgrade M1a/M1b/M2" in tests/paperclip-import.test.ts.
// usage: node --experimental-transform-types migrate.ts <repoRoot> <dataDir> <phase:1|2> <ownName>
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const [repoRoot,dataDir,phase,ownName]=process.argv.slice(2);
const app=join(repoRoot,'packages/agent-app');
const {createAgentService}=await import(join(app,'src/runtime/service.ts'));
const COMPANY='0436ce61-f1eb-44c3-96a9-eb171b93a49a';
const raw=JSON.parse(await readFile(join(app,'tests/fixtures/paperclip-rag/company.json'),'utf8'));
const calls:string[]=[];
globalThis.fetch=(async(input:any,init:any={})=>{
  const url=new URL(String(input)),path=url.pathname.replace(/^\/api/,''),q=url.searchParams,method=init.method??'GET';calls.push(method+' '+path);
  if(method!=='GET')return new Response('{}',{status:405});
  const base=`/companies/${COMPANY}`;let body:any;
  if(path==='/companies')body=raw.companies;else if(path===`${base}/projects`)body=raw.projects;else if(path===`${base}/agents`)body=raw.agents;
  else if(path===`${base}/issues`)body=Number(q.get('offset')??0)>0?[]:raw.issues;else if(path===`${base}/goals`)body=raw.goals;else if(path===`${base}/approvals`)body=raw.approvals;
  else {const m=/^\/issues\/([^/]+)\/(comments|interactions|approvals)$/.exec(path);if(m)body=q.get('after')?[]:raw.perIssue[decodeURIComponent(m[1])]?.[m[2]]??[];else if(/^\/issues\/[^/]+$/.test(path))body=raw.issues.find((i:any)=>i.id===path.split('/')[2]);}
  return body===undefined?new Response('{"error":"nf"}',{status:404}):new Response(JSON.stringify(body),{status:200,headers:{'content-type':'application/json'}});
}) as any;
const provider={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:'m',name:'m'}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'done'};}};
const service=createAgentService({dataDir,provider,onEvent(){}});
const oss=raw.projects.find((p:any)=>p.name==='OSS Manager');
const dump=async(label:string)=>{
  const projects=await service.invoke('project.list',undefined);
  const db=new DatabaseSync(join(dataDir,'muster-agent.sqlite'));
  for(const p of projects){
    const w=await service.invoke('project.work',{projectId:p.id});
    const ids=w.tasks.items.map((t:any)=>t.id);
    const comments=ids.length?(db.prepare(`SELECT count(*) n FROM paperclip_import_comments WHERE task_id IN (${ids.map(()=>'?').join(',')})`).get(...ids) as any).n:0;
    const mapped=ids.length?(db.prepare(`SELECT count(*) n FROM paperclip_import_map WHERE kind='task' AND muster_id IN (${ids.map(()=>'?').join(',')})`).get(...ids) as any).n:0;
    const hist=(db.prepare(`SELECT count(*) n FROM paperclip_import_history WHERE project_id=?`).get(p.id) as any).n;
    console.log(label,JSON.stringify({name:p.name,goal:p.goal.slice(0,40),tasks:ids.length,importComments:comments,tasksStillMapped:mapped,history:hist}));
  }
  const snap=await service.invoke('paperclip.snapshot',{});
  console.log(label,'orgs',JSON.stringify(snap.projects.map((p:any)=>[p.name,p.org??null])));
  db.close();
};
await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
if(phase==='1'){
  const own=await service.invoke('project.create',{name:ownName,goal:'My own goal',folderIds:[]});
  const r=await service.invoke('paperclip.import',{companyId:COMPANY,targets:{[oss.id]:own.id}});
  console.log('phase1 report',JSON.stringify(r.projects),JSON.stringify(r.filled));
  await dump('after-0.3.0-import');
}else{
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  console.log('plan',JSON.stringify(plan.projects.map((p:any)=>[p.name,p.existing])));
  const r=await service.invoke('paperclip.import',{companyId:COMPANY});
  console.log('phase2 report',JSON.stringify(r.projects),JSON.stringify(r.tasks),'comments',r.comments,JSON.stringify(r.notes.filter((n:string)=>/earlier/.test(n))));
  await dump('after-PR-import');
  console.log('non-GET calls',calls.filter(c=>!c.startsWith('GET')).length);
}
await service.dispose();
