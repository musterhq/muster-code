// DOM checks for the Wave 1 governance UI: agent panel, project run policy and secrets, task stage card, stop menu and properties.
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null; // so React takes its real input-event path
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:(id:any)=>clearTimeout(id),ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
const hb={enabled:false,intervalSec:3600,wakeOnAssignment:false,wakeOnComment:false,wakeOnDecision:true,minGapSec:30,maxConcurrent:0};
const caps={canHire:false,canAssign:false,assignScope:'subtree',trust:'standard',containment:'project'};
let files=[{name:'AGENTS.md',text:'Be careful.',updatedAt:null},{name:'SOUL.md',text:'',updatedAt:null},{name:'HEARTBEAT.md',text:'',updatedAt:null},{name:'TOOLS.md',text:'',updatedAt:null}];
const view=()=>({governance:{projectId:'p',memberId:'m1',heartbeat:hb,capabilities:caps,toolRules:[],gitIdentity:null,secrets:[],updatedAt:null},files,revisions:[{id:'r2',version:2,note:'tone',actor:'You',createdAt:new Date().toISOString(),files:['AGENTS.md'],changed:['AGENTS.md']},{id:'r1',version:1,note:'',actor:'You',createdAt:new Date(Date.now()-3600_000).toISOString(),files:['AGENTS.md'],changed:['AGENTS.md']}],wakes:[{id:'w1',projectId:'p',memberId:'m1',taskId:null,reason:'timer',status:'skipped',detail:'Nothing ready for this agent, so the heartbeat started no run (no tokens used).',note:null,merged:1,createdAt:new Date().toISOString(),deliveredAt:null,chatId:null}],runs:[],ceiling:'workspace',secureStorage:true});
const gstate={settings:{runComment:'require',maxContinuations:2,maxRetries:2,defaultPolicy:null,watchdogAgentId:null,stormPerMinute:12,budgetHardStop:true},holds:[{id:'h1',projectId:'p',rootTaskId:'t1',rootKey:'OSS-1',rootTitle:'Root',mode:'pause',release:'manual',status:'active',reason:'',taskIds:['t1','t2'],actor:'You',createdAt:new Date().toISOString(),releasedAt:null,activeRuns:0}],hiddenTaskIds:[],stages:[],policies:[],
 watchdogs:[{id:'wd1',projectId:'p',taskId:'t1',key:'OSS-1',title:'Root',fingerprint:'x',state:'open',summary:'OSS-1 “Root” stopped: 1 of 1 task failed or blocked and nothing is running.',leaves:[{id:'t2',key:'OSS-2',title:'Leaf',state:'failed'}],verdictBy:null,note:null,createdAt:new Date().toISOString(),resolvedAt:null,reviewChatId:null}],monitors:[],breakers:[{id:'b1',projectId:'p',kind:'wake_storm',subject:'m1',summary:'14 wakes in a minute (limit 12). CTO was paused.',evidence:['Timer · 2026'],state:'open',createdAt:new Date().toISOString(),memberId:'m1'}],recovery:[{id:'needs_followup:t2',projectId:'p',taskId:'t2',kind:'needs_followup',summary:'OSS-2: the agent ended its turns without doing the work',at:new Date().toISOString(),actions:['rerun','cancel','dismiss']}],proposals:[],runs:[],wakes:[]};
