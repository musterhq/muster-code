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

const now=new Date().toISOString(), ago=(m:number)=>new Date(Date.now()-m*60_000).toISOString();
const task=(id:string,key:string,title:string,status:string,extra:object={})=>({id,key,title,status,priority:'medium',source:'local',projectId:'p1',parentId:null,goalId:null,assigneeId:'member:cto',assigneeLabel:'CTO',createdAt:ago(60),updatedAt:ago(5),startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:'You',...extra});
const agent=(id:string,name:string,extra:object={})=>({id:`member:${id}`,name,role:'agent',title:`${name} title`,model:'planner',adapter:'hybrow',source:'local',status:'idle',reportsTo:'user:local',lastActiveAt:null,error:null,pausable:true,capabilities:null,projectId:'p1',memberId:id,runner:{providerId:'hybrow',model:'planner'},instructions:'',...extra});
const snapshot={paperclip:null,goals:[],
  tasks:[task('t1','OSS-1','Migration wizard','in_review'),task('t2','OSS-2','Design the wizard','done',{parentId:'t1',assigneeId:'user:local',assigneeLabel:'You'}),task('t3','OSS-3','Docs','blocked',{priority:'high',live:true})],
  agents:[{id:'user:local',name:'You',role:'board',title:'Owner',model:null,adapter:null,source:'local',status:'active',reportsTo:null,lastActiveAt:null,error:null,pausable:false,capabilities:null},
    agent('cto','CTO',{status:'running'}),agent('qa','QA',{reportsTo:'member:cto'}),agent('des','Designer',{status:'pending',pausable:false,title:'Product designer',instructions:'Own the mockups.'})],
  projects:[{id:'p1',name:'OSSMANAGER',status:'in_progress',description:'',source:'local',repo:'github.com/hybrowlabs/oss-manager',cwd:'/work/oss',taskCount:3,openCount:2,paused:false,memory:null}],
  runs:[{id:'r1',agentId:'member:cto',taskId:'t3',status:'running',trigger:'user',source:'local',createdAt:ago(3),startedAt:ago(3),finishedAt:null,error:null,cancellable:true,chatId:'c1'},
    {id:'r2',agentId:'member:qa',taskId:'t1',status:'succeeded',trigger:'user',source:'local',createdAt:ago(40),startedAt:ago(40),finishedAt:ago(30),error:null,cancellable:false,chatId:'c2'}],
  inbox:[{id:'hire:p1:des',kind:'approval',title:'Add Designer as Product designer to OSSMANAGER?',why:'',severity:'high',at:now,taskId:null,agentId:'member:des',runId:null,projectId:'p1',group:'OSSMANAGER',source:'local'}],
  counts:{liveRuns:1,inbox:1,failedRuns:0,openTasks:2},fetchedAt:now};
const days=Array.from({length:14},(_,i)=>new Date(Date.now()-(13-i)*86_400_000).toISOString().slice(0,10));
const dashboard={days,runs:days.map((day,i)=>({day,succeeded:i===13?2:0,failed:i===13?1:0,other:0})),tasksByDay:days.map((day,i)=>({day,counts:i===13?{in_review:1,blocked:1,done:1}:{}})),
  spend:{usd:null,pricedTurns:0,unpricedTurns:3,since:now,source:'Muster',tokens:4000},activity:[{id:'a1',actor:'You',summary:'Added CTO as Chief Technology Officer',at:ago(2),projectId:'p1',projectName:'OSSMANAGER',source:'local',refId:null}],generatedAt:now};
