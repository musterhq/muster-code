// DOM checks for PRJ-11 activity filters, PRJ-13 members, PRJ-17 chat transfer and the UX-15 shared state surface.
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
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
const rows=[
 {id:'a3',projectId:'p',actor:'user',kind:'memory.saved',summary:'Saved a note to Project memory: “Use pnpm”',refId:null,createdAt:at(5)},
 {id:'a2',projectId:'p',actor:'scheduler',kind:'task.run-started',summary:'Started "Build" in an agent chat',refId:null,createdAt:at(60*13)},
 {id:'a1',projectId:'p',actor:'user',kind:'task.create',summary:'Created task: Build',refId:null,createdAt:at(60*24*8)},
];
const member=(over:any)=>({projectId:'p',maxPermission:null,folderIds:null,secrets:[],revokedAt:null,local:false,createdAt:'',updatedAt:'',...over});
let members=[member({id:'local',name:'You',kind:'person',role:'owner',local:true}),member({id:'agent',name:'Agents',kind:'agent',role:'agent'}),member({id:'dana',name:'Dana',kind:'person',role:'editor',folderIds:['f2']})];
const access=(m:any)=>m.revokedAt?{memberIds:[m.id],active:false,canEdit:false,canDispatch:false,canAdmin:false,permissionMode:null,folderIds:[],secrets:[],reason:`${m.name}’s access was revoked.`}
 :{memberIds:[m.id],active:true,canEdit:true,canDispatch:true,canAdmin:m.role==='owner',permissionMode:m.role==='editor'?'workspace':'workspace',folderIds:m.folderIds??['f1','f2'],secrets:m.secrets,reason:null};
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 if(command==='project.activity.query'){
  let items=rows.filter(r=>!input.categories||input.categories.some((c:string)=>c==='memory'?r.kind.startsWith('memory.'):c==='runs'?r.kind.startsWith('task.run-'):c==='tasks'?r.kind==='task.create':false));
  if(input.actors)items=items.filter(r=>input.actors.includes(r.actor));
  if(input.before)items=items.filter(r=>r.id<input.before.split('|')[1]);
  const page=items.slice(0,input.limit===50&&!input.before&&!input.categories&&!input.actors?2:input.limit);
  return {items:page,truncated:page.length<items.length,nextCursor:page.length<items.length?`${page[page.length-1]!.createdAt}|${page[page.length-1]!.id}`:null,actors:['scheduler','user']};
 }
 if(command==='project.members.list')return {members,access:Object.fromEntries(members.map(m=>[m.id,access(m)])),policy:{permissionMode:'workspace',folderIds:['f1','f2']}};
 if(command==='project.members.revoke'){members=members.map(m=>m.id===input.id?{...m,revokedAt:'2026-09-23T00:00:00Z'}:m);return {member:members.find(m=>m.id===input.id),stoppedRuns:0};}
 if(command==='project.chats.preview')return {chatId:input.chatId,title:'Loose chat',mode:input.mode,from:null,to:{id:'p',name:'Target'},blocked:null,messages:3,running:false,folder:{id:'f9',name:'other'},linksFolder:true,
  context:{gains:['Target’s shared goal','Project instructions v2'],loses:[],keeps:['Message history','Model, mode and access settings','Folder: other']},memory:{before:['other memory'],after:['other memory','Target Project memory']},notes:['Saved memories stay in the bank they were saved to. Nothing is copied or shared automatically.']};
 if(command==='project.chats.transfer')return {chatId:input.chatId,projectId:input.projectId};
 throw new Error(`unexpected ${command}`);
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ProjectActivityPanel}=await import('../src/renderer/components/ProjectActivityPanel');
const {ProjectMembersSection}=await import('../src/renderer/components/ProjectMembers');
const {ChatTransferSheet}=await import('../src/renderer/components/ChatTransferSheet');
const {ResourceState}=await import('../src/renderer/components/ResourceState');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click exists');(el as any).click();};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??''));

// UX-15: loading waits before painting a skeleton; partial is a quiet status; error offers retry.
root.render(<><ResourceState kind="loading" label="Loading things"/><ResourceState kind="partial" message="Showing the latest 100."/><ResourceState kind="error" message="Broken." onRetry={()=>{}}/></>);
await delay(10);
assert.equal(document.querySelectorAll('.resource-skeleton').length,0,'no skeleton flash for fast reads');
await delay(200);
assert.equal(document.querySelectorAll('.resource-skeleton').length,3);
assert.equal(document.querySelector('.resource-state-partial')?.getAttribute('role'),'status');
assert.ok(button(/Retry/));

