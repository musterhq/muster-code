import test from 'node:test';
import assert from 'node:assert/strict';
import {COMPOSER_COMMANDS,configuredAccess,effectiveAccess,filterComposerCommands,insertWorkspaceReference,menuIndex,readSlashQuery} from '../src/renderer/components/composerMenus.ts';

test('slash detection recognizes unfinished commands without stealing paths, prose or selections',()=>{
  assert.equal(readSlashQuery('/',1),'');assert.equal(readSlashQuery('/plan',5),'plan');
  for(const text of ['/Users/project','Please /plan','/ask question','https://example.test','/plan\n'])assert.equal(readSlashQuery(text,text.length),null);
  assert.equal(readSlashQuery('/plan',1,5),null);assert.equal(readSlashQuery('/plan',2),null);
});
test('command search distinguishes local skills from installed plugin inventory',()=>{
  assert.deepEqual(filterComposerCommands('plugins').map(command=>command.id),['plugins']);
  assert.equal(COMPOSER_COMMANDS.find(command=>command.id==='plugins')?.description,'Inspect skills, MCP servers and apps');
  for(const id of ['reference','skills','browser','providers','model','agent','ask','plan','access'])
    assert.ok(COMPOSER_COMMANDS.some(command=>command.id===id),`missing composer control: ${id}`);
  assert.ok(filterComposerCommands('web').some(command=>command.id==='browser'));
  assert.ok(filterComposerCommands('/plan').some(command=>command.id==='plan'));
  assert.equal(filterComposerCommands('nonexistent-action').length,0);
  assert.equal(new Set(COMPOSER_COMMANDS.map(command=>command.id)).size,COMPOSER_COMMANDS.length);
  assert.ok(!COMPOSER_COMMANDS.some(command=>/upload|attachment/i.test(command.id)),'no unsupported attachment transport');
});
test('keyboard menu indices wrap and handle an unfocused or empty list',()=>{
  assert.equal(menuIndex(-1,3,'next'),0);assert.equal(menuIndex(-1,3,'previous'),2);
  assert.equal(menuIndex(2,3,'next'),0);assert.equal(menuIndex(0,3,'previous'),2);
  assert.equal(menuIndex(2,3,'first'),0);assert.equal(menuIndex(0,3,'last'),2);assert.equal(menuIndex(0,0,'next'),0);
});
test('effective access remains separate from mode and legacy defaults stay honest',()=>{
  assert.equal(configuredAccess({mode:'agent'}),'workspace');assert.equal(configuredAccess({mode:'ask'}),'read-only');
  assert.equal(effectiveAccess({mode:'agent',permissionMode:'full'}),'full');
  assert.equal(effectiveAccess({mode:'ask',permissionMode:'full'}),'read-only');
  assert.equal(effectiveAccess({mode:'plan',permissionMode:'workspace'}),'read-only');
  assert.equal(configuredAccess({mode:'ask',permissionMode:'full'}),'full','configured Agent access is preserved while Ask is read-only');
});
test('file references preserve text/selection and quote paths containing spaces',()=>{
  assert.deepEqual(insertWorkspaceReference('Review carefully','src/file.ts',6,6),{text:'Review @src/file.ts carefully',caret:19});
  const value=insertWorkspaceReference('Use placeholder now','/Project Docs/a.md',4,15);
  assert.equal(value.text,'Use @"/Project Docs/a.md" now');assert.equal(value.caret,'Use @"/Project Docs/a.md"'.length);
  assert.deepEqual(insertWorkspaceReference('','src/a.ts'),{text:'@src/a.ts',caret:9});
});