const project={id:'p1',name:'OSSMANAGER',goal:'',folderIds:['f1'],primaryFolderId:'f1',archived:false,archivedAt:null};
const work={tasks:{items:[],truncated:false},decisions:{items:[],truncated:false},activity:{items:[],truncated:false},scheduler:{autoDispatch:false,paused:false,concurrency:2,budgetMinutes:30,permissionMode:'workspace',updatedAt:null},instructions:{version:0,text:'',updatedAt:null},context:{version:1,goalVersion:1,instructionsVersion:0,decisions:0,headSha:null,label:'goal v1'},coordinator:{chatId:null,proposals:[]},dispatching:[]};
let teamSettings={requireHireApproval:false,keyPrefix:null as string|null,monthlyBudgetUsd:null as number|null};
const calls:{command:string;input:any}[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.snapshot')return snapshot;
  if(command==='paperclip.watch')return {live:'events'};
  if(command==='paperclip.dashboard')return dashboard;
  if(command==='paperclip.task.create')return {...task('t9','OSS-4',input.title,'todo'),started:input.start?{chatId:'c9',runId:'r9',worktree:'/w',branch:'muster/oss-4'}:undefined};
  if(command==='paperclip.list')return {kind:input.kind,rows:[],note:''};
  if(command==='project.members.add')return {id:'m-new',projectId:'p1',name:input.name,kind:'agent',role:'agent',maxPermission:null,folderIds:null,secrets:[],revokedAt:null,local:false,createdAt:now,updatedAt:now,title:input.title,reportsTo:input.reportsTo,runner:input.runner,instructions:input.instructions,pendingAt:null};
  if(command==='project.members.decide')return {id:input.id,name:'Designer',pendingAt:null};
  if(command==='project.team.settings')return teamSettings;
  if(command==='project.team.settings.set'){teamSettings={...teamSettings,...input};delete (teamSettings as any).projectId;return teamSettings;}
  if(command==='project.work')return work;
  if(command==='project.members.list')return {members:[],access:{},policy:{permissionMode:'workspace',folderIds:['f1']},settings:teamSettings};
  if(command==='project.sources.list')return {sources:[]};
  if(command==='project.handoff.latest')return {packet:null};
  if(command==='settings.projectModel.get')return {value:null};
  if(command==='mailbox.list')return {messages:[],unacked:0,pending:0};
  if(command==='models.usage.project')return {scope:'project',id:'p1',rows:[],totals:{input:0,cached:0,output:0,reasoning:0},costUsd:null,unpricedTokens:0,incrementalInput:false,updatedAt:null};
  if(command==='app.snapshot')return {folders:[{id:'f1',name:'redis-automation',path:'/work/oss'}],chats:[],projects:[{id:'p1',name:'OSSMANAGER',goal:'',folderIds:['f1']}],version:1};
  if(command==='project.list')return [project];
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow Gateway',available:true,identityMasked:'',models:[{id:'planner',name:'Planner'}]}];
  return undefined;
}};

const {createRoot}=await import('react-dom/client');
const {ProjectPage}=await import('../src/renderer/components/ProjectPage');
const {DashboardPage}=await import('../src/renderer/components/DashboardPage');
const {ImportMapping}=await import('../src/renderer/components/HubSetup');
const {refreshWorkspace}=await import('../src/renderer/hubStore');
await refreshWorkspace();
const errors:unknown[]=[];
const text=(sel:string,scope:ParentNode=document)=>[...scope.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=async(el:Element|null|undefined,wait=60)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));await delay(wait);};
const button=(label:RegExp,scope:ParentNode=document)=>[...scope.querySelectorAll('button')].find(b=>label.test(b.textContent?.trim()??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:Element,value:string)=>{if(el.tagName==='SELECT'){for(const o of [...(el as HTMLSelectElement).options])o.selected=o.value===value;try{Object.defineProperty(el,'value',{configurable:true,get:()=>value});}catch{}el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);return;}let proto=Object.getPrototypeOf(el),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
/** Sheets render in a portal on <body>; linkedom events do not reach React's listener there, so call the field's own onChange. */
const change=async(el:Element,value:string)=>{Object.defineProperty(el,'value',{configurable:true,get:()=>value,set:()=>{}});const key=Object.keys(el).find(k=>k.startsWith('__reactProps'))!;(el as any)[key].onChange({target:el,currentTarget:el});await delay(30);};
const nav={onOpenTask(){},onOpenAgent(){},onOpenChat(){}};
const muster={project,allFolders:[{id:'f1',name:'redis-automation',path:'/work/oss'}],chats:[],onUpdated(){},onStartChat(){},onOpenChat(){},onLeave(){},onDeleted(){}};
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});

