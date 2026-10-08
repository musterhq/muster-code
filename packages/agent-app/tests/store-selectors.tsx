/** F1 (fluidity): narrow store subscriptions. A composer keystroke re-renders the Composer only, and a snapshot that changed nothing keeps every reference. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>(),scrolls:string[]=[];
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.chatId);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.closest('[data-chat-id]')?.dataset.chatId??this.className);};
// SketchPad's canvas, for the draft's + → Sketch check: linkedom has no real 2D context or toBlob (see composer-components.tsx).
window.HTMLCanvasElement.prototype.getContext=()=>null;
const twoHoursAgo=new Date(Date.now()-2*3600_000).toISOString();
const mk=(id:string,extra:Record<string,unknown>={})=>({id,title:id,folderId:'folder',status:'completed',updatedAt:twoHoursAgo,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow',...extra});
let chats:any[]=[mk('one',{draft:'hello'}),mk('two')];
const listeners=new Set<(event:any)=>void>(),listener=(event:any)=>{for(const fn of listeners)fn(event);};
const calls:{command:string;input:any}[]=[];
const snapshot=()=>JSON.parse(JSON.stringify({version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'one'}));
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.update'){chats=chats.map(chat=>chat.id===input.id?{...chat,...input}:chat);return chats.find(chat=>chat.id===input.id);}
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow',available:true,models:[{id:'fixture',name:'Fixture'}]}];
  if(command==='plugins.list'||command==='plugins.inventory'||command==='skills.list'||command==='files.list')return [];
  if(command==='files.search')return {entries:[],truncated:false};
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='computer.permissions')return {accessibility:'granted',screen:'granted'};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store'),{Sidebar}=await import('../src/renderer/components/Sidebar');
const {Composer}=await import('../src/renderer/components/Composer'),{SummaryCard}=await import('../src/renderer/components/SummaryCard');
const {shareStructure}=await import('../src/renderer/structuralShare');
const {useStoreSlice}=await import('../src/renderer/useStore');
const commits:Record<string,number>={sidebar:0,summary:0,composer:0};
const count=(id:string)=>()=>{commits[id]++;};
function Probe({id,keys}:{id:string;keys:any[]}){const slice=useStoreSlice(...keys);void slice;commits[id]++;return null;}
function Screen(){
  const chat=store.activeChat();
  return <>
    <React.Profiler id="sidebar" onRender={count('sidebar')}><Sidebar/></React.Profiler>
    <React.Profiler id="summary" onRender={count('summary')}><SummaryCard/></React.Profiler>
    {chat&&<React.Profiler id="composer" onRender={count('composer')}><Composer chat={chat}/></React.Profiler>}
    <Probe id="probe" keys={['snapshot','activeChatId']}/>
  </>;
}
commits.probe=0;
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Screen/>);await delay(500);
assert.deepEqual(errors,[]);assert.ok(document.querySelector('[data-testid="composer-input"]'),'the composer is mounted');
const reset=()=>{for(const key of Object.keys(commits))commits[key]=0;};

// 1. A keystroke is a composerDrafts change: only the Composer commits. Sidebar, SummaryCard and a snapshot-only slice stay put.
reset();
for(let i=1;i<=20;i++){store.setComposerDraft('one','hello'+'x'.repeat(i));await delay(4);}
await delay(30);
assert.ok(commits.composer>=20,`the composer renders for each keystroke (${commits.composer})`);
assert.equal(commits.sidebar,0,'a composer keystroke does not re-render the Sidebar');
assert.equal(commits.summary,0,'a composer keystroke does not re-render the SummaryCard');
assert.equal(commits.probe,0,'a snapshot-only slice does not see draft edits');
assert.equal(store.getState().snapshot!.chats[0].draft,'hello','drafts stay out of snapshot.chats (they live in composerDrafts)');
assert.equal(store.getState().composerDrafts.one.text,'hello'+'x'.repeat(20));

// 2. A snapshot that changed nothing is structurally shared: same references, no commits anywhere.
await delay(300); // the debounced draft save has run
listener({type:'snapshot',snapshot:snapshot()});await delay(40); // the runtime echoes the saved draft
const before=store.getState().snapshot!;reset();
listener({type:'snapshot',snapshot:snapshot()});await delay(40);
assert.equal(store.getState().snapshot,before,'an identical snapshot keeps the previous object');
assert.equal(commits.sidebar+commits.summary+commits.probe,0,'nothing re-renders for an unchanged snapshot');

// 3. One chat changed: only its record is replaced.
const [one,two,folder]=[before.chats[0],before.chats[1],before.folders[0]];
chats=chats.map(chat=>chat.id==='two'?{...chat,title:'renamed'}:chat);
listener({type:'snapshot',snapshot:snapshot()});await delay(40);
const after=store.getState().snapshot!;
assert.notEqual(after,before);assert.equal(after.chats[0],one,'an unchanged chat keeps its reference');assert.notEqual(after.chats[1],two);assert.equal(after.chats[1].title,'renamed');assert.equal(after.folders[0],folder,'folders keep their reference');
assert.deepEqual(errors,[]);


// 4. F3: window focus. A snapshot younger than 2 s makes the refresh a no-op; stale focus bursts collapse into one fetch.
const snapshotReads=()=>calls.filter(call=>call.command==='app.snapshot').length;
listener({type:'snapshot',snapshot:snapshot()});await delay(20);
const reads0=snapshotReads();
for(let i=0;i<5;i++)window.dispatchEvent(new window.Event('focus'));await delay(300);
assert.equal(snapshotReads(),reads0,'focus right after a snapshot does not refetch');
const realNow=Date.now;Date.now=()=>realNow()+store.FOCUS_REFRESH_FRESH_MS+1000;
for(let i=0;i<5;i++)window.dispatchEvent(new window.Event('focus'));await delay(store.FOCUS_REFRESH_DEBOUNCE_MS+200);
Date.now=realNow;
assert.equal(snapshotReads(),reads0+1,'a burst of focus events after a quiet period refetches once');

// shareStructure on its own: ids match across reorders; equal arrays come back as the same array.
const prev=[{id:'a',n:1},{id:'b',n:2}];
assert.equal(shareStructure(prev,[{id:'a',n:1},{id:'b',n:2}]),prev);
const reordered=shareStructure(prev,[{id:'b',n:2},{id:'a',n:1}]);assert.equal(reordered[0],prev[1]);assert.equal(reordered[1],prev[0]);assert.notEqual(reordered,prev);
console.log('store selectors: ok');
process.exit(0);
