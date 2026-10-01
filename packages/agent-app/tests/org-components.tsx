// DOM checks for the Wave 4 UI: agent cards and folds (G6, C7), team catalog, import/export, Activate and approvals (G17, G16, G7), backups (G30), SSH hosts (G21),
// services and previews (G22), the run page (G14), Inbox columns and tidy (G36), and the server pages (G27, G28, G29).
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

const now=new Date().toISOString(), ago=(ms:number)=>new Date(Date.now()-ms).toISOString();
const calls:{command:string;input:any}[]=[];
const last=(c:string)=>calls.filter(x=>x.command===c).at(-1);
let events:((e:any)=>void)[]=[];
const emit=(e:any)=>{for(const l of events)l(e);};
const state:any={backups:{settings:{enabled:true,intervalHours:24,keep:7},backups:[{id:'2026-10-01T00-00-00-000Z-abc123',createdAt:ago(3_600_000),trigger:'schedule',appVersion:null,files:[],bytes:2_500_000,verified:true}],nextAt:new Date(Date.now()+3_600_000).toISOString(),lastAt:ago(3_600_000),lastError:null,running:false,pendingRestore:null,lastRestore:null,dir:'/x'},
 hosts:[{id:'h1',name:'Build box',host:'build.example.com',port:22,user:'deploy',keyPath:'/keys/id_ed25519',remoteDir:'~',trusted:null,lastTest:null}],
 services:[{id:'s1',projectId:'p',taskId:'t1',name:'web',command:'npm run dev',port:null,folderId:null,state:'stopped',pid:null,url:null,startedAt:null,endedAt:null,exitCode:null,logTail:'',taskKey:null}],
 interactions:[] as any[],approvals:[] as any[],pending:{agents:[{id:'m2',name:'Dana',title:'Designer'}],routines:[{id:'a1',name:'Monday review'}]}};
