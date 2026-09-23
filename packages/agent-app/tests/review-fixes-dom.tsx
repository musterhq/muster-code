/** Bundled and run by scripts/test-renderer.mjs. GitActions (the commit box) reads status on mount, so a folder
 *  that isn't a repository says so at once; ProjectDefaultModel shows a load
 *  failure (not "Use my default") and applies only the latest set's response. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30}) as DOMRect;
(window.document as any).hasFocus=()=>true;

let repo=true,getFails=true;
const sets:{value:any;resolve:(value:any)=>void}[]=[];
const status={branch:'main',detached:false,unborn:false,revision:'r1',files:[],truncated:false,stagedCount:0,conflicted:false};
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  if(command==='git.status'){if(!repo)throw new Error('Not a git repository: /plain');return status;}
  if(command==='settings.projectModel.get'){if(getFails)throw new Error('disk error');return {value:null};}
  if(command==='settings.projectModel.set')return new Promise(resolve=>sets.push({value:input.value,resolve}));
  if(command==='providers.list')return [{id:'codex',name:'Codex',available:true,identityMasked:'',models:[{id:'a',name:'Model A'},{id:'b',name:'Model B'}]}];
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const {GitActions}=await import('../src/renderer/components/GitActions');
const host=document.getElementById('root')!;
let root=createRoot(host);
root.render(<GitActions folderId="f"/>);
await delay(60);
assert.ok(document.querySelector('.git-commit-box'),'a repository gets the commit box (message, Amend, Commit)');
assert.equal(document.querySelector('.git-actions-trigger'),null,'no separate Repository disclosure: status lives in the Git tab');
assert.equal((document.querySelector('.git-commit-box button[type="submit"]') as HTMLButtonElement).disabled,true,'nothing staged: Commit waits');
root.unmount();

// The folder turns out not to be a repository.
repo=false;
root=createRoot(host);
root.render(<GitActions folderId="f"/>);
await delay(80);
const neutral=document.querySelector('.git-actions-neutral');
assert.ok(neutral,'the panel learns the folder is not a repository without being opened');
assert.match(neutral.textContent??'',/Not a Git repository/);
root.unmount();

// --- ProjectDefaultModel -----------------------------------------------------------------------------
const {ProjectDefaultModel}=await import('../src/renderer/components/settings/ProjectDefaultModel');
root=createRoot(host);
root.render(<ProjectDefaultModel projectId="p1"/>);
await delay(40);
assert.match(host.textContent??'',/couldn.t be loaded/,'a failed read is an error, not "Use my default"');
assert.ok(!document.querySelector('.default-model-trigger'),'nothing can be set until a read succeeds');
getFails=false;
(Array.from(host.querySelectorAll('button')).find(button=>button.textContent==='Retry') as HTMLButtonElement).click();
await delay(40);
const trigger2=document.querySelector('.default-model-trigger') as HTMLButtonElement;
assert.ok(trigger2,'Retry loads the picker');
assert.match(trigger2.textContent??'',/Use my default/);
trigger2.click();await delay(20);
const pickModel=(name:string)=>(Array.from(document.querySelectorAll('.default-model-list [role="option"]')).find(option=>option.textContent===name) as HTMLButtonElement).click();
pickModel('Model A');await delay(5);
pickModel('Model B');await delay(5);
assert.equal(sets.length,2);
sets[1]!.resolve({value:sets[1]!.value});await delay(10);
sets[0]!.resolve({value:sets[0]!.value});await delay(10);
assert.match((document.querySelector('.default-model-trigger') as HTMLElement).textContent??'',/Model B/,'the older response landing last does not win');
root.unmount();

// --- ExitPlanMode tool row: a one-line summary pointing at the Plan card, not the whole plan again ------
const {ToolCard}=await import('../src/renderer/components/ToolCard');
const planMarkdown='## Ship the redirect fix\n\n1. Clear the stale cookie\n2. Add a regression test for the login loop';
root=createRoot(host);
root.render(<ToolCard item={{id:'t1',chatId:'c1',kind:'tool',text:JSON.stringify({plan:planMarkdown}),status:'completed',createdAt:'',data:{name:'ExitPlanMode',tool:'ExitPlanMode',arguments:JSON.stringify({plan:planMarkdown}),output:planMarkdown}} as any} reveal/>);
await delay(40);
const link=host.querySelector('.tool-plan-link');
assert.ok(link,'the opened row shows the plan link');
assert.match(link.textContent??'',/Ship the redirect fix.*View plan/);
assert.ok(!(host.textContent??'').includes('Add a regression test for the login loop'),'the full plan is not repeated in the row');
root.unmount();
console.log('review-fixes-dom: ok');