let secrets:any[]=[{name:'NPM_TOKEN',description:'publish',version:2,versions:[{version:2,createdAt:new Date().toISOString(),by:'You',current:true},{version:1,createdAt:new Date(Date.now()-86400_000).toISOString(),by:'You',current:false}],createdAt:'',rotatedAt:new Date().toISOString(),expiresAt:null,grantedTo:['CTO']}];
let proposals:any[]=[{id:'sp1',projectId:'p',memberId:'m1',memberName:'CTO',taskId:'t2',name:'DEPLOY_KEY',purpose:'push the release tag',state:'pending',createdAt:new Date().toISOString(),decidedAt:null,expiresAt:new Date(Date.now()+86400_000).toISOString()}];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'project.agent.gov.get':return view();
  case 'project.agent.files.save':files=files.map(f=>f.name===input.name?{...f,text:input.text}:f);return {files,revision:{id:'r3',version:3,note:'',actor:'You',createdAt:'',files:[],changed:[input.name]}};
  case 'project.agent.gov.set':return view().governance;
  case 'project.agent.wake':return {id:'w9',projectId:'p',memberId:'m1',taskId:null,reason:'on_demand',status:'refused',detail:'This agent has no ready task, so there is nothing to start.',note:null,merged:1,createdAt:'',deliveredAt:null,chatId:null};
  case 'project.agent.revisions.restore':return {files,revision:{id:'r4',version:4,note:'',actor:'You',createdAt:'',files:[],changed:[]}};
  case 'project.secrets.list':return {secrets,proposals,secureStorage:true};
  case 'project.secrets.audit':return {events:[{id:'e1',name:'NPM_TOKEN',kind:'lend',actor:'CTO',detail:'lent to a run as an environment variable',chatId:'c',at:new Date().toISOString()}]};
  case 'project.secrets.decide':proposals=proposals.map(p=>({...p,state:input.approve?'approved':'denied'}));return proposals[0];
  case 'project.secrets.save':secrets=[...secrets,{name:input.name,description:'',version:1,versions:[],createdAt:'',rotatedAt:null,expiresAt:null,grantedTo:[]}];return secrets.at(-1);
  case 'project.gov.state':return gstate;
  case 'project.gov.settings.set':return gstate.settings;
  case 'project.watchdogs.resolve':case 'project.breakers.resolve':case 'project.recovery.resolve':case 'project.holds.release':case 'project.holds.create':case 'project.tasks.decide':case 'project.tasks.stop':case 'project.tasks.policy.set':case 'project.tasks.hide':case 'project.monitors.set':return {ok:true};
  case 'paperclip.snapshot':return {paperclip:null,tasks:[],agents:[],projects:[],goals:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:''};
  default:throw new Error(`unexpected ${command}`);
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {AgentGovernancePanel}=await import('../src/renderer/components/AgentGovernance');
const {GovernanceSection,SecretsSection}=await import('../src/renderer/components/ProjectGovernance');
const {StageCard,StopButton,GovernanceProperties}=await import('../src/renderer/components/TaskGovernance');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click exists');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');if(el.tagName==='SELECT'){for(const o of [...el.options])o.selected=o.value===value;try{Object.defineProperty(el,'value',{configurable:true,get:()=>value});}catch{}el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);return;}let proto=Object.getPrototypeOf(el),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
const last=(command:string)=>calls.filter(c=>c.command===command).at(-1);
const agent:any={id:'member:m1',name:'CTO',role:'agent',title:'CTO',model:'m',adapter:'codex',source:'local',status:'idle',reportsTo:null,lastActiveAt:null,error:null,capabilities:null,pausable:true,projectId:'p',memberId:'m1',runner:null,instructions:'Be careful.'};
const snapshot:any={paperclip:null,tasks:[{id:'t1',key:'OSS-1',title:'Root',assigneeId:'member:m1',status:'in_progress',live:false}],agents:[agent],projects:[],goals:[],runs:[],inbox:[],counts:{},fetchedAt:''};

