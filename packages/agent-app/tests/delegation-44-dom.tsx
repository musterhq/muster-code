/** #44: chats one chat started for another, as the user sees them: compact rows in both transcripts, the children in the
 *  sub-agents pane, the parent's copy of a child's approval, and Stop asking whether to stop the children too. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.innerWidth=1000;window.innerHeight=800;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:()=>null,setItem(){}}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;(window as any).getSelection=()=>({anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});
class Highlight extends Set<any>{constructor(...ranges:any[]){super(ranges);}}
Object.assign(globalThis,{Highlight,CSS:{highlights:new Map<string,Highlight>()}});
Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{get(){return 600;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get(){return Number.parseFloat(this.querySelector?.('.timeline-inner')?.style.height||'600');}});
Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get(){return this.classList.contains('timeline-row')?40:600;}});
Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get(){return 800;}});
window.HTMLElement.prototype.getBoundingClientRect=function(){return{x:0,y:0,height:this.classList.contains('timeline-row')?40:600,width:800,top:0,left:0,bottom:600,right:800};};
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLElement.prototype.scrollTo=function({top}:any){this.scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));};
(globalThis as any).CustomEvent=window.CustomEvent;

const at=new Date(Date.now()-60_000).toISOString();
const mk=(id:string,title:string,status:string)=>({id,title,folderId:'folder',status,updatedAt:at,pinned:false,archived:false,draft:'',model:'alpha-1',mode:'agent',providerId:'alpha'});
const chats=[mk('lead','Lead','running'),mk('api','Audit API','running'),mk('ui','Audit UI','completed')];
const started=(id:string,child:string,title:string,state:string,text:string)=>({id,chatId:'lead',kind:'notice',text,status:'completed',createdAt:at,data:{kind:'delegated-task',childChatId:child,title,model:'Beta One',providerId:'beta',state}});
const leadItems=[
  {id:'u1',chatId:'lead',kind:'user',text:'Audit the app',createdAt:at},
  started('n1','api','Audit API','started','Started Audit API on Beta One'),
  started('n2','ui','Audit UI','started','Started Audit UI on Beta One'),
  started('n3','ui','Audit UI','finished','Audit UI finished'),
  {id:'copy',chatId:'lead',kind:'approval',text:'rm -rf build',status:'pending',createdAt:at,data:{method:'item/commandExecution/requestApproval',kind:'command',command:'rm -rf build',delegated:{chatId:'api',itemId:'own',title:'Audit API'}}},
];
const childItems=[{id:'f1',chatId:'api',kind:'notice',text:'Started by Lead',status:'completed',createdAt:at,data:{kind:'delegated-from',parentChatId:'lead',parentTitle:'Lead'}},{id:'cu',chatId:'api',kind:'user',text:'Audit API for bugs.',createdAt:at}];
const calls:{command:string;input:any}[]=[];
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'lead'};
  if(command==='chat.timeline'||command==='chat.select')return {items:input.id==='api'?childItems:input.id==='lead'?leadItems:[],revision:1};
  if(command==='delegation.children')return [{id:'api',parentChatId:'lead',rootChatId:'lead',depth:1,title:'Audit API',model:'beta-1',status:'running',createdAt:at},{id:'ui',parentChatId:'lead',rootChatId:'lead',depth:1,title:'Audit UI',model:'beta-1',status:'completed',createdAt:at}];
  if(command==='delegation.stopChildren')return {stopped:1};
  if(command==='subagents.capabilities')return {stop:true,steer:true};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {Timeline}=await import('../src/renderer/components/ChatView');
const {SubagentsTab}=await import('../src/renderer/components/SubagentsTab');
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();await delay(60);
const click=(element:any)=>{const event=new window.Event('click',{bubbles:true,cancelable:true});Object.assign(event,{button:0});element.dispatchEvent(event);};
const since=()=>{const from=calls.length;return ()=>calls.slice(from);};

// Spec: MUS-SPEC-14-44K (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44k)
await check('#44 started chats show as compact linked rows in both transcripts, in the sub-agents pane, on the parent\'s approval copy, and Stop asks about them',async()=>{
  root.render(<Timeline chatId="lead" items={leadItems as any} running/>);await delay(120);
  const rows=[...document.querySelectorAll('[data-testid="delegated-task"]')];
  assert.deepEqual(rows.map(row=>row.textContent),['Started Audit API on Beta One','Started Audit UI on Beta One','Audit UI finished']);
  assert.equal(rows[2]!.getAttribute('data-state'),'finished');
  let seen=since();click(rows[0]!.querySelector('button'));await delay(40);
  assert.ok(seen().some(call=>call.command==='chat.select'&&call.input.id==='api'),'the row opens the child chat');
  // The parent's copy of the child's approval names the child and answers through the copy.
  const card=document.querySelector('.approval-card')!;
  assert.equal(card.querySelector('[data-testid="delegated-ask"]')!.textContent,'From Audit API, a chat this one started');
  seen=since();click([...card.querySelectorAll('button')].find(button=>/Approve$/.test(button.textContent!.trim()))!);await delay(30);
  assert.deepEqual(seen().filter(call=>call.command==='approval.respond').map(call=>call.input),[{id:'copy',approved:true,decision:'accept'}]);

  root.render(<Timeline chatId="api" items={childItems as any} running/>);await delay(80);
  const origin=document.querySelector('[data-testid="delegated-from"]')!;
  assert.equal(origin.textContent,'Started by Lead');
  seen=since();click(origin.querySelector('button'));await delay(40);
  assert.ok(seen().some(call=>call.command==='chat.select'&&call.input.id==='lead'),'"Started by" opens the parent');

  await store.selectChat('lead');await delay(40);
  root.render(<SubagentsTab tab={{id:'subagents:lead',kind:'subagents',chatId:'lead',title:'Lead'} as any}/>);await delay(80);
  const cards=[...document.querySelectorAll('[data-testid="delegated-child"]')];
  assert.deepEqual(cards.map(card=>card.getAttribute('aria-label')),['Audit API, Working','Audit UI, Done']);
  assert.equal(document.querySelector('.subagents-count')!.textContent,'2');
  assert.match(document.querySelector('.subagent-counts')!.textContent!,/1 running.*1 completed/);
  assert.equal(document.querySelector('.subagents-empty'),null);
  seen=since();click(cards[1]!.querySelector('button'));await delay(40);
  assert.ok(seen().some(call=>call.command==='chat.select'&&call.input.id==='ui'),'a card opens that chat');

  // Stop: OK stops the working children too; Cancel stops only this chat.
  const asked:string[]=[];
  (window as any).confirm=(text:string)=>{asked.push(text);return true;};
  seen=since();await store.stopChat('lead');
  assert.deepEqual(seen().filter(call=>call.command!=='delegation.children').map(call=>call.command),['chat.stop','delegation.stopChildren']);
  assert.match(asked[0]!,/This chat started a chat that is still working: “Audit API”\.\n\nStop it too\? Cancel stops only this chat\./);
  (window as any).confirm=()=>false;
  seen=since();await store.stopChat('lead');
  assert.deepEqual(seen().filter(call=>call.command!=='delegation.children').map(call=>call.command),['chat.stop']);
  assert.deepEqual(errors,[]);
});
root.unmount();
process.exit(0);
