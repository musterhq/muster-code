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
let chat:any={id:'chat',title:'Composer test',folderId:'folder',draft:'Keep my draft',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',providerId:'hybrow',model:'shared-model'};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[{id:'folder',name:'Workspace',path:'/workspace'}],projects:[],version:1,activeChatId:'chat'});
const emit=()=>{for(const listener of listeners)listener({type:'snapshot',snapshot:snapshot()});};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow',available:true,models:[{id:'shared-model',name:'Shared model'}]},{id:'openai-direct',name:'OpenAI Direct',available:true,models:[{id:'shared-model',name:'Shared model'}]}];
  if(command==='chat.update'){chat={...chat,...input};emit();return chat;}
  if(command==='chat.setPermissionMode'){assert.ok(input.permissionMode!=='full'||input.acknowledgeFullAccess===true);chat={...chat,permissionMode:input.permissionMode};emit();return chat;}
  if(command==='chat.selectProvider'){chat={...chat,providerId:input.providerId,model:input.model};emit();return chat;}
  if(command==='plugins.list')return [];
  if(command==='files.search')return {entries:[{name:'note.md',path:'note.md',kind:'file'}],truncated:false};
  if(command==='chat.send')return {runId:'run'};
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
const key=async(element:Element,value:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:value,...extra});element.dispatchEvent(event);await delay(35);return event;};
await store.boot();await render();
assert.deepEqual(errors,[]);
await click('[aria-label="Add context or open tools"]');
assert.match(document.querySelector('[role="menu"]')!.textContent!,/Reference a workspace file/);
assert.match(document.querySelector('[role="menu"]')!.textContent!,/Browse web/);
const menuItems=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
assert.ok(menuItems.some(button=>button.textContent?.includes('Local skills')));
assert.ok(menuItems.some(button=>button.textContent?.includes('Providers & models')));
assert.ok(!menuItems.some(button=>/attachment|upload/i.test(button.textContent??'')));
menuItems.find(button=>button.textContent?.includes('Browse web'))!.click();await delay(35);
assert.equal(store.getState().tabs.at(-1)?.kind,'browser');
assert.equal(store.getState().composerDrafts.chat?.text??chat.draft,'Keep my draft');
// Provider binding is atomic even when two providers advertise the same model ID.
await click('[aria-label="Model: Shared model"]');
const modelChoices=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="option"]'));
modelChoices.find(button=>button.textContent?.includes('OpenAI Direct'))!.click();await delay(40);
assert.ok(calls.some(call=>call.command==='chat.selectProvider'&&call.input.providerId==='openai-direct'&&call.input.model==='shared-model'));
// Access is unchanged until an explicit full-access confirmation is accepted.
await click('[aria-label="Agent access: Workspace"]');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button=>button.textContent?.includes('Full access'))!).click();await delay(65);
assert.deepEqual(errors,[]);
assert.ok(document.querySelector('[role="dialog"]'),document.body.innerHTML);
assert.match(document.querySelector('[role="dialog"]')!.textContent!,/execute commands without approval/);
assert.equal(calls.some(call=>call.command==='chat.setPermissionMode'),false);
const allow=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(button=>button.textContent==='Allow full access')!;assert.ok(allow);allow.click();await delay(60);
assert.ok(calls.some(call=>call.command==='chat.setPermissionMode'&&call.input.permissionMode==='full'&&call.input.acknowledgeFullAccess===true));
assert.equal(store.getState().composerDrafts.chat?.text??chat.draft,'Keep my draft');
// Ask remains read-only although the configured Agent policy is full.
chat={...chat,mode:'ask'};emit();await delay(40);assert.ok(document.querySelector('[aria-label="Agent access: Read-only"]'));
await click('[aria-label="Chat mode: ask"]');
(Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button=>button.textContent?.includes('Agent mode'))!).click();await delay(45);
assert.equal(chat.mode,'agent');
// A leading slash executes a command, preserving ordinary paths and IME input.
store.setComposerDraft('chat','/');generation++;await render();
const commandField=document.querySelector('textarea')!;
await key(commandField,'ArrowDown');assert.equal(document.querySelector('[aria-label="Composer commands"] [aria-selected="true"]')?.id,'composer-command-browser');
await key(commandField,'ArrowUp');assert.equal(document.querySelector('[aria-label="Composer commands"] [aria-selected="true"]')?.id,'composer-command-reference');
await key(commandField,'Escape');assert.equal(store.getState().composerDrafts.chat.text,'/');
store.setComposerDraft('chat','/browser');generation++;await render();
const field=document.querySelector('textarea') as HTMLTextAreaElement;field.setSelectionRange(field.value.length,field.value.length);
assert.ok(document.querySelector('[aria-label="Composer commands"]'));
const beforeTabs=store.getState().tabs.length;
await key(field,'Enter',{isComposing:true});assert.equal(store.getState().tabs.length,beforeTabs);
await key(field,'Enter');assert.equal(store.getState().tabs.length,beforeTabs+1);assert.equal(store.getState().composerDrafts.chat.text,'');
store.setComposerDraft('chat','/workspace/file.ts');generation++;await render();assert.equal(document.querySelector('[aria-label="Composer commands"]'),null);
store.setComposerDraft('chat','/plan');generation++;await render();const planField=document.querySelector('textarea')!;
await key(planField,'Escape');assert.equal(document.querySelector('[aria-label="Composer commands"]'),null);assert.equal(store.getState().composerDrafts.chat.text,'/plan');
chat={...chat,status:'running'};emit();await delay(35);
assert.equal((document.querySelector('[aria-label="Agent access: Full access"]') as HTMLButtonElement).disabled,true);
assert.equal((document.querySelector('[aria-label="Chat mode: agent"]') as HTMLButtonElement).disabled,true);
assert.ok(document.querySelector('[aria-label="Stop run"]'));
assert.deepEqual(errors,[]);root.unmount();await delay(15);
console.log('Composer component checks passed: real plus tools, atomic provider binding, full-access confirmation, mode/access separation, slash/IME/path handling, draft retention and running-state locks.');
