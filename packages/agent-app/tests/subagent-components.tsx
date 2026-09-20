/** Focused DOM checks; bundle with esbuild (CSS empty) and run with Node. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require = createRequire(import.meta.url);
const {parseHTML} = require('linkedom');
const {window} = parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis, {
  window, document:window.document, HTMLElement:window.HTMLElement, Element:window.Element,
  localStorage:{getItem(){return null;},setItem(){}},
  requestAnimationFrame:(callback:any)=>setTimeout(callback,0), cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),
});
window.HTMLElement.prototype.getBoundingClientRect = () => ({height:120,width:600,top:0,left:0,bottom:120,right:600});
const chat = {id:'chat',title:'Background review',projectId:'project',pinned:false,archived:false,draft:'',status:'completed',updatedAt:'',model:'test',mode:'agent'};
let snapshot = {chats:[chat,{...chat,id:'error',title:'Unavailable conversation'}],folders:[{id:'a',name:'One',path:'/one'},{id:'b',name:'Two',path:'/two'}],projects:[{id:'project',name:'Project',goal:'',folderIds:['a','b']}],version:1,activeChatId:'chat'};
const items = [{id:'child-report',chatId:'chat',kind:'tool',text:'',createdAt:'2026-01-01T00:00:00Z',data:{type:'collabAgentToolCall',receiverAgents:[{threadId:'alpha',name:'Reviewer',prompt:'Review the changes',result:'Earlier review result'},{threadId:'beta',name:'Researcher'},{threadId:'gamma',name:'Tester'},{threadId:'delta',name:'Planner'},{threadId:'unknown',name:'Unnamed status'}],agentsStates:{alpha:'running',beta:'pendingInit',gamma:'failed',delta:'completed'}}}];
let eventListener:(event:any)=>void = ()=>{};
let failTimeline = true;
(window as any).muster = {
  subscribe(listener:any){eventListener=listener;return ()=>{};},
  async invoke(command:string,input:any){
    if(command==='app.snapshot') return snapshot;
    if(command==='chat.timeline') {
      if(input.id==='error' && failTimeline) throw new Error('Saved activity cannot be loaded');
      return {items:input.id==='chat'?items:[],revision:1};
    }
    if(command==='git.changes') return [];
    if(command==='chat.contextTelemetry') return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
    return undefined;
  },
};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {WorkspaceOverview} = await import('../src/renderer/components/WorkspaceOverview');
const {SubagentsTab} = await import('../src/renderer/components/SubagentsTab');
const store = await import('../src/renderer/store');
const errors:unknown[] = [];
const root = createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const tab = {id:'subagents:chat',kind:'subagents' as const,chatId:'chat',title:'Saved review'};
root.render(<SubagentsTab tab={tab}/>);
await delay(40);
assert.match(document.body.textContent!,/Loading activity/);
assert.equal(document.querySelector('.subagents-empty'),null,'a restoring tab must not claim there are no agents');
await store.boot();
root.render(<><WorkspaceOverview compact/><SubagentsTab tab={tab}/></>);
await delay(70);
assert.deepEqual(errors,[]);
assert.equal(document.querySelectorAll('.workspace-chat-activity').length,1,'one summary per conversation, regardless of project folders');
assert.equal(document.querySelectorAll('.workspace-launchers button').length,4,'two file/change actions per folder, no duplicate child sections');
assert.match(document.querySelector('.workspace-chat-activity')!.textContent!,/1 working1 waiting1 done1 failed or stopped1 other or unreported/);
assert.equal(document.querySelectorAll('.subagent-row').length,5);
assert.match(document.querySelector('.subagents-header')!.textContent!,/Background review/);
assert.match(document.querySelector('.subagents-provenance')!.textContent!,/saved history/);
assert.ok(document.querySelector('.subagent-state.is-working svg'));
assert.ok(document.querySelector('.subagent-state.is-waiting svg'));
assert.ok(document.querySelector('.subagent-state.is-failed svg'));
assert.ok(document.querySelector('.subagent-state.is-done svg'));
const prompt = document.querySelector('[aria-label="Prompt for Reviewer"]') as HTMLButtonElement;
const result = document.querySelector('[aria-label="Last reported result for Reviewer"]') as HTMLButtonElement;
assert.equal(prompt.getAttribute('aria-expanded'),'false');
assert.equal(result.getAttribute('aria-expanded'),'false');
prompt.click(); await delay(50);
assert.equal(prompt.getAttribute('aria-expanded'),'true');
assert.equal(result.getAttribute('aria-expanded'),'false','prompt and result retain separate disclosure state');
assert.match(document.querySelector('.subagent-detail-body')!.textContent!,/Review the changes/);
result.click(); await delay(50);
assert.equal(result.getAttribute('aria-expanded'),'true');
assert.match(document.querySelector('.subagents-list')!.textContent!,/Earlier review result/);
assert.equal(document.querySelectorAll('details').length,0,'details use the measured animated Disclosure');
(document.querySelector('.workspace-chat-activity .workspace-inline-link') as HTMLButtonElement).click();
assert.equal(store.getState().activeTabId,'subagents:chat');
assert.equal(store.getState().tabs[0].title,'Subagents · Background review');
// Removing the folder relationship never removes the chat-level summary.
snapshot = {...snapshot,folders:[],projects:[],chats:snapshot.chats.map(chat=>({...chat,projectId:undefined as any}))};
eventListener({type:'snapshot',snapshot}); await delay(40);
assert.equal(document.querySelectorAll('.workspace-chat-activity').length,1);
assert.equal(document.querySelectorAll('.workspace-launchers').length,0);
assert.ok(document.querySelector('.workspace-empty'));
// A retained tab continues displaying its own conversation after chat selection.
await store.selectChat('error'); await delay(40);
assert.equal(document.querySelectorAll('.subagent-row').length,5);
root.render(<SubagentsTab tab={{id:'subagents:error',kind:'subagents',chatId:'error',title:'Saved error'}}/>);
await delay(40);
assert.match(document.body.textContent!,/Activity unavailable: .*Saved activity cannot be loaded/);
assert.equal(document.querySelector('.subagents-empty'),null,'load failure must not be presented as an empty conversation');
failTimeline = false;
(document.querySelector('[aria-label="Retry loading subagent activity"]') as HTMLButtonElement).click();
await delay(60);
assert.match(document.querySelector('.subagents-empty')!.textContent!,/No subagents reported yet/);
assert.equal(document.querySelector('.subagents-status.is-error'),null);
assert.deepEqual(errors,[]);
root.unmount();
console.log('Subagent component checks passed: restore, counts, one summary, folderless navigation, independent disclosure, saved-tab identity, error and retry.');