// PRJ-11: filters drive project.activity.query; ages read Codex-style with an exact tooltip; older rows page in.
root.render(<ProjectActivityPanel projectId="p" resolveRef={()=>null} onOpenRef={()=>{}}/>);
await delay(30);
assert.match(text(),/Saved a note to Project memory/);assert.match(text(),/13h ago/);
assert.ok(document.querySelector('.project-activity-meta')?.getAttribute('title'),'exact time tooltip');
click(button(/^Show older$/));await delay(20);
assert.match(text(),/Created task: Build/);assert.match(text(),/1w ago/);
click(button(/^Memory$/));await delay(20);
const last=calls.filter(c=>c.command==='project.activity.query').at(-1)!.input;
assert.deepEqual(last.categories,['memory']);assert.equal(last.window,'any');
assert.equal(document.querySelectorAll('.project-activity-list li').length,1);
const actorSelect=document.querySelector('select[aria-label="Actor"]') as any;
assert.deepEqual([...actorSelect.querySelectorAll('option')].map((o:any)=>o.textContent),['Anyone','scheduler','You']);
click(button(/^Clear filters$/));await delay(20);
assert.equal(calls.filter(c=>c.command==='project.activity.query').at(-1)!.input.categories,undefined);

// PRJ-13: members with their effective access, and revocation behind a confirmation.
const project={id:'p',name:'Target',goal:'',folderIds:['f1','f2'],primaryFolderId:'f1',archived:false,archivedAt:null};
const folders=[{id:'f1',name:'app',path:'/tmp/app'},{id:'f2',name:'api',path:'/tmp/api'}] as any;
root.render(<ProjectMembersSection project={project} folders={folders}/>);
await delay(30);
assert.match(text(),/You.*This Mac/);assert.match(text(),/Dana/);
assert.match(text(),/1 of 2 folders/,'Dana’s folder grant is shown as an intersection');
assert.match(text(),/never lend one member another member’s folders or secrets/);
click([...document.querySelectorAll('button')].filter(b=>b.textContent==='Revoke…').at(-1));await delay(20);
assert.match(text(),/Revoke Dana’s access\?/);
click(button(/^Revoke access$/));await delay(40);
assert.ok(calls.some(c=>c.command==='project.members.revoke'&&c.input.id==='dana'));
assert.match(text(),/Revoked/);assert.match(text(),/Dana’s access was revoked\./);

// PRJ-17: the transfer sheet previews scope changes and only then transfers.
let done:any=null;
root.render(<ChatTransferSheet request={{projectId:'p',mode:'move',projectName:'Target'}} candidates={[{id:'c1',title:'Loose chat'}] as any} onClose={()=>{}} onDone={r=>{done=r;}}/>);
await delay(20);
const confirmButton=()=>button(/^(Move|Copy) chat$/);
assert.equal((confirmButton() as any).disabled,true,'nothing to confirm before a chat and preview exist');
const chatSelect=document.querySelector('.chat-transfer-field select') as any;
assert.deepEqual([...chatSelect.querySelectorAll('option')].map((o:any)=>o.textContent),['Choose a chat…','Loose chat'],'only chats outside the Project are offered');
assert.equal(calls.some(c=>c.command==='project.chats.preview'),false,'no preview before a chat is chosen');
root.render(<ChatTransferSheet request={{chatId:'c1',projectId:'p',mode:'move',projectName:'Target'}} onClose={()=>{}} onDone={r=>{done=r;}}/>);
await delay(30);
assert.match(text(),/Next turn gains/);assert.match(text(),/Project instructions v2/);
assert.match(text(),/other memory → other memory \+ Target Project memory|other memory.*Target Project memory/);
assert.match(text(),/Nothing is copied or shared automatically/);
assert.equal(calls.some(c=>c.command==='project.chats.transfer'),false,'a preview never transfers');
click(confirmButton());await delay(30);
const transfer=calls.find(c=>c.command==='project.chats.transfer')!;
assert.deepEqual(transfer.input,{chatId:'c1',projectId:'p',mode:'move',confirm:true});
assert.equal(done?.chatId,'c1');

assert.deepEqual(errors,[]);
root.unmount();
console.log('project-team-components: ok');
