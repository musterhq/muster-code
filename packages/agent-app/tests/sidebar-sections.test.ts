import assert from 'node:assert/strict';
import {test} from 'node:test';
import {SETTLED_PAGE,buildLookups,buildSections,defaultNewChatFolder,disambiguate,elapsedLabel,pageSettled,parentHint,rowMeta,sameMeta,sectionOf} from '../src/renderer/sidebarSections.ts';
import {chatGroup,compareChats} from '../src/renderer/chatNavigation.ts';
import {chatOrder} from '../src/renderer/navHistory.ts';
import {isInstalledCard,shortSourceLabel} from '../src/renderer/marketplaceCatalog.ts';
import {showsStatusChip} from '../src/renderer/projectStatus.ts';
import type {Chat} from '../src/shared/protocol.ts';

const NOW=Date.parse('2026-10-12T12:00:00Z');
const ago=(ms:number)=>new Date(NOW-ms).toISOString();
const chat=(id:string,extra:Partial<Chat>={}):Chat=>({id,title:id,pinned:false,archived:false,draft:'',status:'idle',updatedAt:ago(1000),model:'m',mode:'agent',...extra});

test('a running chat is Working even when pinned, snoozed or in a folder; other chats split active and settled',()=>{
  assert.equal(sectionOf(chat('a',{status:'running',pinned:true}),NOW,false),'working');
  assert.equal(sectionOf(chat('a',{status:'stopping',snoozedUntil:ago(-1000)}),NOW,false),'working');
  assert.equal(sectionOf(chat('a',{pinned:true}),NOW,false),'pinned');
  assert.equal(sectionOf(chat('a',{unread:true,updatedAt:ago(30*86400_000)}),NOW,false),'active');
  assert.equal(sectionOf(chat('a',{updatedAt:ago(30*86400_000)}),NOW,true),'active','waiting on you keeps it active');
  assert.equal(sectionOf(chat('a',{updatedAt:ago(30*86400_000)}),NOW,false),'settled');
  assert.equal(sectionOf(chat('a',{updatedAt:''}),NOW,false),'active','an unreadable date is never settled');
  assert.equal(sectionOf(chat('a',{archived:true,status:'running'}),NOW,false),'archived');
  assert.equal(chatGroup(chat('a',{status:'running',pinned:true,folderId:'f'}),{folders:[{id:'f',name:'f',path:'/f'}],projects:[]}),'working');
});

test('sections keep each chat in exactly one bucket, in the requested order',()=>{
  const chats=[chat('old',{updatedAt:ago(9*86400_000)}),chat('run',{status:'running'}),chat('pin',{pinned:true}),chat('new',{updatedAt:ago(5000)})];
  const sections=buildSections(chats,new Set(),NOW,compareChats('recent'));
  assert.deepEqual(Object.fromEntries(Object.entries(sections).map(([key,list]:[string,Chat[]])=>[key,list.map((item:Chat)=>item.id)])),{working:['run'],pinned:['pin'],active:['new'],settled:['old'],snoozed:[],archived:[]});
});

test('settled shows ten, then more on request',()=>{
  const items=Array.from({length:14},(_,index)=>index);
  assert.deepEqual(pageSettled(items),{visible:items.slice(0,SETTLED_PAGE),more:4});
  assert.deepEqual(pageSettled(items,20),{visible:items,more:0});
  assert.deepEqual(pageSettled(items.slice(0,3)),{visible:[0,1,2],more:0});
});

test('identical folder and chat names get a parent path or suffix hint; unique names get none',()=>{
  assert.equal(parentHint('/Users/me/work/redis-automation','redis-automation'),'me/work');
  const hints=disambiguate([{id:'1',name:'redis-automation',path:'/a/team/redis-automation'},{id:'2',name:'redis-automation',path:'/b/team/redis-automation'},{id:'3',name:'other',path:'/c/other'}]);
  assert.equal(hints.get('1'),'a/team');assert.equal(hints.get('2'),'b/team');assert.equal(hints.has('3'),false);
  const same=disambiguate([{id:'1',name:'x',path:'/p/x'},{id:'2',name:'x',path:'/p/x'}]);
  assert.deepEqual([same.get('1'),same.get('2')],['p · #1','p · #2']);
  assert.deepEqual([...disambiguate([{id:'1',name:'x'},{id:'2',name:'x'}]).values()],['#1','#2']);
  const snapshot={folders:[{id:'f1',name:'app',path:'/a/app'},{id:'f2',name:'lib',path:'/a/lib'}],projects:[],chats:[chat('c1',{title:'ossmgr UI',folderId:'f1'}),chat('c2',{title:'ossmgr UI',folderId:'f2'}),chat('c3',{title:'solo',folderId:'f1'})]};
  const lookups=buildLookups(snapshot);
  assert.equal(lookups.chatHints.get('c1'),'app');assert.equal(lookups.chatHints.get('c2'),'lib');assert.equal(lookups.chatHints.has('c3'),false);
});

