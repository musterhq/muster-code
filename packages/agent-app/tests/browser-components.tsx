/** Focused browser toolbar/lease DOM test: bundle with esbuild, CSS empty. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserEvent,BrowserState} from '../src/shared/browser-protocol';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}},
  CustomEvent:window.CustomEvent});
// Base UI menus (toolbar Viewport / Profile) read computed style while positioning and animating.
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:400,y:80,width:500,height:600,top:80,left:400,right:900,bottom:680});
window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:BrowserEvent)=>void>();
let state:BrowserState={owner:'browser:one',profileId:'personal',revision:0,url:'about:blank',title:'',loading:false,canGoBack:false,canGoForward:false,visible:false,viewport:'fill',consoleCount:0,consoleErrors:0};
const chat={id:'chat',title:'Browser work',folderId:'repo',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'test',mode:'agent'};
const snapshot={chats:[chat],folders:[{id:'repo',name:'muster-fixture-repo',path:'/repo'}],projects:[],version:1,activeChatId:'chat'};
const staged:any[]=[],contexts:any[]=[];
let opened=false; // Main has no record until browser.open, and none after browser.release.
let consoleLog=[{level:'error',message:'Uncaught TypeError: x is undefined',source:'https://example.test/app.js',line:12,at:1}];
const emit=(patch:Partial<BrowserState>)=>{state={...state,...patch,revision:state.revision+1};for(const listener of listeners)listener({type:'browserState',state});};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='browser.status'&&!opened)throw new Error('Browser tab is closed. Open it again to continue.');
  if(command==='browser.open'){opened=true;state={...state,owner:input.owner,profileId:input.profileId,url:input.url,revision:state.revision+1};return state;}
  if(command==='browser.navigate'){emit({url:input.url,loading:true});return state;}
  if(command==='browser.stop'){emit({loading:false});return state;}
  if(command==='browser.reload'){emit({loading:true});return state;}
  if(command==='browser.back'||command==='browser.forward'||command==='browser.status')return state;
  if(command==='app.snapshot')return snapshot;
  if(command==='browser.release'){opened=false;return undefined;}
  if(command==='browser.profiles')return [{id:'personal',label:'Personal',tabs:0},{id:'folder-repo',label:'muster-fixture-repo',tabs:1}];
  if(command==='browser.setViewport'){emit({viewport:input.preset});return state;}
  if(command==='browser.console'){if(input.clear)consoleLog=[];return consoleLog;}
  if(command==='browser.pickElement')return {url:'https://example.test/',selector:'main > button:nth-of-type(2)',tag:'button',outerHTML:'<button class="primary">Save</button>',truncated:false,text:'Save',rect:{x:1,y:2,width:30,height:20}};
  if(command==='browser.capture')return {dataUrl:'data:image/png;base64,iVBORw0KGgo=',width:10,height:10,url:'https://example.test/',title:'Example'};
  if(command==='attachments.stage'){staged.push(input);return {id:'att-1',chatId:input.chatId,name:input.name,mime:input.mime,size:8,kind:'image',state:'ready'};}
  if(command==='browser.download'){emit({download:input.action==='save'?{...state.download!,state:'saving'}:undefined});return state;}
  if(command==='browser.openExternal')return undefined;
}};
window.addEventListener('muster:composer-add-context',(event:any)=>{event.preventDefault();contexts.push(event.detail);}); // The composer acknowledges each chip.
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {BrowserTab}=await import('../src/renderer/components/BrowserTab');
const store=await import('../src/renderer/store');
await store.boot();await delay(20);
const storeListeners=listeners.size; // The store's own runtime subscription.
const errors:unknown[]=[];
const persisted:string[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const props={owner:'browser:one',profileId:'personal',onUrlChange:(url:string)=>persisted.push(url)};
root.render(<BrowserTab {...props}/>);await delay(60);
// BrowserTab is split into its own chunk; a slow runner can take longer than the first delay to load it.
for(let end=Date.now()+5000;Date.now()<end&&!errors.length&&!/Browse a website/.test(document.body.textContent??'');)await delay(20);
assert.deepEqual(errors,[]);
assert.match(document.body.textContent!,/Browse a website/);
// The store records 'personal'; the tab binds to the active chat's folder profile and remembers it.
assert.equal(calls.find(call=>call.command==='browser.open')?.input.profileId,'folder-repo');
assert.equal(calls.some(call=>call.command==='browser.release'),false,'a first open releases nothing');
assert.match(document.querySelector('.browser-profile')!.textContent!,/muster-fixture-repo profile/);
assert.equal(JSON.parse(storage.get('muster.browserProfiles')!)['browser:one'],'folder-repo');
assert.equal(calls.filter(call=>call.command==='browser.position').length,0,'blank page does not cover the empty address hint');
assert.equal((document.querySelector('[aria-label="Go back"]') as HTMLButtonElement).disabled,true);
emit({url:'https://example.test/',title:'Example',loading:false,canGoBack:true});await delay(40);
assert.deepEqual(persisted,['https://example.test/']);
emit({title:'Example title update'});await delay(20);
assert.deepEqual(persisted,['https://example.test/'],'title/loading revisions do not rewrite persisted navigation');
assert.ok(calls.some(call=>call.command==='browser.position'));
assert.equal((document.querySelector('[aria-label="Go back"]') as HTMLButtonElement).disabled,false);
(document.querySelector('[aria-label="Go back"]') as HTMLButtonElement).click();await delay(15);
assert.ok(calls.some(call=>call.command==='browser.back'));
const input=document.querySelector('[aria-label="Website address"]') as HTMLInputElement;
assert.equal(input.value,'https://example.test/');
(document.querySelector('form') as HTMLFormElement).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(30);
assert.ok(calls.some(call=>call.command==='browser.navigate'&&call.input.url==='https://example.test/'));
assert.ok(document.querySelector('[aria-label="Stop loading"]'));
(document.querySelector('[aria-label="Stop loading"]') as HTMLButtonElement).click();await delay(25);
assert.ok(calls.some(call=>call.command==='browser.stop'));
assert.ok(document.querySelector('[aria-label="Reload page"]'));
// App overlays detach the native surface, then restore it when the overlay closes.
const menu=document.createElement('div');menu.setAttribute('data-browser-overlay','');document.body.append(menu);await delay(35);
assert.equal(calls.at(-1)?.command,'browser.hide');
const positions=calls.filter(call=>call.command==='browser.position').length;
menu.remove();await delay(35);assert.ok(calls.filter(call=>call.command==='browser.position').length>positions);
emit({error:'Page load failed',loading:false});await delay(30);
assert.match(document.querySelector('.browser-error')!.textContent!,/Page load failed/);
assert.equal(calls.at(-1)?.command,'browser.hide');
emit({error:undefined});await delay(30);
window.dispatchEvent(new window.Event('focus'));await delay(30);
assert.ok(calls.some(call=>call.command==='browser.status'),'focus reconciles reports missed while the window was hidden');
const opens=calls.filter(call=>call.command==='browser.open').length;
root.render(<BrowserTab {...props} active={false}/>);await delay(35);
assert.equal(calls.at(-1)?.command,'browser.hide');
assert.equal(listeners.size,storeListeners,'inactive views unsubscribe and detach');
assert.equal(calls.filter(call=>call.command==='browser.open').length,opens);
root.render(<BrowserTab {...props} active/>);await delay(45);
const surfaces=calls.filter(call=>call.command==='browser.open').map(call=>call.input.surfaceId);
assert.notEqual(surfaces.at(-1),surfaces[0],'a remounted surface has a fresh lease');
// Page tools: console drawer with error badge, viewport preset, element pick and region capture into chat.
emit({url:'https://example.test/',consoleCount:1,consoleErrors:1});await delay(25);
assert.match(document.querySelector('.browser-badge')!.textContent!,/1/);
(document.querySelector('[aria-label="Console, 1 errors"]') as HTMLButtonElement).click();await delay(30);
assert.match(document.querySelector('.browser-console')!.textContent!,/Uncaught TypeError/);
(document.querySelector('[aria-label^="Viewport"]') as HTMLButtonElement).click();await delay(20);
assert.ok(document.querySelector('[role="menu"]'),'viewport menu opens');
([...document.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[]).find(item=>/Mobile/.test(item.textContent!))!.click();await delay(30);
assert.ok(calls.some(call=>call.command==='browser.setViewport'&&call.input.preset==='mobile'));
assert.ok(!document.querySelector('[role="menu"]'),'choosing a preset closes the menu');
assert.match(document.querySelector('.browser-load-status')!.textContent!,/Mobile · 390/);
(document.querySelector('[aria-label="Pick element for chat"]') as HTMLButtonElement).click();await delay(30);
assert.equal(contexts.length,1);assert.equal(contexts[0].type,'selection');
assert.match(document.querySelector('.browser-notice')!.textContent!,/Added <button>/);
assert.match(contexts[0].text,/Selector: main > button:nth-of-type\(2\)/);assert.equal(contexts[0].source.kind,'browser');
(document.querySelector('[aria-label="Capture region for chat"]') as HTMLButtonElement).click();await delay(40);
assert.ok(calls.some(call=>call.command==='browser.capture'&&call.input.select===true));
assert.equal(staged.length,1);assert.equal(staged[0].chatId,'chat');assert.equal(staged[0].mime,'image/png');assert.equal(staged[0].dataBase64,'iVBORw0KGgo=');
assert.equal(contexts[1].type,'image');assert.equal(contexts[1].attachment.id,'att-1');
// Downloads wait for a choice.
emit({download:{id:'d1',filename:'report.pdf',totalBytes:2048,receivedBytes:0,state:'pending'}});await delay(25);
assert.match(document.querySelector('[aria-label="Download"]')!.textContent!,/report\.pdf/);
([...document.querySelectorAll('[aria-label="Download"] button')] as HTMLButtonElement[]).find(button=>button.textContent==='Save to Downloads')!.click();await delay(25);
assert.ok(calls.some(call=>call.command==='browser.download'&&call.input.action==='save'&&call.input.id==='d1'));
// Certificate failures replace the page with an interstitial offering the system browser.
emit({download:undefined,certificateError:{url:'https://expired.test/',code:'net::ERR_CERT_DATE_INVALID'}});await delay(30);
assert.match(document.querySelector('.browser-interstitial')!.textContent!,/isn't private/);
assert.equal(calls.at(-1)?.command,'browser.hide','the native page never covers the interstitial');
([...document.querySelectorAll('.browser-interstitial button')] as HTMLButtonElement[]).find(button=>/default browser/.test(button.textContent!))!.click();await delay(20);
assert.ok(calls.some(call=>call.command==='browser.openExternal'));
emit({certificateError:undefined});await delay(20);
// Switching profile releases the page and reopens it in the chosen partition.
(document.querySelector('[aria-label^="Browser profile"]') as HTMLButtonElement).click();await delay(30);
([...document.querySelectorAll('[role="menuitemradio"]')] as HTMLButtonElement[]).find(item=>/Personal/.test(item.textContent!))!.click();await delay(60);
const release=calls.findIndex(call=>call.command==='browser.release');
assert.ok(release>0,'the old page is released first');
assert.equal(calls.slice(release).find(call=>call.command==='browser.open')?.input.profileId,'personal');
assert.equal(JSON.parse(storage.get('muster.browserProfiles')!)['browser:one'],'personal');
root.unmount();await delay(20);
assert.equal(calls.at(-1)?.command,'browser.hide');
assert.equal(calls.some(call=>call.command==='browser.close'),false,'unmount hides; only explicit parent tab close destroys history');
assert.equal(listeners.size,storeListeners);assert.deepEqual(errors,[]);
console.log('Browser component checks passed: navigation controls, scoped profile binding and switching, state reconciliation, overlay/active gating, console, viewport, pick/capture into chat, downloads, certificate interstitial, lease remount and hide-only cleanup.');
