import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test,type TestContext} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';
import {projectRollup,actorLabel} from '../src/renderer/project-rollup.ts';

async function fixture(t:TestContext,provider?:Partial<ProviderAdapter>){
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-admin-'));
 const events:AgentEvent[]=[];
 const base:ProviderAdapter={info:()=>[{id:'hybrow',name:'Fixture',available:true,identityMasked:'fixture',models:[{id:'claude/claude-fable-5',name:'Fixture'}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'ok'}}};
 const service=createAgentService({dataDir,provider:{...base,...provider},onEvent(e){events.push(e)}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=async(name:string)=>{const path=join(dataDir,name);await mkdir(path);return service.invoke('folder.add',{path})};
 return {service,events,folder};
}

test('project.update renames, edits the goal, replaces folders and orders the primary folder first',async t=>{
 const {service,events,folder}=await fixture(t);const a=await folder('a'),b=await folder('b');
 const p=await service.invoke('project.create',{name:'Old',goal:'g',folderIds:[a.id]});
 await assert.rejects(service.invoke('project.update',{id:p.id,name:'  '}),/Name the Project/);
 await assert.rejects(service.invoke('project.update',{id:p.id,folderIds:['missing']}),/Unknown folder/);
 await assert.rejects(service.invoke('project.update',{id:p.id,primaryFolderId:b.id}),/must be attached/);
 const updated=await service.invoke('project.update',{id:p.id,name:'New',goal:'Ship it',folderIds:[a.id,b.id],primaryFolderId:b.id});
 assert.equal(updated.name,'New');assert.equal(updated.goal,'Ship it');assert.deepEqual(updated.folderIds,[b.id,a.id]);assert.equal(updated.primaryFolderId,b.id);
 const snap=await service.invoke('app.snapshot',undefined);const listed=snap.projects.find(x=>x.id===p.id)!;
 assert.equal(listed.name,'New');assert.deepEqual(listed.folderIds,[b.id,a.id],'snapshot readers see the primary folder first');
 assert.ok(events.some(e=>e.type==='projectChanged'&&e.projectId===p.id));
 const activity=await service.invoke('project.activity.list',{projectId:p.id});
 assert.deepEqual(activity.items.map(x=>x.kind).sort(),['project.folder-linked','project.goal','project.primary','project.rename']);
 assert.ok(activity.items.every(x=>x.actor==='user'));
 const unlinked=await service.invoke('project.unlinkFolder',{id:p.id,folderId:b.id});
 assert.deepEqual(unlinked.folderIds,[a.id]);assert.equal(unlinked.primaryFolderId,a.id,'removing the primary promotes the next folder');
 await assert.rejects(service.invoke('project.unlinkFolder',{id:p.id,folderId:b.id}),/not attached/);
});

test('linking an existing folder later works; unlinking a folder with a running project chat is refused',async t=>{
 let release:()=>void=()=>{};let dispatched=false;
 const {service,folder}=await fixture(t,{run:()=>{dispatched=true;return new Promise(resolve=>{release=()=>resolve({status:'completed',finalMessage:'done'})});}});
 const a=await folder('a'),b=await folder('b');
 const p=await service.invoke('project.create',{name:'P',goal:'',folderIds:[a.id]});
 const linked=await service.invoke('project.linkFolder',{id:p.id,folderId:b.id,primary:true});
 assert.deepEqual(linked.folderIds,[b.id,a.id]);
 const chat=await service.invoke('chat.create',{folderId:a.id,projectId:p.id});
 await service.invoke('chat.send',{id:chat.id,text:'go',requestId:'r1'});
 const running=async()=>(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===chat.id)?.status;
 for(let i=0;i<500&&await running()!=='running';i++)await new Promise(r=>setImmediate(r));
 assert.equal(await running(),'running');
 // 'running' marks an accepted send, before the provider is actually dispatched (prompt/run-option
 // hooks run first); wait for the fixture's run() so `release` below resolves the live attempt, not a stale closure.
 for(let i=0;i<500&&!dispatched;i++)await new Promise(r=>setImmediate(r));
 await assert.rejects(service.invoke('project.unlinkFolder',{id:p.id,folderId:a.id}),/is running in a.*Stop it/);
 await assert.rejects(service.invoke('project.update',{id:p.id,folderIds:[b.id]}),/Stop it/);
 await assert.rejects(service.invoke('project.delete',{id:p.id}),/running chat/);
 assert.deepEqual((await service.invoke('project.unlinkFolder',{id:p.id,folderId:b.id})).folderIds,[a.id],'an idle folder can still go');
 release();
 for(let i=0;i<500&&await running()==='running';i++)await new Promise(r=>setImmediate(r));
 assert.deepEqual((await service.invoke('project.unlinkFolder',{id:p.id,folderId:a.id})).folderIds,[]);
});

test('archive previews affected chats and tasks, suspends dispatch, and restore resumes it',async t=>{
 const {service,folder}=await fixture(t);const a=await folder('a');
 const p=await service.invoke('project.create',{name:'P',goal:'',folderIds:[a.id]});
 await service.invoke('chat.create',{folderId:a.id,projectId:p.id});
 const task=await service.invoke('project.tasks.create',{projectId:p.id,title:'Build',acceptance:'',dependencies:[]});
 await service.invoke('project.tasks.create',{projectId:p.id,title:'Verify',acceptance:'',dependencies:[]});
 const preview=await service.invoke('project.preview',{id:p.id});
 assert.equal(preview.chats.total,1);assert.equal(preview.chats.running,0);assert.equal(preview.tasks.total,2);assert.equal(preview.tasks.open,2);
 assert.deepEqual(preview.tasks.items.map(x=>x.title).sort(),['Build','Verify']);
 const archived=await service.invoke('project.archive',{id:p.id});assert.equal(archived.archived,true);assert.ok(archived.archivedAt);
 await assert.rejects(service.invoke('project.tasks.start',{projectId:p.id,id:task.id,revision:0,requestId:'r1'}),/archived/);
 assert.equal((await service.invoke('project.list',undefined)).find(x=>x.id===p.id)?.archived,true);
 const restored=await service.invoke('project.restore',{id:p.id});assert.equal(restored.archived,false);
 const started=await service.invoke('project.tasks.start',{projectId:p.id,id:task.id,revision:0,requestId:'r2'});
 assert.ok(started.chatId);
});

test('delete detaches chats, keeps their data and removes project work',async t=>{
 const {service,folder}=await fixture(t);const a=await folder('a');
 const p=await service.invoke('project.create',{name:'P',goal:'',folderIds:[a.id]});
 const chat=await service.invoke('chat.create',{folderId:a.id,projectId:p.id});
 await service.invoke('project.tasks.create',{projectId:p.id,title:'Build',acceptance:'',dependencies:[]});
 assert.deepEqual(await service.invoke('project.delete',{id:p.id}),{deleted:true,detachedChats:1});
 const snap=await service.invoke('app.snapshot',undefined);
 assert.ok(!snap.projects.some(x=>x.id===p.id));
 const kept=snap.chats.find(c=>c.id===chat.id);assert.ok(kept);assert.equal(kept.projectId,undefined);assert.equal(kept.folderId,a.id);
 await assert.rejects(service.invoke('project.preview',{id:p.id}),/Project not found/);
});

test('overview rollup counts task states, needs-input chats, and maps internal actors',()=>{
 const tasks=[{status:'running'},{status:'blocked'},{status:'implemented'},{status:'verified'},{status:'verified'},{status:'todo'}] as {status:'todo'|'running'|'blocked'|'implemented'|'verified'}[];
 const r=projectRollup(tasks,['c1','c2'],{totalRequests:2,chats:[{chatId:'c1',chatTitle:'x',approvalCount:1,questionCount:0,requests:[]},{chatId:'other',chatTitle:'y',approvalCount:1,questionCount:0,requests:[]}]});
 assert.deepEqual(r,{running:1,blocked:1,needsInput:1,implemented:1,verified:2,todo:1,total:6});
 assert.equal(actorLabel('main'),'You');assert.equal(actorLabel('user'),'You');assert.equal(actorLabel('agent'),'Agent');assert.equal(actorLabel('system'),'Muster');
});
