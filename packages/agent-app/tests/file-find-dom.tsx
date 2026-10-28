/** Bundled and run by scripts/test-renderer.mjs. The in-file Find bar of an open file tab: Cmd+F, match count, next and previous, wrap, Escape. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLElement.prototype.focus=function(){};
const at=new Date().toISOString();
const FILE='alpha beta\nBeta gamma\nbeta delta\nepsilon\n';// "beta" appears three times, in three capitalisations
window.muster={subscribe(){return()=>{};},async invoke(command:string,_input:unknown){
  if(command==='app.snapshot')return JSON.parse(JSON.stringify({version:1,chats:[{id:'c1',title:'Chat',folderId:'folder',status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow'}],folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'c1'}));
  if(command==='files.read')return {text:FILE,truncated:false,revision:'r1'};
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='providers.list')return [];
  return undefined;
}};
// Dynamic imports: the app modules must load after the linkedom globals above exist.
const React=await import('react');
const {createRoot}=await import('react-dom/client');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:false});
const store=await import('../src/renderer/store');
const {FileTab}=await import('../src/renderer/components/FileTab');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();
await store.openFile('folder','notes.txt');
const tab=store.getState().tabs.find(item=>item.kind==='file')!;
root.render(<FileTab tab={tab}/>);await delay(80);

const bar=()=>document.querySelector('.file-find-bar');
const count=()=>document.querySelector('.file-find-count')?.textContent??null;
const button=(label:string)=>document.querySelector<HTMLButtonElement>(`.file-find-bar button[aria-label="${label}"]`)!;
const input=()=>document.querySelector('.file-find-bar input')! as HTMLInputElement&Record<string,{onChange:(event:unknown)=>void}>;
const current=()=>{const marks=[...document.querySelectorAll('.source-code-table mark')];return {total:marks.length,at:marks.findIndex(mark=>mark.getAttribute('data-current')==='true')};};
const type=async(value:string)=>{const element=input();Object.defineProperty(element,'value',{configurable:true,get:()=>value,set:()=>{}});const props=element[Object.keys(element).find(name=>name.startsWith('__reactProps'))!];props.onChange({target:element,currentTarget:element});await delay(40);};
const key=async(name:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:name,metaKey:false,ctrlKey:false,shiftKey:false,...extra});input().dispatchEvent(event);await delay(40);};
const click=async(element:HTMLElement)=>{element.click();await delay(40);};

assert.ok(document.querySelector('.code-scroll'),'the file is showing as source');
assert.equal(bar(),null,'Find is closed until asked for');

// Spec: MUS-SPEC-07-33H (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33h)
await check('Cmd+F opens Find in the open file and typing shows the match count with every match marked',async()=>{
  const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:'f',metaKey:true,ctrlKey:false});
  window.dispatchEvent(event);await delay(60);
  assert.ok(bar(),'the Find bar opens');
  assert.equal(event.defaultPrevented,true,'the browser\u2019s own find is not also opened');
  assert.equal(count(),'','nothing typed: no count yet');
  await type('beta');
    assert.equal(count(),'1/3','three matches, the first current (case is ignored)');
  assert.deepEqual(current(),{total:3,at:0},'all three are marked in the text and the first is the current one');
  assert.equal(button('Next match').disabled,false);
  await type('zzz');
  assert.equal(count(),'0/0','no match reads 0/0');
  assert.equal(button('Next match').disabled,true,'Next and Previous wait while there is nothing to step to');
  assert.equal(button('Previous match').disabled,true);
  await type('beta');
});

// Spec: MUS-SPEC-07-33I (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33i)
await check('Next, Previous and Enter step through the matches and wrap around, and Wrap around off stops at the ends',async()=>{
  assert.equal(count(),'1/3');
  await click(button('Next match'));assert.equal(count(),'2/3');assert.equal(current().at,1,'the second match is now the current one');
  await click(button('Next match'));assert.equal(count(),'3/3');
  await click(button('Next match'));assert.equal(count(),'1/3','Next past the last match wraps to the first');
  await click(button('Previous match'));assert.equal(count(),'3/3','Previous before the first match wraps to the last');
  await key('Enter');assert.equal(count(),'1/3','Enter is Next');
  await key('Enter',{shiftKey:true});assert.equal(count(),'3/3','Shift+Enter is Previous');
  await click(button('Wrap around'));
  assert.equal(button('Wrap around').getAttribute('aria-pressed'),'false','Wrap around is switched off');
  await click(button('Next match'));assert.equal(count(),'3/3','with wrap off, Next stays on the last match');
  await click(button('Wrap around'));
  await type('beta d');
  assert.equal(count(),'1/1','editing the search starts again at the first match');
  await type('beta');
});

// Spec: MUS-SPEC-07-33J (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-33j)
await check('Escape and Close find close the Find bar and show the file as source again',async()=>{
  assert.ok(document.querySelector('.source-code-table mark'),'while Find is open the matches are marked in the source table');
  await key('Escape');
  assert.equal(bar(),null,'Escape closes Find');
  assert.equal(document.querySelectorAll('mark').length,0,'the marks are gone');
  assert.ok(document.querySelector('.code-scroll'),'the file is back to its highlighted source');
  const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:'f',ctrlKey:true,metaKey:false});
  window.dispatchEvent(event);await delay(60);
  assert.ok(bar(),'Ctrl+F opens it again');
  assert.equal(input().value,'beta','the last search is still in the box');
  await click(button('Close find'));
  assert.equal(bar(),null,'the Close find button closes it too');
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('file-find-dom: ok');
process.exit(0);
