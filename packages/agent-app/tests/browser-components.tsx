/** Focused browser toolbar/lease DOM test: bundle with esbuild, CSS empty. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import type {BrowserEvent,BrowserState} from '../src/shared/browser-protocol';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout});
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:400,y:80,width:500,height:600,top:80,left:400,right:900,bottom:680});
window.HTMLElement.prototype.getClientRects=function(){return this.closest('[hidden]')?[]:[this.getBoundingClientRect()];};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:BrowserEvent)=>void>();
let state:BrowserState={owner:'browser:one',profileId:'personal',revision:0,url:'about:blank',title:'',loading:false,canGoBack:false,canGoForward:false,visible:false};
const emit=(patch:Partial<BrowserState>)=>{state={...state,...patch,revision:state.revision+1};for(const listener of listeners)listener({type:'browserState',state});};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='browser.open'){state={...state,owner:input.owner,profileId:input.profileId,url:input.url,revision:state.revision+1};return state;}
  if(command==='browser.navigate'){emit({url:input.url,loading:true});return state;}
  if(command==='browser.stop'){emit({loading:false});return state;}
  if(command==='browser.reload'){emit({loading:true});return state;}
  if(command==='browser.back'||command==='browser.forward'||command==='browser.status')return state;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {BrowserTab}=await import('../src/renderer/components/BrowserTab');
const errors:unknown[]=[];
const persisted:string[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const props={owner:'browser:one',profileId:'personal',onUrlChange:(url:string)=>persisted.push(url)};
root.render(<BrowserTab {...props}/>);await delay(60);
assert.deepEqual(errors,[]);
assert.match(document.body.textContent!,/Browse a website/);
assert.match(document.querySelector('.browser-profile')!.textContent!,/Personal profile/);
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
assert.equal(listeners.size,0,'inactive views unsubscribe and detach');
assert.equal(calls.filter(call=>call.command==='browser.open').length,opens);
root.render(<BrowserTab {...props} active/>);await delay(45);
const surfaces=calls.filter(call=>call.command==='browser.open').map(call=>call.input.surfaceId);
assert.notEqual(surfaces.at(-1),surfaces[0],'a remounted surface has a fresh lease');
root.unmount();await delay(20);
assert.equal(calls.at(-1)?.command,'browser.hide');
assert.equal(calls.some(call=>call.command==='browser.close'),false,'unmount hides; only explicit parent tab close destroys history');
assert.equal(listeners.size,0);assert.deepEqual(errors,[]);
console.log('Browser component checks passed: real navigation controls, Personal profile, state reconciliation, overlay/active gating, lease remount and hide-only cleanup.');
