import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {test,type TestContext} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import {AgentStore} from '../src/runtime/store.ts';
import {createDomainHooks} from '../src/runtime/domains/hooks.ts';
import {createProjectsDomain} from '../src/runtime/domains/projects.ts';
import type {DomainContext} from '../src/runtime/domains/types.ts';
import {type ProviderAdapter} from '../src/runtime/provider.ts';
/** A fixture model id: tests never depend on a particular provider's catalog. */
const MODEL='fixture-model';
import {ACTIVITY_CATEGORY_SQL} from '../src/runtime/project-tasks.ts';
import {activityCategory,activityWindowStart,composeAccess,memberAccess,type ProjectMember} from '../src/shared/domains/project-team-protocol.ts';

async function fixture(t:TestContext){
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-team-'));
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:MODEL,name:MODEL}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'done'}}};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=async(name:string)=>{const path=join(dataDir,name);await mkdir(path);return service.invoke('folder.add',{path})};
 const settle=async(chatId:string)=>{for(let i=0;i<2000;i++){const c=(await service.invoke('app.snapshot',undefined)).chats.find(x=>x.id===chatId);if(c&&c.status!=='running'&&c.status!=='stopping')return c;await new Promise(r=>setTimeout(r,2));}throw new Error('run did not settle');};
 return {service,folder,settle,dataDir};
}

test('activityCategory and its SQL twin agree on every kind the app records (PRJ-11)',()=>{
 const kinds=['task.create','task.edit','task.status','task.verified','task.run-started','task.run-failed','task.run-recovered','task.budget-exceeded','task.needs-input','decision.create','decision.supersede','coordinator.applied','project.coordinator','project.rename','project.scheduler','memory.saved','memory.deleted','environment.set','environment.worktree-created','chat.moved-in','member.added','member.revoked','something.else'];
 const db=new DatabaseSync(':memory:');
 for(const kind of kinds){const row=db.prepare(`SELECT ${ACTIVITY_CATEGORY_SQL} AS c FROM (SELECT ? AS kind)`).get(kind) as {c:string};assert.equal(row.c,activityCategory(kind),kind);}
 db.close();
 assert.equal(activityWindowStart('any'),null);
 assert.equal(activityWindowStart('24h',Date.parse('2026-09-23T12:00:00Z')),'2026-09-22T12:00:00.000Z');
});

test('project.activity.query filters by type, actor and time and pages with a stable cursor (PRJ-11)',async t=>{
 const {service,folder}=await fixture(t);const a=await folder('a');
 const p=await service.invoke('project.create',{name:'Filters',goal:'',folderIds:[a.id]});
 for(let i=0;i<5;i++)await service.invoke('project.tasks.add',{projectId:p.id,title:`Task ${i}`,acceptance:'',dependencies:[]});
 await service.invoke('project.decisions.add',{projectId:p.id,title:'Use SQLite',rationale:'',scope:'',relatedTaskIds:[]});
 await service.invoke('project.update',{id:p.id,name:'Filters 2'});
 const all=await service.invoke('project.activity.query',{projectId:p.id});
 assert.equal(all.items.length,7);assert.equal(all.truncated,false);assert.equal(all.nextCursor,null);assert.deepEqual(all.actors,['user']);
 const tasks=await service.invoke('project.activity.query',{projectId:p.id,categories:['tasks']});
 assert.equal(tasks.items.length,5);assert.ok(tasks.items.every(x=>x.kind==='task.create'));
 const mixed=await service.invoke('project.activity.query',{projectId:p.id,categories:['decisions','project']});
 assert.deepEqual(mixed.items.map(x=>x.kind).sort(),['decision.create','project.rename']);
 assert.equal((await service.invoke('project.activity.query',{projectId:p.id,actors:['scheduler']})).items.length,0,'no fabricated rows for an actor that never wrote');
 assert.equal((await service.invoke('project.activity.query',{projectId:p.id,window:'24h'})).items.length,7);
 // Keyset paging: pages never overlap and together cover everything once.
 const first=await service.invoke('project.activity.query',{projectId:p.id,limit:3});
 assert.equal(first.items.length,3);assert.equal(first.truncated,true);assert.ok(first.nextCursor);
 const second=await service.invoke('project.activity.query',{projectId:p.id,limit:3,before:first.nextCursor!});
 const third=await service.invoke('project.activity.query',{projectId:p.id,limit:3,before:second.nextCursor!});
 const ids=[...first.items,...second.items,...third.items].map(x=>x.id);
 assert.equal(new Set(ids).size,7);assert.deepEqual(ids,all.items.map(x=>x.id));assert.equal(third.nextCursor,null);
 await assert.rejects(service.invoke('project.activity.query',{projectId:p.id,categories:['nope' as never]}),/Invalid activity types/);
 await assert.rejects(service.invoke('project.activity.query',{projectId:p.id,before:'garbage'}),/Invalid activity cursor/);
 await assert.rejects(service.invoke('project.activity.query',{projectId:p.id,window:'1y' as never}),/Invalid time window/);
});

