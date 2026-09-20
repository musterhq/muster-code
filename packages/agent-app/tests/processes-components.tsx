import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
let chat:any={id:'chat',title:'Process checks',folderId:null,draft:'',pinned:false,archived:false,status:'completed',updatedAt:'',mode:'agent',permissionMode:'workspace',model:'model'};
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const snapshot=()=>({chats:[chat],folders:[],projects:[],version:1,activeChatId:'chat'});
const emit=(event:any)=>{for(const listener of listeners)listener(event);};
const row={chatId:'chat',processId:'process:fixture',generation:1,sequence:1,status:'running',label:'Fixture server',purpose:'server',startedAt:'2026-09-19T01:00:00Z',updatedAt:'2026-09-19T01:00:00Z',command:'fixture',output:'old output',truncated:false,exitCode:null};
let pendingAttach:((value:any)=>void)|undefined,leaseId='';
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='processes.attach'){leaseId=input.leaseId;return new Promise(resolve=>{pendingAttach=resolve;});}
  if(command==='processes.stop')return {...row,status:'stopped',sequence:6,signal:'SIGTERM'};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ProcessesTab}=await import('../src/renderer/components/ProcessesTab');
const store=await import('../src/renderer/store');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<ProcessesTab chatId="chat"/>);await delay(45);
assert.deepEqual(errors,[]);assert.ok(pendingAttach);
assert.match(document.body.textContent??'',/Host commands require Full access/);
assert.equal((document.querySelector('button[type="submit"]') as HTMLButtonElement).disabled,true);
// Event received after subscribing but before the attach snapshot cannot rewind.
emit({type:'processSession',leaseId,session:{...row,sequence:3,output:'newest streamed output'}});
pendingAttach!({chatId:'chat',sessions:[row]});await delay(45);
assert.deepEqual(errors,[]);
assert.equal(document.querySelector('pre')?.textContent,'newest streamed output');
assert.equal(document.querySelectorAll('.process-row').length,1);
assert.match(document.body.textContent??'',/Non-interactive commands/);
emit({type:'processSession',leaseId:'stale-viewer',session:{...row,sequence:4,output:'must not render'}});await delay(15);
assert.equal(document.querySelector('pre')?.textContent,'newest streamed output');
// Switching away only detaches the observer, even while its command is running.
root.render(<ProcessesTab chatId="chat" active={false}/>);await delay(35);
assert.ok(calls.some(call=>call.command==='processes.detach'&&call.input.leaseId===leaseId));
assert.equal(calls.some(call=>call.command==='processes.stop'),false);
root.render(<ProcessesTab chatId="chat" active/>);await delay(35);
pendingAttach!({chatId:'chat',sessions:[{...row,sequence:4,output:'reattached output'}]});await delay(35);
assert.equal(document.querySelector('pre')?.textContent,'reattached output');
// Permission downgrade must not prevent the user stopping an owned process.
(document.querySelector('[aria-label="Stop Fixture server"]') as HTMLButtonElement).click();await delay(35);
assert.ok(calls.some(call=>call.command==='processes.stop'&&call.input.processId==='process:fixture'));
assert.match(document.body.textContent??'',/Stopped/);
const stopCount=calls.filter(call=>call.command==='processes.stop').length;
root.unmount();await delay(20);assert.equal(calls.filter(call=>call.command==='processes.stop').length,stopCount);
assert.deepEqual(errors,[]);
console.log('Process component checks passed: Full gate, subscribe/snapshot race, stale lease exclusion, detach/reopen and explicit Stop after access downgrade.');
