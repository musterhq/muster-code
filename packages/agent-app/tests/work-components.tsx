// DOM checks for the Wave 2 work-layer UI: pull requests, votes, documents (edit, history, comments), status cards, goals,
// labels, feedback, project status, the paused banner, Outputs, Inbox extras, the Gantt, the Roster tabs and the Automations parts.
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),URL:Object.assign(URL,{createObjectURL:()=>'blob:x',revokeObjectURL(){}})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
(window as any).open=()=>null;

const now=new Date().toISOString(), ago=(ms:number)=>new Date(Date.now()-ms).toISOString();
const calls:{command:string;input:any}[]=[];
const last=(command:string)=>calls.filter(c=>c.command===command).at(-1);
let links:any[]=[{id:'L1',projectId:'p',taskId:'t1',kind:'pull_request',url:'https://github.com/acme/widgets/pull/12',repo:'acme/widgets',number:12,title:'Fix login',state:'open',draft:false,checks:'failing',checksSummary:'2 passed · 1 failed',source:'manual',fetchedAt:now,error:null,createdAt:now},
  {id:'L2',projectId:'p',taskId:'t1',kind:'pull_request',url:'https://github.com/acme/widgets/pull/13',repo:'acme/widgets',number:13,title:'',state:'unknown',draft:false,checks:'none',checksSummary:'',source:'detected',fetchedAt:now,error:'Not found on GitHub, or this account can’t see it.',createdAt:now}];
let votes:any[]=[];
let doc:any={taskId:'t1',key:'design',rev:2,text:'The API has two endpoints: list and create.\n',updatedAt:now,
  revisions:[{rev:2,note:'second draft',actor:'CTO',createdAt:now,chars:44},{rev:1,note:'first',actor:'You',createdAt:ago(3600_000),chars:30}],
  threads:[{id:'th1',rev:2,quote:'two endpoints',start:12,end:25,status:'open',createdAt:now,current:true,comments:[{id:'c1',author:'You',kind:'user',body:'Why not three?',createdAt:now}]}]};
let cards:any[]=[{id:'s1',projectId:'p',title:'Project summary',query:'',refresh:'daily',tokenCap:600,enabled:true,state:'idle',error:null,lastRunAt:now,nextRunAt:new Date(Date.now()+86_400_000).toISOString(),rev:2,text:'**Status:** on track. 3 tasks watched.',revisions:[{rev:2,createdAt:now,fingerprint:'x',chars:40,tasks:3,chatId:null},{rev:1,createdAt:ago(86_400_000),fingerprint:'y',chars:30,tasks:2,chatId:null}],createdAt:now,watching:3},
  {id:'s2',projectId:'p',title:'Blockers',query:'status:blocked',refresh:'manual',tokenCap:300,enabled:true,state:'failed',error:'Link a folder to this project first.',lastRunAt:null,nextRunAt:null,rev:null,text:'',revisions:[],createdAt:now,watching:0}];