test('memory saves into a Project are logged as activity; saves elsewhere are not (PRJ-11)',async t=>{
 // Drives the projects domain's command observer directly: the bundled memory engine is CommonJS-only under node tests.
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-memory-'));const store=new AgentStore(dataDir);const runtime=createDomainHooks();
 const folder=store.addFolder(dataDir,'repo'),project=store.createProject('Mem','',[folder.id]),chat=store.createChat({folderId:folder.id,projectId:project.id,model:'m',mode:'agent'}),loose=store.createChat({folderId:folder.id,model:'m',mode:'agent'});
 const context:DomainContext={dataDir,store,db:()=>store.database(),emit(){},emitSnapshot(){},folderFor:id=>store.folder(id)!,invoke:(async()=>{throw new Error('unused')}) as DomainContext['invoke'],hooks:runtime.hooks};
 const domain=createProjectsDomain(context);
 t.after(async()=>{await domain.dispose?.();store.close();await rm(dataDir,{recursive:true,force:true})});
 const ok={local:{id:'m1'},hindsight:'skipped'};
 runtime.commandCompleted({command:'memory.rememberText',input:{folderId:`project:${project.id}`,text:'Deploys go through the   staging gate first.'},output:ok});
 runtime.commandCompleted({command:'memory.rememberText',input:{chatId:chat.id,folderId:folder.id,text:'Folder fact'},output:ok});
 runtime.commandCompleted({command:'memory.rememberText',input:{chatId:loose.id,text:'Not in a project'},output:ok});
 runtime.commandCompleted({command:'memory.rememberText',input:{folderId:`project:${project.id}`,text:'failed save'},output:{hindsight:'failed'}});
 runtime.commandCompleted({command:'memory.delete',input:{folderId:`project:${project.id}`,id:'m1'},output:{deleted:true}});
 runtime.commandCompleted({command:'sandbox.chatEnvironment.set',input:{chatId:chat.id,env:'sandbox',mode:'copy'},output:{}});
 runtime.commandCompleted({command:'sandbox.applyToHost',input:{chatId:chat.id,paths:['a','b']},output:{applied:['a','b']}});
 const query=(categories:string[])=>domain.handlers['project.activity.query']!({projectId:project.id,categories}) as {items:{kind:string;summary:string;refId:string|null}[]};
 const memory=query(['memory']).items;
 assert.deepEqual(memory.map(x=>x.kind).sort(),['memory.deleted','memory.saved','memory.saved'],'failed saves and non-Project saves are not logged');
 assert.ok(memory.some(x=>x.summary==='Saved a note to Project memory: “Deploys go through the staging gate first.”'));
 assert.ok(memory.some(x=>x.refId===chat.id&&/to repo memory/.test(x.summary)));
 const env=query(['environment']).items;
 assert.deepEqual(env.map(x=>x.kind).sort(),['environment.applied','environment.set']);
 assert.ok(env.some(x=>/Applied 2 files/.test(x.summary)));assert.ok(env.some(x=>/now runs in a sandbox \(copy\)/.test(x.summary)));
});

test('a worktree created on a Project folder is logged through the service command hook (PRJ-11)',async t=>{
 const {service,folder}=await fixture(t);const a=await folder('repo');
 const p=await service.invoke('project.create',{name:'Env',goal:'',folderIds:[a.id]});
 const git=(...args:string[])=>execFileSync('git',args,{cwd:a.path,stdio:'pipe'});
 git('init','-q');git('config','user.email','t@example.com');git('config','user.name','T');await writeFile(join(a.path,'f.txt'),'x');git('add','.');git('commit','-qm','init');
 await service.invoke('git.worktree.create',{folderId:a.id,branch:'feature-x'});
 const env=await service.invoke('project.activity.query',{projectId:p.id,categories:['environment']});
 assert.equal(env.items.length,1);assert.equal(env.items[0]!.kind,'environment.worktree-created');assert.match(env.items[0]!.summary,/feature-x in repo/);
});

