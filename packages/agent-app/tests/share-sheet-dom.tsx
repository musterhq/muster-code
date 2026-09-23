/** Run with node tests/run-share-sheet-dom.mjs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:()=>null,setItem(){}}});
Object.assign(window,{setTimeout,clearTimeout});
const invoked:{command:string;input:any}[]=[];
let saved=true,failSave=false;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){invoked.push({command,input});
  if(command==='chat.export')return {text:`EXPORT:${input.format}:${input.redact===false?'raw':'redacted'}`,omitted:[],fileName:'x'};
  if(command==='chat.export.file'){if(failSave)throw new Error('Disk full.');return saved?{saved:true,fileName:'chat.html'}:{saved:false};}
  return undefined;}};
const {act}=await import('react'),{createRoot}=await import('react-dom/client');
const {ShareSheet,localChatLink}=await import('../src/renderer/components/ShareSheet');
const {getState}=await import('../src/renderer/store');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const root=createRoot(document.getElementById('root')!);
await act(async()=>{root.render(<ShareSheet/>);});
const sheet=()=>document.querySelector('[data-testid="share-sheet"]');
const button=(label:string)=>[...document.querySelectorAll('[data-testid="share-sheet"] button')].find(entry=>entry.textContent===label) as HTMLButtonElement|undefined;
const open=async()=>{await act(async()=>{window.dispatchEvent(new window.CustomEvent('muster:share-chat',{detail:{chatId:'chat-1',title:'Fix login'}}));});await delay(5);};
const calls=(command:string)=>invoked.filter(call=>call.command===command);
const click=async(element:Element|undefined|null)=>{assert.ok(element,'control exists');await act(async()=>{(element as HTMLElement).click();});await delay(5);};
// linkedom's click() does not toggle inputs: set checked through the native setter (bypassing React's tracker), then click.
const check=async(element:Element|null|undefined,value:boolean)=>{assert.ok(element,'input exists');const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element),'checked')?.set;setter?setter.call(element,value):((element as HTMLInputElement).checked=value);await act(async()=>{element.dispatchEvent(new window.Event('click',{bubbles:true}));});await delay(5);};

assert.equal(sheet(),null,'closed until requested');
await open();
assert.ok(sheet(),'opens on muster:share-chat');
assert.equal(sheet()!.querySelector('h2')?.textContent,'Share “Fix login”');
assert.equal(sheet()!.getAttribute('role'),'dialog');
const radios=[...sheet()!.querySelectorAll('input[type=radio]')] as HTMLInputElement[];
assert.deepEqual(radios.map(radio=>radio.value),['markdown','html','json']);
assert.equal(radios[0].checked,true,'Markdown by default');
const redact=sheet()!.querySelector('.share-redact input') as HTMLInputElement;
assert.equal(redact.checked,true,'redaction on by default');
assert.ok(sheet()!.textContent!.includes('Works only in Muster on this Mac'),'link scope is explained');

// Copy (Markdown, redacted) goes through chat.export then the clipboard, then closes.
await click(button('Copy'));
assert.deepEqual(calls('chat.export').at(-1)!.input,{id:'chat-1',format:'markdown'});
assert.deepEqual(calls('clipboard.write').at(-1)!.input,{text:'EXPORT:markdown:redacted'});
assert.equal(sheet(),null,'closes after copying');
assert.ok(getState().notices.some(notice=>notice.message.includes('secrets redacted')));

// HTML with redaction off, saved through the dialog.
await open();
await check(sheet()!.querySelector('input[value=html]'),true);
await check(sheet()!.querySelector('.share-redact input'),false);
assert.ok(sheet()!.textContent!.includes('will be included as written'),'warns when redaction is off');
await click(button('Save…'));
assert.deepEqual(calls('chat.export.file').at(-1)!.input,{id:'chat-1',format:'html',redact:false});
assert.equal(sheet(),null);

// A cancelled save keeps the sheet open; a failed save shows the error inline.
await open();saved=false;
await click(button('Save…'));
assert.ok(sheet(),'cancel in the save dialog keeps the sheet');
assert.deepEqual(calls('chat.export.file').at(-1)!.input,{id:'chat-1',format:'markdown'},'reopening resets format and redaction');
failSave=true;await click(button('Save…'));
assert.equal(sheet()!.querySelector('[role=alert]')?.textContent,'Disk full.');
failSave=false;saved=true;

// Copy local link copies only the muster:// id link.
await click(button('Copy local link'));
assert.deepEqual(calls('clipboard.write').at(-1)!.input,{text:'muster://chat/chat-1'});
assert.equal(localChatLink('a b/c'),'muster://chat/a%20b%2Fc');
assert.equal(sheet(),null);
await act(async()=>{root.unmount();});
console.log('share-sheet-dom: ok');
