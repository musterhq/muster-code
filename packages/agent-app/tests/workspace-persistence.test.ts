import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWorkspace, saveWorkspace } from '../src/renderer/workspacePersistence.ts';

function storage(value: unknown): Storage {
  return { getItem: () => JSON.stringify(value) } as unknown as Storage;
}

const scoped = (tabs: unknown[], activeTabId: string | null) => ({version:2, scope:'personal', tabs, activeTabId});

test('subagent tabs are keyed by chat and support folderless chats', () => {
  const workspace = readWorkspace(storage(scoped([
    {kind:'subagents', chatId:'chat-a', title:'A'},
    {kind:'subagents', chatId:'chat-b', title:'B', folderId:'folder-1'},
    {kind:'files', folderId:'folder-1', title:'Files'},
  ], 'subagents:chat-b')));
  assert.deepEqual(workspace.tabs.map(tab => tab.id), ['subagents:chat-a','subagents:chat-b','files:folder-1']);
  assert.equal(workspace.tabs[0]?.folderId, undefined);
  assert.equal(workspace.activeTabId, 'subagents:chat-b');
});

test('invalid subagent persistence without a chat id is discarded', () => {
  const workspace = readWorkspace(storage(scoped([
    {kind:'subagents', title:'missing identity'},
    {kind:'subagents', chatId:'chat-a', title:'valid'},
  ], 'subagents:chat-a')));
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
  const restored=readWorkspace(storage(scoped([{...tab,url:'file:///etc/passwd'}],tab.id)));
  assert.equal(restored.tabs[0]?.url,'about:blank');
});

test('browser persistence rejects malformed owners and profile paths', () => {
  const workspace=readWorkspace(storage(scoped([
    {id:'browser:valid',kind:'browser',browserProfileId:'../../default'},
    {id:'file:bad',kind:'browser',browserProfileId:'personal'},
    {id:'browser:valid',kind:'browser',browserProfileId:'personal'},
    {id:'browser:valid',kind:'browser',browserProfileId:'personal'},
  ], null)));
  assert.equal(workspace.tabs.length,1);
});


test('command and computer tabs restore scoped identities without caller handles or paths',()=>{
  const workspace=readWorkspace(storage(scoped([
    {kind:'processes',chatId:'chat-a',title:'Commands'},
    {kind:'computer',scope:{kind:'project',id:'project-a'},title:'Computer'},
    {kind:'computer',scope:{kind:'host',id:'/Users/private'},title:'invalid'},
    {kind:'processes',chatId:'../../private',title:'invalid'},
  ], null)));
  assert.deepEqual(workspace.tabs.map(tab=>tab.id),['processes:chat-a','computer:project:project-a']);
});

test('resource tabs persist under isolated chat/project/repository scopes',()=>{
  const values=new Map<string,string>();
  const storage={getItem:(key:string)=>values.get(key)??null,setItem:(key:string,value:string)=>{values.set(key,value);}} as unknown as Storage;
  const a={tabs:[{id:'file:repo-a:budget.xlsx',kind:'file' as const,folderId:'repo-a',path:'budget.xlsx',title:'budget.xlsx'}],activeTabId:'file:repo-a:budget.xlsx'};
  const b={tabs:[{id:'file:repo-b:notes.md',kind:'file' as const,folderId:'repo-b',path:'notes.md',title:'notes.md'}],activeTabId:'file:repo-b:notes.md'};
  assert.equal(saveWorkspace(storage,a,'chat:chat-a|project:project-a|folder:repo-a'),true);
  assert.equal(saveWorkspace(storage,b,'chat:chat-b|project:project-b|folder:repo-b'),true);
  assert.deepEqual(readWorkspace(storage,'chat:chat-a|project:project-a|folder:repo-a'),a);
  assert.deepEqual(readWorkspace(storage,'chat:chat-b|project:project-b|folder:repo-b'),b);
  assert.deepEqual(readWorkspace(storage,'chat:chat-a|project:project-b|folder:repo-b'),{tabs:[],activeTabId:null});
});

test('the old shared resource-tab list is not restored into an arbitrary chat',()=>{
  const storage={getItem:(key:string)=>key==='muster.workspace.v1'?JSON.stringify({version:1,tabs:[{kind:'file',folderId:'private-repo',path:'payroll.xlsx',title:'payroll.xlsx'}],activeTabId:'file:private-repo:payroll.xlsx'}):null} as unknown as Storage;
  assert.deepEqual(readWorkspace(storage,'chat:other'),{tabs:[],activeTabId:null});
});
