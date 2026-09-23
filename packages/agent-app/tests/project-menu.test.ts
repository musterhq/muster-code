import assert from 'node:assert/strict';
import {test} from 'node:test';
import {projectMenuTemplate,type ProjectMenuCommand} from '../src/main/chat-menu.ts';
import {isCommandName} from '../src/main/commands.ts';

// UR-135: a Project row gets its own native menu (it used to just open the Project on right-click).
// S3-G: rename, edit (goal and folders) and archive/restore live in the same menu.
test('project row menu offers new chat, open, rename, edit, export and archive, and each item reports its command', () => {
  const picked: ProjectMenuCommand[]=[];
  const template=projectMenuTemplate({id:'p1',name:'Launch',goal:'',folderIds:[]},command=>picked.push(command));
  const labels=template.map(item=>item.type==='separator'?'-':item.label);
  assert.deepEqual(labels,['New Chat in Project','Open Project','-','Rename…','Edit Project…','Export “Launch”…','-','Archive Project…']);
  for(const item of template)(item.click as (()=>void)|undefined)?.();
  assert.deepEqual(picked,['new-chat','open','rename','edit','export','archive']);
  assert.equal(isCommandName('project.contextMenu'),true);
});

test('an archived project offers Restore instead of Archive and cannot start a new chat', () => {
  const picked: ProjectMenuCommand[]=[];
  const template=projectMenuTemplate({id:'p1',name:'Old',goal:'',folderIds:[],archived:true},command=>picked.push(command));
  assert.equal(template.at(-1)?.label,'Restore Project');
  assert.equal(template[0]?.enabled,false);
  (template.at(-1)!.click as ()=>void)();
  assert.deepEqual(picked,['restore']);
});
