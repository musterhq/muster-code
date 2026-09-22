import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import {ProjectTaskStore} from '../src/runtime/project-tasks.ts';
import {MODEL,type ProviderAdapter} from '../src/runtime/provider.ts';

test('Project task start creates one scoped agent chat and settles as implemented with the linked identity',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-run-')),folderPath=join(dataDir,'source');await mkdir(folderPath);
 let calls=0,projectChanges=0,projectChanged:(projectId:string,taskId:string)=>void=()=>{};const settled=new Promise<void>(resolve=>{projectChanged=()=>{if(++projectChanges>=2)resolve()}});
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:MODEL,name:MODEL}]}],stop:async()=>true,dispose(){},async run(input){calls++;assert.ok(input.cwd.endsWith('/source'));assert.match(input.prompt,/Acceptance criteria:[\s\S]*visible behavior/);return {status:'completed',finalMessage:'Implemented the task.'}}};
 const service=createAgentService({dataDir,provider,onEvent(event){if(event.type==='projectChanged')projectChanged(event.projectId,event.taskId)}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=await service.invoke('folder.add',{path:folderPath}),project=await service.invoke('project.create',{name:'Demo',goal:'ship safely',folderIds:[folder.id]});
 const dependency=await service.invoke('project.tasks.create',{projectId:project.id,title:'Prerequisite',acceptance:'done',dependencies:[]});
 const task=await service.invoke('project.tasks.create',{projectId:project.id,title:'Build a feature',acceptance:'visible behavior',dependencies:[dependency.id]});
 const chatsBeforeBlockedStart=(await service.invoke('app.snapshot',undefined)).chats.length;
 await assert.rejects(service.invoke('project.tasks.start',{projectId:project.id,id:task.id,revision:0,requestId:'blocked-attempt'}),/not yet verified/);
 assert.equal((await service.invoke('app.snapshot',undefined)).chats.length,chatsBeforeBlockedStart,'blocked dependencies do not create orphan chats');
 await service.invoke('project.tasks.updateStatus',{projectId:project.id,id:dependency.id,status:'verified',revision:0,evidence:['reviewed']});
 const started=await service.invoke('project.tasks.start',{projectId:project.id,id:task.id,revision:0,requestId:'project-task-request',folderId:folder.id});
 assert.equal(started.task.status,'running');assert.equal(started.task.runChatId,started.chatId);
 await settled;
 const tasks=await service.invoke('project.tasks.list',{projectId:project.id}),finished=tasks.items.find(item=>item.id===task.id)!;
 assert.equal(finished.status,'implemented',JSON.stringify(finished));assert.equal(finished.runChatId,started.chatId);assert.equal(calls,1);
 const linked=(await service.invoke('app.snapshot',undefined)).chats.find(chat=>chat.id===started.chatId)!;
 assert.equal(linked.projectId,project.id);assert.equal(linked.folderId,folder.id);assert.match(linked.title,/Build a feature/);
 const replay=await service.invoke('project.tasks.start',{projectId:project.id,id:task.id,revision:0,requestId:'project-task-request',folderId:folder.id});
 assert.equal(replay.chatId,started.chatId);assert.equal(replay.runId,started.runId);assert.equal(calls,1,'repeated request identity never starts duplicate provider work');
});

test('pre-dispatch failure preserves a linked task chat and draft without claiming a run',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-run-fail-')),folderPath=join(dataDir,'source');await mkdir(folderPath);
 const provider:ProviderAdapter={info:()=>[],stop:async()=>true,dispose(){},async run(){throw new Error('unavailable providers must fail before run')}};
 const service=createAgentService({dataDir,provider,onEvent(){}});t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const emptyProject=await service.invoke('project.create',{name:'Needs a scope',goal:'',folderIds:[]}),emptyTask=await service.invoke('project.tasks.create',{projectId:emptyProject.id,title:'Cannot run yet',acceptance:'must remain scoped',dependencies:[]});
 await assert.rejects(service.invoke('project.tasks.start',{projectId:emptyProject.id,id:emptyTask.id,revision:0,requestId:'missing-scope'}),/Attach a folder/);
 assert.equal((await service.invoke('app.snapshot',undefined)).chats.length,0,'a Project with no execution scope does not create an unscoped chat');
 const folder=await service.invoke('folder.add',{path:folderPath}),project=await service.invoke('project.create',{name:'Unavailable',goal:'',folderIds:[folder.id]}),task=await service.invoke('project.tasks.create',{projectId:project.id,title:'Keep draft',acceptance:'preserve it',dependencies:[]});
 await assert.rejects(service.invoke('project.tasks.start',{projectId:project.id,id:task.id,revision:0,requestId:'pre-dispatch-failure'}),/unavailable through the configured provider/);
 const saved=(await service.invoke('project.tasks.list',{projectId:project.id})).items[0]!;
 assert.equal(saved.status,'blocked');assert.ok(saved.runChatId);assert.match(saved.runError??'',/unavailable through/);
 const chat=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===saved.runChatId)!;
 assert.match(chat.draft,/preserve it/);assert.equal(chat.status,'idle');
});

test('restart reconciles an unaccepted Project run to blocked without losing its chat or draft',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-run-restart-')),folderPath=join(dataDir,'source');await mkdir(folderPath);
 const provider:ProviderAdapter={info:()=>[],stop:async()=>true,dispose(){},async run(){throw new Error('restart recovery must not redispatch work')}};
 let service=createAgentService({dataDir,provider,onEvent(){}});t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=await service.invoke('folder.add',{path:folderPath}),project=await service.invoke('project.create',{name:'Restart',goal:'preserve work',folderIds:[folder.id]}),task=await service.invoke('project.tasks.create',{projectId:project.id,title:'Recover task',acceptance:'keep the draft',dependencies:[]});
 const chat=await service.invoke('chat.create',{folderId:folder.id,projectId:project.id});await service.invoke('chat.update',{id:chat.id,title:'Task · Recover task',draft:'saved prompt'});
 await service.dispose();
 const tasks=new ProjectTaskStore(dataDir);tasks.startTask({projectId:project.id,id:task.id,revision:0,requestId:'accepted-by-task-only',chatId:chat.id});tasks.close();
 service=createAgentService({dataDir,provider,onEvent(){}});
 const recovered=(await service.invoke('project.tasks.list',{projectId:project.id})).items[0]!;
 const restored=(await service.invoke('app.snapshot',undefined)).chats.find(item=>item.id===chat.id)!;
 assert.equal(recovered.status,'blocked');assert.equal(recovered.runChatId,chat.id);assert.equal(recovered.runRequestId,'accepted-by-task-only');assert.match(recovered.runError??'',/before the linked agent chat accepted/);
 assert.equal(restored.draft,'saved prompt');assert.equal(restored.status,'idle');
});