// --- The project page: header and Paperclip's tabs ---------------------------------------------------------------------------
root.render(<ProjectPage snapshot={snapshot as any} projectId="p1" nav={nav} muster={muster as any}/>);
await delay(150);
assert.deepEqual(errors,[]);
assert.deepEqual(text('[role="tab"]'),['Dashboard','Tasks','Roster','Outputs','Ledger','Budget','Settings']);
assert.match(text('.pp-sub')[0],/github\.com\/hybrowlabs\/oss-manager.*2 open of 3/);
// Tasks: a nested list, keys with the project prefix, owners and ages on the right.
const keys=()=>text('.task-row .ws-key');
assert.deepEqual(keys(),['OSS-3','OSS-1','OSS-2'],'workflow order, the subtask under its parent');
assert.deepEqual([...document.querySelectorAll('.task-row')].map(r=>r.getAttribute('aria-level')),['1','1','2']);
assert.ok(text('.task-row .task-row-owner').some(t=>/You$/.test(t)),'owners on the right');
await click(button(/Collapse OSS-1/));
assert.deepEqual(keys(),['OSS-3','OSS-1'],'collapsing a parent hides its subtasks');
assert.match(text('.task-sub-count')[0],/1 subtasks/);
await click(button(/Expand OSS-1/));
const search=document.querySelector('.task-search input')!;
await setValue(search,'docs');
assert.deepEqual(keys(),['OSS-3']);
await setValue(search,'');
// Filters: Status › Blocked.
await click(button(/^Filter$/));
assert.ok(document.querySelector('[role="menu"]'),'the filter menu opens');
await click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find(i=>/Blocked/.test(i.textContent!)));
assert.deepEqual(keys(),['OSS-3']);
assert.match(button(/^Filter/)!.getAttribute('aria-label')!,/1 active/);
await click([...document.querySelectorAll('[role="menuitemcheckbox"]')].find(i=>/Blocked/.test(i.textContent!)));
assert.deepEqual(keys(),['OSS-3','OSS-1','OSS-2']);
await click(button(/^Filter/),80);
assert.equal(document.querySelectorAll('[role="menu"]').length,0,'the filter menu closes');
// Group by owner, from a remembered view (the Group menu writes the same view).
{
  const {TaskList}=await import('../src/renderer/components/TaskList');
  storage.set('muster.tasks.view.grouped',JSON.stringify({layout:'list',group:'owner',sort:'key'}));
  const host=document.createElement('div');document.body.appendChild(host);
  const r=createRoot(host);r.render(<TaskList snapshot={snapshot as any} tasks={snapshot.tasks as any} scope="grouped" onOpenTask={()=>{}}/>);await delay(80);
  assert.deepEqual(text('.task-group-head',host).map(t=>t.replace(/\d+$/,'')),['CTO','You']);
  assert.match(host.querySelector('[aria-label^="Group:"]')!.getAttribute('aria-label')!,/Group: Owner/);
  await click(host.querySelector('.task-group-head'));
  assert.deepEqual(text('.task-row .ws-key',host),['OSS-2'],'a collapsed group hides its rows');
  r.unmount();host.remove();
}
// Board: a column per status.
await click(button(/^Board$/));
assert.deepEqual(text('.task-col-head span:not(.task-col-count)'),['Backlog','Todo','In Progress','In Review','Blocked','Done','Cancelled']);
assert.deepEqual(text('.task-col[data-status="in_review"] .task-card .ws-key'),['OSS-1']);
assert.ok(JSON.parse(storage.get('muster.tasks.view.p1')!).layout==='board','the view is remembered per project');
await click(button(/^List$/));
// Every Tasks menu opens without taking the page down (Sort and Group crashed with Base UI error #31: a group label
// outside its group). Each pick is applied, and the view toggles both ways.
{
  const menuItems=(role:string)=>[...document.querySelectorAll(`[role="${role}"]`)];
  await click(button(/^Sort:/));
  assert.equal(document.querySelectorAll('[role="menu"]').length,1,'the Sort menu opens');
  assert.deepEqual(text('[role="menu"] .ui-menu-label'),['Sort by']);
  assert.equal(menuItems('menuitemradio').length,7);
  await click(menuItems('menuitemradio').find(i=>/Title/.test(i.textContent!)),80);
  assert.match(button(/^Sort:/)!.getAttribute('aria-label')!,/Sort: Title/);
  if(document.querySelector('[role="menu"]'))await click(button(/^Sort:/),80);
  await click(button(/^Group:/));
  assert.equal(document.querySelectorAll('[role="menu"]').length,1,'the Group menu opens');
  assert.deepEqual(text('[role="menu"] .ui-menu-label'),['Group by']);
  await click(menuItems('menuitemradio').find(i=>/Status/.test(i.textContent!)),80);
  assert.match(button(/^Group:/)!.getAttribute('aria-label')!,/Group: Status/);
  assert.ok(document.querySelectorAll('.task-group-head').length>=2,'grouped by status');
  if(document.querySelector('[role="menu"]'))await click(button(/^Group:/),80);
  await click(button(/^Group:/));
  await click(menuItems('menuitemradio').find(i=>/None/.test(i.textContent!)),80);
  if(document.querySelector('[role="menu"]'))await click(button(/^Group:/),80);
  await click(button(/^Filter$/));
  assert.equal(document.querySelectorAll('[role="menu"]').length,1,'the Filter menu opens');
  await click(button(/^Filter/),80);
  await click(button(/^Board$/));
  assert.ok(document.querySelector('.task-col'),'the board view');
  await click(button(/^Sort:/));
  assert.equal(document.querySelectorAll('[role="menu"]').length,1,'Sort opens on the board too');
  await click(button(/^Sort:/),80);
  await click(button(/^List$/));
  assert.ok(document.querySelector('.task-row'),'back to the list view');
  assert.ok(document.querySelector('[role="tab"]'),'the project page is still up');
  assert.deepEqual(errors,[]);
}

