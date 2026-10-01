// DOM checks for the Wave 3 navigation and insight UI: keyboard shortcuts and the cheatsheet (C3), costs and provider limits (G24),
// your stats (G38), Audit Runs (C26), the Reflection Coach (G25), Skill Studio (G26), the project setup wizard (C20, G31).
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const memory=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,KeyboardEvent:window.KeyboardEvent??window.Event,localStorage:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),URL:Object.assign(URL,{createObjectURL:()=>'blob:x',revokeObjectURL(){}})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).scrollIntoView=function(){};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
(window as any).open=()=>null;
Object.assign(window,{setTimeout,clearTimeout});

const now=new Date().toISOString(), ago=(ms:number)=>new Date(Date.now()-ms).toISOString();
const calls:{command:string;input:any}[]=[];
const last=(command:string)=>calls.filter(c=>c.command===command).at(-1);
const all=(command:string)=>calls.filter(c=>c.command===command);
let failProfile=false;
const profile={since:'2026-09-01T00:00:00Z',tasks:{total:12,completed:7,open:4,failed:1},runs:{total:40,succeeded:33,failed:5,other:2},tokens:{input:2_400_000,output:600_000},costUsd:12.5,unpricedTurns:3,providerMix:[{provider:'openai',name:'ChatGPT',turns:30,share:0.75},{provider:'anthropic',name:'Claude',turns:10,share:0.25}],activity:Array.from({length:28},(_,i)=>({day:`2026-09-${String(i+1).padStart(2,'0')}`,runs:i%3})),activeDays:19,streak:4,topProjects:[{projectId:'p',name:'OSSMANAGER',completed:5,open:2}]};
const costs=(days:number)=>({days,since:'2026-09-01',until:'2026-09-30',entries:9,totals:{key:'all',label:'Total',turns:9,inputTokens:90_000,outputTokens:30_000,costUsd:1.25,unpricedTurns:2},
  byDay:Array.from({length:Math.min(days,7)},(_,i)=>({day:`2026-09-${String(24+i).padStart(2,'0')}`,turns:i,tokens:i*1000,costUsd:i?i*0.1:null})),
  byModel:[{key:'a|gpt-x',label:'gpt-x',turns:7,inputTokens:80_000,outputTokens:20_000,costUsd:1.2,unpricedTurns:0},{key:'a|gpt-y',label:'gpt-y',turns:2,inputTokens:10_000,outputTokens:10_000,costUsd:null,unpricedTurns:2}],
  byAgent:[{key:'CTO',label:'CTO',turns:9,inputTokens:90_000,outputTokens:30_000,costUsd:1.25,unpricedTurns:2}],
  byProject:[{key:'p',label:'OSSMANAGER',projectId:'p',turns:9,inputTokens:90_000,outputTokens:30_000,costUsd:1.25,unpricedTurns:2}],
  windows:[{providerId:'codex',name:'ChatGPT sign-in',reports:true,usage:{providerId:'codex',primary:{usedPercent:42,windowMinutes:300,resetsAt:new Date(Date.now()+3_600_000).toISOString()},secondary:{usedPercent:71,windowMinutes:10080,resetsAt:null},planType:'plus',source:'live',updatedAt:now}},{providerId:'gw',name:'Gateway',reports:true,usage:null}],ledgerSince:'2026-08-20T00:00:00Z'});
let reflections:any[]=[{id:'r1',projectId:'p',memberId:'m1',agent:'CTO',file:'AGENTS.md',state:'ready',baseText:'Be careful.\n',proposedText:'Be careful.\nAdd a test with every fix.\n',rationale:'Replies were marked as missing tests.',evidence:{turns:12,failed:3,needsWork:2,changesRequested:1,tasks:4},chatId:'c1',error:null,createdAt:ago(3600_000),decidedAt:null},
  {id:'r0',projectId:'p',memberId:'m1',agent:'CTO',file:'AGENTS.md',state:'unchanged',baseText:'',proposedText:'',rationale:'It already fits.',evidence:{turns:5,failed:0,needsWork:0,changesRequested:0,tasks:2},chatId:null,error:null,createdAt:ago(8*86_400_000),decidedAt:ago(8*86_400_000)}];
