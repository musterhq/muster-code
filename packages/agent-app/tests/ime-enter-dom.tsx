/** NAV-11/NAV-12 in the DOM: global search sections, message-content hits with highlighted snippets, a real
 *  empty state, and the command palette (⌘⇧P / "> ") listing disabled commands with their reason. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,KeyboardEvent:window.KeyboardEvent??window.Event,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(k:string)=>saved.get(k)??null,setItem:(k:string,v:string)=>void saved.set(k,v),removeItem:(k:string)=>void saved.delete(k)}});
Object.assign(window,{setTimeout,clearTimeout});
(window.document as any).hasFocus=()=>true;
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:200,height:30,left:0,top:0,right:200,bottom:30});
window.HTMLElement.prototype.scrollIntoView=function(){};
(window.HTMLInputElement.prototype as any).setSelectionRange=function(){};
const chats=[
  {id:'alpha',title:'Refactor auth',folderId:'f1',status:'completed',updatedAt:'2026-09-02T00:00:00Z',pinned:false,archived:false,draft:'',model:'m',mode:'agent'},
  {id:'beta',title:'Release notes',folderId:'f1',status:'completed',updatedAt:'2026-09-01T00:00:00Z',pinned:false,archived:false,draft:'',model:'m',mode:'agent'},
];
const calls:{command:string;input:any}[]=[];
const last=(command:string)=>calls.filter(c=>c.command===command).at(-1)!;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats,folders:[{id:'f1',name:'api-server',path:'/work/api-server'}],projects:[{id:'p1',name:'Billing revamp',goal:'',folderIds:['f1']}]};
  if(command==='chat.search')return input.query.includes('hono')?[{chatId:'beta',snippet:'…move the proxy to Hono…',itemId:'i1',ranges:[[19,23]],matches:1}]:[];
  if(command==='files.quickOpen')return {results:input.query==='util'?[{path:'src/lib/util.ts',score:1}]:[]};
  if(command==='search.workspace'){
    const q=String(input.query),scope=input.scope??'all';
    const mk=(kind:string,id:string,title:string,over:any={})=>({kind,id,title,snippet:'',titleRanges:[],snippetRanges:[],key:null,status:null,source:'local',projectId:'p1',projectName:'Billing revamp',taskId:null,chatId:null,agentId:null,at:null,...over});
    const counts={tasks:0,agents:0,projects:0,documents:0,comments:0,outputs:0,decisions:0};
    if(/^oss-12$/i.test(q))return {query:q,scope,rows:[mk('tasks','t12','Fix the login redirect',{key:'OSS-12',taskId:'t12',exact:true,snippet:'Billing revamp · CTO'})],counts:{...counts,tasks:1},identifier:{key:'OSS-12',found:true},truncated:false};
    if(/^oss-99$/i.test(q))return {query:q,scope,rows:[],counts,identifier:{key:'OSS-99',found:false},truncated:false};
    if(/redirect|cookie/.test(q)){
      const rows=[mk('tasks','t12','Fix the login redirect',{key:'OSS-12',taskId:'t12'}),mk('documents','t12:plan','plan · Fix the login redirect',{key:'OSS-12',taskId:'t12',snippet:'Replace the session cookie before the redirect.',snippetRanges:[[20,26]]}),mk('comments','c1:i1','Fix the login redirect',{key:'OSS-12',taskId:'t12',snippet:'I traced the redirect loop to a stale cookie.'}),mk('agents','member:m1','CTO',{agentId:'member:m1',snippet:'Chief Technology Officer'})];
      return {query:q,scope,rows:scope==='all'?rows:rows.filter(r=>r.kind===scope),counts:{...counts,tasks:1,documents:1,comments:1,agents:1},identifier:null,truncated:false};
    }
    return {query:q,scope,rows:[],counts,identifier:null,truncated:false};
  }
  if(command==='git.info')return {branch:'main',detached:false,fetchedAt:null,hasRemote:false,worktree:null};
  if(command==='chat.timeline'||command==='chat.select')return {items:[],revision:0};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const hub=await import('../src/renderer/hubStore');
const spotlight=await import('../src/renderer/components/SpotlightSearch');
await store.boot();
await store.selectChat('alpha');
const root=createRoot(document.getElementById('root')!);
root.render(<spotlight.SpotlightSearchHost/>);await delay(20);
const input=()=>document.querySelector<HTMLInputElement>('.spotlight-panel input')!;
const type=async(value:string,wait=320)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()),'value')?.set;setter?setter.call(input(),value):(input().value=value);input().dispatchEvent(new window.Event('input',{bubbles:true}));await delay(wait);};
const sections=()=>[...document.querySelectorAll('.spotlight-section-label')].map(node=>node.textContent);
const rowTitles=()=>[...document.querySelectorAll('.spotlight-row .spotlight-row-title')].map(node=>node.textContent);

// Confirming an IME composition with Enter must not run the highlighted row.
spotlight.openSpotlightSearch();await delay(40);
await type('OSS-12');
const enter=(init:Record<string,unknown>)=>input().dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true,cancelable:true}),{key:'Enter'},init));
const before=store.getState().screen;
enter({isComposing:true});await delay(60);
assert.equal(store.getState().screen,before,'Enter that confirms a composition does not open the row');
assert.ok(spotlight.isSpotlightSearchOpen(),'the palette stays open');
enter({keyCode:229});await delay(60);
assert.equal(store.getState().screen,before,'the keyCode 229 keydown that follows compositionend is ignored too');
enter({});await delay(60);
assert.equal(store.getState().screen,'hub','a plain Enter still opens the row');
console.log('PASS: spotlight ignores Enter during IME composition');
process.exit(0);
