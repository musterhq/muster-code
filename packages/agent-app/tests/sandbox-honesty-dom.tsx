/** #652/#653 DOM: raising access in a sandbox chat asks "Leave the sandbox?" first, and the Sandbox environment is offered
 *  only on models whose tools can use it. Never pass DOM nodes to assert.equal (heap cap). */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
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
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get:()=>40});
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{get:()=>600});
const style={minHeight:'26px',maxHeight:'200px',borderTopWidth:'0px',borderBottomWidth:'0px',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px',getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;window.innerWidth=1200;window.innerHeight=800;
(window.document as any).hasFocus=()=>true;
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},sessionStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});

let chat:any={id:'chat',title:'Sandboxed',folderId:'folder',draft:'',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'read-only',providerId:'codex',model:'gpt'};
let env:any={chatId:'chat',env:'sandbox',mode:'copy',ready:true,browser:'host'};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[{id:'folder',name:'Workspace',path:'/workspace'}],projects:[],version:1,activeChatId:'chat'});
const emit=(event:any)=>{for(const listener of listeners)listener(event);};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='providers.list')return [{id:'codex',name:'Codex',driver:'codex-app-server',available:true,identityMasked:'',models:[{id:'gpt',name:'GPT'}]},{id:'gem',name:'Gemini CLI',driver:'gemini-cli',available:true,identityMasked:'',models:[{id:'gemini',name:'Gemini'}]}];
  if(command==='sandbox.chatEnvironment.get')return env;
  if(command==='sandbox.chatEnvironment.set'){
    if(input.permissionMode==='full')assert.equal(input.acknowledgeFullAccess,true,'Full is acknowledged');
    env={...env,env:input.env};chat={...chat,permissionMode:input.permissionMode??chat.permissionMode};
    emit({type:'snapshot',snapshot:snapshot()});emit({type:'sandboxEnvironment',chatId:'chat',environment:env});return env;
  }
  if(command==='chat.setPermissionMode'){chat={...chat,permissionMode:input.permissionMode};emit({type:'snapshot',snapshot:snapshot()});return chat;}
  if(command==='git.info')return {branch:'main',detached:false,fetchedAt:null,hasRemote:false,worktree:null};
  if(command==='git.worktree.list')return [];
  if(command==='plugins.list'||command==='plugins.inventory'||command==='attachments.list'||command==='providers.usage')return [];
  if(command==='processes.list')return {chatId:input.chatId,sessions:[]};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {Composer}=await import('../src/renderer/components/Composer');
