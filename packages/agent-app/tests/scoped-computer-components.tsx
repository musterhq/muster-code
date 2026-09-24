import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible'};
window.getComputedStyle=()=>style;
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,Element:window.Element,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const emit=(event:any)=>{for(const listener of listeners)listener(event);};
const limits={network:'none',memoryMiB:512,cpus:1,processes:256,maxRunning:2,maxTimeoutMs:7_200_000};
let status:any={id:'computer_1',scope:{kind:'chat',id:'c1'},label:'Research',provider:'local-docker',state:'running',workspacePreserved:true,durability:'scratch',image:'node',user:'1000:1000',limits};
let exec=0;
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='computer.inspect')return status;
  if(command==='computer.history')return [{executionId:'old',computerId:'computer_1',command:'npm test',state:'recovery-needed',restored:true,stdout:'\x1b[32mpass\x1b[0m 3\n',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:null,computerStopped:false,startedAt:'t',reason:'Ended when Muster closed. Output up to that point is shown.'}];
  if(command==='computer.files.list')return input.path==='src'?{path:'src',entries:[{name:'a.ts',path:'src/a.ts',kind:'file',size:2048,modifiedAt:'t'}],truncated:false}:{path:'',entries:[{name:'src',path:'src',kind:'directory',size:0,modifiedAt:'t'},{name:'notes.txt',path:'notes.txt',kind:'file',size:12,modifiedAt:'t'}],truncated:false};
  if(command==='computer.execStream'){const execId=`e${++exec}`;emit({type:'computerOutput',computerId:'computer_1',execId,stream:'stdout',data:'early chunk\n'});return {execId};}
  if(command==='computer.cancel')return {executionId:input.executionId,computerId:'computer_1',state:'cancelled',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:143,computerStopped:false,reason:'Cancelled. The sandbox kept running.'};
  if(command==='computer.setNetwork'){status={...status,limits:{...limits,network:input.network}};return status;}
  if(command==='computer.workspace.size')return {bytes:3*1024*1024,files:4,truncated:false};
  if(command==='computer.files.import')return {imported:['x']};
  if(command==='computer.files.export')return {savedTo:'/tmp/notes.txt'};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ScopedComputerTab}=await import('../src/renderer/components/ScopedComputerTab');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const count=(name:string)=>calls.filter(call=>call.command===name).length;
const button=(label:string)=>{const node=Array.from(document.querySelectorAll('button')).find(item=>(item.textContent??'').trim()===label||item.getAttribute('aria-label')===label) as HTMLButtonElement|undefined;assert.ok(node,`missing button ${label}`);return node!;};
const area=()=>document.querySelector('.sbx-input textarea') as HTMLTextAreaElement;
const type=async(value:string)=>{const element=area();let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(20);};
const key=async(name:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:name,shiftKey:false,ctrlKey:false,...extra});area().dispatchEvent(event);await delay(40);};

root.render(<ScopedComputerTab scope={{kind:'chat',id:'c1'}}/>);await delay(80);
assert.equal(errors.length,0);
assert.match(text(),/Scratch sandbox · Research/);assert.match(text(),/Linux container \(Docker\) · not this Mac · disposable/);
assert.equal(document.querySelector('.sbx-state')?.textContent,'Ready');assert.match(text(),/No network/);assert.match(text(),/512 MiB · 1 CPU · 256 processes · user 1000/);
// Restored history: ANSI stripped, shown as ended.
assert.match(text(),/npm test/);assert.match(text(),/pass 3/);assert.ok(!text().includes('\x1b'));assert.match(text(),/Ended when Muster closed/);
// Files side list.
assert.match(document.querySelector('.sbx-files')?.textContent??'',/notes\.txt12 B/);
button('src').click();await delay(30);assert.match(document.querySelector('.sbx-files')?.textContent??'',/a\.ts2\.0 KB/);
button('Import files from this Mac').click();await delay(30);assert.deepEqual(calls.find(call=>call.command==='computer.files.import')!.input,{scope:{kind:'chat',id:'c1'},into:'src'});
// Shift+Enter is a newline, Enter runs with the 30-minute default; an event that beats the reply is kept.
await type('echo hi');await key('Enter',{shiftKey:true});assert.equal(count('computer.execStream'),0);
await key('Enter');assert.equal(count('computer.execStream'),1);
const started=calls.find(call=>call.command==='computer.execStream')!.input;assert.equal(started.command,'echo hi');assert.equal(started.timeoutMs,1_800_000);assert.ok(started.requestId);
assert.match(text(),/early chunk/);assert.equal(document.querySelector('.sbx-state')?.textContent,'Running command');assert.equal(area().value,'');
// While running, Enter sends stdin rather than a new command.
await type('yes');await key('Enter');assert.deepEqual(calls.find(call=>call.command==='computer.input')!.input,{scope:{kind:'chat',id:'c1'},execId:'e1',data:'yes\n'});assert.equal(count('computer.execStream'),1);
emit({type:'computerOutput',computerId:'computer_1',execId:'e1',stream:'stderr',data:'warn\n'});emit({type:'computerOutput',computerId:'other',execId:'e1',stream:'stdout',data:'LEAK'});await delay(20);
assert.ok(document.querySelector('.sbx-run pre .is-stderr'));assert.ok(!text().includes('LEAK'),'events for another sandbox are ignored');
emit({type:'computerExecution',computerId:'computer_1',execution:{executionId:'e1',computerId:'computer_1',state:'completed',stdout:'',stderr:'',stdoutTruncated:false,stderrTruncated:false,exitCode:0,computerStopped:false}});await delay(30);
assert.equal(document.querySelector('.sbx-state')?.textContent,'Ready');assert.ok(Array.from(document.querySelectorAll('.sbx-run-state')).some(node=>node.textContent==='Done'));
// Up-arrow recalls history.
await key('ArrowUp');assert.equal(area().value,'echo hi');await key('ArrowUp');assert.equal(area().value,'npm test');await key('ArrowDown');assert.equal(area().value,'echo hi');
// Per-command stop keeps the sandbox.
await type('sleep 100');await key('Enter');button('Stop the running command').click();await delay(40);
assert.deepEqual(calls.find(call=>call.command==='computer.cancel')!.input,{scope:{kind:'chat',id:'c1'},executionId:'e2'});assert.match(text(),/Cancelled\. The sandbox kept running\./);
// Egress needs an explicit confirmation and shows in the header.
button('No network').click();await delay(20);assert.equal(count('computer.setNetwork'),0);assert.match(text(),/Allow internet access\? The container is recreated/);
button('Allow internet access').click();await delay(40);assert.deepEqual(calls.find(call=>call.command==='computer.setNetwork')!.input,{scope:{kind:'chat',id:'c1'},network:'egress',confirmed:true});assert.match(text(),/Internet on/);
// Scratch disposal previews the size first.
button('Dispose…').click();await delay(40);assert.match(text(),/files are deleted \(3\.0 MB in 4 items\)/);button('Cancel').click();await delay(20);
// Repair offer for an unregistered container.
status={...status,state:'not-created',repair:'unregistered-container',reason:'A container from an interrupted start was found.'};button('Refresh sandbox status').click();await delay(40);
assert.ok(button('Adopt'));assert.ok(button('Remove and recreate'));assert.equal(document.querySelector('.sbx-state')?.textContent,'Not created');
assert.equal(errors.length,0);
root.unmount();console.log('scoped-computer-components: ok');
