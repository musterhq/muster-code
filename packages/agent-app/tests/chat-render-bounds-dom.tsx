/** Streaming one token must not re-render the composer. */
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
  if(command==='chat.timeline')return {items:[{id:'a1',chatId:'one',kind:'assistant',text:'hi',createdAt:''}],revision:1};
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
const {ResourceLink}=await import('../src/renderer/components/ResourceLink');
const {ChangesView}=await import('../src/renderer/components/ChangesView');
const {shareStructure}=await import('../src/renderer/structuralShare');
const {useStoreSlice}=await import('../src/renderer/useStore');
const commits:Record<string,number>={sidebar:0,summary:0,composer:0,links:0,changes:0,processes:0};
const count=(id:string)=>()=>{commits[id]++;};
function Probe({id,keys}:{id:string;keys:any[]}){const slice=useStoreSlice(...keys);void slice;commits[id]++;return null;}
function Screen(){
  const chat=store.activeChat();
  return <>
    <React.Profiler id="sidebar" onRender={count('sidebar')}><Sidebar/></React.Profiler>
    <React.Profiler id="summary" onRender={count('summary')}><SummaryCard/></React.Profiler>
    <React.Profiler id="links" onRender={count('links')}>{[1,2,3].map(n=><ResourceLink key={n} href="https://example.com/x">link</ResourceLink>)}</React.Profiler>
    <React.Profiler id="changes" onRender={count('changes')}><ChangesView folderId="folder" repo={{root:'/fixture',branch:'main'} as any}/></React.Profiler>
    {chat&&<React.Profiler id="composer" onRender={count('composer')}><Composer chat={chat}/></React.Profiler>}
    <Probe id="probe" keys={['snapshot','activeChatId']}/>
  </>;
}
commits.probe=0;
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Screen/>);await delay(500);
assert.deepEqual(errors,[]);assert.ok(document.querySelector('[data-testid="composer-input"]'),'the composer is mounted');
const reset=()=>{for(const key of Object.keys(commits))commits[key]=0;};

await delay(100);
reset();
for(let i=1;i<=20;i++){listener({type:'timelinePatch',chatId:'one',patch:{after:i,revision:i+1,items:[{id:'a1',chatId:'one',kind:'assistant',text:'hi'+' tok'.repeat(i),createdAt:''}]}});await delay(8);}
await delay(60);
console.log('composer commits for 20 streamed tokens',commits.composer,'links',commits.links,'changes',commits.changes,'sidebar',commits.sidebar,'summary',commits.summary);
assert.match(JSON.stringify(store.getState().timelines.one.value),/tok tok tok/);
assert.ok(commits.composer<=2,`streaming a token must not re-render the composer (${commits.composer} commits for 20 tokens)`);
assert.ok(commits.links<=2,`streaming a token must not re-render resource links (${commits.links} commits for 20 tokens)`);
assert.ok(commits.changes<=2,`streaming a token must not re-render the changes view (${commits.changes} commits for 20 tokens)`);
assert.deepEqual(errors,[]);
process.exit(0);
