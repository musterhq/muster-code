/** Run with node tests/run-git-components.mjs: composer environment/branch footer, branch switch with carried changes, summary card fetch wording, sandbox scope, PR detail. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
const saved=new Map<string,string>();
/** Live ResizeObserver stubs, so a test can simulate the conversation column being resized. */
const resizeObservers=new Set<{cb:()=>void}>();
const resize=()=>{for(const observer of [...resizeObservers])observer.cb();};
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{cb:()=>void;constructor(cb:()=>void){this.cb=cb;}observe(){resizeObservers.add(this);}disconnect(){resizeObservers.delete(this);}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};
// linkedom never lays anything out, so clientWidth is normally undefined; the summary card's float/
// reserve/overlay pick reads it directly. A `data-test-width` attribute makes it controllable per element.
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{configurable:true,get(){const raw=(this as Element).getAttribute?.('data-test-width');return raw?Number(raw):1800;}});
(window.document as any).hasFocus=()=>true;

const calls:{command:string;input:any}[]=[];
let fetchedAt:string|null=null,blockNext=true;
const status={branch:'main',detached:false,unborn:false,revision:'r1',files:[],truncated:false,stagedCount:0,conflicted:false,upstream:'origin/main',ahead:0,behind:0,pushRemote:'origin',remoteUrl:'https://github.com/o/r'};
const chat={id:'c',title:'Build it',folderId:'f',status:'completed',updatedAt:'',pinned:false,archived:false,draft:'',model:'m',mode:'agent'};
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats:[chat],folders:[{id:'f',name:'Repo',path:'/repo'}],projects:[],activeChatId:'c'};
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='processes.summary')return {revision:1,sessions:[]};
  if(command==='processes.ports')return {chatId:input.chatId,supported:true,scannedAt:'',ports:[{id:'listener:a',port:5174,address:'127.0.0.1',name:'vite',owner:'agent',source:{kind:'agent'}}]};
  if(command==='git.info')return {branch:'main',detached:false,fetchedAt,hasRemote:true,worktree:null};
  if(command==='git.status')return status;
  if(command==='git.changes')return [];
  if(command==='git.pullRequests')return {available:true,items:[{number:7,title:'Add worktrees',url:'https://github.com/o/r/pull/7',state:'OPEN',headRefName:'feat/wt',isDraft:true}]};
  if(command==='git.branches')return {current:'main',detached:false,local:[{name:'main',upstream:'origin/main',ahead:0,behind:0,worktreePath:'/repo'},{name:'dev'},{name:'feat/wt',worktreePath:'/data/wt'}],recent:['dev'],truncated:false};
  if(command==='git.switch'){if(blockNext&&!input.carry){blockNext=false;return {blocked:true,files:['a.ts','b.ts'],total:2};}return {blocked:false,status:{...status,branch:input.branch}};}
  if(command==='git.fetch'){fetchedAt=new Date().toISOString();return {status,info:{branch:'main',detached:false,fetchedAt,hasRemote:true,worktree:null}};}
  if(command==='git.worktree.list')return [{path:'/repo',branch:'main',head:'x',main:true,current:true,dirty:false,locked:false,prunable:false,folderId:'f'},{path:'/data/wt',branch:'feat/wt',head:'y',main:false,current:false,dirty:false,locked:false,prunable:false}];
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const {EnvironmentFooter}=await import('../src/renderer/components/EnvironmentFooter');
const {SummaryCard,pickSummaryLayout}=await import('../src/renderer/components/SummaryCard');
await store.boot();
const text=(selector:string)=>Array.from(document.querySelectorAll(selector)).map(node=>node.textContent??'');
const key=(target:Element,name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});target.dispatchEvent(event);};
const type=(input:HTMLInputElement,value:string)=>{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(input),'value')?.set;setter?setter.call(input,value):(input.value=value);input.dispatchEvent(new window.Event('input',{bubbles:true}));};

// --- Composer footer: environment ▾ · branch ▾ ------------------------------------------------------
const host=document.getElementById('root')!;
let root=createRoot(host);
root.render(<EnvironmentFooter chat={chat as any} folder={{id:'f',name:'Repo',path:'/repo'}}/>);
await delay(120);
const triggers=text('.env-footer-trigger');
assert.equal(triggers.length,2,'environment and branch dropdowns: '+triggers.join(' | '));
assert.match(triggers[0],/This Mac/);
assert.match(triggers[1],/main/);
assert.ok(host.querySelector('.context-meter'),'the context meter stays in the footer');

