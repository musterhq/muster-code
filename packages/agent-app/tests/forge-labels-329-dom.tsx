/** #329: on a GitLab remote the summary card and the PR tab say merge request and `!5`, and the PR tab hides the review
 *  controls that are GitHub-only, saying so instead. Stubbed bridge; linkedom DOM. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.scrollIntoView=function(){};
Object.defineProperty(window.HTMLElement.prototype,'clientWidth',{configurable:true,get(){return 1800;}});
(window.document as any).hasFocus=()=>true;

const status={branch:'feature/widget',detached:false,unborn:false,revision:'r1',files:[],truncated:false,stagedCount:0,conflicted:false,upstream:'origin/feature/widget',ahead:0,behind:0,pushRemote:'origin',forge:'gitlab',forgeUrl:'https://gitlab.com/group/app'};
const chat={id:'c',title:'Build it',folderId:'f',status:'completed',updatedAt:'',pinned:false,archived:false,draft:'',model:'m',mode:'agent'};
const mr={number:5,nodeId:'9001',title:'Add widget',body:'Explains why.',url:'https://gitlab.com/group/app/-/merge_requests/5',state:'open',draft:false,author:'tanuki',headRef:'feature/widget',headSha:'abc',baseRef:'main',mergeable:true,mergeableState:'clean',additions:0,deletions:0,changedFiles:1,commits:0,requestedReviewers:[],createdAt:'',updatedAt:''};
window.muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='app.snapshot')return {version:1,chats:[chat],folders:[{id:'f',name:'Repo',path:'/repo'}],projects:[],activeChatId:'c'};
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='processes.summary')return {revision:1,sessions:[]};
  if(command==='processes.ports')return {chatId:'c',supported:true,scannedAt:'',ports:[]};
  if(command==='git.info')return {branch:'feature/widget',detached:false,fetchedAt:null,hasRemote:true,worktree:null};
  if(command==='git.status')return status;
  if(command==='git.changes')return [];
  if(command==='git.pullRequests')return {available:true,items:[{number:5,title:'Add widget',url:mr.url,state:'OPEN',headRefName:'main-fix',isDraft:false}]};
  if(command==='github.repo')return {nameWithOwner:'group/app',url:'https://gitlab.com/group/app',defaultBranch:'main',mergeMethods:['merge','squash'],viewerCanPush:true,forge:'gitlab'};
  if(command==='github.pr.get')return mr;
  if(command==='github.pr.checks')return {headSha:'abc',items:[],summary:{passed:0,failed:0,pending:0,skipped:0}};
  if(command==='github.pr.conversation')return {comments:[],reviews:[]};
  if(command==='ci.repair.list')return [];
  if(command==='automations.list')return [];
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
const {SummaryCard}=await import('../src/renderer/components/SummaryCard');
const {PullRequestTab}=await import('../src/renderer/components/PullRequestTab');
await store.boot();
const host=document.getElementById('root')!;
const root=createRoot(host);
root.render(<main className="center"><div className="chat"><header className="chat-head"/></div><SummaryCard/></main>);
await delay(300);
const labels=()=>Array.from(host.querySelectorAll('.summary-row-label')).map(node=>node.textContent??'');

// Spec: MUS-SPEC-08-329H (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-329h)
await check('a GitLab remote is labelled merge request with ! numbers, and its PR tab hides the GitHub-only review controls',async()=>{
  assert.ok(labels().includes('Create merge request'),`the create row says merge request: ${labels().join(' | ')}`);
  assert.equal(host.querySelector('.summary-subsection .summary-section-head')?.textContent,'Merge requests');
  assert.equal(host.querySelector('.summary-pr-num')?.textContent,'!5');
  (host.querySelector('.summary-pr .summary-row') as HTMLButtonElement).click();
  await delay(60);
  assert.ok(Array.from(host.querySelectorAll('.summary-pr-open-link')).some(node=>/Review merge request/.test(node.textContent??'')));
  root.render(<PullRequestTab tab={{id:'git:f',kind:'git',folderId:'f',prNumber:5,title:'Add widget'} as any}/>);
  await delay(300);
  assert.equal(host.querySelector('.pr-title .pr-muted')?.textContent,'!5');
  const buttons=Array.from(host.querySelectorAll('.pr-action-row button')).map(node=>node.textContent??'');
  assert.equal(buttons.some(text=>/Request review|^Review/.test(text)),false,`no GitHub-only review buttons: ${buttons.join(' | ')}`);
  assert.ok(buttons.includes('Merge'),'Merge stays');
  assert.match(host.querySelector('.pr-actions [role="note"]')?.textContent??'',/GitHub-only.*Open on GitLab/);
});
root.unmount();
process.exit(0);
