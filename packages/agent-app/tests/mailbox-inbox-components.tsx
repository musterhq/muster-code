/** Inbox (SBX-12/SBX-17) DOM checks; bundled with esbuild (CSS empty) and run with Node like the other *-components suites. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
// React only listens for `input` when the document advertises it.
window.document.oninput = null;
Object.assign(globalThis, {
  window, document:window.document, HTMLElement:window.HTMLElement, Element:window.Element,
  localStorage:{getItem(){return null;},setItem(){}},
  requestAnimationFrame:(callback:any)=>setTimeout(callback,0), cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),
});
const now = new Date().toISOString(), soon = new Date(Date.now() + 15 * 60_000).toISOString();
const lead = {kind:'chat', id:'lead', label:'Lead'}, me = {kind:'chat', id:'worker', label:'Worker'};
let messages:any[] = [
  {id:'m3', seq:3, kind:'message', sender:me, recipient:{kind:'user', id:'user', label:'You'}, projectId:'p', body:'Need a pricing decision.', createdAt:now, state:'delivered', reply:'none', deliveries:[{chatId:'', deliveredAt:now, ackedAt:null, via:'user'}]},
  {id:'m2', seq:2, kind:'request', sender:lead, recipient:me, projectId:'p', subject:'Schema', body:'Is the users table migrated?', replyBy:soon, createdAt:now, state:'pending', reply:'awaiting', deliveries:[]},
  {id:'m1', seq:1, kind:'message', sender:{kind:'user', id:'user', label:'You'}, recipient:me, projectId:'p', body:'Old note', expiresAt:now, createdAt:now, state:'expired', reply:'none', deliveries:[]},
];
const calls:{command:string;input:any}[] = [];
const listeners = new Set<(event:any)=>void>();
(window as any).muster = {
  subscribe(listener:any){listeners.add(listener);return ()=>{listeners.delete(listener);};},
  async invoke(command:string,input:any){
    calls.push({command,input});
    if(command==='mailbox.list') return {messages, unacked:2, pending:1};
    if(command==='mailbox.ack') { messages = messages.map(m => m.id === input.messageId ? {...m, state:'acked', deliveries:[{chatId:input.chatId ?? '', deliveredAt:now, ackedAt:now, via:'user'}]} : m); return messages.find(m => m.id === input.messageId); }
    if(command==='mailbox.send') return {...messages[0], id:'m4', seq:4};
    if(command==='mailbox.reply') return {...messages[0], id:'m5', seq:5, kind:'reply'};
    if(command==='app.snapshot') return {chats:[{id:'worker',title:'Worker',projectId:'p',status:'idle',mode:'agent'},{id:'lead',title:'Lead',projectId:'p',status:'idle',mode:'agent'}],folders:[],projects:[{id:'p',name:'P',goal:'',folderIds:[]}],version:1};
    return undefined;
  },
};
const {createRoot} = await import('react-dom/client');
const {MailboxInbox, messageStatus, addressLabel} = await import('../src/renderer/components/MailboxInbox');
const errors:unknown[] = [];
const root = createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const type = async (element:HTMLTextAreaElement, value:string) => { let proto = Object.getPrototypeOf(element), descriptor; while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto,'value'))) proto = Object.getPrototypeOf(proto); descriptor!.set!.call(element,value); element.dispatchEvent(new window.Event('input',{bubbles:true})); await delay(30); };

assert.equal(addressLabel({kind:'project', id:'p', label:'Launch'}), 'Launch (everyone)');
assert.equal(addressLabel({kind:'agent', id:'t', label:'Reviewer'}), 'Subagent: Reviewer');
assert.equal(messageStatus(messages[1], 'worker').label, 'Queued for next turn');
assert.equal(messageStatus({...messages[1], deliveries:[{chatId:'worker', deliveredAt:now, ackedAt:null, via:'steer'}]}, 'worker').label, 'Steered in');

root.render(<MailboxInbox chatId="worker" />);
await delay(60);
assert.deepEqual(errors, []);
const rows = [...document.querySelectorAll('.mailbox-message')];
assert.equal(rows.length, 3);
assert.match(document.querySelector('.mailbox-counts')!.textContent!, /2 unacknowledged · 1 queued/);
const request = document.querySelector('[aria-label="Message #2 from Lead"]')!;
assert.match(request.textContent!, /Request/); assert.match(request.textContent!, /Queued for next turn/); assert.match(request.textContent!, /Awaiting reply · due/);
assert.match(request.querySelector('.mailbox-subject')!.textContent!, /Schema/);
assert.ok(document.querySelector('[aria-label="Message #1 from You"]')!.className.includes('is-expired'), 'expired mail is shown dimmed');
const outgoing = document.querySelector('[aria-label="Message #3 from Worker"]')!;
assert.ok(outgoing.className.includes('is-outgoing'));
assert.match(outgoing.textContent!, /To You/);
// The user acknowledges on the chat's behalf.
(request.querySelector('.mailbox-message-foot button[title="Mark this message handled"]') as HTMLButtonElement).click();
await delay(40);
assert.deepEqual(calls.find(call => call.command === 'mailbox.ack')!.input, {messageId:'m2', chatId:'worker'});
assert.match(document.querySelector('[aria-label="Message #2 from Lead"]')!.textContent!, /Acknowledged/);
// Agent mail addressed to the user can be answered from here.
(document.querySelector('[aria-label="Message #3 from Worker"] .mailbox-message-foot button') as HTMLButtonElement).click();
await delay(30);
await type(document.querySelector('[aria-label="Reply to #3"]') as HTMLTextAreaElement, 'Go with $20.');
(document.querySelector('.mailbox-reply') as HTMLFormElement).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await delay(40);
assert.deepEqual(calls.find(call => call.command === 'mailbox.reply')!.input, {messageId:'m3', body:'Go with $20.', idempotencyKey:'ui-m3'});
// Composing mails this chat as the user, optionally as a request with a deadline.
await type(document.querySelector('.mailbox-compose textarea') as HTMLTextAreaElement, 'Please rebase first.');
{ const box = document.querySelector('.mailbox-check input') as HTMLInputElement; box.checked = true; box.dispatchEvent(new window.Event('click',{bubbles:true})); }
await delay(30);
assert.ok(document.querySelector('[aria-label="Reply deadline"]'));
(document.querySelector('.mailbox-compose') as HTMLFormElement).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await delay(40);
const sent = calls.find(call => call.command === 'mailbox.send')!.input;
assert.deepEqual({...sent, idempotencyKey:undefined}, {to:{kind:'chat', id:'worker'}, body:'Please rebase first.', kind:'request', replyWithinMs:15 * 60_000, idempotencyKey:undefined});
assert.match(sent.idempotencyKey, /^ui-/);
// A mailboxChanged event for this chat reloads the list.
const lists = calls.filter(call => call.command === 'mailbox.list').length;
for (const listener of listeners) listener({type:'mailboxChanged', chatIds:['worker'], projectIds:[]});
await delay(30);
assert.ok(calls.filter(call => call.command === 'mailbox.list').length > lists);
// The Project inbox lists project mail and offers a recipient picker.
root.render(<MailboxInbox projectId="p" />);
await delay(60);
assert.equal(document.querySelector('[aria-label="Project inbox"]') !== null, true);
assert.deepEqual(calls.filter(call => call.command === 'mailbox.list').at(-1)!.input, {projectId:'p', includeExpired:true});
assert.ok(document.querySelector('[aria-label="Recipient"]'));
assert.deepEqual(errors, []);
root.unmount();
console.log('Mailbox inbox checks passed: statuses, counts, ack on behalf of a chat, reply to agent mail, compose request, live reload, project scope.');
