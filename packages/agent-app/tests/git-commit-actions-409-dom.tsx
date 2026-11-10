// #409: the History graph's commit menu (right-click and Shift+F10), its confirm dialogs, guards and refresh. linkedom DOM, stubbed bridge.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,Event:window.Event,
  ResizeObserver:class{observe(){}disconnect(){}unobserve(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,width:600,height:400,left:0,top:0,right:600,bottom:400};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
(window.HTMLElement.prototype as any).scrollIntoView=function(){};
(window.document as any).hasFocus=()=>true;
(globalThis as any).Worker=class{constructor(){throw new Error('no worker');}};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',userAgent:'linkedom',clipboard:{writeText:async()=>undefined}}});

const calls:{command:string;input:any}[]=[];
const listeners=new Set<(event:any)=>void>();
const emit=(event:any)=>{for(const listener of [...listeners])listener(event);};
const sha=(n:number)=>String(n).padStart(40,'c');
const mainCommits=Array.from({length:4},(_,i)=>({sha:sha(i),short:sha(i).slice(0,7),author:'Ada',email:'a@b',authoredAt:new Date(Date.now()-i*3600e3).toISOString(),subject:`Main ${i}`,parents:i<3?[sha(i+1)]:[],refs:i===0?['main']:[],head:i===0}));
const topicCommits=[{sha:sha(9),short:sha(9).slice(0,7),author:'Grace',email:'g@b',authoredAt:new Date().toISOString(),subject:'Topic fix',parents:[sha(1)],refs:['topic'],head:false},...mainCommits.slice(1).map(c=>({...c,head:false}))];
const clean={branch:'main',detached:false,unborn:false,revision:'r1',files:[],truncated:false,stagedCount:0,conflicted:false};
let status:any=clean;
let actionResult:any=()=>({status:clean});
const snapshot=(chats:any[]=[])=>({version:1,chats,folders:[{id:'f',name:'Repo',path:'/repo'}],projects:[]});
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='git.info')return {branch:'main',detached:false,fetchedAt:null,hasRemote:false,worktree:null};
  if(command==='git.log'){const list=input.ref==='topic'?topicCommits:mainCommits;return {commits:list,hasMore:false,skip:0};}
  if(command==='git.commitDetail'){const c=[...mainCommits,...topicCommits].find(c=>c.sha===input.sha)!;return {commit:c,body:`${c.subject}\n\nWhy it changed.`,base:c.parents[0]??null,files:[],truncated:false};}
  if(command==='git.branches')return {current:'main',detached:false,local:[{name:'main'},{name:'topic'}],recent:[],truncated:false};
  if(command==='git.status')return status;
  if(command==='git.commitAction')return actionResult(input);
  if(command==='git.changes')return [];
  if(command==='git.conflicts')return {operation:'cherry-pick',currentLabel:'main',incomingLabel:'Topic fix',incomingSubject:'Topic fix',files:[],canContinue:false};
  if(command==='clipboard.write')return;
  return undefined;
}};
const React=await import('react');
const {act}=React;
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {GitHistoryTab}=await import('../src/renderer/components/GitHistoryTab');
await store.boot();
const host=document.getElementById('root')!;
const settle=async(ms=80)=>{await act(async()=>{await delay(ms);});};
const until=async(ok:()=>unknown,what:string,ms=3000)=>{for(const end=Date.now()+ms;Date.now()<end;await settle(20))if(ok())return;assert.fail(`timed out waiting for ${what}`);};
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const called=(command:string)=>calls.filter(c=>c.command===command);
const rows=()=>[...host.querySelectorAll('.git-history-row')] as HTMLElement[];
const items=()=>[...document.querySelectorAll('[role=menuitem]')] as HTMLElement[];
const item=(label:RegExp)=>items().find(i=>label.test(text(i)));
const dialog=()=>document.querySelector('[data-testid="commit-action-dialog"]');
const confirmButton=()=>dialog()?.querySelector<HTMLButtonElement>('[data-testid="commit-action-confirm"]');
const rightClick=async(node:Element)=>{const event=new window.Event('contextmenu',{bubbles:true,cancelable:true});Object.defineProperty(event,'clientX',{value:40});Object.defineProperty(event,'clientY',{value:30});await act(async()=>{node.dispatchEvent(event);await delay(30);});return event;};
const press=async(node:Element,key:string,extra:Record<string,unknown>={})=>{const event=new (window as any).KeyboardEvent('keydown',{bubbles:true,cancelable:true,key,...extra});await act(async()=>{node.dispatchEvent(event);await delay(30);});return event;};
const click=async(el:Element|null|undefined,what:string)=>{assert.ok(el,`${what} exists`);await act(async()=>{(el as HTMLElement).click();await delay(30);});};
const closeMenu=async()=>{const open=document.querySelector('[role=menu]');if(open)await press(open,'Escape');await settle();};
const openMenuOn=async(index:number)=>{await rightClick(rows()[index]);await until(()=>items().length,'the commit menu');};
const choose=async(label:RegExp)=>{await click(item(label),`menu item ${label}`);await until(()=>dialog(),'the action dialog');await until(()=>confirmButton()&&!/Checking/.test(text(confirmButton())),'the dialog to finish checking');};
const showRef=async(value:string)=>{const select=host.querySelector<HTMLSelectElement>('select[aria-label="Commits shown"]');assert.ok(select,'the branch selector');await act(async()=>{for(const option of select.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')===value);select.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);});await until(()=>called('git.log').at(-1)?.input.ref===(value||undefined)&&rows()[0]?.textContent?.includes(value==='topic'?'Topic fix':'Main 0'),`the ${value||'current'} history`);};

const root=createRoot(host);
await act(async()=>{root.render(<GitHistoryTab tab={{id:'history:f',kind:'history',folderId:'f',title:'History · Repo'}}/>);});
await until(()=>rows().length===4,'the commit rows');

// Spec: MUS-SPEC-08-409H (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409h)
await check('a commit row opens its action menu on right-click and on Shift+F10, and Copy SHA copies the full SHA',async()=>{
  const event=await rightClick(rows()[1]);
  await until(()=>items().length,'the menu from right-click');
  assert.equal(event.defaultPrevented,true,'the browser menu is suppressed');
  assert.deepEqual(items().map(text),['Copy SHA','Copy message','Check out this commit…','Create branch here…','Cherry-pick onto main…','Revert this commit…']);
  assert.ok(item(/Cherry-pick/)!.getAttribute('aria-disabled')==='true'||item(/Cherry-pick/)!.hasAttribute('data-disabled'),'a commit already on main cannot be picked onto it');
  await closeMenu();
  assert.equal(items().length,0,'Escape closes the menu');
  await press(rows()[1],'F10',{shiftKey:true});
  await until(()=>items().length,'the menu from Shift+F10');
  await click(item(/^Copy SHA$/),'Copy SHA');
  assert.deepEqual(called('clipboard.write').at(-1)?.input,{text:sha(1)});
  await settle();
  await press(rows()[1],'ContextMenu');
  await until(()=>items().length,'the menu from the ContextMenu key');
  await click(item(/^Copy message$/),'Copy message');
  await until(()=>called('clipboard.write').length===2,'the message copy');
  assert.deepEqual(called('clipboard.write').at(-1)?.input,{text:'Main 1\n\nWhy it changed.'});
  await settle();
});

// Spec: MUS-SPEC-08-409I (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409i)
await check('checkout and revert confirm first, naming what happens, then refresh history and changes',async()=>{
  await openMenuOn(2);
  await choose(/Check out this commit/);
  assert.match(text(dialog()),new RegExp(`${sha(2).slice(0,7)}.*Main 2`),'the dialog names the commit');
  assert.match(text(dialog()),/detached/i,'and says HEAD will be detached');
  assert.equal(called('git.commitAction').length,0,'nothing runs before confirm');
  const logs=called('git.log').length,changes=called('git.changes').length;
  assert.equal(text(confirmButton()),'Check out');
  await click(confirmButton(),'Check out');
  await until(()=>!dialog(),'the dialog to close');
  assert.deepEqual(called('git.commitAction').at(-1)?.input,{folderId:'f',action:'checkout',sha:sha(2),revision:'r1'});
  await until(()=>called('git.log').length>logs&&called('git.changes').length>changes,'history and Changes to reload');
  await openMenuOn(1);
  await choose(/Revert this commit/);
  assert.match(text(dialog()),new RegExp(`new commit on main.*undoes.*${sha(1).slice(0,7)}`,'i'));
  await click(confirmButton(),'Revert');
  await until(()=>!dialog(),'the dialog to close');
  assert.deepEqual(called('git.commitAction').at(-1)?.input,{folderId:'f',action:'revert',sha:sha(1),revision:'r1'});
});

// Spec: MUS-SPEC-08-409J (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409j)
await check('with uncommitted changes the dialog names them and offers no way to run the action',async()=>{
  await showRef('topic');
  status={...clean,revision:'r2',files:[{path:'src/app.ts',index:' ',worktree:'M',staged:false,untracked:false,conflict:false},{path:'README.md',index:'M',worktree:' ',staged:true,untracked:false,conflict:false},{path:'notes.txt',index:'?',worktree:'?',staged:false,untracked:true,conflict:false}],stagedCount:1};
  const before=called('git.commitAction').length;
  await openMenuOn(0);
  await choose(/Cherry-pick onto main/);
  assert.match(text(dialog()),/2 uncommitted files.*src\/app\.ts.*README\.md/,'both tracked files are named');
  assert.doesNotMatch(text(dialog()),/notes\.txt/,'untracked files do not block');
  assert.match(text(dialog()),/commit or stash/i);
  assert.equal(confirmButton()!.disabled,true,'the action cannot run');
  await press(dialog()!,'Escape');
  await until(()=>!dialog(),'the dialog to close');
  assert.equal(called('git.commitAction').length,before);
  status=clean;
});

// Spec: MUS-SPEC-08-409L (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409l)
await check('a conflicting cherry-pick opens changes and the conflict view for the first file',async()=>{
  actionResult=()=>({status:{...clean,conflicted:true},conflicts:['src/app.ts']});
  await openMenuOn(0);
  await choose(/Cherry-pick onto main/);
  assert.match(text(dialog()),new RegExp(`${sha(9).slice(0,7)}.*Topic fix.*on top of main`,'i'));
  await click(confirmButton(),'Cherry-pick');
  await until(()=>store.getState().tabs.some(t=>t.kind==='conflict'&&t.path==='src/app.ts'),'the conflict tab');
  assert.deepEqual(called('git.commitAction').at(-1)?.input,{folderId:'f',action:'cherry-pick',sha:sha(9),revision:'r1'});
  assert.ok(store.getState().tabs.some(t=>(t as any).gitView==='changes'),'Changes opens too');
  assert.ok(store.getState().notices.some((n:any)=>/cherry-pick stopped on 1 conflicting file/i.test(n.message)),'a notice explains the stop');
  actionResult=()=>({status:clean});
  await showRef('');
});

// Spec: MUS-SPEC-08-409M (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409m)
await check('create branch here asks for a name and whether to switch to it',async()=>{
  actionResult=(input:any)=>({status:clean,branch:input.branch});
  await openMenuOn(3);
  await choose(/Create branch here/);
  const input=dialog()!.querySelector<HTMLInputElement>('input[aria-label="Branch name"]')!;
  assert.ok(input,'a name field');
  assert.equal(confirmButton()!.disabled,true,'a name is needed');
  let proto=Object.getPrototypeOf(input),descriptor:PropertyDescriptor|undefined;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);
  await act(async()=>{descriptor!.set!.call(input,'hotfix');input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(20);});
  const box=dialog()!.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
  assert.match(text(box.closest('label')),/Switch to it/);
  await act(async()=>{box.checked=true;box.dispatchEvent(new window.Event('click',{bubbles:true}));await delay(20);});
  await click(confirmButton(),'Create branch');
  await until(()=>!dialog(),'the dialog to close');
  assert.deepEqual(called('git.commitAction').at(-1)?.input,{folderId:'f',action:'branch',sha:sha(3),branch:'hotfix',checkout:true,revision:'r1'});
  assert.ok(store.getState().notices.some((n:any)=>/hotfix/.test(n.message)),'a notice names the branch');
  actionResult=()=>({status:clean});
});

// Spec: MUS-SPEC-08-409K (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-409k)
await check('a running chat in the same folder is named before HEAD changes and the confirm says anyway',async()=>{
  await act(async()=>{emit({type:'snapshot',snapshot:snapshot([{id:'c1',title:'Refactor parser',folderId:'f',status:'running'}])});await delay(30);});
  await openMenuOn(2);
  await choose(/Check out this commit/);
  assert.match(text(dialog()),/Refactor parser.*running in this folder/);
  assert.equal(text(confirmButton()),'Check out anyway');
  await click(confirmButton(),'Check out anyway');
  await until(()=>!dialog(),'the dialog to close');
  assert.deepEqual(called('git.commitAction').at(-1)?.input,{folderId:'f',action:'checkout',sha:sha(2),revision:'r1',allowRunning:true});
});

await act(async()=>{root.unmount();});
process.exit(0);
