/** #445: the Dashboard follows the active org, names agents in its activity, and reuses the org's last read. Paperclip is faked. */
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join} from 'node:path';import {test,type TestContext} from 'node:test';
import {createPaperclipDomain} from '../src/runtime/domains/paperclip.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';

const A='a0000000-0000-4000-8000-00000000000a',B='b0000000-0000-4000-8000-00000000000b';
const recent=new Date(Date.now()-2*86_400_000).toISOString();
const issue=(org:string,n:number)=>({id:`${org}-i${n}`,identifier:`X-${n}`,title:`Task ${n}`,status:'todo',priority:'low',projectId:null,createdAt:recent,updatedAt:recent});

function fakeServer(){
  let gate:Promise<void>|null=null,release=()=>{};const reads:string[]=[];
  const org=(id:string,name:string,tasks:number)=>({
    [`/api/companies/${id}/issues`]:()=>Array.from({length:tasks},(_,i)=>issue(id,i+1)),
    [`/api/companies/${id}/agents`]:()=>[{id:`${id}-ag`,name:`${name} Builder`,role:'general',status:'idle',adapterConfig:{}}],
    [`/api/companies/${id}/activity`]:()=>[{id:`${id}-act`,action:'issue.updated',actorType:'agent',actorId:`${id}-ag`,agentId:`${id}-ag`,entityType:'issue',entityId:`${id}-i1`,createdAt:recent,details:{}}],
  });
  const routes:Record<string,()=>unknown>={'/api/health':()=>({status:'ok',version:'1',deploymentMode:'authenticated'}),
    '/api/companies':()=>[{id:A,name:'Alpha',issuePrefix:'A',status:'active'},{id:B,name:'Beta',issuePrefix:'B',status:'active'}],...org(A,'Alpha',3),...org(B,'Beta',1)};
  const fetch=async(input:string)=>{
    const path=new URL(input).pathname;if(path.endsWith('/issues'))reads.push(path);
    if(gate&&path===`/api/companies/${B}/issues`)await gate;
    const route=routes[path];
    return new Response(JSON.stringify(route?route():path.endsWith('/budgets/overview')?{policies:[],activeIncidents:[]}:[]),{status:200,headers:{'content-type':'application/json'}});
  };
  return {fetch,reads,hold(){gate=new Promise(r=>{release=r;});},release(){gate=null;release();}};
}

async function harness(t:TestContext){
  const dataDir=await mkdtemp(join(tmpdir(),'muster-dash-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const {DatabaseSync}=await import('node:sqlite');const db=new DatabaseSync(':memory:');t.after(()=>db.close());
  const values=new Map<string,string>();
  const secrets={status:(id:string)=>({stored:values.has(id),updatedAt:null,secureStorage:true}),get:(id:string)=>values.get(id),set(id:string,v:string){values.set(id,v);return this.status(id);},clear(id:string){values.delete(id);return this.status(id);}};
  const context={dataDir,db:()=>db,store:{snapshot:()=>({folders:[]})},emit:()=>{},hooks:{},async invoke(command:string){
    if(command==='project.list')return [];if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};
    if(command==='memory.browse')return {records:[],status:{connection:'not-configured'}};if(command==='project.stats')return {states:{},byDay:[],runsByDay:[],activity:[]};
    throw new Error(`unexpected ${command}`);}} as unknown as DomainContext;
  const server=fakeServer();
  const domain=createPaperclipDomain(context,{refreshCoalesceMs:0,fetch:server.fetch as never,secrets:()=>secrets as never,timers:{setTimeout:(()=>0) as never,clearTimeout:(()=>{}) as never} as never,socket:()=>{throw new Error('no socket');}});
  t.after(()=>domain.dispose?.());
  const call=(command:string,input:Record<string,unknown>={})=>Promise.resolve(domain.handlers[command]!(input)) as Promise<any>;
  return {server,call};
}
const taskTotal=(dash:any)=>dash.tasksByDay.reduce((n:number,d:any)=>n+Object.values(d.counts as Record<string,number>).reduce((a,b)=>a+b,0),0);

test('#445: switching org while the old org is still being read never leaves the Dashboard on the old org',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local',companyId:B});
  assert.equal((await h.call('paperclip.dashboard',{})).spend.source,'Muster and Beta');
  h.server.hold();
  const slow=h.call('paperclip.snapshot',{refresh:true});// a read of Beta that is still running
  await new Promise(r=>setImmediate(r));
  await h.call('paperclip.config.set',{mode:'local',companyId:A});
  const dash=h.call('paperclip.dashboard',{});
  await new Promise(r=>setImmediate(r));h.server.release();await slow;
  const data=await dash;
  assert.equal(data.spend.source,'Muster and Alpha','the Dashboard asked for after the switch reads the org that is now active');
  assert.equal(taskTotal(data),3,'tasks by day count the active org’s tasks');
  const again=await h.call('paperclip.dashboard',{});
  assert.equal(again.spend.source,'Muster and Alpha','the old org’s late read did not replace the new org');
  assert.equal(taskTotal(again),3);
});

test('#445: Dashboard activity names the agent instead of a raw id',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local',companyId:A});
  const data=await h.call('paperclip.dashboard',{});
  assert.deepEqual(data.activity.map((a:any)=>a.actor),['Alpha Builder']);
  const audit=await h.call('paperclip.list',{kind:'audit'});
  assert.ok(audit.rows.some((r:any)=>r.detail==='Alpha Builder'),'the Activity list names the agent too');
});

test('#445: the Dashboard reuses the org’s last read instead of reading every task page again',async t=>{
  const h=await harness(t);
  await h.call('paperclip.config.set',{mode:'local',companyId:A});
  await h.call('paperclip.snapshot',{refresh:true});
  const before=h.server.reads.length;
  await h.call('paperclip.dashboard',{});
  assert.equal(h.server.reads.length,before,'no issue pages are read again for the Dashboard');
});
