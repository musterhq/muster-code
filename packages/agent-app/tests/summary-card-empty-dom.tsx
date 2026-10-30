/** #792: a chat with nothing to summarise renders no summary card and reserves no room; the card appears once a section exists. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',display:'block',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:1200,height:800,left:0,top:0,right:1200,bottom:800});
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{configurable:true,get(){return 1000;}});
const chat={id:'one',title:'one',status:'completed',updatedAt:new Date().toISOString(),pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow'};
const listeners=new Set<(event:any)=>void>(),emit=(event:any)=>{for(const fn of listeners)fn(event);};
const reply=[{id:'u1',chatId:'one',kind:'user',text:'hello',createdAt:''},{id:'a1',chatId:'one',kind:'assistant',text:'Hi there.',createdAt:''}];
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string){
  if(command==='app.snapshot')return {version:1,chats:[chat],folders:[],projects:[],activeChatId:'one'};
  if(command==='chat.timeline')return {items:reply,revision:1};
  if(command==='processes.summary')return {sessions:[]};
  if(command==='automations.list')return [];
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store'),{SummaryCard}=await import('../src/renderer/components/SummaryCard');
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();
root.render(<main className="center"><div className="chat"><header className="chat-head"/></div><SummaryCard/></main>);
await delay(300);
assert.deepEqual(errors,[]);
assert.equal(store.getState().timelines.one?.value?.length,2,'the chat has its one plain reply loaded');
const center=()=>document.querySelector<HTMLElement>('.center')!;

// Spec: MUS-SPEC-01-792A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-792a)
await check('a chat with nothing to summarise shows no summary card and reserves no room',async()=>{
  // Compare strings, never linkedom nodes: a failing assert on a node makes util.inspect walk the whole DOM.
  assert.equal(document.querySelector('.summary-card')?.outerHTML??'none','none','no summary card renders when there is nothing to show');
  assert.equal(center().getAttribute('data-summary'),null,'.center reserves no summary room');
});

// Spec: MUS-SPEC-01-792B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-792b)
await check('the summary card appears once the chat changes a file',async()=>{
  emit({type:'timelinePatch',chatId:'one',patch:{after:1,revision:2,items:[{id:'t1',chatId:'one',kind:'tool',status:'completed',text:'Edited src/app.ts',createdAt:'',data:{type:'fileChange',changes:[{path:'src/app.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]}}]}});
  await delay(100);
  const card=document.querySelector('.summary-card');
  assert.equal(!!card,true,'the summary card renders once a file changes');
  assert.equal(!!card!.querySelector('[aria-label="Sources"]'),true,'it shows the Sources section');
  assert.match(card!.textContent??'',/app\.ts/);
  assert.notEqual(center().getAttribute('data-summary'),null,'.center gets its summary layout');
});
root.unmount();
process.exit(0);