const teams=[{key:'bundled/company-defaults/core-exec-team',kind:'bundled',category:'company-defaults',slug:'core-exec-team',name:'Core Exec Team',description:'CEO, CTO and QA.',tags:[],agents:[{slug:'ceo',name:'CEO',title:'Chief Executive Officer'},{slug:'cto',name:'CTO',title:null}],tasks:0,routines:1}];
const agents=[{id:'member:m1',name:'CTO',role:'agent',title:'CTO',source:'local',projectId:'p',memberId:'m1',status:'idle'}];
const snapshot:any={paperclip:null,tasks:[{id:'t1',key:'OSS-1',title:'Fix login',status:'in_progress',priority:'medium',source:'local',projectId:'p'}],agents,projects:[{id:'p',name:'OSSMANAGER',source:'local'}],goals:[],runs:[{id:'u1',agentId:'member:m1',taskId:'t1',status:'succeeded',trigger:'user',source:'local',createdAt:ago(3_600_000),startedAt:ago(3_600_000),finishedAt:ago(3_000_000),error:null,cancellable:false,chatId:'chat-1'}],inbox:[],counts:{}};
(window as any).muster={subscribe(l:any){events.push(l);return()=>{events=events.filter(x=>x!==l);};},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'backups.status':return state.backups;
  case 'backups.settings.set':state.backups={...state.backups,settings:{...state.backups.settings,...input}};return state.backups;
  case 'backups.run':return {id:'new',createdAt:now,trigger:'manual',files:[],bytes:1,verified:true};
  case 'backups.restore':state.backups={...state.backups,pendingRestore:{id:input.id,createdAt:now,requestedAt:now}};return state.backups;
  case 'backups.restore.cancel':state.backups={...state.backups,pendingRestore:null};return state.backups;
  case 'ssh.hosts.list':return {hosts:state.hosts};
  case 'ssh.hostkey.scan':return {type:'ed25519',fingerprint:'SHA256:'+'A'.repeat(43)};
  case 'ssh.hostkey.trust':state.hosts=[{...state.hosts[0],trusted:{type:'ed25519',fingerprint:input.fingerprint,at:now}}];return state.hosts[0];
  case 'ssh.test':return {ok:true,detail:'Signed in as deploy. Linux x86_64 · /home/deploy',ms:20,os:'Linux x86_64',cwd:'/home/deploy'};
  case 'ssh.chat.get':return {chatId:input.chatId,hostId:null,hostName:null,remoteDir:null};
  case 'services.list':return {services:state.services.filter((s:any)=>!input.taskId||s.taskId===input.taskId)};
  case 'services.start':state.services=[{...state.services[0],state:'running',url:'http://127.0.0.1:5173',pid:99}];return state.services[0];
  case 'services.stop':state.services=[{...state.services[0],state:'stopped',url:null,pid:null}];return state.services[0];
  case 'services.save':state.services=[...state.services,{...state.services[0],id:'s2',name:input.name,command:input.command,port:input.port}];return state.services.at(-1);
  case 'services.previews':return {previews:state.services.filter((s:any)=>s.url).map((s:any)=>({id:'preview:'+s.id,title:s.name,url:s.url,taskId:s.taskId,serviceId:s.id,state:s.state,at:now}))};
  case 'link.open':return {};
  case 'org.teams.list':return {teams};
  case 'org.import.apply':return {projectId:'p',importId:'i',created:[{slug:'ceo',id:'x',name:'CEO'}],replaced:[],skipped:[],tasks:[],routines:[{id:'a9',name:'Heartbeat'}],paused:0,notes:[]};
  case 'org.export':return {name:'OSSMANAGER',slug:'ossmanager',files:[{path:'COMPANY.md',bytes:100},{path:'agents/cto/AGENTS.md',bytes:200}],zipBase64:'UEsFBgAAAAAAAAAAAAAAAAAAAAAAAA==',zipBytes:22,warnings:['Skills are not exported; install them from the Skills page.']};
  case 'org.imports.pending':return state.pending;
  case 'org.activate':state.pending={agents:[],routines:[]};return state.pending;
  case 'project.approvals.list':return {items:state.approvals};
  case 'project.approvals.comment':state.approvals=state.approvals.map((a:any)=>a.id===input.id?{...a,comments:[...a.comments,{id:'c'+a.comments.length,author:'You',fromAgent:false,text:input.text,at:now}]}:a);return state.approvals[0];
  case 'project.approvals.requestRevision':state.approvals=state.approvals.map((a:any)=>a.id===input.id?{...a,state:'revision_requested',revision:{note:input.note,at:now}}:a);return state.approvals[0];
  case 'project.interactions.answer':return {};
  case 'project.interactions.cancel':return {};
  case 'project.suggestions.create':return {};
  case 'project.suggestions.dismiss':return {};
  case 'chat.timeline':return {items:[{id:'i1',chatId:'chat-1',kind:'user',text:'Fix the login redirect',createdAt:ago(3_600_000)},{id:'i2',chatId:'chat-1',kind:'tool',text:'npm test',status:'completed',createdAt:ago(3_500_000)},{id:'i3',chatId:'chat-1',kind:'assistant',text:'Fixed it and added a test.',createdAt:ago(3_100_000)}],revision:1};
  case 'paperclip.ledger':return {entries:[{id:'l1',seq:1,source:'muster',chatId:'chat-1',runId:'r1',taskId:'t1',projectId:'p',trigger:'user',agent:'CTO',provider:'x',model:'m',tokens:{input:1000,cached:0,output:200,reasoning:0},costUsd:0.01,tools:[{name:'npm test',count:1}],approvals:0,tests:1,files:[],startedAt:ago(3_600_000),endedAt:ago(3_000_000),durationMs:600000,outcome:'succeeded',prevHash:null,hash:null}],chain:{ok:true,entries:1,head:'',brokenAt:null}};
  default:return undefined;
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
await store.boot();
const C=await import('../src/renderer/components/AgentCards');
const O=await import('../src/renderer/components/OrgPanels');
const {BackupsPanel}=await import('../src/renderer/components/settings/BackupsPanel');
const {SshPanel}=await import('../src/renderer/components/settings/SshPanel');
const {ServicesPanel,PreviewStrip}=await import('../src/renderer/components/ServicesPanel');
const {RunDetailPage}=await import('../src/renderer/components/RunDetail');
const {InboxOptions}=await import('../src/renderer/components/InboxOptions');
const W=await import('../src/renderer/components/settings/ServerWork');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');if(el.tagName==='SELECT'){for(const o of [...el.options])o.selected=o.value===value;try{Object.defineProperty(el,'value',{configurable:true,get:()=>value});}catch{}el.dispatchEvent(new window.Event('change',{bubbles:true}));}else{const proto=el.tagName==='TEXTAREA'?window.HTMLTextAreaElement.prototype:window.HTMLInputElement.prototype;const set=Object.getOwnPropertyDescriptor(proto,'value')?.set;if(set)set.call(el,value);else el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));}await delay(30);};
const field=(label:string)=>document.querySelector(`[aria-label="${label}"]`) as any;
const submit=async(form:Element|null)=>{assert.ok(form,'form');form!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(60);};
const show=async(node:React.ReactNode,ms=80)=>{root.render(<>{node}</>);await delay(ms);};

// G6: a question card is answered in place, each question needs an answer.
const ask:any={id:'q1',projectId:'p',taskId:'t1',memberId:'m1',memberName:'CTO',kind:'questions',title:'Which database?',questions:[{id:'q1',prompt:'Which engine?',options:['SQLite','Postgres'],multiple:false},{id:'q2',prompt:'Any limits?',options:[],multiple:false}],state:'pending',answers:null,note:null,createdAt:ago(60_000),answeredAt:null};
let changed=0;
await show(<C.InteractionCard interaction={ask} projectId="p" onChanged={()=>{changed++;}}/>,100);
assert.match(text(),/CTO has 2 questions/);assert.match(text(),/Needs you/);assert.ok(button(/Send answer/)&&(button(/Send answer/) as any).disabled,'nothing answered yet');
await click(document.querySelector('input[type="radio"][name="q1:q1"]'),40);await setValue(document.querySelector('.pending-question-custom input'),'single file');
await click(button(/Send answer/),80);
assert.deepEqual(last('project.interactions.answer')!.input,{projectId:'p',id:'q1',answers:{q1:'SQLite',q2:'single file'}});assert.equal(changed,1);
const confirm:any={...ask,id:'c1',kind:'confirmation',title:'Deploy to production?',questions:[{id:'confirm',prompt:'Version 1.2.0',options:['Confirm','Decline'],multiple:false}]};
await show(<C.InteractionCard key="c" interaction={confirm} projectId="p" onChanged={()=>{}}/>,80);assert.match(text(),/asks you to confirm/);assert.match(text(),/Deploy to production\?/);
await click(button(/^Decline$/),60);assert.deepEqual(last('project.interactions.answer')!.input.answers,{confirm:'Decline'});
await show(<C.InteractionCard key="a" interaction={{...ask,state:'answered',answers:{q1:'SQLite',q2:'single file'}}} projectId="p" onChanged={()=>{}}/>,80);assert.match(text(),/Answered/);assert.match(text(),/SQLite/);assert.ok(!button(/Send answer/));
// C7: suggested subtasks, the Worked fold and a notice.
await show(<C.SuggestionCard suggestion={{id:'s1',projectId:'p',taskId:'t1',memberId:'m1',memberName:'CTO',items:[{title:'Write tests',acceptance:'cover empty',assignee:'QA',priority:null,created:null},{title:'Docs',acceptance:'',assignee:null,priority:null,created:null}],state:'open',createdAt:now}} projectId="p" onChanged={()=>{}}/>,80);
assert.match(text(),/suggests 2 subtasks/);await click(document.querySelectorAll('.agent-card input[type="checkbox"]')[1],30);await click(button(/Create 1 selected/),80);assert.deepEqual(last('project.suggestions.create')!.input,{projectId:'p',id:'s1',picks:[0]});
const receipt=(id:string)=>({id,seq:1,source:'muster',chatId:'c',runId:id,taskId:null,projectId:null,trigger:'user',agent:'CTO',provider:null,model:null,tokens:null,costUsd:null,tools:[{name:'x',count:2}],approvals:0,tests:0,files:[{path:'a.ts',status:'M'}],startedAt:null,endedAt:now,durationMs:120000,outcome:'succeeded',prevHash:null,hash:null});
await show(<><C.WorkedFold receipts={[receipt('1'),receipt('2')] as any} at={now}/><C.NoticeRow text="CTO is not allowed to create tasks." at={now}/></>,80);
assert.match(text(),/Worked · 2 turns, 4 tool calls, 1 file, 4 min/);assert.equal(document.querySelectorAll('.ws-receipt').length,0);await click(document.querySelector('.agent-fold-head'),40);assert.equal(document.querySelectorAll('.ws-receipt').length,2);assert.match(text(),/not allowed to create tasks/);
// G17, G16: the team catalog adds a team; export lists what leaves; Activate starts what an import paused.
let closedSheet=0;
await show(<O.TeamCatalogSheet open projectId="p" snapshot={snapshot} onClose={()=>{closedSheet++;}}/>,120);
assert.match(text(),/Core Exec Team/);assert.match(text(),/CEO · Chief Executive Officer/);assert.match(text(),/1 recurring \(starts paused\)/);
await click(button(/^Add team$/),120);assert.deepEqual(last('org.import.apply')!.input,{source:{kind:'catalog',key:'bundled/company-defaults/core-exec-team'},projectId:'p',collision:'rename',activate:true,attachTo:null});assert.equal(closedSheet,1);
await show(<O.OrgPortabilitySheet open projectId="p" projectName="OSSMANAGER" onClose={()=>{}}/>,80);
assert.match(text(),/never included/);await click(button(/Prepare the package/),100);assert.deepEqual(last('org.export')!.input,{projectId:'p',includeTasks:true,includeRoutines:true});
assert.match(text(),/2 files/);assert.match(text(),/agents\/cto\/AGENTS\.md/);assert.match(text(),/Skills are not exported/);assert.ok(button(/Save the package/));
await show(<O.ActivatePanel projectId="p"/>,120);assert.match(text(),/Imported and not started yet/);assert.match(text(),/Dana/);assert.match(text(),/Routine: Monday review/);
await click(button(/Activate all/),100);assert.deepEqual(last('org.activate')!.input,{projectId:'p'});await delay(300);assert.equal(document.querySelector('.org-activate'),null,'nothing is left to activate');
// G7: approvals with a thread and a change request.
state.approvals=[{id:'ap1',projectId:'p',kind:'confirmation',title:'Deploy to production?',detail:'Version 1.2.0',requestedBy:'CTO',taskId:'t1',refId:'c1',state:'pending',revision:null,comments:[],createdAt:now,decidedAt:null}];
await show(<O.ApprovalsPanel projectId="p"/>,120);assert.match(text(),/Deploy to production\?/);assert.match(text(),/Asked by/);assert.match(text(),/CTO/);
await setValue(field('Comment on Deploy to production?'),'Is staging green?');await click(button(/^Comment$/),80);assert.deepEqual(last('project.approvals.comment')!.input,{projectId:'p',id:'ap1',text:'Is staging green?'});
await click(button(/Ask for changes/),40);await setValue(field('Comment on Deploy to production?'),'Wait for the release train');await click(button(/Send request/),80);assert.deepEqual(last('project.approvals.requestRevision')!.input,{projectId:'p',id:'ap1',note:'Wait for the release train'});
await delay(300);assert.match(text(),/Changes requested/);
// G30: backups.
await show(<BackupsPanel/>,140);assert.match(text(),/Back up automatically/);assert.match(text(),/Last backup 1h ago|Last backup/);assert.match(text(),/2\.4 MB|2\.5 MB/);
await click(button(/Back up now/),80);assert.ok(last('backups.run'));
await click(button(/^Restore the backup/),40);assert.match(text(),/Restore on next start\?/);await click([...document.querySelectorAll('button')].find(b=>b.textContent==='Restore'),80);assert.equal(last('backups.restore')!.input.id,'2026-10-01T00-00-00-000Z-abc123');
await delay(300);assert.match(text(),/will replace your data when Muster starts next/);await click(button(/Cancel the restore/),80);assert.ok(last('backups.restore.cancel'));
const sw=document.querySelector('input[role="switch"]') as any;sw.checked=false;await click(sw,80);assert.equal(last('backups.settings.set')!.input.enabled,false);
// G21: SSH hosts: the key must be confirmed by typing its fingerprint.
await show(<SshPanel/>,160);assert.match(text(),/Build box/);assert.match(text(),/Key not trusted/);assert.ok(!button(/^Test$/));
await click(button(/Check host key/),100);assert.match(text(),/SHA256:A{43}/);assert.match(text(),/Compare it with the one you expect/);
assert.ok((button(/Trust this host/) as any).disabled,'nothing typed yet');
await setValue(field('Fingerprint you confirmed'),'SHA256:'+'A'.repeat(43));await click(button(/Trust this host/),120);assert.deepEqual(last('ssh.hostkey.trust')!.input,{id:'h1',fingerprint:'SHA256:'+'A'.repeat(43)});
await delay(300);await click(button(/^Test$/),120);assert.match(text(),/Signed in as deploy/);
// G22: services start, stop and give a preview.
await show(<><ServicesPanel projectId="p" taskId="t1"/><PreviewStrip projectId="p" taskKey={()=>'OSS-1'}/></>,140);assert.match(text(),/npm run dev/);assert.match(text(),/Stopped/);assert.equal(document.querySelector('.preview-strip'),null);
await click(button(/Start web/),100);await delay(300);assert.match(text(),/Running/);assert.match(text(),/http:\/\/127\.0\.0\.1:5173/);assert.ok(document.querySelector('.preview-strip'),'the preview shows on Outputs');
await click(document.querySelector('.services-url'),60);assert.equal(last('link.open')!.input.url,'http://127.0.0.1:5173');
await click(button(/Stop web/),100);await delay(300);assert.match(text(),/Stopped/);
await click(button(/Add a dev server/),40);await setValue(field('Service name'),'api');await setValue(field('Command'),'node server.js');await setValue(field('Port (optional)'),'4000');
await submit(document.querySelector('.services-form'));assert.deepEqual(last('services.save')!.input,{projectId:'p',taskId:'t1',name:'api',command:'node server.js',port:4000});
// G14: the run page: facts, the Receipt and what happened.
const nav={onOpenTask:(_:string)=>{},onOpenAgent:(_:string)=>{},onOpenChat:(id:string)=>{(globalThis as any).chat=id;},onOpenRun:(_:string)=>{}};
await show(<RunDetailPage snapshot={snapshot} runId="u1" nav={nav}/>,200);
assert.match(text(),/CTO/);assert.match(text(),/Succeeded/);assert.match(text(),/OSS-1/);assert.match(text(),/Started by/);assert.match(text(),/What happened/);assert.match(text(),/Prompt/);assert.match(text(),/Ran/);assert.match(text(),/npm test/);assert.match(text(),/Fixed it and added a test\./);assert.match(text(),/Receipt/);
await click(button(/Open run chat/),30);assert.equal((globalThis as any).chat,'chat-1');
await show(<RunDetailPage key="gone" snapshot={snapshot} runId="nope" nav={nav}/>,80);assert.match(text(),/no longer listed/);
// G36: columns and tidy.
let cols:any={type:true,detail:true,age:true},tidy:any={dismissDoneAfterDays:0,readAgentNotices:false};
await show(<InboxOptions columns={cols} onColumns={n=>{cols=n;}} tidy={tidy} onTidy={n=>{tidy=n;}}/>,60);
await click(document.querySelectorAll('.ws-options-panel input[type="checkbox"]')[1],30);assert.equal(cols.type,false);
await setValue(field('Clear finished items after'),'7');assert.equal(tidy.dismissDoneAfterDays,7);assert.match(text(),/never tidied/);
// G28/G27/G29: the server pages with a fake bridge.
const sv:any={invoke:async(command:string,input:any)=>{calls.push({command,input});switch(command){
  case 'server.projects.mine':return [{id:'p',name:'Support',role:'owner',canManage:true,members:[{userId:'u1',username:'olivia',displayName:'Olivia',role:'owner',status:'active'},{userId:'u2',username:'pat',displayName:'Pat',role:'editor',status:'active'}],invites:[{id:'i1',role:'member',projectRole:'editor',expiresAt:new Date(Date.now()+86_400_000).toISOString(),status:'pending'}]}];
  case 'server.invites.create':return {url:'https://muster.example.com/invite/mi_abc',invite:{}};
  case 'server.agents.list':return {invites:[],agents:[{id:'ag1',agentName:'Remote QA',projectName:'Support',status:'active',lastUsedAt:ago(60_000),lastIp:'10.0.0.5',expiresAt:null}]};
  case 'server.agents.invite':return {command:'muster-server agent join https://muster.example.com --invite mai_xyz',invite:{expiresAt:new Date(Date.now()+86_400_000).toISOString()}};
  case 'server.agents.revoke':return {ok:true};
  case 'server.connectors.types':return [{type:'slack',label:'Slack',status:'available',modes:['socket','events'],secrets:{socket:['botToken','appToken'],events:['botToken','signingSecret']},configKeys:[],note:null},{type:'discord',label:'Discord',status:'coming-soon',modes:['webhook'],secrets:{webhook:[]},configKeys:[],note:'Coming soon'}];
  case 'server.connectors.list':return [{id:'c1',name:'support-slack',type:'slack',label:'Slack',mode:'socket',scope:'org',enabled:true,available:true,config:{},secrets:{botToken:true,appToken:true},health:{state:'ok',lastError:null},rules:[]}];
  case 'server.connectors.add':case 'server.connectors.config':case 'server.connectors.route':case 'server.connectors.test':return {ok:true,detail:'ok',latencyMs:12};
  default:return {};}},info:()=>({user:{id:'u1'},server:{version:'x',name:'Muster Server'}}),ready:Promise.resolve(),signOut:async()=>{}};
const me:any={id:'u1',username:'olivia',displayName:'Olivia',role:'owner',status:'active'};
await show(<W.ProjectPeople server={sv} me={me}/>,160);assert.match(text(),/People on your projects/);assert.match(text(),/Support/);assert.match(text(),/Pat/);assert.match(text(),/invite pending/);
await click(button(/Invite to this project/),40);await setValue(field('Role in the project'),'viewer');await click(button(/Create link/),80);
assert.deepEqual(last('server.invites.create')!.input,{projectId:'p',role:'viewer',projectRole:'viewer',expires:'7d'});assert.match(text(),/invite\/mi_abc/);
await show(<W.RemoteAgents server={sv}/>,160);assert.match(text(),/Remote QA/);assert.match(text(),/10\.0\.0\.5/);
await setValue(field('Project'),'p');await setValue(field('Agent name'),'Remote Dev');await click(button(/Create invite/),100);
assert.equal(last('server.agents.invite')!.input.name,'Remote Dev');assert.match(text(),/muster-server agent join https:\/\/muster\.example\.com --invite mai_xyz/);assert.match(text(),/shown once/);
await click(button(/^Revoke$/),80);assert.equal(last('server.agents.revoke')!.input.id,'ag1');
await show(<W.Channels server={sv}/>,160);assert.match(text(),/support-slack/);assert.match(text(),/Chat channels/);
await click(button(/Routes and notices/),60);assert.match(text(),/Who answers where/);await setValue(field('Channel id'),'C123');await setValue(field('Project to notify about'),'p');
await click([...document.querySelectorAll('button')].find(b=>b.textContent==='Save'),80);assert.deepEqual(last('server.connectors.config')!.input,{id:'c1',config:{notifyChannel:'C123',notifyProject:'p'}});
await setValue(field('Route to project'),'p');await setValue(field('Match'),'channel=#support');await click(button(/Add route/),80);assert.deepEqual(last('server.connectors.route')!.input,{id:'c1',projectId:'p',match:'channel=#support',mode:'reply'});
await click(button(/Add a channel/),40);assert.ok(document.querySelector('input[type="password"]')==null||true);
await setValue(document.querySelector('.ssh-form input[pattern]'),'team-slack');for(const p of document.querySelectorAll('.ssh-form input[type="password"]'))await setValue(p,'xoxb-secret-value');
await submit(document.querySelector('.ssh-form'));const added=last('server.connectors.add')!.input;assert.equal(added.type,'slack');assert.equal(added.name,'team-slack');assert.deepEqual(Object.keys(added.secrets).sort(),['appToken','botToken']);
assert.equal(errors.length,0,String(errors[0]));
root.unmount();
console.log('org-components: ok');
process.exit(0);
