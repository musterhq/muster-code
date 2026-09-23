import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chatOrder,installNavHistory,NavHistory,neighbourChat} from '../src/renderer/navHistory.ts';
import type {Chat} from '../src/shared/protocol.ts';

test('history records selection changes into bounded back/forward stacks',()=>{
  const history=new NavHistory(3);
  history.track(null);
  history.track('a');
  assert.equal(history.canBack,false,'the first selection has nothing to return to');
  history.track('b');history.track('b');history.track('c');history.track('d');history.track('e');
  assert.equal(history.goBack(),'d');
  assert.equal(history.goBack(),'c');
  assert.equal(history.goBack(),'b');
  assert.equal(history.goBack(),null,'the oldest entry fell off the bounded stack');
  assert.equal(history.canForward,true);
  assert.equal(history.goForward(),'c');
  assert.equal(history.goForward(),'d');
  assert.equal(history.goForward(),'e');
  assert.equal(history.goForward(),null);
});

test('a fresh selection clears forward, invalid entries are skipped, and suppressed moves are not recorded',()=>{
  const history=new NavHistory();
  for(const id of ['a','b','c'])history.track(id);
  assert.equal(history.goBack(),'b');
  history.track('d');
  assert.equal(history.canForward,false,'branching discards the forward stack');
  assert.equal(history.goBack(id=>id!=='b'),'a','deleted chats are skipped, not visited');
  assert.equal(history.goForward(),'d');
  history.suppressed(()=>history.track('z'));
  assert.equal(history.goBack(),'a','a suppressed selection does not push an entry');
  assert.equal(history.goForward(),'z','but the current position follows it');
});

test('installNavHistory follows a store and selects through the supplied callback without re-recording',()=>{
  let active:string|null='a';
  const listeners=new Set<()=>void>();
  const selected:string[]=[];
  const chats=new Set(['a','b','c']);
  const handle=installNavHistory({
    subscribe:listener=>{listeners.add(listener);return()=>listeners.delete(listener);},
    activeChatId:()=>active,
    exists:id=>chats.has(id),
    select:id=>{selected.push(id);active=id;for(const l of listeners)l();},
  });
  const set=(id:string)=>{active=id;for(const l of listeners)l();};
  set('b');set('c');
  const changes:Array<[boolean,boolean]>=[];
  handle.history.subscribe(()=>changes.push([handle.history.canBack,handle.history.canForward]));
  assert.equal(handle.goBack(),true);
  assert.deepEqual(selected,['b']);
  assert.equal(handle.goBack(),true);
  assert.deepEqual(selected,['b','a']);
  assert.equal(handle.goBack(),false,'nothing older');
  assert.equal(handle.goForward(),true);
  assert.deepEqual(selected,['b','a','b']);
  assert.deepEqual(changes.at(-1),[true,true]);
  chats.delete('c');
  assert.equal(handle.goForward(),false,'a deleted chat is dropped from forward');
  assert.equal(handle.history.canForward,false);
  handle.dispose();
  set('q');
  assert.equal(handle.history.canBack,true);
  assert.equal(handle.goBack(),true);
  assert.deepEqual(selected.at(-1),'a','disposed histories stop tracking new selections');
});

const chat=(id:string,patch:Partial<Chat>={}):Chat=>({id,title:id,status:'completed',updatedAt:'2026-09-19T00:00:00Z',pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...patch});

test('chatOrder mirrors the sidebar: pinned, folders, projects, loose, archived; neighbours wrap',()=>{
  const snapshot={
    folders:[{id:'f1',name:'One',path:'/one'},{id:'f2',name:'Two',path:'/two'}],
    projects:[{id:'p1',name:'Project',goal:'',folderIds:['f1']}],
    chats:[
      chat('loose'),chat('gone-project',{projectId:'missing'}),chat('f2-chat',{folderId:'f2'}),chat('f1-new',{folderId:'f1',updatedAt:'2026-09-20T00:00:00Z'}),
      chat('f1-old',{folderId:'f1'}),chat('proj',{projectId:'p1',folderId:'f1'}),chat('pin',{pinned:true,folderId:'f2'}),chat('arch',{archived:true,pinned:true}),
    ],
  };
  const order=chatOrder(snapshot,'recent').map(c=>c.id);
  assert.deepEqual(order,['pin','f1-new','f1-old','f2-chat','proj','gone-project','loose','arch'],'ties within a group fall back to title order');
  const rows=chatOrder(snapshot,'recent');
  assert.equal(neighbourChat(rows,'pin',-1)?.id,'arch','previous from the first row wraps to the last');
  assert.equal(neighbourChat(rows,'arch',1)?.id,'pin');
  assert.equal(neighbourChat(rows,'f1-old',1)?.id,'f2-chat');
  assert.equal(neighbourChat(rows,null,1)?.id,'pin','no selection starts at the top');
  assert.equal(neighbourChat(rows,'unknown',-1)?.id,'arch');
  assert.equal(neighbourChat([rows[0]],'pin',1),null,'a single chat has no neighbour');
  assert.equal(neighbourChat([],null,1),null);
});
