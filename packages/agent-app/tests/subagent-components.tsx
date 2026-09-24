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
const items = [{id:'child-report',chatId:'chat',kind:'tool',text:'',createdAt:'2026-01-01T00:00:00Z',data:{type:'collabAgentToolCall',receiverAgents:[{threadId:'alpha',name:'Reviewer',prompt:'Review the changes',result:'Earlier review result'},{threadId:'beta',name:'Researcher'},{threadId:'gamma',name:'Tester'},{threadId:'delta',name:'Planner'},{threadId:'unknown',name:'Unnamed status'}],agentsStates:{alpha:'running',beta:'pendingInit',gamma:'failed',delta:{status:'completed',message:'All checks passed'}}}}];
const transcriptReads:string[] = [];
let transcriptFails = false;
const eventListeners = new Set<(event:any)=>void>();
const eventListener = (event:any) => { for (const listener of eventListeners) listener(event); };
let failTimeline = true;
const copied:string[] = [];
const controls:any[] = [];
(window as any).muster = {
  subscribe(listener:any){eventListeners.add(listener);return ()=>{eventListeners.delete(listener);};},
  async invoke(command:string,input:any){
    if(command==='app.snapshot') return snapshot;
    if(command==='chat.timeline') {
      if(input.id==='error' && failTimeline) throw new Error('Saved activity cannot be loaded');
      return {items:input.id==='chat'?items:[],revision:1};
    }
    if(command==='subagents.transcript') {
      transcriptReads.push(input.threadId);
      if(transcriptFails) throw new Error('Provider thread unavailable');
      return {threadId:input.threadId,status:input.threadId==='alpha'?'running':'completed',source:'live',startedAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:02:05Z',model:'child-model',items:[
        {id:`${input.threadId}:u`,chatId:'chat',kind:'user',text:'Review the changes',createdAt:''},
        {id:`${input.threadId}:c1`,chatId:'chat',kind:'tool',text:'npm test\nok',status:'completed',createdAt:'',data:{type:'commandExecution',command:'npm test',name:'npm test',output:'ok',threadId:input.threadId}},
        {id:`${input.threadId}:c2`,chatId:'chat',kind:'tool',text:'cat a.ts',status:'completed',createdAt:'',data:{type:'commandExecution',command:'cat a.ts',name:'cat a.ts',output:'',threadId:input.threadId}},
        {id:`${input.threadId}:a`,chatId:'chat',kind:'assistant',text:'Child answer for '+input.threadId,createdAt:''},
      ]};
    }
    if(command==='subagents.capabilities') return {stop:true,steer:true};
    if(command==='subagents.control') { controls.push(input); return input.threadId==='alpha'?{ok:true}:{ok:false,reason:'This subagent has no running turn to stop.'}; }
    if(command==='clipboard.write') { copied.push(input.text); return undefined; }
    if(command==='git.changes') return [];
    if(command==='chat.contextTelemetry') return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
    return undefined;
  },
};
const React = await import('react');
const {createRoot} = await import('react-dom/client');
const {WorkspaceOverview} = await import('../src/renderer/components/WorkspaceOverview');
const {SubagentsTab} = await import('../src/renderer/components/SubagentsTab');
const {ActivityGroup} = await import('../src/renderer/components/ActivityGroup');
const activity = await import('../src/renderer/subagentActivity');
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
const folderLaunchers = () => [...document.querySelectorAll('.workspace-launchers button')].filter(button => /^(Changes|Files)/.test(button.textContent!)).length;
assert.equal(folderLaunchers(),4,'two file/change actions per folder, no duplicate child sections');
assert.match(document.querySelector('.workspace-chat-activity')!.textContent!,/1 working1 waiting1 done1 failed or stopped1 other or unreported/);
assert.equal(document.querySelectorAll('.subagent-card').length,5);
assert.match(document.querySelector('.subagents-tab .subagent-counts')!.textContent!,/1 running1 waiting0 completed1 reported back1 failed or stopped1 not reported/);
assert.ok(!document.body.textContent!.includes('Thread'),'raw thread ids are not list content');
assert.ok(document.querySelector('.subagent-card.is-verified .subagent-phase.is-verified'),'a completed child with a reported result is verified');
assert.ok(document.querySelector('.subagent-card .subagent-avatar .agent-glyph'),'identity glyph, not a generic bot icon');
assert.equal(document.querySelector('.subagent-card .subagent-avatar .agent-glyph')!.getAttribute('style'),`--agent-hue:${(await import('../src/renderer/agentIdentity')).agentHue('Reviewer')}`,'same hue as the timeline glyph');
assert.match(document.querySelector('.subagents-header')!.textContent!,/Background review/);
assert.deepEqual([...document.querySelectorAll('.subagent-card .subagent-stop')].map(button=>button.getAttribute('aria-label')),['Stop Reviewer','Stop Researcher'],'running and queued cards get Stop');
assert.match(document.querySelector('.subagent-card.is-failed .subagent-failure')!.textContent!,/No failure reason reported/);
assert.match(document.querySelector('.subagents-provenance')!.textContent!,/saved history/);
assert.ok(document.querySelector('.subagent-phase.is-running svg'));
assert.ok(document.querySelector('.subagent-phase.is-waiting svg'));
assert.ok(document.querySelector('.subagent-phase.is-failed svg'));
assert.ok(document.querySelector('.workspace-chat-activity .subagent-state svg'),'overview keeps the reported-state badge');
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
// Opening a child shows its own streamed transcript with a back arrow, then returns to the list.
(document.querySelector('[aria-label="Open Reviewer transcript"]') as HTMLButtonElement).click();
await delay(60);
assert.equal(document.querySelectorAll('.subagent-card').length,0,'the detail replaces the list');
const view = document.querySelector('.subagent-view')!;
assert.ok(view,'detail view opens');
assert.equal(view.getAttribute('aria-label'),'Reviewer transcript');
assert.match(view.querySelector('.subagent-view-head')!.textContent!,/Reviewer/);
assert.match(view.querySelector('.subagent-view-title p')!.textContent!,/child-model/);
assert.match(view.querySelector('.subagent-phase')!.textContent!,/Running/);
assert.match(view.querySelector('.subagent-elapsed')!.textContent!,/\d/,'elapsed timer is shown');
assert.ok(view.querySelector('.subagent-avatar .agent-glyph.is-working'));
assert.match(view.querySelector('.subagent-transcript')!.textContent!,/Child answer for alpha/);
assert.equal(view.querySelectorAll('.subagent-transcript .msg-user').length,1);
assert.ok(view.querySelector('.subagent-transcript .activity-group'),'consecutive child tools group like the chat');
// TRN-10: Stop and Steer are real for a running child on a Codex route.
const steer = view.querySelector('[aria-label="Steer Reviewer"]') as HTMLButtonElement;
assert.equal(steer.disabled,false,'steering is available while the child runs');
steer.click(); await delay(30);
assert.ok(view.querySelector('.subagent-steer-form textarea'),'Steer opens an inline instruction box');
(view.querySelector('.subagent-steer-actions button[type="button"]') as HTMLButtonElement).click(); await delay(30);
assert.equal(view.querySelector('.subagent-steer-form'),null,'Cancel closes it');
const stop = view.querySelector('.subagent-view-head [aria-label="Stop Reviewer"]') as HTMLButtonElement;
assert.equal(stop.disabled,false);
stop.click(); await delay(40);
assert.deepEqual(controls,[{chatId:'chat',threadId:'alpha',action:'stop'}]);
assert.ok(!view.textContent!.includes('Thread alpha'));
assert.deepEqual(transcriptReads,['alpha']);
await delay(2100);
assert.deepEqual(transcriptReads,['alpha','alpha'],'a running child is polled');
(view.querySelector('[aria-label="Back to subagents"]') as HTMLButtonElement).click();
await delay(40);
assert.ok(!document.querySelector('.subagent-view'));
assert.equal(document.querySelectorAll('.subagent-card').length,5);
assert.equal(activity.selectedSubagent('chat'),null);
await delay(2100);
assert.deepEqual(transcriptReads,['alpha','alpha'],'polling stops when the detail closes');
// A settled child is read once; failures keep a retry.
(document.querySelector('[aria-label="Open Planner transcript"]') as HTMLButtonElement).click();
await delay(60);
assert.match(document.querySelector('.subagent-view .subagent-phase')!.textContent!,/Reported back/);
assert.match(document.querySelector('.subagent-report')!.textContent!,/All checks passed/);
await delay(2100);
assert.deepEqual(transcriptReads,['alpha','alpha','delta']);
(document.querySelector('[aria-label="Back to subagents"]') as HTMLButtonElement).click();
await delay(30);
transcriptFails = true;
(document.querySelector('[aria-label="Open Tester transcript"]') as HTMLButtonElement).click();
await delay(60);
assert.match(document.querySelector('.subagent-transcript')!.textContent!,/Transcript unavailable: .*Provider thread unavailable/);
assert.match(document.querySelector('.subagent-view > .subagent-failure')!.textContent!,/No failure reason reported/,'a failed child says why, or that the provider did not');
assert.equal((document.querySelector('.subagent-view-head [aria-label="Stop Tester"]') as HTMLButtonElement).disabled,true,'a failed child cannot be stopped');
transcriptFails = false;
(document.querySelector('[aria-label="Retry loading subagent transcript"]') as HTMLButtonElement).click();
await delay(60);
assert.match(document.querySelector('.subagent-transcript')!.textContent!,/Child answer for gamma/);
assert.ok(!document.querySelector('.subagent-transcript .subagents-status.is-error'));
activity.selectSubagent('chat',null); await delay(30);
// A timeline lifecycle row for one agent opens that agent's transcript directly.
const host = document.createElement('div'); document.body.appendChild(host);
const rowRoot = createRoot(host);
rowRoot.render(<ActivityGroup items={[{id:'spawn',chatId:'chat',kind:'tool',text:'',status:'completed',createdAt:'',data:{type:'collabAgentToolCall',tool:'spawnAgent',receiverThreadIds:['beta'],agentNickname:'Researcher'}} as any]}/>);
await delay(30);
(host.querySelector('.subagent-row') as HTMLButtonElement).click();
await delay(60);
assert.equal(activity.selectedSubagent('chat'),'beta');
assert.equal(store.getState().activeTabId,'subagents:chat');
assert.equal(document.querySelector('.subagent-view')!.getAttribute('aria-label'),'Researcher transcript');
rowRoot.unmount(); host.remove();
activity.selectSubagent('chat',null); await delay(30);
// Removing the folder relationship never removes the chat-level summary.
snapshot = {...snapshot,version:2,folders:[],projects:[],chats:snapshot.chats.map(chat=>({...chat,projectId:undefined as any}))};
eventListener({type:'snapshot',snapshot}); await delay(40);
assert.equal(document.querySelectorAll('.workspace-chat-activity').length,1);
assert.equal(folderLaunchers(),0);
assert.ok(document.querySelector('.workspace-empty'));
// A retained tab continues displaying its own conversation after chat selection.
await store.selectChat('error'); await delay(40);
assert.equal(document.querySelectorAll('.subagent-card').length,5);
assert.match(document.querySelector('.subagents-tab .subagent-counts')!.textContent!,/1 running1 waiting0 completed1 reported back1 failed or stopped1 not reported/);
assert.ok(!document.body.textContent!.includes('Thread'),'raw thread ids are not list content');
assert.ok(document.querySelector('.subagent-card.is-verified .subagent-phase.is-verified'),'a completed child with a reported result is verified');
assert.ok(document.querySelector('.subagent-card .subagent-avatar .agent-glyph'),'identity glyph, not a generic bot icon');
assert.equal(document.querySelector('.subagent-card .subagent-avatar .agent-glyph')!.getAttribute('style'),`--agent-hue:${(await import('../src/renderer/agentIdentity')).agentHue('Reviewer')}`,'same hue as the timeline glyph');
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
console.log('Subagent component checks passed: restore, counts, identity hue, child transcript detail with back, polling, retry, timeline row opens child, folderless navigation, disclosure, saved-tab identity, error and retry.');