(host.querySelectorAll('.env-footer-trigger')[1] as HTMLButtonElement).click();
await delay(120);
let options=text('.branch-picker-option');
assert.ok(options.some(o=>o.startsWith('dev')),'branches are listed: '+options.join(' | '));
assert.ok(options.some(o=>o.includes('New worktree for a parallel chat')));
const checkedOut=Array.from(document.querySelectorAll('.branch-picker-option')).find(o=>o.textContent?.startsWith('feat/wt'));
assert.equal(checkedOut?.getAttribute('aria-disabled'),'true','a branch checked out in another worktree cannot be switched to');
const search=document.querySelector<HTMLInputElement>('.branch-picker-search input')!;
type(search,'de');
await delay(40);
options=text('.branch-picker-option');
assert.ok(options[0]?.startsWith('dev'),'search narrows the list: '+options.join(' | '));
assert.ok(options.some(o=>o.includes('Create branch “de”')),'an unmatched query offers to create it');
key(search,'Enter');
await delay(120);
assert.ok(calls.some(c=>c.command==='git.switch'&&c.input.branch==='dev'&&c.input.revision==='r1'&&!c.input.carry));
assert.match(document.querySelector('.branch-picker-confirm')?.textContent??'',/2 changed files.*dev/,'local changes are confirmed before switching');
Array.from(document.querySelectorAll<HTMLButtonElement>('.branch-picker-buttons button')).find(b=>b.textContent?.includes('Bring changes'))!.click();
await delay(120);
assert.ok(calls.some(c=>c.command==='git.switch'&&c.input.branch==='dev'&&c.input.carry===true),'confirmation carries the changes');
assert.equal(document.querySelectorAll('.branch-picker-confirm').length,0,'the picker closes after switching');
root.unmount();

// --- Summary card: fetch wording, sandbox scope, PR detail ----------------------------------------
root=createRoot(host);
root.render(<div className="center"><SummaryCard/></div>);
await delay(200);
const commitRow=()=>Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-row')).find(row=>/fetch/i.test(row.textContent??'')||/Up to date/.test(row.textContent??''));
assert.match(commitRow()?.textContent??'',/Last fetched: never.*Fetch/,'no "Up to date" claim before a fetch');
commitRow()!.click();
await delay(120);
assert.ok(calls.some(c=>c.command==='git.fetch'&&c.input.folderId==='f'));
assert.match(commitRow()?.textContent??'',/Up to date as of now/,'after a fetch the time is stated');

const envRow=Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-row')).find(row=>row.textContent?.includes('This Mac'))!;
assert.equal(envRow.getAttribute('aria-expanded'),'false','the environment menu trigger reports its state');
envRow.click();
await delay(150);
assert.equal(envRow.getAttribute('aria-expanded'),'true');
const items=text('.env-menu-item');
assert.ok(items.some(i=>i.includes('This Mac')&&i.includes('main')),'worktrees are listed: '+items.join(' | '));
assert.ok(items.some(i=>i.includes('feat/wt')));
Array.from(document.querySelectorAll<HTMLElement>('.env-menu-item')).find(i=>i.textContent?.includes('Sandbox shell'))!.click();
await delay(120);
const tab=store.getState().tabs.find(t=>t.kind==='computer');
assert.equal(tab?.id,'computer:chat:c','without a project the chat scope is used');
assert.equal(tab?.title,'Sandbox · Build it','the tab title names the scope');

const pr=Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-pr .summary-row'))[0]!;
assert.equal(pr.getAttribute('aria-expanded'),'false');
pr.click();
await delay(40);
assert.equal(pr.getAttribute('aria-expanded'),'true','PR rows expand in place');
assert.match(host.querySelector('.summary-pr-detail')?.textContent??'',/Draft.*feat\/wt.*Open in browser/);
assert.equal(host.querySelector('.summary-pr .summary-row-icon .pr-state')?.getAttribute('data-pr-state'),'draft','a draft PR icon is grey (draft tone), not green');
assert.equal(host.querySelector('.summary-pr-detail .git-state-pill')?.getAttribute('data-pr-state'),'draft');

