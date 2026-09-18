const {test}=require('node:test');
const assert=require('node:assert/strict');
const {mkdtemp,rm,writeFile,symlink}=require('node:fs/promises');
const {tmpdir}=require('node:os');
const {join}=require('node:path');
const {createAgentService}=require('../dist/runtime/service.cjs');
const {randomUUID}=require('node:crypto');
const settled=async(service,id)=>{for(let i=0;i<100;i++){const s=await service.invoke('app.snapshot');if(s.chats.find(c=>c.id===id).status!=='running')return s;await new Promise(r=>setTimeout(r,5));}throw Error('Run did not settle');};
async function fixture(t,run){const dir=await mkdtemp(join(tmpdir(),'muster-agent-service-'));const calls=[];const provider={info:()=>[{id:'hybrow',available:true,identityMasked:'Hidden',models:[]}],run:async x=>{calls.push(x);return run(x);},stop:async()=>true,dispose(){}};const service=createAgentService({dataDir:join(dir,'data'),provider,onEvent(){}});t.after(async()=>{await service.dispose();await rm(dir,{recursive:true,force:true});});return {dir,service,calls,provider};}
test('provider-fixture stream chronology equals durable replay; accepted retry is not dispatched twice',async t=>{
 const {service,calls}=await fixture(t,async x=>{x.onDelta('Before');x.onEvent('item/started',{item:{id:'tool-1',type:'commandExecution',command:'pwd'}});x.onEvent('item/completed',{item:{id:'tool-1',type:'commandExecution',command:'pwd',aggregatedOutput:'/workspace'}});x.onDelta('After');return {status:'completed',finalMessage:'BeforeAfter',threadId:'provider-thread'};});
 const c=await service.invoke('chat.create',{});const requestId=randomUUID();const input={id:c.id,text:'inspect fixture',requestId};const receipt=await service.invoke('chat.send',input);await settled(service,c.id);assert.deepEqual(await service.invoke('chat.send',input),receipt);assert.equal(calls.length,1);const items=await service.invoke('chat.select',{id:c.id});assert.deepEqual(items.map(x=>x.kind),['user','assistant','tool','assistant']);assert.equal(items[1].text,'Before');assert.equal(items[3].text,'After');await assert.rejects(service.invoke('chat.send',{...input,text:'different side effect'}),/conflicts/);
});
test('folder and Project identities, draft/pin/title survive reopening; outside symlinks denied',async t=>{
 const {dir,service,provider}=await fixture(t,async()=>({status:'completed',finalMessage:''}));const root=join(dir,'workspace');await require('node:fs/promises').mkdir(root);await writeFile(join(root,'safe.txt'),'fixture content');await writeFile(join(dir,'outside.txt'),'private fixture');await symlink(join(dir,'outside.txt'),join(root,'escape.txt'));
 const folder=await service.invoke('folder.add',{path:root});const project=await service.invoke('project.create',{name:'Release',goal:'Ship',folderIds:[folder.id]});const c=await service.invoke('chat.create',{folderId:folder.id});await service.invoke('chat.update',{id:c.id,title:'My task',draft:'unsent',pinned:true});assert.equal(c.projectId,undefined);assert.notEqual(folder.id,project.id);assert.equal((await service.invoke('files.read',{folderId:folder.id,path:'safe.txt'})).text,'fixture content');await assert.rejects(service.invoke('files.read',{folderId:folder.id,path:'escape.txt'}),/outside/);await assert.rejects(service.invoke('files.read',{folderId:folder.id,path:'../outside.txt'}),/escapes/);await service.dispose();const reopened=createAgentService({dataDir:join(dir,'data'),provider,onEvent(){}});t.after(()=>reopened.dispose());const saved=(await reopened.invoke('app.snapshot')).chats[0];assert.equal(saved.draft,'unsent');assert.equal(saved.title,'My task');assert.equal(saved.pinned,true);
});
test('approval item ID resolves real pending request and failed execution remains visible',async t=>{
 let decision;const {service}=await fixture(t,async x=>{decision=await x.onRequest('item/commandExecution/requestApproval',{command:'touch fixture'});throw Error('Fixture provider disconnected');});const c=await service.invoke('chat.create',{});await service.invoke('chat.send',{id:c.id,text:'test approval',requestId:randomUUID()});let items=await service.invoke('chat.select',{id:c.id});const approval=items.find(x=>x.kind==='approval');assert.ok(approval);await service.invoke('approval.respond',{id:approval.id,approved:false});await settled(service,c.id);assert.deepEqual(decision,{decision:'decline'});items=await service.invoke('chat.select',{id:c.id});assert.equal(items.find(x=>x.kind==='approval').status,'declined');assert.match(items.at(-1).text,/disconnected/);
});
test('Project chats resolve a sole attached folder and reject unrelated or ambiguous folders', async t => {
 const {dir, service} = await fixture(t, async () => ({status:'completed', finalMessage:''}));
 const fs = require('node:fs/promises');
 const folders = [];
 for (const name of ['one', 'two', 'unrelated']) {
   const path = join(dir, name); await fs.mkdir(path);
   folders.push(await service.invoke('folder.add', {path}));
 }
 const solo = await service.invoke('project.create', {name:'Solo', goal:'One workspace', folderIds:[folders[0].id]});
 const chat = await service.invoke('chat.create', {projectId:solo.id});
 assert.equal(chat.folderId, folders[0].id);
 assert.equal(chat.projectId, solo.id);
 const multi = await service.invoke('project.create', {name:'Several', goal:'Two workspaces', folderIds:folders.slice(0,2).map(f=>f.id)});
 await assert.rejects(service.invoke('chat.create', {projectId:multi.id}), /Choose a Project folder/);
 await assert.rejects(service.invoke('chat.create', {projectId:multi.id, folderId:folders[2].id}), /not attached/);
 const selected = await service.invoke('chat.create', {projectId:multi.id, folderId:folders[1].id});
 assert.equal(selected.folderId, folders[1].id);
 const independent = await service.invoke('chat.create', {folderId:folders[0].id});
 assert.equal(independent.projectId, undefined);
});
