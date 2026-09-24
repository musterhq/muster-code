/** UX-22: file tree multiselect + batch actions. Run via scripts/test-renderer.mjs ('file-tree-multiselect' suite). */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};

const calls:{command:string;input:any}[]=[];
const listing:Record<string,any[]>={
  '':[{name:'src',path:'src',kind:'directory'},{name:'README.md',path:'README.md',kind:'file'},{name:'notes.md',path:'notes.md',kind:'file'}],
  src:[{name:'app.tsx',path:'src/app.tsx',kind:'file'}],
};
const chat={id:'chat',title:'Chat',folderId:'f',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'m',mode:'agent'};
const snapshot={version:1,chats:[chat],folders:[{id:'f',name:'Repo',path:'/repo'}],projects:[],activeChatId:'chat'};
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='files.list')return listing[input.path??'']??[];
  if(command==='files.reveal')return undefined;
  if(command==='files.trash')return undefined;
  if(command==='clipboard.write')return undefined;
  if(command==='app.snapshot')return snapshot;
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.update')return chat;
  if(command==='settings.get')return {values:{}};
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {FileTree}=await import('../src/renderer/components/FileTree');
await store.boot();await delay(30);
const errors:unknown[]=[];
const host=document.getElementById('root')!;
const root=createRoot(host,{onUncaughtError:(error:unknown)=>errors.push(error)});
root.render(<FileTree folderId="f" path=""/>);await delay(80);
assert.deepEqual(errors,[]);
const rows=()=>Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'));
assert.deepEqual(rows().map(el=>el.dataset.path),['src','README.md','notes.md'],'the root listing renders');
// Expand 'src' so selection can be exercised across a nested, recursive FileTree instance too.
rows()[0].click();await delay(80);
assert.deepEqual(rows().map(el=>el.dataset.path),['src','src/app.tsx','README.md','notes.md'],'src is expanded');

const clickEvt=(target:Element,init:Record<string,unknown>={})=>{const event=new window.Event('click',{bubbles:true,cancelable:true});Object.assign(event,init);target.dispatchEvent(event);return event;};
const key=(target:Element,init:Record<string,unknown>)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,init);target.dispatchEvent(event);return event;};
const row=(path:string)=>rows().find(el=>el.dataset.path===path)!;
const selectedPaths=()=>rows().filter(el=>el.classList.contains('is-selected')).map(el=>el.dataset.path).sort();

// Cmd-click toggles a file row into the selection instead of opening it.
const modClick=clickEvt(row('README.md'),{metaKey:true,ctrlKey:false});await delay(20);
assert.ok(modClick.defaultPrevented,'a modified click never falls through to the plain-click open behaviour');
assert.ok(row('README.md').classList.contains('is-selected'),'Cmd-click visibly selects the row');
assert.equal(row('README.md').getAttribute('aria-selected'),'true');
assert.equal(host.querySelector('.tree-selection-count')?.textContent,'1 selected');
assert.equal(host.querySelector('[aria-live="polite"]')?.textContent,'1 file selected');

// Cmd-click on a file inside the expanded subfolder adds to the SAME selection — proves it is shared
// across the recursive FileTree instance for 'src', not local to whichever level was clicked.
clickEvt(row('src/app.tsx'),{metaKey:true,ctrlKey:false});await delay(20);
assert.deepEqual(selectedPaths(),['README.md','src/app.tsx'].sort(),'selection is shared across the recursive subfolder instance');
assert.equal(host.querySelector('.tree-selection-count')?.textContent,'2 selected');

// Shift-click on the directory row ranges from the anchor (src/app.tsx, the last Cmd-click) to it,
// replacing the prior picks rather than adding to them — and directories can be part of a range too.
clickEvt(row('src'),{shiftKey:true});await delay(20);
assert.deepEqual(selectedPaths(),['src','src/app.tsx'].sort(),'the range spans a directory and a nested file');
assert.equal(row('src').getAttribute('aria-selected'),'true');
assert.equal(row('src').getAttribute('aria-expanded'),'true','selecting a folder does not collapse it');
assert.equal(row('README.md').getAttribute('aria-selected'),'false','a row not in the range is aria-selected=false in selection mode');