// Agent panel: Instructions edit and save with a note.
root.render(<AgentGovernancePanel agent={agent} snapshot={snapshot}/>);await delay(40);
assert.match(text(),/Governance/);assert.ok(document.querySelector('textarea[aria-label="AGENTS.md text"]'));
click(button(/^SOUL\.md/));await delay(10);
await setValue(document.querySelector('input[aria-label="Revision note"]'),'persona');await setValue(document.querySelector('textarea[aria-label="SOUL.md text"]'),'You are terse.');
click(button(/^Save$/));await delay(30);
assert.deepEqual(last('project.agent.files.save')!.input,{projectId:'p',memberId:'m1',name:'SOUL.md',text:'You are terse.',note:'persona'});
// Runtime: heartbeat toggle, interval, save, Wake now reports the real answer.
click([...document.querySelectorAll('[role=tab]')].find(t=>/^Runtime$/.test(t.textContent??'')));await delay(10);
{const box:any=document.querySelector('input[type=checkbox]');box.checked=true;click(box);await delay(10);}
click(button(/^Save$/));await delay(30);
assert.equal(last('project.agent.gov.set')!.input.heartbeat.enabled,true);
click(button(/Wake now/));await delay(30);
assert.match(document.querySelector('[role=status]')?.textContent??'',/no ready task/);
assert.match(text(),/heartbeat started no run/);
// Permissions: low-trust switches Can propose adding agents off; a tool rule is added and saved.
click([...document.querySelectorAll('[role=tab]')].find(t=>/^Permissions$/.test(t.textContent??'')));await delay(10);
const trust=document.querySelector('select[aria-label="Trust"]') as any;await setValue(trust,'low-trust');await delay(5);
assert.ok(document.querySelector('select[aria-label="Containment"]'),'containment appears for low-trust');
assert.ok((document.querySelector('input[type=checkbox][disabled]')),'hire is disabled for low-trust');
click(button(/Add rule/));await delay(5);
await setValue(document.querySelector('input[aria-label="Rule 1 pattern"]'),'git push*');await setValue(document.querySelector('select[aria-label="Rule 1 effect"]'),'deny');
click(button(/Save rules/));await delay(30);
assert.deepEqual(last('project.agent.gov.set')!.input.toolRules,[{match:'command',pattern:'git push*',effect:'deny'}]);
// Revisions: restore an older one.
click([...document.querySelectorAll('[role=tab]')].find(t=>/^Revisions$/.test(t.textContent??'')));await delay(10);
assert.match(text(),/Revision 2 · current/);click(button(/^Restore$/));await delay(30);
assert.equal(last('project.agent.revisions.restore')!.input.revisionId,'r1');

// Project run policy: needs a decision, with a way out for each.
root.render(<GovernanceSection projectId="p" snapshot={snapshot}/>);await delay(50);
assert.match(text(),/Wake storm/);assert.match(text(),/14 wakes in a minute/);assert.match(text(),/stopped: 1 of 1 task/);assert.match(text(),/ended its turns without doing the work/);assert.match(text(),/On hold|Paused/);
click(button(/Resume the agent/));await delay(20);assert.equal(last('project.breakers.resolve')!.input.action,'resume');
click(button(/^Reopen$/));await delay(20);assert.equal(last('project.watchdogs.resolve')!.input.verdict,'reopen');
click([...document.querySelectorAll('.gov-item button')].find(b=>/^Re-run$/.test(b.textContent??'')));await delay(20);assert.deepEqual(last('project.recovery.resolve')!.input,{projectId:'p',taskId:'t2',action:'rerun'});
await setValue(document.querySelector('select[aria-label="Run comment rule"]'),'off');await delay(20);assert.equal(last('project.gov.settings.set')!.input.runComment,'off');
const reassign=document.querySelector('select[aria-label="Reassign to"]') as any;assert.ok(reassign);

