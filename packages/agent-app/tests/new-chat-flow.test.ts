import assert from 'node:assert/strict';
import {test} from 'node:test';
import {isUnusedChat,resolveTarget,reusableChat,sameTarget,targetKey,targetOptions} from '../src/renderer/chatNavigation.ts';
import type {Chat} from '../src/shared/protocol.ts';
const chat=(id:string,patch:Partial<Chat>={}):Chat=>({id,title:'New chat',status:'idle',updatedAt:'2026-09-19T00:00:00Z',pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...patch});
const snapshot={
  folders:[{id:'app',name:'App',path:'/app'},{id:'gone',name:'Gone',path:'/gone',missing:true}],
  projects:[{id:'launch',name:'Launch',goal:'Ship it',folderIds:['app']},{id:'empty',name:'Empty',goal:'',folderIds:[]},{id:'old',name:'Old',goal:'',folderIds:['app'],archived:true},{id:'stale',name:'Stale',goal:'',folderIds:['gone']}],
};

test('target options offer a plain chat, every available folder and every live project with a folder',()=>{
  assert.deepEqual(targetOptions(snapshot).map(option=>option.key),['none','folder:app','project:launch']);
  assert.deepEqual(targetOptions(snapshot).find(option=>option.key==='project:launch')?.target,{folderId:'app',projectId:'launch'});
  assert.deepEqual(targetOptions(null).map(option=>option.key),['none'],'with no workspace only a plain chat is possible');
});

test('a target resolves to its option and falls back when the folder or project is gone',()=>{
  assert.equal(resolveTarget({folderId:'app'},snapshot).label,'App');
  assert.equal(resolveTarget({folderId:'app',projectId:'launch'},snapshot).label,'Launch');
  assert.equal(resolveTarget({folderId:'app',projectId:'removed'},snapshot).key,'folder:app','a removed project keeps the folder');
  assert.equal(resolveTarget({folderId:'gone'},snapshot).key,'none','a missing folder becomes a plain chat');
  assert.equal(targetKey({}),'none');
});

test('only an untouched chat counts as unused',()=>{
  assert.ok(isUnusedChat(chat('a')));
  assert.ok(isUnusedChat(chat('a'),0),'a loaded empty timeline is unused');
  assert.ok(!isUnusedChat(chat('a'),2),'a chat with messages is used');
  assert.ok(!isUnusedChat(chat('a',{title:'Fix login'})),'a titled chat has been used');
  assert.ok(!isUnusedChat(chat('a',{draft:'half a thought'})),'a saved draft is user data');
  assert.ok(!isUnusedChat(chat('a'),0,'typed but unsaved'),'so is unsaved composer text');
  assert.ok(!isUnusedChat(chat('a',{status:'running'})));
  assert.ok(!isUnusedChat(chat('a',{providerThreadId:'thread'})));
  assert.ok(!isUnusedChat(chat('a',{archived:true})));
  assert.ok(!isUnusedChat(chat('a',{pinned:true})));
});

test('reuse picks the newest unused chat in exactly the same target',()=>{
  const chats=[
    chat('plain'),
    chat('folder-old',{folderId:'app',updatedAt:'2026-09-18T00:00:00Z'}),
    chat('folder-new',{folderId:'app',updatedAt:'2026-09-20T00:00:00Z'}),
    chat('folder-used',{folderId:'app',updatedAt:'2026-09-21T00:00:00Z',title:'Real work'}),
    chat('project',{folderId:'app',projectId:'launch'}),
  ];
  assert.equal(reusableChat(chats,{folderId:'app'})?.id,'folder-new');
  assert.equal(reusableChat(chats,{})?.id,'plain','a plain chat reuses only folderless chats');
  assert.equal(reusableChat(chats,{folderId:'app',projectId:'launch'})?.id,'project');
  assert.equal(reusableChat(chats,{folderId:'app'},id=>id==='folder-new'?3:undefined)?.id,'folder-old','loaded messages disqualify a chat');
  assert.equal(reusableChat(chats,{folderId:'app'},()=>undefined,id=>id.startsWith('folder')?'draft':undefined),undefined,'composer drafts disqualify');
  assert.equal(reusableChat([],{folderId:'app'}),undefined);
  assert.ok(sameTarget({folderId:'app'},{folderId:'app'})&&!sameTarget({folderId:'app',projectId:'launch'},{folderId:'app'}));
});
