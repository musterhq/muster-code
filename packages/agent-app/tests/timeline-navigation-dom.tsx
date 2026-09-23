import assert from 'node:assert/strict';
import type {TimelineItem} from '../src/shared/protocol';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {window}=require('linkedom').parseHTML('<html><body><div id="root"></div></body></html>');
window.innerWidth=1000;window.innerHeight=800;(window.document as any).oninput=null;(window as any).getSelection=()=>({anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});// React only wires native input events when the document advertises them.
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
// Find highlighting uses the CSS Custom Highlight API; linkedom has neither it nor Range offsets.
class Highlight extends Set<any>{constructor(...ranges:any[]){super(ranges);}}
Object.assign(globalThis,{Highlight,CSS:{highlights:new Map<string,Highlight>()},MutationObserver:window.MutationObserver});
window.document.createRange=()=>({setStart(node:any,offset:number){(this as any).node=node;(this as any).start=offset;},setEnd(_node:any,offset:number){(this as any).end=offset;},toString(){return (this as any).node.nodeValue.slice((this as any).start,(this as any).end);}}) as any;
let focused:any;Object.defineProperty(document,'activeElement',{get:()=>focused});
window.HTMLElement.prototype.focus=function(){focused=this;this.dispatchEvent(new window.Event('focusin',{bubbles:true}));};
Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{get(){return 350;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get(){return Number.parseFloat(this.querySelector('.timeline-inner')?.style.height||'350');}});
Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get(){return this.classList.contains('timeline-row')?70:350;}});
Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get(){return 800;}});
window.HTMLElement.prototype.getBoundingClientRect=function(){return{height:this.classList.contains('timeline-row')?70:350,width:800,top:0,left:0,bottom:350,right:800};};
window.HTMLElement.prototype.scrollTo=function({top}:any){this.scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));queueMicrotask(()=>this.dispatchEvent(new window.Event('scroll')));};
const React=await import('react');const {createRoot}=await import('react-dom/client');
const {Timeline}=await import('../src/renderer/components/ChatView');
const {TimelineNavigation}=await import('../src/renderer/components/TimelineNavigation');
const {summarizeTurns}=await import('../src/renderer/components/timeline-navigation-model');
const rows=Array.from({length:80},(_,index)=>({id:(index%2?'a':'u')+Math.floor(index/2),chatId:'one',kind:index%2?'assistant' as const:'user' as const,text:(index%2?'Answer ':'Request ')+Math.floor(index/2),createdAt:'2026-09-19T10:00:00Z'}));
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const render=async(items:TimelineItem[]=rows,key='one')=>{root.render(<Timeline key={key} chatId={key} items={items}/>);await delay(70);assert.deepEqual(errors,[]);};
await render();
let timeline=document.querySelector('.timeline') as HTMLElement;
assert.ok(document.querySelector('nav[aria-label="Conversation turns"]'));
assert.ok(document.querySelectorAll('.turn-tick').length<=33);
timeline.scrollTop=1400;timeline.dispatchEvent(new window.Event('scroll'));await delay(40);
// Explicit jump pauses tail following and saves the virtual reading anchor.
// Tail-centered rail may not currently include turn 11: use keyboard Home.
const tick=document.querySelector('.turn-tick[tabindex="0"]') as HTMLButtonElement;
const key=(node:Element,name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});node.dispatchEvent(event);};
tick.dispatchEvent(new window.Event('mouseover',{bubbles:true}));await delay(10);
assert.ok(document.querySelector('[role="tooltip"][data-native-preview-overlay]'),'hover preview participates in native overlay suppression');
tick.dispatchEvent(new window.Event('mouseout',{bubbles:true}));await delay(10);
key(tick,'Home');await delay(20);
assert.equal(document.activeElement?.getAttribute('aria-label'),'Turn 1: Request 0');
assert.match(document.querySelector('[role="tooltip"]')?.textContent??'',/Answer 0/);
key(document.activeElement!,'Escape');await delay(10);assert.equal(document.querySelector('[role="tooltip"]'),null);
const readingAnchor=()=>{
  const row=Array.from(document.querySelectorAll<HTMLElement>('.timeline-row')).find(row=>Number(/translateY\(([-\d.]+)px\)/.exec(row.style.transform)?.[1])+row.offsetHeight>timeline.scrollTop)!;
  return {id:row.dataset.itemId,offset:timeline.scrollTop-Number(/translateY\(([-\d.]+)px\)/.exec(row.style.transform)?.[1])};
};
const previousReading=readingAnchor();
(document.activeElement as HTMLButtonElement).click();await delay(60);
assert.equal(timeline.scrollTop,0);
const before=timeline.scrollTop;
await render([...rows.slice(0,-1),{...rows.at(-1)!,text:'Streaming update '+ 'x'.repeat(500)}]);
assert.equal(document.querySelector('.timeline'),timeline,'streaming does not remount');assert.equal(timeline.scrollTop,before,'tail updates do not steal navigation position');
assert.equal(document.querySelector('[aria-label="Back to previous reading position"]')?.hasAttribute('disabled'),false);
(document.querySelector('[aria-label="Back to previous reading position"]') as HTMLButtonElement).click();await delay(60);
assert.deepEqual(readingAnchor(),previousReading,'Back restores anchor plus offset even when row measurement changes absolute position');
(document.querySelector('[aria-label="Go to latest conversation activity"]') as HTMLButtonElement).click();await delay(30);
assert.ok(timeline.scrollTop>0);
await render([{...rows[0],id:'other',chatId:'two',text:'Second chat only'}],'two');
assert.equal(document.querySelectorAll('.turn-tick').length,1);assert.match(document.querySelector('.turn-tick')?.getAttribute('aria-label')??'',/Second chat only/);
assert.equal(document.querySelector('[aria-label="Back to previous reading position"]')?.hasAttribute('disabled'),true);
// All turns remain keyboard-reachable without rendering thousands of buttons.
const many=summarizeTurns(Array.from({length:5000},(_,index)=>({...rows[0],id:'many'+index,text:'Prompt '+index})));
let chosen='';root.render(<TimelineNavigation turns={many} currentId="many0" canGoBack={false} onTurn={id=>{chosen=id;}} onBack={()=>{}} onLatest={()=>{}}/>);await delay(30);
key(document.querySelector('.turn-tick[tabindex="0"]')!,'End');await delay(30);
assert.equal(document.activeElement?.getAttribute('aria-label'),'Turn 5000: Prompt 4999');
(document.activeElement as HTMLButtonElement).click();assert.equal(chosen,'many4999');assert.ok(document.querySelectorAll('.turn-tick').length<=33);
// Find: ⌘F event opens the field, counts occurrences, marks them, and unfolds a completed turn's activity.
const at=(s:number)=>new Date(Date.UTC(2026,8,22,10,0,s)).toISOString();
const findRows=[
  {id:'fu0',chatId:'find',kind:'user' as const,text:'Find the widget',createdAt:at(0)},
  {id:'ft1',chatId:'find',kind:'tool' as const,status:'completed',text:'grep widget\nwidget.ts:1 widget',createdAt:at(5),data:{type:'commandExecution',command:'grep widget',output:'widget.ts:1 widget',exitCode:0}},
  {id:'ft2',chatId:'find',kind:'tool' as const,status:'completed',text:'ls',createdAt:at(9),data:{type:'commandExecution',command:'ls',output:'a',exitCode:0}},
  {id:'fa0',chatId:'find',kind:'assistant' as const,text:'Done with widget',createdAt:at(30)},
  {id:'fu1',chatId:'find',kind:'user' as const,text:'Next',createdAt:at(40)},
  {id:'fa1',chatId:'find',kind:'assistant' as const,text:'ok',createdAt:at(41)},
];
await render(findRows,'find');
const header=document.querySelector('.turn-worked');
assert.equal(header?.textContent,'Worked for 30s · Ran 2 commands','folded, the header says what the work was (Codex)');assert.equal(header?.getAttribute('aria-expanded'),'false','older completed turns fold their activity');
assert.ok(!document.querySelector('.activity-group'),'folded activity is not rendered');
assert.ok(!document.querySelector('.working-tail'),'no live tail when idle');
window.dispatchEvent(new window.Event('muster:find-in-chat'));await delay(20);
const input=document.querySelector('input[aria-label="Find in conversation"]') as HTMLInputElement;
assert.ok(input,'find-in-chat event opens the search field');assert.ok(document.activeElement===input,'and focuses it');
input.value='widget';(input as any)._valueTracker?.setValue('');input.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(20);
assert.match(document.querySelector('.timeline-search-count')?.textContent??'',/^0 of 5$/,'counts occurrences (user 1, tool 3, assistant 1), not rows');
const highlights=(globalThis as any).CSS.highlights as Map<string,Set<any>>;
assert.equal(highlights.get('chat-find')?.size,2,'visible prose occurrences are marked (tool rows are folded)');
key(input,'Enter');await delay(80);
assert.match(document.querySelector('.timeline-search-count')?.textContent??'',/^1 of 5$/);
assert.equal([...highlights.get('chat-find-active')!].map(range=>range.toString()).join(),'widget');
key(input,'Enter');await delay(120);
assert.equal(document.querySelector('.turn-worked')?.getAttribute('aria-expanded'),'true','a hit in folded activity unfolds its turn');
assert.ok(document.querySelector('.activity-group[data-open]')||document.querySelector('.activity-details'),'and opens the collapsed activity group');
assert.ok((highlights.get('chat-find')?.size??0)>2,'revealed tool text is marked too');
assert.equal(highlights.get('chat-find-active')?.size,1);
key(input,'Escape');await delay(30);
assert.ok(!highlights.has('chat-find'),'closing find clears every mark');
// Live runs show the shimmering tail with a Working-for timer.
await render([...findRows,{id:'fu2',chatId:'find',kind:'user' as const,text:'Go',createdAt:new Date(Date.now()-72000).toISOString()},{id:'ft3',chatId:'find',kind:'tool' as const,status:'running',text:'npm test',createdAt:new Date().toISOString(),data:{type:'commandExecution',command:'npm test'}}],'find');
assert.equal(document.querySelector('.working-tail')?.textContent,'Running npm test','the tail says what the agent is doing now');
assert.match(document.querySelector('.turn-worked.is-live')?.textContent??'',/^Working for 1m 1[23]s$/,'the live turn is headed "Working for …" (Codex)');
// Reasoning: "Thinking" expands to the live stream; an empty reasoning item is a plain label, never an expander.
const click=(node:Element|null)=>{assert.ok(node,'clickable element');(node as HTMLElement).click();};
const thinking=(text:string,status='running')=>[{id:'ru',chatId:'think',kind:'user' as const,text:'Think',createdAt:at(0)},{id:'rr',chatId:'think',kind:'reasoning' as const,status,text,createdAt:at(1)}];
await render(thinking(''),'think');
assert.equal(document.querySelector('.reasoning-row.is-empty')?.textContent,'Thinking');
assert.equal(document.querySelector('.reasoning-trigger'),null,'nothing to open, so no expander');
await render(thinking('**Plan** first step'),'think');
const trigger=document.querySelector('.reasoning-trigger');
assert.equal(trigger?.getAttribute('aria-expanded'),'false');
click(trigger);await delay(40);
assert.equal(document.querySelector('.reasoning-trigger')?.getAttribute('aria-expanded'),'true','click opens it');
assert.match(document.querySelector('.reasoning-body')?.textContent??'',/Plan first step/);
await render(thinking('**Plan** first step, then the second'),'think');
assert.match(document.querySelector('.reasoning-body')?.textContent??'',/then the second/,'new deltas stream into the open row');
assert.equal(document.querySelector('.reasoning-trigger')?.getAttribute('aria-expanded'),'true','and it stays open across updates');
assert.equal(document.querySelector('.working-tail')?.textContent,'','the tail does not repeat "Thinking" under a streaming reasoning row');
await render(thinking('**Plan** done','completed'),'think');
assert.match(document.querySelector('.reasoning-trigger')?.textContent??'',/^Thought/);
click(document.querySelector('.reasoning-trigger'));await delay(260);
assert.equal(document.querySelector('.reasoning-trigger')?.getAttribute('aria-expanded'),'false','and collapses back');