test('row meta carries chip, branch, PRs, provider and the unseen state from lookup maps',()=>{
  const snapshot={folders:[{id:'f',name:'repo',path:'/r/repo'}],projects:[{id:'p',name:'Launch',goal:'',folderIds:['f']}],chats:[chat('c',{folderId:'f',projectId:'p',providerId:'claude-code',unread:true}),chat('d',{folderId:'f',status:'running',unread:true})],attention:{totalRequests:2,chats:[{chatId:'c',approvalCount:0,questionCount:0,requests:[{},{}]} as never]}};
  const lookups=buildLookups(snapshot as never);
  const meta=rowMeta(snapshot.chats[0]!,lookups,3,{branch:'dev',prs:2});
  assert.deepEqual({chip:meta.chip,branch:meta.branch,prs:meta.prs,providerId:meta.providerId,attention:meta.attention,processes:meta.processes,unseen:meta.unseen},{chip:'Launch',branch:'dev',prs:2,providerId:'claude-code',attention:2,processes:3,unseen:true});
  assert.equal(rowMeta(snapshot.chats[1]!,lookups,0).unseen,false,'a running chat is not an unseen completion');
  assert.equal(sameMeta(meta,{...meta}),true);assert.equal(sameMeta(meta,{...meta,prs:3}),false);
});

test('chat order for keyboard navigation lists Working first',()=>{
  const snapshot={folders:[],projects:[],chats:[chat('a'),chat('b',{status:'running',pinned:true})]};
  assert.deepEqual(chatOrder(snapshot,'recent').map(item=>item.id),['b','a']);
});

test('elapsed label reads like Working 20s',()=>{
  assert.equal(elapsedLabel(20_400),'20s');assert.equal(elapsedLabel(185_000),'3m 05s');assert.equal(elapsedLabel(3_720_000),'1h 02m');assert.equal(elapsedLabel(-5),'0s');
});

test('a new chat never defaults to the home or Documents folder',()=>{
  const broad=(path:string)=>/^\/Users\/me(\/Documents)?$/.test(path);
  const folders=[{id:'docs',name:'Documents',path:'/Users/me/Documents'},{id:'proj',name:'proj',path:'/Users/me/code/proj'},{id:'gone',name:'gone',path:'/x',missing:true}];
  const chats=[chat('a',{folderId:'docs',updatedAt:ago(10)}),chat('b',{folderId:'proj',updatedAt:ago(50_000)})];
  assert.equal(defaultNewChatFolder({folders,chats},'proj',broad),'proj','the last-used folder wins');
  assert.equal(defaultNewChatFolder({folders,chats},'docs',broad),'proj','a broad last-used folder falls back to the newest project folder');
  assert.equal(defaultNewChatFolder({folders,chats},'gone',broad),'proj');
  assert.equal(defaultNewChatFolder({folders:[folders[0]!],chats:[chats[0]!]},undefined,broad),undefined,'nothing usable means a plain chat, not Documents');
});

test('skills cards: long Codex source paths shrink, installed items leave Discover, empty projects show no status',()=>{
  assert.equal(shortSourceLabel('Codex: /Users/me/.codex/plugins/cache/openai-curated/github/1.0.0'),'Codex');
  assert.equal(shortSourceLabel('Anthropic Skills'),'Anthropic Skills');
  assert.equal(isInstalledCard({pkg:{installed:undefined},installedAs:undefined} as never),false);
  assert.equal(isInstalledCard({pkg:{installed:{}},installedAs:undefined} as never),true);
  assert.equal(isInstalledCard({pkg:{},installedAs:{kind:'codex',id:'x'}} as never),true);
  assert.equal(showsStatusChip('in_progress',0),false);
  assert.equal(showsStatusChip('in_progress',3),true);
  assert.equal(showsStatusChip('completed',0),true);
  assert.equal(showsStatusChip('in_progress',undefined),true);
});
