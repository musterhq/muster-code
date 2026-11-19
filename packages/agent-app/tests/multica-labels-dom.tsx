// A Multica server is called Multica wherever Muster names the server (#890): the hub's top bar, an issue's source badge, a project's badge,
// the Projects list's org groups and the sidebar's org rows. A Paperclip or Muster Server connection keeps "Muster Server".
// linkedom DOM, the real components, a stubbed bridge; no network, no Electron.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
const storage=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,
  localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,String(v));},removeItem:(k:string)=>{storage.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return this._top??0;},set(v){this._top=v;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

const now=new Date().toISOString();
let kind:'multica'|'paperclip'='multica';
const task={id:'t1',key:'ACME-1',title:'Fix the login redirect',status:'in_review',priority:'critical',source:'paperclip',projectId:'p1',parentId:null,goalId:null,assigneeId:'a1',assigneeLabel:'Dev Agent',createdAt:now,updatedAt:now,startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:'You',labels:[{name:'bug',color:null}]};
const snapshot=()=>({paperclip:{origin:'projects.acme.example',kind,company:{id:'ws1',name:'Acme',prefix:'ACME'},companies:[{id:'ws1',name:'Acme',prefix:'ACME'}],live:'poll'},goals:[],approvals:[],labels:[],people:[],
  tasks:[task],agents:[{id:'a1',name:'Dev Agent',role:'agent',title:null,model:null,adapter:null,source:'paperclip',status:'idle',reportsTo:null,lastActiveAt:null,error:null,capabilities:null,pausable:false}],runs:[],inbox:[],
  projects:[{id:'p1',name:'Website',status:'in_progress',description:'',source:'paperclip',repo:null,cwd:null,taskCount:1,openCount:1,paused:false,memory:null,org:'Acme'}],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:1},fetchedAt:now});
const work=()=>({connected:true,me:{id:'me',name:'Dana'},orgs:[{org:{id:'ws1',name:'Acme',prefix:'ACME',server:'projects.acme.example',kind},sidebar:'mine',open:1,tasks:[],projects:[{id:'p1',name:'Website',open:1}],inbox:[]}]});
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='paperclip.snapshot')return snapshot();
  if(command==='paperclip.task')return {task,description:'After sign-in the app lands on /undefined.',comments:[],runs:[],addressee:null,composerNote:null,subtasks:[],blocking:[],receipts:[],cards:[],mentionable:[]};
  if(command==='paperclip.watch')return {live:'poll'};
  if(command==='paperclip.inbox.dismissed')return {items:[]};
  if(command==='paperclip.badge')return {connected:true,inbox:0,liveRuns:0,mail:0,chatIds:[],company:'Acme',orgs:{}};
  if(command==='orgs.work')return work();
  if(command==='checkout.leases')return {leases:[]};
  if(command==='checkout.countdowns')return {countdowns:[]};
  if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};
  if(command==='project.list')return [];
  if(command==='app.snapshot')return {folders:[],chats:[],projects:[],version:1};
  if(command==='memory.task')return {records:[],note:null};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {HubScreen}=await import('../src/renderer/components/HubScreen');
const {ProjectsScreen}=await import('../src/renderer/components/ProjectsScreen');
const {OrgSidebar}=await import('../src/renderer/components/OrgSidebar');
const {openHub,refreshWorkspace}=await import('../src/renderer/hubStore');
await (await import('../src/renderer/store')).boot();
await refreshWorkspace(true);
const text=(sel:string,scope:ParentNode=document)=>[...scope.querySelectorAll(sel)].map(e=>(e.textContent??'').replace(/\s+/g,' ').trim());
const mount=async(el:React.ReactElement,wait=300)=>{const root=createRoot(document.getElementById('root')!);root.render(el);await delay(wait);return root;};

// Spec: MUS-SPEC-12-890D (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-890d)
await check('a Multica server is called Multica in the top bar, on an issue, on a project, in the Projects list and on the sidebar org', async()=>{
  openHub('task','t1');
  let root=await mount(<HubScreen/>,500);
  assert.match(text('.ws-topbar-origin')[0]??'',/^Multica · Acme/,'the top bar names Multica');
  assert.ok(text('.ws-source').includes('Multica'),'the issue’s source badge says Multica');
  assert.equal(document.body.textContent!.includes('Muster Server'),false,'nothing on the issue page says Muster Server');
  root.unmount();
  openHub('project','p1');
  root=await mount(<HubScreen/>,500);
  assert.ok(text('.ws-source').includes('Multica'),'the project’s badge says Multica');
  assert.equal(document.body.textContent!.includes('Muster Server'),false);
  root.unmount();
  root=await mount(<ProjectsScreen onBack={()=>{}} onStartChat={()=>{}}/>);
  assert.ok(text('.ws-group-title').some(t=>t.startsWith('Acme · Multica')),'the org group in Projects says Multica');
  root.unmount();
  root=await mount(<OrgSidebar/>);
  assert.match(document.querySelector('.org-name')?.getAttribute('title')??'',/^Acme · Multica · projects\.acme\.example$/,'the sidebar org row names Multica');
  root.unmount();
});

// Spec: MUS-SPEC-12-890E (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-890e)
await check('a Paperclip-backed connection keeps the Muster Server name', async()=>{
  kind='paperclip';await refreshWorkspace(true);
  openHub('task','t1');
  const root=await mount(<HubScreen/>,500);
  assert.match(text('.ws-topbar-origin')[0]??'',/^Muster Server · Acme/);
  assert.ok(text('.ws-source').includes('Muster Server'));
  assert.equal(text('.ws-source').includes('Multica'),false);
  root.unmount();
});
console.log('multica-labels-dom: ok');
process.exit(0);
