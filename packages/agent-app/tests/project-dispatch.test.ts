import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import {MODEL,type ProviderAdapter} from '../src/runtime/provider.ts';

// Exercises the richer project.tasks.dispatch path (used by both the "Run in agent chat" button and the
// scheduler), as distinct from the legacy project.tasks.start covered in project-task-run.test.ts.
test('project.tasks.dispatch never exceeds the Project scheduler permission mode (PRJ-13)',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-dispatch-')),folderPath=join(dataDir,'source');await mkdir(folderPath);
 const provider:ProviderAdapter={info:()=>[{id:'hybrow',name:'Hybrow',available:true,identityMasked:'configured',models:[{id:MODEL,name:MODEL}]}],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:'done'}}};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=await service.invoke('folder.add',{path:folderPath});
 const project=await service.invoke('project.create',{name:'Clamp',goal:'',folderIds:[folder.id]});
 await service.invoke('project.scheduler.set',{projectId:project.id,permissionMode:'read-only'});

 // A task asking for more access than the Project allows is clamped down to the Project's mode.
 const overreaching=await service.invoke('project.tasks.add',{projectId:project.id,title:'Wants full access',acceptance:'',dependencies:[],permissionMode:'full'});
 const dispatchedOverreaching=await service.invoke('project.tasks.dispatch',{projectId:project.id,id:overreaching.id,revision:overreaching.revision});
 const chatOverreaching=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===dispatchedOverreaching.chatId)!;
 assert.equal(chatOverreaching.permissionMode,'read-only','a task-level override is clamped to the Project scheduler mode');

 // A task with a stricter override than the Project keeps its own, narrower mode.
 const stricter=await service.invoke('project.tasks.add',{projectId:project.id,title:'Prefers read-only',acceptance:'',dependencies:[],permissionMode:'read-only'});
 await service.invoke('project.scheduler.set',{projectId:project.id,permissionMode:'full',acknowledgeFullAccess:true});
 const dispatchedStricter=await service.invoke('project.tasks.dispatch',{projectId:project.id,id:stricter.id,revision:stricter.revision});
 const chatStricter=(await service.invoke('app.snapshot',undefined)).chats.find(c=>c.id===dispatchedStricter.chatId)!;
 assert.equal(chatStricter.permissionMode,'read-only','a stricter task-level override is never loosened by the Project mode');
});