// Esc clears the selection (scoped to the tree, like the rest of its WAI-ARIA keyboard handling).
key(row('src'),{key:'Escape'});await delay(20);
assert.equal(selectedPaths().length,0,'Escape clears the selection');
assert.ok(!host.querySelector('.tree-selection-bar'),'the batch bar disappears with an empty selection');
assert.equal(host.querySelector('[aria-live="polite"]')?.textContent,'');

// Shift+ArrowDown/Up from a focused row extends (or shrinks) the selection, moving focus with it.
clickEvt(row('src'),{metaKey:true,ctrlKey:false});await delay(20); // anchor = src
key(row('src'),{key:'ArrowDown',shiftKey:true});await delay(20);
assert.deepEqual(selectedPaths(),['src','src/app.tsx'].sort(),'Shift+ArrowDown grows the range by one row');
key(row('src/app.tsx'),{key:'ArrowDown',shiftKey:true});await delay(20);
assert.deepEqual(selectedPaths(),['README.md','src','src/app.tsx'].sort(),'and again');
key(row('README.md'),{key:'ArrowUp',shiftKey:true});await delay(20);
assert.deepEqual(selectedPaths(),['src','src/app.tsx'].sort(),'Shift+ArrowUp shrinks the range back toward the anchor');
key(row('src'),{key:'Escape'});await delay(20);
assert.equal(selectedPaths().length,0);

// Space toggles the focused row; Cmd/Ctrl+A selects every rendered row; aria-selected is always the selection state.
assert.equal(row('notes.md').getAttribute('aria-selected'),'false','every row carries aria-selected in the multiselectable tree');
key(row('notes.md'),{key:' '});await delay(20);
assert.deepEqual(selectedPaths(),['notes.md'],'Space toggles the focused row in');
key(row('notes.md'),{key:' '});await delay(20);
assert.equal(selectedPaths().length,0,'and out');
const isMacTree=/mac/i.test((globalThis as any).navigator?.platform||(globalThis as any).navigator?.userAgent||'');
key(row('README.md'),{key:'a',metaKey:isMacTree,ctrlKey:!isMacTree});await delay(20);
assert.deepEqual(selectedPaths(),['README.md','notes.md','src','src/app.tsx'].sort(),'Cmd/Ctrl+A selects every rendered row');
key(row('README.md'),{key:'Escape'});await delay(20);
assert.equal(selectedPaths().length,0);