let settings={projectId:'p',weekly:false,lastRunAt:null,nextRunAt:null as string|null};
let skillInputs:any[]=[{id:'i1',skill:'release-demo',label:'Small release',text:'Cut 1.2.0',createdAt:now}];
let skillRuns:any[]=[{id:'sr1',skill:'release-demo',inputId:'i1',input:'Cut 1.2.0',projectId:'p',chatId:'chat-x',state:'done',result:'Tagged 1.2.0.\nTest note: none',error:null,startedAt:ago(60_000),endedAt:now}];
const agents=[{id:'member:m1',name:'CTO',role:'agent',title:'CTO',model:null,adapter:null,source:'local',status:'idle',reportsTo:null,lastActiveAt:null,error:null,capabilities:null,pausable:true,projectId:'p',memberId:'m1'}];
const runs=[{id:'u1',agentId:'member:m1',taskId:'t1',status:'succeeded',trigger:'user',source:'local',createdAt:ago(3600_000),startedAt:ago(3600_000),finishedAt:ago(3000_000),error:null,cancellable:false},
  {id:'u2',agentId:'member:m1',taskId:'t1',status:'failed',trigger:'heartbeat',source:'local',createdAt:ago(7200_000),startedAt:ago(7200_000),finishedAt:ago(7000_000),error:'Provider rate limit reached',cancellable:false},
  {id:'u3',agentId:'member:m1',taskId:null,status:'succeeded',trigger:'automation',source:'local',createdAt:ago(10*86_400_000),startedAt:ago(10*86_400_000),finishedAt:ago(10*86_400_000-60_000),error:null,cancellable:false,chatId:'chat-old'}];
const wsSnapshot:any={paperclip:null,tasks:[{id:'t1',key:'OSS-1',title:'Fix login',status:'in_progress',priority:'medium',source:'local',projectId:'p',parentId:null,goalId:null,assigneeId:'member:m1',assigneeLabel:'CTO',createdAt:now,updatedAt:now,startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:null}],
  agents,projects:[{id:'p',name:'OSSMANAGER',status:'in_progress',description:'',source:'local',repo:null,cwd:null,taskCount:1,openCount:1,paused:false,memory:null}],goals:[],runs,inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:1,openTasks:1},fetchedAt:now};
