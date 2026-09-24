import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver});
window.muster={invoke:async()=>undefined,subscribe:()=>()=>{}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {MessageBody}=await import('../src/renderer/components/MessageBody');
const root=createRoot(document.getElementById('root')!);
const show=async(text:string,animate=true)=>{root.render(<MessageBody text={text} animate={animate}/>);await delay(15);};
const fades=()=>[...document.querySelectorAll('.md-fade')];

await show('Reading the store.');
assert.equal(fades().length,0,'text present at first render does not fade');
await show('Reading the store. Due dates');
assert.deepEqual(fades().map(e=>e.textContent),[' Due dates'],'new text fades in its own span');
const first=fades()[0];
await show('Reading the store. Due dates are in, and all 31 tests pass.');
assert.equal(fades().length,2);
assert.equal(fades()[0],first,'an earlier span keeps its DOM node, so its animation never replays');
assert.equal(document.querySelector('.md-body')!.textContent,'Reading the store. Due dates are in, and all 31 tests pass.','text reads exactly as sent');

await show('Reading the store. Due dates are in, and all 31 tests pass.\n\n- Model: `dueAt`\n- Job');
const items=[...document.querySelectorAll('li')];
assert.equal(items.length,2);
assert.ok(items[1]!.querySelector('.md-fade'),'a new list item fades in');
assert.ok(!document.querySelector('code .md-fade'),'inline code is not split');

await show('Something else entirely');
assert.equal(fades().length,0,'an edit or replacement resets instead of animating old text');

await show('Static text',false);await show('Static text grows',false);
assert.equal(fades().length,0,'without animate, nothing fades');
root.unmount();
console.log('Markdown fade DOM checks passed: new text fades once, spans stay put, code and edits are left alone.');
