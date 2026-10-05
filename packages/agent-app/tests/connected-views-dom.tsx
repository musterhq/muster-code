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
const PROJECT='p1';
const project={id:PROJECT,name:'Onboarding',status:'in_progress',description:'',source:'paperclip',repo:null,cwd:'/paperclip/instances/default/projects/co/p1/_default',taskCount:1,openCount:1,paused:false,memory:null};
const snapshot={paperclip:{origin:'aiteam.example.com',company:{id:'c',name:'B26Org',prefix:'BOR'},companies:[],live:'poll'},
  tasks:[],agents:[],projects:[project],goals:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:1},fetchedAt:now};
const row=(id:string,title:string,projectId:string|null)=>({id,title,detail:'agent abc',status:null,at:now,source:'paperclip',projectId});
const calls:{command:string;input:any}[]=[];
let costsReply:any={report:null,note:'Costs for server projects come from the server; not available here yet.'};
let runReply:any={run:null,receipt:null,missing:true,links:{run:null,task:null}};
let runError='';
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.snapshot')return snapshot;
  if(command==='paperclip.watch')return {live:'poll'};
  if(command==='paperclip.ledger')return {entries:[],chain:{ok:true,entries:0,head:'0'.repeat(64),brokenAt:null}};
  if(command==='paperclip.costs')return costsReply;
  if(command==='insight.costs')throw new Error('That project no longer exists.');
  if(command==='paperclip.list')return {kind:'audit',rows:[row('ev-p','issue.updated · issue',PROJECT),row('ev-org','invite.created · invite',null)],note:''};
  if(command==='paperclip.run'){if(runError)throw new Error(runError);return runReply;}
  if(command==='link.open')return {ok:true};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {LedgerPage}=await import('../src/renderer/components/HubPages');
const {RunDetailPage}=await import('../src/renderer/components/RunDetail');
const {PaperclipSettings}=await import('../src/renderer/components/ProjectPage');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=(sel:string)=>[...document.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const body=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(120);};
const show=async(node:React.ReactNode)=>{root.render(<>{node}</>);await delay(200);};
const tab=(label:string)=>[...document.querySelectorAll('[role="tab"]')].find(t=>t.textContent===label);
const nav={onOpenTask(){},onOpenAgent(){},onOpenChat(){},onOpenRun(){}} as any;

// B2: Costs on a connected project is read through the server; the local `insight.costs` is never asked, and nothing says "deleted".
await show(<LedgerPage snapshot={snapshot as any} nav={nav} projectId={PROJECT}/>);
await click(tab('Costs'));
assert.ok(calls.some(c=>c.command==='paperclip.costs'&&c.input.projectId===PROJECT),'costs go through the server');
assert.ok(!calls.some(c=>c.command==='insight.costs'),'the local project store is never asked about a server project');
assert.match(body(),/Costs for server projects come from the server; not available here yet/);
assert.doesNotMatch(body(),/no longer exists|could not be read/);
costsReply={report:{days:30,since:'2026-09-01',until:'2026-09-30',entries:2,totals:{key:'all',label:'Total',turns:2,inputTokens:2000,outputTokens:400,costUsd:0.02,unpricedTurns:1},byDay:[{day:'2026-09-30',turns:2,tokens:2400,costUsd:0.02}],byModel:[{key:'m',label:'gpt',turns:2,inputTokens:2000,outputTokens:400,costUsd:0.02,unpricedTurns:1}],byAgent:[{key:'Atlas',label:'Atlas',turns:2,inputTokens:2000,outputTokens:400,costUsd:0.02,unpricedTurns:1}],byProject:[],windows:[],ledgerSince:null,truncated:false},note:null};
await click(document.querySelector('button[aria-label="Refresh costs"]')??tab('Costs'));
await show(<LedgerPage key="again" snapshot={snapshot as any} nav={nav} projectId={PROJECT}/>);await click(tab('Costs'));
assert.match(body(),/Estimated cost/);assert.match(body(),/Atlas/);assert.match(body(),/what the server reported/);

// B4: the project's Activity shows that project's events; organisation events sit behind an explicitly labelled view.
await show(<LedgerPage key="act" snapshot={snapshot as any} nav={nav} projectId={PROJECT}/>);
await click(tab('Activity'));
assert.deepEqual(text('.ws-row-title'),['issue.updated · issue'],'only this project’s event');
assert.doesNotMatch(body(),/invite\.created/);
const scope=(label:string)=>[...document.querySelectorAll('[aria-label="Activity scope"] button')].find(b=>b.textContent===label);
assert.deepEqual([...document.querySelectorAll('[aria-label="Activity scope"] button')].map(b=>b.textContent),['This project','Organisation activity']);
await click(scope('Organisation activity'));
assert.deepEqual(text('.ws-row-title').sort(),['invite.created · invite','issue.updated · issue']);
assert.match(text('.ws-activity-scope')[0]!,/Organisation activity: every event in B26Org, not only this project/);
await click(scope('This project'));
assert.deepEqual(text('.ws-row-title'),['issue.updated · issue']);
// The global Ledger (no project) still lists everything and has no scope switch.
await show(<LedgerPage key="global" snapshot={snapshot as any} nav={nav}/>);await click(tab('Activity'));
assert.equal(text('.ws-row-title').length,2);assert.equal(document.querySelector('[aria-label="Activity scope"]'),null);