const {EnvironmentFooter}=await import('../src/renderer/components/EnvironmentFooter');
const {useStore}=await import('../src/renderer/useStore');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
function Harness(){const state=useStore();const current=state.snapshot?.chats[0];return current?<><Composer chat={current}/><EnvironmentFooter chat={current} folder={{id:'folder',name:'Workspace',path:'/workspace'} as any}/></>:null;}
await store.boot();await store.loadProviders(true);
root.render(<Harness/>);await delay(150);
assert.deepEqual(errors,[]);
const byTest=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLElement|null;
const chip=()=>document.querySelector('.env-footer-trigger')?.textContent??'';
const sheet=()=>byTest('leave-sandbox-confirm');
const pick=async(label:string)=>{(document.querySelector('[data-testid="composer-access"]') as HTMLButtonElement).click();await delay(60);
  const item=Array.from(document.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')).find(button=>button.textContent?.includes(label));assert.ok(item,label);item!.click();await delay(80);};
const button=(label:string)=>Array.from(document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')).find(node=>node.textContent===label);
const changed=()=>calls.filter(call=>call.command==='chat.setPermissionMode'||call.command==='sandbox.chatEnvironment.set');

// Spec: MUS-SPEC-06-665K (docs/spec/clauses/06-sandbox.md#mus-spec-06-665k)
await check('raising access in a sandbox chat asks to leave the sandbox first, and Cancel changes nothing',async()=>{
  assert.match(chip(),/Sandbox · Linux container/,'the chat starts in the sandbox: '+chip());
  assert.equal(calls.filter(call=>call.command==='sandbox.chatEnvironment.get').length,1,'the composer and the footer share one status request');

  // Workspace: asks first; Cancel keeps the sandbox and changes nothing.
  await pick('Ask for approval');
  assert.ok(sheet(),'"Leave the sandbox?" opens');
  assert.match(sheet()!.textContent??'',/Leave the sandbox\?/);
  assert.match(sheet()!.textContent??'',/Commands will run on this Mac with workspace access\./);
  assert.equal(changed().length,0,'nothing changes before confirming');
  button('Cancel')!.click();await delay(80);
  assert.equal(sheet(),null,'Cancel closes the sheet');
  assert.equal(changed().length,0,'Cancel changes nothing');
  assert.match(chip(),/Sandbox/,'Cancel keeps the sandbox');
  assert.ok(document.querySelector('[aria-label="Access: Read only"]'),'and the access level');

  // Confirming leaves the sandbox with the chosen level, and the chip updates.
  await pick('Ask for approval');
  button('Leave sandbox')!.click();await delay(120);
  assert.deepEqual(changed().map(call=>[call.command,call.input]),[['sandbox.chatEnvironment.set',{chatId:'chat',env:'host',permissionMode:'workspace'}]],'one call leaves and raises');
  assert.match(chip(),/This Mac/,'the chip updates: '+chip());
  assert.ok(document.querySelector('[aria-label="Access: Ask for approval"]'));

  // Full: "Leave the sandbox?" names full access, then the usual Full access confirmation still applies.
  env={...env,env:'sandbox'};chat={...chat,permissionMode:'read-only'};emit({type:'snapshot',snapshot:snapshot()});emit({type:'sandboxEnvironment',chatId:'chat',environment:env});await delay(80);
  calls.length=0;
  await pick('Full access');
  assert.match(sheet()?.textContent??'',/Commands will run on this Mac with full access\./);
  button('Leave sandbox')!.click();await delay(100);
  assert.equal(changed().length,0,'Full still waits for its own confirmation');
  const turnOn=button('Turn on');assert.ok(turnOn,'the Full access confirmation follows');
  turnOn!.click();await delay(120);
  assert.deepEqual(changed().map(call=>call.input),[{chatId:'chat',env:'host',permissionMode:'full',acknowledgeFullAccess:true}]);
  assert.match(chip(),/This Mac/);
});

// Spec: MUS-SPEC-06-665L (docs/spec/clauses/06-sandbox.md#mus-spec-06-665l)
await check('a sandbox chat on a model whose tools cannot use the sandbox is warned, and the Sandbox choice is disabled with the reason',async()=>{
  // A model whose tools can't use the sandbox: a sandbox chat says so plainly in the composer and the footer menu.
  env={...env,env:'sandbox'};chat={...chat,permissionMode:'read-only',providerId:'gem',model:'gemini'};emit({type:'snapshot',snapshot:snapshot()});emit({type:'sandboxEnvironment',chatId:'chat',environment:env});await delay(100);
  assert.match(byTest('sandbox-route-warning')?.textContent??'',/This model’s tools can’t run in the sandbox yet\. They run on this Mac, read-only\./);
  assert.ok(document.querySelector('.env-footer-trigger.is-warn'),'the Sandbox chip warns');
  // A host chat on that model: Sandbox is disabled with the reason.
  env={...env,env:'host'};emit({type:'sandboxEnvironment',chatId:'chat',environment:env});await delay(80);
  assert.equal(byTest('sandbox-route-warning'),null,'no composer warning for a host chat');
  (document.querySelector('.env-footer-trigger') as HTMLButtonElement).click();await delay(120);
  const sandboxItem=Array.from(document.querySelectorAll<HTMLElement>('.env-menu-item')).find(node=>node.querySelector('.env-menu-text')?.textContent==='Sandbox');
  assert.ok(sandboxItem,'the Sandbox row is listed');
  assert.equal(sandboxItem!.getAttribute('aria-disabled'),'true','and disabled');
  assert.match(byTest('sandbox-route-note')?.textContent??'',/This model’s tools can’t run in the sandbox yet\./);
  sandboxItem!.click();await delay(60);
  assert.equal(calls.some(call=>call.command==='sandbox.chatEnvironment.set'&&call.input.env==='sandbox'),false,'clicking it does nothing');

  // A model that can: the menu says what runs where.
  chat={...chat,providerId:'codex',model:'gpt'};env={...env,env:'sandbox'};emit({type:'snapshot',snapshot:snapshot()});emit({type:'sandboxEnvironment',chatId:'chat',environment:env});await delay(120);
  assert.match(byTest('sandbox-runs-where')?.textContent??'',/Commands and file edits the agent makes with sandbox tools run in a Linux container, on an isolated copy of the folder\. The agent can still read files on this Mac\./);
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('sandbox-honesty-dom ok');
process.exit(0);
