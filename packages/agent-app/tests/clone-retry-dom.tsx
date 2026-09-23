/** Run with node tests/run-clone-retry-dom.mjs: GIT-10 clone Retry and draft-while-cloning. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:()=>null,setItem(){},removeItem(){}}});
Object.assign(window,{setTimeout,clearTimeout});
(window.document as any).hasFocus=()=>true;
const calls:{command:string;input:any}[]=[];
const listeners=new Set<(event:any)=>void>();
const emit=(event:any)=>{for(const listener of [...listeners])listener(event);};
let next=0;
(window as any).muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats:[],folders:[],projects:[]};
  if(command==='git.clone.defaultDestination')return {path:'/home/me/Code/repo',name:'repo'};
  if(command==='git.clone.start')return {id:`clone-${++next}`,destination:input.destination??'/home/me/Code/repo',name:'repo'};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const draft=await import('../src/renderer/newChatDraft');
const {CloneRepositorySheet,openCloneSheet,closeCloneSheet}=await import('../src/renderer/components/CloneRepositorySheet');
await store.boot();
const root=createRoot(document.getElementById('root')!);
root.render(<CloneRepositorySheet/>);await delay(20);
const sheet=()=>document.querySelector('[data-testid="clone-sheet"]');
const button=(label:string)=>[...(sheet()?.querySelectorAll('.composer-confirm-actions button')??[])].find(node=>node.textContent===label) as HTMLButtonElement|undefined;
const type=(input:HTMLInputElement,value:string)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set;setter?setter.call(input,value):(input.value=value);input.dispatchEvent(new window.Event('input',{bubbles:true}));};
const starts=()=>calls.filter(call=>call.command==='git.clone.start');

openCloneSheet();await delay(40);
type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Repository URL"]')!,'https://github.com/o/repo.git');
await delay(350);
sheet()!.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(40);
assert.deepEqual(starts().at(-1)!.input,{url:'https://github.com/o/repo.git',destination:'/home/me/Code/repo'});
assert.equal(button('Retry'),undefined,'no Retry while cloning');

// Draft while cloning: the sheet steps aside, a New-chat draft opens, the clone keeps running.
assert.ok(button('Draft a chat meanwhile'),'offered while the clone runs');
button('Draft a chat meanwhile')!.click();await delay(40);
assert.equal(sheet(),null,'the sheet steps aside');
assert.equal(draft.getNewChatDraft().open,true,'a new-chat draft opens');
draft.setNewChatText('Explain the build');
emit({type:'gitClone',id:'clone-1',phase:'progress',percent:50,message:'Receiving objects: 60%'});await delay(20);
openCloneSheet();await delay(30);
assert.match(sheet()?.querySelector('[data-testid="clone-progress"]')?.textContent??'',/Receiving objects/,'reopening shows the running clone');
button('Draft a chat meanwhile')!.click();await delay(40);
emit({type:'gitClone',id:'clone-1',phase:'done',path:'/home/me/Code/repo',folder:{id:'f9',path:'/home/me/Code/repo',name:'repo'}});await delay(40);
assert.equal(sheet(),null);
assert.equal(draft.getNewChatDraft().target.folderId,'f9','the draft is aimed at the landed folder');
assert.equal(draft.getNewChatDraft().text,'Explain the build','…and keeps what was typed');
assert.ok(store.getState().notices.some(notice=>notice.message==='Cloned repo'));

// A failure while drafting brings the sheet back with the reason and Retry, which re-runs the same inputs.
openCloneSheet();await delay(40);
type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Repository URL"]')!,'git@github.com:o/private.git');
type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Destination folder"]')!,'/home/me/Work/private');
await delay(20);
sheet()!.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(40);
const failed=starts().at(-1)!.input;
assert.deepEqual(failed,{url:'git@github.com:o/private.git',destination:'/home/me/Work/private'});
button('Draft a chat meanwhile')!.click();await delay(40);
assert.equal(sheet(),null);
emit({type:'gitClone',id:'clone-2',phase:'failed',error:'The remote rejected your credentials.'});await delay(40);
assert.ok(sheet(),'the failed clone reopens the sheet');
assert.match(sheet()!.querySelector('[role="alert"]')?.textContent??'',/rejected your credentials/);
assert.ok(button('Retry'),'Retry is offered after a failure');
assert.equal(button('Retry')!.className,'is-primary');
button('Retry')!.click();await delay(40);
assert.equal(starts().length,3);
assert.deepEqual(starts().at(-1)!.input,failed,'Retry re-runs exactly the same clone');
assert.equal(sheet()!.querySelector('[role="alert"]'),null,'the old error clears');
assert.equal(button('Retry'),undefined);

// Cancelling is not a failure: no Retry. Editing the inputs after a failure drops Retry (Clone uses the new ones).
emit({type:'gitClone',id:'clone-3',phase:'failed',error:'Network is unreachable.'});await delay(30);
assert.ok(button('Retry'));
type(sheet()!.querySelector<HTMLInputElement>('input[aria-label="Destination folder"]')!,'/home/me/Work/other');await delay(20);
assert.equal(button('Retry'),undefined,'edited inputs retire Retry');
sheet()!.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(40);
emit({type:'gitClone',id:'clone-4',phase:'cancelled',error:'Clone cancelled.'});await delay(30);
assert.equal(button('Retry'),undefined,'a cancelled clone offers no Retry');
assert.equal(sheet()!.querySelector('[role="alert"]'),null);
closeCloneSheet();await delay(20);
root.unmount();
console.log('clone-retry-dom: ok');
process.exit(0);
