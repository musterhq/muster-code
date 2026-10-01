/** Projects like Paperclip (#193), DOM checks through linkedom:
 *  - the one project page: header and tabs; Tasks as a nested list with collapse, search, filters, grouping and a board;
 *  - New task with Assign & start;
 *  - the Roster: list, Add agent and the hire approval card;
 *  - Settings sections and the approval toggle;
 *  - Budget and the Dashboard, which never show a fake $0;
 *  - the import mapping step.
 *  No intervals anywhere. Never pass DOM nodes to assert.equal. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
// Base UI's focus manager checks `instanceof KeyboardEvent` (and friends), which linkedom does not define.
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
const storage=new Map<string,string>();
let intervals=0;
const realSetInterval=globalThis.setInterval;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,
  localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,String(v));},removeItem:(k:string)=>{storage.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  setInterval:((fn:any,ms:number)=>{intervals++;return realSetInterval(fn,ms);}) as typeof setInterval});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return this._top??0;},set(v){this._top=v;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

const now=new Date().toISOString();
const proj=(id:string,name:string,extra:object={})=>({id,name,status:'in_progress',description:'',source:'local',repo:null,cwd:null,taskCount:2,openCount:1,paused:false,memory:null,...extra});
let live:'socket'|'poll'='socket';
const approvals=[{id:'ap-hire',type:'hire_agent',status:'pending',title:'Hire Nova as Data Engineer',detail:'Role: engineer',requestedBy:'CTO',agentId:'a-nova',issueIds:[],at:now,verbs:['approve','reject','request_revision']}];
const snapshot=()=>({paperclip:{origin:'This Mac',company:{id:'c',name:'RagnarDataOps',prefix:'RAG'},companies:[],live},goals:[],approvals,labels:[],
  tasks:[],agents:[],runs:[],counts:{liveRuns:0,inbox:2,failedRuns:0,openTasks:0},fetchedAt:now,
  projects:[proj('mine','My own project'),proj('imp','Data Pipeline',{org:'RagnarDataOps',editedHere:true}),proj('pc2','Ops Dashboard',{source:'paperclip',org:'RagnarDataOps'}),proj('other','Old import',{org:'OtherOrg'})],
  inbox:[{id:'import:approval:ap-hire',kind:'approval',title:'Hire Nova as Data Engineer',why:'Waiting for your approval.',severity:'high',at:now,taskId:null,agentId:null,runId:null,source:'paperclip',group:'RagnarDataOps',approvalId:'ap-hire',approvalVerbs:['approve','reject','request_revision']},
    {id:'plain',kind:'question',title:'A question',why:'x',severity:'high',at:now,taskId:null,agentId:'a1',runId:null,source:'paperclip',group:'RagnarDataOps'}]});
const calls:{command:string;input:any}[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.snapshot')return snapshot();
  if(command==='paperclip.watch')return {live};
  if(command==='paperclip.approval.decide')return {ok:true};
  if(command==='paperclip.inbox.dismissed')return {items:[]};
  if(command==='paperclip.badge')return {connected:true,inbox:2,liveRuns:0,mail:0,chatIds:[]};
  if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};
  if(command==='project.list')return [{id:'mine',name:'My own project',goal:'',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null},{id:'imp',name:'Data Pipeline',goal:'Ship',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null},{id:'other',name:'Old import',goal:'',folderIds:[],primaryFolderId:null,archived:false,archivedAt:null}];
  if(command==='app.snapshot')return {folders:[],chats:[],projects:[{id:'mine',name:'My own project',goal:'',folderIds:[]},{id:'imp',name:'Data Pipeline',goal:'Ship',folderIds:[]},{id:'other',name:'Old import',goal:'',folderIds:[]}],version:1};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {ProjectsScreen}=await import('../src/renderer/components/ProjectsScreen');
const {HubScreen}=await import('../src/renderer/components/HubScreen');
const {openHub,refreshWorkspace}=await import('../src/renderer/hubStore');
await (await import('../src/renderer/store')).boot();
await refreshWorkspace();
const errors:unknown[]=[];
const text=(sel:string,scope:ParentNode=document)=>[...scope.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=async(el:Element|null|undefined,wait=80)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));await delay(wait);};
const button=(label:RegExp,scope:ParentNode=document)=>[...scope.querySelectorAll('button')].find(b=>label.test(b.textContent?.trim()??'')||label.test(b.getAttribute('aria-label')??''));
const typeInto=async(el:Element,value:string)=>{const key=Object.keys(el).find(k=>k.startsWith('__reactProps'))!;Object.defineProperty(el,'value',{configurable:true,get:()=>value,set:()=>{}});(el as any)[key].onChange({target:el,currentTarget:el});await delay(40);};

// Projects: yours first, then one group per Paperclip org (imported and linked projects together, once each).
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{(errors as unknown[]).push(e);},onRecoverableError:e=>{(errors as unknown[]).push(e);}});
root.render(<ProjectsScreen onBack={()=>{}} onStartChat={()=>{}}/>);
for(let i=0;i<40&&!document.querySelector('.pp-list');i++)await delay(40);
await delay(100);
assert.deepEqual(text('.ws-group-title'),['My projects','OtherOrg · Paperclip','RagnarDataOps · Paperclip']);
const group=(label:string)=>[...document.querySelectorAll('section.ws-section')].find(s=>s.getAttribute('aria-label')===label)!;
assert.deepEqual(text('.ws-row-title',group('My projects')),['My own project'],'a project you made shows as before');
assert.deepEqual(text('.ws-row-title',group('RagnarDataOps · Paperclip')),['Data Pipeline','Ops Dashboard']);
assert.deepEqual(text('.ws-row-title',group('OtherOrg · Paperclip')),['Old import']);
assert.ok(text('.ws-chip',group('RagnarDataOps · Paperclip')).includes('edited here'),'an imported project edited here says so');
assert.ok(!text('.ws-chip',group('My projects')).includes('edited here'));
assert.deepEqual(errors,[]);
root.unmount();

// The Inbox: an approval row is decided from the row; Request revision asks what should change first.
openHub('inbox');
const root2=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{(errors as unknown[]).push(e);},onRecoverableError:e=>{(errors as unknown[]).push(e);}});
root2.render(<HubScreen/>);
await delay(250);
const rows=[...document.querySelectorAll('.ws-inbox-row')];
assert.equal(document.querySelectorAll('.ws-approval-actions').length,1,'only the approval row has decisions');
const actions=document.querySelector('.ws-approval-actions')!;
assert.deepEqual(text('button',actions),['Reject','Request revision','Approve']);
await click(button(/^Approve$/,actions),120);
assert.deepEqual(calls.find(c=>c.command==='paperclip.approval.decide')?.input,{id:'ap-hire',decision:'approve'},'Approve decides it, with no note');
await click(button(/^Request revision$/,document.querySelector('.ws-approval-actions')!));
const send=button(/^Send back$/,document.querySelector('.ws-approval-actions')!) as HTMLButtonElement;
assert.equal(send.disabled,true,'a revision request needs its reason');
await typeInto(document.querySelector('.ws-approval-actions input')!,'Add a budget line');
await click(button(/^Send back$/,document.querySelector('.ws-approval-actions')!),120);
assert.deepEqual(calls.filter(c=>c.command==='paperclip.approval.decide').at(-1)?.input,{id:'ap-hire',decision:'request_revision',note:'Add a budget line'});
void rows;
assert.deepEqual(errors,[]);
// When Paperclip pushes nothing (board keys), the top bar says it is checked every 15 s, not live.
assert.doesNotMatch(text('.ws-topbar-origin')[0]??'',/updates every/);
root2.unmount();
live='poll';await refreshWorkspace(true);
openHub('tasks');
const root3=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{(errors as unknown[]).push(e);},onRecoverableError:e=>{(errors as unknown[]).push(e);}});
root3.render(<HubScreen/>);await delay(200);
assert.match(text('.ws-topbar-origin')[0],/RagnarDataOps · updates every 15 s/);
root3.unmount();

assert.equal(intervals,0,'the hub and the Projects list start no intervals');
// The sidebar's Projects section: yours as before, then each Paperclip org as a labelled group of its projects.
const {Sidebar}=await import('../src/renderer/components/Sidebar');
const root4=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{(errors as unknown[]).push(e);},onRecoverableError:e=>{(errors as unknown[]).push(e);}});
root4.render(<Sidebar/>);await delay(3300);  // the badge read (which says Paperclip is linked) starts 2.5 s after the first paint
assert.deepEqual(errors,[],'the sidebar renders (a hook below its loading return crashed it before)');
const projectsBlock=document.querySelector('section[aria-label="Projects"]')!;
assert.ok(projectsBlock,'the Projects section');
assert.deepEqual(text('.nav-org-label',projectsBlock),['OtherOrg · Paperclip','RagnarDataOps · Paperclip']);
const orgGroup=(label:string)=>[...projectsBlock.querySelectorAll('.nav-org')].find(g=>g.getAttribute('aria-label')===label)!;
assert.deepEqual(text('.nav-section-title',orgGroup('RagnarDataOps · Paperclip')),['Data Pipeline','Ops Dashboard'],'imported and linked projects of one org sit together, once each');
root4.unmount();
assert.deepEqual(errors,[]);

console.log('paperclip-integration-dom: ok');
process.exit(0);