const member=(over:Partial<ProjectMember>):ProjectMember=>({id:'m',projectId:'p',name:'M',kind:'person',role:'editor',maxPermission:null,folderIds:null,secrets:[],revokedAt:null,local:false,createdAt:'',updatedAt:'',...over});
test('access composes by intersection: a shared coordinator cannot lend one member another member’s secrets or repos (PRJ-13)',()=>{
 const policy={permissionMode:'full' as const,folderIds:['f1','f2','f3']};
 const alice=memberAccess(member({id:'alice',role:'owner',folderIds:['f1','f2'],secrets:['ALICE_TOKEN','SHARED']}),policy);
 const bob=memberAccess(member({id:'bob',role:'editor',folderIds:['f3'],secrets:['SHARED']}),policy);
 const coordinator=memberAccess(member({id:'coord',kind:'agent',role:'agent',secrets:['ALICE_TOKEN','SHARED','BOB_KEY']}),policy);
 const bobsRun=composeAccess([bob,coordinator]);
 assert.deepEqual(bobsRun.folderIds,['f3'],'Bob’s delegated run never reaches Alice’s repos');
 assert.deepEqual(bobsRun.secrets,['SHARED'],'the coordinator cannot lend Alice’s token to Bob');
 assert.equal(bobsRun.permissionMode,'workspace','the editor role caps the run below the Project’s Full policy');
 assert.equal(composeAccess([alice,coordinator]).permissionMode,'full');
 assert.equal(memberAccess(member({role:'owner',maxPermission:'read-only'}),policy).permissionMode,'read-only','a personal cap lowers the role cap');
 assert.equal(memberAccess(member({role:'owner'}),{...policy,permissionMode:'workspace'}).permissionMode,'workspace','the Project policy lowers everyone');
 const viewer=memberAccess(member({role:'viewer'}),policy);assert.equal(viewer.canDispatch,false);assert.equal(viewer.canEdit,false);
 const revoked=composeAccess([memberAccess(member({revokedAt:'2026-01-01'}),policy),coordinator]);
 assert.equal(revoked.active,false);assert.equal(revoked.permissionMode,null);assert.deepEqual(revoked.folderIds,[]);assert.deepEqual(revoked.secrets,[]);
});

test('members: seeded local owner and agent, roles, folder grants, and revocation that blocks runs at once (PRJ-13)',async t=>{
 const {service,folder,settle}=await fixture(t);const a=await folder('a'),b=await folder('b');
 const p=await service.invoke('project.create',{name:'Team',goal:'',folderIds:[a.id,b.id]});
 const listed=await service.invoke('project.members.list',{projectId:p.id});
 assert.deepEqual(listed.members.map(m=>[m.id,m.role]),[['local','owner'],['agent','agent']]);
 assert.equal(listed.access.local!.permissionMode,'workspace','the default Project policy is Workspace');
 assert.deepEqual(listed.access.local!.folderIds,[a.id,b.id]);
 await assert.rejects(service.invoke('project.members.update',{projectId:p.id,id:'local',role:'viewer'}),/stay the owner/);
 await assert.rejects(service.invoke('project.members.revoke',{projectId:p.id,id:'local'}),/cannot revoke your own/);
 await assert.rejects(service.invoke('project.members.add',{projectId:p.id,name:'Bot',kind:'agent',role:'owner'}),/Agents take the Agent role/);
 const dana=await service.invoke('project.members.add',{projectId:p.id,name:'Dana',kind:'person',role:'editor',folderIds:[b.id]});
 const updated=await service.invoke('project.members.update',{projectId:p.id,id:dana.id,role:'viewer'});
 assert.equal(updated.role,'viewer');
 // Limiting the default agent to one folder refuses runs in the other.
 await service.invoke('project.members.update',{projectId:p.id,id:'agent',folderIds:[b.id]});
 const task=await service.invoke('project.tasks.add',{projectId:p.id,title:'Build',acceptance:'',dependencies:[]});
 await assert.rejects(service.invoke('project.tasks.dispatch',{projectId:p.id,id:task.id,revision:task.revision,folderId:a.id}),/no access to a/);
 const run=await service.invoke('project.tasks.dispatch',{projectId:p.id,id:task.id,revision:task.revision,folderId:b.id});
 await settle(run.chatId);
 // Revoking the agent refuses every new run until it is restored.
 const revoked=await service.invoke('project.members.revoke',{projectId:p.id,id:'agent'});
 assert.ok(revoked.member.revokedAt);
 const second=await service.invoke('project.tasks.add',{projectId:p.id,title:'Second',acceptance:'',dependencies:[]});
 await assert.rejects(service.invoke('project.tasks.dispatch',{projectId:p.id,id:second.id,revision:second.revision,folderId:b.id}),/Agents’s access was revoked/);
 await service.invoke('project.members.restore',{projectId:p.id,id:'agent'});
 const again=await service.invoke('project.tasks.dispatch',{projectId:p.id,id:second.id,revision:second.revision,folderId:b.id});
 await settle(again.chatId);
 const log=await service.invoke('project.activity.query',{projectId:p.id,categories:['members']});
 assert.deepEqual(log.items.map(x=>x.kind).reverse(),['member.added','member.role','member.access','member.revoked','member.restored']);
 await service.invoke('project.delete',{id:p.id});
});