let projectGoal='';
(window as any).muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'insight.profile':if(failProfile)throw new Error('Only owners and admins can see server-wide data.');return profile;
  case 'insight.costs':return costs(input.days??30);
  case 'insight.reflect.list':return {reflections,settings};
  case 'insight.reflect.accept':reflections=reflections.map(r=>r.id===input.id?{...r,state:'accepted'}:r);return reflections[0];
  case 'insight.reflect.dismiss':reflections=reflections.map(r=>r.id===input.id?{...r,state:'dismissed'}:r);return reflections[0];
  case 'insight.reflect.run':return {...reflections[0],id:'r2',state:'working'};
  case 'insight.reflect.settings.set':settings={...settings,weekly:input.weekly,nextRunAt:input.weekly?new Date(Date.now()+7*86_400_000).toISOString():null};return settings;
  case 'studio.skill.inputs.list':return {inputs:skillInputs,runs:skillRuns};
  case 'studio.skill.inputs.save':skillInputs=[{id:'i2',skill:input.skill,label:input.label,text:input.text,createdAt:now},...skillInputs];return skillInputs[0];
  case 'studio.skill.inputs.remove':skillInputs=skillInputs.filter(i=>i.id!==input.id);return {removed:true};
  case 'studio.skill.test':skillRuns=[{id:'sr2',skill:input.skill,inputId:input.inputId??null,input:input.input,projectId:input.projectId,chatId:'chat-y',state:'working',result:'',error:null,startedAt:now,endedAt:null},...skillRuns];return skillRuns[0];
  case 'studio.skill.templates':return {templates:[{id:'release-notes',name:'Release notes',description:'Use when asked to write release notes.',body:'# Release notes\n1. Group the changes.'}]};
  case 'studio.skill.fromTask':return {draft:{name:'Cut a release',description:'Use when asked to do work like “Cut a release”.',body:'# Cut a release\n\n## Goal\nCut a release.'},sources:{messages:4,documents:1,tools:['shell']}};
  case 'extensions.skills.read':return {name:input.name,description:'Cut a release',body:'# Release\n1. Tag it.',path:'/x',assets:[],history:[]};
  case 'extensions.skills.save':return {name:input.name,description:input.description,body:input.body,path:'/y',assets:[],history:[]};
  case 'project.update':projectGoal=input.goal??projectGoal;return {id:'p',name:'OSSMANAGER',goal:projectGoal,folderIds:['f1'],primaryFolderId:'f1',archived:false,archivedAt:null};
  case 'work.project.meta.set':return {projectId:'p',status:'in_progress',targetDate:input.targetDate??null,starred:false,hidden:false,updatedAt:now};
  case 'project.members.add':return {id:'m9',projectId:'p',name:input.name,kind:'agent',role:'agent',title:input.title,pendingAt:null};
  case 'paperclip.task.create':return {id:'t9',key:'OSS-9',title:input.title,status:'todo',priority:'medium',source:'local',projectId:'p',parentId:null,goalId:null,assigneeId:input.assigneeId,assigneeLabel:'CTO',createdAt:now,updatedAt:now,startedAt:null,completedAt:null,live:false,blockedByIds:[],origin:null,...(input.start?{started:{branch:'task/oss-9'}}:{})};
  case 'insight.setup.interview':return {chatId:'coord-1',started:true};
  case 'paperclip.snapshot':return wsSnapshot;
  case 'paperclip.watch':case 'paperclip.badge':return {connected:false,inbox:0,liveRuns:0,mail:0,chatIds:[]};
  case 'providers.list':return [];
  case 'app.snapshot':return {folders:[],chats:[],projects:[{id:'p',name:'OSSMANAGER',goal:'',folderIds:['f1'],primaryFolderId:'f1'}],version:1};
  case 'chat.select':case 'chat.timeline':return {items:[],revision:0};
  default:return undefined;
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const hub=await import('../src/renderer/hubStore');
await store.boot();
const {YouCard}=await import('../src/renderer/components/YouCard');
const {CostsPanel}=await import('../src/renderer/components/CostsPanel');
const {AuditRuns}=await import('../src/renderer/components/AuditRuns');
const R=await import('../src/renderer/components/ReflectionCoach');
const S=await import('../src/renderer/components/SkillStudio');
const {ProjectSetupWizard,SetupCard}=await import('../src/renderer/components/ProjectSetup');
const {WorkShortcutsHost}=await import('../src/renderer/components/WorkShortcuts');
const {setShortcutsEnabled}=await import('../src/renderer/shortcuts');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');if(el.tagName==='SELECT'){for(const o of [...el.options])o.selected=o.value===value;try{Object.defineProperty(el,'value',{configurable:true,get:()=>value});}catch{}el.dispatchEvent(new window.Event('change',{bubbles:true}));}else{const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(set)set.call(el,value);else el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));}await delay(30);};
const field=(label:string)=>document.querySelector(`[aria-label="${label}"]`) as any;
const submit=async(form:Element|null)=>{assert.ok(form,'form');form!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(60);};
const show=async(node:React.ReactNode,ms=80)=>{root.render(<>{node}</>);await delay(ms);};
const press=async(key:string,init:any={})=>{const {target,...rest}=init;const e:any=Object.assign(new window.Event('keydown',{bubbles:true,cancelable:true}),{key,metaKey:false,ctrlKey:false,altKey:false,shiftKey:false,isComposing:false,repeat:false,...rest});if(target)Object.defineProperty(document,'activeElement',{configurable:true,get:()=>target});(key==='Escape'?document:window).dispatchEvent(e);await delay(30);return e;};

// G38: your stats.
await show(<YouCard/>,140);
assert.match(text(),/Tasks completed/);assert.match(text(),/\b7\b/);assert.match(text(),/Agent turns/);assert.match(text(),/3\.0M|3M/);assert.match(text(),/\$12\.50/);assert.match(text(),/\+ unpriced/);
assert.match(text(),/ChatGPT/);assert.match(text(),/75%/);assert.match(text(),/Claude/);assert.match(text(),/Day|Days/);assert.match(text(),/Busiest projects/);assert.match(text(),/OSSMANAGER/);
assert.equal(document.querySelectorAll('.you .dash-bar').length,28,'a bar for each of the last 28 days');
await show(<YouCard projectId="p"/>,140);assert.match(text(),/Your part in this project/);assert.equal(last('insight.profile')!.input.projectId,'p');
failProfile=true;await show(<YouCard key="fail" projectId="p"/>,140);assert.equal(document.querySelector('.you'),null,'a server that keeps this read back just leaves the card out');failProfile=false;

