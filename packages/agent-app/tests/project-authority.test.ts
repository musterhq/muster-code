import assert from 'node:assert/strict';
import {mkdtemp,mkdir,realpath,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {createAgentService} from '../src/runtime/service.ts';
import type {ProviderAdapter} from '../src/runtime/provider.ts';

test('Project commands enforce target Project, derive authorship, and export attached folder identity',async t=>{
 const dataDir=await mkdtemp(join(tmpdir(),'muster-project-authority-'));
 const folderPath=join(dataDir,'source');await mkdir(folderPath);
 const provider:ProviderAdapter={info:()=>[],stop:async()=>true,dispose(){},async run(){return {status:'completed',finalMessage:''}}};
 const service=createAgentService({dataDir,provider,onEvent(){}});
 t.after(async()=>{await service.dispose();await rm(dataDir,{recursive:true,force:true})});
 const folder=await service.invoke('folder.add',{path:folderPath});
 const p1=await service.invoke('project.create',{name:'One',goal:'goal',folderIds:[folder.id]});
 const p2=await service.invoke('project.create',{name:'Two',goal:'other',folderIds:[]});
 const task=await service.invoke('project.tasks.create',{projectId:p1.id,title:'Ship slice',acceptance:'observable',dependencies:[]});
 await assert.rejects(service.invoke('project.tasks.updateStatus',{projectId:p2.id,id:task.id,status:'blocked',revision:0}),/different project/);
 const decision=await service.invoke('project.decisions.create',{projectId:p1.id,title:'Use local state',rationale:'privacy',scope:'project',relatedTaskIds:[task.id],author:'forged client'} as never);
 assert.equal(decision.author,'main');
 await assert.rejects(service.invoke('project.decisions.supersede',{projectId:p2.id,id:decision.id,replacementId:decision.id}),/different project/);
 const exported=await service.invoke('project.export',{projectId:p1.id});
 assert.deepEqual(exported.project.folderIds,[folder.id]);assert.equal(exported.folders[0]?.path,await realpath(folderPath));assert.equal(exported.tasks.items[0]?.id,task.id);assert.equal(exported.chats.items.length,0);assert.equal(exported.schemaVersion,2);
 await assert.rejects(service.invoke('project.tasks.list',{projectId:'missing'}),/Project not found/);
});
