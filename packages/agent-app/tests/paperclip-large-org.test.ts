/** Large Paperclip orgs (F1, F2, C12, C13, #181): issues and comments are read page by page with no hard cap, a re-import of a
 *  project with more than 200 tasks creates no duplicate and applies every status, and an issue with 500+ comments is fully read. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

const COMPANY='c0000000-0000-4000-8000-0000000000aa',PROJECT='p0000000-0000-4000-8000-0000000000aa',AGENT='a0000000-0000-4000-8000-0000000000aa';
type Json=Record<string,any>;
const STATUSES=['todo','done','in_review','blocked','backlog','cancelled'];
const N=1_250,COMMENTS=530;

async function fixture(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-pc-large-'));
  const issues:Json[]=Array.from({length:N},(_,i)=>({id:`i${String(i).padStart(5,'0')}`,identifier:`BIG-${i+1}`,title:`Task ${i+1}`,description:'',status:STATUSES[i%STATUSES.length],priority:'medium',projectId:PROJECT,assigneeAgentId:AGENT,createdAt:new Date(Date.UTC(2026,8,1,0,0,i)).toISOString(),updatedAt:new Date(Date.UTC(2026,8,1,0,0,i)).toISOString(),labels:[]}));
  const comments:Json[]=Array.from({length:COMMENTS},(_,i)=>({id:`c${String(i).padStart(5,'0')}`,issueId:issues[0].id,body:`Comment ${i+1}`,authorUserId:'local-board',createdAt:new Date(Date.UTC(2026,8,2,0,0,i)).toISOString()}));
  const requests:{path:string;limit:number|null;offset:number|null;after:string|null}[]=[];
  const realFetch=globalThis.fetch;
  globalThis.fetch=(async(input:string|URL,init:RequestInit={})=>{
    const url=new URL(String(input)),path=url.pathname.replace(/^\/api/,''),q=url.searchParams;
    if((init.method??'GET')!=='GET')return new Response('{"error":"read only"}',{status:405});
    const json=(v:unknown)=>new Response(JSON.stringify(v),{status:200,headers:{'content-type':'application/json'}});
    const limit=q.get('limit')?Number(q.get('limit')):null,offset=q.get('offset')?Number(q.get('offset')):null;
    if(path==='/companies')return json([{id:COMPANY,name:'BigCo',issuePrefix:'BIG',status:'active'}]);
    if(path===`/companies/${COMPANY}/issues`){requests.push({path,limit,offset,after:null});const sorted=[...issues].sort((a,b)=>a.id.localeCompare(b.id));return json(sorted.slice(offset??0,(offset??0)+Math.min(limit??500,1000)));}
    if(path===`/companies/${COMPANY}/projects`)return json([{id:PROJECT,name:'Big project',description:'A big one',codebase:{}}]);
    if(path===`/companies/${COMPANY}/agents`)return json([{id:AGENT,name:'Atlas',role:'engineer',title:'Lead',status:'idle',adapterType:'process',adapterConfig:{}}]);
    if(path===`/companies/${COMPANY}/heartbeat-runs`||path===`/companies/${COMPANY}/live-runs`||path===`/companies/${COMPANY}/goals`||path===`/companies/${COMPANY}/approvals`||path===`/companies/${COMPANY}/labels`)return json([]);
    if(path===`/companies/${COMPANY}/attention`)return json({items:[]});
    const c=/^\/issues\/([^/]+)\/comments$/.exec(path);
    if(c){const after=q.get('after');requests.push({path,limit,offset,after});const from=after?comments.findIndex(x=>x.id===after)+1:0;return json(c[1]===issues[0].id?comments.slice(from,from+Math.min(limit??500,500)):[]);}
    const one=/^\/issues\/([^/]+)$/.exec(path);
    if(one){const issue=issues.find(i=>i.id===one[1]);return issue?json(issue):new Response('{"error":"not found"}',{status:404});}
    if(/^\/issues\/[^/]+\/(runs|interactions|approvals|documents|work-products)$/.test(path))return json([]);
    return new Response('{"error":"not found"}',{status:404});
  }) as typeof fetch;
  const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:'m',name:'m'}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'done'};}};
  const service=createAgentService({dataDir,provider,onEvent(){}});
  t.after(async()=>{globalThis.fetch=realFetch;await service.dispose();await rm(dataDir,{recursive:true,force:true});});
  return {service,issues,comments,requests};
}

test('F1/F2: a linked org with more than 1000 issues and an issue with 500+ comments shows every one (paged, no hard cap)',async t=>{
  const {service,requests}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const snap=await service.invoke('paperclip.snapshot',{});
  assert.equal(snap.tasks.filter(x=>x.source==='paperclip').length,N,'every issue is listed');
  assert.equal(snap.paperclip?.stale,undefined);
  const pages=requests.filter(r=>/issues$/.test(r.path));
  assert.ok(pages.length>=2&&pages.every(r=>(r.limit??0)<=1000),'issues arrive in pages of at most 1000');
  assert.deepEqual(pages.slice(0,2).map(r=>r.offset??0),[0,1000],'the next page starts where the last ended');
  const detail=await service.invoke('paperclip.task',{id:'i00000'});
  assert.equal(detail.comments.length,COMMENTS,'every comment is shown');
  assert.equal(detail.comments[0].body,'Comment 1');assert.equal(detail.comments.at(-1)!.body,`Comment ${COMMENTS}`,'oldest first, in order');
});

test('C12/C13: a project of more than 1000 tasks imports once, re-imports with zero duplicates and every status applied, comments fully read; timing is reported',async t=>{
  const {service,issues,requests}=await fixture(t);
  await service.invoke('paperclip.config.set',{mode:'local',companyId:COMPANY});
  const first=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.equal(first.tasks.created,N,'every issue becomes a task');assert.equal(first.issues,N);
  assert.equal(first.comments,COMMENTS,'all comments of the big issue are imported');
  assert.ok(first.tookMs>0);
  const project=(await service.invoke('project.list',undefined)).find(p=>p.name==='Big project')!;
  const tasks=async()=>(await service.invoke('project.work',{projectId:project.id,activityLimit:1})).tasks;
  const afterFirst=await tasks();
  assert.equal(afterFirst.items.length,N);assert.equal(afterFirst.truncated,false);
  const stateOf=(status:string)=>({todo:'todo',backlog:'todo',in_review:'review',blocked:'blocked',done:'verified',cancelled:'cancelled'} as Record<string,string>)[status];
  const wrong=afterFirst.items.filter(x=>x.state!==stateOf(issues[Number(x.title.slice(5))-1].status));
  assert.deepEqual(wrong.map(x=>x.title),[],'every task, past the 200th too, carries Paperclip’s status');
  // Paperclip moves a few tasks; the re-import applies them everywhere and adds nothing.
  for(const i of [3,250,999,1200])issues[i].status='cancelled';
  requests.length=0;
  const again=await service.invoke('paperclip.import',{companyId:COMPANY});
  assert.equal(again.tasks.created,0,'zero duplicates');assert.equal(again.tasks.updated,N);assert.equal(again.comments,0);
  const afterAgain=await tasks();
  assert.equal(afterAgain.items.length,N,'still exactly one task per issue');
  for(const i of [3,250,999,1200])assert.equal(afterAgain.items.find(x=>x.title===`Task ${i+1}`)!.state,'cancelled',`task ${i+1}`);
  console.log(`large org: first import ${first.tookMs} ms, re-import ${again.tookMs} ms for ${N} issues, ${COMMENTS} comments; RSS ${Math.round(process.memoryUsage().rss/1e6)} MB`);
});