// Edits stay visible after a turn: one Edited row per file, the whole file in an editor view (no @@, no "diff" label).
const {getState}=await import('../src/renderer/store');
const {saveGlobalDiffPreferences,readGlobalDiffPreferences}=await import('../src/renderer/diff-preferences');
const state=getState() as any;
state.snapshot={...(state.snapshot??{}),folders:[{id:'f1',name:'w',path:'/w'}],chats:[{id:'edits',title:'Edits',folderId:'f1',status:'completed'}],projects:[]};
state.showInlineFileDiffs=true;
const onDisk=Array.from({length:40},(_,index)=>`line ${index+1}`).join('\n')+'\n';
const reads:string[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){if(command==='files.read'){reads.push(input.path);return {path:input.path,text:input.path==='src/app.ts'?onDisk:'# Notes\n- one\n',truncated:false};}if(command==='review.baselines')return [];if(command==='review.marks')return [];throw new Error('not a git repository');}};
const appPatch='@@ -3,7 +3,7 @@\n line 3\n line 4\n line 5\n-old six\n+line 6\n line 7\n line 8\n line 9\n@@ -30,6 +30,7 @@\n line 30\n line 31\n line 32\n+line 33\n line 34\n line 35\n line 36\n';
const edits=[
  {id:'eu',chatId:'edits',kind:'user' as const,text:'Edit two files',createdAt:at(0)},
  {id:'et1',chatId:'edits',kind:'tool' as const,status:'completed',text:'',createdAt:at(2),data:{type:'fileChange',changes:[{path:'/w/src/app.ts',kind:'update',diff:appPatch}]}},
  {id:'et2',chatId:'edits',kind:'tool' as const,status:'completed',text:'',createdAt:at(3),data:{type:'fileChange',changes:[{path:'/w/notes.md',kind:{type:'add'},diff:'# Notes\n- one\n'}]}},
  {id:'ea',chatId:'edits',kind:'assistant' as const,text:'Done.',createdAt:at(9)},
];
await render(edits,'edits');await delay(80);
const rowsFor=()=>Array.from(document.querySelectorAll('.turn-files .edited-file-row'));
assert.deepEqual(rowsFor().map(row=>row.querySelector('.tool-row-text')?.textContent),['Edited app.ts','Created notes.md'],'one row per file, outside the work group');
assert.deepEqual(rowsFor().map(row=>row.querySelector('.diff-stat')?.getAttribute('aria-label')),['2 lines added, 1 removed','2 lines added, 0 removed'],'"- one" in a new markdown file is an addition');
assert.equal(document.querySelector('.turn-files-pill'),null,'the latest turn\'s pill floats above the composer instead');
const appRows=()=>rowsFor()[0].querySelectorAll('.fde .inline-diff-row');
assert.deepEqual(reads.sort(),['notes.md','src/app.ts'],'the latest turn opens with each file read from disk');
assert.equal(appRows().length,41,'every line of the 40-line file renders, plus the removed line in place');
assert.equal(rowsFor()[0].querySelectorAll('.fde .inline-diff-row.is-add').length,2);
const removed=rowsFor()[0].querySelector('.fde .inline-diff-row.is-del');
assert.equal(removed?.querySelector('.fde-num')?.textContent,'6','a removed line keeps its old line number');
assert.equal((removed?.nextElementSibling as HTMLElement|null)?.dataset.line,'6','and sits right above the line that replaced it');
const transcriptText=document.querySelector('.turn-files')?.textContent??'';
assert.ok(!transcriptText.includes('@@'),'no hunk headers in the transcript');
assert.equal(document.querySelector('.turn-files .md-code-lang'),null,'no "diff" language label');
assert.equal(document.querySelector('.turn-files .fde-hunk-actions'),null,'without a review baseline there are no Keep/Undo controls at all');
// "Inline diff length": Changes with context folds unchanged code into expandable rows.
const stored=new Map<string,string>();(globalThis as any).localStorage={getItem:(key:string)=>stored.get(key)??null,setItem:(key:string,value:string)=>{stored.set(key,value);},removeItem:(key:string)=>{stored.delete(key);}};
const preferences=readGlobalDiffPreferences();
assert.equal(preferences.fullFile,true,'Full file is the default inline diff length');
// Node's CustomEvent does not reach linkedom listeners; the app's own event is re-sent through linkedom.
saveGlobalDiffPreferences({...preferences,fullFile:false});window.dispatchEvent(new window.CustomEvent('muster:diff-preferences'));await delay(40);
assert.ok(appRows().length<41,'fewer rows with changes-with-context');
const gap=rowsFor()[0].querySelector('button.fde-gap');
assert.match(gap?.textContent??'',/unchanged lines/);
const folded=appRows().length;click(gap);await delay(30);
assert.ok(appRows().length>folded,'a folded run opens in place');
saveGlobalDiffPreferences({...preferences,fullFile:true});window.dispatchEvent(new window.CustomEvent('muster:diff-preferences'));await delay(40);
assert.equal(appRows().length,41,'back to the full file');
// With a live review (a Git baseline for the latest turn) counts follow the review: an undone hunk leaves them.
const {refreshRunMarks}=await import('../src/renderer/reviewState');
const beforeTurn=onDisk.replace('line 6\n','old six\n').replace('line 33\n','');
let marks:any[]=[];
const change=(path:string,adds:number,dels:number)=>({path,status:'M',adds,dels,beforeHash:'b',afterHash:'a',revision:path+adds+dels});
(window as any).muster.invoke=async(command:string,input:any)=>{
  if(command==='review.baselines')return [{runId:'r1',chatId:'rev',folderId:'f1',treeSha:'t1',at:at(0)}];
  if(command==='review.changes')return {baseline:{runId:'r1'},label:'turn',truncated:false,files:[change('src/app.ts',1,1),change('notes.md',2,0)]};
  if(command==='review.marks')return marks;
  if(command==='review.fileDiff')return input.path==='src/app.ts'?{path:input.path,status:'M',before:beforeTurn,after:onDisk,truncated:false,size:{before:1,after:1},beforeHash:'b',afterHash:'a',revision:'1',label:'turn'}:{path:input.path,status:'A',before:'',after:'# Notes\n- one\n',truncated:false,size:{before:0,after:1},beforeHash:'',afterHash:'n',revision:'2',label:'turn'};
  if(command==='files.read')return {path:input.path,text:input.path==='src/app.ts'?onDisk:'# Notes\n- one\n',truncated:false};
  throw new Error('not a git repository');
};
state.snapshot.chats=[...state.snapshot.chats,{id:'rev',title:'Review',folderId:'f1',status:'completed'}];
await render(edits.map(item=>({...item,id:'r'+item.id,chatId:'rev'})),'rev');await delay(150);
assert.deepEqual(rowsFor().map(row=>row.querySelector('.diff-stat')?.getAttribute('aria-label')),['1 line added, 1 removed','2 lines added, 0 removed'],'row counts come from the review (one app.ts addition was undone), the file stays listed');
const appActions=()=>rowsFor()[0].querySelectorAll('.fde-hunk-actions');
assert.equal(appActions().length,2,'each pending change block has Keep/Undo');
assert.ok(rowsFor()[0].querySelector('.fde-head.is-actions'),'and the file has Keep all / Undo all');
marks=[{runId:'r1',path:'src/app.ts',hunkId:'*',state:'kept',at:at(30)}];await refreshRunMarks('r1');await delay(80);
assert.equal(appActions().length,0,'once every hunk is kept the Keep/Undo pills disappear');
assert.equal(rowsFor()[0].querySelector('.fde-head.is-actions'),null);
assert.equal(rowsFor()[0].querySelectorAll('.fde .inline-diff-row.is-add,.fde .inline-diff-row.is-del').length,0,'and the rows return to normal tint');
assert.equal(rowsFor()[0].querySelectorAll('.fde .inline-diff-row').length,40,'the whole file still shows');
// An older turn shows its own pill; a following turn makes this one "not latest".
await render([...edits,{id:'eu2',chatId:'edits',kind:'user' as const,text:'Thanks',createdAt:at(20)},{id:'ea2',chatId:'edits',kind:'assistant' as const,text:'Sure.',createdAt:at(21)}],'edits');await delay(40);
assert.equal(document.querySelector('.turn-files-pill')?.textContent,'2 files changed+4-1','every earlier turn that edited files ends with its pill');
root.unmount();assert.deepEqual(errors,[]);console.log('Timeline DOM checks passed: anchors, keyboard/preview/Escape, jump/back/latest, stream continuity, chat switch, bounded long history, find occurrences/highlights/unfold, worked-for header, live tail, reasoning expand/stream, edited-file rows with whole-file editor diff, inline diff length setting, per-turn pills.');
