import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';
import {createAgentService} from '../src/runtime/service.ts';
import type {AgentEvent} from '../src/shared/protocol.ts';

test('watched folder edits reach the renderer event channel and stop when resources close', async t=>{
  const root=await mkdtemp(join(tmpdir(),'muster-live-'));
  const folder=join(root,'workspace'); await mkdir(folder);
  const events:AgentEvent[]=[];
  const service=createAgentService({dataDir:join(root,'state'),onEvent:event=>events.push(event)});
  t.after(async()=>{await service.dispose();await rm(root,{recursive:true,force:true});});
  const added=await service.invoke('folder.add',{path:folder});
  await service.invoke('workspace.watch',{folderIds:[added.id]});
  await sleep(500); events.length=0;
  await writeFile(join(folder,'example.ts'),'export const value = 2;');
  const deadline=Date.now()+3000;
  while(!events.some(e=>e.type==='workspaceChanged') && Date.now()<deadline) await sleep(25);
  assert.ok(events.some(e=>e.type==='workspaceChanged' && e.folderId===added.id));
  const read=await service.invoke('files.read',{folderId:added.id,path:'example.ts'});
  assert.equal(read.text,'export const value = 2;');
  await service.invoke('workspace.watch',{folderIds:[]});events.length=0;
  await writeFile(join(folder,'example.ts'),'export const value = 3;');await sleep(500);
  assert.equal(events.some(e=>e.type==='workspaceChanged'),false);
  await assert.rejects(service.invoke('workspace.watch',{folderIds:['unknown']}),/Folder does not exist/);
});
