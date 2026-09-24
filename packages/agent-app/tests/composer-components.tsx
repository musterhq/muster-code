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
const style={minHeight:'26px',maxHeight:'200px',borderTopWidth:'0px',borderBottomWidth:'0px',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px',getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;window.innerWidth=1200;window.innerHeight=800;
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
// SketchPad's canvas: linkedom has no real 2D context or toBlob; a stroke only needs React state (points are pushed
// directly, painting is skipped when getContext() returns null), and Attach only needs toBlob to hand back a Blob.
window.HTMLCanvasElement.prototype.getContext=()=>null;
(window.HTMLCanvasElement.prototype as any).toBlob=function(callback:(blob:Blob|null)=>void){callback(new Blob(['sketch'],{type:'image/png'}));};
let chat:any={id:'chat',title:'Composer test',folderId:'folder',draft:'Keep my draft',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',providerId:'hybrow',model:'shared-model'};
let staged=0;
let stashes:any[]=[];
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[{id:'folder',name:'Workspace',path:'/workspace'}],projects:[{id:'proj',name:'Launch',goal:'Ship v1',folderIds:['folder']}],version:1,activeChatId:'chat'});
const emit=()=>{for(const listener of listeners)listener({type:'snapshot',snapshot:snapshot()});};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow',available:true,models:[{id:'shared-model',name:'Shared model'}]},{id:'openai-direct',name:'OpenAI Direct',available:true,models:[{id:'shared-model',name:'Shared model'}]}];
  if(command==='chat.update'){chat={...chat,...input};emit();return chat;}
  if(command==='chat.setPermissionMode'){assert.ok(input.permissionMode!=='full'||input.acknowledgeFullAccess===true);chat={...chat,permissionMode:input.permissionMode};emit();return chat;}
  if(command==='chat.selectProvider'){chat={...chat,providerId:input.providerId,model:input.model};emit();return chat;}
  if(command==='plugins.list')return [{id:'/home/.codex/skills/pdf',name:'pdf',provenance:'~/.codex/skills',path:'/home/.codex/skills/pdf',readme:'Use pdf tools.',readError:null,displayName:'PDF Skill',shortDescription:'Create, edit, and review PDFs',icon:{kind:'image',dataUrl:'data:image/png;base64,AAAA'}}];
  if(command==='plugins.inventory')return [
    {id:'/cache/openai-curated/gmail/0.1.0',name:'gmail',version:'0.1.0',provenance:'openai-curated',path:'/cache/openai-curated/gmail/0.1.0',skills:[],mcpServers:[],apps:[],readError:null,displayName:'Gmail',shortDescription:'Read and manage Gmail',brandColor:'#EA4335',icon:{kind:'image',dataUrl:'data:image/png;base64,AAAA'}},
    {id:'/cache/openai-curated/heygen/4.0.0',name:'heygen',version:'4.0.0',provenance:'openai-curated',path:'/cache/openai-curated/heygen/4.0.0',skills:[],mcpServers:[],apps:[],readError:null,displayName:'HeyGen',shortDescription:'Create AI videos and avatars',icon:{kind:'monogram',text:'H',hue:12}}];
  if(command==='processes.list')return {chatId:input.chatId,sessions:[]};
  if(command==='files.search')return {entries:[{name:'note.md',path:'note.md',kind:'file'}],truncated:false};
  if(command==='chat.send')return {runId:'run'};
  if(command==='chat.create')return {id:'chat-bg',title:'',folderId:input.folderId??chat.folderId,pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',providerId:chat.providerId,model:chat.model,draft:''};
  if(command==='attachments.stage'){staged++;return {id:`att-${staged}`,chatId:input.chatId,name:input.name,mime:input.mime,size:Buffer.from(input.dataBase64,'base64').byteLength,kind:input.mime.startsWith('image/')?'image':'file',state:'staged'};}
  if(command==='attachments.list')return [];
  // A durable data: preview the composer swaps its blob: (or missing) thumbnail for once staging finishes (BLANK THUMBNAILS fix).
  if(command==='attachments.preview')return {dataUrl:`data:image/png;base64,DURABLE-${input.id}`};
  if(command==='chat.queue.add')return {id:`q-${input.requestId}`,text:input.text,requestId:input.requestId,attachmentIds:input.attachmentIds??[],createdAt:'',...(input.skillIds?{skillIds:input.skillIds}:{}),...(input.pluginIds?{pluginIds:input.pluginIds}:{}),...(input.effort?{effort:input.effort}:{})};
  if(command==='goals.set'){chat={...chat,goal:{chatId:'chat',text:input.text,status:'active',createdAt:'',startedAt:new Date(Date.now()-65_000).toISOString(),accumulatedMs:0,turns:0,maxTurns:20,updatedAt:''}};emit();return chat.goal;}
  if(command==='goals.pause'){chat={...chat,goal:{...chat.goal,status:'paused',reason:'user',startedAt:null,accumulatedMs:65_000}};emit();return chat.goal;}
  if(command==='goals.clear'){const {goal:_goal,...rest}=chat;chat=rest;emit();return undefined;}
  if(command==='skills.create')return {id:'/home/.codex/skills/weekly-report',slug:'weekly-report',path:'/home/.codex/skills/weekly-report/SKILL.md',replaced:false};
  if(command==='chat.steer')return {steered:false};
  if(command==='providers.usage')return [];
  // CMP-19 prompt stashes: an in-memory runtime.
  if(command==='stashes.save'){const stash={id:`stash-${stashes.length+1}`,name:input.name||input.text.split('\n')[0],text:input.text,chips:input.chips??[],context:input.context??[],...(input.effort?{effort:input.effort}:{}),attachments:(input.attachmentIds??[]).map((id:string)=>({id:`copy-${id}`,name:`${id}.txt`,mime:'text/plain',size:1,kind:'file'})),chatId:input.chatId,createdAt:'',updatedAt:new Date().toISOString()};stashes.unshift(stash);return stash;}
  if(command==='stashes.list')return {stashes:[...stashes]};
  if(command==='stashes.rename'){const stash=stashes.find(item=>item.id===input.id)!;stash.name=input.name.trim();return {...stash};}
  if(command==='stashes.delete'){stashes=stashes.filter(item=>item.id!==input.id);return undefined;}
  if(command==='stashes.restore'){const stash=stashes.find(item=>item.id===input.id)!;return {stash,attachments:stash.attachments.map((file:any)=>({id:`restaged-${file.id}`,chatId:input.chatId,name:file.name,mime:file.mime,size:file.size,kind:file.kind,state:'staged'}))};}
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {Composer}=await import('../src/renderer/components/Composer');
const {useStore}=await import('../src/renderer/useStore');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
let generation=0;
function Harness(){const state=useStore();return state.snapshot?<Composer key={generation} chat={state.snapshot.chats[0]}/>:null;}
const render=async()=>{root.render(<Harness/>);await delay(45);};
const click=async(selector:string)=>{const button=document.querySelector(selector) as HTMLButtonElement;assert.ok(button,selector);button.click();await delay(35);};
// Write through the native setter so React's value tracker sees a real edit, as typing would.
const type=async(element:HTMLInputElement,value:string)=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(35);};
const key=async(element:Element,value:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:value,...extra});element.dispatchEvent(event);await delay(35);return event;};
const pointer=async(element:Element,type:string,props:Record<string,unknown>={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientX:0,clientY:0,...props});element.dispatchEvent(event);await delay(20);};
await store.boot();await render();
assert.deepEqual(errors,[]);
const byTest=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLElement|null;
const rowLabels=()=>Array.from(document.querySelectorAll('[data-testid="composer-row"] .composer-row-label')).map(node=>node.textContent);
const headers=()=>Array.from(document.querySelectorAll('[data-testid="composer-popover"] .composer-menu-section')).map(node=>node.textContent);
// Layout: Codex toolbar, no mode picker, "Do anything".
assert.equal(document.querySelector('[aria-label^="Chat mode"]'),null,'no Agent/Ask/Plan mode picker');
assert.equal(byTest('composer-input')!.getAttribute('placeholder'),'Do anything');
const order=Array.from(document.querySelectorAll('[data-testid^="composer-"]')).map(node=>node.getAttribute('data-testid')).filter(id=>['composer-plus','composer-access','composer-model','composer-mic','composer-primary'].includes(id!));
assert.deepEqual(order,['composer-plus','composer-access','composer-model','composer-primary'],'mic is hidden because dictation is unavailable');
assert.equal(byTest('composer-primary')!.getAttribute('aria-label'),'Send (Enter)');
assert.equal(byTest('composer-access')!.getAttribute('aria-label'),'Access: Ask for approval');
// + menu: Add and Plugins sections, manifest icons or monograms, type-to-filter, Esc closes.
await click('[data-testid="composer-plus"]');await delay(30);
const plus=document.querySelector('[role="dialog"][aria-label="Add files and more"]') as HTMLElement;assert.ok(plus);
assert.deepEqual(headers(),['Add','Plugins','Skills']);
assert.deepEqual(rowLabels(),['Files and folders','Capture window','Work in a project','Goal','Plan mode','Record a skill','Save as skill','Sketch','Mention file or chat…','Start in background','Stash prompt','Stashes','Gmail','HeyGen','PDF Skill'],'Codex + menu order; every row works end to end');
const pluginRows=Array.from(plus.querySelectorAll('[data-testid="composer-row"]')).filter(row=>/Gmail|HeyGen/.test(row.textContent??''));
assert.ok(pluginRows[0].querySelector('img.item-icon'));assert.equal(pluginRows[1].querySelector('.item-monogram')?.textContent,'H');
await key(plus,'g');await key(plus,'m');
assert.deepEqual(rowLabels(),['Gmail']);
await key(plus,'Escape');assert.equal(document.querySelector('[aria-label="Add files and more"][role="dialog"]'),null);
const plusRow=async(label:string)=>{await click('[data-testid="composer-plus"]');await delay(30);const row=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(node=>node.querySelector('.composer-row-label')?.textContent===label);assert.ok(row,label);row!.click();await delay(50);};
// Work in a project: an empty chat moves into the chosen project and shows it in the toolbar.
await plusRow('Work in a project');
assert.ok(document.querySelector('[role="dialog"][aria-label="Work in a project"]'));
assert.deepEqual(rowLabels(),['Launch','New project…']);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(row=>row.textContent?.includes('Launch'))!).click();await delay(60);
assert.ok(calls.some(call=>call.command==='chat.update'&&call.input.projectId==='proj'));
assert.equal(byTest('composer-project')?.textContent,'Launch');
// Goal: + → Goal opens the editor in the strip slot; Enter sets it; the strip pauses and clears.
await plusRow('Goal');
const goalField=document.querySelector<HTMLTextAreaElement>('[data-testid="goal-editor"] textarea')!;assert.ok(goalField);
assert.equal(goalField.getAttribute('placeholder'),'Describe your goal, define measurable outcomes for best results');
await type(goalField as unknown as HTMLInputElement,'Ship the beta');await key(goalField,'Enter');await delay(40);
assert.ok(calls.some(call=>call.command==='goals.set'&&call.input.text==='Ship the beta'&&call.input.chatId==='chat'));
assert.ok(!byTest('goal-editor'));
let strip=byTest('goal-strip')!;assert.ok(strip);
assert.equal(strip.querySelector('.goal-strip-label')?.textContent,'Pursuing goal');assert.equal(strip.querySelector('.goal-strip-text')?.textContent,'Ship the beta');
assert.match(strip.querySelector('.goal-strip-time')?.textContent??'',/^1m 0[5-9]s$/,'elapsed time since the goal started');
await click('[aria-label="Expand goal"]');assert.match(byTest('goal-strip')!.querySelector('.goal-strip-meta')?.textContent??'',/0 automatic turns/);
await click('[aria-label="Pause goal"]');await delay(20);
strip=byTest('goal-strip')!;assert.equal(strip.querySelector('.goal-strip-label')?.textContent,'Paused goal');assert.ok(strip.querySelector('[aria-label="Resume goal"]'));
await click('[aria-label="Clear goal"]');await delay(20);assert.ok(!byTest('goal-strip'),'cleared');
// /goal opens the same editor with the rest of the draft.
store.setComposerDraft('chat','Finish the docs /goal');generation++;await render();
assert.equal(rowLabels()[0],'/goal');
await key(byTest('composer-input')!,'Enter');await delay(40);
assert.equal(document.querySelector<HTMLTextAreaElement>('[data-testid="goal-editor"] textarea')?.value,'Finish the docs');
await key(document.querySelector('[data-testid="goal-editor"] textarea')!,'Escape');assert.ok(!byTest('goal-editor'));
store.setComposerDraft('chat','Keep my draft');generation++;await render();
// Save as skill: a dialog drafts SKILL.md and saves through the runtime.
await plusRow('Save as skill');
const recordDialog=byTest('record-skill');assert.ok(recordDialog,'record dialog opens');
const [skillName,skillWhen]=Array.from(recordDialog!.querySelectorAll('input')) as HTMLInputElement[];
await type(skillName,'Weekly report');await type(skillWhen,'Use when summarising the week');
await type(recordDialog!.querySelector('textarea') as unknown as HTMLInputElement,'Collect updates.');
assert.match(recordDialog!.querySelector('.record-skill-path')?.textContent??'',/weekly-report\/SKILL\.md/);
(Array.from(recordDialog!.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Save skill')!).click();await delay(60);
assert.ok(calls.some(call=>call.command==='skills.create'&&call.input.name==='Weekly report'&&call.input.body==='Collect updates.'));
assert.ok(!byTest('record-skill'),'closes after saving');
assert.match(document.querySelector('.composer-status')?.textContent??'',/Saved skill \$weekly-report/);
// Sketch opens a drawing dialog; with nothing drawn it cannot attach.
await plusRow('Sketch');
const sketch=byTest('sketch-pad');assert.ok(sketch,'sketch dialog opens');
assert.equal((Array.from(sketch!.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Attach sketch')!).disabled,true);
assert.ok(sketch!.querySelector('[aria-label="Eraser"]'));assert.ok(sketch!.querySelector('[aria-label="Undo"]'));
(Array.from(sketch!.querySelectorAll<HTMLButtonElement>('button')).find(button=>button.textContent==='Cancel')!).click();await delay(60);assert.ok(!byTest('sketch-pad'));
// SKETCH REOPEN fix: a sketch tile's click reopens the Sketch editor (for more drawing), instead of
// AttachmentStrip's default "open in the resource pane" that a plain tile still gets (see CLICK TO OPEN below).
await plusRow('Sketch');
const drawCanvas=document.querySelector<HTMLCanvasElement>('[aria-label="Sketch canvas"]')!;assert.ok(drawCanvas);
await pointer(drawCanvas,'pointerdown',{clientX:10,clientY:10});
await pointer(drawCanvas,'pointermove',{clientX:40,clientY:40});
await pointer(drawCanvas,'pointerup',{clientX:40,clientY:40});
const attachSketchButton=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="sketch-pad"] button')).find(button=>button.textContent==='Attach sketch')!;
assert.equal(attachSketchButton.disabled,false,'a drawn stroke enables Attach');
attachSketchButton.click();await delay(60);
assert.ok(!byTest('sketch-pad'),'attaching closes the sketch dialog');
assert.ok(Array.from(document.querySelectorAll('[data-testid="attachment-tile"]')).some(tile=>tile.getAttribute('title')?.includes('Muster Sketch.png')),'the sketch joins the attachment strip');
const sketchOpen=document.querySelector<HTMLButtonElement>('[aria-label="Open Muster Sketch.png"]');assert.ok(sketchOpen,'a ready sketch tile is a real button, same as any other attachment');
const tabsBeforeSketch=store.getState().tabs.length;
sketchOpen!.click();await delay(30);
assert.equal(store.getState().tabs.length,tabsBeforeSketch,'clicking a sketch tile never opens it in the resource pane');
assert.ok(byTest('sketch-pad'),'it reopens the Sketch editor instead');
assert.equal(document.querySelector('[data-testid="sketch-pad"] .sketch-footer .is-primary')?.textContent,'Update sketch','editing the existing sketch, not starting a blank one');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="sketch-pad"] button')).find(button=>button.textContent==='Cancel')!).click();await delay(30);
assert.ok(!byTest('sketch-pad'));
await click('[aria-label="Remove Muster Sketch.png"]');await delay(20);
assert.equal(document.querySelectorAll('[data-testid="attachment-tile"]').length,0,'left clean for the attachment checks below');
assert.deepEqual(errors,[]);
// Leave no trace in `calls` (or the staged-id counter) either: the attachment checks below count/index
// attachments.* calls, and expect ids starting at att-1, from scratch.
for(let i=calls.length-1;i>=0;i--)if(calls[i].command.startsWith('attachments.'))calls.splice(i,1);
staged=0;
// + → Plugins → Gmail inserts the same chip as @.
await click('[data-testid="composer-plus"]');await delay(30);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(row=>row.textContent?.includes('Gmail'))!).click();await delay(40);
assert.equal(store.getState().composerDrafts.chat.text,'Keep my draft @gmail ');
assert.equal(document.querySelector('[data-testid="token-chip"]')?.textContent,'@gmail');
assert.ok(document.querySelector('[data-testid="token-chip"] img.item-icon'),'plugin chip carries the manifest icon');
// Plan mode is a + row toggle, shown as a removable chip; the access control greys out.
await click('[data-testid="composer-plus"]');await delay(30);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="composer-row"]')).find(row=>row.textContent?.includes('Plan mode'))!).click();await delay(50);
assert.equal(chat.mode,'plan');assert.ok(document.querySelector('.composer-plan-chip'));
assert.equal(byTest('composer-access')!.getAttribute('title'),'Plan mode runs read-only');
assert.equal(byTest('composer-input')!.getAttribute('placeholder'),'Describe your task to generate a plan…');
await key(byTest('composer-input')!,'Tab',{shiftKey:true});await delay(30);assert.equal(chat.mode,'agent','Shift+Tab toggles plan off');
// Model picker: provider rail, grouped list, reasoning effort in the trigger.
await click('[data-testid="composer-model"]');
assert.deepEqual(Array.from(document.querySelectorAll('.composer-model-rail [role="tab"]')).map(tab=>tab.getAttribute('aria-label')),['All providers','Hybrow','OpenAI Direct']);
assert.deepEqual(Array.from(document.querySelectorAll('.composer-model-list .composer-menu-section')).map(node=>node.textContent),['Hybrow','OpenAI Direct']);
const modelSearch=document.querySelector<HTMLInputElement>('[aria-label="Search models"]')!;
await type(modelSearch,'openai');
let modelChoices=Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-model-list [role="option"]'));
assert.equal(modelChoices.length,1,'search includes provider identity');
const favorite=document.querySelector<HTMLButtonElement>('[aria-label^="Add Shared model OpenAI Direct"]')!;assert.ok(favorite);favorite.click();await delay(20);
assert.equal(favorite.getAttribute('aria-pressed'),'true');
await type(modelSearch,'');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Reasoning effort"] [role="radio"]')).find(button=>button.textContent==='High')!).click();await delay(20);
assert.match(byTest('composer-model')!.textContent??'',/Shared modelHigh/);
assert.equal(byTest('composer-model')!.querySelector('.composer-effort-label')?.textContent,'High');
modelChoices=Array.from(document.querySelectorAll<HTMLButtonElement>('.composer-model-list [role="option"]'));
assert.equal(modelChoices.length,2,'same model id remains selectable from both providers');
modelChoices.find(button=>button.title.startsWith('OpenAI Direct'))!.click();await delay(40);
assert.ok(calls.some(call=>call.command==='chat.selectProvider'&&call.input.providerId==='openai-direct'&&call.input.model==='shared-model'));
// Access: three levels; Full needs confirmation and turns the label orange.
await click('[data-testid="composer-access"]');
assert.equal(document.querySelectorAll('[role="menuitemradio"]').length,3);
(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button=>button.textContent?.includes('Full access'))!).click();await delay(65);
assert.deepEqual(errors,[]);
assert.equal(document.querySelector('[role="menu"]'),null,'choosing Full access closes the menu for confirmation');
assert.equal(calls.some(call=>call.command==='chat.setPermissionMode'),false,'nothing changes before confirmation');
const allow=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='Turn on');
if(allow){allow.click();await delay(60);assert.ok(calls.some(call=>call.command==='chat.setPermissionMode'&&call.input.permissionMode==='full'&&call.input.acknowledgeFullAccess===true));}
else{chat={...chat,permissionMode:'full'};emit();await delay(40);}
const fullPill=document.querySelector('[aria-label="Access: Full access"]')!;assert.ok(fullPill);
assert.ok(fullPill.classList.contains('is-full'));assert.ok(fullPill.querySelector('.lucide-circle-alert'),'with the Codex warning icon');
// Legacy Ask chats read as read-only.
chat={...chat,mode:'ask'};emit();await delay(40);assert.ok(document.querySelector('[aria-label="Access: Read only"]'));
chat={...chat,mode:'agent'};emit();await delay(40);
// Slash: Skills then Commands; a skill pick inserts a chip, never navigates.
store.setComposerDraft('chat','/');generation++;await render();
assert.deepEqual(headers(),['Skills','Commands'],'/ lists only skills and built-in commands — plugins belong to @ and the + menu, not a second full dump here');
assert.ok(document.querySelector('[data-testid="composer-popover"] img.item-icon'),'skill manifest icon');
assert.ok(!rowLabels().some(label=>/^\/(agent|ask|skills|plugins|file)$/.test(label??'')));
store.setComposerDraft('chat','/pd');generation++;await render();
assert.equal(rowLabels()[0],'PDF Skill');
await key(byTest('composer-input')!,'Enter');await delay(30);
assert.equal(store.getState().composerDrafts.chat.text,'$pdf ');assert.equal(store.getState().screen,'work');
assert.equal(document.querySelector('[data-testid="token-chip"]')?.textContent,'$pdf');
store.setComposerDraft('chat','$pdf /pl');generation++;await render();
assert.equal(rowLabels()[0],'/plan','commands outrank a longer skill name');
await key(byTest('composer-input')!,'Enter');await delay(50);
assert.equal(chat.mode,'plan');assert.equal(store.getState().composerDrafts.chat.text,'$pdf ');
chat={...chat,mode:'agent'};emit();await delay(30);
store.setComposerDraft('chat','src/a');generation++;await render();assert.equal(byTest('composer-popover'),null,'a slash inside a word stays text');
store.setComposerDraft('chat','hello /mo');generation++;await render();assert.ok(byTest('composer-popover'),'mid-sentence slash opens');
await key(byTest('composer-input')!,'Escape');assert.equal(byTest('composer-popover'),null);assert.equal(store.getState().composerDrafts.chat.text,'hello /mo');
store.setComposerDraft('chat','/browser');generation++;await render();
const beforeTabs=store.getState().tabs.length;
await key(byTest('composer-input')!,'Enter',{isComposing:true});assert.equal(store.getState().tabs.length,beforeTabs);
await key(byTest('composer-input')!,'Enter');assert.equal(store.getState().tabs.length,beforeTabs+1);assert.equal(store.getState().composerDrafts.chat.text,'');
// @: files, folders and plugins; a plugin pick inserts a chip that invokes it on send.
store.setComposerDraft('chat','see @');generation++;await render();await delay(30);
assert.ok(headers().includes('Plugins'));assert.ok(document.querySelector('[role="listbox"][aria-label="Mention"] .item-monogram'),'no-icon plugin falls back to its monogram');
store.setComposerDraft('chat','mail me@example.com');generation++;await render();assert.equal(byTest('composer-popover'),null,'e-mail addresses never open @');
store.setComposerDraft('chat','$pdf see @gm');generation++;await render();await delay(240);
assert.equal(rowLabels()[0],'Gmail');
await key(byTest('composer-input')!,'Enter');await delay(30);
assert.equal(store.getState().composerDrafts.chat.text,'$pdf see @gmail ');
assert.equal(document.querySelectorAll('[data-testid="token-chip"]').length,2);
// Backspace right after a chip selects it first; the chip shows as selected.
const field=byTest('composer-input') as HTMLTextAreaElement;field.setSelectionRange(15,15);
await key(field,'Backspace');await delay(20);
assert.equal(field.selectionStart,9);assert.equal(field.selectionEnd,15);
field.dispatchEvent(new window.Event('select',{bubbles:true}));await delay(20);
assert.ok(document.querySelector('[data-testid="token-chip"].is-selected'));
field.setSelectionRange(16,16);field.dispatchEvent(new window.Event('select',{bubbles:true}));await delay(20);
await click('[data-testid="composer-primary"]');await delay(30);
let sent=calls.filter(call=>call.command==='chat.send').at(-1)!;
assert.equal(sent.input.text,'$pdf see @gmail ');assert.equal(sent.input.skillId,'/home/.codex/skills/pdf');assert.deepEqual(sent.input.pluginIds,['/cache/openai-curated/gmail/0.1.0']);assert.equal(sent.input.effort,'high');
// @ file pick inserts a file chip.
store.setComposerDraft('chat','see @no');generation++;await render();await delay(240);
assert.match(document.querySelector('[aria-label="Mention"]')!.textContent!,/note\.md/);
await key(byTest('composer-input')!,'Enter');
assert.equal(store.getState().composerDrafts.chat.text,'see @note.md ');
assert.equal(calls.filter(call=>call.command==='chat.send').length,1,'choosing a mention never sends');
// Pasting a file stages it and shows a tile; the send carries its id and clears the strip.
store.setComposerDraft('chat','with a file');generation++;await render();
const paste=async(clipboardData:any)=>{const event=new window.Event('paste',{bubbles:true,cancelable:true});Object.assign(event,{clipboardData});document.querySelector('textarea')!.dispatchEvent(event);await delay(60);return event;};
await paste({files:[new File(['hello'],'notes.txt',{type:'text/plain',lastModified:1})],items:[],getData:()=>''});
const stage=calls.find(call=>call.command==='attachments.stage')!;assert.ok(stage);
assert.equal(stage.input.name,'notes.txt');assert.equal(stage.input.dataBase64,'aGVsbG8=');assert.equal(stage.input.chatId,'chat');
assert.match(document.querySelector('[aria-label="Attachments"]')?.textContent??'',/notes\.txt.*5 B/);assert.ok(byTest('attachment-tile'));
await paste({files:[new File(['hello'],'notes.txt',{type:'text/plain',lastModified:1})],items:[],getData:()=>''});
assert.equal(calls.filter(call=>call.command==='attachments.stage').length,1,'the same file is attached once');
await click('[data-testid="composer-primary"]');await delay(20);
sent=calls.filter(call=>call.command==='chat.send').at(-1)!;assert.deepEqual(sent.input.attachmentIds,['att-1']);assert.equal(sent.input.text,'with a file');
assert.ok(!document.querySelector('[aria-label="Attachments"]'),'the strip clears after an acknowledged send');
await paste({files:[new File(['x'],'b.txt',{type:'text/plain',lastModified:2})],items:[],getData:()=>''});
await click('[aria-label="Remove b.txt"]');
assert.ok(calls.some(call=>call.command==='attachments.discard'&&call.input.id==='att-2'));
const big='x'.repeat(33*1024);
const bigPaste=await paste({files:[],items:[],getData:(type:string)=>type==='text/plain'?big:''});
assert.equal(bigPaste.defaultPrevented,true);
assert.ok(document.querySelector('[aria-label="Large paste"]'));
Array.from(document.querySelectorAll<HTMLButtonElement>('[aria-label="Large paste"] button')).find(button=>button.textContent==='Paste as attachment')!.click();await delay(60);
assert.match(calls.filter(call=>call.command==='attachments.stage').at(-1)!.input.name,/^Pasted text .*\.txt$/);
await click('[aria-label="Remove '+calls.filter(call=>call.command==='attachments.stage').at(-1)!.input.name+'"]');
// BLANK THUMBNAILS fix: once staging finishes, an image tile's preview swaps to the durable data: URL the runtime
// returns (there is no blob: URL to revoke in this harness either, since linkedom has no URL.createObjectURL —
// exactly the "no blob at all" case the fix also has to cover).
await paste({files:[new File(['img'],'photo.png',{type:'image/png',lastModified:3})],items:[],getData:()=>''});
await delay(30);
const previewCall=calls.find(call=>call.command==='attachments.preview');assert.ok(previewCall,'staging an image fetches a durable preview');
assert.equal(document.querySelector('.attachment-thumb')?.getAttribute('src'),`data:image/png;base64,DURABLE-${previewCall!.input.id}`,'the tile shows the durable preview, not a transient blob');
// CLICK TO OPEN fix: a ready tile is a real button; click or Enter/Space opens (and focuses) its attachment tab and
// unhides the resource pane, and removing the tile never also opens it.
const openPhoto=document.querySelector<HTMLButtonElement>('[aria-label="Open photo.png"]');assert.ok(openPhoto,'a ready tile is a button that opens it');
store.setResourcesHidden(true);
openPhoto!.click();await delay(20);
let opened=store.getState().tabs.find(t=>t.kind==='attachment'&&t.attachmentId===previewCall!.input.id);
assert.ok(opened,'clicking the tile opens a chat-scoped attachment tab');
assert.equal(opened!.title,'photo.png');assert.equal(store.getState().resourcesHidden,false,'opening it unhides the resource pane');
store.closeTab(opened!.id);
store.setResourcesHidden(true);
await key(openPhoto!,'Enter');await delay(20);
assert.ok(store.getState().tabs.some(t=>t.id===opened!.id),'Enter on the focused tile opens the same attachment');
store.closeTab(opened!.id);
store.setResourcesHidden(true);
await key(openPhoto!,'a');await delay(20);
assert.ok(!store.getState().tabs.some(t=>t.kind==='attachment'),'a non-activating key never opens it');
await click('[aria-label="Remove photo.png"]');await delay(20);
assert.ok(!store.getState().tabs.some(t=>t.kind==='attachment'),'removing the tile never opens it');
assert.ok(calls.some(call=>call.command==='attachments.discard'&&call.input.id===previewCall!.input.id));
// While running, Enter queues and Cmd+Enter steers with a queue fallback.
chat={...chat,status:'running',mode:'agent'};emit();await delay(35);
assert.ok(document.querySelector('.composer-run-spinner'),'run spinner left of the model');
assert.equal(byTest('composer-primary')!.getAttribute('aria-label'),'Stop','empty draft while running shows Stop');
store.setComposerDraft('chat','follow up');await delay(20);
let textarea=byTest('composer-input') as HTMLTextAreaElement;
assert.equal(textarea.getAttribute('placeholder'),'Working…');
assert.equal(byTest('composer-primary')!.getAttribute('aria-label'),'Queue (Enter) · Steer ⌘Enter');assert.ok(document.querySelector('.composer-stop.is-ghost'));
await key(textarea,'Enter');await delay(20);
const queued=calls.find(call=>call.command==='chat.queue.add')!;assert.ok(queued,'Enter while running queues');
assert.equal(queued.input.text,'follow up');
assert.equal(store.getState().composerDrafts.chat.text,'','queued text leaves the draft');
assert.ok(document.querySelector('[data-testid="queue-item"]')?.textContent?.includes('follow up'),'queued row appears immediately');
store.setComposerDraft('chat','steer now');await delay(20);
await key(byTest('composer-input')!,'Enter',{metaKey:true});await delay(30);
assert.ok(calls.some(call=>call.command==='chat.steer'&&call.input.text==='steer now'));
assert.ok(calls.some(call=>call.command==='chat.queue.add'&&call.input.text==='steer now'),'a refused steer falls back to the queue');
assert.match(document.querySelector('.composer-status')?.textContent??'',/Queued: agent could not accept a steer right now/);
// Chips travel with queued messages and render on the queued row.
store.setComposerDraft('chat','/pd');generation++;await render();
await key(byTest('composer-input')!,'Enter');await delay(30);
store.setComposerDraft('chat','$pdf queued with a skill');await delay(20);
await key(byTest('composer-input')!,'Enter');await delay(40);
const chipQueued=calls.filter(call=>call.command==='chat.queue.add').at(-1)!;
assert.equal(chipQueued.input.text,'$pdf queued with a skill');assert.deepEqual(chipQueued.input.skillIds,['/home/.codex/skills/pdf']);assert.equal(chipQueued.input.effort,'high');
assert.deepEqual(Array.from(document.querySelectorAll('[data-testid="queue-chip"]')).map(node=>node.textContent),['PDF Skill','High']);
chat={...chat,queue:[{id:'q1',text:'first',requestId:'r1',attachmentIds:[],createdAt:''},{id:'q2',text:'second',requestId:'r2',attachmentIds:[],createdAt:'',pluginIds:['/cache/openai-curated/gmail/0.1.0']}]};emit();await delay(35);
assert.equal(document.querySelectorAll('[data-testid="queue-item"]')[1]?.querySelector('[data-testid="queue-chip"]')?.textContent,'Gmail');
assert.equal(document.querySelectorAll('[data-testid="queue-item"]').length,2);
(document.querySelectorAll<HTMLButtonElement>('[aria-label="Delete queued message"]')[1]).click();await delay(30);
assert.ok(calls.some(call=>call.command==='chat.queue.remove'&&call.input.queueId==='q2'));
chat={...chat,status:'running'};emit();await delay(35);
assert.equal((byTest('composer-access') as HTMLButtonElement).disabled,false,'access can change mid-run');
await click('[data-testid="composer-access"]');
assert.equal(document.querySelector('.composer-access-note')?.textContent,'Applies to the next turn');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button=>button.textContent?.includes('Read only'))!).click();await delay(50);
assert.ok(calls.some(call=>call.command==='chat.setPermissionMode'&&call.input.permissionMode==='read-only'));
assert.match(document.querySelector('.composer-status')?.textContent??'',/Access applies to the next turn/);
// Esc twice on an empty draft stops; once only hints.
store.setComposerDraft('chat','');await delay(20);
await key(byTest('composer-input')!,'Escape');assert.match(document.querySelector('.composer-status')?.textContent??'',/Press Esc again to stop/);
assert.equal(calls.filter(call=>call.command==='chat.stop').length,0);
await key(byTest('composer-input')!,'Escape');assert.equal(calls.filter(call=>call.command==='chat.stop').length,1);
chat={...chat,status:'stopping'};emit();await delay(35);
const stopping=byTest('composer-primary') as HTMLButtonElement;assert.equal(stopping.getAttribute('aria-label'),'Stopping run');assert.equal(stopping.disabled,true);
chat={...chat,status:'completed'};emit();await delay(35);
// CMP-13/RUN-06/CMP-18: a window-dispatched chip (terminal excerpt, quote, …) is taken by the focused composer as a context chip.
store.setComposerDraft('chat','');await delay(20);
const notTaken=window.dispatchEvent(new window.CustomEvent('muster:composer-add-context',{detail:{type:'terminal',label:'zsh 1',text:'$ npm test\nok',source:{kind:'terminal',terminalId:'t1',title:'zsh 1'}},cancelable:true}));
await delay(30);
assert.equal(notTaken,false,'the focused composer takes the chip (preventDefault)');
assert.ok(byTest('composer-context'),'the context strip appears');
assert.match(document.querySelector('[data-testid="context-chip"]')?.textContent??'',/zsh 1/);
await click('.context-chip-remove');
assert.equal(byTest('composer-context'),null,'removing the only chip clears the strip');
// An unrecognised chip is refused so other listeners (or the clipboard) can fall back.
const refused=window.dispatchEvent(new window.CustomEvent('muster:composer-add-context',{detail:{type:'nope',label:'x'},cancelable:true}));
assert.equal(refused,true,'not defaultPrevented when nothing usable was found');
// CHAT-17: "Start in background" sends the draft to a freshly created chat, in the same folder and model, and clears here.
store.setComposerDraft('chat','background message');await delay(20);
await plusRow('Start in background');await delay(60);
assert.ok(calls.some(call=>call.command==='chat.create'&&call.input.folderId==='folder'),'created in the same folder');
const bgSend=calls.filter(call=>call.command==='chat.send').at(-1)!;
assert.equal(bgSend.input.id,'chat-bg');assert.equal(bgSend.input.text,'background message');
assert.equal(store.getState().composerDrafts.chat.text,'','the draft here clears once the background chat is sent');
// CHAT-25: "Resume paused goal?" only pops up while this chat's surface is actually in view — it used to
// appear over the Memory screen (or any other) if the triggering send's response arrived after navigating
// away, since Composer stays mounted (just visually hidden) behind every other screen.
chat={...chat,goal:{chatId:'chat',text:'Ship the beta',status:'paused',reason:'user',createdAt:'g1',startedAt:null,accumulatedMs:65_000,turns:1,maxTurns:20,updatedAt:''}};emit();await delay(30);
store.setComposerDraft('chat','resume check');await delay(20);
store.openMemoryScreen(undefined);await delay(20);
assert.equal(store.getState().screen,'memory','left the chat surface before the send settles');
await click('[data-testid="composer-primary"]');await delay(40);
assert.ok(!document.querySelector('[data-testid="goal-resume"]'),'the dialog does not pop up over Memory');
store.closeSettings();await delay(20);
assert.equal(store.getState().screen,'work');
assert.ok(document.querySelector('[data-testid="goal-resume"]'),'and appears once back on the chat surface, since the offer is still relevant');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="goal-resume"] button')).find(button=>button.textContent==='Not now')!).click();await delay(20);
assert.ok(!document.querySelector('[data-testid="goal-resume"]'));
chat={...chat,goal:undefined};emit();await delay(20);
// CMP-19: ⌘⇧S stashes the draft (text + chips + effort) without sending and clears the composer.
const sendsBefore=calls.filter(call=>call.command==='chat.send').length;
store.setComposerDraft('chat','Refactor the parser\nand add tests');await delay(20);
await key(byTest('composer-input')!,'S',{metaKey:true,shiftKey:true});await delay(30);
const stashSave=calls.filter(call=>call.command==='stashes.save').at(-1)!;
assert.ok(stashSave,'⌘⇧S calls stashes.save');
assert.equal(stashSave.input.text,'Refactor the parser\nand add tests');assert.equal(stashSave.input.chatId,'chat');
assert.ok(Array.isArray(stashSave.input.chips)&&Array.isArray(stashSave.input.context)&&Array.isArray(stashSave.input.attachmentIds));
assert.equal(calls.filter(call=>call.command==='chat.send').length,sendsBefore,'stashing never sends');
assert.equal(store.getState().composerDrafts.chat.text,'','the composer clears once stashed');
// + › Stash prompt saves a second draft; + › Stashes lists both, newest first.
store.setComposerDraft('chat','Second idea');await delay(20);
await plusRow('Stash prompt');await delay(30);
assert.equal(stashes.length,2);assert.equal(store.getState().composerDrafts.chat.text,'');
await plusRow('Stashes');await delay(40);
const stashPanel=()=>byTest('composer-stashes');
assert.ok(stashPanel(),'the Stashes popover opens from the + menu');
const stashNames=()=>Array.from(stashPanel()!.querySelectorAll('.composer-stash-name')).map(node=>node.textContent);
assert.deepEqual(stashNames(),['Second idea','Refactor the parser']);
// Rename inline.
await click('[aria-label="Rename Refactor the parser"]');
const renameInput=stashPanel()!.querySelector('.composer-stash-rename') as HTMLInputElement;assert.ok(renameInput);
await type(renameInput,'Parser work');await key(renameInput,'Enter');await delay(30);
assert.deepEqual(calls.filter(call=>call.command==='stashes.rename').at(-1)!.input,{id:'stash-1',name:'Parser work'});
assert.deepEqual(stashNames(),['Second idea','Parser work']);
// Delete asks first.
await click('[aria-label="Delete Second idea"]');
assert.equal(calls.some(call=>call.command==='stashes.delete'),false,'the first click only asks');
await click('[aria-label="Confirm delete Second idea"]');
assert.deepEqual(calls.filter(call=>call.command==='stashes.delete').at(-1)!.input,{id:'stash-2'});
assert.deepEqual(stashNames(),['Parser work']);
// Esc closes; ⌘K "Stashes" (openStashes) reopens it.
await key(stashPanel()!,'Escape');await delay(20);
assert.equal(stashPanel(),null);
const {OPEN_STASHES_EVENT}=await import('../src/renderer/components/PromptStashes');
window.dispatchEvent(new window.CustomEvent(OPEN_STASHES_EVENT));await delay(40);
assert.ok(stashPanel(),'⌘K Stashes opens the list in the focused composer');
// Restore: text into the composer, attachments restaged into the strip, popover closes, the stash is kept.
stashes[0].attachments=[{id:'copy-a',name:'notes.txt',mime:'text/plain',size:5,kind:'file'}];
store.setComposerDraft('chat','Already typed');await delay(20);
(stashPanel()!.querySelector('.composer-stash-restore') as HTMLButtonElement).click();await delay(50);
assert.deepEqual(calls.filter(call=>call.command==='stashes.restore').at(-1)!.input,{id:'stash-1',chatId:'chat'});
assert.equal(store.getState().composerDrafts.chat.text,'Already typed\n\nRefactor the parser\nand add tests','restored text joins the draft');
assert.ok((document.querySelector('.composer-attachments')?.textContent??'').includes('notes.txt'),'the stashed file is back in the attachment strip');
assert.equal(stashPanel(),null);assert.equal(stashes.length,1);
store.setComposerDraft('chat','');await delay(20);
assert.deepEqual(errors,[]);root.unmount();await delay(15);
console.log('Composer component checks passed: Codex toolbar without a mode picker, + menu (Add/Plugins/Skills, icons, filter, plan toggle, project, goal strip, record a skill, sketch), mid-run access, access levels with confirmation, provider-grouped model picker with effort, / skills+commands chips, @ files/plugins chips with Backspace selection, structured send payload, attachments, queue/steer, Esc-Esc stop and stopping state.');
