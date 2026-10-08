/** PiP cluster + right-sidebar session tabs (#308): bundled by scripts/test-renderer.mjs, native browser views stubbed. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
const memory={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,localStorage:memory,sessionStorage:memory,CustomEvent:window.CustomEvent});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:300,height:188,top:0,left:0,right:300,bottom:188});
(window as any).innerWidth=1400;(window as any).innerHeight=900;
const calls:{command:string;input:any}[]=[];
const chat={id:'c1',title:'Research',folderId:'repo',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'test',mode:'agent'};
const snapshot={chats:[chat],folders:[{id:'repo',name:'repo',path:'/repo'}],projects:[],version:1,activeChatId:'c1'};
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot;
  if(command==='chat.timeline')return {items:[],cursor:null};
  if(command==='browser.status')throw new Error('closed');
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const ui=await import('../src/renderer/computerUse');
const {ComputerPip,openSessionTab}=await import('../src/renderer/components/ComputerPip');
const {Workspace}=await import('../src/renderer/components/Workspace');
const {saveWorkspace,readWorkspace}=await import('../src/renderer/workspacePersistence');
await store.boot();await delay(30);

// A chat that already used the browser and the desktop: two frames arrive, but nothing may start.
const frame=(host:string,at:number)=>({chatId:'c1',owner:'',profileId:'personal',dataUrl:'data:image/jpeg;base64,AA',width:2,height:1,url:`https://${host}/`,title:host,action:'Opened '+host,at});
const now=Date.now();
ui.applyComputerEvent({type:'computerFrame',frame:frame('a.test',now-2000)});
ui.applyComputerEvent({type:'computerFrame',frame:frame('b.test',now-1000)});

const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<><ComputerPip/><Workspace/></>);
await delay(80);
const cards=()=>[...document.querySelectorAll<HTMLElement>('.pip-card')];
const shown=()=>cards().filter(card=>!card.hasAttribute('data-docked'));
const main=(card:HTMLElement)=>card.querySelector<HTMLButtonElement>('.pip-card-main')!;
const front=()=>shown().find(card=>card.classList.contains('is-front'))!;
const tabsText=()=>[...document.querySelectorAll('[role="tab"]')].map(tab=>tab.textContent);

// 5. No auto-start: two idle PiPs, no tab, no sidebar, no browser session.
assert.deepEqual(errors,[]);
assert.equal(cards().length,2,'both sessions show as PiPs');
assert.equal(store.getState().tabs.length,0);assert.equal(store.getState().resourcesHidden,true,'the sidebar stays closed');
assert.equal(calls.some(call=>call.command.startsWith('browser.')&&call.command!=='browser.status'),false,'no browser session started');
assert.equal(shown().length,2);

// 3. Z-order: the newest page is in front; clicking the one behind raises it and the other moves back.
const keyOf=(card:HTMLElement)=>card.getAttribute('data-session')!;
const firstFront=keyOf(front());
const behind=shown().find(card=>!card.classList.contains('is-front'))!;
assert.match(main(behind).getAttribute('aria-label')!,/Bring .* to the front/);
const behindKey=keyOf(behind);
main(behind).click();await delay(30);
assert.equal(keyOf(front()),behindKey,'clicked card comes to the front');
assert.equal(store.getState().tabs.length,0,'raising does not open the sidebar');
assert.notEqual(keyOf(front()),firstFront);
assert.ok(Number(front().style.zIndex)>Number(shown().find(card=>!card.classList.contains('is-front'))!.style.zIndex),'front card has the higher z-index');

// 1. Several tabs beside a file tab. Open a file tab first, then both sessions.
store.openTab({id:'files:repo',kind:'files',folderId:'repo',title:'repo'});await delay(20);
main(front()).click();await delay(40);               // 2. click on the front PiP -> its tab, sidebar open
let state=store.getState();
assert.equal(state.tabs.length,2);assert.equal(state.resourcesHidden,false,'the sidebar opened');
const firstTab=state.tabs.find(tab=>tab.kind==='liveView')!;
assert.equal(state.activeTabId,firstTab.id);
assert.ok(document.querySelector(`[data-session-tab="${firstTab.id}"]`),'the session tab shows its live view');
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,1,'the PiP of the open tab steps aside');
assert.equal(shown().length,1,'the other session is still a PiP');
// 4. No double visibility: the docked card's session is exactly the visible tab's.
const dockedCard=cards().find(card=>card.hasAttribute('data-docked'))!;
assert.ok(dockedCard.getAttribute('data-session')!.startsWith('c1|browser:'));
main(shown()[0]!).click();await delay(40);          // second session -> second tab (the sidebar is not taken over)
state=store.getState();
assert.equal(state.tabs.length,3,'a second session opens beside the first');
const sessionTabs=state.tabs.filter(tab=>tab.kind==='liveView');assert.equal(sessionTabs.length,2);
assert.equal(state.tabs.some(tab=>tab.kind==='files'),true,'other tabs are kept');
assert.equal(state.activeTabId,sessionTabs[1]!.id);
assert.equal(tabsText().length,3);
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,1,'only the tab on screen hides its PiP');
assert.notEqual(keyOf(shown()[0]!),keyOf(cards().find(card=>card.hasAttribute('data-docked'))!),'the inactive tab\'s session is back in the PiP');
// Switching tabs swaps which card is docked.
store.activateTab(sessionTabs[0]!.id);await delay(30);
assert.equal(document.querySelector('[data-session-tab]')!.getAttribute('data-session-tab'),sessionTabs[0]!.id);
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,1);
// Focusing an already-open tab from its PiP does not duplicate it.
openSessionTab(ui.computerUi().frames.c1!);await delay(20);
assert.equal(store.getState().tabs.filter(tab=>tab.kind==='liveView').length,2);
// Closing a session tab returns it to the PiP; closing the sidebar shows every PiP.
store.closeTab(sessionTabs[0]!.id);await delay(30);
assert.equal(store.getState().tabs.length,2);
assert.equal(store.getState().activeTabId,sessionTabs[1]!.id);
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,1,'the neighbouring session tab is on screen');
store.activateTab('files:repo');await delay(30);
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,0,'a file tab on screen -> both PiPs');
store.activateTab(sessionTabs[1]!.id);await delay(20);
store.setResourcesHidden(true);await delay(30);
assert.equal(cards().filter(card=>card.hasAttribute('data-docked')).length,0,'sidebar closed -> PiP shows again');
// Live-view tabs and agent browser tabs are never restored, so reopening never starts a session.
const saved=new Map<string,string>();
saveWorkspace({setItem:(k,v)=>void saved.set(k,v)},{tabs:[...store.getState().tabs,{id:'browser:agent-c1',kind:'browser',browserProfileId:'personal',url:'https://a.test/',title:'Browser'}],activeTabId:null});
const restored=readWorkspace({getItem:k=>saved.get(k)??null});
assert.equal(restored.tabs.some(tab=>(tab.kind as string)==='liveView'||tab.id.startsWith('browser:agent-')),false);
assert.deepEqual(errors,[]);
console.log('pip-components ok');
process.exit(0);
