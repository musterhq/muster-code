// S3-G DOM checks: Edit project dialog, sidebar project hover card, PRJ-X3 sections (Agents, Changes, Memory, Environments)
// and the Overview hierarchy. Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph).
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
const at=(minutesAgo:number)=>new Date(Date.now()-minutesAgo*60_000).toISOString();
const attempt=(id:string,chatId:string,minutesAgo:number,status:string,trigger='scheduler',error?:string)=>({id,chatId,runId:null,trigger,startedAt:at(minutesAgo),endedAt:status==='running'?null:at(minutesAgo-5),status,contextVersion:null,...(error?{error}:{})});
const task=(id:string,title:string,state:string,attempts:any[]=[])=>({id,projectId:'p',title,status:'todo',state,dependencies:[],acceptance:'',evidence:[],revision:1,createdAt:at(900),updatedAt:at(30),owner:{kind:'agent',id:'a'},priority:2,artifacts:[],attempts,verification:null,permissionMode:null,budgetMinutes:null,blockedBy:null,ready:true,verificationStale:false,waitingChatId:null});
const work={tasks:{items:[task('t1','Wire the dialog','running',[attempt('a1','c-run',12,'running')]),task('t2','Write tests','todo'),task('t3','Old work','verified',[attempt('a2','c-old',600,'failed','user','Budget exceeded')])],truncated:false},
 decisions:{items:[],truncated:false},activity:{items:[{id:'x',projectId:'p',actor:'user',kind:'task.create',summary:'Created task: Write tests',refId:null,createdAt:at(3)}],truncated:false},
 scheduler:{autoDispatch:false,paused:false,concurrency:1,budgetMinutes:30,permissionMode:'workspace',updatedAt:null},instructions:{version:0,text:'',updatedAt:null},
 context:{version:1,goalVersion:1,instructionsVersion:0,decisions:0,headSha:null,label:'goal v1'},coordinator:{chatId:null,proposals:[]},dispatching:[]};
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 if(command==='project.update')return {id:'p',name:input.name??'Muster Code',goal:input.goal??'Ship it',folderIds:input.folderIds??['f1','f2'],primaryFolderId:input.primaryFolderId??'f1',archived:false,archivedAt:null};
 if(command==='folder.pick')return null;
 if(command==='project.work')return work;
 if(command==='git.status'){if(input.folderId==='f2')throw new Error('Not a git repository.');return {branch:'main',detached:false,unborn:false,revision:'r',files:[{path:'src/a.ts',index:' ',worktree:'M',staged:false,untracked:false,conflict:false},{path:'src/b.ts',index:'A',worktree:' ',staged:true,untracked:false,conflict:false},{path:'notes.md',index:'?',worktree:'?',staged:false,untracked:true,conflict:false}],truncated:false,stagedCount:1,conflicted:false,ahead:2};}
 if(command==='memory.list')return [{id:'m1',kind:'fact',summary:'Use pnpm in this repo',observedAt:at(90),confidence:1,provenance:[],scopes:[],redactionState:'none'},{id:'m2',kind:'decision',summary:'Ship behind a flag',observedAt:at(5),confidence:1,provenance:[],scopes:[],redactionState:'none'}];
 if(command==='sandbox.chatEnvironment.get')return input.chatId==='c-run'?{chatId:'c-run',env:'sandbox',mode:'copy',ready:true,browser:'host'}:{chatId:input.chatId,env:'host',mode:'copy',ready:true,browser:'host'};
 if(command==='project.members.list')return {members:[{id:'local',name:'You',revokedAt:null},{id:'d',name:'Dana',revokedAt:null},{id:'x',name:'Gone',revokedAt:'2026-01-01'}],access:{},policy:{}};
 throw new Error(`unexpected ${command}`);
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {EditProjectDialog}=await import('../src/renderer/components/ProjectEditDialog');
const {ProjectHoverCard}=await import('../src/renderer/components/ProjectHoverCard');
const {ProjectAgentsSection,ProjectChangesSection,ProjectMemorySection,ProjectEnvironmentsSection}=await import('../src/renderer/components/ProjectSections');
const {ProjectOverview}=await import('../src/renderer/components/ProjectOverview');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click exists');(el as any).click();};
const button=(label:RegExp,scope:ParentNode=document)=>[...scope.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const folders=[{id:'f1',name:'muster-code',path:'/Users/me/code/muster-code'},{id:'f2',name:'muster',path:'/Users/me/code/muster'},{id:'f3',name:'site',path:'/Users/me/code/site'}] as any;
const project={id:'p',name:'Muster Code',goal:'Ship it',folderIds:['f1','f2'],primaryFolderId:'f1',archived:false,archivedAt:null};

// IMG-2026-09-19T1315: Edit project — name, Source folders with Primary and ×, Add folder, Save sends one project.update.
let saved:any=null,archive=0;
root.render(<EditProjectDialog project={project} allFolders={folders} open onClose={()=>{}} onSaved={p=>{saved=p;}} onArchive={()=>{archive++;}}/>);
await delay(20);
const dialog=document.querySelector('[data-testid="project-edit-dialog"]');
assert.ok(dialog,'dialog renders');
assert.equal(dialog!.getAttribute('role'),'dialog');
assert.match(dialog!.textContent??'',/Edit project/);
assert.equal((dialog!.querySelector('.project-edit-name input') as any).value,'Muster Code');
assert.deepEqual([...dialog!.querySelectorAll('.project-edit-folder-name')].map(e=>e.textContent),['muster-code','muster']);
assert.equal(dialog!.querySelectorAll('.project-edit-primary').length,1);
click(button(/^Remove muster from project$/,dialog!));await delay(10);
click(button(/^Add folder$/,dialog!));await delay(10);
assert.match(document.querySelector('.project-edit-picker')?.textContent??'',/site.*~\/code\/site/);
click([...document.querySelectorAll('.project-edit-picker button')].find(b=>/site/.test(b.textContent??'')));await delay(10);
click(button(/^Make primary$/));await delay(10);
assert.deepEqual([...document.querySelectorAll('.project-edit-folder-name')].map(e=>e.textContent),['site','muster-code']);
document.querySelector('.project-edit-dialog form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await delay(20);
assert.deepEqual(calls.filter(c=>c.command==='project.update').at(-1)?.input,{id:'p',folderIds:['f3','f1'],primaryFolderId:'f3'});
assert.equal(saved?.primaryFolderId,'f3');
click(button(/Archive project/));assert.equal(archive,1);

// Sidebar hover card: goal, open/running tasks, folder paths with Primary, last activity, Edit project.
let edits=0,opens=0;
root.render(<ProjectHoverCard project={project} folders={folders} chats={[{id:'c1',projectId:'p',title:'x',status:'idle',updatedAt:at(60),archived:false}] as any} onEdit={()=>{edits++;}} onOpen={()=>{opens++;}}/>);
await delay(30);
const card=text();
assert.match(card,/Muster Code/);assert.match(card,/Ship it/);
assert.match(card,/2 open tasks/,'running and todo tasks count as open; verified does not');
assert.match(card,/1 running/);
assert.match(card,/~\/code\/muster-code/);assert.match(card,/Primary/);
assert.match(card,/Active 3m ago/,'newest of activity, tasks and chats');
click(button(/^Edit project$/));click(button(/^Open$/));
assert.equal(edits,1);assert.equal(opens,1);
const workCalls=calls.filter(c=>c.command==='project.work').length;
root.render(<></>);await delay(5);
root.render(<ProjectHoverCard project={project} folders={folders} chats={[]} onEdit={()=>{}} onOpen={()=>{}}/>);await delay(20);
assert.equal(calls.filter(c=>c.command==='project.work').length,workCalls,'reopening within 15s reuses the cached glance');

// PRJ-X3 Agents: running first, trigger and error shown, rows open the run chat.
const opened:string[]=[];
root.render(<ProjectAgentsSection work={work as any} chats={[{id:'c-live',title:'Loose chat',status:'running',updatedAt:at(1),archived:false}] as any} onOpenChat={id=>opened.push(id)} onShowTasks={()=>{}}/>);
await delay(10);
assert.deepEqual([...document.querySelectorAll('.project-run-title')].map(e=>e.textContent),['Loose chat','Wire the dialog','Old work']);
assert.match(text(),/2 working now · 2 task runs/);
assert.match(text(),/Scheduler · running/);assert.match(text(),/Started by you · took 5m · Budget exceeded/);
click(button(/Wire the dialog/));assert.deepEqual(opened,['c-run']);
root.render(<ProjectAgentsSection work={{tasks:{items:[],truncated:false}} as any} chats={[]} onOpenChat={()=>{}} onShowTasks={()=>{}}/>);
await delay(10);
assert.match(text(),/No agent runs yet/);

// PRJ-X3 Changes: git status per folder, totals, errors per folder, Review opens that folder.
const reviewed:string[]=[];
root.render(<ProjectChangesSection folders={folders.slice(0,2)} onReview={f=>reviewed.push(f.id)}/>);
await delay(30);
assert.match(text(),/3 changed files across 1 folder/);
assert.match(text(),/main ↑2/);
assert.deepEqual([...document.querySelectorAll('.project-change-code')].map(e=>e.textContent),['M','A','?']);
assert.match(text(),/Not a git repository\./);
click(button(/^Review$/));assert.deepEqual(reviewed,['f1']);

// PRJ-X3 Memory: the Project's own bank (project:<id>), newest first, with a way into the Memory screen.
let memoryOpened=0;
root.render(<ProjectMemorySection projectId="p" onOpenMemory={()=>{memoryOpened++;}}/>);
await delay(30);
assert.equal(calls.filter(c=>c.command==='memory.list').at(-1)?.input.folderId,'project:p');
assert.deepEqual([...document.querySelectorAll('.project-memory-summary')].map(e=>e.textContent),['Ship behind a flag','Use pnpm in this repo']);
click(button(/Open in Memory/));assert.equal(memoryOpened,1);

// PRJ-X3 Environments: folders first, then where each recent project chat's agent runs.
root.render(<ProjectEnvironmentsSection chats={[{id:'c-run',folderId:'f1',title:'Runner',status:'running',updatedAt:at(2),archived:false},{id:'c2',title:'Scratch chat',status:'idle',updatedAt:at(9),archived:false}] as any} folders={folders} onOpenChat={()=>{}}><p className="folders-slot">folders here</p></ProjectEnvironmentsSection>);
await delay(30);
assert.deepEqual([...document.querySelectorAll('.project-subhead')].map(e=>e.textContent),['Folders','Where agents run']);
assert.ok(document.querySelector('.folders-slot'));
assert.deepEqual([...document.querySelectorAll('.project-run-meta')].map(e=>e.textContent),['muster-code · Sandbox','Scratch · This Mac']);

// Overview hierarchy: tasks → chats → activity → knowledge → members and usage.
root.render(<ProjectOverview project={project} folders={folders.slice(0,2)} chats={[]} work={work as any} onTab={()=>{}} onTasks={()=>{}} onOpenChat={()=>{}} onOpenRef={()=>{}} resolveRef={()=>null} onEditGoal={()=>{}} onStartChat={()=>{}} onAddTask={()=>{}} onChanged={()=>{}}/>);
await delay(40);
assert.deepEqual([...document.querySelectorAll('.project-overview-heading h2')].map(e=>e.textContent),['Tasks','Chats','Activity','Knowledge','Members and usage']);
assert.match(text(),/2 members · You, Dana/,'revoked members are left out');

root.unmount();
assert.equal(errors.length,0,String(errors[0]??''));
console.log('project-surface-components: ok');