// G24: costs by model, agent, project and day, provider windows.
await show(<CostsPanel/>,140);
assert.match(text(),/\$1\.25 \+ unpriced/);assert.match(text(),/2 unpriced turns left out/);assert.match(text(),/90,000|120K|90\.0K/);
assert.match(text(),/By model/);assert.match(text(),/gpt-x/);assert.match(text(),/gpt-y/);assert.match(text(),/Unpriced/,'a model with no price reads Unpriced, never $0');assert.ok(!/\$0\.00/.test(text()));
assert.match(text(),/By agent/);assert.match(text(),/CTO/);assert.match(text(),/By project/);
assert.match(text(),/Provider limits/);assert.match(text(),/ChatGPT sign-in/);assert.match(text(),/42% used/);assert.match(text(),/71% used/);assert.match(text(),/Weekly/);assert.match(text(),/Gateway/);assert.match(text(),/No usage reported yet/);
assert.match(text(),/goes back to/);assert.equal(last('insight.costs')!.input.days,30);
await click(button(/^7 days$/),100);assert.equal(last('insight.costs')!.input.days,7);assert.match(text(),/Last 7 days/);
await click(button(/Refresh costs/),100);assert.ok(all('insight.costs').length>=3);
await show(<CostsPanel key="project" projectId="p"/>,140);assert.equal(last('insight.costs')!.input.projectId,'p');assert.ok(!/Provider limits/.test(text())&&!/By project/.test(text()),'a project view has no provider limits or project table');

// C26: Audit Runs filter by window, outcome and agent; rows open the task.
const opened:string[]=[];
await show(<AuditRuns snapshot={wsSnapshot} nav={{onOpenTask:id=>opened.push(id),onOpenAgent:()=>{},onOpenChat:()=>{}}}/>,100);
assert.equal(document.querySelectorAll('.audit-table tbody tr').length,2,'7 days: the 10-day-old run is out');
assert.match(text(),/Fix login/);assert.match(text(),/heartbeat/);assert.match(text(),/Failed/);
await click(button(/^Failed/),60);assert.equal(document.querySelectorAll('.audit-table tbody tr').length,1);
await click(button(/^All/),60);
await setValue(document.querySelector('select[aria-label="Window"]'),'all');assert.equal(document.querySelectorAll('.audit-table tbody tr').length,3);
await setValue(document.querySelector('select[aria-label="Window"]'),'24h');assert.equal(document.querySelectorAll('.audit-table tbody tr').length,2);
await click(document.querySelector('.audit-table tbody .ws-link'),30);assert.deepEqual(opened,['t1']);

// G25: the proposal dialog shows why, the evidence and the diff; Apply sends the edit; Dismiss refuses nothing else.
let decided=0;
await show(<R.ReflectionDialog open reflection={reflections[0]} onClose={()=>{}} onDecided={()=>{decided++;}}/>,100);
assert.match(text(),/Update CTO.s instructions\?/);assert.match(text(),/marked as missing tests/);assert.match(text(),/12 turns read · 3 failed · 2 marked .Needs work. · 1 change request/);
assert.match(text(),/\+ Add a test with every fix/);assert.match(text(),/Nothing changes until you apply it/);
await click(button(/^Edit first/),60);await setValue(document.querySelector('.work-reflect textarea'),'Be careful.\nAdd a test.\nSay what you ran.\n');assert.match(text(),/\+ Say what you ran/);
await click(button(/^Apply/),100);assert.deepEqual(last('insight.reflect.accept')!.input,{projectId:'p',id:'r1',text:'Be careful.\nAdd a test.\nSay what you ran.\n'});assert.equal(decided,1);
reflections[0]={...reflections[0],state:'ready'};
await show(<R.ReflectionDialog key="plain" open reflection={reflections[0]} onClose={()=>{}} onDecided={()=>{decided++;}}/>,80);
await click(button(/^Apply/),100);assert.deepEqual(last('insight.reflect.accept')!.input,{projectId:'p',id:'r1'},'an unedited proposal is applied as written');
await show(<R.ReflectionDialog key="dismiss" open reflection={reflections[0]} onClose={()=>{}} onDecided={()=>{decided++;}}/>,80);
await click(button(/^Dismiss/),100);assert.equal(last('insight.reflect.dismiss')!.input.id,'r1');
// The agent page section: run now, weekly toggle, earlier proposals.
reflections[0]={...reflections[0],state:'ready'};
await show(<R.ReflectionSection agent={agents[0] as any}/>,140);
assert.match(text(),/Reflection coach/);assert.match(text(),/Replies were marked as missing tests/);assert.match(text(),/It already fits/);assert.match(text(),/No change/);
await click(button(/Reflect on recent work/),100);assert.deepEqual(last('insight.reflect.run')!.input,{projectId:'p',memberId:'m1'});
const weekly=document.querySelector('.reflect input[type="checkbox"]') as any;assert.equal(weekly.checked,false);weekly.checked=true;await click(weekly,100);
assert.deepEqual(last('insight.reflect.settings.set')!.input,{projectId:'p',weekly:true});
await click(button(/Review change/),80);assert.match(text(),/AGENTS\.md: \+1 −0/);

