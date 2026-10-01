// Manual regression probe of the upgrade path (scenarios a: own same-name project with a task of yours, filled, b: import-made renamed, c: import-made then paused, d: touched scheduler then filled).
// Phase 1 runs on a checkout of release/0.3.0, phase 2 and 3 on this branch, same data dir. The permanent checks are "upgrade M1a-M1f" and "upgrade M2" in tests/paperclip-import.test.ts.
// usage: node --experimental-transform-types migrate.ts <repoRoot> <dataDir> <phase:1|2> <ownName>
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
const [repoRoot,dataDir,phase,scenario]=process.argv.slice(2);const ownName=scenario==='a'?'OSS Manager':'Mine';
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
const find=async(n:string)=>(await service.invoke('project.list',undefined)).find((p:any)=>p.name===n);
if(phase==='1'){
  if(scenario==='a'||scenario==='d'){
    const own=await service.invoke('project.create',{name:ownName,goal:'My own goal',folderIds:[]});
    if(scenario==='d') await service.invoke('project.scheduler.set',{projectId:own.id,concurrency:3});
    await service.invoke('project.tasks.add',{projectId:own.id,title:'my own task',acceptance:'',dependencies:[]}).catch(()=>{});
    if(scenario==='d'){ /* within seconds: import into it */ }
    const r=await service.invoke('paperclip.import',{companyId:COMPANY,targets:{[oss.id]:own.id}});
    console.log('phase1 report',JSON.stringify(r.projects),JSON.stringify(r.filled));
  } else {
    const r=await service.invoke('paperclip.import',{companyId:COMPANY});
    console.log('phase1 report',JSON.stringify(r.projects));
    const p=await find('OSS Manager');
    if(scenario==='b') await service.invoke('project.update',{id:p.id,name:'Renamed OSS',goal:'my goal'});
    if(scenario==='c') { await new Promise(r=>setTimeout(r,1500)); await service.invoke('project.scheduler.set',{projectId:p.id,paused:true}); }
  }
  await dump('after-0.3.0');
}else if(phase==='2'){
  const plan=await service.invoke('paperclip.import.plan',{companyId:COMPANY});
  console.log('plan',JSON.stringify(plan.projects.map((p:any)=>[p.name,p.existing])));
  const r=await service.invoke('paperclip.import',{companyId:COMPANY});
  console.log('phase2 report',JSON.stringify(r.projects),JSON.stringify(r.tasks),'comments',r.comments,'conflicts',r.conflicts.length,JSON.stringify(r.notes.filter((n:string)=>/earlier/.test(n))));
  await dump('after-PR');
  const db=new DatabaseSync(join(dataDir,'muster-agent.sqlite'));
  for(const p of await service.invoke('project.list',undefined)){const w=await service.invoke('project.work',{projectId:p.id});const s=await service.invoke('paperclip.snapshot',{});
    const ts=s.tasks.filter((t:any)=>t.projectId===p.id);console.log('meta',p.name,JSON.stringify({keys:ts.filter((t:any)=>t.key&&/-\d+$/.test(t.key)).length,withParent:ts.filter((t:any)=>t.parentId).length,roster:s.agents.filter((a:any)=>a.projectId===p.id).length,tasks:ts.length}));}
  db.close();
  console.log('non-GET calls',calls.filter(c=>!c.startsWith('GET')).length);
}else{
  // phase 3: delete the Paperclip-made OSS Manager project and re-import
  const p=(await service.invoke('project.list',undefined)).filter((x:any)=>x.name===(process.env.PNAME??'OSS Manager')).pop();
  const w=await service.invoke('project.work',{projectId:p.id});
  await service.invoke('project.delete',{id:p.id});
  const r=await service.invoke('paperclip.import',{companyId:COMPANY});
  console.log('phase3 report',JSON.stringify(r.projects),JSON.stringify(r.tasks),'comments',r.comments);
  await dump('after-delete-reimport');
}
await service.dispose();
