// S3-A composer completeness (DOM): pending-question panel (1–9, Next/Submit, typed custom answer), ⌘⇧Enter first
// queued, queued-message Undo, queueing toggle, /status /mcp /init /review, Connectors & MCP in +, Terminals pill,
// plugin defaultPrompt hint, Full access "Don't ask again" (and Ask again in Settings), themed plugin icons.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;window.getSelection=()=>({anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});
let focused:any=window.document.body;
Object.defineProperty(window.document,'activeElement',{get:()=>focused});
window.HTMLElement.prototype.focus=function(){focused=this;this.dispatchEvent(new window.Event('focusin',{bubbles:true}));};
window.HTMLElement.prototype.blur=function(){focused=window.document.body;};
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get:()=>40});
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{get:()=>600});
const style={minHeight:'26px',maxHeight:'200px',borderTopWidth:'0px',borderBottomWidth:'0px',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px',getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',transitionDuration:'0s',transitionDelay:'0s',transitionProperty:'none',animationDuration:'0s',direction:'ltr',overflowX:'visible',overflowY:'visible',paddingLeft:'0px',paddingRight:'0px'};
window.getComputedStyle=()=>style;window.innerWidth=1200;window.innerHeight=800;
const memory=new Map<string,string>();
const localStorage={getItem:(key:string)=>memory.has(key)?memory.get(key)!:null,setItem:(key:string,value:string)=>{memory.set(key,String(value));},removeItem:(key:string)=>{memory.delete(key);}};
Object.assign(window,{localStorage});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage,CustomEvent:window.CustomEvent,requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});

