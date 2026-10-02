import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
// Base UI's focus manager checks `instanceof KeyboardEvent` (and friends), which linkedom does not define.
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
const storage=new Map<string,string>();
let intervals=0;
const realSetInterval=globalThis.setInterval;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,
  localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,String(v));},removeItem:(k:string)=>{storage.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  setInterval:((fn:any,ms:number)=>{intervals++;return realSetInterval(fn,ms);}) as typeof setInterval});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return this._top??0;},set(v){this._top=v;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

/** "Sign in to Muster Server" (#285) in Settings › Integrations › Paperclip: the third option, waiting / cancel / signed-in / sign-out,
 *  every error in plain words, and that the existing options are unchanged. */
let config:any={mode:'off',baseUrl:'http://127.0.0.1:3100',hasToken:false,secureStorage:true,companyId:null,signedIn:null,signInNotice:null};
let signin:any={phase:'idle'};
const calls:{command:string;input:any}[]=[];
let listener:((e:any)=>void)|null=null;
let startError='';
(window as any).muster={subscribe(l:any){listener=l;return()=>{listener=null;};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.config.get')return config;
  if(command==='paperclip.signin.status')return signin;
  if(command==='paperclip.signin.start'){if(startError)throw new Error(startError);signin={phase:'waiting',baseUrl:input.baseUrl,approvalUrl:input.baseUrl+'/cli-auth/abc?token=secret',expiresAt:new Date(Date.now()+300000).toISOString()};return signin;}
  if(command==='paperclip.signin.cancel'){signin={phase:'cancelled',message:'Sign-in cancelled.'};return signin;}
  if(command==='paperclip.signin.signout'){config={...config,hasToken:false,signedIn:null};return {config,revoked:true};}
  if(command==='paperclip.test')return {ok:true,stage:'ok',message:'Connected to Paperclip 2026 (authenticated). 1 company.',companies:[{id:'c1',name:'MockCo',prefix:'MCK'}]};
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  if(command==='link.open')return undefined;
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {ConnectionPanel}=await import('../src/renderer/components/HubSetup');
const errors:unknown[]=[];
const text=(sel:string,scope:ParentNode=document)=>[...scope.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=async(el:Element|null|undefined,wait=80)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));await delay(wait);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent?.trim()??''));
const typeInto=async(el:Element,value:string)=>{const key=Object.keys(el).find(k=>k.startsWith('__reactProps'))!;Object.defineProperty(el,'value',{configurable:true,get:()=>value,set:()=>{}});(el as any)[key].onChange({target:el,currentTarget:el});await delay(40);};
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{errors.push(e);},onRecoverableError:e=>{errors.push(e);}});
root.render(<ConnectionPanel/>);
for(let i=0;i<40&&!document.querySelector('.ws-segmented');i++)await delay(40);
await delay(100);
// The existing options are unchanged and the new one sits beside them.
assert.deepEqual(text('.ws-segment-label'),['This Mac','Custom URL + API token','Sign in to Muster Server','Off']);
await click(button(/Custom URL/));
assert.ok(document.querySelector('input[type=password]'),'the token field is still there for Custom URL');
assert.ok(!button(/Sign in to Muster Server$/),'no sign-in button on the token option');
// Sign in: URL, then the button.
await click(button(/Approve in your browser/)!);
assert.ok(!document.querySelector('input[type=password]'),'sign-in takes no token');
assert.ok(button(/Sign in to Muster Server$/)?.hasAttribute('disabled'),'needs a URL first');
await typeInto(document.querySelector('input[type=url]')!,'https://paperclip.example.test');
await click(button(/Sign in to Muster Server$/));
assert.equal(calls.find(c=>c.command==='paperclip.signin.start')?.input.baseUrl,'https://paperclip.example.test');
const opened=calls.find(c=>c.command==='link.open');
assert.equal(opened?.input.url,'https://paperclip.example.test/cli-auth/abc?token=secret','the approval page opens in the system browser');
assert.match(document.body.textContent!,/Waiting for you to approve in your browser…/);
assert.match(document.body.textContent!,/expires at/);
assert.ok(button(/^Cancel$/),'Cancel while waiting');
assert.ok(!button(/Test connection/),'no test while waiting');
await click(button(/^Cancel$/));
assert.match(document.body.textContent!,/Sign-in cancelled\./);
assert.ok(!document.body.textContent!.includes('Waiting for you'));
// Approved in the browser: the runtime says so, the panel shows who you are.
signin={phase:'waiting',baseUrl:'https://paperclip.example.test',approvalUrl:'https://paperclip.example.test/cli-auth/abc?token=secret',expiresAt:new Date(Date.now()+300000).toISOString()};
await click(button(/Sign in to Muster Server$/));
signin={phase:'signed-in',baseUrl:'https://paperclip.example.test',user:{name:'Test Founder',email:'founder@example.test'}};
config={mode:'custom',baseUrl:'https://paperclip.example.test',hasToken:true,secureStorage:true,companyId:null,signedIn:{name:'Test Founder',email:'founder@example.test'},signInNotice:null};
(listener as any)?.({type:'projectsWorkspaceChanged',scopes:['config'],taskIds:[]});
await delay(250);
assert.match(document.body.textContent!,/Signed in as Test Founder \(founder@example\.test\)\./);
assert.ok(button(/^Sign out$/)&&button(/Test connection/)&&button(/Import from Paperclip/));
assert.ok(calls.some(c=>c.command==='paperclip.test'),'the link is tested once after approval');
await click(button(/^Sign out$/));
assert.ok(calls.some(c=>c.command==='paperclip.signin.signout'));
assert.ok(!/Signed in as/.test(document.body.textContent!));
// Errors in plain words.
startError='Muster will not sign in over plain http to paperclip.example.test: the key would travel readable by anyone on the network. Use an https:// address.';
await typeInto(document.querySelector('input[type=url]')!,'http://paperclip.example.test');
assert.match(document.body.textContent!,/Sign in needs an https:\/\/ address/);
await click(button(/Sign in to Muster Server$/));
assert.match(text('.settings-error').join(' '),/will not sign in over plain http/);
config={...config,signedIn:null,hasToken:false,signInNotice:'Signed out by Muster Server — sign in again.'};
root.unmount();
const root2=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{errors.push(e);},onRecoverableError:e=>{errors.push(e);}});
root2.render(<ConnectionPanel/>);
await delay(300);
assert.match(document.body.textContent!,/Signed out by Muster Server — sign in again\./);
assert.ok(button(/Sign in to Muster Server$/),'the sign-in button is back');
assert.deepEqual(errors,[]);
root2.unmount();
console.log('paperclip-signin-dom: ok');
process.exit(0);