// Secrets: values are password fields; approving a request sends the value you typed; nothing shows a value.
root.render(<SecretsSection projectId="p" snapshot={snapshot}/>);await delay(50);
assert.match(text(),/NPM_TOKEN/);assert.match(text(),/Lent to CTO/);assert.match(text(),/DEPLOY_KEY/);assert.match(text(),/Given to a run/);
assert.equal((document.querySelector('input[aria-label="Secret value"]') as any).type,'password');
const approve=button(/^Approve$/) as any;assert.ok(approve.disabled,'approve needs a value');
await setValue(document.querySelector('input[aria-label="Value for DEPLOY_KEY"]'),'tok_live_abc123456789');await delay(5);
assert.equal((document.querySelector('input[aria-label="Value for DEPLOY_KEY"]') as any).type,'password');
click(button(/^Approve$/));await delay(30);
assert.deepEqual(last('project.secrets.decide')!.input,{projectId:'p',id:'sp1',approve:true,value:'tok_live_abc123456789'});
assert.ok(!document.body.innerHTML.includes('tok_live_abc123456789'),'the typed value is cleared from the page');

// Task: stage card needs a note to request changes; Approve sends no note requirement.
const stage:any={taskId:'t1',stage:0,stages:2,round:2,status:'awaiting',kind:'review',approver:{kind:'user'},approverName:'You',reviewChatId:null,history:[{stage:0,kind:'review',decision:'changes_requested',by:'QA',note:'Add tests',at:new Date().toISOString(),round:1}],updatedAt:'',feedback:null};
root.render(<StageCard stage={stage} taskId="t1" projectId="p" onChanged={()=>{}}/>);await delay(20);
assert.match(text(),/Review 1 of 2/);assert.match(text(),/round 2/);assert.ok((button(/^Request changes$/) as any).disabled);
await setValue(document.querySelector('textarea[aria-label="Note for the owner"]'),'Cover the empty case.');await delay(5);
click(button(/^Request changes$/));await delay(20);assert.deepEqual(last('project.tasks.decide')!.input,{projectId:'p',id:'t1',decision:'request_changes',note:'Cover the empty case.'});
click(button(/^Approve$/));await delay(20);assert.equal(last('project.tasks.decide')!.input.decision,'approve');
assert.match(text(),/1 earlier decision/);

// Stop: split menu with the three variants.
root.render(<StopButton taskId="t1" projectId="p" onChanged={()=>{}}/>);await delay(10);
click(button(/More ways to stop/));await delay(10);
assert.deepEqual([...document.querySelectorAll('[role=menuitem]')].map(b=>b.firstChild?.textContent),['Stop','Stop and mark done','Stop and cancel']);
click([...document.querySelectorAll('[role=menuitem]')].find(b=>/mark done/.test(b.textContent??'')));await delay(20);
assert.deepEqual(last('project.tasks.stop')!.input,{projectId:'p',id:'t1',mode:'done'});

// Properties: cancelling a subtree needs the key typed.
const task:any={id:'t1',key:'OSS-1',title:'Root',status:'todo',assigneeId:'member:m1',assigneeLabel:'CTO'};
const governance:any={stage:null,policy:null,effectivePolicy:null,hold:null,hidden:false,runs:[{chatId:'c',taskId:'t1',memberId:'m1',reason:'timer',liveness:'completed',comment:'agent',continuations:1,retries:0,note:null,createdAt:new Date().toISOString(),settledAt:null,pendingAt:null}],monitor:null,watchdog:null,agents:[{memberId:'m1',name:'CTO'}]};
root.render(<GovernanceProperties task={task} governance={governance} projectId="p" onChanged={()=>{}}/>);await delay(20);
assert.match(text(),/Heartbeat timer/);assert.match(text(),/1 continued/);
click(button(/Cancel subtree…/));await delay(5);
assert.ok((button(/^Cancel subtree$/) as any).disabled,'disabled until the key is typed');
await setValue(document.querySelector('input[aria-label="Type the task key to confirm"]'),'OSS-1');await delay(5);
click(button(/^Cancel subtree$/));await delay(20);
assert.equal(last('project.holds.create')!.input.confirm,'OSS-1');assert.equal(last('project.holds.create')!.input.mode,'cancel');
click(button(/Pause subtree/));await delay(20);assert.equal(last('project.holds.create')!.input.mode,'pause');
assert.deepEqual(errors,[]);
console.log('governance components ok');
process.exit(0);
