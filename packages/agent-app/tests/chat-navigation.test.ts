import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chatGroup,compareChats,isChatRunning,newChatTarget,readChatSort,rovingStop,rovingTarget,saveChatSort,selectionReveal} from '../src/renderer/chatNavigation.ts';
import type {Chat} from '../src/shared/protocol.ts';
const chat=(id:string,patch:Partial<Chat>={}):Chat=>({id,title:id,status:'completed',updatedAt:'2026-09-19T00:00:00Z',pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...patch});
const snapshot={folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[{id:'project',name:'Project',goal:'',folderIds:['folder']}]};

test('sort keeps explicit pin order and groups active chats without changing their identity',()=>{
  const rows=[chat('Z', {updatedAt:'2026-09-19T03:00:00Z'}),chat('A'),chat('working',{status:'running'}),chat('stopping',{status:'stopping'}),chat('pin-second',{pinned:true,pinOrder:2}),chat('pin-first',{pinned:true,pinOrder:1})];
  for(const sort of ['recent','name','active'] as const)assert.deepEqual([...rows].sort(compareChats(sort)).slice(0,2).map(row=>row.id),['pin-first','pin-second']);
  assert.equal([...rows].sort(compareChats('recent'))[2].id,'Z');
  assert.equal([...rows].sort(compareChats('name'))[2].id,'A');
  assert.ok([...rows].sort(compareChats('active')).slice(2,4).every(isChatRunning));
  assert.equal(rows[0].id,'Z','sorting callers can preserve the source snapshot');
});

test('each live chat is assigned to an available group even with stale references',()=>{
  assert.equal(chatGroup(chat('p',{projectId:'project',folderId:'folder'}),snapshot),'project:project');
  assert.equal(chatGroup(chat('f',{projectId:'removed',folderId:'folder'}),snapshot),'folder:folder');
  assert.equal(chatGroup(chat('o',{projectId:'removed',folderId:'removed'}),snapshot),'chats');
  assert.equal(chatGroup(chat('p',{pinned:true,projectId:'project'}),snapshot),'pinned');
  assert.equal(chatGroup(chat('a',{archived:true,pinned:true}),snapshot),'archived');
});

test('reveal is requested for a selection change, never for streaming status or timestamp changes',()=>{
  const selected=chat('selected',{folderId:'folder'});
  assert.deepEqual(selectionReveal(null,selected,snapshot),{id:'selected',group:'folder:folder'});
  assert.equal(selectionReveal('selected',{...selected,status:'running',updatedAt:'later'},snapshot),null);
  assert.equal(selectionReveal('selected',{...selected,pinned:true},snapshot),null,'manual group changes do not force scrolling');
  assert.deepEqual(selectionReveal('selected',chat('archived',{archived:true}),snapshot),{id:'archived',group:'archived'});
  assert.equal(selectionReveal('selected',undefined,snapshot),null);
});

test('sort preference survives reload and malformed/unavailable storage falls back to recent',()=>{
  let saved:string|null=null;
  const storage={getItem:()=>saved,setItem:(_key:string,value:string)=>{saved=value;}};
  assert.equal(readChatSort(storage),'recent');assert.equal(saveChatSort(storage,'active'),true);assert.equal(readChatSort(storage),'active');
  saved='unexpected';assert.equal(readChatSort(storage),'recent');
  assert.equal(readChatSort({getItem:()=>{throw Error('denied');}}),'recent');
  assert.equal(saveChatSort({setItem:()=>{throw Error('quota');}},'name'),false);
});

test('roving focus steps through visible rows, clamps at the edges and jumps with Home/End',()=>{
  const ids=['a','b','c'];
  assert.equal(rovingTarget(ids,'a','ArrowDown'),'b');
  assert.equal(rovingTarget(ids,'c','ArrowDown'),'c');
  assert.equal(rovingTarget(ids,'a','ArrowUp'),'a');
  assert.equal(rovingTarget(ids,'b','Home'),'a');
  assert.equal(rovingTarget(ids,'a','End'),'c');
  assert.equal(rovingTarget(ids,null,'ArrowDown'),'a');
  assert.equal(rovingTarget(ids,'gone','ArrowUp'),'c');
  assert.equal(rovingTarget(ids,'a','Enter'),null);
  assert.equal(rovingTarget([],null,'ArrowDown'),null);
});

test('exactly one row owns the tab stop, preferring focus, then selection, then the first row',()=>{
  assert.equal(rovingStop(['a','b'],'b','a'),'b');
  assert.equal(rovingStop(['a','b'],'collapsed','b'),'b');
  assert.equal(rovingStop(['a','b'],null,'hidden'),'a');
  assert.equal(rovingStop([],null,'a'),null);
});

test('new chats land in the active folder/project, dropping references the runtime would reject',()=>{
  assert.deepEqual(newChatTarget(chat('p',{projectId:'project',folderId:'folder'}),snapshot),{folderId:'folder',projectId:'project'});
  assert.deepEqual(newChatTarget(chat('f',{folderId:'folder'}),snapshot),{folderId:'folder'});
  assert.deepEqual(newChatTarget(chat('s',{projectId:'removed',folderId:'removed'}),snapshot),{});
  assert.deepEqual(newChatTarget(chat('m',{projectId:'project',folderId:'other'}),{...snapshot,folders:[...snapshot.folders,{id:'other',name:'Other',path:'/other'}]}),{folderId:'other'});
  assert.deepEqual(newChatTarget(null,snapshot),{});
});