// --- Summary card rows route into the folder's one Git tab -------------------------------------------
const summaryRow=(label:RegExp)=>Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-row')).find(row=>label.test(row.querySelector('.summary-row-label')?.textContent??''))!;
summaryRow(/^Changes$/).click();
await delay(40);
assert.deepEqual(store.getState().tabs.filter(t=>t.folderId==='f').map(t=>[t.id,t.kind,t.gitView]),[['git:f','git','changes']],'Changes opens the Git tab on Changes');
summaryRow(/^Create pull request$/).click();
await delay(40);
assert.deepEqual(store.getState().tabs.filter(t=>t.folderId==='f').map(t=>[t.id,t.gitView,t.prNumber]),[['git:f','pullRequest',undefined]],'Create pull request is the same tab, Pull request segment, create form');
Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-pr-open-link')).find(b=>/Review pull request/.test(b.textContent??''))!.click();
await delay(40);
assert.deepEqual(store.getState().tabs.filter(t=>t.folderId==='f').map(t=>[t.id,t.gitView,t.prNumber]),[['git:f','pullRequest',7]],'Review pull request #7 retargets the same tab');
assert.equal(store.getState().activeTabId,'git:f');
// S3-E / DF-F38: a server the agent left listening is visible on the card, marked Agent, and opens in the browser.
const portRow=Array.from(host.querySelectorAll<HTMLButtonElement>('.summary-row')).find(row=>/:5174/.test(row.textContent??''));
assert.ok(portRow,'the agent port is on the summary card');
assert.match(portRow!.textContent??'',/vite\s*Agent.*:5174/);
assert.ok(Array.from(host.querySelectorAll('.summary-row')).some(row=>/Terminal.*1 port listening/.test(row.textContent??'')));
portRow!.click();await delay(20);
assert.ok(store.getState().tabs.some(t=>t.kind==='browser'&&(t.url??'').startsWith('http://localhost:5174')),'opens the local URL');

// --- Summary card placement: a separate floating card over the conversation at every width ---------
// Pure layout pick: wide columns float in the margin, mid widths reserve a gutter, narrow ones (the
// resource pane is open) get a compact card of ≈ min(300px, 40%) over the transcript's right margin.
assert.deepEqual(pickSummaryLayout(1800),{layout:'float',cardWidth:300});
assert.deepEqual(pickSummaryLayout(1000),{layout:'reserve',cardWidth:300});
assert.deepEqual(pickSummaryLayout(808),{layout:'overlay',cardWidth:300},'pane open (~808px column): overlay rather than squeezing a 484px transcript');
assert.deepEqual(pickSummaryLayout(924),{layout:'reserve',cardWidth:300},'a gutter only when the transcript keeps >= 600px');
assert.deepEqual(pickSummaryLayout(620),{layout:'overlay',cardWidth:248});
assert.deepEqual(pickSummaryLayout(420),{layout:'overlay',cardWidth:200},'the compact card keeps a readable floor');

root.unmount();
host.textContent='';
root=createRoot(host);
root.render(<div className="shell">
  <main className="center" data-test-width="1800"><div className="chat"><header className="chat-head"/><div className="timeline-shell"><div className="timeline"/></div><div className="composer" data-testid="composer"><section className="composer-queue"/></div></div><SummaryCard/></main>
  <aside className="workspace" aria-label="Resources"><div className="workspace-body"/></aside>
</div>);
await delay(200);
const center=host.querySelector<HTMLElement>('.center')!;
const pane=host.querySelector<HTMLElement>('.workspace')!;
const card=()=>host.querySelector<HTMLElement>('[data-testid="summary-card"]');
// The reserve gutter is pure CSS: every rule using --summary-reserve must target only the transcript's
// scroller (or the empty-state prompt), never the composer, its queued strip/footer, the header or .chat.
const {readFileSync}=await import('node:fs');
const cardCss=readFileSync(`${process.cwd()}/src/renderer/components/summary-card.css`,'utf8');
const reserveRules=[...cardCss.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*var\(--summary-reserve\)[^{}]*)\}/g)].map(m=>m[1].trim());
assert.ok(reserveRules.length>0,'the reserve gutter rule exists');
for(const selector of reserveRules.flatMap(rule=>rule.split(',').map(part=>part.trim()))){
  assert.match(selector,/(\.timeline|\.chat-empty)$/,`the gutter applies to the transcript only: ${selector}`);
  assert.doesNotMatch(selector,/composer|chat-head|footer|turn-changes/,`the gutter never reaches ${selector}`);
}
const assertComposerUntouched=(layout:string)=>{
  const composer=host.querySelector<HTMLElement>('[data-testid="composer"]')!;
  const chatEl=host.querySelector<HTMLElement>('.chat')!;
  assert.equal(center.dataset.summary,layout);
  assert.equal(composer.getAttribute('style'),null,`${layout}: no inline gutter on the composer`);
  assert.equal(chatEl.getAttribute('style'),null,`${layout}: no inline gutter on the chat column`);
  assert.equal(card()?.contains(composer),false);
};
const cardState=()=>({parent:card()?.parentElement?.className,layout:card()?.getAttribute('data-layout'),hidden:card()?.hasAttribute('hidden'),collapsed:card()?.hasAttribute('data-collapsed'),summary:center.dataset.summary});

assert.deepEqual(cardState(),{parent:'center',layout:'float',hidden:false,collapsed:false,summary:'float'},'a wide column floats the card in its margin');
assert.equal(host.querySelector('.summary-collapse'),null,'the full-size card needs no collapse control');