test('explicit chat move and copy preview memory and context scope before anything changes (PRJ-17)',async t=>{
 const {service,folder,settle}=await fixture(t);const a=await folder('a'),other=await folder('other');
 const p=await service.invoke('project.create',{name:'Target',goal:'Ship v1',folderIds:[a.id]});
 await service.invoke('project.instructions.set',{projectId:p.id,text:'Be careful',baseVersion:0});
 const chat=await service.invoke('chat.create',{folderId:other.id});
 await service.invoke('chat.send',{id:chat.id,text:'hello',requestId:'req-1'});
 await settle(chat.id);

 const preview=await service.invoke('project.chats.preview',{chatId:chat.id,projectId:p.id,mode:'move'});
 assert.equal(preview.blocked,null);assert.equal(preview.messages,1);assert.equal(preview.linksFolder,true,'a chat with history keeps its folder, linked to the Project');
 assert.deepEqual(preview.context.gains,['Target’s shared goal','Project instructions v1']);
 assert.deepEqual(preview.memory.before,['other memory']);assert.deepEqual(preview.memory.after,['other memory','Target Project memory']);
 assert.ok(preview.notes.some(n=>/never added automatically/.test(n)));
 let snap=await service.invoke('app.snapshot',undefined);
 assert.equal(snap.chats.find(c=>c.id===chat.id)!.projectId,undefined,'a preview changes nothing');

 await assert.rejects(service.invoke('project.chats.transfer',{chatId:chat.id,projectId:p.id,mode:'move',confirm:false as never}),/confirm/);
 const moved=await service.invoke('project.chats.transfer',{chatId:chat.id,projectId:p.id,mode:'move',confirm:true});
 assert.equal(moved.chatId,chat.id);
 snap=await service.invoke('app.snapshot',undefined);
 assert.equal(snap.chats.find(c=>c.id===chat.id)!.projectId,p.id);
 assert.deepEqual(snap.projects.find(x=>x.id===p.id)!.folderIds,[a.id,other.id]);
 assert.equal((await service.invoke('project.chats.preview',{chatId:chat.id,projectId:p.id,mode:'move'})).blocked,'This chat is already in Target.');

 // Copy out of the Project: the original stays, the copy leaves with its history.
 const out=await service.invoke('project.chats.preview',{chatId:chat.id,projectId:null,mode:'copy'});
 assert.deepEqual(out.context.loses,['Target’s shared goal','Project instructions v1']);assert.deepEqual(out.memory.after,['other memory']);
 const copied=await service.invoke('project.chats.transfer',{chatId:chat.id,projectId:null,mode:'copy',confirm:true});
 assert.notEqual(copied.chatId,chat.id);
 snap=await service.invoke('app.snapshot',undefined);
 assert.equal(snap.chats.find(c=>c.id===chat.id)!.projectId,p.id);assert.equal(snap.chats.find(c=>c.id===copied.chatId)!.projectId,undefined);

 const log=await service.invoke('project.activity.query',{projectId:p.id,categories:['chats']});
 assert.deepEqual(log.items.map(x=>x.kind).reverse(),['chat.moved-in','chat.copied-out']);
 await service.invoke('project.archive',{id:p.id});
 assert.match((await service.invoke('project.chats.preview',{chatId:copied.chatId,projectId:p.id,mode:'move'})).blocked!,/Restore Target/);
});
