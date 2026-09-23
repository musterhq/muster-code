/** Run with node tests/run-sidebar-navigation.mjs; dynamic chunks initialize UI after the DOM. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>(),scrolls:string[]=[];
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.chatId);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.closest('[data-chat-id]')?.dataset.chatId??this.className);};
// SketchPad's canvas, for the draft's + → Sketch check: linkedom has no real 2D context or toBlob (see composer-components.tsx).
window.HTMLCanvasElement.prototype.getContext=()=>null;
(window.HTMLCanvasElement.prototype as any).toBlob=function(callback:(blob:Blob|null)=>void){callback(new Blob(['sketch'],{type:'image/png'}));};
const pointer=async(element:Element,type:string,props:Record<string,unknown>={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientX:0,clientY:0,...props});element.dispatchEvent(event);await delay(20);};
const twoHoursAgo=new Date(Date.now()-2*3600_000).toISOString();
let chats:any[]=['one','two'].map((id,index)=>({id,title:id,folderId:'folder',status:index?'running':'completed',updatedAt:twoHoursAgo,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent'}));
chats.push({...chats[0],id:'loose',title:'loose',folderId:undefined,unread:true},{...chats[0],id:'old',title:'old',archived:true});
// Every subscriber hears every event (the store and the process summary both subscribe).
const listeners=new Set<(event:any)=>void>(),listener=(event:any)=>{for(const fn of listeners)fn(event);};
const calls:{command:string;input:any}[]=[];
let createdCount=0,userDefault=false,refuseDelete='';
let contextMenuAction:any=null,folderMenuAction:any=null;
let folders:any[]=[{id:'folder',name:'Folder',path:'/fixture'}];
const snapshot=()=>({version:1,chats,folders,projects:[{id:'project',name:'Launch',goal:'Ship it',folderIds:['folder']}],activeChatId:'one'});
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='chat.contextMenu'){
    // Main runs data actions itself and answers with a fresh snapshot; only renderer UI actions come back.
    if(contextMenuAction==='main:pin'){chats=chats.map(chat=>chat.id===input.id?{...chat,pinned:!chat.pinned}:chat);listener({type:'snapshot',snapshot:snapshot()});return null;}
    return contextMenuAction;
  }
  if(command==='folder.contextMenu')return folderMenuAction;
  if(command==='folder.pick'){const folder={id:'added',name:'Added',path:'/added'};folders=[...folders,folder];listener({type:'snapshot',snapshot:snapshot()});return folder;}
  if(command==='folder.rename'){folders=folders.map(folder=>folder.id===input.id?{...folder,name:input.name}:folder);listener({type:'snapshot',snapshot:snapshot()});return folders[0];}
  if(command==='chat.markUnread'){chats=chats.map(chat=>chat.id===input.id?{...chat,unread:input.unread}:chat);listener({type:'snapshot',snapshot:snapshot()});return chats.find(chat=>chat.id===input.id);}
  if(command==='chat.create'){const chat={...chats[0],id:`created-${++createdCount}`,title:'New chat',folderId:input.folderId,projectId:input.projectId};chats=[...chats,chat];listener({type:'snapshot',snapshot:snapshot()});return chat;}
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.delete'){if(input.id===refuseDelete)throw new Error('This chat is still working. Stop it first, or confirm deleting it while it runs.');chats=chats.filter(chat=>chat.id!==input.id);listener({type:'snapshot',snapshot:snapshot()});return undefined;}
  if(command==='chat.send'){chats=chats.map(chat=>chat.id===input.id?{...chat,title:input.text,draft:''}:chat);listener({type:'snapshot',snapshot:snapshot()});return {runId:'run',replay:false};}
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.update'){chats=chats.map(chat=>chat.id===input.id?{...chat,...input}:chat);listener({type:'snapshot',snapshot:snapshot()});return chats.find(chat=>chat.id===input.id);}
  // F9: the draft asks chat.defaults — exactly what chat.create will resolve — instead of guessing.
  if(command==='chat.defaults')return userDefault&&input.folderId==='folder'?{providerId:'terra',model:'terra-1',effort:'high',source:'user'}:{providerId:'hybrow',model:'claude/claude-fable-5',source:'runtime'};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  // CHAT-05/09: the draft's model picker, + menu (Plan/Goal/Sketch) and / (skills) + @ (files/folders/plugins).
  if(command==='providers.list')return [{id:'terra',name:'Terra',available:true,models:[{id:'terra-1',name:'Terra One'}]},{id:'hybrow',name:'Hybrow',available:true,models:[{id:'claude/claude-fable-5',name:'Claude Fable'}]}];
  if(command==='plugins.list')return [{id:'/skills/recap',name:'recap',provenance:'~/.codex/skills',path:'/skills/recap',readme:'Summaries.',readError:null,displayName:'Recap',shortDescription:'Summarise the chat'}];
  if(command==='plugins.inventory')return [{id:'/plugins/gmail',name:'gmail',version:'1.0.0',provenance:'openai-curated',path:'/plugins/gmail',skills:[],mcpServers:[],apps:[],readError:null,displayName:'Gmail',shortDescription:'Read and manage Gmail'}];
  if(command==='files.list')return [{name:'README.md',path:'README.md',kind:'file'},{name:'src',path:'src',kind:'directory'}];
  if(command==='files.search')return {entries:[{name:'README.md',path:'README.md',kind:'file'}],truncated:false};
  if(command==='goals.set'){return {chatId:input.chatId,text:input.text,status:'active',createdAt:'',startedAt:new Date().toISOString(),accumulatedMs:0,turns:0,maxTurns:20,updatedAt:''};}
  if(command==='chat.setPermissionMode'){assert.ok(input.permissionMode!=='full'||input.acknowledgeFullAccess===true,'CHAT-08: Full access must acknowledge, in the draft too');chats=chats.map(chat=>chat.id===input.id?{...chat,permissionMode:input.permissionMode}:chat);listener({type:'snapshot',snapshot:snapshot()});return chats.find(chat=>chat.id===input.id);}
  if(command==='chat.selectProvider'){chats=chats.map(chat=>chat.id===input.id?{...chat,providerId:input.providerId,model:input.model}:chat);listener({type:'snapshot',snapshot:snapshot()});return chats.find(chat=>chat.id===input.id);}
  // Side chats/canvases sync and the capture picker's permission probe: empty and granted in this fixture.
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='computer.permissions')return {accessibility:'granted',screen:'granted'};
  if(command==='computer.captureSources')return [{id:'window-1',name:'Muster Agent',kind:'window',thumbnail:'data:image/png;base64,AAAA',width:10,height:10}];
  if(command==='computer.captureSource')return {dataUrl:'data:image/png;base64,c2hvdA==',width:10,height:10,name:'Muster Agent'};
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store'),{Sidebar}=await import('../src/renderer/components/Sidebar');
const drafts=await import('../src/renderer/newChatDraft'),{NewChatScreen}=await import('../src/renderer/components/NewChatScreen');
function Shell(){const draft=drafts.useNewChatDraft();return <><Sidebar/>{draft.open&&<NewChatScreen/>}</>;}
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Shell/>);await delay(60);
assert.deepEqual(errors,[]);assert.ok(document.querySelector('[aria-label="1 active chats"]'),'running group count remains visible when collapsed');
const footerLabels=Array.from(document.querySelectorAll<HTMLElement>('.nav-footer-action')).map(button=>button.textContent);
assert.deepEqual(footerLabels,['Settings','Skills & plugins','Accounts & providers'],'sidebar utilities remain legible at the minimum navigation width');
const sections=()=>Array.from(document.querySelector('.nav-scroll')!.children).map(el=>el.getAttribute('aria-label')??el.querySelector('.nav-section-title')?.textContent);
assert.deepEqual(sections(),['Folders','Projects','Chats','Archived (1)'],'folders, projects, folderless chats, then archived');
assert.ok(!document.querySelector('[data-chat-id="old"]'),'archived starts collapsed');
const ageOne=document.querySelector('[data-chat-id="one"] .chat-row-age')!;
assert.equal(ageOne.textContent,'2h','each row shows its compact age');assert.ok(ageOne.getAttribute('title')?.length,'the age carries an exact-time tooltip');
assert.ok(!document.querySelector('[data-chat-id="one"] .chat-row-status'),'settled rows carry no badge');
assert.equal(document.querySelector('[data-chat-id="one"] .status-dot')?.getAttribute('aria-label'),'Completed');
assert.ok(!document.querySelector('[data-chat-id="one"] .lucide-circle-check'),'completed chats use the neutral chat glyph, not a check');
assert.ok(document.querySelector('[data-chat-id="loose"]')!.classList.contains('is-unread'),'an unseen result marks the row unread (bold title)');
assert.equal(document.querySelector('[data-chat-id="loose"] .status-dot')?.getAttribute('aria-label'),'Unread · Completed');
assert.ok(document.querySelector('[data-chat-id="loose"] .status-unread-dot'),'with a blue dot in the glyph slot');
assert.ok(!document.querySelector('[data-chat-id="one"] .status-unread-dot'),'read rows keep the quiet glyph');
for(const button of Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-inner button'))){if(!button.textContent?.trim())assert.ok(button.title,`icon-only button ${button.getAttribute('aria-label')} has a tooltip`);}
(document.querySelector('[aria-label="Pin one"]') as HTMLButtonElement).click();await delay(40);
assert.ok(calls.some(call=>call.command==='chat.update'&&call.input.id==='one'&&call.input.pinned===true),'the inline hover Pin action pins through the chat service');
assert.deepEqual(sections(),['Pinned','Folders','Projects','Chats','Archived (1)'],'pinned leads the hierarchy');
assert.equal(document.querySelector('[aria-label="Unpin one"]')?.getAttribute('title'),'Unpin','the pinned row offers Unpin in the same reserved slot');
assert.equal(document.querySelectorAll('.chat-row-main[tabindex="0"]').length,1,'exactly one chat row is a tab stop');
const main=(id:string)=>document.querySelector(`[data-chat-id="${id}"] .chat-row-main`)!;
const key=(target:Element,init:Record<string,unknown>)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,init);target.dispatchEvent(event);return event;};
assert.ok(key(main('one'),{key:'ArrowDown'}).defaultPrevented);assert.equal(focused.at(-1),'two','ArrowDown moves from the pinned row to the first folder row');
key(main('two'),{key:'ArrowDown'});assert.equal(focused.at(-1),'loose','ArrowDown skips empty groups into folderless chats');
key(main('loose'),{key:'ArrowDown'});assert.equal(focused.at(-1),'loose','ArrowDown clamps at the last visible row (archived is collapsed)');
key(main('loose'),{key:'Home'});assert.equal(focused.at(-1),'one');key(main('one'),{key:'End'});assert.equal(focused.at(-1),'loose');
key(main('two'),{key:'ArrowUp'});assert.equal(focused.at(-1),'one');
(document.querySelector('[aria-label="Unpin one"]') as HTMLButtonElement).click();await delay(40);
// New chat is a draft: repeated Cmd+N / New chat clicks create no rows until the first message is sent.
const creates=()=>calls.filter(call=>call.command==='chat.create');
const sends=()=>calls.filter(call=>call.command==='chat.send');
const newChatButton=()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-toolbar .tool-button')).find(button=>button.textContent==='New chat')!;
const typeDraft=async(text:string)=>{const field=document.querySelector('[data-testid="new-chat"] textarea') as HTMLTextAreaElement;field.value=text;(field as any)._valueTracker?.setValue('');field.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(10);};
const sendDraft=async()=>{(document.querySelector('[data-testid="new-chat"] .composer-send') as HTMLButtonElement).click();await delay(60);};
const createsBefore=creates().length;
for(let i=0;i<3;i++){key(window as any,{key:'n',metaKey:true,ctrlKey:false});await delay(15);}
newChatButton().click();newChatButton().click();await delay(30);
assert.equal(creates().length,createsBefore,'Cmd+N and New chat never persist a chat on their own');
assert.equal(document.querySelectorAll('[data-testid="new-chat"]').length,1,'repeated New chat focuses the one draft');
assert.equal(newChatButton().getAttribute('aria-current'),'page','the New chat entry shows as the current view');
assert.ok(!document.querySelector('.chat-row.is-active'),'no chat row claims selection while drafting');
assert.equal(document.querySelector('[data-testid="new-chat"] .chat-empty-prompt')?.textContent,'What should we build in Folder?','the draft names the preselected folder');
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-label'),'Start in: Folder');
assert.ok((document.querySelector('[data-testid="new-chat"] .composer-send') as HTMLButtonElement).disabled,'nothing to send yet');
await typeDraft('Build the thing');await sendDraft();
// CHAT-06: "two" is still running in Folder, so the second run in that checkout asks first; Run anyway sends it here.
const guard=await import('../src/renderer/components/ParallelRunGuard');
await delay(20);assert.deepEqual(guard.pendingParallelRun()?.siblingIds,['two'],'the question names the chat working in Folder');
guard.answerParallelRun('run');await delay(40);
assert.equal(creates().length,createsBefore+1,'the first message creates exactly one chat');
assert.equal(creates().at(-1)!.input.folderId,'folder','in the chosen folder');
assert.equal(sends().at(-1)?.input.id,'created-1');assert.equal(sends().at(-1)?.input.text,'Build the thing','and sends the message there');
assert.equal(store.getState().activeChatId,'created-1','the new chat is selected');
assert.ok(!drafts.getNewChatDraft().open&&!document.querySelector('[data-testid="new-chat"]'),'and the draft closes');
// No folder: the plain chat entry retargets the draft; the chat is created without a folder.
(document.querySelector('[aria-label="New chat without a folder"]') as HTMLButtonElement).click();await delay(30);
assert.ok(document.querySelector('[data-testid="new-chat"]'),'the Chats entry opens the draft');
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-label'),'Start in: No folder');
assert.equal(document.querySelector('[data-testid="new-chat"] .chat-empty-prompt')?.textContent,'What should we build?');
await typeDraft('Just a question');await sendDraft();
assert.equal(creates().length,createsBefore+2);assert.ok(!('folderId' in creates().at(-1)!.input)&&!('projectId' in creates().at(-1)!.input),'None makes a folderless chat');
// CHAT-21: the folder-row "New chat in <folder>" icon opens the same draft as global New chat now — it never
// creates a row on its own (no more stray "New chat" rows) — and only sending reuses an unused chat already there.
chats=[...chats,{...chats[0],id:'blank',title:'New chat',status:'idle',draft:'',folderId:'folder',updatedAt:new Date().toISOString()}];listener({type:'snapshot',snapshot:snapshot()});await delay(30);
(document.querySelector('[aria-label="New chat in Folder"]') as HTMLButtonElement).click();await delay(40);
assert.equal(creates().length,createsBefore+2,'the folder + only opens a draft, no chat created yet');
assert.ok(document.querySelector('[data-testid="new-chat"]'),'and the draft opens, targeted at the folder');
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-label'),'Start in: Folder');
await typeDraft('Use the blank one');await sendDraft();
await delay(20);assert.equal(guard.pendingParallelRun()?.chatId,'blank','CHAT-06: the same-checkout question again');guard.answerParallelRun('run');await delay(40);
// From here on "two" keeps running in Folder: every later send in this fixture answers Run anyway.
setInterval(()=>{if(guard.pendingParallelRun())guard.answerParallelRun('run');},5).unref();
assert.equal(creates().length,createsBefore+2,'sending reuses the unused chat instead of creating another');assert.equal(sends().at(-1)?.input.id,'blank');assert.equal(store.getState().activeChatId,'blank');
// F22/CHAT-06/NAV-06: the running chat in the same folder keeps streaming (snapshots that even suggest it as the
// host's active chat) — the view stays on the second chat, its folder stays open, and it owns the one composer.
for(let i=0;i<3;i++){listener({type:'snapshot',snapshot:{...snapshot(),activeChatId:'two',chats:chats.map(chat=>chat.id==='two'?{...chat,status:'running',updatedAt:new Date(Date.now()+i).toISOString()}:chat)}});await delay(15);}
assert.equal(store.getState().activeChatId,'blank','no snap back to the running chat');
assert.equal(main('blank').closest('.nav-section')?.querySelector('.nav-disclosure')?.getAttribute('aria-expanded'),'true','its folder stays expanded');
assert.ok(document.querySelector('[data-chat-id="blank"]'),'and the second chat stays visible in the sidebar');
chats=chats.filter(chat=>!chat.id.startsWith('created')&&chat.id!=='blank');listener({type:'snapshot',snapshot:snapshot()});await store.selectChat('one');await delay(20);
const typeAt=async(value:string)=>{const field=document.querySelector('[data-testid="new-chat"] textarea.composer-input') as HTMLTextAreaElement;field.value=value;(field as any)._valueTracker?.setValue('');field.setSelectionRange(value.length,value.length);field.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(30);};
const draftPlusRow=async(label:string)=>{(document.querySelector('[data-testid="new-chat"] .composer-plus') as HTMLButtonElement).click();await delay(30);const row=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="new-chat"] [data-testid="composer-row"]')).find(node=>node.querySelector('.composer-row-label')?.textContent===label);assert.ok(row,label);row!.click();await delay(30);};
// CHAT-09: the draft shows the runtime default model (hybrow/Claude Fable) — not modelOptions[0] (Terra One) — so
// what the user sees matches what a plain send actually uses.
drafts.openNewChat({folderId:'folder'});await delay(30);
assert.equal(document.querySelector('[data-testid="new-chat"] .composer-model')?.textContent,'Claude Fable','the runtime default, not the first provider in the list');
// F9: a user/project default (chat.defaults) is what the draft shows, and a reused unused chat that predates it is
// switched to it on send, so the chip never lies about the model the chat runs on.
userDefault=true;listener({type:'chatDefaultsChanged'});await delay(40);
assert.equal(document.querySelector('[data-testid="new-chat"] .composer-model')?.textContent,'Terra One','the resolved user default, re-asked when chatDefaultsChanged fires');
chats=[...chats,{...chats[0],id:'stale',title:'New chat',status:'idle',draft:'',folderId:'folder',model:'claude/claude-fable-5',providerId:'hybrow',updatedAt:new Date().toISOString()}];listener({type:'snapshot',snapshot:snapshot()});await delay(30);
await typeAt('Default model check');await sendDraft();
assert.equal(sends().at(-1)?.input.id,'stale','reuses the unused chat');
assert.ok(calls.some(call=>call.command==='chat.selectProvider'&&call.input.id==='stale'&&call.input.providerId==='terra'&&call.input.model==='terra-1'),'and puts it on the model the draft showed');
assert.equal(JSON.parse(saved.get('muster.composer.effort.v1')??'{}').stale,'high','the resolved default effort is seeded into the new chat’s composer');
userDefault=false;chats=chats.filter(chat=>chat.id!=='stale');listener({type:'snapshot',snapshot:snapshot()});await store.selectChat('one');await delay(20);
drafts.openNewChat({folderId:'folder'});await delay(40);
// F4: the target picker closes as soon as a target is chosen (Base UI radio items stay open by default).
(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip') as HTMLButtonElement).click();await delay(40);
const noFolderItem=Array.from(document.querySelectorAll<HTMLElement>('.new-chat-target-menu [role="menuitemradio"]')).find(item=>item.textContent?.includes('No folder'));
assert.ok(noFolderItem,'the target menu opens');noFolderItem!.click();await delay(60);
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-label'),'Start in: No folder','the pick applies');
assert.ok(!document.querySelector('.new-chat-target-menu'),'and the menu closes on selection');assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-expanded'),'false');
drafts.setNewChatTarget({folderId:'folder'});await delay(20);
// CHAT-05: + now offers Plan mode, Goal and Sketch too, same as an in-chat composer (not just Files and folders).
await draftPlusRow('Plan mode');
assert.ok(document.querySelector('[data-testid="new-chat"] .composer-plan-chip'),'Plan mode shows as a chip');
assert.equal(document.querySelector<HTMLTextAreaElement>('[data-testid="new-chat"] textarea.composer-input')?.getAttribute('placeholder'),'Describe your task to generate a plan…');
await draftPlusRow('Goal');
const goalField=document.querySelector('[data-testid="new-chat-goal"]') as HTMLTextAreaElement;assert.ok(goalField,'Goal opens an inline editor, same copy as Composer’s');
goalField.value='Ship the beta';(goalField as any)._valueTracker?.setValue('');goalField.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(10);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="new-chat"] .new-chat-goal-popover button')).find(button=>button.textContent==='Done')!).click();await delay(20);
// CHAT-08: Full access chosen + confirmed in the draft must carry acknowledgeFullAccess (the mock throws otherwise) —
// this used to be silently dropped on send.
(document.querySelector('[data-testid="new-chat"] .composer-access') as HTMLButtonElement).click();await delay(20);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="new-chat"] [role="menuitemradio"]')).find(button=>button.textContent?.includes('Full access'))!).click();await delay(20);
// F6/F13: the draft uses the same Full-access dialog as a running chat, and it states its scope.
assert.ok(document.querySelector('[data-testid="full-access-confirm"]'),'the shared Full-access confirmation');
assert.equal(document.querySelectorAll('[data-testid="full-access-confirm"] li').length,3,'same three-row list as the in-chat dialog');
assert.match(document.querySelector('[data-testid="full-access-confirm"] .composer-access-scope')?.textContent??'',/this chat.*New chats in Folder/,'says what it applies to');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='Turn on')!).click();await delay(20);
assert.ok(document.querySelector('[data-testid="new-chat"] [aria-label="Access: Full access"]'),'reflected locally before send too');
// CHAT-05 (lead follow-up): Capture window and Work in a project must work in the draft too, not be dropped —
// Capture stages the screenshot locally (no chat exists yet to stage a runtime copy against).
const stagedBefore=calls.filter(call=>call.command==='attachments.stage').length;
await draftPlusRow('Capture window');
const captureRow=document.querySelector<HTMLButtonElement>('[aria-label="Capture a window or screen"] [data-testid="composer-row"]');assert.ok(captureRow,'Capture window opens the same picker as Composer’s');
captureRow!.click();await delay(30);
// CUA-08: choosing a source opens the region step; "Attach whole" keeps the one-click whole-window capture.
(Array.from(document.querySelectorAll<HTMLButtonElement>('.capture-region-actions button')).find(button=>button.textContent==='Attach whole')!).click();await delay(30);
assert.ok(Array.from(document.querySelectorAll('[data-testid="new-chat"] [data-testid="attachment-tile"]')).some(tile=>tile.getAttribute('title')?.includes('Muster Agent.png')),'the capture joins the draft’s attachment strip');
assert.equal(calls.filter(call=>call.command==='attachments.stage').length,stagedBefore,'staged locally only — no runtime copy until a chat exists to send to');
await draftPlusRow('Work in a project');
const projectRow=Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Work in a project"] [data-testid="composer-row"]')).find(row=>row.textContent?.includes('Launch'));assert.ok(projectRow,'the same ProjectPicker Composer uses');
projectRow!.click();await delay(20);
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.textContent,'Launch','retargets the draft’s own target picker instead of duplicating it');
// Sketch: draw a stroke, attach; the tile joins the strip exactly like Composer's.
await draftPlusRow('Sketch');
const drawCanvas=document.querySelector<HTMLCanvasElement>('[aria-label="Sketch canvas"]');assert.ok(drawCanvas,'Sketch is reachable from the draft’s + menu (it portals to document.body, like Composer’s)');
await pointer(drawCanvas!,'pointerdown',{clientX:5,clientY:5});await pointer(drawCanvas!,'pointerup',{clientX:5,clientY:5});
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="sketch-pad"] button')).find(button=>button.textContent==='Attach sketch')!).click();await delay(30);
assert.ok(Array.from(document.querySelectorAll('[data-testid="new-chat"] [data-testid="attachment-tile"]')).some(tile=>tile.getAttribute('title')?.includes('Muster Sketch.png')),'the sketch joins the draft’s attachment strip');
await typeAt('Draft with everything');
const createsBeforeAll=creates().length;
await sendDraft();
assert.equal(creates().length,createsBeforeAll+1,'exactly one chat created for the whole draft');
const createdId=sends().at(-1)!.input.id as string;
assert.ok(calls.some(call=>call.command==='chat.update'&&call.input.id===createdId&&call.input.mode==='plan'),'Plan mode applied to the new chat before send');
assert.ok(calls.some(call=>call.command==='goals.set'&&call.input.chatId===createdId&&call.input.text==='Ship the beta'),'the Goal is applied to the new chat');
assert.ok(calls.some(call=>call.command==='chat.setPermissionMode'&&call.input.id===createdId&&call.input.permissionMode==='full'&&call.input.acknowledgeFullAccess===true),'CHAT-08 fixed: Full access carries acknowledgeFullAccess from the draft');
// CHAT-24: a second chat in the same folder starts with the access level the first one settled on.
drafts.openNewChat({folderId:'folder'});await delay(30);
assert.equal(document.querySelector('[data-testid="new-chat"] [aria-label^="Access:"]')?.getAttribute('aria-label'),'Access: Full access','remembered per folder, not reset to Ask for approval');
// CHAT-23: / lists skills AND commands (never plugins — those belong to @ and +) and @ lists files/folders/plugins,
// same split as Composer's — the draft used to open no menu at all.
await typeAt('/recap');await delay(30);
assert.deepEqual(Array.from(document.querySelectorAll('[data-testid="new-chat-popover"] [data-testid="composer-row"] .composer-row-label')).map(node=>node.textContent),['Recap'],'/ matches the skill');
(document.querySelector('[data-testid="new-chat-popover"] [data-testid="composer-row"]') as HTMLButtonElement).click();await delay(30);
assert.equal(drafts.getNewChatDraft().text,'$recap ','picking a skill inserts its chip token, same as Composer');
assert.equal(document.querySelector('[data-testid="new-chat"] [data-testid="token-chip"]')?.textContent,'$recap','and draws as a chip (ChipMirror), not plain text');
await typeAt('/plan');await delay(30);
assert.ok(Array.from(document.querySelectorAll('[data-testid="new-chat-popover"] [data-testid="composer-row"] .composer-row-label')).some(node=>node.textContent==='/plan'),'/ also lists Muster’s own commands (Plan mode, Goal, Project, Sketch, Model, Reasoning, Access), same as Composer');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="new-chat-popover"] [data-testid="composer-row"]')).find(row=>row.textContent?.includes('/plan'))!).click();await delay(30);
assert.ok(document.querySelector('[data-testid="new-chat"] .composer-plan-chip'),'/plan runs the command (toggles Plan mode), not just inserts text');
await typeAt('$recap see @READ');await delay(260);
assert.ok(Array.from(document.querySelectorAll('[data-testid="new-chat-popover"] [data-testid="composer-row"] .composer-row-label')).some(node=>node.textContent==='README.md'),'@ lists files (folders and plugins too)');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="new-chat-popover"] [data-testid="composer-row"]')).find(row=>row.textContent?.includes('README.md'))!).click();await delay(30);
assert.equal(drafts.getNewChatDraft().text,'$recap see @README.md ','@ inserts a file chip');
// + › Start in background (same row as an in-chat composer): the chat starts and the draft stays, emptied.
drafts.setNewChatText('');await delay(10);await typeAt('Background job');
const sendsBeforeBackground=sends().length;
await draftPlusRow('Start in background');await delay(40);
assert.equal(sends().length,sendsBeforeBackground+1,'starts the chat');assert.equal(sends().at(-1)?.input.text,'Background job');
assert.ok(drafts.getNewChatDraft().open&&drafts.getNewChatDraft().text==='','and the draft stays open, cleared');
// CHAT-17: a failed background start puts the exact input back; the retry reuses the same chat and requestId, so a
// reply lost after the runtime accepted the send replays that run instead of starting a second chat or run.
{const original=(window as any).muster.invoke;let fail=true;const attempts:any[]=[];
(window as any).muster.invoke=async(command:string,input:any)=>{if(command==='chat.send'){attempts.push(input);if(fail){fail=false;calls.push({command,input});throw new Error('Connection lost');}}return original(command,input);};
drafts.setNewChatText('');await delay(10);await typeAt('Flaky job');
const createsBefore=calls.filter(call=>call.command==='chat.create').length;
await draftPlusRow('Start in background');await delay(40);
assert.equal(drafts.getNewChatDraft().text,'Flaky job','a failed background start restores the exact input');
assert.match(document.querySelector('[data-testid="new-chat"] .composer-error')?.textContent??'',/Connection lost/,'and says why');
await draftPlusRow('Start in background');await delay(40);
assert.equal(attempts.length,2,'retried once');
assert.equal(attempts[1].id,attempts[0].id,'the retry reuses the chat the first attempt created');
assert.equal(attempts[1].requestId,attempts[0].requestId,'and its requestId, so the runtime never runs it twice');
assert.ok(calls.filter(call=>call.command==='chat.create').length-createsBefore<=1,'one durable chat at most');
assert.equal(drafts.getNewChatDraft().text,'','the draft is fresh after the retry succeeds');
(window as any).muster.invoke=original;}
drafts.closeNewChat();await delay(20);
// F2: Add folder lands in a draft aimed at the folder just added — never "No folder" or the previous chat's folder.
(document.querySelector('[aria-label="Add folder"]') as HTMLButtonElement).click();await delay(50);
assert.equal(document.querySelector('[data-testid="new-chat"] .new-chat-target-chip')?.getAttribute('aria-label'),'Start in: Added','the draft targets the new folder');
drafts.closeNewChat();folders=folders.filter(folder=>folder.id!=='added');listener({type:'snapshot',snapshot:snapshot()});await delay(20);
assert.deepEqual(errors,[]);
assert.deepEqual(errors,[]);
// One search surface: the Search chats command and ⌘K open the Spotlight panel, never an inline sidebar field.
const {closeSpotlightSearch,isSpotlightSearchOpen}=await import('../src/renderer/components/SpotlightSearch');
window.dispatchEvent(new window.Event('muster:search-chats'));await delay(40);
assert.ok(isSpotlightSearchOpen(),'the Search chats command opens Spotlight');
assert.ok(!document.querySelector('.nav-search'),'no inline search field appears in the sidebar');
closeSpotlightSearch();await delay(20);
await store.selectChat('one');await delay(40);
const group=main('two').closest('.nav-section')!.querySelector('.nav-disclosure') as HTMLButtonElement;group.click();await delay(30);assert.equal(group.getAttribute('aria-expanded'),'false');
await store.selectChat('two');await delay(45);
assert.equal(group.getAttribute('aria-expanded'),'true');assert.equal(scrolls.at(-1),'two');
const count=scrolls.length;listener({type:'snapshot',snapshot:{...snapshot(),chats:chats.map(chat=>({...chat,updatedAt:'stream-update'}))}});await delay(35);assert.equal(scrolls.length,count,'stream updates do not force sidebar scrolling');
const selected=document.querySelector('[data-chat-id="two"] .chat-row-main')!;
const timelineReadsBeforeDoubleClick=calls.filter(call=>call.command==='chat.timeline').length;
selected.dispatchEvent(new window.Event('click',{bubbles:true}));selected.dispatchEvent(new window.Event('click',{bubbles:true}));selected.dispatchEvent(new window.Event('dblclick',{bubbles:true}));await delay(20);
assert.equal(calls.filter(call=>call.command==='chat.timeline').length,timelineReadsBeforeDoubleClick,'native double click on the active chat does not trigger redundant timeline reloads');
const doubleRename=document.querySelector('[aria-label="Chat title"]') as HTMLInputElement;
assert.ok(doubleRename,'double click on a chat title starts inline rename');assert.equal(doubleRename.value,'two');
const cancel=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(cancel,{key:'Escape'});doubleRename.dispatchEvent(cancel);await delay(30);
assert.ok(!document.querySelector('[aria-label="Chat title"]'),'Escape leaves double-click rename without saving');
contextMenuAction='main:pin';
const contextClick=new window.Event('contextmenu',{bubbles:true,cancelable:true});Object.assign(contextClick,{clientX:42,clientY:64});main('two').dispatchEvent(contextClick);await delay(35);
assert.ok(contextClick.defaultPrevented,'right click suppresses Chromium custom menu in favor of native macOS menu');
assert.ok(calls.some(call=>call.command==='chat.contextMenu'&&call.input.id==='two'&&call.input.x===42&&call.input.y===64&&call.input.surface==='sidebar'),'right click asks the native main-process menu at the pointer location');
assert.ok(chats.find(chat=>chat.id==='two')?.pinned,'a data action run by main reaches the sidebar through the snapshot');
assert.ok(document.querySelector('[aria-label="Unpin two"]'),'and the row reflects it');
contextMenuAction='rename';
const keyboard=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(keyboard,{key:'F10',shiftKey:true});document.querySelector('[data-chat-id="two"] .chat-row-main')!.dispatchEvent(keyboard);await delay(70);
assert.deepEqual(errors,[]);assert.ok(!document.querySelector('[role="menu"]'),'native menu is not redrawn as a custom renderer popover');
assert.ok(calls.some(call=>call.command==='chat.contextMenu'&&call.input.id==='two'),'Shift+F10 opens the native menu for the focused chat');
await delay(20);assert.ok(document.querySelector('[aria-label="Chat title"]'),'native Rename action enters the existing rename flow');
const rename=document.querySelector('[aria-label="Chat title"]') as HTMLInputElement;
const before=calls.filter(call=>call.command==='chat.update').length;
const escape=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(escape,{key:'Escape'});rename.dispatchEvent(escape);await delay(35);
assert.equal(calls.filter(call=>call.command==='chat.update').length,before,'Escape never submits rename on blur');
assert.ok(!document.querySelector('[aria-label="Chat title"]'));
contextMenuAction='activity';
const trigger=document.querySelector('[aria-label="Actions for two"]') as HTMLButtonElement;trigger.click();await delay(50);
assert.ok(store.getState().tabs.some(tab=>tab.id==='processes:two'),'Open Command Activity opens the chat under the pointer, not the active one');
contextMenuAction=null;
const markKey=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(markKey,{key:'U',metaKey:true,shiftKey:true,ctrlKey:false,altKey:false});window.dispatchEvent(markKey);await delay(30);
assert.ok(calls.some(call=>call.command==='chat.markUnread'&&call.input.id===store.getState().activeChatId&&call.input.unread===true),'Shift+Cmd+U marks the chat on screen unread');
const folderHead=document.querySelector('[aria-label="Actions for folder Folder"]')!.closest('.nav-section-head')!;
folderMenuAction='rename';
const folderClick=new window.Event('contextmenu',{bubbles:true,cancelable:true});Object.assign(folderClick,{clientX:5,clientY:9});folderHead.dispatchEvent(folderClick);await delay(40);
assert.ok(folderClick.defaultPrevented&&calls.some(call=>call.command==='folder.contextMenu'&&call.input.id==='folder'&&call.input.x===5),'folder rows open the native folder menu');
const folderInput=document.querySelector('[aria-label="Folder name for /fixture"]') as HTMLInputElement;assert.ok(folderInput,'Rename… edits the folder label in place');
folderInput.value='Client';(folderInput as any)._valueTracker?.setValue('');folderInput.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(10);
key(folderInput,{key:'Enter'});await delay(40);
assert.ok(calls.some(call=>call.command==='folder.rename'&&call.input.name==='Client'),'Enter saves the label');
assert.ok(document.querySelector('[aria-label="Actions for folder Client"]'),'and the head shows it');
folders=folders.map(folder=>({...folder,missing:true}));listener({type:'snapshot',snapshot:snapshot()});await delay(30);
const relink=Array.from(document.querySelectorAll<HTMLButtonElement>('.nav-relink')).find(button=>button.textContent==='Relink');assert.ok(relink,'a missing folder offers Relink in place');
folderMenuAction=null;relink!.click();await delay(30);
assert.ok(calls.some(call=>call.command==='folder.contextMenu'&&call.input.run==='relink'),'Relink goes straight to the relink dialog');
// --- UX-22: multiselect + batch actions ----------------------------------------------------------
const clickEvt=(target:Element,init:Record<string,unknown>={})=>{const event=new window.Event('click',{bubbles:true,cancelable:true});Object.assign(event,init);target.dispatchEvent(event);return event;};
const visibleChatIds=()=>Array.from(document.querySelectorAll<HTMLElement>('[data-chat-id]')).map(el=>el.dataset.chatId!);
const selectedRowIds=()=>Array.from(document.querySelectorAll('.chat-row.is-selected')).map(el=>(el as HTMLElement).dataset.chatId);
const order=visibleChatIds();
assert.ok(order.length>=3,'at least three live rows are on screen to exercise multiselect: '+order.join(','));
const activeBeforeSelect=store.getState().activeChatId!;
assert.ok(order.includes(activeBeforeSelect),'the active chat is one of the visible rows');
const rowA=order.find(id=>id!==activeBeforeSelect)!;
assert.ok(rowA,'a second, non-active row is visible');
const modClick=clickEvt(main(rowA),{metaKey:true,ctrlKey:false});await delay(20);
assert.ok(modClick.defaultPrevented,'a modified click never falls through to the plain-click open behaviour');
assert.equal(store.getState().activeChatId,activeBeforeSelect,'Cmd-click selects the row instead of opening it');
assert.ok(document.querySelector(`[data-chat-id="${rowA}"]`)!.classList.contains('is-selected'),'Cmd-click visibly selects the row');
assert.equal(document.querySelector(`[data-chat-id="${rowA}"] .chat-row-main`)?.getAttribute('aria-pressed'),'true','a selected row is a pressed toggle (aria-selected is invalid on a button)');
assert.equal(document.querySelector(`[data-chat-id="${rowA}"] .chat-row-main`)?.hasAttribute('aria-selected'),false);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'1 selected','the count bar shows the right count');
assert.equal(document.querySelector('[aria-live="polite"]')?.textContent,'1 chat selected','and an aria-live region announces it');
const rowB=order.find(id=>id!==rowA)!;
clickEvt(main(rowB),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'2 selected','a second Cmd-click adds to the selection');
assert.equal(document.querySelector('[aria-live="polite"]')?.textContent,'2 chats selected');
const rowC=order.find(id=>id!==rowA&&id!==rowB)!;
assert.ok(rowC,'a third row is visible for the range test');
clickEvt(main(rowC),{shiftKey:true});await delay(20);
const [lo,hi]=[order.indexOf(rowB),order.indexOf(rowC)].sort((a,b)=>a-b);
const expectedRange=order.slice(lo,hi+1);
assert.deepEqual(selectedRowIds().sort(),[...expectedRange].sort(),'Shift-click ranges from the anchor (rowB, the last Cmd-clicked row) to the clicked row, over the visible order — replacing the prior picks, not adding to them');
// A plain click keeps opening the chat and drops the selection.
clickEvt(main(rowA));await delay(30);
assert.equal(store.getState().activeChatId,rowA,'a plain click keeps opening the chat');
assert.equal(selectedRowIds().length,0,'and clears the selection');
assert.ok(!document.querySelector('.nav-selection-bar'),'the batch bar disappears with an empty selection');
assert.equal(document.querySelector('[aria-live="polite"]')?.textContent,'','and the live region falls silent');
// Esc clears a selection without touching the active chat.
clickEvt(main(rowB),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'1 selected');
key(window as any,{key:'Escape'});await delay(20);
assert.equal(selectedRowIds().length,1,'Escape outside the list (e.g. closing a dialog) keeps the selection');
key(main(rowB),{key:'Escape'});await delay(20);
assert.equal(selectedRowIds().length,0,'Escape in the list clears the selection');
assert.equal(store.getState().activeChatId,rowA,'Escape never touches navigation');
// Batch Archive calls chat.update for every selected chat, then clears the selection.
clickEvt(main(rowB),{metaKey:true,ctrlKey:false});clickEvt(main(rowC),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'2 selected');
const archivedBefore=calls.filter(call=>call.command==='chat.update'&&call.input.archived===true).length;
const noticesBefore=store.getState().notices.length;
(document.querySelector('[aria-label="Archive selected chats"]') as HTMLButtonElement).click();await delay(30);
// A working chat in the batch asks once for the whole batch (never one native dialog per chat).
const archiveConfirm=document.querySelector('[data-testid="sidebar-archive-confirm"]');
if([rowB,rowC].some(id=>chats.find(chat=>chat.id===id)?.status==='running')){
  assert.ok(archiveConfirm,'one confirmation when a selected chat is still working');
  Array.from(archiveConfirm!.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Archive')!.click();await delay(50);
} else assert.equal(archiveConfirm,null);
const archivedCalls=calls.filter(call=>call.command==='chat.update'&&call.input.archived===true);
assert.equal(archivedCalls.length,archivedBefore+2,'batch Archive calls chat.update once per selected chat');
assert.ok([rowB,rowC].every(id=>archivedCalls.some(call=>call.input.id===id)),'each selected chat id is archived: '+JSON.stringify(archivedCalls));
assert.ok(archivedCalls.slice(archivedBefore).every(call=>call.input.acknowledgeRunning===true),'the batch confirmed once, so main skips its per-chat dialog');
assert.equal(selectedRowIds().length,0,'archiving clears the selection');
assert.deepEqual(store.getState().notices.slice(noticesBefore).map(notice=>notice.message),['Archived 2 chats'],'one summary notice for the batch');
assert.ok(!document.querySelector('.nav-selection-bar'),'and the batch bar is gone');
// A selected chat deleted elsewhere (another window, the chat menu) leaves the selection: the count stays honest.
const liveIds=()=>visibleChatIds().filter(id=>chats.some(chat=>chat.id===id&&!chat.archived));
const [keepId,goneId]=liveIds();
clickEvt(main(keepId!),{metaKey:true,ctrlKey:false});clickEvt(main(goneId!),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'2 selected');
chats=chats.filter(chat=>chat.id!==goneId);listener({type:'snapshot',snapshot:snapshot()});await delay(30);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'1 selected','the deleted chat is pruned from the selection');
// Batch Delete with a partial failure: the chat that refused stays selected, the deleted one leaves.
const [otherId]=liveIds().filter(id=>id!==keepId);
clickEvt(main(otherId!),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(document.querySelector('.nav-selection-count')?.textContent,'2 selected');
refuseDelete=keepId!;
(document.querySelector('[aria-label="Delete selected chats"]') as HTMLButtonElement).click();await delay(20);
Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="sidebar-delete-confirm"] button')).find(button=>button.textContent==='Delete')!.click();await delay(60);
assert.ok(!chats.some(chat=>chat.id===otherId),'the deletable chat is deleted');
assert.deepEqual(selectedRowIds(),[keepId],'the chat that refused stays selected so it can be stopped or retried');
assert.ok(!document.querySelector('[data-testid="sidebar-delete-confirm"]'),'the confirm sheet closes');
refuseDelete='';key(main(keepId!),{key:'Escape'});await delay(20);
assert.equal(selectedRowIds().length,0);
// Space toggles the focused row; Cmd+A selects every visible chat; Shift-click with no anchor ranges from the open chat.
{
  const ids=visibleChatIds();
  key(main(ids[0]!),{key:' '});await delay(20);
  assert.deepEqual(selectedRowIds(),[ids[0]],'Space toggles the focused row into the selection');
  key(main(ids[0]!),{key:' '});await delay(20);
  assert.equal(selectedRowIds().length,0,'and out again');
  const isMac=/mac/i.test((globalThis as any).navigator?.platform||(globalThis as any).navigator?.userAgent||'');
  key(main(ids[0]!),{key:'a',metaKey:isMac,ctrlKey:!isMac});await delay(20);
  assert.deepEqual(selectedRowIds().sort(),[...ids].sort(),'Cmd/Ctrl+A selects every visible chat');
  key(main(ids[0]!),{key:'Escape'});await delay(20);
  const active=store.getState().activeChatId as string;const last=ids[ids.length-1] as string;const far=last===active?ids[0] as string:last;
  clickEvt(main(far),{shiftKey:true});await delay(20);
  const [from,to]=[ids.indexOf(active),ids.indexOf(far)].sort((a,b)=>a-b);
  assert.deepEqual(selectedRowIds().sort(),ids.slice(from,to+1).sort(),'Shift-click with no anchor ranges from the active chat');
  key(main(far),{key:'Escape'});await delay(20);
}
assert.deepEqual(errors,[]);
// CHAT-15 Snoozed group and Wake now · UX-12/UX-23 pin reorder and NAV-05 folder reorder through their keyboard
// equivalents (⌥⇧↑/⌥⇧↓ produce the same full-order commands a drop does).
{
  const baseInvoke=(window as any).muster.invoke;
  (window as any).muster.invoke=async(command:string,input:any)=>{
    if(command==='chat.wake'){calls.push({command,input});chats=chats.map(chat=>chat.id===input.id?{...chat,snoozedUntil:undefined}:chat);listener({type:'snapshot',snapshot:snapshot()});return chats.find(chat=>chat.id===input.id);}
    if(command==='chat.reorderPins'||command==='folder.reorder'){calls.push({command,input});return undefined;}
    return baseInvoke(command,input);
  };
  const extra=(id:string,patch:Record<string,unknown>)=>({id,title:id,folderId:undefined,status:'completed',updatedAt:twoHoursAgo,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',...patch});
  chats=[...chats.map(chat=>({...chat,pinned:false})),extra('p1',{pinned:true,pinOrder:1}),extra('p2',{pinned:true,pinOrder:2}),extra('zz',{snoozedUntil:new Date(Date.now()+86_400_000).toISOString(),draft:'kept'})];
  folders=[{id:'folder',name:'Folder',path:'/fixture'},{id:'second',name:'Second',path:'/second'}];
  listener({type:'snapshot',snapshot:snapshot()});await delay(40);
  assert.ok(sections().includes('Snoozed (1)'),'a snoozed chat waits in its own Snoozed group: '+JSON.stringify(sections()));
  assert.ok(!document.querySelector('.nav-section [data-chat-id="zz"] .chat-row-age'),'a snoozed row shows when it wakes instead of its age');
  assert.ok(document.querySelector('[data-chat-id="zz"] .chat-row-wake'));
  assert.equal(document.querySelector('[data-chat-id="p1"]')?.getAttribute('draggable'),'true','pinned rows are drag handles');
  assert.equal(document.querySelector('[data-folder-id="second"] .nav-section-head')?.getAttribute('draggable'),'true','folder headers are drag handles');
  (document.querySelector('[aria-label="Wake zz now"]') as HTMLButtonElement).click();await delay(40);
  assert.ok(calls.some(call=>call.command==='chat.wake'&&call.input.id==='zz'),'Wake now wakes through the runtime');
  assert.ok(!sections().some(title=>title?.startsWith('Snoozed')),'the Snoozed group goes away once empty');
  assert.ok(key(main('p1'),{key:'ArrowDown',altKey:true,shiftKey:true}).defaultPrevented);await delay(30);
  assert.deepEqual(calls.filter(call=>call.command==='chat.reorderPins').at(-1)?.input,{chatIds:['p2','p1']},'⌥⇧↓ moves a pin down one slot');
  const reorders=calls.filter(call=>call.command==='chat.reorderPins').length;
  key(main('p1'),{key:'ArrowUp',altKey:true,shiftKey:true});await delay(30);
  // The optimistic order already put p1 second; a further ⌥⇧↓ at the end is a no-op that sends nothing.
  key(main('p1'),{key:'ArrowDown',altKey:true,shiftKey:true});key(main('p1'),{key:'ArrowDown',altKey:true,shiftKey:true});await delay(30);
  assert.ok(calls.filter(call=>call.command==='chat.reorderPins').length>=reorders,'pin moves stay full-order commands');
  const folderToggle=document.querySelector('[data-folder-id="folder"] .nav-disclosure')!;
  assert.ok(key(folderToggle,{key:'ArrowDown',altKey:true,shiftKey:true}).defaultPrevented);await delay(30);
  assert.deepEqual(calls.filter(call=>call.command==='folder.reorder').at(-1)?.input,{folderIds:['second','folder']},'⌥⇧↓ on a folder header moves the folder down');
  assert.ok(!key(main('zz'),{key:'ArrowDown',altKey:true,shiftKey:true}).defaultPrevented,'an unpinned row has nothing to reorder');
  (window as any).muster.invoke=baseInvoke;
}
assert.deepEqual(errors,[]);
root.unmount();await delay(20);assert.deepEqual(errors,[]);
console.log('PASS: unread rows, folder menu, rename and relink, sidebar hierarchy, row age and hover actions, roving focus, draft New chat (no stray rows, folder/None targets, reuse, folder-row parity), draft composer parity (runtime default model, Plan mode, Goal, Full access acknowledgement, Sketch, per-folder access memory, / skills, @ files/folders/plugins), search command, double-click rename, selection reveal, stable streaming scroll, native context menu routing, authoritative pin and cancelled rename, multiselect (Cmd-click toggle, Shift-click range, count bar, aria-live announcements, Esc clears, plain click opens and clears, batch Archive, pruning deleted chats, partial-failure Delete keeps the refused chats selected)');
