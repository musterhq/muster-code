import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput = null; // React only wires native input events when the document advertises them.
Object.assign(globalThis, {window, document:window.document, HTMLElement:window.HTMLElement, IS_REACT_ACT_ENVIRONMENT:true});
const React = await import('react');
const {act} = React;
const {createRoot} = await import('react-dom/client');
const {HindsightPanel, recallNotice} = await import('../src/renderer/components/HindsightPanel');
const root = createRoot(document.getElementById('root')!);
const calls: {command:string;input:Record<string, unknown>}[] = [];
let connection = 'unchecked';
let fail = false;
let pending: ReturnType<typeof Promise.withResolvers<{bankId:string;records:{id:string;text:string;source:string;kind:string;provenance:string[];scope:{kind:string;id:string;label:string};deletable:boolean}[]}>> | undefined;
let reflecting: ReturnType<typeof Promise.withResolvers<{bankId:string;text:string;sources:unknown[];cancelled?:boolean}>> | undefined;
const record = (id:string, text:string) => ({id, text, source:'hindsight', kind:'world', provenance:['design review'], scope:{kind:'workspace',id:'w',label:'Folder'}, deletable:false});
window.muster = {subscribe:()=>()=>{},invoke:async (command:string,input:Record<string, unknown>) => {
  calls.push({command,input});
  if (command === 'memory.status') return {connection, bankId:`bank-${String(input.folderId)}`};
  if (command === 'memory.recall') {
    if (pending) return pending.promise;
    if (input.entities) return {bankId:'bank',records:[{...record('f1','Atlas staging target'),why:'mentions "atlas"; observed 2026-01-10, before 2026-03-01'}],excluded:{untimed:1,outsideRange:0,noEntity:2}};
    if (fail) { connection = 'local-only'; throw new Error('Service unavailable'); }
    connection = 'connected'; return {bankId:`bank-${String(input.folderId)}`,records:[record('one','synthetic recalled memory')]};
  }
  if (command === 'memory.reflect') { reflecting = Promise.withResolvers(); return reflecting.promise; }
  if (command === 'memory.reflect.cancel') { reflecting?.resolve({bankId:'',text:'',sources:[],cancelled:true}); return {cancelled:true}; }
  throw new Error(`Unexpected command: ${command}`);
}};
const text = () => document.querySelector('.hindsight-panel')!.textContent!;
const setQuery = async (value:string) => {
  const area = document.querySelector('textarea') as unknown as HTMLTextAreaElement;
  let proto = Object.getPrototypeOf(area), descriptor: PropertyDescriptor | undefined;
  while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  await act(async()=>{ descriptor!.set!.call(area, value); area.dispatchEvent(new window.Event('input',{bubbles:true})); });
};
const submit = () => document.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
const click = (label:string) => { const button = [...document.querySelectorAll('button')].find(item => item.textContent === label); assert.ok(button, `button ${label}`); button!.dispatchEvent(new window.Event('click',{bubbles:true})); };

await act(async()=>{root.render(<HindsightPanel folderId="first"/>);});
assert.match(text(),/Configured/);
assert.deepEqual(calls.map(call=>call.command),['memory.status'],'mount sends no hidden memory probe');
await setQuery('what do we know');
await act(async()=>{submit();});
assert.match(text(),/Connected/);
assert.match(text(),/synthetic recalled memory/);
assert.match(text(),/design review/,'recall shows provenance');
fail=true;
await act(async()=>{submit();});
assert.match(text(),/Last request failed/);
assert.match(text(),/Service unavailable/);
assert.equal(document.querySelector('textarea')!.hasAttribute('disabled'),false,'failure leaves retry input available');
fail=false; connection='unchecked';
pending=Promise.withResolvers();
await act(async()=>{submit();});
assert.match(text(),/Recalling/);
await act(async()=>{root.render(<HindsightPanel folderId="second"/>);});
assert.doesNotMatch(text(),/Recalling|synthetic recalled memory/);
await act(async()=>{pending!.resolve({bankId:'bank-first',records:[record('late','private result from previous scope')]});});
assert.doesNotMatch(text(),/private result from previous scope/);
assert.equal(calls.filter(call=>call.command==='memory.recall').length,3);
pending=undefined;

// Reflect: Cancel aborts through the request id; Markdown renders; cited sources show when present.
await act(async()=>{click('Reflect');});
await setQuery('what have we learned');
await act(async()=>{submit();});
assert.match(text(),/Reflecting/);
const requestId = calls.find(call=>call.command==='memory.reflect')!.input.requestId;
assert.equal(typeof requestId,'string');
await act(async()=>{click('Cancel');});
assert.equal(calls.find(call=>call.command==='memory.reflect.cancel')!.input.requestId,requestId);
assert.match(text(),/Reflection cancelled/);
await act(async()=>{submit();});
await act(async()=>{reflecting!.resolve({bankId:'bank',text:'## Findings\n\n- **Staging** first',sources:[record('s1','Staging runs on Fridays')]});});
assert.ok(document.querySelector('.hindsight-answer h2'),'reflection renders Markdown');
assert.equal(document.querySelector('.hindsight-answer strong')!.textContent,'Staging');
assert.match(text(),/Based on 1 memory/);
assert.match(text(),/Staging runs on Fridays/);

// MEM-13: entity and valid-at filters reach the API; the result explains why each memory matched and what was left out.
assert.equal(recallNotice(0,{untimed:0,outsideRange:0,noEntity:3}),'No memories matched this query and its filters. Left out: 3 not mentioning the entities.');
assert.equal(recallNotice(2),'2 recalled memories');
await act(async()=>{click('Recall');});
await act(async()=>{click('Options');});
const field = async (label:string, value:string) => {
  const input = [...document.querySelectorAll('.hindsight-advanced label')].find(item => item.textContent!.startsWith(label))!.querySelector('input') as unknown as HTMLInputElement;
  let proto = Object.getPrototypeOf(input), descriptor: PropertyDescriptor | undefined;
  while (proto && !(descriptor = Object.getOwnPropertyDescriptor(proto, 'value'))) proto = Object.getPrototypeOf(proto);
  await act(async()=>{ descriptor!.set!.call(input, value); input.dispatchEvent(new window.Event('input',{bubbles:true})); input.dispatchEvent(new window.Event('change',{bubbles:true})); });
};
await field('Entities','Atlas, deploy');
await field('Valid at','2026-03-01');
await setQuery('deploy target');
await act(async()=>{submit();});
const filtered = calls.filter(call=>call.command==='memory.recall').at(-1)!.input;
assert.deepEqual(filtered.entities,['Atlas','deploy']);
assert.equal(filtered.validAt,'2026-03-01T23:59:59.999Z');
assert.match(text(),/Matched: mentions "atlas"/);
assert.match(text(),/Left out: 2 not mentioning the entities, 1 undated/);

connection='not-configured';
await act(async()=>{root.render(<HindsightPanel folderId="third" onConfigure={()=>{}}/>);});
assert.match(text(),/Set up memory engine/);
assert.ok(!document.querySelector('.hindsight-panel textarea'),'no query form without a configured bank');
await act(async()=>{root.unmount();});
console.log('Recall and Reflect lifecycle passed: no hidden probe, provenance, retry, stale scope suppression, cancel, Markdown, citations, entity/valid-at filters.');