center.setAttribute('data-test-width','1000');resize();await delay(60);
assert.deepEqual(cardState(),{parent:'center',layout:'reserve',hidden:false,collapsed:false,summary:'reserve'},'a mid-width column reserves a gutter for the card');
assert.equal(center.style.getPropertyValue('--summary-reserve'),'324px','the gutter is the card plus its inset and gap');
assertComposerUntouched('reserve');

// Resource pane open: the conversation column narrows. The card stays a floating card in .center.
center.setAttribute('data-test-width','620');resize();await delay(60);
assert.equal(saved.has('muster.summaryCollapsed'),false,'no stored fold preference yet');
assert.deepEqual(cardState(),{parent:'center',layout:'overlay',hidden:false,collapsed:true,summary:'overlay'},'pane open + narrow column: the compact card defaults to a pill floating over the conversation');
assert.equal(pane.querySelector('[data-testid="summary-card"]'),null,'the card is never merged into the resource pane');
assert.equal(host.querySelectorAll('[data-testid="summary-card"]').length,1);
assert.equal(center.style.getPropertyValue('--summary-width'),'248px','compact width is 40% of the column');
assert.equal(card()?.querySelector('.summary-card-body'),null,'the pill covers no transcript rows');
const pill=()=>host.querySelector<HTMLButtonElement>('.summary-pill');
assert.ok(pill(),'the pill is a button');
assert.equal(pill()!.getAttribute('aria-expanded'),'false');
assert.match(pill()!.textContent??'',/Summary/);
assertComposerUntouched('overlay');
const pillClearRules=[...cardCss.replace(/\/\*[\s\S]*?\*\//g,'').matchAll(/([^{}]+)\{([^{}]*padding-top[^{}]*)\}/g)].filter(m=>m[1].includes("[data-summary='overlay']"));
assert.equal(pillClearRules.length,1,'the folded pill clears the first message with a top padding');
assert.match(pillClearRules[0][1].trim(),/\.chat > \.timeline-shell > \.timeline$/,'only the transcript scroller is padded, never the composer');
assert.match(pillClearRules[0][2],/padding-top:\s*50px/,'gap 10 + pill 32 + 8');

pill()!.click();await delay(60);
assert.deepEqual(cardState(),{parent:'center',layout:'overlay',hidden:false,collapsed:false,summary:'overlay-open'},'clicking the pill expands the compact card');
assert.equal(saved.get('muster.summaryCollapsed'),'false','expanding is remembered');
assert.ok(card()?.querySelector('.summary-card-body .summary-row'),'the expanded compact card shows its rows');
assert.ok(reserveRules.some(rule=>rule.includes("[data-summary='overlay-open']")&&rule.includes('.timeline')),'an expanded compact card gives the timeline scroller a gutter so rows reflow beside it');
assertComposerUntouched('overlay-open');

const collapse=host.querySelector<HTMLButtonElement>('.summary-collapse')!;
assert.ok(collapse,'the compact card offers its own collapse chevron');
assert.equal(collapse.getAttribute('aria-expanded'),'true');
collapse.click();await delay(60);
assert.equal(cardState().collapsed,true,'collapsing folds the card back to a pill');
assert.equal(cardState().summary,'overlay','the folded pill drops the transcript gutter');
assert.equal(cardState().hidden,false,'a folded card is still present');
assert.equal(saved.get('muster.summaryCollapsed'),'true','the fold is remembered');
pill()!.click();await delay(60);
assert.equal(cardState().collapsed,false,'the stored choice is respected and can flip again');
assert.equal(saved.get('muster.summaryCollapsed'),'false');

store.setSummaryHidden(true);await delay(60);
assert.equal(cardState().hidden,true,'the header toggle hides the compact card');
assert.equal(center.dataset.summary,'hidden');
store.toggleSummary();await delay(60);
assert.equal(cardState().hidden,false,'and the header toggle shows it again');

// Pane closed again: back to a wide float; the header toggle works the same there.
center.setAttribute('data-test-width','1800');resize();await delay(60);
assert.deepEqual(cardState(),{parent:'center',layout:'float',hidden:false,collapsed:false,summary:'float'});
store.toggleSummary();await delay(60);
assert.equal(cardState().hidden,true,'the header toggle hides the floating card');
store.setSummaryHidden(false);await delay(60);
assert.equal(cardState().hidden,false,'and shows it again');

root.unmount();
console.log('PASS: footer environment + branch dropdowns; searchable branch switch with carried-changes confirmation; fetch-time wording; consistent sandbox scope; PR detail with draft-coloured state; summary rows (Changes, Create pull request, Review pull request) route into the one Git tab; summary card floats over the conversation at every width (float/reserve/compact overlay with a persisted pill fold), never inside the resource pane, hidden only by the header toggle');
process.exit(0);
