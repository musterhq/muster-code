/** #403: real draft, sidebar and transcript workflows; temporary durable title store. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check as runCheck} from './dom-check.ts';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AgentStore} from '../src/runtime/store';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>(),scrolls:string[]=[];
Object.assign(globalThis,{CustomEvent:window.CustomEvent,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.chatId);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.closest('[data-chat-id]')?.dataset.chatId??this.className);};
// SketchPad's canvas, for the draft's + → Sketch check: linkedom has no real 2D context or toBlob (see composer-components.tsx).
window.HTMLCanvasElement.prototype.getContext=()=>null;
const dir=await mkdtemp(join(tmpdir(),'muster-403-')),durable=new AgentStore(dir);
const mk=(id:string,extra:Record<string,unknown>={})=>({id,title:id,folderId:'alpha',status:'completed',updatedAt:'2026-10-20T10:00:00Z',pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...extra});
let chats:any[]=[mk('work',{projectId:'project'}),mk('beta-work',{folderId:'beta'}),mk('plain',{folderId:undefined}),mk('documents',{folderId:'documents'})];
let folders:any[]=[{id:'alpha',name:'Alpha',path:'/Users/fixture/work/alpha'},{id:'beta',name:'Beta',path:'/Users/fixture/work/beta'},{id:'documents',name:'Documents',path:'/Users/fixture/Documents'}];
const listeners=new Set<(event:any)=>void>(),calls:{command:string;input:any}[]=[];
const snapshot=()=>({version:1,chats,folders,projects:[{id:'project',name:'Launch',goal:'Ship it',folderIds:['alpha']}],activeChatId:'work'});
const emit=()=>{for(const fn of listeners)fn({type:'snapshot',snapshot:snapshot()});};
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.create'){const chat=durable.createChat({model:'fixture',mode:'agent'});chats=[...chats,{...chat,...input}];emit();return chats.at(-1);}
  if(command==='chat.send'){durable.recordSend(input.id,`request-${input.id}`,input.text);chats=chats.map(chat=>chat.id===input.id?{...chat,...durable.chat(input.id)}:chat);emit();return {runId:`run-${input.id}`,replay:false};}
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='chat.defaults')return {providerId:'fixture',model:'fixture',source:'runtime'};
  if(command==='providers.list')return [{id:'fixture',name:'Fixture',available:true,models:[{id:'fixture',name:'Fixture'}]}];
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='checkout.leases')return {leases:[]};
  if(command==='processes.list')return {sessions:[]};
  if(command==='plugins.list'||command==='plugins.inventory'||command==='skills.list'||command==='files.list')return [];
  if(command==='files.search')return {entries:[],truncated:false};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store'),{Sidebar}=await import('../src/renderer/components/Sidebar');
const drafts=await import('../src/renderer/newChatDraft'),{NewChatScreen}=await import('../src/renderer/components/NewChatScreen');
const {Timeline}=await import('../src/renderer/components/ChatView');
const errors:unknown[]=[],failures:string[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
function Shell(){const draft=drafts.useNewChatDraft();return <><Sidebar/>{draft.open&&<NewChatScreen/>}</>;}
const render=async()=>{root.render(<Shell/>);await delay(100);assert.deepEqual(errors,[]);};
const check=async(name:string,fn:()=>Promise<void>)=>{try{await runCheck(name,fn);}catch(error){failures.push(name);console.error(error);drafts.closeNewChat();}};
const row=(id:string)=>document.querySelector(`[data-chat-id="${id}"]`)!;
const newChat=async()=>{(Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-toolbar button')).find(button=>button.textContent==='New chat')!).click();await delay(40);};
const target=()=>document.querySelector('.new-chat-target-chip')?.getAttribute('aria-label');
const send=async(text:string)=>{const field=document.querySelector('[data-testid="new-chat"] textarea') as HTMLTextAreaElement;field.value=text;(field as any)._valueTracker?.setValue('');field.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(10);(document.querySelector('[data-testid="new-chat"] .composer-send') as HTMLButtonElement).click();await delay(80);};
await store.boot();await render();
// Spec: MUS-SPEC-01-403A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-403a)
await check('sending a first message keeps punctuation in its generated sidebar title',async()=>{
  for(const prompt of ['Why deploy?','Fix! notes. scope: /src/ #42','"Review" \'draft\'']){
    drafts.openNewChat({});await delay(30);await send(prompt);
    const id=store.getState().activeChatId!;
    assert.equal(row(id).querySelector('.chat-title')?.textContent,prompt,'provisional title keeps punctuation');
    durable.appendItem(id,'assistant','Done.','completed');durable.updateChat(id,{status:'completed'});durable.settleTitle(id);
    chats=chats.map(chat=>chat.id===id?{...chat,...durable.chat(id)}:chat);emit();await delay(40);
    assert.equal(row(id).querySelector('.chat-title')?.textContent,prompt,'settled title keeps punctuation');
    durable.updateChat(id,{title:'My title: "keep it!"'});durable.settleTitle(id);
    assert.equal(durable.chat(id)!.title,'My title: "keep it!"','a rename still wins');
  }
});
// Spec: MUS-SPEC-01-403B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-403b)
await check('New chat returns to the last project after a folderless or Documents chat',async()=>{
  await render();await store.selectChat('work');await store.selectChat('plain');await newChat();
  assert.equal(target(),'Start in: Launch','folderless chat retains the last selected project');
  await send('Build a release');
  assert.deepEqual(calls.filter(call=>call.command==='chat.create').at(-1)!.input,{folderId:'alpha',projectId:'project'},'send uses the folder shown');
  await store.selectChat('work');await store.selectChat('documents');await newChat();
  assert.equal(target(),'Start in: Launch','Documents never becomes the implicit default');
  drafts.closeNewChat();await store.selectChat('beta-work');await store.selectChat('plain');await newChat();
  assert.equal(target(),'Start in: Beta','the last selection wins over the previous project');
  drafts.closeNewChat();folders=folders.filter(folder=>folder.id!=='beta');emit();await delay(20);await newChat();
  assert.equal(target(),'Start in: Launch','a removed remembered folder is skipped');
  drafts.closeNewChat();folders=folders.filter(folder=>folder.id==='documents');emit();await delay(20);await newChat();
  assert.equal(target(),'Start in: No folder','only broad folders means no implicit folder');
  drafts.closeNewChat();await delay(20);(document.querySelector('[aria-label="New chat without a folder"]') as HTMLButtonElement).click();await delay(30);
  assert.equal(target(),'Start in: No folder','an explicit plain chat stays plain');drafts.closeNewChat();
});
// Spec: MUS-SPEC-01-403C (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-403c)
await check('a one-turn transcript has no lone minimap dash and later turns remain reachable',async()=>{
  Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{configurable:true,get(){return 350;}});
  Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{configurable:true,get(){return Number.parseFloat(this.querySelector('.timeline-inner')?.style.height||'350');}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{configurable:true,get(){return this.classList.contains('timeline-row')?100:350;}});
  Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{configurable:true,get(){return 800;}});
  window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,width:800,height:this.classList.contains('timeline-row')?100:350,left:0,top:0,right:800,bottom:350};};
  window.HTMLElement.prototype.scrollTo=function({top}:any){this.scrollTop=top;};
  const items:any[]=Array.from({length:12},(_,index)=>({id:`item-${index}`,chatId:'transcript',kind:index%6===0?'user':'assistant',text:index%6===0?`Question ${index/6+1}`:'A reply paragraph.',createdAt:'2026-10-20T10:00:00Z'}));
  root.render(<Timeline chatId="transcript" items={items.slice(0,6)}/>);await delay(100);
  assert.equal(document.querySelectorAll('.turn-tick').length,0,'one turn has no lone dash');
  window.dispatchEvent(new window.Event('muster:find-in-chat'));await delay(30);
  assert.ok(document.querySelector('[aria-label="Find in conversation"]'),'single-turn search remains reachable');
  root.render(<Timeline chatId="transcript" items={items}/>);await delay(100);assert.equal(document.querySelectorAll('.turn-tick').length,2);
  for(let i=1;i>=0;i--){(document.querySelector(`[aria-label="Turn ${i+1}: Question ${i+1}"]`) as HTMLButtonElement).click();await delay(40);assert.ok(document.querySelector(`[data-item-id="item-${i*6}"]`),'tick reveals its matching user row');assert.equal(document.querySelector('.timeline')!.scrollTop,i*600,'tick jumps to its own row, including the real first row at zero');}
  root.render(<Timeline chatId="transcript" items={items.slice(0,6)}/>);await delay(60);assert.equal(document.querySelectorAll('.turn-tick').length,0,'no stale marker after removing a turn');
  root.render(<Timeline chatId="transcript" items={[]}/>);await delay(60);assert.equal(document.querySelectorAll('.turn-tick').length,0);
});
// Spec: MUS-SPEC-01-403D (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-403d)
await check('duplicate sidebar chat names get distinct suffixes without renaming them',async()=>{
  folders=[{id:'alpha',name:'Alpha',path:'/work/alpha'},{id:'beta',name:'Beta',path:'/work/beta'}];
  chats=[mk('dup-a',{title:'Release?'}),mk('dup-b',{title:'Release?',folderId:'beta'}),mk('dup-c',{title:'Release?'}),mk('unique',{title:'Only one!'})];emit();await render();
  const hints=['dup-a','dup-b','dup-c'].map(id=>row(id).querySelector('.chat-title-hint')?.textContent);
  assert.ok(hints.every(Boolean),'duplicate rows have a visible suffix');assert.equal(new Set(hints).size,3,'even same-folder duplicates have distinct hints');assert.equal(row('unique').querySelector('.chat-title-hint'),null,'unique titles have no suffix');
  for(const id of ['dup-a','dup-b','dup-c']){(row(id).querySelector('.chat-row-main') as HTMLButtonElement).click();await delay(30);assert.equal(store.getState().activeChatId,id);assert.equal(row(id).querySelector('.chat-title')?.textContent,'Release?');}
  chats=chats.map(chat=>chat.id==='dup-b'?{...chat,title:'Different!'}:chat);emit();await delay(40);assert.equal(row('dup-b').querySelector('.chat-title-hint'),null,'rename removes its obsolete hint');assert.equal(row('dup-b').querySelector('.chat-title')?.textContent,'Different!');
});
assert.deepEqual(errors,[]);root.unmount();durable.close();await rm(dir,{recursive:true,force:true});
console.log(`${4-failures.length}/4 sidebar chrome workflows passed`);process.exit(failures.length?1:0);