const question=(status:string)=>({id:'q-item',chatId:'chat',kind:'question',text:'',status,createdAt:'',data:{method:'item/tool/requestUserInput',questions:[
  {id:'db',header:'Database',question:'Which database should I use?',options:[{label:'Postgres',description:'Relational'},{label:'SQLite'}],allowCustomAnswer:true,multiSelect:false},
  {id:'name',header:'Name',question:'What should the service be called?',options:[],allowCustomAnswer:true,multiSelect:false},
]}});
let timeline:any[]=[question('pending')],revision=1;
let chat:any={id:'chat',title:'S3-A',folderId:'folder',draft:'',pinned:false,archived:false,status:'waiting',updatedAt:'',mode:'agent',permissionMode:'workspace',providerId:'claude',model:'m',providerThreadId:'thread-1'};
let agentsMd=false,gitFiles:string[]=['src/a.ts','README.md'];
let terminals:any[]=[{id:'t1',chatId:'chat',title:'zsh',cwd:'/w',shell:'zsh',owner:'user',status:'running',startedAt:'',exitCode:null}];
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[{id:'folder',name:'Workspace',path:'/workspace'}],projects:[],version:1,activeChatId:'chat'});
const emit=()=>{for(const listener of listeners)listener({type:'snapshot',snapshot:snapshot()});};
const plugin={id:'/cache/c/linear/1.0.0',name:'linear',version:'1.0.0',provenance:'c',path:'/cache/c/linear/1.0.0',skills:[],mcpServers:[{name:'linear-mcp',transport:'remote'}],apps:[{name:'Linear',id:'linear-app',required:false,category:'Productivity'}],readError:null,displayName:'Linear',defaultPrompts:['Triage my open issues'],
  icon:{kind:'image',dataUrl:'data:image/svg+xml;base64,TElHSFQ=',monochrome:true,darkDataUrl:'data:image/svg+xml;base64,REFSSw=='}};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:timeline,revision};
  if(command==='providers.list')return [{id:'claude',name:'Claude',available:true,models:[{id:'m',name:'Model M'}]}];
  if(command==='plugins.list')return [];
  if(command==='plugins.inventory')return [plugin];
  if(command==='mcp.servers.list')return [
    {id:'s1',name:'github',transport:'http',args:[],env:{},auth:{kind:'none'},scope:'user',scopeId:'',enabled:true,createdAt:'',updatedAt:'',health:{lastTestAt:'2026-09-23',ok:true,consecutiveFailures:0,toolCount:12},configKey:'github',healthy:true,loadedBy:[]},
    {id:'s2',name:'postgres',transport:'stdio',args:[],env:{},auth:{kind:'none'},scope:'user',scopeId:'',enabled:true,createdAt:'',updatedAt:'',health:{lastTestAt:'2026-09-23',ok:false,stage:'initialize',error:'timed out',consecutiveFailures:2},configKey:'postgres',healthy:false,loadedBy:[]},
    {id:'s3',name:'off',transport:'stdio',args:[],env:{},auth:{kind:'none'},scope:'user',scopeId:'',enabled:false,createdAt:'',updatedAt:'',health:{consecutiveFailures:0},configKey:'off',healthy:false,loadedBy:[]}];
  if(command==='terminal.list')return terminals;
  if(command==='processes.list')return {chatId:input.chatId,sessions:[]};
  if(command==='processes.summary')return {revision:1,sessions:[{chatId:'chat',processId:'p1',label:'npm run dev',purpose:'server',status:'running',startedAt:'',updatedAt:''}]};
  if(command==='question.respond'){timeline=[question('answered')];revision++;return undefined;}
  if(command==='chat.queue.steer')return {steered:false,started:true};
  if(command==='chat.queue.remove'){chat={...chat,queue:chat.queue.filter((item:any)=>item.id!==input.queueId)};emit();return undefined;}
  if(command==='chat.queue.add'){const item={id:`q-${calls.length}`,text:input.text,requestId:input.requestId,attachmentIds:[],createdAt:''};chat={...chat,queue:[...(chat.queue??[]),item]};emit();return item;}
  if(command==='chat.queue.reorder'){chat={...chat,queue:input.queueIds.map((id:string)=>chat.queue.find((item:any)=>item.id===id))};emit();return undefined;}
  if(command==='chat.contextTelemetry')return {usedTokens:84_000,windowTokens:200_000,source:'live',compacted:false,updatedAt:''};
  if(command==='files.read'){if(agentsMd)return {path:'AGENTS.md',text:'# Guide',truncated:false};throw new Error('ENOENT');}
  if(command==='git.status')return {branch:'main',detached:false,unborn:false,revision:'r',files:gitFiles.map(path=>({path,index:'M',worktree:' ',staged:false,untracked:false,conflict:false})),truncated:false,stagedCount:0,conflicted:false};
  if(command==='chat.send')return {runId:'run'};
  if(command==='chat.setPermissionMode'){assert.ok(input.permissionMode!=='full'||input.acknowledgeFullAccess===true);chat={...chat,permissionMode:input.permissionMode};emit();return chat;}
  if(command==='attachments.list')return [];
  if(command==='providers.usage')return [];
  if(command==='files.list')return [];
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {Composer}=await import('../src/renderer/components/Composer');
const {PendingQuestion}=await import('../src/renderer/components/PendingQuestion');
const {FullAccessSkips}=await import('../src/renderer/components/FullAccessConfirm');
const {PluginIcon}=await import('../src/renderer/components/PluginIcon');
const {useStore}=await import('../src/renderer/useStore');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
let generation=0;
function Harness(){const state=useStore();if(!state.snapshot)return null;const current=state.snapshot.chats[0];const item=state.timelines[current.id]?.value?.find(entry=>entry.kind==='question');
  return <>{item&&<PendingQuestion item={item}/>}<Composer key={generation} chat={current}/><FullAccessSkips folders={state.snapshot.folders}/></>;}
const render=async()=>{root.render(<Harness/>);await delay(60);};
const byTest=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLElement|null;
const input=()=>byTest('composer-input') as unknown as HTMLTextAreaElement;
const key=async(element:Element,value:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:value,...extra});element.dispatchEvent(event);await delay(35);return event;};
// Write through the native setter so React's value tracker sees a real edit, as typing would.
const type=async(element:HTMLTextAreaElement,value:string)=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.selectionStart=element.selectionEnd=value.length;element.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(35);};
// A remount puts the caret at the end of the draft (as composer-components does), so / and @ popovers see it.
const setDraft=async(value:string)=>{store.setComposerDraft('chat',value);generation++;await render();};
const lastNote=()=>document.querySelector('.composer-status')?.textContent??'';
await store.boot();await store.selectChat('chat');await render();
assert.deepEqual(errors,[]);