// G26: Skill Studio.
await show(<S.SkillStudio name="release-demo" canFork onForked={()=>{}}/>,140);
assert.match(text(),/read-only chat of a project/);assert.match(text(),/Small release/);assert.match(text(),/Test note: none/);assert.match(text(),/Tagged 1\.2\.0/);
await setValue(document.querySelector('.studio-input textarea'),'Cut 1.3.0 from these changes');
await click(button(/Run test/),100);assert.deepEqual(last('studio.skill.test')!.input,{projectId:'p',skill:'release-demo',input:'Cut 1.3.0 from these changes'});
assert.match(text(),/Running…/);
await setValue(field('Name for this input'),'Minor release');await click(button(/Save input/),100);assert.deepEqual(last('studio.skill.inputs.save')!.input,{skill:'release-demo',label:'Minor release',text:'Cut 1.3.0 from these changes'});
await setValue(field('Name for the fork'),'release-demo-v3');let forked='';
await show(<S.SkillStudio key="fork" name="release-demo" canFork onForked={n=>{forked=n;}}/>,140);
await setValue(field('Name for the fork'),'Release Demo V3');await click(button(/^Fork$/),120);
assert.deepEqual(last('extensions.skills.save')!.input,{name:'release-demo-v3',description:'Cut a release',body:'# Release\n1. Tag it.'});assert.equal(forked,'release-demo-v3');
await show(<S.SkillStudio key="nofork" name="release-demo" canFork={false} onForked={()=>{}}/>,120);assert.ok(!button(/^Fork$/),'only skills edited in the Skills editor can be forked');
await show(<S.SkillTemplates onPick={t=>{(globalThis as any).picked=t.id;}}/>,100);await click(button(/Release notes/),30);assert.equal((globalThis as any).picked,'release-notes');
await show(<S.SkillFromTask projectId="p" taskId="t1"/>,60);await click(button(/Make a skill from this task/),140);
assert.deepEqual(last('studio.skill.fromTask')!.input,{projectId:'p',taskId:'t1'});assert.match(text(),/Save as skill/);assert.equal((document.querySelector('.record-skill-dialog input') as any).value,'Cut a release');assert.match((document.querySelector('.record-skill-dialog textarea') as any).value,/## Goal/);

// C20, G31: the setup wizard walks mission, team, first task, launch; an interview opens the coordinator chat.
const project:any={id:'p',name:'OSSMANAGER',goal:'',folderIds:['f1'],primaryFolderId:'f1',archived:false,archivedAt:null};
let closed=0,done=0;const chats:string[]=[];
const wizard=(key:string)=><ProjectSetupWizard key={key} open project={project} snapshot={wsSnapshot} onClose={()=>{closed++;}} onOpenChat={id=>chats.push(id)} onDone={()=>{done++;}}/>;
await show(wizard('a'),100);
assert.match(text(),/Set up OSSMANAGER/);assert.match(text(),/What should this project achieve\?/);assert.equal(document.querySelectorAll('.setup-step').length,4);assert.equal(document.querySelector('.setup-steps [aria-current="step"]')!.textContent!.trim().endsWith('Mission'),true);
await setValue(document.querySelector('.setup-wizard textarea'),'Ship a calm 0.3.0.');await setValue(document.querySelector('.setup-wizard input[type="date"]'),'2026-12-31');
await submit(document.querySelector('.setup-wizard form'));
assert.deepEqual(last('project.update')!.input,{id:'p',goal:'Ship a calm 0.3.0.'});assert.deepEqual(last('work.project.meta.set')!.input,{projectId:'p',targetDate:'2026-12-31'});
assert.match(text(),/Chief of staff/);assert.match(text(),/Engineer/);assert.match(text(),/On the Roster: CTO/);
await click(button(/^Chief of staff$/),50);assert.equal((document.querySelector('.setup-wizard input[type="text"]') as any).value,'Chief of staff');assert.match((document.querySelectorAll('.setup-wizard textarea')[0] as any).value,/chief of staff for this project/);
await submit(document.querySelector('.setup-wizard form'));
const added=last('project.members.add')!.input;assert.equal(added.name,'Chief of staff');assert.equal(added.title,'Chief of staff');assert.match(added.instructions,/Ask the owner before anything costly/);assert.equal(added.runner,null);
assert.match(text(),/I have a task/);assert.match(text(),/Interview me/);
await setValue(document.querySelector('.setup-wizard input[type="text"]'),'Draft the plan');await setValue(document.querySelector('.setup-wizard select'),'member:m9');
await submit(document.querySelector('.setup-wizard form'));
const made=last('paperclip.task.create')!.input;assert.equal(made.title,'Draft the plan');assert.equal(made.projectId,'p');assert.equal(made.assigneeId,'member:m9');assert.ok(!('start' in made),'nothing starts unless asked');
assert.match(text(),/First task: OSS-9 · Draft the plan/);assert.match(text(),/Chief of staff/);assert.match(text(),/The mission is written/);
await click(button(/Open Tasks/),40);assert.equal(done,1);assert.ok(closed>=1);
// The interview path.
await show(wizard('b'),100);await click(button(/^Skip$/),50);await click(button(/^Skip$/),50);
await click(document.querySelector('[role="radio"][aria-checked="false"].setup-mode'),40);assert.match(text(),/coordinator chat with the first question/);
await submit(document.querySelector('.setup-wizard form'));assert.deepEqual(last('insight.setup.interview')!.input,{projectId:'p'});assert.deepEqual(chats,['coord-1']);
// A project with nothing in it is offered the wizard.
let started=0;await show(<SetupCard onStart={()=>{started++;}}/>,40);await click(button(/Set up project/),20);assert.equal(started,1);

// C3: shortcuts on a work screen: ? opens the cheatsheet, g i goes to the Inbox, c opens the new-task sheet, typing and the preference stop them.
await show(<WorkShortcutsHost/>,60);
store.closeSettings();await press('?',{shiftKey:true});assert.ok(!/Keyboard shortcuts/.test(text()),'on the chat screen plain keys do nothing');
hub.openHub('tasks');await delay(60);assert.equal(store.getState().screen,'hub');
await press('?',{shiftKey:true});assert.match(text(),/Keyboard shortcuts/);assert.match(text(),/Go to/);assert.match(text(),/Single-key shortcuts/);assert.match(text(),/Type a task key to jump to it/);
await press('Escape');await delay(40);assert.ok(!/Single-key shortcuts/.test(text()),'Escape closes the cheatsheet');
await press('g');await press('i');assert.equal(hub.hubRoute().page,'inbox');
await press('g');await press('r');assert.equal(hub.hubRoute().page,'roster');
await press('g');await press('l');assert.equal(hub.hubRoute().page,'ledger');
await press('c');await delay(150);assert.match(text(),/New task/);assert.ok(document.querySelector('.ws-new-task'),'c opens the new-task sheet');
await press('Escape');await delay(60);
const typing=document.createElement('input');document.body.appendChild(typing);await press('g',{target:typing});await press('i',{target:typing});Object.defineProperty(document,'activeElement',{configurable:true,get:()=>null});assert.equal(hub.hubRoute().page,'ledger','typing in a field never triggers a shortcut');
await press('g',{metaKey:true});await press('d');assert.notEqual(hub.hubRoute().page,'dashboard','a modified g does not arm the chord');
setShortcutsEnabled(false);await delay(40);await press('g');await press('i');assert.equal(hub.hubRoute().page,'ledger','turned off, nothing fires');
assert.equal(memory.get('muster.shortcuts'),'off');setShortcutsEnabled(true);await delay(40);
await press('g');await press('d');assert.equal(hub.hubRoute().page,'dashboard');

assert.deepEqual(errors,[]);
console.log('nav components ok');
process.exit(0);