let goals:any[]=[{id:'g1',projectId:null,parentId:null,level:'workspace',title:'Make agents trustworthy',description:'',status:'active',ownerMemberId:null,targetDate:null,createdAt:'1',updatedAt:'1'},{id:'g2',projectId:'p',parentId:'g1',level:'project',title:'Ship 0.3.0',description:'All rows work.',status:'active',ownerMemberId:null,targetDate:'2026-11-01',createdAt:'2',updatedAt:'2'},{id:'g3',projectId:'p',parentId:'g2',level:'task',title:'Wave 2 lands',description:'',status:'planned',ownerMemberId:null,targetDate:null,createdAt:'3',updatedAt:'3'}];
let goalLinks:any[]=[{kind:'task',refId:'t1',goalId:'g3'}];
let labels:any[]=[{id:'lb1',projectId:'p',name:'bug',color:'danger',tasks:2},{id:'lb2',projectId:'p',name:'docs',color:'ok',tasks:0}];
let outputsRows:any[]=[{id:'file:p:docs/plan.md',title:'plan.md',detail:'P · CTO · docs/plan.md',status:'added',at:now,source:'local',projectId:'p',path:'docs/plan.md',taskId:'t1',agent:'CTO'},{id:'file:p:logo.png',title:'logo.png',detail:'P · QA · assets/logo.png',status:'added',at:ago(7200_000),source:'local',projectId:'p',path:'assets/logo.png',taskId:null,agent:'QA'}];
let outputStates:any={};
let inboxMeta:any[]=[];
const gates:any[]=[{id:'G1',automationId:'a1',automationName:'Gated',projectId:'p',projectName:'P',trigger:'webhook',summary:'Webhook · Every hour. Approve it to start the run.',variables:{},createdAt:now}];
const rosterAgents:any[]=[];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'work.links.list':return {links};
  case 'work.links.add':links=[...links,{...links[0],id:'L3',number:99,url:input.url,source:'manual'}];return links.at(-1);
  case 'work.links.scan':return {found:1,links};
  case 'work.links.refresh':return {links};
  case 'work.links.remove':links=links.filter(l=>l.id!==input.id);return {removed:true};
  case 'work.votes.set':votes=input.vote?[{id:'v1',projectId:'p',subject:input.subject,subjectId:input.subjectId,taskId:input.taskId,vote:input.vote,reason:input.reason??'',excerpt:input.excerpt,createdAt:now}]:[];return {vote:votes[0]??null};
  case 'work.votes.list':return {votes};
  case 'work.votes.export':return {json:'{"votes":[]}',count:votes.length};
  case 'work.docs.list':return {docs:[{key:'design',rev:doc.rev,chars:44,updatedAt:now,openThreads:1},{key:'plan',rev:1,chars:10,updatedAt:now,openThreads:0}]};
  case 'work.docs.get':if(input.key==='nope')throw new Error('This task has no “nope” document.');if(input.rev===1)return {...doc,rev:1,text:'The API has endpoints.\n'};return doc;
  case 'work.docs.save':doc={...doc,rev:doc.rev+1,text:input.text};return doc;
  case 'work.docs.restore':doc={...doc,rev:3,text:'The API has endpoints.\n'};return doc;
  case 'work.docs.thread.reply':return {...doc.threads[0],comments:[...doc.threads[0].comments,{id:'c2',author:'You',kind:'user',body:input.body,createdAt:now}]};
  case 'work.docs.thread.resolve':doc={...doc,threads:[{...doc.threads[0],status:input.resolved?'resolved':'open'}]};return doc.threads[0];
  case 'work.docs.thread.add':return {...doc.threads[0],id:'th2'};
  case 'work.docs.remove':return {removed:true};
  case 'work.summaries.list':return {cards};
  case 'work.summaries.refresh':return {status:input.id==='s1'&&!input.force?'unchanged':'started',card:cards[0]};
  case 'work.summaries.save':return cards[0];
  case 'work.summaries.remove':cards=cards.filter(c=>c.id!==input.id);return {removed:true};
  case 'work.summaries.revision':return {rev:input.rev,text:'Older text.',createdAt:ago(86_400_000)};
  case 'work.goals.list':return {goals,links:goalLinks,ancestry:{g3:['Make agents trustworthy','Ship 0.3.0','Wave 2 lands'],g2:['Make agents trustworthy','Ship 0.3.0'],g1:['Make agents trustworthy']}};
  case 'work.goals.save':return {...goals[1],...input};
  case 'work.goals.remove':goals=goals.filter(g=>g.id!==input.id);return {removed:true};
  case 'work.goals.link':return {ok:true};
  case 'work.labels.list':return {labels};
  case 'work.labels.save':return {id:'lb3',projectId:'p',tasks:0,...input};
  case 'work.labels.remove':labels=labels.filter(l=>l.id!==input.id);return {removed:true};
  case 'work.task.labels.set':return {labels:[]};
  case 'work.project.meta.set':return {projectId:'p',status:input.status??'in_progress',targetDate:input.targetDate??null,starred:false,hidden:false,updatedAt:now};
  case 'work.star.set':return {starred:Boolean(input.starred),hidden:Boolean(input.hidden)};
  case 'work.outputs.state':return {states:outputStates,seenAt:ago(3600_000),pullRequests:[{id:'pr:L1',title:'Fix login',detail:'acme/widgets#12 · open · 2 passed · 1 failed',url:'https://github.com/acme/widgets/pull/12',taskId:'t1',state:'open',at:ago(60_000)}]};
  case 'work.outputs.status':outputStates={...outputStates,[input.outputId]:{status:input.status,note:input.note??'',by:'You',at:now}};return outputStates[input.outputId];
  case 'work.outputs.seen':return {seenAt:now};
  case 'work.inbox.state':return {items:inboxMeta};
  case 'work.inbox.read':case 'work.inbox.snooze':case 'work.inbox.decideBy':return {ok:true};
  case 'work.inbox.recommend':inboxMeta=[{id:input.id,readAt:null,readFor:null,snoozedUntil:null,snoozedFor:null,decideBy:null,recommendation:{state:'ready',agent:'CTO',text:'Pick SQLite.',chatId:'c',at:now}}];return inboxMeta[0].recommendation;
  case 'paperclip.list':return {kind:'artifacts',rows:outputsRows,note:''};
  case 'paperclip.snapshot':return {paperclip:null,tasks:[],agents:rosterAgents,projects:[],goals:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:now};
  case 'project.scheduler.set':return {};
  case 'automations.gate.list':return {items:gates};
  case 'automations.gate.decide':gates.length=0;return {ok:true};
  case 'automations.webhook.rotate':return {url:'http://127.0.0.1:47831/hooks/a1',secret:'whsec_'+'ab'.repeat(32)};
  case 'project.members.list':return {members:[{id:'m1',projectId:'p',name:'CTO',kind:'agent',role:'agent',title:'CTO'}],access:{},policy:{}};
  case 'clipboard.write':return {ok:true};
  case 'link.open':return {ok:true};
  case 'app.snapshot':return {folders:[],chats:[],projects:[{id:'p',name:'P',goal:'',folderIds:['f1'],primaryFolderId:'f1'}],version:1};
  default:throw new Error(`unexpected ${command}`);
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const W=await import('../src/renderer/components/WorkTask');
const P=await import('../src/renderer/components/WorkProject');
const {OutputsPanel}=await import('../src/renderer/components/WorkOutputs');
const I=await import('../src/renderer/components/WorkInbox');
const {GanttTimeline}=await import('../src/renderer/components/Gantt');
const A=await import('../src/renderer/components/WorkAutomations');
const {RosterList}=await import('../src/renderer/components/RosterPanel');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');if(el.tagName==='SELECT'){for(const o of [...el.options])o.selected=o.value===value;try{Object.defineProperty(el,'value',{configurable:true,get:()=>value});}catch{}el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);return;}let proto=Object.getPrototypeOf(el),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
const field=(label:string)=>document.querySelector(`[aria-label="${label}"]`) as any;
const submit=async(form:Element|null)=>{assert.ok(form,'form');form!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(40);};
const show=async(node:React.ReactNode,ms=60)=>{root.render(<>{node}</>);await delay(ms);};

