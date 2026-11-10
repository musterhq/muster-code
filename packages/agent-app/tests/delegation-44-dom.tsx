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
leadItems.push({id:'rep',chatId:'lead',kind:'user',text:'Muster: a chat you delegated finished. This is its report, not a message from the user.\nui "Audit UI" on Beta One: finished\nFinal reply:\nThe UI is clean.',createdAt:at,data:{kind:'delegation-report',childChatId:'ui',title:'Audit UI',state:'finished',summary:'The UI is clean.'}} as any,{id:'a9',chatId:'lead',kind:'assistant',text:'Good, the UI is done.',createdAt:at} as any);
const childItems=[{id:'f1',chatId:'api',kind:'notice',text:'Started by Lead',status:'completed',createdAt:at,data:{kind:'delegated-from',parentChatId:'lead',parentTitle:'Lead'}},{id:'cu',chatId:'api',kind:'user',text:'Audit API for bugs.',createdAt:at}];
const calls:{command:string;input:any}[]=[];
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'lead'};
  if(command==='chat.timeline')return {items:input.id==='api'?childItems:input.id==='lead'?leadItems:[],revision:1};
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
await check('#44 started chats show as compact linked rows in both transcripts, in the sub-agents pane and on the parent\'s approval copy',async()=>{
  root.render(<Timeline chatId="lead" items={leadItems as any} running/>);await delay(120);
  const rows=[...document.querySelectorAll('[data-testid="delegated-task"]')];
  assert.deepEqual(rows.map(row=>row.textContent),['Started Audit API on Beta One','Started Audit UI on Beta One','Audit UI finished']);
  assert.equal(rows[2]!.getAttribute('data-state'),'finished');
  click(rows[0]!.querySelector('button'));await delay(40);
  assert.equal(store.getState().activeChatId,'api','the row opens the child chat');
  // The parent's copy of the child's approval names the child and answers through the copy.
  const card=document.querySelector('.approval-card')!;
  assert.equal(card.querySelector('[data-testid="delegated-ask"]')!.textContent,'From Audit API, a chat this one started');
  let seen=since();click([...card.querySelectorAll('button')].find(button=>/Approve$/.test(button.textContent!.trim()))!);await delay(30);
  assert.deepEqual(seen().filter(call=>call.command==='approval.respond').map(call=>call.input),[{id:'copy',approved:true,decision:'accept'}]);

  root.render(<Timeline chatId="api" items={childItems as any} running/>);await delay(80);
  const origin=document.querySelector('[data-testid="delegated-from"]')!;
  assert.equal(origin.textContent,'Started by Lead');
  click(origin.querySelector('button'));await delay(40);
  assert.equal(store.getState().activeChatId,'lead','"Started by" opens the parent');

  await store.selectChat('lead');await delay(40);
  root.render(<SubagentsTab tab={{id:'subagents:lead',kind:'subagents',chatId:'lead',title:'Lead'} as any}/>);await delay(80);
  const cards=[...document.querySelectorAll('[data-testid="delegated-child"]')];
  assert.deepEqual(cards.map(card=>card.getAttribute('aria-label')),['Audit API, Working','Audit UI, Done']);
  assert.equal(document.querySelector('.subagents-count')!.textContent,'2');
  assert.match(document.querySelector('.subagent-counts')!.textContent!,/1 running.*1 completed/);
  assert.equal(document.querySelector('.subagents-empty'),null);
  click(cards[1]!.querySelector('button'));await delay(40);
  assert.equal(store.getState().activeChatId,'ui','a card opens that chat');

  assert.deepEqual(errors,[]);
});

// Spec: MUS-SPEC-14-44L (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44l)
await check('#44 Stop on a chat with working children offers Stop all, Stop this chat only and Cancel; Cancel and Esc stop nothing',async()=>{
  const {StopChildrenHost}=await import('../src/renderer/components/StopChildrenSheet');
  root.render(<StopChildrenHost/>);await delay(40);
  (window as any).confirm=()=>{throw new Error('window.confirm must not be used');};
  const sheet=()=>document.querySelector('[data-testid="stop-children-confirm"]');
  const press=async(label:string)=>{const button=[...sheet()!.querySelectorAll('button')].find(b=>b.textContent===label)!;click(button);await delay(30);};
  const stopping=async(action:()=>Promise<void>)=>{const seen=since();const done=store.stopChat('lead');await delay(60);await action();await done;return seen().filter(call=>call.command!=='delegation.children').map(call=>call.command);};
  assert.deepEqual(await stopping(async()=>{
    assert.ok(sheet(),'the dialog opens');
    assert.match(sheet()!.textContent!,/“Lead” started a chat that is still working: “Audit API”\./);
    assert.deepEqual([...sheet()!.querySelectorAll('button')].map(b=>b.textContent),['Cancel','Stop this chat only','Stop all']);
    await press('Stop all');
  }),['chat.stop','delegation.stopChildren'],'Stop all stops the chat and the chats it started');
  assert.equal(sheet(),null);
  assert.deepEqual(await stopping(()=>press('Stop this chat only')),['chat.stop']);
  assert.deepEqual(await stopping(()=>press('Cancel')),[],'Cancel stops nothing');
  assert.deepEqual(await stopping(async()=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:'Escape'});document.dispatchEvent(event);await delay(30);}),[],'Esc stops nothing');
  assert.equal(sheet(),null);
  assert.deepEqual(errors,[]);
});

// Spec: MUS-SPEC-14-44M (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-44m)
await check('#44 a wake-up report shows as a compact notice row with the child\'s first line and Open, never as a user bubble',async()=>{
  root.render(<Timeline chatId="lead" items={leadItems as any} running={false}/>);await delay(120);
  const row=document.querySelector('[data-testid="delegation-report"]')!;
  assert.ok(row,'the report is a notice row');
  assert.equal(row.textContent,'Audit UI finished · The UI is clean. · Open');
  assert.ok(row.classList.contains('delegation-row'));
  const bubbles=[...document.querySelectorAll('.msg-user, .user-message-row')].map(node=>node.textContent??'');
  assert.ok(bubbles.length>=1,'the user\'s own message is still a bubble');
  assert.ok(!bubbles.some(text=>text.trim().startsWith('Muster: a chat you delegated')),'no user bubble starts with the report');
  click([...row.querySelectorAll('button')].find(button=>button.textContent==='Open'));await delay(40);
  assert.equal(store.getState().activeChatId,'ui','Open opens the child chat');
  assert.deepEqual(errors,[]);
});
root.unmount();
process.exit(0);