// --- New task with Assign & start --------------------------------------------------------------------------------------------
await click(button(/^New task$/));
const dialog=document.querySelector('[role="dialog"]')!;
assert.ok(dialog,'the New task sheet opens');
const selects=[...dialog.querySelectorAll('select')] as HTMLSelectElement[];
assert.deepEqual([...selects[1].options].map(o=>o.textContent),['You','CTO · CTO title','QA · QA title'],'owners: You and the approved Roster (a pending hire is not offered)');
assert.equal(button(/Assign & start/,dialog),undefined,'nothing to start while You own it');
await change(dialog.querySelector('input')!,'Fix the failing tests');
await change(selects[1],'member:cto');
await change(selects[2],'high');
await change(selects[3],'t1');
await click(button(/Assign & start/,dialog),120);
assert.deepEqual(calls.filter(c=>c.command==='paperclip.task.create').at(-1)!.input,{title:'Fix the failing tests',description:'',projectId:'p1',assigneeId:'member:cto',priority:'high',parentId:'t1',start:true});

// --- Roster: list, the hire approval card, Add agent ---------------------------------------------------------------------------
await click([...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Roster'));
assert.deepEqual(text('.roster-row .ws-row-title'),['CTO','Designer','QA'],'real members, working first; no generic "Agents" row');
assert.ok(text('.roster-row').some(t=>/reports to.*CTO/.test(t)),'QA reports to CTO');
assert.ok(text('.roster-row .ws-row-meta').some(t=>/Hybrow Gateway · planner/.test(t)),'the runner shows its provider’s name, not its raw id');
assert.ok(!text('.roster-row .ws-row-meta').some(t=>/\bhybrow\b/.test(t)));
assert.match(text('.hire-card-head')[0],/Add Designer as Product designer\?/);
await click(button(/^Approve$/,document.querySelector('.hire-card')!),100);
assert.deepEqual(calls.find(c=>c.command==='project.members.decide')!.input,{projectId:'p1',id:'des',approve:true});
await click(button(/^Add agent$/));
const sheet=document.querySelector('.ws-agent-sheet')!;
const inputs=[...sheet.querySelectorAll('input')];
await change(inputs[0],'Reviewer');
await change(inputs[1],'Code reviewer');
await change(sheet.querySelector('select')!,'cto');
await change(sheet.querySelector('textarea')!,'Read-only reviews.');
sheet.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(100);
assert.deepEqual(calls.find(c=>c.command==='project.members.add')!.input,{projectId:'p1',name:'Reviewer',kind:'agent',role:'agent',title:'Code reviewer',reportsTo:'cto',runner:null,instructions:'Read-only reviews.'});
await click(button(/^Org chart$/));
assert.equal(document.querySelectorAll('.ws-roster-card').length,4,'the org chart shows the Roster');
assert.ok(document.querySelectorAll('.ws-roster-line').length>=1,'with reporting lines');

// --- Settings: every old section is reachable; approvals toggle ------------------------------------------------------------------
await click([...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Settings'),150);
assert.deepEqual(text('.pp-settings-nav button'),['General','Folders','Members','Mail','Chats','Knowledge','Runs & verification','Run policy','Secrets','Goals','Labels','Feedback','Activity']);
assert.ok(text('.pp-fields dt').includes('Task keys'));
assert.equal((document.querySelector('.pp-prefix') as HTMLInputElement).getAttribute('placeholder'),'OSS');
const approval=document.querySelector('.pp-check input') as HTMLInputElement;
approval.checked=true;approval.dispatchEvent(new window.Event('click',{bubbles:true}));await delay(80);
assert.ok(calls.some(c=>c.command==='project.team.settings.set'&&c.input.requireHireApproval===true),'Require approval to add an agent saves');
assert.ok(text('.pp-danger h3').includes('Danger zone'));
await click(button(/^Mail$/),100);
assert.ok(calls.some(c=>c.command==='mailbox.list'&&c.input.projectId==='p1'),'Mail is the project mailbox (renamed from Inbox)');
assert.equal(text('.mailbox-header h2')[0],'Mail','its heading says Mail too (S68)');

// --- Budget: observed spend is "Unpriced", never $0; a token budget works without prices (S64) --------------------------------
teamSettings={...teamSettings,monthlyBudgetTokens:5000} as any;
await click([...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent==='Budget'),150);
assert.equal(text('.pp-budget-head .ws-chip')[0],'Near budget','4,000 of 5,000 tokens is past the 80% soft alert');
assert.ok(document.querySelector('.pp-budget .pp-meter'),'the meter shows token use');
assert.equal((document.getElementById('pp-token-budget-input') as HTMLInputElement).value,'5000');
assert.deepEqual(calls.filter(c=>c.command==='paperclip.dashboard').at(-1)!.input.projectId,'p1');
assert.equal(text('.pp-budget-grid .dash-value')[0],'Unpriced');
assert.ok(!text('.pp-budget').join(' ').includes('$0.00'),'no fake $0');
root.unmount();

// --- Dashboard -----------------------------------------------------------------------------------------------------------------------
const root2=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root2.render(<DashboardPage snapshot={snapshot as any} nav={nav}/>);
await delay(150);
assert.deepEqual(text('.dash-tile-label'),['Agents enabled','Tasks in progress','Month spend','Pending approvals']);
assert.deepEqual(text('.dash-tile .dash-value'),['2','0','Unpriced','1'],'a hire waiting for approval is not enabled yet');
assert.match(text('.dash-tile-detail')[0],/1 running, 0 paused, 0 errors/);
assert.match(text('.dash-tile-detail')[1],/2 open, 1 blocked/);
assert.deepEqual(text('.dash-agent header .ws-name-link'),['CTO','QA'],'working agents first');
assert.match(text('.dash-agent footer')[0],/^Working now/); assert.match(text('.dash-agent footer')[1],/^Finished/);
assert.deepEqual(text('.dash-chart figcaption strong'),['Run activity','Tasks by status','Success rate']);
assert.ok(document.querySelectorAll('.dash-bar rect[data-tone="ok"]').length>=2,'bars are drawn in token colours');
assert.deepEqual(text('.dash-legend li').slice(0,3),['Succeeded','Failed','Other']);
assert.equal(text('.dash-activity .ws-row-title')[0],'Added CTO as Chief Technology Officer');
assert.equal(text('.dash-task .ws-key').length,3);
root2.unmount();

// --- Import mapping --------------------------------------------------------------------------------------------------------------------
const root3=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
let imported=0,changed:[string,string]|null=null;
root3.render(<ImportMapping plan={{company:{id:'c',name:'RagnarDataOps'},companies:[],muster:[{id:'p1',name:'OSSMANAGER',folders:['/work/oss']}],
  projects:[{id:'pc1',name:'OSS Manager',repo:'github.com/hybrowlabs/oss-manager',localFolder:'/work/oss',taskCount:16,mappedTo:null,suggestion:{projectId:'p1',reason:'folder'}},{id:'pc2',name:'Muster',repo:null,localFolder:null,taskCount:0,mappedTo:null,suggestion:null}]} as any}
  targets={{pc1:'p1',pc2:'new'}} busy={false} onChange={(a,b)=>{changed=[a,b];}} onCancel={()=>{}} onImport={()=>{imported++;}}/>);
await delay(60);
assert.deepEqual(text('.ws-import-map .ws-row-title'),['OSS Manager','Muster']);
assert.deepEqual(text('.ws-import-map .ws-chip'),['Matched: same folder']);
assert.deepEqual([...(document.querySelector('.ws-import-map select') as HTMLSelectElement).options].map(o=>o.textContent),['Fill OSSMANAGER','New project','Don’t import']);
await setValue(document.querySelectorAll('.ws-import-map select')[1],'skip');
assert.deepEqual(changed,['pc2','skip']);
await click(button(/^Import 2 projects$/));
assert.equal(imported,1);
root3.unmount();

// S44: "Open project" from the sidebar lands on the project the first time, even when React discards a first render.
{
  const {StrictMode,Suspense,lazy}=await import('react');
  // A lazy sibling still loading: React throws the first render of the screen away, as a lazy chunk does in the app.
  const Lazy=lazy(()=>new Promise<{default:()=>null}>(r=>setTimeout(()=>r({default:()=>null}),30)));
  const {ProjectsScreen}=await import('../src/renderer/components/ProjectsScreen');
  const {openProject}=await import('../src/renderer/projectFocus');
  await (await import('../src/renderer/store')).boot();
  openProject('p1');
  const root4=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
  root4.render(<StrictMode><Suspense fallback={null}><Lazy/><ProjectsScreen onBack={()=>{}} onStartChat={()=>{}}/></Suspense></StrictMode>);
  for(let i=0;i<40&&!document.querySelector('.project-screen');i++)await delay(50);
  await delay(150);
  assert.match(text('.ws-crumb')[0]??'',/OSSMANAGER/,'the first open shows the project, not the list');
  root4.unmount();
}
assert.deepEqual(errors,[]);
assert.equal(intervals,0,'no intervals anywhere');
console.log('projects-parity-components: ok');
process.exit(0);
