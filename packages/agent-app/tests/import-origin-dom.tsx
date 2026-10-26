/** Imported-chat note (#95): the session's own model and provider are shown as plain text. Run with scripts/test-renderer.mjs. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:()=>null,setItem(){}}});
Object.assign(window,{setTimeout,clearTimeout});
Object.assign(window,{muster:{subscribe(){return()=>{};},async invoke(){return {};}}});
// Dynamic imports on purpose: the component code must load after the linkedom globals above exist.
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ImportOrigin}=await import('../src/renderer/components/ImportConversations');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const note=()=>document.querySelector('[data-testid="import-origin"]');

// Spec: MUS-SPEC-01-95B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-95b)
await check('the imported chat note shows the session model and provider read-only',async()=>{
  root.render(<ImportOrigin data={{kind:'imported',source:'codex',importedAt:new Date().toISOString(),model:'gpt-6-codex',provider:'openai'}}/>);await delay(20);
  assert.ok(note(),'the note renders');
  const text=note()!.textContent??'';
  assert.ok(text.includes('gpt-6-codex'),'the session model is named');
  assert.ok(text.includes('openai'),'the session provider is named');
  assert.equal(note()!.querySelectorAll('button,input,select,textarea,[role="combobox"],[role="menu"],[role="button"]').length,0,'nothing in the note changes the model');
  root.render(<ImportOrigin data={{kind:'imported',source:'chatgpt',importedAt:new Date().toISOString()}}/>);await delay(20);
  assert.ok(note(),'a note without a model still renders');
  assert.ok(!/gpt|openai|model/i.test((note()!.textContent??'').replace(/ChatGPT/g,'')),'no model text when the session named none');
});
root.unmount();assert.deepEqual(errors,[]);
