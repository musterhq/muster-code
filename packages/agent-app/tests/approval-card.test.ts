import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {approvalData,createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

async function approvalRun(t:import('node:test').TestContext,method:string,params:Record<string,unknown>,decision:'accept'|'acceptForSession'|'decline',events:Array<[string,Record<string,unknown>]>=[]) {
 const dataDir=await mkdtemp(join(tmpdir(),'muster-approval-'));let response:unknown;
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}],stop:async()=>true,dispose(){},async run(input){
  for(const [m,p] of events)input.onEvent(m,p);
  response=await input.onRequest(method,params);return{status:'completed',finalMessage:'done'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 let item;for(let i=0;i<100&&!item;i++){item=(await service.invoke('chat.select',{id:chat.id})).find(c=>c.kind==='approval');if(!item)await delay(2);}
 assert.ok(item);
 await service.invoke('approval.respond',{id:item.id,approved:decision!=='decline',decision});
 for(let i=0;i<100&&response===undefined;i++)await delay(2);
 return {response,item:(await service.invoke('chat.select',{id:chat.id})).find(c=>c.id===item.id)!};
}

test('approve for this session forwards acceptForSession and records a readable scope',async t=>{
 const {response,item}=await approvalRun(t,'item/commandExecution/requestApproval',{itemId:'cmd',command:'npm test',cwd:'/work/app',reason:'Runs the suite'},'acceptForSession');
 assert.deepEqual(response,{decision:'acceptForSession'});
 assert.equal(item.status,'approved-session');
 assert.equal(item.data?.kind,'command');assert.equal(item.data?.command,'npm test');assert.equal(item.data?.cwd,'/work/app');
});

test('a plain approve stays one-shot and deny declines',async t=>{
 assert.deepEqual((await approvalRun(t,'item/commandExecution/requestApproval',{command:'ls'},'accept')).response,{decision:'accept'});
 const denied=await approvalRun(t,'item/commandExecution/requestApproval',{command:'rm -rf build'},'decline');
 assert.deepEqual(denied.response,{decision:'decline'});assert.equal(denied.item.status,'declined');
});

test('a file change approval carries the provider diff from its fileChange item',async t=>{
 const change={path:'src/a.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'};
 const {item}=await approvalRun(t,'item/fileChange/requestApproval',{itemId:'fc1'},'accept',[['item/started',{item:{id:'fc1',type:'fileChange',changes:[change]}}]]);
 assert.equal(item.data?.kind,'fileChange');
 assert.deepEqual(item.data?.diff,[change]);
});

test('mcp approval data names the server, tool and arguments',()=>{
 const data=approvalData('item/mcpToolCall/requestApproval',{server:'github',tool:'create_issue',arguments:{title:'Bug'}});
 assert.equal(data.kind,'mcp');assert.equal(data.server,'github');assert.equal(data.tool,'create_issue');assert.match(data.args??'',/"title": "Bug"/);
});

/** Computer-use permission prompts (MCP elicitations) must route through the same approval-card
 *  machinery as command/fileChange/mcpToolCall approvals: accepted immediately in full access,
 *  surfaced and answered back through approval.respond in workspace access, and declined
 *  immediately in read-only access — never left unanswered at the provider. */
async function elicitationRun(t:import('node:test').TestContext,permissionMode:'full'|'workspace'|'read-only',decision:'accept'|'decline'='accept') {
 const dataDir=await mkdtemp(join(tmpdir(),'muster-elicit-'));let response:unknown;
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}],stop:async()=>true,dispose(){},async run(input){
  response=await input.onRequest('mcpServer/elicitation/request',{message:'Allow Mail control?',serverName:'computer-use'});return{status:'completed',finalMessage:'done'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});
 await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode,...(permissionMode==='full'?{acknowledgeFullAccess:true}:{})});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 let item;
 if(permissionMode==='workspace'){
  for(let i=0;i<100&&!item;i++){item=(await service.invoke('chat.select',{id:chat.id})).find(c=>c.kind==='approval');if(!item)await delay(2);}
  assert.ok(item,'an approval card is created for the elicitation');
  assert.equal(item!.data?.kind,'mcp');assert.equal(item!.data?.server,'computer-use');assert.equal(item!.data?.reason,'Allow Mail control?');
  await service.invoke('approval.respond',{id:item!.id,approved:decision!=='decline',decision});
 }
 for(let i=0;i<100&&response===undefined;i++)await delay(2);
 return {response,item,items:await service.invoke('chat.select',{id:chat.id})};
}

test('full access auto-accepts a computer-use elicitation without asking',async t=>{
 const {response,items}=await elicitationRun(t,'full');
 assert.deepEqual(response,{action:'accept',content:{}});
 assert.ok(!items.some(i=>i.kind==='approval'),'no approval card is shown when access is already unrestricted');
});

test('read-only access auto-declines a computer-use elicitation without asking',async t=>{
 const {response,items}=await elicitationRun(t,'read-only');
 assert.deepEqual(response,{action:'decline',content:null});
 assert.ok(!items.some(i=>i.kind==='approval'));
});

test('workspace access surfaces a computer-use elicitation as an approval card and routes accept back as the elicitation envelope',async t=>{
 const {response,item,items}=await elicitationRun(t,'workspace','accept');
 assert.deepEqual(response,{action:'accept',content:{}});
 assert.equal(items.find(i=>i.id===item?.id)?.status,'approved');
});

test('workspace access routes a decline back as the elicitation envelope',async t=>{
 const {response,item,items}=await elicitationRun(t,'workspace','decline');
 assert.deepEqual(response,{action:'decline',content:null});
 assert.equal(items.find(i=>i.id===item?.id)?.status,'declined');
});

test('F60: a started command blocked on approval is flagged as waiting, and the flag clears on decision',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-approval-'));let release!:()=>void;const released=new Promise<void>(resolve=>{release=resolve;});
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'Hidden',models:[]}],stop:async()=>true,dispose(){},async run(input){
  input.onEvent('item/started',{item:{id:'cmd1',type:'commandExecution',command:'npm view hono version'}});
  await input.onRequest('item/commandExecution/requestApproval',{itemId:'cmd1',command:'npm view hono version'});
  await released;
  input.onEvent('item/completed',{item:{id:'cmd1',type:'commandExecution',command:'npm view hono version',exitCode:0,aggregatedOutput:'4.13.8'}});
  return{status:'completed',finalMessage:'done'};
 }};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true});});
 const chat=await service.invoke('chat.create',{});await service.invoke('chat.setPermissionMode',{id:chat.id,permissionMode:'workspace'});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:randomUUID()});
 const read=()=>service.invoke('chat.select',{id:chat.id});
 let approval;for(let i=0;i<200&&!approval;i++){approval=(await read()).find(c=>c.kind==='approval');if(!approval)await delay(2);}
 assert.ok(approval);
 const tool=(await read()).find(c=>c.kind==='tool')!;
 assert.equal(tool.status,'running');
 assert.equal(tool.data?.awaitingApproval,approval.id,'the running row knows it is blocked on this card');
 assert.equal(approval.data?.toolItemId,tool.id);
 await service.invoke('approval.respond',{id:approval.id,approved:true,decision:'accept'});
 const after=(await read()).find(c=>c.id===tool.id)!;
 assert.equal(after.data?.awaitingApproval,undefined,'approving clears the waiting state; the row reads Running again');
 release();
 let done;for(let i=0;i<200;i++){done=(await read()).find(c=>c.id===tool.id);if(done?.status==='completed')break;await delay(2);}
 assert.equal(done?.status,'completed');assert.equal(done?.data?.awaitingApproval,undefined);
});
