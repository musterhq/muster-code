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
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats,folders:[{id:'f1',name:'api-server',path:'/work/api-server'}],projects:[{id:'p1',name:'Billing revamp',goal:'',folderIds:['f1']}]};
  if(command==='chat.search')return input.query.includes('hono')?[{chatId:'beta',snippet:'…move the proxy to Hono…',itemId:'i1',ranges:[[19,23]],matches:1}]:[];
  if(command==='files.quickOpen')return {results:input.query==='util'?[{path:'src/lib/util.ts',score:1}]:[]};
  if(command==='git.info')return {branch:'main',detached:false,fetchedAt:null,hasRemote:false,worktree:null};
  if(command==='chat.timeline'||command==='chat.select')return {items:[],revision:0};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const spotlight=await import('../src/renderer/components/SpotlightSearch');
await store.boot();
await store.selectChat('alpha');
const root=createRoot(document.getElementById('root')!);
root.render(<spotlight.SpotlightSearchHost/>);await delay(20);
const input=()=>document.querySelector<HTMLInputElement>('.spotlight-panel input')!;
const type=async(value:string,wait=320)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input()),'value')?.set;setter?setter.call(input(),value):(input().value=value);input().dispatchEvent(new window.Event('input',{bubbles:true}));await delay(wait);};
const sections=()=>[...document.querySelectorAll('.spotlight-section-label')].map(node=>node.textContent);
const rowTitles=()=>[...document.querySelectorAll('.spotlight-row .spotlight-row-title')].map(node=>node.textContent);

spotlight.openSpotlightSearch();await delay(40);
assert.ok(input(),'⌘K panel opens');
// Global search: a chat found only by what was said in it, with the matched words highlighted.
await type('hono');
assert.ok(sections().includes('Chats'));
const snippet=document.querySelector('.spotlight-row-snippet');
assert.equal(snippet?.textContent,'…move the proxy to Hono…');
assert.equal(snippet?.querySelector('mark')?.textContent,'Hono','the matched term is highlighted in the excerpt');
assert.ok(calls.some(call=>call.command==='chat.search'&&call.input.limit===20&&call.input.offset===0),'paged request');
// Files (quick open over the active chat's folder), folders and Projects are their own result types.
await type('util');
assert.ok(sections().includes('Files'),`sections: ${sections().join(',')}`);
assert.ok(rowTitles().includes('util.ts'));
await type('api');
assert.ok(sections().includes('Folders'));
await type('billing');
assert.ok(sections().includes('Projects'));
assert.ok(rowTitles().includes('Billing revamp'));
// QA: a query that finds nothing says so and suggests what to try — never a blank panel.
await type('zzzznonexistent');
const empty=document.querySelector('.spotlight-results .resource-state-empty');
assert.ok(empty,'empty state renders');
assert.equal(empty!.querySelector('.resource-state-title')?.textContent,'No results for “zzzznonexistent”');
assert.match(empty!.textContent??'',/type > for commands/);

// Command mode by prefix: every command listed; a disabled one says why and does not run.
await type('> forward',30);
const forward=[...document.querySelectorAll('.spotlight-row')].find(row=>row.querySelector('.spotlight-row-title')?.textContent==='Forward')!;
assert.ok(forward,'Forward is listed even though it cannot run');
assert.equal(forward.getAttribute('aria-disabled'),'true');
assert.equal(forward.querySelector('.spotlight-row-snippet')?.textContent,'Nothing to go forward to');
assert.equal(forward.querySelector('.spotlight-shortcut')?.textContent,'⌘]');
(forward as HTMLButtonElement).click();await delay(20);
assert.ok(spotlight.isSpotlightSearchOpen(),'a disabled command keeps the palette open');
assert.match(document.querySelector('.spotlight-status')?.textContent??'',/Forward is unavailable: Nothing to go forward to/);
// Scope visible before execution: chat commands name the chat they act on.
await type('> rename',30);
const rename=[...document.querySelectorAll('.spotlight-row')].find(row=>row.querySelector('.spotlight-row-title')?.textContent==='Rename chat…')!;
assert.equal(rename.getAttribute('aria-disabled'),null);
assert.equal(rename.querySelector('.spotlight-row-snippet')?.textContent,'Refactor auth');
await type('> frobnicate',30);
assert.equal(document.querySelector('.resource-state-title')?.textContent,'No commands match “frobnicate”');
spotlight.closeSpotlightSearch();await delay(30);

// ⌘⇧P opens straight into command mode.
window.dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true,cancelable:true}),{key:'P',metaKey:true,ctrlKey:false,shiftKey:true,altKey:false}));await delay(40);
assert.ok(spotlight.isSpotlightSearchOpen());
assert.equal(input().value,'> ');
assert.equal(document.querySelector('.spotlight-section-label')?.textContent,'Commands');
assert.ok(document.querySelectorAll('.spotlight-row').length>=30,'the full command list');
spotlight.closeSpotlightSearch();await delay(20);
root.unmount();
console.log('PASS: spotlight global search, empty state and command palette');
process.exit(0);
