/** Orgs and Work locally in the UI (#117): the sidebar's org rows and accordion, My work, the owner picker, Settings › orgs, and the Work locally / Hand back controls.
 *  Bundled with esbuild and run with Node like the other *-components suites. Never pass DOM nodes to assert.equal: a failing one makes util.inspect walk the whole linkedom graph (that once grew past 100 GB). Assert on booleans and text. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const store=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'})});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

const iso=(d:number)=>new Date(Date.now()-d*3_600_000).toISOString();
const mk=(org:string,orgId:string,key:string,title:string,status:string,project:string,hours:number,over:object={})=>({id:`${orgId}-${key}`,key,title,status,priority:'medium',orgId,orgName:org,projectId:project.toLowerCase(),projectName:project,createdAt:iso(hours+1),updatedAt:iso(hours),why:'mine',assignee:null,checkout:null,...over});
const ragTasks=[
  mk('Ragnar','rag','RAG-2','External Valkey migration','in_progress','Redis',1,{checkout:{state:'checked_out',thisMac:true,device:'MacBook',since:iso(2),stale:false}}),
  mk('Ragnar','rag','RAG-9','Review: Sentinel auth contract','in_review','Redis',2),
  mk('Ragnar','rag','RAG-7','Cluster seed discovery','todo','Redis',3),
  mk('Ragnar','rag','RAG-11','Tune the pool','todo','PostgreSQL',4),mk('Ragnar','rag','RAG-12','Replication lag','blocked','PostgreSQL',5),
  mk('Ragnar','rag','RAG-13','Docs pass','todo','Website',6),mk('Ragnar','rag','RAG-14','Release notes','todo','Website',7),
];
const work={connected:true,me:{id:'u-me',name:'Dhairya'},fetchedAt:iso(0),orgs:[
  {org:{id:'rag',name:'Ragnar',prefix:'RAG',server:'aiteam.example.com'},sidebar:'mine',open:7,tasks:ragTasks,projects:[{id:'redis',name:'Redis',open:3},{id:'postgresql',name:'PostgreSQL',open:2},{id:'website',name:'Website',open:2},{id:'ui',name:'UI App',open:0}],inbox:[]},
  {org:{id:'hyb',name:'Hybrow',prefix:'HYB',server:'aiteam.example.com'},sidebar:'mine',open:1,tasks:[mk('Hybrow','hyb','HYB-2','Invite agents to the team','in_progress','Onboarding',5)],projects:[{id:'onboarding',name:'Onboarding',open:1},{id:'rez',name:'Rez',open:0}],inbox:[]},
]};
let lease:any=null,pending:any={rows:[],conflict:null};
let plan:any={task:{id:'t1',key:'RAG-1',title:'External Valkey migration',status:'todo',orgId:'rag',orgName:'Ragnar',projectId:'redis',projectName:'Redis',assignee:'You'},assignedToMe:true,willPost:{comment:'Checked out · working locally on MacBook · via Muster',status:'in_progress',reassign:false},device:'MacBook',binding:{orgId:'rag',projectId:'redis',projectName:'Redis',path:'/Users/me/redis',devBranch:'dev',boundAt:iso(1)},detectedFolder:null,devBranch:'dev',agents:[{id:'a-ceo',name:'Head Muster',adapter:'claude_local',model:'claude-opus-4',suggested:true,mapsTo:'Claude Code · Opus 4'}],providers:[{id:'omniroute',name:'OmniRoute',models:[{id:'gpt-x',name:'GPT X'}]}],otherMac:null,firstTime:false};
let preview:any={taskId:'t1',branch:'muster/RAG-1',testsRun:true,testsLine:'12 passed, 0 failed.',prUrl:null,summary:'RAG-1',decisions:[],reviewers:[{kind:'agent',id:'a-qa',name:'QA Lead',suggested:true},{kind:'user',id:'u-bob',name:'Bob Rivera',suggested:false}],policy:[],reviewedLocally:[],blocked:null};
const calls:{command:string;input:any}[]=[];
// A runaway guard: this suite is small, so it stops itself on a render or read loop instead of eating memory.
setInterval(()=>{if(process.memoryUsage().rss>1_500_000_000||calls.length>3000){console.error('orgs-dom: runaway guard tripped',calls.length,Math.round(process.memoryUsage().rss/1e6)+'MB');process.exit(3);}},500);
setTimeout(()=>{console.error('orgs-dom: timed out');process.exit(4);},90_000);
const listeners=new Set<(e:any)=>void>();
(window as any).muster={subscribe(l:(e:any)=>void){listeners.add(l);return()=>{listeners.delete(l);};},async invoke(command:string,input:any){calls.push({command,input});
  switch(command){
    case 'orgs.work':return work;
    case 'orgs.list':return {connected:true,server:'aiteam.example.com',me:{id:'u-me',name:'Dhairya'},orgs:[{id:'rag',name:'Ragnar',prefix:'RAG',server:'aiteam',projects:5,agents:17,enabled:true,sidebar:'mine',active:true},{id:'hyb',name:'Hybrow',prefix:'HYB',server:'aiteam',projects:2,agents:1,enabled:true,sidebar:'mine',active:false},{id:'hp',name:'Hybrow Projects',prefix:'HP',server:'aiteam',projects:1,agents:0,enabled:false,sidebar:'mine',active:false}]};
    case 'orgs.set':return {connected:true,server:'x',me:null,orgs:[]};
    case 'checkout.get':return {lease};
    case 'checkout.plan':return plan;
    case 'checkout.start':return {...(lease??{}),taskId:'t1',key:'RAG-1',state:'checked_out',chatId:'chat-1',modelLabel:'Head Muster → Claude Code · Opus 4',model:input.model,branch:'muster/RAG-1'};
    case 'checkout.handback.preview':return preview;
    case 'checkout.handback':return {state:'handed_back'};
    case 'checkout.undo':return {state:'checked_out'};
    case 'checkout.auto':return {mode:input.mode??'auto'};
    case 'checkout.pending':return pending;
    case 'checkout.org':return {copy:null};
    case 'checkout.bindings':return {bindings:[],orgs:[]};
    case 'checkout.settings':return {staleHours:8,deviceName:'MacBook'};
    // The local chat opens through the store's timeline read; this suite does not model a timeline, so it errors (a bare snapshot would be re-read by the store until it looks complete).
    case 'chat.timeline':throw new Error('no timeline in this suite');
    case 'folder.pick':return null;
    default:return undefined;
  }}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {OrgSidebar}=await import('../src/renderer/components/OrgSidebar');
const {MyWorkPage}=await import('../src/renderer/components/MyWorkPage');
const {OwnerPicker}=await import('../src/renderer/components/OwnerPicker');
const {OrgsCard}=await import('../src/renderer/components/OrgsCard');
const {WorkLocallyBar,CheckoutNotes,CheckoutProperties}=await import('../src/renderer/components/CheckoutPanel');
const {HandBackHost}=await import('../src/renderer/components/HandBackHost');
const {getState}=await import('../src/renderer/store');
const {ownerOptions,filterOwners,agentLabel,chipMentions,mentionMatches}=await import('../src/renderer/ownerOptions');
const {toggleOrg,togglePin}=await import('../src/renderer/orgStore');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=(sel:string)=>[...document.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const body=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(120);};
let shown=0;
// Each show remounts (a new key), so a component that reads through `invoke` reads the mock's current answer, as it would after the runtime's event.
const show=async(node:React.ReactNode)=>{root.render(<React.Fragment key={++shown}>{node}</React.Fragment>);await delay(250);};
const setValue=async(el:Element,value:string)=>{let proto=Object.getPrototypeOf(el),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(80);};
const byText=(sel:string,t:string)=>[...document.querySelectorAll(sel)].find(e=>e.textContent?.includes(t));

// the sidebar: one row per org with the person's own count; an accordion; five tasks, "See all mine"; project badges
await show(<OrgSidebar/>);
assert.deepEqual(text('.org-name'),['Ragnar','Hybrow'],'one row per ticked org');
assert.deepEqual(text('.org-toggle > .org-count'),['7','1'],'the person’s own open count');
assert.equal(document.querySelectorAll('.org-task').length,0,'collapsed by default');
await click(document.querySelector('.org-toggle'));
assert.equal(document.querySelectorAll('.org-task').length,5,'at most five of seven');
assert.deepEqual(text('.org-task .org-key').slice(0,3),['RAG-2','RAG-9','RAG-7'],'newest first');
assert.ok(body().includes('See all mine (7)'));
assert.deepEqual(text('.org-project .org-project-name'),['Redis','PostgreSQL','Website','UI App']);
assert.deepEqual(text('.org-project .org-count'),['3','2','2'],'a project’s badge is the person’s own open tasks; zero shows none');
assert.ok(document.querySelector('.org-task svg[aria-label="Checked out · this Mac"]'),'a checked-out task is marked');
// opening Hybrow closes Ragnar
await click([...document.querySelectorAll('.org-toggle')][1]);
assert.equal(document.querySelectorAll('.org-task').length,1); assert.deepEqual(text('.org-task .org-key'),['HYB-2']);
assert.equal(document.querySelectorAll('.org-toggle')[0]!.getAttribute('aria-expanded'),'false');
// pinned orgs stay open
await click(document.querySelector('.org-pin[aria-label="Pin Hybrow"]'));
await click(document.querySelector('.org-toggle'));
assert.equal(document.querySelectorAll('.org-task').length,6,'Hybrow is pinned, so opening Ragnar leaves it open');
assert.deepEqual(toggleOrg({open:['a'],pinned:[]},'b').open,['b']); assert.deepEqual(toggleOrg({open:['a'],pinned:['a']},'b').open.sort(),['a','b']); assert.deepEqual(togglePin({open:[],pinned:[]},'a'),{open:['a'],pinned:['a']});

// My work: grouped org → project, org and status filters, a board
await show(<MyWorkPage/>);
assert.deepEqual(text('.my-work .ws-section > .ws-group-title').map(t=>t.slice(1).replace(/\d+$/,'')),['Ragnar','Hybrow'],'org headings (an avatar letter, the name, the count)');
assert.deepEqual(text('.my-project-title'),['PostgreSQL','Redis','Website','Onboarding'],'grouped by project');
assert.ok(body().includes('Checked out · this Mac'));
assert.ok(!body().includes('Bob'),'no one else’s work');
await click(byText('.ws-filter','Hybrow')); assert.deepEqual(text('.my-project-title'),['Onboarding'],'org filter');
await click(byText('.ws-filter','All orgs')); await click(byText('.ws-filter','Blocked')); assert.deepEqual(text('.my-row .org-key'),['RAG-12'],'status filter');
await click(byText('.ws-filter','Active'));
await click(byText('.ws-filter','Board')); assert.deepEqual(text('.my-board-col .ws-group-title').map(t=>t.replace(/\d+$/,'')),['Todo','In Progress','In Review','Blocked']);

// the owner picker: No owner, Me pinned first, People alphabetical, Agents; type to filter; one name when the title repeats it
const opts=ownerOptions({agents:[{id:'a1',name:'UI/API Lead',title:'UI/API Lead',status:'idle'} as any,{id:'a2',name:'CTO',title:'Chief Technology Officer',status:'idle'} as any,{id:'a3',name:'Gone',title:null,status:'terminated'} as any],people:[{id:'u-zed',name:'Zed'},{id:'u-me',name:'Dhairya',me:true},{id:'u-ann',name:'Ann Lee'}],noneLabel:'No owner'});
assert.deepEqual(opts.map(o=>o.label),['No owner','Me','Ann Lee','Zed','CTO · Chief Technology Officer','UI/API Lead'],'terminated agents are left out; a repeated title is shown once');
assert.deepEqual(opts.map(o=>o.group),['none','me','people','people','agents','agents']);
assert.equal(agentLabel('Redis/Valkey CLI','Redis/Valkey CLI'),'Redis/Valkey CLI'); assert.equal(agentLabel('CTO','Chief'),'CTO · Chief');
assert.deepEqual(filterOwners(opts,'ann').map(o=>o.label),['Ann Lee']); assert.deepEqual(filterOwners(opts,'chief tech').map(o=>o.label),['CTO · Chief Technology Officer']);
let picked='';
await show(<OwnerPicker label="Owner" value="" options={opts} onChange={v=>{picked=v;}}/>);
await click(document.querySelector('.owner-trigger'));
assert.deepEqual(text('.owner-option > span'),['No owner','Me','Ann Lee','Zed','CTO · Chief Technology Officer','UI/API Lead']);
assert.deepEqual(text('.owner-group'),['People','Agents']);
await setValue(document.querySelector('.owner-filter')!,'zed');
assert.deepEqual(text('.owner-option > span'),['Zed'],'type to filter');
(document.querySelector('.owner-option') as any).dispatchEvent(new window.Event('mousedown',{bubbles:true,cancelable:true})); await delay(80);
assert.equal(picked,'user:u-zed','a person is assigned as user:<id>');

// @-mentions: people first when the query matches; the chip is the format Paperclip's composer writes
const m=[{id:'a-ann',name:'Ann Agent',kind:'agent' as const},{id:'u-ann',name:'Ann Lee',kind:'user' as const},{id:'a-cto',name:'CTO'}];
assert.deepEqual(mentionMatches(m,'an').map(x=>x.name),['Ann Lee','Ann Agent'],'people first');
assert.equal(chipMentions('Ping @Ann Lee and @CTO about it.',m),'Ping [@Ann Lee](user://u-ann) and [@CTO](agent://a-cto) about it.');
assert.equal(chipMentions('Mail ann@Ann Lee.example and [@CTO](agent://a-cto)',m),'Mail ann@Ann Lee.example and [@CTO](agent://a-cto)','already-chipped text and addresses are left alone');

// Settings: every org with a checkbox and a sidebar choice
await show(<OrgsCard/>);
assert.deepEqual(text('.ws-orgs-name > span:last-child').map(t=>t.replace(/\s+/g,' ')),['Ragnar · 5 projects · 17 agents','Hybrow · 2 projects · 1 agent','Hybrow Projects · 1 project · 0 agents']);
assert.deepEqual([...document.querySelectorAll<HTMLInputElement>('.ws-orgs-name input')].map(i=>i.checked),[true,true,false]);
assert.deepEqual([...document.querySelectorAll('.ws-orgs-row')][0]!.querySelectorAll('option').length,3,'My work, My team, Nothing');
assert.equal((document.querySelectorAll('.ws-orgs-row select')[2] as HTMLSelectElement).disabled,true,'an unticked org has nothing to choose');
calls.length=0;
{const box=document.querySelectorAll('.ws-orgs-name input')[2] as HTMLInputElement;box.checked=true;await click(box);}
assert.deepEqual(calls.find(c=>c.command==='orgs.set')?.input,{companyId:'hp',enabled:true});

// Work locally: one button; later clicks need no sheet; first use shows what will be posted
const detail=(over:object={})=>({task:{id:'t1',key:'RAG-1',title:'T',status:'todo',source:'paperclip',assigneeId:'user:u-me',...over}} as any);
await show(<WorkLocallyBar detail={detail()}/>);
assert.deepEqual(text('.ws-checkout button'),['Work locally']);
calls.length=0; await click(document.querySelector('.ws-checkout button'));
const start=calls.find(c=>c.command==='checkout.start');
assert.ok(start,'no sheet: bound folder, not the first check-out'); assert.deepEqual(start!.input,{taskId:'t1',take:false,model:{kind:'org-agent',agentId:'a-ceo'},confirm:true});
assert.ok(calls.some(c=>c.command==='chat.timeline'&&c.input.id==='chat-1'),'the local chat opens');
// M1: a task that is someone else's is never one click: the sheet asks "Take it from <X>?" even when the folder and engine are known
plan={...plan,assignedToMe:false,task:{...plan.task,assignee:'Bob Rivera'},willPost:{...plan.willPost,reassign:true}};
calls.length=0; await show(<WorkLocallyBar detail={detail()}/>); await click(document.querySelector('.ws-checkout button'));await delay(150);
assert.ok(document.querySelector('.ws-work-locally'),'the sheet opens'); assert.ok(!calls.some(c=>c.command==='checkout.start'),'nothing was started by the click');
assert.ok(body().includes('Take it from Bob Rivera?'),'it asks'); assert.ok(text('.ws-work-locally button').some(t=>t==='Take it from Bob Rivera and work locally'),'and the button says what it does');
await click(byText('.ws-work-locally button','Cancel')); assert.ok(!document.querySelector('.ws-work-locally'));
plan={...plan,assignedToMe:true,task:{...plan.task,assignee:'You'},willPost:{...plan.willPost,reassign:false}};
plan={...plan,binding:null,detectedFolder:'/Users/me/redis',firstTime:true};
await click(document.querySelector('.ws-checkout button')); await delay(150);
assert.ok(document.querySelector('.ws-work-locally'),'the first use asks once');
assert.ok(body().includes('Post as you: “Checked out · working locally on MacBook · via Muster”'),'shows what will be posted');
assert.ok(body().includes('/Users/me/redis')&&body().includes('Found from the project’s repository.'),'the folder is found, not asked');
assert.deepEqual(text('.ws-checkout-engines strong'),['Org agents','My subscriptions']);
assert.ok(!/Paperclip/.test(document.querySelector('.ws-work-locally')!.textContent!),'plain words');
calls.length=0; await click(byText('.ws-work-locally button','Work locally') as any);
assert.deepEqual(calls.find(c=>c.command==='checkout.start')?.input.model,{kind:'org-agent',agentId:'a-ceo'});
assert.equal(calls.find(c=>c.command==='checkout.start')?.input.folder,'/Users/me/redis');
plan={...plan,binding:{orgId:'rag',projectId:'redis',projectName:'Redis',path:'/x',devBranch:'dev',boundAt:iso(1)},detectedFolder:null,firstTime:false};

// While working: "Working locally · <engine>" and nothing else on the surface. Hand-back is automatic; the properties hold the fallback and the Auto / Ask me choice
lease={taskId:'t1',orgId:'rag',key:'RAG-1',state:'checked_out',model:{kind:'org-agent',agentId:'a-ceo'},modelLabel:'Head Muster → Claude Code · Opus 4',branch:'muster/RAG-1',worktree:'/wt/x',device:'MacBook',chatId:'chat-1',pending:0,offline:null,stale:false,staleHours:8,conflict:null,thisMac:true,since:iso(1),lastActivityAt:iso(0),reviewLocally:false,reviewChats:[]};
await show(<><WorkLocallyBar detail={detail()}/><CheckoutNotes detail={detail()}/></>);
assert.deepEqual(text('.ws-checkout button'),['Working locally · Org agents'],'no Hand back button: people forget, so it is automatic');
assert.ok(!document.querySelector('.ws-checkout-notes'),'no extra chrome when nothing is waiting');
calls.length=0;
await show(<CheckoutProperties detail={detail()}/>); await delay(200);
assert.deepEqual(text('.ws-prop dt').slice(0,6),['Engine','Work offline','Hand back','Branch','Worktree','On this Mac'],'engine and the offline switch live in the properties');
assert.deepEqual([...document.querySelectorAll('select[aria-label="Hand back"] option')].map(o=>o.textContent),['Automatic','Ask me']);
assert.equal((document.querySelector('select[aria-label="Hand back"]') as HTMLSelectElement).value,'auto','Automatic is the default');
{const sel=document.querySelector('select[aria-label="Hand back"]') as HTMLSelectElement;for(const o of [...sel.options])o.selected=o.value==='ask';Object.defineProperty(sel,'value',{configurable:true,get:()=>'ask'});sel.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(100);}
assert.deepEqual(calls.find(c=>c.command==='checkout.auto'&&c.input.mode)?.input,{taskId:'t1',mode:'ask'},'per project, from the properties');
preview={...preview,testsRun:false,blocked:'Run the tests, or write why they were not run.',testsLine:'No test command ran yet.'};
await click(byText('.ws-link','Hand back now'));
assert.ok(document.querySelector('.ws-hand-back')); assert.equal((document.querySelector('.ws-hand-back select') as HTMLSelectElement).value,'agent:a-qa','the recipient is pre-filled');
assert.ok(body().includes('Run the tests, or write why they were not run.'));
const confirmBtn=()=>[...document.querySelectorAll<HTMLButtonElement>('.ws-hand-back .project-edit-actions button')].find(b=>b.textContent==='Hand back')!;
assert.equal(confirmBtn().disabled,true,'blocked until a reason is written');
await setValue(byText('.ws-hand-back label','Why were the tests not run?')!.querySelector('input')!,'Docs only');
assert.equal(confirmBtn().disabled,false);
calls.length=0; await click(confirmBtn());
assert.deepEqual(calls.find(c=>c.command==='checkout.handback')?.input,{taskId:'t1',reviewer:{kind:'agent',id:'a-qa'},testsNote:'Docs only'});

// the toast: Handed back to <X> · Undo (about two minutes), and "Ask me" offers it
await show(<HandBackHost/>);
for(const l of [...listeners])l({type:'handedBack',taskId:'t1',key:'RAG-1',to:'QA Lead',undoUntil:iso(-0.03)});
await delay(100);
const undoNotice=getState().notices.find(n=>n.message==='Handed back RAG-1 to QA Lead');
assert.ok(undoNotice,'a toast says where it went'); assert.equal(undoNotice!.action?.label,'Undo'); assert.equal(undoNotice!.lifetimeMs,120_000,'Undo is available for about two minutes');
calls.length=0; undoNotice!.action!.run(); await delay(100);
assert.deepEqual(calls.find(c=>c.command==='checkout.undo')?.input,{taskId:'t1'});
for(const l of [...listeners])l({type:'handBackReady',taskId:'t2',key:'RAG-2',to:'Bob Rivera',recipient:{kind:'user',id:'u-bob'},reason:'the pull request is open'});
await delay(100);
const ask=getState().notices.find(n=>n.message.startsWith('RAG-2 looks finished'));
assert.ok(ask&&ask.action?.label==='Hand back'); calls.length=0; ask!.action!.run(); await delay(100);
assert.deepEqual(calls.find(c=>c.command==='checkout.handback')?.input,{taskId:'t2',reviewer:{kind:'user',id:'u-bob'}},'the recipient comes with the offer: one click');
// offline and conflicts show only when relevant
lease={...lease,pending:3,offline:'auto'};
await show(<CheckoutNotes detail={detail()}/>);
assert.ok(body().includes('Offline · 3 updates waiting'));
lease={...lease,pending:2,offline:null,conflict:{at:iso(0),changes:['It is now assigned to Bob.','It was marked Done.'],status:'done',assignee:'Bob'}};
pending={rows:[{id:7,type:'comment',kind:'decision',summary:'Decision',body:'**Decision**\n\nKeep the list.',at:iso(0),editable:true}],conflict:lease.conflict};
await show(<CheckoutNotes detail={detail()}/>);
assert.ok(body().includes('This task changed on the server while you were offline.')&&body().includes('assigned to Bob'));
assert.deepEqual(text('.ws-checkout-conflict button'),['Send anyway','Edit first','Discard'],'send anyway, edit, or discard');
await show(<WorkLocallyBar detail={detail({status:'done'})}/>);
assert.ok(text('.ws-checkout button')[0]?.startsWith('Working locally'),'while still checked out the control stays, even on a done task');
lease=null; await show(<WorkLocallyBar detail={detail({status:'done'})}/>); assert.ok(!document.querySelector('.ws-checkout'),'a done task cannot be checked out');
await show(<WorkLocallyBar detail={detail({source:'local'})}/>); assert.ok(!document.querySelector('.ws-checkout'),'only server tasks');
assert.deepEqual(errors,[],'no render errors');
console.log('orgs-dom ok');
process.exit(0);
