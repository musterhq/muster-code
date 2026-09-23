/** Run with node tests/run-resource-pane-components.mjs: file tree keyboard + retained expansion, '+' menu, and the one
 *  Git tab (Changes · History · Pull request): staged/unstaged sections, colour classes per status, segment navigation,
 *  CI and conflict banner routing. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}unobserve(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};
const calls:{command:string;input:any}[]=[];
const listing:Record<string,any[]>={
  '':[{name:'src',path:'src',kind:'directory'},{name:'README.md',path:'README.md',kind:'file'},{name:'package.json',path:'package.json',kind:'file'}],
  src:[{name:'app.tsx',path:'src/app.tsx',kind:'file'}],
};
const file=(path:string,index:string,worktree:string,extra:any={})=>({path,index,worktree,staged:index!==' '&&index!=='?',untracked:index==='?',conflict:false,...extra});
const gitStatus={branch:'feat/x',detached:false,unborn:false,revision:'r1',files:[
  file('src/app.tsx',' ','M'),file('docs/new.md','R',' ',{previousPath:'docs/old.md'}),file('logo.png','A',' '),file('gone.txt',' ','D'),file('new.txt','?','?'),
],truncated:false,stagedCount:2,conflicted:false,upstream:'origin/feat/x',ahead:2,behind:1,remoteUrl:'https://github.com/o/r',pushRemote:'origin'};
let prs:any[]=[];
const conflictStatus={...gitStatus,files:[file('src/merge.ts','U','U',{conflict:true,staged:false})],stagedCount:0,conflicted:true};
const sha=(n:number)=>String(n).padStart(40,'b');
const commits=[
  {sha:sha(0),short:'bbbbbb0',author:'Ada',email:'a@b',authoredAt:new Date().toISOString(),subject:'Merge topic',parents:[sha(1),sha(2)],refs:['feat/x','origin/feat/x','tag: v2'],head:true},
  {sha:sha(1),short:'bbbbbb1',author:'Ada',email:'a@b',authoredAt:new Date().toISOString(),subject:'Main work',parents:[sha(3)],refs:[],head:false},
  {sha:sha(2),short:'bbbbbb2',author:'Bo',email:'a@b',authoredAt:new Date().toISOString(),subject:'Topic work',parents:[sha(3)],refs:[],head:false},
  {sha:sha(3),short:'bbbbbb3',author:'Bo',email:'a@b',authoredAt:new Date().toISOString(),subject:'Base',parents:[],refs:[],head:false},
];
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='git.status'&&input.folderId==='f')return gitStatus;
  if(command==='git.status'&&input.folderId==='h')return conflictStatus;
  if(command==='git.mutate')return gitStatus;
  if(command==='git.pullRequests')return {available:true,items:prs};
  if(command==='git.conflicts')return input.folderId==='h'?{operation:'rebase',currentLabel:'feat/x',incomingLabel:'main',incomingSubject:'main work',files:[{path:'src/merge.ts',status:'UU',description:'Both modified',resolved:false}],canContinue:false}:{operation:null,currentLabel:'HEAD',incomingLabel:'incoming',incomingSubject:null,files:[],canContinue:false};
  if(command==='git.info')return {branch:'feat/x',detached:false,fetchedAt:null,hasRemote:true,worktree:null};
  if(command==='git.log')return {commits,hasMore:false,skip:0};
  if(command==='git.branches')return {current:'feat/x',detached:false,local:[{name:'feat/x'},{name:'main'}],recent:[],truncated:false};
  if(command==='github.pr.checks')return {headSha:'h1',items:[{id:'c1',name:'build',kind:'check',status:'completed',conclusion:'failure'},{id:'c2',name:'lint',kind:'check',status:'completed',conclusion:'success'},{id:'c3',name:'e2e',kind:'check',status:'in_progress',conclusion:null}],summary:{passed:1,failed:1,pending:1,skipped:0}};
  if(command==='github.pr.get')return {number:9,nodeId:'n',title:'Ship it',body:'',url:'https://github.com/o/r/pull/9',state:'open',draft:false,author:'ada',headRef:'feat/x',headSha:'h1',baseRef:'main',mergeable:true,mergeableState:'unstable',additions:4,deletions:2,changedFiles:1,commits:2,requestedReviewers:[],createdAt:'',updatedAt:''};
  if(command==='github.repo')return {nameWithOwner:'o/r',url:'',defaultBranch:'main',mergeMethods:['squash'],viewerCanPush:true};
  if(command==='github.pr.conversation')return {comments:[],reviews:[{id:1,author:'bob',state:'APPROVED',body:'',submittedAt:''},{id:2,author:'cy',state:'CHANGES_REQUESTED',body:'Fix it',submittedAt:''}]};
  if(command==='ci.repair.list')return [];
  if(command==='chat.editOwners')return [];
  if(command==='files.list')return listing[input.path??'']??[];
  if(command==='files.search')return {entries:[{name:'app.tsx',path:'src/app.tsx',kind:'file'}],truncated:false};
  if(command==='git.changes'&&input.folderId==='g')throw new Error("git.changes: Error invoking remote method 'muster:invoke': Error: Not a git repository: /tmp/plain");
  if(command==='review.changes'&&input.folderId==='g')throw new Error("review.changes: Error invoking remote method 'muster:invoke': Error: Not a git repository: /tmp/plain");
  if(command==='git.status'&&input.folderId==='g')throw new Error("git.status: Error invoking remote method 'muster:invoke': Error: Not a git repository: /tmp/plain");
  if(command==='git.changes')return [{path:'src/app.tsx',status:'modified',adds:4,dels:2},{path:'docs/new.md',previousPath:'docs/old.md',status:'renamed',adds:0,dels:0},{path:'logo.png',status:'added',adds:0,dels:0},{path:'gone.txt',status:'deleted',adds:0,dels:3},{path:'new.txt',status:'untracked',adds:1,dels:0}];
  if(command==='files.read')return {path:input.path,text:'x',truncated:false};
  if(command==='app.snapshot')return {version:1,chats:[{id:'c',title:'Chat',folderId:'f',status:'completed',updatedAt:'',pinned:false,archived:false,draft:'',model:'m',mode:'agent'}],folders:[{id:'f',name:'Repo',path:'/repo'},{id:'h',name:'Rebasing',path:'/rebasing'}],projects:[],activeChatId:'c'};
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='processes.summary')return {revision:1,sessions:[]};
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=await import('react');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const {FileTree}=await import('../src/renderer/components/FileTree');
const view=await import('../src/renderer/resourceViewState');
const {recordClosedTab,recentlyClosedTabs,addressFromQuery}=await import('../src/renderer/components/ResourceAddMenu');
const {Workspace}=await import('../src/renderer/components/Workspace');
const {GitActions}=await import('../src/renderer/components/GitActions');

// --- File tree: role=tree, arrow keys, expansion that survives a remount -------------------------
const host=document.getElementById('root')!;
let root=createRoot(host);
root.render(<FileTree folderId="f" path=""/>);
await delay(350);
assert.ok(host.querySelector('[role="tree"]'),'the explorer is an ARIA tree');
const rows=()=>Array.from(host.querySelectorAll<HTMLElement>('[role="treeitem"]'));
assert.deepEqual(rows().map(row=>row.textContent),['src','README.md','package.json']);
assert.equal(rows()[0].getAttribute('aria-expanded'),'false');
assert.equal(rows()[0].getAttribute('tabindex'),'0','the first row is the tree tab stop');
assert.equal(host.querySelector('[data-kind="markdown"]')?.getAttribute('data-tone'),'accent','files carry per-extension icons');
const key=(target:HTMLElement,name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});target.dispatchEvent(event);};
let focused='';
window.HTMLElement.prototype.focus=function(){focused=this.textContent??'';};
key(rows()[0],'ArrowDown');
assert.equal(focused,'README.md','Down moves to the next row');
key(rows()[1],'ArrowUp');
assert.equal(focused,'src','Up moves to the previous row');
key(rows()[0],'ArrowRight');
await delay(350);
assert.equal(view.isExpanded('f','src'),true,'Right expands a folder');
assert.deepEqual(rows().map(row=>row.textContent),['src','app.tsx','README.md','package.json']);
assert.equal(rows()[1].getAttribute('aria-level'),'2');
key(rows()[1],'ArrowLeft');
assert.equal(focused,'src','Left on a child climbs to its folder');
root.unmount();
root=createRoot(host);
root.render(<FileTree folderId="f" path=""/>);
await delay(50);
assert.deepEqual(rows().map(row=>row.textContent),['src','app.tsx','README.md','package.json'],'expansion survives a tab switch remount');
key(rows()[0],'ArrowLeft');
await delay(50);
assert.equal(view.isExpanded('f','src'),false,'Left collapses an open folder');
assert.match(saved.get('muster.resourceView.expanded.v1')??'',/^\[\]$/,'expansion is mirrored to sessionStorage');
root.unmount();

// --- '+' menu helpers ---------------------------------------------------------------------------
for(let index=0;index<12;index++)recordClosedTab({id:`file:f:${index}.md`,kind:'file',folderId:'f',path:`${index}.md`,title:`${index}.md`});
assert.equal(recentlyClosedTabs().length,10,'recently closed keeps the last ten');
assert.equal(recentlyClosedTabs()[0].title,'11.md','most recent first');
assert.equal(addressFromQuery('notes.md'),null,'file names are not URLs');
assert.equal(addressFromQuery('example.com/docs'),'https://example.com/docs');
assert.equal(addressFromQuery('localhost:5173'),'http://localhost:5173/');

// --- Workspace: '+' after the tabs, Terminal label, Changes list details ---------------
await store.boot();
await delay(50);
root=createRoot(host);
root.render(<Workspace/>);
await delay(50);
assert.deepEqual(Array.from(host.querySelectorAll('.resource-launchers button')).map(button=>button.textContent),['Changes','Browser','Terminal','Files'],'the Terminal tile opens a real PTY terminal (W2-C), so it is labelled Terminal');
store.openChangesTab('f','Repo');
await delay(150);
assert.ok(host.querySelector('.workspace-head > .resource-add-trigger'),'a + trigger follows the tab strip once tabs are open');
// One Git tab per folder, named for it.
assert.deepEqual(store.getState().tabs.filter(t=>t.folderId==='f').map(t=>[t.id,t.kind,t.gitView]),[['git:f','git','changes']],'Changes opens the folder\'s one Git tab');
assert.ok(Array.from(host.querySelectorAll('.workspace-tab-title')).some(node=>node.textContent==='Git · Repo'));
const gitTab=()=>host.querySelector<HTMLElement>('[data-testid="git-tab"]')!;
const segments=()=>Array.from(host.querySelectorAll<HTMLButtonElement>('.git-segment')).map(button=>(button.getAttribute('data-view')??'')+':'+(button.textContent??''));
assert.deepEqual(segments(),['changes:Changes5','history:History'],'Changes · History; no Pull request segment without a PR');
// Branch chip in the accent, diverged ahead/behind in red.
assert.equal(host.querySelector('.git-tab-branch .git-ref')?.className,'git-ref is-current');
assert.equal(host.querySelector('.git-tab-branch .git-ref')?.textContent,'feat/x');
assert.equal(host.querySelector('.git-tab-branch .git-sync')?.getAttribute('data-sync'),'diverged','↑2 ↓1 reads as diverged');
assert.match(host.querySelector('.git-tab-branch .git-sync')?.textContent??'',/↑2.*↓1/);
// Staged and not-staged sections, visually distinct, each row coloured by its status.
const section=(side:string)=>host.querySelector<HTMLElement>(`[data-testid="git-section-${side}"]`);
assert.ok(section('staged')?.classList.contains('is-staged'),'a Staged section');
assert.ok(section('unstaged')?.classList.contains('is-unstaged'),'a Not staged section');
assert.equal(section('conflict'),null,'no Conflicts section without conflicts');
const rowsIn=(side:string)=>Array.from(section(side)!.querySelectorAll<HTMLElement>('.change-row')).map(row=>({text:row.textContent??'',badge:row.querySelector('.git-status')!.className,code:row.querySelector('.git-status')!.getAttribute('data-status')}));
const staged=rowsIn('staged'), unstaged=rowsIn('unstaged');
assert.match(staged[0].text,/docs\/old\.md.*docs\/new\.md/,'renames show old → new');
assert.deepEqual([staged[0].badge,staged[0].code],['git-status git-tone-renamed','R'],'renamed is blue R');
assert.match(staged[1].text,/logo\.png.*Binary/,'binary files are marked');
assert.deepEqual([staged[1].badge,staged[1].code],['git-status git-tone-added','A'],'added is green A');
assert.match(unstaged[0].text,/app\.tsx.*\+4.*−2/,'per-file additions and deletions');
assert.deepEqual([unstaged[0].badge,unstaged[0].code],['git-status git-tone-modified','M'],'modified is amber M');
assert.deepEqual([unstaged[1].badge,unstaged[1].code],['git-status git-tone-deleted','D'],'deleted is red D');
assert.ok(section('unstaged')!.querySelector('.git-name-deleted'),'a deleted file name is struck through');
assert.deepEqual([unstaged[2].badge,unstaged[2].code],['git-status git-tone-untracked','U'],'untracked is green U');
assert.equal(section('unstaged')!.querySelector('.change-adds')?.className,'change-adds git-add','additions use the shared add colour');
assert.equal(section('unstaged')!.querySelector('.change-dels')?.className,'change-dels git-del','deletions use the shared delete colour');
// Stage / Unstage per row; the commit box names what it commits.
(host.querySelector('button[aria-label="Stage src/app.tsx"]') as HTMLButtonElement).click();
await delay(60);
assert.deepEqual(calls.filter(c=>c.command==='git.mutate').at(-1)?.input,{folderId:'f',operation:'stage',revision:'r1',paths:['src/app.tsx']});
const commitButton=host.querySelector<HTMLButtonElement>('.git-commit-box button[type="submit"]')!;
assert.equal(commitButton.textContent,'Commit 2 staged');
assert.equal(commitButton.disabled,true,'no commit without a message');
// "Compare against" replaces the old "baseline" wording.
assert.match(host.querySelector('.review-baseline-trigger')?.textContent??'',/Compare against.*Last commit/);
// Segment navigation: Changes → History (with its lane graph and coloured refs).
(host.querySelector('.git-segment[data-view="history"]') as HTMLButtonElement).click();
await delay(250);
assert.equal(store.getState().tabs.find(t=>t.id==='git:f')?.gitView,'history','the segment is kept on the tab');
assert.equal(gitTab().getAttribute('data-view'),'history');
for(let i=0;i<60&&!host.querySelector('.git-history-row');i++)await delay(50); // the History segment is a lazy chunk
assert.ok(host.querySelector('[data-testid="git-history"].is-embedded'),'History renders inside the Git tab');
const firstCommit=host.querySelector('.git-history-row')!;
assert.ok(firstCommit.querySelector('svg.git-graph circle.git-graph-dot.is-merge'),'a merge commit is marked in the lane column');
assert.ok(host.querySelectorAll('.git-history-row svg.git-graph').length>=3,'every row draws its lanes');
assert.ok(firstCommit.classList.contains('is-merge'));
const refKinds=Array.from(firstCommit.querySelectorAll('.git-ref')).map(chip=>`${chip.getAttribute('data-ref-kind')}:${chip.textContent}`);
assert.deepEqual(refKinds,['head:HEAD','current:feat/x','remote:origin/feat/x','tag:v2'],'HEAD, current branch, remote branch and tag each get their own colour class');
// A PR for the branch adds the Pull request segment; the summary card's "View pull request" lands on it.
prs=[{number:9,title:'Ship it',url:'https://github.com/o/r/pull/9',state:'OPEN',headRefName:'feat/x',isDraft:false}];
store.openPullRequestTab('f',9,'Ship it');
for(let i=0;i<60&&!host.querySelector('.pr-view');i++)await delay(50); // the Pull request segment is a lazy chunk
await delay(100);
assert.deepEqual(store.getState().tabs.filter(t=>t.folderId==='f').map(t=>[t.id,t.gitView,t.prNumber]),[['git:f','pullRequest',9]],'no second tab: the Git tab switches to its Pull request segment');
assert.deepEqual(segments().map(s=>s.split(':')[0]),['changes','history','pullRequest']);
assert.match(segments()[2],/Pull request #9/);
assert.ok(host.querySelector('.git-segment[data-view="pullRequest"] .pr-state.is-open'),'the segment icon is the open (green) PR state');
assert.equal(host.querySelector('.git-segment[data-view="pullRequest"] .git-dot')?.getAttribute('data-check'),'failure','failing CI shows as a red dot on the segment');
assert.equal(host.querySelector('.pr-view .git-state-pill.pr-state')?.getAttribute('data-pr-state'),'open');
assert.equal(host.querySelector('.pr-view .git-state-pill.pr-state')?.textContent,'Open');
await delay(100);
const reviews=Array.from(host.querySelectorAll('.pr-comment .review-state')).map(pill=>pill.getAttribute('data-review-state'));
assert.deepEqual(reviews,['approved','changes'],'review states are coloured: approved green, changes requested red');
// CI failing banner → View checks opens the PR on its Checks section, with the check states coloured.
const banner=host.querySelector('[data-testid="ci-banner"]')!;
assert.match(banner.textContent??'',/1 check failing on #9.*build/);
assert.ok(banner.querySelector('.ci-repair'),'the banner offers the Fix repair task');
(host.querySelector('.git-segment[data-view="changes"]') as HTMLButtonElement).click();
await delay(120);
assert.ok(host.querySelector('[data-testid="ci-banner"]'),'the CI banner stays visible on every segment');
(Array.from(host.querySelectorAll<HTMLButtonElement>('[data-testid="ci-banner"] button')).find(b=>b.textContent==='View checks'))!.click();
await delay(300);
assert.equal(store.getState().tabs.find(t=>t.id==='git:f')?.gitView,'pullRequest');
assert.match(host.querySelector('.pr-section-tab[aria-selected="true"]')?.textContent??'',/^Checks/,'View checks lands on the Checks section');
const checkStates=Array.from(host.querySelectorAll('.pr-check-row [data-check]')).map(icon=>icon.getAttribute('data-check'));
assert.deepEqual(checkStates,['failure','success','pending'],'checks: failure red, success green, running amber');
// Keyboard: ← from the Pull request segment goes to History.
host.querySelector('.git-segments')!.dispatchEvent(Object.assign(new window.Event('keydown',{bubbles:true,cancelable:true}),{key:'ArrowLeft'}));
await delay(60);
assert.equal(store.getState().tabs.find(t=>t.id==='git:f')?.gitView,'history');
// A rebase in progress: the banner leads to the resolver, and the conflicted file has its own section.
store.openChangesTab('h','Rebasing');
await delay(250);
const conflictBanner=host.querySelector('[data-testid="conflict-banner"]')!;
assert.match(conflictBanner.textContent??'',/Rebase in progress.*feat\/x.*main.*src\/merge\.ts.*Both modified.*Resolve/);
assert.equal(section('conflict')?.querySelector('.git-status')?.className,'git-status git-tone-conflict','a conflict is an orange C with a warning icon');
assert.ok(section('conflict')?.querySelector('.git-status svg'),'the conflict badge carries an icon');
(conflictBanner.querySelector('.git-conflict-resolve') as HTMLButtonElement).click();
await delay(60);
assert.equal(store.getState().activeTabId,'conflict:h:src/merge.ts','Resolve opens the conflict resolver');
assert.equal(host.querySelector('.git-commit-box button[type="submit"]'),null,'the resolver replaced the Git tab on screen');
store.activateTab('git:f');
await delay(60);
(host.querySelector('.resource-add-trigger') as HTMLButtonElement).click();
await delay(80);
const options=()=>Array.from(document.querySelectorAll('.resource-add-option')).map(option=>option.textContent??'');
assert.ok(options().some(text=>text.startsWith('Browser')),'the menu offers resource types: '+options().join(' | '));
assert.ok(options().some(text=>text.startsWith('Subagents')));
assert.ok(options().some(text=>text.startsWith('11.md')),'recently closed resources are listed');
const option=Array.from(document.querySelectorAll<HTMLElement>('.resource-add-option')).find(item=>item.textContent?.startsWith('Files'))!;
option.click();
await delay(80);
assert.equal(store.getState().activeTabId,'files:f','choosing Files opens the folder explorer');
assert.equal(document.querySelectorAll('.resource-add-option').length,0,'choosing an option closes the menu');
assert.ok(host.querySelector('.files-explorer [role="tree"]'),'the Files tab is the folder tree');
assert.ok(!host.querySelector('.files-explorer .change-row'),'the Files tab does not repeat the Changes list');
// The terminal is always "Terminal": + menu, tab title (including older saved titles).
(host.querySelector('.resource-add-trigger') as HTMLButtonElement).click();
await delay(80);
assert.ok(options().some(text=>text.startsWith('Terminal')),'the + menu names it Terminal: '+options().join(' | '));
assert.ok(!options().some(text=>text.startsWith('Commands')),'no separate "Commands" entry');
(host.querySelector('.resource-add-trigger') as HTMLButtonElement).click();await delay(40);
store.openTab({id:'processes:c',kind:'processes',chatId:'c',title:'Commands · Local commands'});store.activateTab('files:f'); // the PTY view itself needs a real DOM
await delay(80);
assert.ok(Array.from(host.querySelectorAll('.workspace-tab-title')).some(node=>node.textContent==='Terminal'),'a saved "Commands · …" title renders as Terminal: '+Array.from(host.querySelectorAll('.workspace-tab-title')).map(n=>n.textContent).join('|')+' '+JSON.stringify(store.getState().tabs.map(t=>t.id)));
assert.ok(!Array.from(host.querySelectorAll('.workspace-tab-title')).some(node=>/Commands/.test(node.textContent??'')));
// A folder without Git: calm neutral state, no raw IPC text, no "vs HEAD" baseline, no counts.
store.openChangesTab('g','Plain');
await delay(120);
assert.match(host.querySelector('.resource-neutral')?.textContent??'',/Not a Git repository/,'non-git folders show a neutral state');
assert.ok(!/Error invoking|git\.changes/.test(host.textContent??''),'raw IPC error strings never reach the pane');
assert.ok(!host.querySelector('.review-baseline-trigger'),'no baseline picker without a repository');
assert.ok(!host.querySelector('.change-counts'),'no change counts without a repository');
// New-chat draft: an empty pane with working tiles, never the previous chat's tabs.
const draftModule=await import('../src/renderer/newChatDraft');
draftModule.openNewChat();
await delay(60);
assert.equal(host.querySelectorAll('.workspace-tab').length,0,'the draft does not show the previous chat\'s tabs');
assert.deepEqual(Array.from(host.querySelectorAll('.resource-launchers button')).map(button=>button.textContent),['Changes','Browser','Files'],'draft tiles are the ones that work for its folder');
assert.match(host.querySelector('.resource-launchers-note')?.textContent??'',/Terminal/,'one line says why Terminal is absent');
Array.from(host.querySelectorAll<HTMLButtonElement>('.resource-launchers button')).find(button=>button.textContent==='Files')!.click();
await delay(80);
assert.deepEqual(Array.from(host.querySelectorAll('.workspace-tab-title')).map(node=>node.textContent),['Repo'],'a tile opened from the draft shows, even when the previous chat had it open');
draftModule.closeNewChat();
await delay(60);
assert.ok(host.querySelectorAll('.workspace-tab').length>1,'leaving the draft restores the chat\'s tabs');
root.unmount();

// GitActions itself (rendered standalone, e.g. from the resource-pane overview) must reach the same
// quiet neutral state on its own — it reads its own `git.status` independently of the Changes tab's
// `notRepo` gating, so it needs its own not-a-repo handling rather than relying on a parent to hide it.
root=createRoot(host);
root.render(<GitActions folderId="g"/>);
await delay(120);
assert.match(host.querySelector('.git-actions-neutral')?.textContent??'',/Not a Git repository/,'GitActions reads a non-repo folder as neutral, not a red error');
assert.ok(!host.querySelector('.git-action-error'),'no red error row');
assert.ok(!host.querySelector('.git-actions-trigger'),'no Repository disclosure, Refresh button or commit form for a non-repo folder');
assert.ok(!/Error invoking|git\.status/.test(host.textContent??''),'raw IPC error strings never reach GitActions either');
root.unmount();

console.log('PASS: file tree ARIA keys and retained expansion; + menu resource types and recents; Terminal naming; one Git tab per folder with Staged / Not staged / Conflicts sections, status colour classes (M amber, A/U green, D red, R blue, C conflict), coloured counts, refs, ahead/behind, PR/review/check states; Changes → History → Pull request navigation (click, ← key, summary routing); CI banner → Checks and conflict banner → resolver; Files tab is the tree; non-git neutral state; draft shows an empty pane; GitActions non-git neutral state');
process.exit(0);
