/** Paperclip-in-Muster DOM checks (#115): the Inbox, a task thread (agent turns, system cards, Receipts, @-mentions,
 *  Properties and Memory), the project Roster graph (cards, keyboard, talking-now edge) and the cost rules (live on
 *  mount, off on unmount, no intervals). Bundled with esbuild and run with Node like the other *-components suites.
 *  Never pass DOM nodes to assert.equal. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
let intervals=0;
const realSetInterval=globalThis.setInterval;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),
  setInterval:((fn:any,ms:number)=>{intervals++;return realSetInterval(fn,ms);}) as typeof setInterval});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return this._top??0;},set(v){this._top=v;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
(window.HTMLElement.prototype as any).setPointerCapture=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

const now=new Date().toISOString();
const task=(id:string,key:string,title:string,status:string,extra:object={})=>({id,key,title,status,priority:'high',source:'paperclip',projectId:'p1',parentId:null,goalId:null,assigneeId:'cto',assigneeLabel:'CTO',createdAt:now,updatedAt:now,startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:'CEO',...extra});
const agent=(id:string,name:string,reportsTo:string|null,status='idle')=>({id,name,role:id,title:`${name} title`,model:'claude-opus-5-5',adapter:'claude_local',source:'paperclip',status,reportsTo,lastActiveAt:now,error:null,pausable:true,capabilities:`${name} does things.`});
const snapshot={paperclip:{origin:'This Mac',company:{id:'c',name:'RagnarDataOps',prefix:'RAG'},companies:[],live:'socket'},
  tasks:[task('t1','RAG-1','Migration wizard','in_progress',{assigneeId:'ceo',assigneeLabel:'CEO'}),task('t15','RAG-15','Implement migration','in_progress',{live:true,parentId:'t1'}),task('t4','RAG-4','Docs','blocked',{assigneeId:'qa',assigneeLabel:'QA'})],
  agents:[agent('ceo','CEO',null),agent('cto','CTO','ceo','running'),agent('qa','QA','cto','error')],
  projects:[{id:'p1',name:'OSS Manager',status:'in_progress',description:'',source:'paperclip',repo:'github.com/hybrowlabs/oss-manager',cwd:'/work/oss',taskCount:3,openCount:3,paused:false,memory:{label:'oss-manager',count:3}}],goals:[],
  runs:[{id:'r1',agentId:'cto',taskId:'t15',status:'running',trigger:'assignment',source:'paperclip',createdAt:now,startedAt:now,finishedAt:null,error:null,cancellable:true}],
  inbox:[{id:'i1',kind:'question',title:'RAG-1 · Approve the plan',why:'Waiting for the board.',severity:'high',at:now,taskId:'t1',agentId:null,runId:null,group:'OSS Manager',source:'paperclip',projectId:'p1'},
    {id:'i2',kind:'agent_error',title:'QA',why:'continuation_task_ownership_changed',severity:'high',at:now,taskId:null,agentId:'qa',runId:null,group:'RagnarDataOps',source:'paperclip'}],
  counts:{liveRuns:1,inbox:2,failedRuns:0,openTasks:3},fetchedAt:now};
const receipt={id:'paperclip:r1',seq:null,source:'paperclip',chatId:null,runId:'r1',taskId:'t1',projectId:null,trigger:'assignment',agent:'CEO',provider:'claude_local',model:'claude-opus-5-5',tokens:{input:12300,cached:0,output:1200,reasoning:0},costUsd:null,tools:[],approvals:0,tests:2,files:[{path:'a.ts',status:'modified',before:'1111111',after:'2222222',added:12,removed:3}],startedAt:now,endedAt:now,durationMs:64000,outcome:'succeeded',prevHash:null,hash:null};
const historyEntry={...receipt,id:'history:chat1:u1',source:'history',chatId:'chat1',runId:'run-old',taskId:null,agent:'Refactor login',tokens:null,tests:0,files:null};
let ledgerEntries:any[]=[];
const calls:{command:string;input:any}[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.snapshot')return snapshot;
  if(command==='paperclip.watch')return {live:'socket'};
  // A Muster task whose run is waiting on a question: the card carries the run's real question and answers it in place.
  if(command==='paperclip.task'&&input.id==='t15')return {task:snapshot.tasks[1],description:'',comments:[],runs:[],addressee:{id:'cto',label:'CTO'},composerNote:null,subtasks:[],blocking:[],receipts:[],mentionable:[],
    cards:[{kind:'needs',id:'interaction:int-q',at:now,from:'CTO',prompt:'Which scope?',detail:null,status:'pending',resolution:null,interactionId:'int-q',acceptLabel:null,rejectLabel:null,submitLabel:'Send',
      questions:[{id:'scope',prompt:'Which scope?',helpText:null,multi:false,allowOther:false,options:[{id:'mig',label:'Migration only',description:null},{id:'all',label:'Everything',description:null}]}]}]};
  if(command==='paperclip.task'&&input.id==='t4')return {task:snapshot.tasks[2],description:'',comments:[],runs:[{id:'a9',agentId:'qa',taskId:'t4',status:'failed',trigger:'user',source:'local',createdAt:now,startedAt:now,finishedAt:now,error:'The provider attempt failed: rate_limited',cancellable:false,chatId:'c-run'}],addressee:{id:'qa',label:'QA'},composerNote:null,subtasks:[],blocking:[],receipts:[],mentionable:[],
    cards:[{kind:'needs',id:'needs:q1',at:now,from:'QA',prompt:'Which colour should the banner be?',detail:null,status:'pending',resolution:null,interactionId:null,acceptLabel:null,rejectLabel:null,chatId:'c-run',
      pending:{id:'q1',chatId:'c-run',kind:'question',text:'The provider needs your input.',status:'pending',createdAt:now,data:{method:'item/tool/requestUserInput',questions:[{id:'color',header:'Colour',question:'Which colour should the banner be?',options:[{label:'Blue'},{label:'Green'}],allowCustomAnswer:false,multiSelect:false}]}}},
      // Imported issue approvals (S17): a read-only Approval card with its status.
      {kind:'approval',id:'import:ap-1',at:now,title:'Ship the migration to production',status:'pending'},
      {kind:'approval',id:'import:ap-2',at:now,title:'Rotate the API keys',status:'approved'}]};
  if(command==='paperclip.task')return {task:snapshot.tasks[0],description:'Build the **wizard**.',comments:[{id:'m1',author:{kind:'agent',id:'ceo',label:'CEO'},body:'@CTO please take the implementation.',createdAt:now,runId:'r1'}],runs:[snapshot.runs[0]],addressee:{id:'ceo',label:'CEO'},composerNote:null,subtasks:['t15'],blocking:[],
    receipts:[receipt],mentionable:[{id:'ceo',name:'CEO'},{id:'cto',name:'CTO'},{id:'qa',name:'QA'}],
    cards:[{kind:'delegated',id:'d1',at:now,from:'CEO',to:'CTO',taskId:'t15',key:'RAG-15',title:'Implement migration',brief:''},
      {kind:'needs',id:'n1',at:now,from:'CEO',prompt:'Approve the migration-only plan?',detail:null,status:'pending',resolution:null,interactionId:'int-1',acceptLabel:'Approve and delegate',rejectLabel:'Request changes'},
      {kind:'handoff',id:'h1',at:now,from:'CEO',to:'CTO',summary:'RAG-1 → RAG-15',memory:[{text:'Baseline is 66 failed / 6304 passed.',source:'oss-manager'}]}]};
  if(command==='paperclip.memory')return {scope:{kind:'repository',label:'oss-manager',folderId:'f'},repo:'github.com/hybrowlabs/oss-manager',query:'x',records:[],engine:'not-configured',note:'3 memories in the oss-manager folder, none about this task yet.'};
  if(command==='paperclip.comment')return {id:'m2',author:{kind:'user',id:null,label:'Board'},body:input.body,createdAt:now};
  if(command==='paperclip.interaction.respond')return {ok:true};
  if(command==='paperclip.ledger')return {entries:ledgerEntries,chain:{ok:true,entries:0,head:'0'.repeat(64),brokenAt:null}};
  if(command==='paperclip.ledger.backfill'){ledgerEntries=[historyEntry];return {chats:1,turns:1};}
  if(command==='paperclip.inbox.dismissed')return {items:[]};
  if(command==='paperclip.inbox.dismiss')return {ok:true};
  if(command==='app.snapshot')return {folders:[],chats:[{id:'chat1',title:'Refactor login',status:'failed',error:'Rate limited by the provider',archived:false,updatedAt:now,pinned:false,draft:'',model:'m',mode:'agent'},
    {id:'chat2',title:'Quit mid-turn',status:'interrupted',unread:true,archived:false,updatedAt:now,pinned:false,draft:'',model:'m',mode:'agent'}],projects:[],version:1};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {HubScreen}=await import('../src/renderer/components/HubScreen');
const {ProjectRoster}=await import('../src/renderer/components/ProjectHub');
const {openHub,hubRoute}=await import('../src/renderer/hubStore');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=(sel:string)=>[...document.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=async(el:Element|null|undefined)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));await delay(80);};
const key=async(el:Element,k:string)=>{const e=new window.Event('keydown',{bubbles:true,cancelable:true}) as any;e.key=k;el.dispatchEvent(e);await delay(40);};

openHub('inbox');
root.render(<HubScreen/>);
await delay(200);
assert.deepEqual(errors,[]);
assert.ok(calls.some(c=>c.command==='paperclip.watch'&&c.input.visible===true),'the hub goes live on mount');
// Inbox: Paperclip items grouped by project; plain-language errors; buckets
assert.deepEqual(text('.ws-filter').map(t=>t.replace(/\d+$/,'')),['All','Mine','Unread','Snoozed','All','Needs you','Done','Review','Problems','Mail'],'the views (Mine, Unread, Snoozed) come before the buckets');
assert.ok(text('.ws-group-title').some(t=>t.startsWith('OSS Manager')));
assert.ok(text('.ws-row-meta').some(t=>/reassigned while this run was working/.test(t)),'opaque error codes become plain sentences');
// Task thread
await click([...document.querySelectorAll('.ws-row-link')].find(b=>/Approve the plan/.test(b.textContent!)));
await delay(150);
assert.match(document.querySelector('.ws-thread-title')!.textContent!,/Migration wizard/);
assert.ok(text('.ws-message-author').some(t=>/CEO.*CTO/.test(t)),'an @-addressed turn reads "CEO → CTO"');
assert.deepEqual([...document.querySelectorAll('.ws-card-sys')].map(c=>(c as any).dataset.kind).sort(),['delegated','handoff','needs']);
assert.match(text('.ws-card-memory')[0],/Memory carried · 1 note[\s\S]*6304 passed/);
assert.match(text('.ws-receipt-summary')[0],/1 file \+12 −3 · 2 test runs · 12\.3k in · 1\.2k out · unpriced · 1m 4s/,'a Receipt: files, tests, tokens, honest cost, time');
await click([...document.querySelectorAll('.ws-card-actions button')].find(b=>/Approve and delegate/.test(b.textContent!)));
assert.deepEqual(calls.find(c=>c.command==='paperclip.interaction.respond')?.input,{taskId:'t1',interactionId:'int-1',accept:true},'Needs you is answerable in the thread');
assert.deepEqual(text('.ws-prop-group'),['Work','Memory','Relationships','Execution','About']);
const box=document.querySelector('.ws-composer textarea') as any;
assert.match(box.getAttribute('placeholder'),/Message CEO/);
let proto=Object.getPrototypeOf(box),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);
box.selectionStart=4;descriptor!.set!.call(box,'@CT');box.selectionStart=3;box.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(40);
assert.deepEqual(text('.ws-mentions button'),['CTCTO'],'typing @ offers the agents');
descriptor!.set!.call(box,'@CTO rebase onto dev');box.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(40);
document.querySelector('.ws-composer')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(80);
assert.deepEqual(calls.find(c=>c.command==='paperclip.comment')?.input,{taskId:'t1',body:'@CTO rebase onto dev'});
// A Muster run's question is answered from its task card through question.respond (not "reply below").
openHub('task','t4');await delay(150);
{
  const runCard=document.querySelector('.ws-card-sys[data-kind="needs"]')!;
  assert.ok(runCard?.querySelector('.pending-question'),'the run’s question renders in the card');
  assert.match(runCard.textContent!,/Which colour should the banner be\?/);
  assert.ok(!/replying below/.test(runCard.textContent!),'no "reply below" for a run question');
  const blue=runCard.querySelector('input[type="radio"]') as any;
  const props=Object.keys(blue).find(k=>k.startsWith('__reactProps'))!;
  blue[props].onChange({target:blue,currentTarget:blue});await delay(40);
  await click([...runCard.querySelectorAll('button')].find(b=>/Send answer/.test(b.textContent!)));
  assert.deepEqual(calls.find(c=>c.command==='question.respond')?.input,{id:'q1',answers:{color:{answers:['Blue']}}},'answered through question.respond');
  // S37: the failed run's chat is one click away from the task.
  const open=[...document.querySelectorAll('.ws-properties button')].find(b=>b.textContent==='Open run chat');
  assert.ok(open,'Open run chat on the Last run');
  await click(open);
  assert.ok(calls.some(c=>/^chat\.(select|timeline)$/.test(c.command)&&c.input.id==='c-run'),'it opens the run chat');
  const approvals=[...document.querySelectorAll('.ws-card-sys[data-kind="approval"]')];
  assert.deepEqual(approvals.map(a=>a.querySelector('.ws-card-sys-text')!.textContent),['Approval Ship the migration to production','Approval Rotate the API keys']);
  assert.deepEqual(approvals.map(a=>a.querySelector('.ws-chip')?.textContent),['pending','approved'],'each approval shows its status');
}
// A Paperclip question set is answered in place through Paperclip's respond endpoint.
openHub('task','t15');await delay(150);
{
  const qCard=document.querySelector('.ws-card-sys[data-kind="needs"]')!;
  assert.match(qCard.textContent!,/Which scope\?/);
  const options=[...qCard.querySelectorAll('input[type="radio"]')] as any[];
  assert.equal(options.length,2);
  const props=Object.keys(options[0]).find(k=>k.startsWith('__reactProps'))!;
  options[0][props].onChange({target:options[0],currentTarget:options[0]});await delay(40);
  await click([...qCard.querySelectorAll('button')].find(b=>/^Send$/.test(b.textContent!)));
  assert.deepEqual(calls.find(c=>c.command==='paperclip.interaction.respond'&&c.input.answers)?.input,{taskId:'t15',interactionId:'int-q',accept:true,answers:[{questionId:'scope',optionIds:['mig']}]});
}
root.unmount();await delay(30);
assert.equal(calls.filter(c=>c.command==='paperclip.watch').at(-1)!.input.visible,false,'leaving the hub stops live updates');

// Project › Roster: cards, reporting lines, the talking-now edge, keyboard
const root2=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root2.render(<ProjectRoster projectId="p1"/>);
await delay(200);
const cards=[...document.querySelectorAll('.ws-roster-card')];
assert.deepEqual(cards.map(c=>c.querySelector('.ws-roster-name')!.textContent),['CEO','CTO','QA']);
assert.equal(document.querySelectorAll('.ws-roster-line').length,2,'CEO→CTO and CTO→QA reporting lines');
assert.equal(document.querySelectorAll('.ws-roster-talk').length,1,'CEO is talking to CTO on the live RAG-15');
assert.match(cards[1].getAttribute('title')!,/Working on: RAG-15 Implement migration\nModel: claude-opus-5-5/,'hover shows current work and model');
assert.match(cards[0].textContent!,/3/,'memory badge from the project’s bank');
// Pulse: Paperclip agents belong to the company, so the project's Pause says so and warns before stopping them.
const pause=[...document.querySelectorAll('.ws-page-actions button')].find(b=>/^Pause/.test(b.textContent!));
assert.equal(pause?.textContent,'Pause 3 Paperclip agents (company-wide)');
await click(pause);
assert.deepEqual(text('.ws-confirm-text'),['Pause 3 Paperclip agents? They also stop working on other projects.']);
await click([...document.querySelectorAll('.ws-confirm button')].find(b=>/Keep running/.test(b.textContent!)));
assert.equal(calls.filter(c=>c.command==='paperclip.agent.pause').length,0,'nothing pauses without the confirm');
let focused='';(window.HTMLElement.prototype as any).focus=function(){focused=this.querySelector?.('.ws-roster-name')?.textContent??'';};
await key(cards[0],'ArrowDown');
assert.equal(focused,'CTO','arrow keys move between cards');
await click(document.querySelector('.ws-roster-talk-chip'));
assert.deepEqual([hubRoute().page,hubRoute().arg],['task','t15'],'the talking-now edge opens that conversation');
await click(cards[2]);
assert.deepEqual([hubRoute().page,hubRoute().arg],['agent','qa'],'a card opens the agent page');
assert.deepEqual(errors,[]);
assert.equal(intervals,0,'no intervals anywhere');
root2.unmount();

// Inbox with Paperclip unreachable on a fresh profile: say so, never "all caught up".
const {InboxPage}=await import('../src/renderer/components/HubPages');
const root3=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root3.render(<InboxPage snapshot={{...snapshot,inbox:[],tasks:[],projects:[],paperclip:{...snapshot.paperclip,company:null,stale:'fetch failed',cached:false}} as any} nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>);
await delay(120);
assert.ok(text('.resource-state-partial p').some(t=>/Paperclip can’t be reached, so its questions, approvals and problems are not shown/.test(t)));
assert.ok(!text('.resource-state-title').some(t=>/all caught up/.test(t)),'offline is never "all caught up"');
root3.unmount();

// An empty Ledger says nothing was recorded rather than "chain verified · 0 entries".
const {LedgerPage}=await import('../src/renderer/components/HubPages');
const root4=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root4.render(<LedgerPage snapshot={snapshot as any} nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>);
await delay(120);
assert.deepEqual(text('.ws-chain'),['No Muster turns recorded yet']);
// #190: the empty state says what gets recorded and offers the past turns.
assert.deepEqual(text('.resource-state-empty p:not(.resource-state-title)'),['Every agent turn from now on gets a receipt here. Past turns: Import history.']);
await click([...document.querySelectorAll('.resource-state-empty button')].find(b=>/Import history/.test(b.textContent!)));
await delay(120);
assert.ok(calls.some(c=>c.command==='paperclip.ledger.backfill'),'Import history runs the backfill');
assert.deepEqual(text('.ws-ledger .ws-source-history'),['Imported history'],'imported entries are tagged');
assert.match(text('.ws-chain')[0],/1 imported from history \(not chained\)/);
assert.match(text('.ws-receipt-summary')[0],/tokens not stored per turn/);
root4.unmount();

// #189: Inbox rows say an interrupted turn can be continued, and Dismiss hides a row (saved by id and time).
await (await import('../src/renderer/store')).boot();
const root5=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root5.render(<InboxPage snapshot={{...snapshot,inbox:[]} as any} nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>);
await delay(150);
const rowOf=(title:string)=>[...document.querySelectorAll('.ws-inbox-row')].find(r=>r.querySelector('.ws-row-title')?.textContent===title);
assert.ok(rowOf('Quit mid-turn'),'the interrupted chat is listed');
assert.equal(rowOf('Quit mid-turn')!.querySelector('.ws-row-meta')!.textContent,'Interrupted when Muster quit — continue?');
assert.equal(rowOf('Quit mid-turn')!.querySelector('.ws-row-action')!.textContent,'Continue');
await click(rowOf('Refactor login')!.querySelector('.ws-row-dismiss'));
assert.deepEqual(calls.filter(c=>c.command==='paperclip.inbox.dismiss').map(c=>c.input),[{id:'chat-problem:chat1',at:now}]);
assert.equal(rowOf('Refactor login'),undefined,'the dismissed row is gone');
assert.ok(rowOf('Quit mid-turn'),'other rows stay');
root5.unmount();
// A Roster agent opened from a project's page keeps the project as its breadcrumb, not "Inbox".
openHub('inbox');openHub('agent','qa',{page:'project',arg:'p1'});
const root6=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>{(errors as unknown[]).push(e);}});
root6.render(<HubScreen/>);await delay(150);
assert.deepEqual(text('.ws-crumb .ws-crumb-link'),['OSS Manager']);
root6.unmount();
assert.deepEqual(errors,[]);
console.log('hub-components: ok');
process.exit(0);
