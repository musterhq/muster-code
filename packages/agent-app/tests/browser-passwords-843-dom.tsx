/** #843: the browser toolbar's key button offers the page's 1Password logins and asks main to fill the chosen one. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserEvent,BrowserLogins,BrowserState} from '../src/shared/browser-protocol';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}},
  CustomEvent:window.CustomEvent});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:400,y:80,width:500,height:600,top:80,left:400,right:900,bottom:680});
window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:BrowserEvent)=>void>();
let state:BrowserState={owner:'browser:one',profileId:'personal',revision:0,url:'about:blank',title:'',loading:false,canGoBack:false,canGoForward:false,visible:false,viewport:'fill',consoleCount:0,consoleErrors:0};
const chat={id:'chat',title:'Browser work',folderId:'repo',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'test',mode:'agent'};
const snapshot={chats:[chat],folders:[{id:'repo',name:'muster-fixture-repo',path:'/repo'}],projects:[],version:1,activeChatId:'chat'};
const LOGIN={id:'a'.repeat(26),vault:'v'.repeat(26),title:'Example',username:'ada@example.test',site:'example.test'};
let logins:BrowserLogins={manager:'1password',available:true,logins:[LOGIN]};
const emit=(patch:Partial<BrowserState>)=>{state={...state,...patch,revision:state.revision+1};for(const listener of listeners)listener({type:'browserState',state});};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='browser.open'){state={...state,owner:input.owner,profileId:input.profileId,url:input.url,revision:state.revision+1};return state;}
  if(command==='browser.status')return state;
  if(command==='app.snapshot')return snapshot;
  if(command==='browser.profiles')return [{id:'personal',label:'Personal',tabs:0}];
  if(command==='browser.passwords')return logins;
  if(command==='browser.fillLogin')return {title:'Example',filled:'login'};
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {BrowserTab}=await import('../src/renderer/components/BrowserTab');
const store=await import('../src/renderer/store');
await store.boot();await delay(20);
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<BrowserTab owner="browser:one" profileId="personal"/>);
for(let end=Date.now()+5000;Date.now()<end&&!errors.length&&!document.querySelector('[aria-label="Go back"]');)await delay(20);
// The page is ready only once main answered browser.open; a page emitted before that is replaced by the open reply.
for(let end=Date.now()+5000;Date.now()<end&&!errors.length&&!calls.some(call=>call.command==='browser.open');)await delay(20);
await delay(40);
emit({url:'https://example.test/login',title:'Sign in',loading:false});
// Logins can be filled only when the page tools are live (the same gate as the element picker).
for(let end=Date.now()+5000;Date.now()<end&&!errors.length&&(document.querySelector('[aria-label="Pick element for chat"]') as HTMLButtonElement|null)?.disabled!==false;)await delay(20);
const keyButton=()=>document.querySelector('[aria-label^="Fill a login"]') as HTMLButtonElement|null;

// Spec: MUS-SPEC-09-843F (docs/spec/clauses/09-browser-and-previews.md#mus-spec-09-843f)
await check('the key button lists matching logins and fills the chosen one',async()=>{
  assert.ok(keyButton(),'the toolbar has a key button');
  keyButton()!.click();
  for(let end=Date.now()+2000;Date.now()<end&&!/ada@example\.test/.test(document.querySelector('[role="menu"]')?.textContent??'');)await delay(20);
  assert.deepEqual(calls.find(call=>call.command==='browser.passwords')?.input,{owner:'browser:one'});
  const item=([...document.querySelectorAll('[role="menuitem"]')] as HTMLElement[]).find(entry=>/Example/.test(entry.textContent!) && /ada@example\.test/.test(entry.textContent!));
  assert.ok(item,'the menu lists the login with its username');
  item!.click();await delay(60);
  assert.deepEqual(calls.find(call=>call.command==='browser.fillLogin')?.input,{owner:'browser:one',id:LOGIN.id,vault:LOGIN.vault});
  assert.match(document.querySelector('.browser-notice')?.textContent??'',/Filled the Example login/);
  logins={manager:'1password',available:false,logins:[],message:'Install the 1Password CLI (op) and turn on its desktop app integration to fill logins.'};
  keyButton()!.click();
  for(let end=Date.now()+2000;Date.now()<end&&!/1Password CLI/.test(document.querySelector('[role="menu"]')?.textContent??'');)await delay(20);
  assert.match(document.querySelector('[role="menu"]')?.textContent??'',/1Password CLI/);
  assert.equal(calls.filter(call=>call.command==='browser.fillLogin').length,1);
  assert.deepEqual(errors,[]);
});
root.unmount();await delay(20);
process.exit(0);
