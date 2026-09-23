// S3-G / PRJ-X3 pure helpers: the Edit project patch, display paths, the hover-card glance and the Agents run list.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {agentRuns,projectEditPatch,projectGlance,shortPath,toProjectDetails} from '../src/renderer/projectSurface.ts';

const project={id:'p',name:'Muster Code',goal:'Ship it',folderIds:['a','b'],primaryFolderId:'a'};

test('Edit project sends nothing when nothing changed, and only the changed fields otherwise', () => {
  assert.equal(projectEditPatch(project,{name:' Muster Code ',goal:'Ship it',folderIds:['a','b']}),null);
  assert.deepEqual(projectEditPatch(project,{name:'Muster',goal:'Ship it',folderIds:['a','b']}),{id:'p',name:'Muster'});
  assert.deepEqual(projectEditPatch(project,{name:'Muster Code',goal:'Ship v2',folderIds:['a','b']}),{id:'p',goal:'Ship v2'});
});

test('Edit project folders: first is primary; reordering only moves primary, removing sends the new set', () => {
  assert.deepEqual(projectEditPatch(project,{name:'Muster Code',goal:'Ship it',folderIds:['b','a']}),{id:'p',primaryFolderId:'b'});
  assert.deepEqual(projectEditPatch(project,{name:'Muster Code',goal:'Ship it',folderIds:['b']}),{id:'p',folderIds:['b'],primaryFolderId:'b'});
  assert.deepEqual(projectEditPatch(project,{name:'Muster Code',goal:'Ship it',folderIds:['a','b','c']}),{id:'p',folderIds:['a','b','c']});
  assert.deepEqual(projectEditPatch(project,{name:'Muster Code',goal:'Ship it',folderIds:[]}),{id:'p',folderIds:[],primaryFolderId:null});
});

test('snapshot projects convert to details with the first folder as primary', () => {
  assert.deepEqual(toProjectDetails({id:'p',name:'n',goal:'',folderIds:['x','y']}),{id:'p',name:'n',goal:'',folderIds:['x','y'],primaryFolderId:'x',archived:false,archivedAt:null});
});

test('shortPath abbreviates the home directory only', () => {
  assert.equal(shortPath('/Users/dhairya/code/muster'),'~/code/muster');
  assert.equal(shortPath('/home/ci/app'),'~/app');
  assert.equal(shortPath('/Users/dhairya'),'~');
  assert.equal(shortPath('/opt/Users/x'),'/opt/Users/x');
});

test('hover-card glance counts open and running tasks and picks the newest activity', () => {
  const g=projectGlance([{state:'todo',updatedAt:'2026-09-20T00:00:00Z'},{state:'running',updatedAt:'2026-09-21T00:00:00Z'},{state:'needs-input',updatedAt:'2026-09-19T00:00:00Z'},{state:'verified',updatedAt:'2026-09-22T00:00:00Z'},{state:'cancelled',updatedAt:'2026-09-18T00:00:00Z'}],
    '2026-09-21T12:00:00Z',[{updatedAt:'2026-09-23T00:00:00Z',archived:true},{updatedAt:'2026-09-22T06:00:00Z',archived:false}]);
  assert.deepEqual(g,{openTasks:3,runningTasks:2,lastActivityAt:'2026-09-22T06:00:00Z'});
  assert.equal(projectGlance([],null,[]).lastActivityAt,null);
});

test('agent runs list running attempts first, then newest, capped', () => {
  const attempt=(id:string,startedAt:string,status='completed')=>({id,chatId:`c-${id}`,runId:null,trigger:'user',startedAt,endedAt:null,status,contextVersion:null});
  const tasks=[{id:'t1',title:'One',state:'verified',attempts:[attempt('a','2026-09-20T00:00:00Z'),attempt('b','2026-09-22T00:00:00Z')]},{id:'t2',title:'Two',state:'running',attempts:[attempt('c','2026-09-19T00:00:00Z','running')]}] as never;
  assert.deepEqual(agentRuns(tasks).map(r=>r.attempt.id),['c','b','a']);
  assert.deepEqual(agentRuns(tasks,2).map(r=>`${r.task.title}:${r.attempt.id}`),['Two:c','One:b']);
});