// --- Batch actions -------------------------------------------------------------------------------
clickEvt(row('README.md'),{metaKey:true,ctrlKey:false});clickEvt(row('notes.md'),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(host.querySelector('.tree-selection-count')?.textContent,'2 selected');

// Copy paths: clipboard.write (the same command the single-file "Copy relative path" action uses), newline-joined.
(host.querySelector('[aria-label="Copy selected paths"]') as HTMLButtonElement).click();await delay(20);
const copyCall=[...calls].reverse().find(call=>call.command==='clipboard.write');
assert.equal(copyCall?.input.text,'README.md\nnotes.md');

// Reveal: files.reveal (the single-file "Reveal in file manager" command) once per selected path.
const revealBefore=calls.filter(call=>call.command==='files.reveal').length;
(host.querySelector('[aria-label="Reveal selected files"]') as HTMLButtonElement).click();await delay(20);
const revealCalls=calls.filter(call=>call.command==='files.reveal').slice(revealBefore);
assert.deepEqual(revealCalls.map(call=>call.input.path).sort(),['README.md','notes.md']);

// Attach to composer: an @mention per selected path, inserted into the active chat's draft.
(host.querySelector('[aria-label="Attach selected files to the composer"]') as HTMLButtonElement).click();await delay(20);
const draft=store.getState().snapshot?.chats.find(c=>c.id==='chat')?.draft ?? '';
assert.match(draft,/@README\.md/);assert.match(draft,/@notes\.md/);

// The selection survives these non-destructive actions.
assert.equal(host.querySelector('.tree-selection-count')?.textContent,'2 selected');

// Delete respects unsaved tabs: a dirty file is skipped (never silently discarded) and noted; the clean one is trashed.
store.setTabDirty('file:f:README.md',true);
(host.querySelector('[aria-label="Delete selected files"]') as HTMLButtonElement).click();await delay(20);
assert.ok(document.querySelector('[data-testid="file-tree-delete-confirm"]'),'Delete opens a ConfirmSheet, same pattern as single-file delete');
const confirmButtons=Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-tree-delete-confirm"] button'));
confirmButtons.find(button=>button.textContent==='Move to Trash')!.click();await delay(40);
assert.ok(calls.some(call=>call.command==='files.trash'&&call.input.path==='notes.md'),'the clean file is trashed via files.trash, the single-file delete command');
assert.ok(!calls.some(call=>call.command==='files.trash'&&call.input.path==='README.md'),'the file with unsaved changes is skipped');
assert.ok(store.getState().notices.some(n=>/unsaved changes/.test(n.message)),'a notice explains the skip');
assert.deepEqual(selectedPaths(),['README.md'],'the trashed file leaves the selection; the kept (unsaved) one stays selected');
assert.ok(!document.querySelector('[data-testid="file-tree-delete-confirm"]'),'the confirm sheet closes');
key(row('README.md'),{key:'Escape'});await delay(20);

// A folder and a file inside it: the folder is trashed once, the nested file is not trashed separately.
const trashes=()=>calls.filter(call=>call.command==='files.trash').map(call=>call.input.path);
const trashedBefore=trashes().length;
clickEvt(row('src'),{metaKey:true,ctrlKey:false});clickEvt(row('src/app.tsx'),{metaKey:true,ctrlKey:false});await delay(20);
// ...but not while a file under the folder has unsaved edits: that folder is kept whole.
store.setTabDirty('file:f:src/app.tsx',true);
(host.querySelector('[aria-label="Delete selected files"]') as HTMLButtonElement).click();await delay(20);
Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-tree-delete-confirm"] button')).find(button=>button.textContent==='Move to Trash')!.click();await delay(40);
assert.deepEqual(trashes().slice(trashedBefore),[],'a folder holding an unsaved file is not trashed');
assert.deepEqual(selectedPaths(),['src','src/app.tsx'].sort(),'and stays selected');
store.setTabDirty('file:f:src/app.tsx',false);
(host.querySelector('[aria-label="Delete selected files"]') as HTMLButtonElement).click();await delay(20);
Array.from(document.querySelectorAll<HTMLButtonElement>('[data-testid="file-tree-delete-confirm"] button')).find(button=>button.textContent==='Move to Trash')!.click();await delay(40);
assert.deepEqual(trashes().slice(trashedBefore),['src'],'only the folder is trashed; the file inside goes with it');
assert.equal(host.querySelector('[role="tree"]')?.getAttribute('aria-multiselectable'),'true');
store.setTabDirty('file:f:README.md',false);

// A plain click keeps its ordinary behaviour (expand/collapse a folder) and drops any selection.
clickEvt(row('notes.md'),{metaKey:true,ctrlKey:false});await delay(20);
assert.equal(host.querySelector('.tree-selection-count')?.textContent,'1 selected');
const wasExpanded=row('src').getAttribute('aria-expanded');
clickEvt(row('src'));await delay(40);
assert.notEqual(row('src').getAttribute('aria-expanded'),wasExpanded,'a plain click still toggles the folder');
assert.equal(selectedPaths().length,0,'and clears the selection');

assert.deepEqual(errors,[]);
root.unmount();await delay(20);
console.log('PASS: file tree multiselect (Cmd-click toggle shared across recursive subfolders, Shift-click range over directories and files, Shift+Arrow extend/shrink, Esc clears, count bar + aria-live announcements, batch Copy paths/Reveal/Attach to composer/Delete respecting unsaved tabs, plain click still opens/toggles and clears)');
