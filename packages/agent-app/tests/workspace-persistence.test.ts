import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkspace, saveWorkspace } from '../src/renderer/workspacePersistence.ts';

function storage(value: unknown): Storage {
  return { getItem: () => JSON.stringify(value) } as unknown as Storage;
}

test('subagent tabs are keyed by chat and support folderless chats', () => {
  const workspace = readWorkspace(storage({version:1, tabs:[
    {kind:'subagents', chatId:'chat-a', title:'A'},
    {kind:'subagents', chatId:'chat-b', title:'B', folderId:'folder-1'},
    {kind:'files', folderId:'folder-1', title:'Files'},
  ], activeTabId:'subagents:chat-b'}));
  assert.deepEqual(workspace.tabs.map(tab => tab.id), ['subagents:chat-a','subagents:chat-b','files:folder-1']);
  assert.equal(workspace.tabs[0]?.folderId, undefined);
  assert.equal(workspace.activeTabId, 'subagents:chat-b');
});

test('invalid subagent persistence without a chat id is discarded', () => {
  const workspace = readWorkspace(storage({version:1, tabs:[
    {kind:'subagents', title:'missing identity'},
    {kind:'subagents', chatId:'chat-a', title:'valid'},
  ], activeTabId:'subagents:chat-a'}));
  assert.deepEqual(workspace.tabs.map(tab => tab.id), ['subagents:chat-a']);
});


test('browser persistence restores the latest validated address and profile without page titles', () => {
  let saved='';
  const tab={id:'browser:test-1',kind:'browser' as const,browserProfileId:'personal',title:'Private page title',url:'https://example.com/?token=private'};
  assert.equal(saveWorkspace({setItem:(_key,value)=>{saved=value;}},{tabs:[tab],activeTabId:tab.id}),true);
  assert.equal(saved.includes('https://example.com/?token=private'),true);
  assert.equal(saved.includes('Private page'),false);
  const restored=readWorkspace({getItem:()=>saved});
  assert.deepEqual(restored.tabs,[{id:tab.id,kind:'browser',browserProfileId:'personal',url:'https://example.com/?token=private',title:'Browser'}]);
});

test('browser persistence replaces credential-bearing or invalid addresses with a blank page',()=>{
  let saved='';
  const tab={id:'browser:test-1',kind:'browser' as const,browserProfileId:'personal',title:'Browser',url:'https://user:secret@example.test/private'};
  assert.equal(saveWorkspace({setItem:(_key,value)=>{saved=value;}},{tabs:[tab],activeTabId:tab.id}),true);
  assert.equal(saved.includes('secret'),false);
  assert.equal(readWorkspace({getItem:()=>saved}).tabs[0]?.url,'about:blank');
  const restored=readWorkspace(storage({version:1,tabs:[{...tab,url:'file:///etc/passwd'}]}));
  assert.equal(restored.tabs[0]?.url,'about:blank');
});

test('browser persistence rejects malformed owners and profile paths', () => {
  const workspace=readWorkspace(storage({version:1,tabs:[
    {id:'browser:valid',kind:'browser',browserProfileId:'../../default'},
    {id:'file:bad',kind:'browser',browserProfileId:'personal'},
    {id:'browser:valid',kind:'browser',browserProfileId:'personal'},
    {id:'browser:valid',kind:'browser',browserProfileId:'personal'},
  ]}));
  assert.equal(workspace.tabs.length,1);
});


test('command and computer tabs restore scoped identities without caller handles or paths',()=>{
  const workspace=readWorkspace(storage({version:1,tabs:[
    {kind:'processes',chatId:'chat-a',title:'Commands'},
    {kind:'computer',scope:{kind:'project',id:'project-a'},title:'Computer'},
    {kind:'computer',scope:{kind:'host',id:'/Users/private'},title:'invalid'},
    {kind:'processes',chatId:'../../private',title:'invalid'},
  ]}));
  assert.deepEqual(workspace.tabs.map(tab=>tab.id),['processes:chat-a','computer:project:project-a']);
});
