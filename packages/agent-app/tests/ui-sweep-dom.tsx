/** #398: user-visible regressions from the UI sweep, with a local bridge and the real components. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>(),scrolls:string[]=[];
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.chatId);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.closest('[data-chat-id]')?.dataset.chatId??this.className);};
// SketchPad's canvas, for the draft's + → Sketch check: linkedom has no real 2D context or toBlob (see composer-components.tsx).
window.HTMLCanvasElement.prototype.getContext=()=>null;
(window.HTMLCanvasElement.prototype as any).toBlob=function(callback:(blob:Blob|null)=>void){callback(new Blob(['sketch'],{type:'image/png'}));};
const pointer=async(element:Element,type:string,props:Record<string,unknown>={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientX:0,clientY:0,...props});element.dispatchEvent(event);await delay(20);};

import {check as namedCheck} from './dom-check.ts';
import {installSweepFixture, workspace, savedSummaries} from './ui-sweep-fixture';
installSweepFixture();
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {Sidebar}=await import('../src/renderer/components/Sidebar');
const {MemoryScreen}=await import('../src/renderer/components/MemoryScreen');
const {ProvidersScreen}=await import('../src/renderer/components/ProvidersScreen');
const {PluginsScreen}=await import('../src/renderer/components/PluginsScreen');
const {ProjectsScreen}=await import('../src/renderer/components/ProjectsScreen');
const {LedgerPage}=await import('../src/renderer/components/HubPages');
const {TurnHeader}=await import('../src/renderer/components/TurnStatus');
const {describeTurns}=await import('../src/renderer/components/turnStatusModel');
const {SpotlightSearchHost,openSpotlightSearch,closeSpotlightSearch}=await import('../src/renderer/components/SpotlightSearch');
const drafts=await import('../src/renderer/newChatDraft');
const {refreshWorkspace}=await import('../src/renderer/hubStore');
const errors:unknown[]=[],failures:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e)});
const render=async(node:React.ReactNode)=>{root.render(node);await delay(100);assert.deepEqual(errors,[]);};
const check=async(name:string,fn:()=>Promise<void>)=>{try{await namedCheck(name,fn);}catch(e){console.error(e);failures.push(e);}};
await store.boot();await refreshWorkspace();
// Spec: MUS-SPEC-15-398A (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-398a)
await check('only the visible destination is highlighted after leaving a draft',async()=>{
  drafts.openNewChat();(await import('../src/renderer/hubStore')).openHub('inbox');await render(<Sidebar/>);
  assert.equal(document.querySelectorAll('.nav-toolbar .is-active').length,1);
  assert.equal(document.querySelector('.nav-toolbar .is-active')?.textContent,'Inbox');
  store.openMemoryScreen(undefined);await delay(30);
  assert.equal(document.querySelectorAll('.nav-toolbar .is-active').length,1);
  assert.equal(document.querySelector('.nav-toolbar .is-active')?.textContent,'Memory');
});
// Spec: MUS-SPEC-02-398A (docs/spec/clauses/02-turns-streaming-and-queue.md#mus-spec-02-398a)
await check('an imported turn displays its work duration without the import gap',async()=>{
  const rows:any[]=[{kind:'user',id:'u',createdAt:'2026-09-01T00:00:00Z'},{kind:'reasoning',id:'r',createdAt:'2026-09-01T00:00:10Z',status:'completed'},{kind:'assistant',id:'a',createdAt:'2026-09-01T00:00:26Z',status:'completed'},{kind:'notice',id:'n',createdAt:'2026-10-01T00:00:00Z'}];
  await render(<TurnHeader durationMs={describeTurns(rows,false).turns.get('u')!.durationMs} open={false} onToggle={()=>{}}/>);
  assert.match(document.body.textContent??'',/Worked for 26s/);
});
// Spec: MUS-SPEC-11-398A (docs/spec/clauses/11-memory.md#mus-spec-11-398a)
await check('memory suggestions start as compact source rows and expand for review',async()=>{
  await render(<MemoryScreen/>);
  assert.equal(document.querySelectorAll('.memory-offer').length,20);
  assert.equal(document.querySelectorAll('.memory-offer textarea').length,0);
  const toggle=document.querySelector<HTMLButtonElement>('.memory-offer [aria-expanded="false"]');assert.ok(toggle);
  assert.match(toggle.textContent??'',/Prefer small pull requests/);
  assert.match(document.querySelector('.memory-offer')?.textContent??'',/From “ossmgr UI”/);
  toggle.click();await delay(30);
  assert.equal(document.querySelectorAll('.memory-offer textarea').length,1);
  const remember=[...document.querySelectorAll<HTMLButtonElement>('.memory-offer button')].find(b=>b.textContent==='Remember')!;
  remember.click();await delay(30);assert.match(savedSummaries.at(-1)??'',/Full transcript/);assert.equal(document.querySelectorAll('.memory-offer').length,19);
});
// Spec: MUS-SPEC-03-398A (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-398a)
await check('an unprobed gateway says not checked yet and explains its model count',async()=>{
  await render(<ProvidersScreen/>);
  assert.equal(document.querySelector('.connection-status')?.textContent,'Not checked yet');
  assert.equal(document.querySelector('.connection-status')?.classList.contains('is-ready'),false);
  assert.match(document.body.textContent??'',/2 chat models/);
  assert.match(document.body.textContent??'',/1 image, audio and other models/);
});
// Spec: MUS-SPEC-15-398B (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-398b)
await check('duplicate folder names and search results show their parent folders',async()=>{
  await render(<Sidebar/>);
  const names=[...document.querySelectorAll('[data-folder-id] .nav-section-title')].map(e=>e.textContent);
  assert.ok(names.includes('redis-automation · alpha'));assert.ok(names.includes('redis-automation · beta'));
  openSpotlightSearch();await render(<SpotlightSearchHost/>);
  assert.match(document.body.textContent??'',/redis-automation.*alpha|alpha.*redis-automation/s);
  assert.match(document.body.textContent??'',/redis-automation.*beta|beta.*redis-automation/s);
  closeSpotlightSearch();
});
// Spec: MUS-SPEC-17-398A (docs/spec/clauses/17-usage-cost-and-ledger.md#mus-spec-17-398a)
await check('ledger integrity jargon starts behind a details toggle',async()=>{
  await render(<LedgerPage snapshot={workspace as any} nav={{onOpenTask(){},onOpenAgent(){},onOpenChat(){}}}/>);
  const details=document.querySelector('details.ws-chain-details');assert.ok(details);assert.equal(details.hasAttribute('open'),false);
  assert.match(details.querySelector('summary')?.textContent??'',/integrity/i);
  assert.match(details.textContent??'',/chain verified/);
});
// Spec: MUS-SPEC-12-398A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-398a)
await check('a project with zero tasks does not claim work is in progress',async()=>{
  await render(<ProjectsScreen onBack={()=>{}} onStartChat={()=>{}}/>);
  assert.match(document.querySelector('.pp-list-row')?.textContent??'',/0 tasks/);
  assert.doesNotMatch(document.querySelector('.pp-list-row')?.textContent??'',/in progress/i);
});
// Spec: MUS-SPEC-14-398A (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-398a)
await check('marketplace cards show the source name and keep full provenance in a tooltip',async()=>{
  await render(<PluginsScreen/>);
  [...document.querySelectorAll<HTMLButtonElement>('.plugins-view-tabs [role="tab"]')].find(b=>b.textContent?.startsWith('Discover'))!.click();await delay(30);
  const source=document.querySelector('.plugins-card-text em');assert.ok(source);
  assert.equal(source.textContent,'local-marketplace');
  assert.equal(source.getAttribute('title'),'Codex: local-marketplace');
  assert.ok(document.querySelector('[aria-label="Install Notes"]'),'Discover offers the uninstalled package');
});
root.unmount();assert.deepEqual(errors,[]);
if(failures.length)throw new Error(`${failures.length} UI sweep checks failed`);
process.exit(0);