// B5: a server path is the server's workspace, with its host; a local checkout is a separate, read-only field.
await show(<PaperclipSettings snapshot={snapshot as any}/>);
assert.deepEqual(text('.pp-fields dt'),['Name','Description','Repository','Server workspace','Local checkout on this Mac','Memory']);
const dd=(label:string)=>[...document.querySelectorAll('.pp-fields > div')].find(d=>d.querySelector('dt')?.textContent===label)!.querySelector('dd')!.textContent!;
assert.match(dd('Server workspace'),/\/paperclip\/instances\/default\/projects\/co\/p1\/_default on aiteam\.example\.com/);
assert.match(dd('Local checkout on this Mac'),/Not linked/);assert.equal(document.querySelector('.pp-fields input'),null,'the local checkout is read-only for now');
assert.doesNotMatch(body(),/Local folder/);

// B3/B6: a run the snapshot no longer lists is read from the server, with its tool use, an Open in server link and the receipt by run id.
const run={id:'run-old',agentId:null,taskId:null,status:'succeeded',trigger:'assignment',source:'paperclip',createdAt:now,startedAt:now,finishedAt:now,error:null,cancellable:false};
const receipt={id:'paperclip:run-old',seq:null,source:'paperclip',chatId:null,runId:'run-old',taskId:null,projectId:null,trigger:'assignment',agent:'Atlas',provider:null,model:null,tokens:{input:10,cached:0,output:5,reasoning:0},costUsd:null,tools:[{name:'Bash',count:2},{name:'Read',count:1}],approvals:0,tests:1,files:null,startedAt:now,endedAt:now,durationMs:1000,outcome:'succeeded',prevHash:null,hash:null};
runReply={run,receipt,missing:false,links:{run:'https://aiteam.example.com/BOR/agents/a/runs/run-old',task:'https://aiteam.example.com/BOR/issues/BOR-2'}};
await show(<RunDetailPage snapshot={snapshot as any} runId="run-old" nav={nav}/>);
assert.deepEqual(calls.filter(c=>c.command==='paperclip.run').at(-1)?.input,{id:'run-old'},'fetched by id');
assert.doesNotMatch(body(),/no longer listed|not found/);
assert.match(text('.run-detail-facts')[0]!,/Started by\s*assignment/);
assert.match(body(),/Bash ×2, Read ×1/,'the receipt on the run page carries the tools');
await click([...document.querySelectorAll('button')].find(b=>/Open in server/.test(b.textContent!)));
assert.deepEqual(calls.filter(c=>c.command==='link.open').at(-1)?.input,{url:'https://aiteam.example.com/BOR/agents/a/runs/run-old'});
assert.ok([...document.querySelectorAll('a.ws-link')].some(a=>/Open its task in the server/.test(a.textContent!)));
// Not fetched is not none recorded.
runReply={...runReply,receipt:{...receipt,tools:[],toolsState:'unfetched'}};
await show(<RunDetailPage key="unfetched" snapshot={snapshot as any} runId="run-old" nav={nav}/>);
assert.match(body(),/Not fetched from the server/);assert.doesNotMatch(body(),/None recorded/);
runReply={...runReply,receipt:{...receipt,tools:[]}};
await show(<RunDetailPage key="none" snapshot={snapshot as any} runId="run-old" nav={nav}/>);
assert.match(body(),/None recorded/);
// Precise wording when the run is truly missing, and an error when the server could not be asked.
runReply={run:null,receipt:null,missing:true,links:{run:null,task:null}};
await show(<RunDetailPage key="gone" snapshot={snapshot as any} runId="run-gone" nav={nav}/>);
assert.match(body(),/This run was not found/);assert.match(body(),/the server answered that it has no such run/);assert.doesNotMatch(body(),/no longer listed/);
runError='Muster Server answered 500 for /heartbeat-runs/run-x.';
await show(<RunDetailPage key="err" snapshot={snapshot as any} runId="run-x" nav={nav}/>);
assert.match(body(),/This run could not be read from the server/);assert.match(body(),/answered 500/);assert.doesNotMatch(body(),/not found|no longer listed/);
assert.deepEqual(errors,[]);
console.log('connected-views-dom: ok');
process.exit(0);