// CS-B11-1/2: the pending question sits above the card; the timeline card points to it instead of a second form.
let panel=byTest('composer-question')!;assert.ok(panel,'panel above the card');
assert.ok(panel.nextElementSibling?.matches('[data-testid="composer"]'),'attached directly above the composer card');
assert.equal(panel.querySelector('.composer-question-title')?.textContent,'Database');
assert.equal(panel.querySelector('.composer-question-count')?.textContent,'1/2');
assert.ok(byTest('pending-question-hosted'),'the timeline card defers to the panel');
assert.equal(input().getAttribute('placeholder'),'Type your own answer, or leave blank to use the selected option');
assert.deepEqual(Array.from(panel.querySelectorAll('kbd')).map(node=>node.textContent),['1','2']);
// `2` picks SQLite and auto-advances after 200 ms; ↑ history stays off while answering.
await key(input(),'2');
assert.equal(byTest('composer-question')!.querySelector('[aria-checked="true"]')?.textContent,'SQLite');
await delay(260);
panel=byTest('composer-question')!;assert.equal(panel.querySelector('.composer-question-count')?.textContent,'2/2');
assert.equal(input().getAttribute('placeholder'),'Type your answer','free-text question');
assert.equal(panel.querySelector('[data-testid="composer-question-next"]')?.textContent,'Submit');
// Previous goes back with the pick kept; Next returns.
(Array.from(panel.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Previous')!).click();await delay(30);
assert.equal(byTest('composer-question')!.querySelector('.composer-question-count')?.textContent,'1/2');
(byTest('composer-question-next') as HTMLButtonElement).click();await delay(30);
assert.equal(byTest('composer-question')!.querySelector('.composer-question-count')?.textContent,'2/2');
// Enter with nothing typed on a free-text question explains instead of sending.
await key(input(),'Enter');
assert.match(byTest('composer-question')!.querySelector('.composer-question-error')?.textContent??'',/Type an answer first/);
assert.equal(calls.some(call=>call.command==='question.respond'),false);
// The textarea is the custom answer: Enter submits every answer and clears the composer.
await type(input(),'billing-api');
await key(input(),'Enter');await delay(40);
const respond=calls.find(call=>call.command==='question.respond')!;assert.ok(respond);
assert.deepEqual(respond.input,{id:'q-item',answers:{db:{answers:['SQLite']},name:{answers:['billing-api']}}});
assert.equal(store.getState().composerDrafts.chat?.text??'','','the used answer leaves the composer');
assert.ok(!calls.some(call=>call.command==='chat.send'),'answering never sends a chat message');
await store.selectChat('chat');await delay(60);
assert.equal(byTest('composer-question'),null,'answered: the panel goes away');
assert.equal(byTest('pending-question-hosted'),null,'the timeline shows the settled card again');
assert.equal(input().getAttribute('placeholder'),'Do anything');
// The send arrow is Submit too while a question waits: a typed answer never goes out as a chat message.
timeline=[{...question('pending'),id:'q-two',data:{method:'item/tool/requestUserInput',questions:[{id:'why',header:'Why',question:'Why?',options:[],allowCustomAnswer:true,multiSelect:false}]}}];revision++;
await store.selectChat('chat');await delay(60);assert.ok(byTest('composer-question'));
await type(input(),'Because');(byTest('composer-primary') as HTMLButtonElement).click();await delay(50);
assert.deepEqual(calls.filter(call=>call.command==='question.respond').at(-1)!.input,{id:'q-two',answers:{why:{answers:['Because']}}});
assert.ok(!calls.some(call=>call.command==='chat.send'||call.command==='chat.queue.add'));
timeline=[];revision++;await store.selectChat('chat');await delay(40);

// CS-A1-3: the Terminals pill counts running shells plus background commands and opens the Terminal pane.
const pill=byTest('composer-terminals')!;assert.ok(pill,'pill while terminals run');
assert.equal(pill.textContent,'2 Terminals');
assert.ok(pill.closest('.composer-options'),'in the composer footer');
pill.click();await delay(30);
assert.equal(store.getState().activeTabId,'processes:chat','opens this chat\'s Terminal pane');
terminals=[];listeners.forEach(listener=>listener({type:'terminalExit',id:'t1',code:0}));await delay(40);
assert.equal(byTest('composer-terminals')!.textContent,'1 Terminal','a shell exit re-reads the list');

// CS-B4-4: /status shows the chat id, context usage and rate-limit support.
const runSlash=async(command:string)=>{await setDraft(`/${command}`);await key(input(),'Enter');await delay(60);};
await runSlash('status');
const status=byTest('composer-info-status')!;assert.ok(status,'/status opens its card above the composer');
assert.match(status.textContent??'',/chat/);
assert.match(status.querySelector('[data-testid="status-context"]')?.textContent??'',/^42% used · 84\D?000 of \S+ tokens$/,'percent and token counts (grouping follows the locale)');
assert.match(status.textContent??'',/does not report rate limits/);
await key(document.body,'Escape');assert.equal(byTest('composer-info-status'),null,'Esc closes it');
// /mcp lists servers with their health and the plugin-bundled ones.
await runSlash('mcp');await delay(40);
const mcp=byTest('composer-info-mcp')!;assert.ok(mcp);
assert.deepEqual(Array.from(mcp.querySelectorAll('[data-testid="mcp-status-row"] .composer-info-state')).map(node=>node.textContent),['Ready · 12 tools','Failing at initialize · timed out','Disabled']);
assert.match(mcp.textContent??'',/linear-mcp/);
(mcp.querySelector('[aria-label="Close"]') as HTMLButtonElement).click();await delay(30);
// /init sends Codex's AGENTS.md prompt when there is none, and never overwrites an existing one.
await runSlash('init');
let send=calls.filter(call=>call.command==='chat.send').at(-1)!;assert.ok(send,'/init starts a real turn');
assert.match(send.input.text,/Generate a file named AGENTS\.md/);
assert.equal(store.getState().composerDrafts.chat?.text??'','','the /init token is consumed');
agentsMd=true;const sends=calls.filter(call=>call.command==='chat.send').length;
await runSlash('init');
assert.equal(calls.filter(call=>call.command==='chat.send').length,sends,'existing AGENTS.md: no turn');
assert.match(lastNote(),/AGENTS\.md already exists/);
// /review reviews the uncommitted files; a clean tree says so.
await runSlash('review');
send=calls.filter(call=>call.command==='chat.send').at(-1)!;
assert.match(send.input.text,/Review the current code changes/);assert.match(send.input.text,/- src\/a\.ts\n- README\.md/);
gitFiles=[];const reviews=calls.filter(call=>call.command==='chat.send').length;
await runSlash('review');
assert.equal(calls.filter(call=>call.command==='chat.send').length,reviews);assert.match(lastNote(),/No uncommitted changes/);

// CS-B1-7: Connectors & MCP in the + menu; a pick inserts an @mcp:/@app: chip.
await setDraft('');
(byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
const headers=Array.from(document.querySelectorAll('[data-testid="composer-popover"] .composer-menu-section')).map(node=>node.textContent);
assert.ok(headers.includes('Connectors & MCP'),'section present');
assert.ok(headers.indexOf('Connectors & MCP')>headers.indexOf('Plugins'),'below Plugins');
const connectorRows=()=>{const rows:HTMLButtonElement[]=[];let node=Array.from(document.querySelectorAll('.composer-menu-section')).find(header=>header.textContent==='Connectors & MCP')?.nextElementSibling;
  while(node&&!node.classList.contains('composer-menu-section')){rows.push(node as HTMLButtonElement);node=node.nextElementSibling;}return rows;};
assert.deepEqual(connectorRows().map(row=>`${row.querySelector('.composer-row-label')?.textContent}|${row.querySelector('.composer-row-badge')?.textContent}`),['github|MCP','postgres|MCP','linear-mcp|MCP','Linear|App'],'enabled servers, plugin servers and apps');
connectorRows()[0].click();await delay(50);
assert.equal(store.getState().composerDrafts.chat.text,'@mcp:github ');
assert.equal(document.querySelector('[data-testid="token-chip"]')?.getAttribute('data-kind'),'mcp');

// CS-B3-6: a plugin chip with a defaultPrompt shows it as a hint while nothing else is typed; Tab takes it.
await setDraft('');
(byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(row=>row.querySelector('.composer-row-label')?.textContent==='Linear'&&row.querySelector('img.item-icon'))!).click();await delay(50);
assert.equal(store.getState().composerDrafts.chat.text,'@linear ');
assert.equal(byTest('plugin-prompt-hint')?.textContent,'Triage my open issues');
await key(input(),'Tab');
assert.equal(store.getState().composerDrafts.chat.text,'@linear Triage my open issues');
assert.equal(byTest('plugin-prompt-hint'),null,'the hint goes once there is text');

// CS-C3-2: a manifest dark logo renders as a themed pair (CSS shows one); black-only marks keep their flag.
const icons=Array.from(document.querySelectorAll('[data-testid="token-chip"] img.item-icon'));
assert.deepEqual(icons.map(node=>node.className.includes('is-theme-dark')?'dark':node.className.includes('is-theme-light')?'light':'plain'),['light','dark']);
assert.ok(icons[0].className.includes('is-monochrome')&&!icons[1].className.includes('is-monochrome'),'the dark variant is never inverted');
root.render(<PluginIcon icon={{kind:'image',dataUrl:'data:image/png;base64,AAAA'}} name="Plain"/>);await delay(20);
assert.equal(document.querySelectorAll('img.item-icon').length,1,'no dark logo: a single image');
await render();

// CS-B8-2 + CR-15: ⌘⇧Enter sends the first queued item; Delete offers Undo that restores it at its index.
await setDraft('');
chat={...chat,status:'running',queue:[{id:'qa',text:'First follow-up',requestId:'ra',attachmentIds:[],createdAt:''},{id:'qb',text:'Second follow-up',requestId:'rb',attachmentIds:[],createdAt:''}]};emit();await delay(40);
await key(input(),'Enter',{metaKey:true,shiftKey:true});
assert.deepEqual(calls.filter(call=>call.command==='chat.queue.steer').at(-1)!.input,{id:'chat',queueId:'qa'});
assert.equal(lastNote(),'Sent the first queued message');
const deleteButtons=Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Delete queued message"]'));
deleteButtons[0].click();await delay(50);
assert.deepEqual(chat.queue.map((item:any)=>item.text),['Second follow-up']);
const undo=store.getState().notices.find(notice=>notice.message==='Queued message deleted')!;assert.ok(undo?.action,'Undo offered');
await undo.action!.run();await delay(50);
assert.deepEqual(chat.queue.map((item:any)=>item.text),['First follow-up','Second follow-up'],'restored at its old index');
assert.ok(store.getState().notices.some(notice=>notice.message==='Queued message restored'));
// CR-15: the queueing toggle flips the Follow-up behavior from the + menu while a turn runs.
(byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
const toggle=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(row=>row.querySelector('.composer-row-label')?.textContent==='Turn off queueing')!;assert.ok(toggle);
toggle.click();await delay(40);
assert.equal(store.getState().followUpMode,'steer');
(byTest('composer-plus') as HTMLButtonElement).click();await delay(60);
assert.ok(Array.from(document.querySelectorAll('[data-testid="composer-row"] .composer-row-label')).some(node=>node.textContent==='Turn on queueing'));
store.setFollowUpMode('queue');await key(document.querySelector('[role="dialog"][aria-label="Add files and more"]')!,'Escape');
chat={...chat,status:'completed',queue:undefined};emit();await delay(40);

// linkedom's click() never toggles a checkbox: flip it through the prototype setter (so React's tracker sees a change), then click.
const tick=async(box:HTMLInputElement)=>{box.checked=!box.checked;box.dispatchEvent(new window.Event('click',{bubbles:true}));await delay(25);};
// CS-B7-3: the confirmation offers "Don't ask again for <folder>" and hands the choice to its caller.
const {FullAccessConfirm}=await import('../src/renderer/components/FullAccessConfirm');
const {setFullAccessSkip}=await import('../src/renderer/components/composerMenus');
const dialogHost=document.createElement('div');document.body.appendChild(dialogHost);
const dialogRoot=createRoot(dialogHost);let confirmed:boolean|null=null;
dialogRoot.render(<FullAccessConfirm open folderName="Workspace" canRemember onOpenChange={()=>{}} onConfirm={remember=>{confirmed=remember;}}/>);await delay(60);
const dialog=byTest('full-access-confirm')!;assert.ok(dialog,'the shared confirmation');
const rememberRow=dialog.querySelector('[data-testid="full-access-remember"]')!;assert.match(rememberRow.textContent??'',/Don’t ask again for Workspace/);
const turnOn=()=>(Array.from(dialog.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Turn on')!).click();
turnOn();await delay(20);assert.equal(confirmed,false,'unchecked by default');
await tick(rememberRow.querySelector('input') as HTMLInputElement);
turnOn();await delay(20);assert.equal(confirmed,true,'checked: remember this folder');
dialogRoot.render(<FullAccessConfirm open onOpenChange={()=>{}} onConfirm={()=>{}}/>);await delay(40);
assert.equal(byTest('full-access-remember'),null,'no folder, no offer');
dialogRoot.unmount();dialogHost.remove();
// A remembered folder switches straight to Full access (still acknowledged to the runtime); Settings › Chat lists it
// with "Ask again", which brings the confirmation back.
const chooseLevel=async(level:string)=>{(byTest('composer-access') as HTMLButtonElement).click();await delay(40);(document.querySelector(`.composer-access-menu button.is-${level}`) as HTMLButtonElement).click();await delay(60);};
assert.equal(byTest('full-access-skips')?.textContent,'Muster asks before every switch to Full access.');
setFullAccessSkip('folder',true);await delay(30);
assert.deepEqual(JSON.parse(memory.get('muster.fullAccess.skipConfirm')!),['folder']);
assert.match(byTest('full-access-skips')?.textContent??'',/Workspace/,'Settings lists the folder');
await chooseLevel('full');
assert.equal(byTest('full-access-confirm'),null,'no dialog for a remembered folder');
assert.equal(chat.permissionMode,'full');
assert.equal(calls.filter(call=>call.command==='chat.setPermissionMode').at(-1)!.input.acknowledgeFullAccess,true,'the runtime still gets the acknowledgement');
await chooseLevel('workspace');assert.equal(chat.permissionMode,'workspace','switching down never asks');
(document.querySelector('[aria-label="Ask again before Full access in Workspace"]') as HTMLButtonElement).click();await delay(40);
assert.deepEqual(JSON.parse(memory.get('muster.fullAccess.skipConfirm')!),[]);
assert.equal(byTest('full-access-skips')?.textContent,'Muster asks before every switch to Full access.');
const setCalls=calls.filter(call=>call.command==='chat.setPermissionMode').length;
await chooseLevel('full');
assert.equal(calls.filter(call=>call.command==='chat.setPermissionMode').length,setCalls,'asks again: nothing changes before confirmation');
assert.equal(chat.permissionMode,'workspace');
// End to end in the chat: tick "Don't ask again", Turn on → Full access, remembered for the folder only after it applied.
const chatDialog=byTest('full-access-confirm')!;assert.ok(chatDialog,'the chat asks again');
await tick(chatDialog.querySelector('[data-testid="full-access-remember"] input') as HTMLInputElement);
(Array.from(chatDialog.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Turn on')!).click();await delay(80);
assert.equal(chat.permissionMode,'full');
assert.deepEqual(JSON.parse(memory.get('muster.fullAccess.skipConfirm')!),['folder']);
setFullAccessSkip('folder',false);

assert.deepEqual(errors,[]);root.unmount();await delay(15);
console.log('S3-A composer checks passed: pending-question panel (1–9 auto-advance, Previous/Next/Submit, typed custom answer, timeline defers), Terminals pill, /status, /mcp, /init, /review, Connectors & MCP chips, plugin defaultPrompt hint + Tab, themed plugin logos, ⌘⇧Enter first queued, queued Undo, queueing toggle, Full access Don’t ask again + Ask again.');