// G34: linked pull requests with state, checks and plain error text; link, scan and unlink call the right commands.
await show(<W.TaskPullRequests projectId="p" taskId="t1"/>,120);
assert.match(text(),/Fix login/);assert.match(text(),/acme\/widgets#12/);assert.match(text(),/Open/);assert.match(text(),/Checks failing/);assert.match(text(),/2 passed · 1 failed/);
assert.match(text(),/Not found on GitHub/);assert.match(text(),/Not read/);
await setValue(field('Pull request link'),'https://github.com/acme/widgets/pull/99');await submit(document.querySelector('.work-inline-form'));
assert.deepEqual(last('work.links.add')!.input,{projectId:'p',taskId:'t1',url:'https://github.com/acme/widgets/pull/99'});
await click(button(/Scan this thread for pull requests/));assert.deepEqual(last('work.links.scan')!.input,{projectId:'p',taskId:'t1'});
await click(button(/Unlink acme\/widgets#12/));assert.deepEqual(last('work.links.remove')!.input,{projectId:'p',id:'L1'});

// G15: thumbs on an agent reply: Helpful saves at once; Needs work asks why and saves the reason; clicking again clears.
const changed:string[]=[];
await show(<W.VoteButtons projectId="p" taskId="t1" subject="message" subjectId="m1" excerpt="I wrote the code." votes={votes} onChanged={()=>changed.push('x')}/>);
await click(button(/^Helpful$/));assert.deepEqual(last('work.votes.set')!.input,{projectId:'p',taskId:'t1',subject:'message',subjectId:'m1',vote:'helpful',reason:'',excerpt:'I wrote the code.'});
await click(button(/^Needs work$/));assert.ok(field('What was wrong?'),'a reason is asked for');
await setValue(field('What was wrong?'),'Skipped the tests');await submit(document.querySelector('.work-vote-reason'));
assert.equal(last('work.votes.set')!.input.vote,'needs_work');assert.equal(last('work.votes.set')!.input.reason,'Skipped the tests');assert.ok(changed.length>=2);
await show(<W.VoteButtons projectId="p" taskId="t1" subject="message" subjectId="m1" excerpt="x" votes={votes} onChanged={()=>{}}/>);
assert.equal((button(/^Needs work$/) as any).getAttribute('aria-pressed'),'true');
await click(button(/^Needs work$/));assert.equal(last('work.votes.set')!.input.vote,null);

// G5: documents list, the editor saves with a note and its base revision, History compares and restores, Comments reply and resolve.
await show(<W.TaskDocuments projectId="p" taskId="t1" votes={[]} onVotesChanged={()=>{}}/>,120);
assert.match(text(),/design/);assert.match(text(),/rev 2/);assert.match(text(),/plan/);
await click(button(/Open the design document/),120);
assert.ok(document.querySelector('[data-testid="work-doc-dialog"]'));assert.equal(field('design text').value,doc.text);
await setValue(field('design text'),'The API has three endpoints.\n');await setValue(field('Revision note'),'added a third');
await click(button(/Save revision/),80);assert.deepEqual(last('work.docs.save')!.input,{projectId:'p',taskId:'t1',key:'design',text:'The API has three endpoints.\n',note:'added a third',baseRev:2});
await click([...document.querySelectorAll('[role=tab]')].find(t=>/History/.test(t.textContent??'')),60);
assert.match(text(),/rev 2/);assert.match(text(),/second draft/);assert.match(text(),/first/);
await click(button(/Compare revision 2 with the one before/),120);assert.ok(document.querySelector('.work-diff'),'the diff shows');
await click(button(/Restore revision 1/),80);assert.deepEqual(last('work.docs.restore')!.input,{projectId:'p',taskId:'t1',key:'design',rev:1});
await click([...document.querySelectorAll('[role=tab]')].find(t=>/Comments/.test(t.textContent??'')),60);
assert.match(text(),/two endpoints/);assert.match(text(),/Why not three\?/);
await setValue(document.querySelector('.work-thread input'),'Because REST.');await click(button(/^Reply$/));assert.equal(last('work.docs.thread.reply')!.input.body,'Because REST.');
await click(button(/^Resolve$/));assert.equal(last('work.docs.thread.resolve')!.input.resolved,true);
// Read and comment: a selection becomes an anchored thread (the selection is faked: linkedom has no ranges).
await click([...document.querySelectorAll('[role=tab]')].find(t=>/Read and comment/.test(t.textContent??'')),60);
{const pre=document.querySelector('.work-doc-read') as any;assert.ok(pre,'the reader');
 (window as any).getSelection=()=>({rangeCount:1,isCollapsed:false,anchorNode:pre,focusNode:pre,getRangeAt:()=>({startContainer:pre,startOffset:0,toString:()=>'two endpoints',cloneRange:()=>({selectNodeContents(){},setEnd(){},toString:()=>'The API has '})})});
 pre.contains=()=>true;pre.dispatchEvent(new window.Event('mouseup',{bubbles:true}));await delay(40);
 assert.match(text(),/Commenting on “two endpoints”/);
 await setValue(field('Comment on the selection'),'Explain the list endpoint.');await submit(document.querySelector('.work-comment-form'));
 const added=last('work.docs.thread.add')!.input;assert.deepEqual([added.key,added.quote,added.start,added.end,added.body],['design','two endpoints',12,25,'Explain the list endpoint.']);}
await click(button(/^Close$/),40);

// G2: status cards show the text and when it was written; Refresh says plainly when nothing changed; a failed card says why; revisions open.
await show(<P.StatusCards projectId="p"/>,120);
assert.match(text(),/Project summary/);assert.match(text(),/on track/);assert.match(text(),/Once a day/);assert.match(text(),/Revision 2/);assert.match(text(),/Link a folder to this project first\./);
await click(button(/Refresh Project summary/),60);assert.deepEqual(last('work.summaries.refresh')!.input,{projectId:'p',id:'s1'});
await setValue(field('Project summary revisions'),'1');await delay(40);assert.match(text(),/Older text\./);assert.match(text(),/Back to latest/);
await click(button(/Edit Project summary/),60);assert.ok(document.querySelector('[data-testid="work-card-dialog"]'));
await setValue(document.querySelector('[data-testid="work-card-dialog"] input[placeholder^="status:blocked"]'),'label:release');await setValue(document.querySelector('[data-testid="work-card-dialog"] input[type=number]'),'800');
await submit(document.querySelector('[data-testid="work-card-dialog"] form'));
{const s=last('work.summaries.save')!.input;assert.deepEqual([s.id,s.query,s.tokenCap,s.refresh],['s1','label:release',800,'daily']);}
await click(button(/Delete Blockers/),20);await click(button(/^Delete$/),40);assert.equal(last('work.summaries.remove')!.input.id,'s2');
cards=[];await show(<P.StatusCards key="empty" projectId="p"/>,120);assert.match(text(),/Add a project summary/);
await click(button(/Add a project summary/),80);assert.equal(last('work.summaries.save')!.input.title,'Project summary');assert.equal(last('work.summaries.save')!.input.refresh,'daily');

// G18: the goals tree with levels, status, dates and links; a sub-goal dialog saves under its parent; removal calls the command.
const snap:any={paperclip:null,tasks:[{id:'t1',key:'OSS-1',title:'T',status:'todo'}],agents:[{id:'member:m1',name:'CTO',projectId:'p',memberId:'m1'}],projects:[],goals:[],runs:[],inbox:[],counts:{},fetchedAt:now};
await show(<P.GoalsSection projectId="p" snapshot={snap}/>,120);
assert.match(text(),/Make agents trustworthy/);assert.match(text(),/Ship 0\.3\.0/);assert.match(text(),/Wave 2 lands/);assert.match(text(),/1 task/);assert.match(text(),/Workspace/);assert.match(text(),/Planned/);
await click(button(/Add a sub-goal under Ship 0\.3\.0/),60);
await setValue(document.querySelector('[data-testid="work-goal-dialog"] input'),'Zero broken rows');await submit(document.querySelector('[data-testid="work-goal-dialog"] form'));
{const g=last('work.goals.save')!.input;assert.deepEqual([g.title,g.parentId,g.level,g.projectId],['Zero broken rows','g2','team','p']);}
await click(button(/Delete Wave 2 lands/),40);assert.equal(last('work.goals.remove')!.input.id,'g3');
await click(button(/Delete Make agents trustworthy/),40);assert.equal(last('work.goals.remove')!.input.workspace,true,'a workspace goal says so');

// C6 and G15 settings: labels (create, colour, delete) and the feedback list with export.
await show(<P.LabelsSection projectId="p"/>,120);
assert.match(text(),/bug/);assert.match(text(),/2 tasks/);
await setValue(field('New label name'),'release');await submit(document.querySelector('.work-inline-form'));assert.deepEqual(last('work.labels.save')!.input,{projectId:'p',name:'release',color:'accent'});
await setValue(field('Colour of bug'),'warn');assert.deepEqual(last('work.labels.save')!.input,{projectId:'p',id:'lb1',name:'bug',color:'warn'});
await click(button(/Delete label docs/),40);assert.equal(last('work.labels.remove')!.input.id,'lb2');
votes=[{id:'v1',projectId:'p',subject:'message',subjectId:'m1',taskId:'t1',vote:'needs_work',reason:'Skipped the tests',excerpt:'I wrote the code.',createdAt:now},{id:'v2',projectId:'p',subject:'document',subjectId:'t1:plan',taskId:'t1',vote:'helpful',reason:'',excerpt:'plan',createdAt:now}];
await show(<P.FeedbackSection key="fb" projectId="p" snapshot={snap}/>,120);
assert.match(text(),/1 helpful/);assert.match(text(),/1 needs work/);assert.match(text(),/Skipped the tests/);assert.match(text(),/OSS-1/);
await click(button(/Copy JSON/),60);assert.equal(last('clipboard.write')!.input.text,'{"votes":[]}');

// G32 and C18: status chips (overdue turns red), the status and date fields, the paused banner.
await show(<><P.ProjectStatusChips project={{status:'planned',targetDate:'2020-01-01'}}/><P.ProjectStatusChips project={{status:'completed',targetDate:'2020-01-01'}}/></>);
assert.match(text(),/Planned/);assert.match(text(),/Overdue/);assert.match(text(),/Completed/);assert.equal([...document.querySelectorAll('.ws-chip')].filter(c=>c.getAttribute('data-tone')==='danger').length,1,'only the open project is overdue');
await show(<dl><P.ProjectStatusFields projectId="p" status="planned" targetDate={null}/></dl>);
await setValue(field('Project status'),'in_progress');assert.deepEqual(last('work.project.meta.set')!.input,{projectId:'p',status:'in_progress'});
await setValue(field('Target date'),'2026-12-31');await click(button(/^Save$/),40);assert.deepEqual(last('work.project.meta.set')!.input,{projectId:'p',targetDate:'2026-12-31'});
await show(<P.PausedBanner project={{id:'p',paused:true,source:'local'}}/>);assert.match(text(),/agents are paused/);
await click(button(/Resume/),40);assert.deepEqual(last('project.scheduler.set')!.input,{projectId:'p',paused:false});
await show(<P.PausedBanner project={{id:'p',paused:false,source:'local'}}/>);assert.equal(text().trim(),'');

// G4: Outputs by kind, search, status, New cue, request changes needs a note.
const outSnap:any={...snap,tasks:[{id:'t1',key:'OSS-1',title:'Plan the launch',status:'todo'}],fetchedAt:'1'};
await show(<OutputsPanel snapshot={outSnap} projectId="p" local nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>,200);
assert.match(text(),/plan\.md/);assert.match(text(),/logo\.png/);assert.match(text(),/Fix login/);assert.match(text(),/Documents/);assert.match(text(),/Images/);assert.match(text(),/Pull requests/);
assert.ok([...document.querySelectorAll('.work-output')].some(o=>/plan\.md/.test(o.textContent??'')&&o.hasAttribute('data-new')),'an output made after you last looked is marked New');
assert.ok(![...document.querySelectorAll('.work-output')].some(o=>/logo\.png/.test(o.textContent??'')&&o.hasAttribute('data-new')),'an older one is not');
await click([...document.querySelectorAll('[role=tab]')].find(t=>/^Images/.test(t.textContent??'')),40);assert.ok(!/plan\.md/.test(document.querySelector('.work-outputs')!.textContent!.replace(/Documents/g,'')));
await click([...document.querySelectorAll('[role=tab]')].find(t=>/^All/.test(t.textContent??'')),40);
await setValue(field('Status of plan.md'),'ready_for_review');assert.deepEqual([last('work.outputs.status')!.input.outputId,last('work.outputs.status')!.input.status],['file:p:docs/plan.md','ready_for_review']);
await delay(100);await click(button(/Request changes/),40);
assert.ok((button(/^Request changes$/) as any),'the note form is open');await setValue(field('What should change in plan.md?'),'Add a rollback section.');
await submit(document.querySelector('.work-output .work-comment-form'));
{const o=last('work.outputs.status')!.input;assert.deepEqual([o.status,o.note,o.taskId,o.title],['changes_requested','Add a rollback section.','t1','plan.md']);}
await setValue(document.querySelector('input[type=search]'),'logo');assert.ok(!/plan\.md/.test(document.querySelector('.work-outputs')!.textContent!));

// C4 and G37: Inbox views, decide-by, recommendation, gate buttons.
const item:any={id:'ws:task:t1',bucket:'needs',title:'Pick a database',why:'Needs a pick',at:now,group:'P',unread:true,source:'muster',kind:'approval',action:{kind:'task',taskId:'t1'},projectId:'p',taskId:'t1',agentId:'member:m1'};
const rendered:string[]=[];
await show(<I.InboxViews view="mine" counts={{all:4,mine:3,unread:2,snoozed:1}} onView={v=>rendered.push(v)} unread={2} onMarkAll={()=>rendered.push('all-read')}/>);
assert.match(text(),/All4/);assert.match(text(),/Mine3/);assert.match(text(),/Unread2/);assert.match(text(),/Snoozed1/);
await click(button(/^Unread/));await click(button(/Mark all read/));assert.deepEqual(rendered,['unread','all-read']);
await show(<I.DecisionExtras item={item} meta={undefined} agentName="CTO" onChanged={()=>{}}/>);
await setValue(field('Decide Pick a database by'),'2026-10-20');assert.deepEqual(last('work.inbox.decideBy')!.input,{id:'ws:task:t1',date:'2026-10-20'});
await click(button(/Ask CTO for a recommendation/),40);assert.deepEqual(last('work.inbox.recommend')!.input,{id:'ws:task:t1',projectId:'p',taskId:'t1',title:'Pick a database',why:'Needs a pick'});
await show(<I.DecisionExtras item={item} meta={{id:item.id,readAt:null,readFor:null,snoozedUntil:null,snoozedFor:null,decideBy:'2020-01-01',recommendation:{state:'ready',agent:'CTO',text:'Pick SQLite: one file.',chatId:null,at:now}}} agentName="CTO" onChanged={()=>{}}/>);
assert.match(text(),/CTO’s recommendation/);assert.match(text(),/Pick SQLite: one file\./);assert.match(text(),/Overdue since/);assert.match(text(),/Ask CTO again/);
await show(<I.GateActions item={{...item,id:'ws:gate:G1'}} onChanged={()=>{}}/>);await click(button(/^Approve$/),60);assert.deepEqual(last('automations.gate.decide')!.input,{id:'G1',approve:true});
await show(<I.GateActions item={item} onChanged={()=>{}}/>);assert.equal(text().trim(),'','only a gate item gets Approve and Decline');

// G1: the Gantt shows stats, a bar per run, and the controls.
const gsnap:any={...snap,tasks:[{id:'t1',key:'OSS-1',title:'Plan',status:'todo',assigneeLabel:'CTO'}],agents:[{id:'member:m1',name:'CTO'}],fetchedAt:'2',
  runs:[{id:'r1',agentId:'member:m1',taskId:'t1',status:'succeeded',trigger:'user',source:'local',createdAt:ago(7200_000),startedAt:ago(7200_000),finishedAt:ago(3600_000),error:null,cancellable:false},{id:'r2',agentId:'member:m1',taskId:'t1',status:'failed',trigger:'user',source:'local',createdAt:ago(1800_000),startedAt:ago(1800_000),finishedAt:ago(900_000),error:'x',cancellable:false}]};
let opened='';
await show(<GanttTimeline snapshot={gsnap} view={null} onOpenTask={id=>{opened=id;}}/>,80);
assert.equal(document.querySelectorAll('.work-gantt-bar').length,2);assert.match(text(),/2 runs/);assert.match(text(),/1 succeeded/);assert.match(text(),/1 failed/);assert.match(text(),/OSS-1 · Plan/);
await click(document.querySelector('.work-gantt-bar'),20);assert.equal(opened,'t1');
await click(button(/Zoom in/),20);assert.match(text(),/×2/);await click(button(/Zoom out/),20);assert.match(text(),/×1/);
await setValue(field('Range'),'1h');assert.equal(document.querySelectorAll('.work-gantt-bar').length,1,'a one-hour range drops the older run');
await click([...document.querySelectorAll('[role=radio]')].find(r=>/By agent/.test(r.textContent??'')),20);assert.match(text(),/CTO/);

// G35 and C13: roster tabs, star and hide.
const ag=(id:string,name:string,status:string,extra:object={})=>({id,name,role:'agent',title:null,model:null,adapter:null,source:'local',status,reportsTo:null,lastActiveAt:null,error:null,capabilities:null,pausable:true,projectId:'p',memberId:id,...extra});
const agents:any[]=[ag('a','Alpha','idle'),ag('b','Beta','running',{starred:true}),ag('c','Gamma','paused'),ag('d','Delta','idle',{hidden:true})];
await show(<RosterList snapshot={{...snap,agents,tasks:[]}} agents={agents} nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>,80);
assert.deepEqual([...document.querySelectorAll('.roster-row .ws-row-title')].map(e=>e.textContent),['Beta','Alpha','Gamma'],'starred first, hidden folded away');
assert.deepEqual([...document.querySelectorAll('.roster-tabs [role=tab]')].map(t=>t.textContent),['All3','Active2','Paused1','Starred1','Hidden1']);
await click([...document.querySelectorAll('.roster-tabs [role=tab]')].find(t=>/^Hidden/.test(t.textContent??'')),30);assert.deepEqual([...document.querySelectorAll('.roster-row .ws-row-title')].map(e=>e.textContent),['Delta']);
await click(button(/Show Delta/),30);assert.deepEqual(last('work.star.set')!.input,{kind:'agent',id:'d',hidden:false});
await click([...document.querySelectorAll('.roster-tabs [role=tab]')].find(t=>/^All/.test(t.textContent??'')),30);
await click(button(/Star Alpha/),30);assert.deepEqual(last('work.star.set')!.input,{kind:'agent',id:'a',starred:true});
await click(button(/Hide Gamma/),30);assert.deepEqual(last('work.star.set')!.input,{kind:'agent',id:'c',hidden:true});

// G20, G3, C22: templates fill the form, the task target and variables, the webhook secret is shown once, Run now asks for values, a gate row approves.
const draft:any={...A.BLANK_TASK_FIELDS,projectId:'p'};const patches:any[]=[];
await show(<A.TemplatePicker onPick={t=>patches.push(t.id)}/>);await click(button(/Daily standup/),10);assert.equal(JSON.stringify(patches),'["daily-standup"]');
await show(<A.TaskTargetFields draft={{...draft,taskMode:'standup'}} patch={p=>patches.push(p)} projects={[{id:'p',name:'P'}]}/>,80);
assert.match(text(),/one parent task and a subtask for every agent/);assert.ok(!document.querySelector('select option[value="user:local"]'),'a standup has no single owner');
await show(<A.TaskTargetFields draft={draft} patch={p=>patches.push(p)} projects={[{id:'p',name:'P'}]}/>,80);
assert.ok(document.querySelector('select option[value="member:m1"]'),'the Roster agents are the owners to pick');
await show(<A.VariablesEditor variables={[]} onChange={v=>patches.push(v)} text="Look at {{ticket}} on {{date}}"/>);
assert.match(text(),/\{\{ticket\}\} is used but not declared/);await click(button(/Declare it/),10);assert.deepEqual(patches.at(-1),[{name:'ticket'}]);
const view:any={id:'a1',name:'Gated',ext:{variables:[{name:'ticket',required:true,label:'Ticket'},{name:'label',default:'triage'}],approval:true,activityGate:false,webhook:true},webhook:{url:'http://127.0.0.1:47831/hooks/a1',hasSecret:false},awaiting:1};
await show(<A.TriggersFields draft={{...draft,webhook:true,approval:true}} patch={()=>{}} editing={view} allowActivity/>);
assert.match(text(),/127\.0\.0\.1:47831\/hooks\/a1/);await click(button(/Make a secret/),60);
assert.match(text(),/whsec_(ab){32}/);assert.match(text(),/not shown again|shown once/i);assert.equal(last('automations.webhook.rotate')!.input.id,'a1');
await show(<A.TriggersFields key="reopened" draft={{...draft,webhook:true}} patch={()=>{}} editing={view} allowActivity/>);assert.ok(!/whsec_/.test(text()),'the secret is gone once the form is shown again');
const ran:any[]=[];
await show(<A.RunNowDialog automation={view} onClose={()=>{}} onRun={async v=>{ran.push(v);}}/>);
assert.match(text(),/Ticket \(required\)/);assert.ok((button(/^Run now$/) as any).disabled,'a required variable blocks it');assert.equal(field('label').value,'triage','defaults are filled in');
await setValue(field('Ticket'),'ABC-1');await submit(document.querySelector('[data-testid="work-runnow-dialog"] form'));assert.deepEqual(ran,[{ticket:'ABC-1',label:'triage'}]);
gates.push({id:'G1',automationId:'a1',automationName:'Gated',projectId:'p',projectName:'P',trigger:'webhook',summary:'Webhook · Every hour. Approve it to start the run.',variables:{},createdAt:now});await show(<A.GateBar key="gate" automation={view}/>,80);assert.match(text(),/Approve it to start the run/);await click(button(/^Approve$/),40);assert.deepEqual(last('automations.gate.decide')!.input,{id:'G1',approve:true});

assert.deepEqual(errors,[]);
console.log('work components ok');
process.exit(0);
