/** Run with node tests/run-recovery-notice.mjs; the store is imported after the DOM and bridge exist. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:()=>null,setItem(){}}});
Object.assign(window,{setTimeout,clearTimeout});
window.MouseEvent=class extends window.Event {};
const invoked:{command:string;input:any}[]=[];
let release:(()=>void)|undefined,fail=false;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){invoked.push({command,input});if(command==='chat.send'){if(fail)throw new Error('503 Chat admission capacity is temporarily unavailable.');await new Promise<void>(resolve=>{release=resolve;});return {runId:'run-1'};}return {};}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {RecoveryNotice}=await import('../src/renderer/components/RecoveryNotice');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const base={id:'chat-1',title:'Chat',pinned:false,archived:false,draft:'Run the suite again',status:'failed' as const,updatedAt:'',model:'claude/claude-fable-5',mode:'agent' as const,error:'Provider admission is temporarily unavailable.'};
const rejected={...base,recovery:{kind:'admission-rejected' as const,retryable:true,reason:'Provider admission is temporarily unavailable. No turn was dispatched; retry manually later.'}};
const button=()=>document.querySelector('.chat-error-banner button') as HTMLButtonElement|null;
const text=()=>document.querySelector('.chat-error-banner')?.textContent??'';

root.render(<RecoveryNotice chat={rejected}/>);await delay(20);
assert.ok(text().includes('Provider admission is temporarily unavailable'),'reason text is shown');
assert.ok(text().includes('your draft is retained'));
assert.equal(button()?.textContent,'Retry now');assert.equal(button()?.hasAttribute('disabled'),false);
button()!.click();await delay(30);
assert.equal(button()?.textContent,'Retrying…','busy label while the send is in flight');
assert.equal(button()?.hasAttribute('disabled'),true);assert.equal(button()?.getAttribute('aria-busy'),'true');
const send=invoked.find(call=>call.command==='chat.send');
assert.ok(send,'retry sends through the store');assert.equal(send!.input.id,'chat-1');assert.equal(send!.input.text,'Run the suite again');
assert.ok(typeof send!.input.requestId==='string'&&send!.input.requestId.length>0,'sends carry a request id for host dedupe');
button()!.click();await delay(10);assert.equal(invoked.filter(call=>call.command==='chat.send').length,1,'a busy retry cannot double-send');
release!();await delay(30);
// A sent draft is consumed by the store, so there is nothing left to retry.
assert.equal(button()?.textContent,'Retry now');assert.equal(button()?.hasAttribute('disabled'),true);
assert.ok(!text().includes('was not sent'));assert.ok(text().includes('Write a message to retry'));
const {setComposerDraft}=await import('../src/renderer/store');
setComposerDraft('chat-1','Run the suite again');await delay(20);
assert.equal(button()?.hasAttribute('disabled'),false);

// A rejected send surfaces the failure inline and keeps the draft.
fail=true;button()!.click();await delay(30);
assert.ok(text().includes('was not sent'),'failed retry is reported in the banner');assert.equal(button()?.hasAttribute('disabled'),false);
fail=false;

// Retry sends the composer's live draft, not the stale persisted chat.draft.
setComposerDraft('chat-1','Run only the failing test');await delay(20);
const before=invoked.filter(call=>call.command==='chat.send').length;
button()!.click();await delay(30);
const sends=invoked.filter(call=>call.command==='chat.send');
assert.equal(sends.length,before+1);assert.equal(sends.at(-1)!.input.text,'Run only the failing test','live composer text is retried');
release!();await delay(30);
setComposerDraft('chat-1','Run the suite again');await delay(20);

// Running or stopping chats and empty drafts cannot retry.
root.render(<RecoveryNotice chat={{...rejected,status:'running'}}/>);await delay(20);
assert.equal(button()?.hasAttribute('disabled'),true);
setComposerDraft('chat-1','   ');root.render(<RecoveryNotice chat={{...rejected,draft:'   '}}/>);await delay(20);
assert.equal(button()?.hasAttribute('disabled'),true);assert.ok(text().includes('Write a message to retry'));

// Non-retryable admission or uncertain attempts never offer Retry.
root.render(<RecoveryNotice chat={{...rejected,recovery:{...rejected.recovery,retryable:false}}}/>);await delay(20);
assert.ok(!button(),'a non-retryable rejection shows the reason only');assert.ok(text().includes('temporarily unavailable'));
root.render(<RecoveryNotice chat={{...base,recovery:{kind:'recovery-needed',retryable:false,reason:'The provider may have accepted this turn.'}}}/>);await delay(20);
assert.equal(button()?.textContent,'Check provider status');assert.equal(document.querySelectorAll('.chat-error-banner button').length,1);
root.render(<RecoveryNotice chat={{...base,error:undefined}}/>);await delay(20);
assert.ok(!document.querySelector('.chat-error-banner'),'nothing to recover renders nothing');
// PER-08 (F42/F43): a user Stop is neutral: no red failure, no button to resolve before sending again.
root.render(<RecoveryNotice chat={{...base,status:'interrupted',error:'Stopped.',recovery:{kind:'cancelled',retryable:false,reason:'Stopped.'}}}/>);await delay(20);
assert.equal(document.querySelector('.chat-error-banner')?.className,'chat-error-banner is-interrupted');
assert.equal(document.querySelector('.chat-error-banner')?.getAttribute('data-recovery'),'cancelled');
assert.equal(text(),'Stopped.');assert.ok(!button(),'Stop never asks the user to check provider status');
root.unmount();assert.deepEqual(errors,[]);
console.log('PASS: admission-rejected Retry now sends the retained draft with busy/disabled states; recovery-needed keeps the reconcile button');
