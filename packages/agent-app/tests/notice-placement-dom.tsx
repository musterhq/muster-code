/** Toast placement (#627): the real App renders the stack; layout sizes are faked per element class, so no real window is used.
 *  Bundled by scripts/test-renderer.mjs. */
import {createRequire} from 'node:module';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="fake-layout"></div><div id="root"></div></body></html>');
const storage=new Map<string,string>();
const memory={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,localStorage:memory,sessionStorage:memory,CustomEvent:window.CustomEvent});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',minHeight:'26px',maxHeight:'200px',borderTopWidth:'0px',borderBottomWidth:'0px',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
type Box={left:number;top:number;right:number;bottom:number};
const layout:{card:Box;composer:Box;status:Box}={card:{left:0,top:0,right:0,bottom:0},composer:{left:0,top:0,right:0,bottom:0},status:{left:0,top:0,right:0,bottom:0}};
const rect=(box:Box)=>({x:box.left,y:box.top,left:box.left,top:box.top,right:box.right,bottom:box.bottom,width:box.right-box.left,height:box.bottom-box.top});
window.HTMLElement.prototype.getBoundingClientRect=function(this:HTMLElement){
  if(this.classList.contains('summary-card'))return rect(layout.card);
  if(this.classList.contains('composer'))return rect(layout.composer);
  if(this.classList.contains('env-footer'))return rect(layout.status);
  return rect({left:0,top:0,right:0,bottom:0});
};
// The sizes above belong to these stand-ins, which come first in the document, so they are what the layout measures.
document.getElementById('fake-layout')!.innerHTML='<div class="summary-card"></div><div class="composer"></div><footer class="env-footer"></footer>';
const snapshot={chats:[],folders:[],projects:[],version:1,activeChatId:null};
(window as any).muster={subscribe(){return()=>undefined;},async invoke(command:string){if(command==='app.snapshot')return snapshot;return undefined;}};
const resize=(width:number,height:number)=>{(window as any).innerWidth=width;(window as any).innerHeight=height;window.dispatchEvent(new window.Event('resize'));};
resize(1280,800);

const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {App}=await import('../src/renderer/App');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<App/>);
await store.boot();await delay(60);
const clear=()=>{for(const notice of store.getState().notices)store.dismissNotice(notice.id);};
const stack=()=>document.querySelector<HTMLElement>('.notices')!;
const px=(value:string)=>Number.parseFloat(value);
const place=async(width:number,height:number,boxes:Partial<typeof layout>,count=2)=>{
  clear();Object.assign(layout,boxes);resize(width,height);
  for(let i=0;i<count;i++)store.notifyError(new Error(`Toast ${i}`));
  await delay(60);resize(width,height);await delay(60);
  const element=stack();assert.ok(element,'the stack is on screen');
  return {bottomEdge:height-px(element.style.bottom),topLimit:height-px(element.style.bottom)-px(element.style.maxHeight),right:element.style.right,left:width-16-Math.min(380,width-32)};
};
// The suite runs from dist/tests/ (scripts/test-renderer.mjs bundles it there), so the source tree is two levels up.
const css=readFileSync(new URL('../../src/renderer/styles.css',import.meta.url),'utf8');
const base=css.slice(css.indexOf('\n.notices {'));const baseBody=base.slice(base.indexOf('{')+1,base.indexOf('}'));

// Spec: MUS-SPEC-16-1A (docs/spec/clauses/16-notifications-and-attention.md#mus-spec-16-1a)
await check('toasts stack in the bottom-right corner above the status row',async()=>{
  assert.doesNotMatch(baseBody,/^\s*top:/m,'the stack is not pinned to the top of the window');
  assert.match(baseBody,/^\s*right:\s*16px;/m);
  const result=await place(1440,900,{card:{left:1126,top:56,right:1426,bottom:360},composer:{left:260,top:700,right:1040,bottom:800},status:{left:260,top:810,right:1040,bottom:834}});
  assert.equal(result.bottomEdge,802,'its bottom edge is 8px above the status row');
  assert.ok(result.topLimit>=368,`it cannot reach the card (limit ${result.topLimit})`);
  assert.ok(result.left>=1044,'it starts right of the transcript column and the composer');
});

// Spec: MUS-SPEC-16-1B (docs/spec/clauses/16-notifications-and-attention.md#mus-spec-16-1b)
await check('toasts lift above the composer in a narrow window',async()=>{
  const result=await place(800,640,{card:{left:486,top:56,right:786,bottom:400},composer:{left:250,top:520,right:780,bottom:600},status:{left:250,top:610,right:780,bottom:634}},4);
  assert.ok(result.bottomEdge<=512,`the composer stays uncovered (stack bottom ${result.bottomEdge})`);
  assert.ok(result.topLimit>=408,`the card stays uncovered (stack top limit ${result.topLimit})`);
});

// Spec: MUS-SPEC-16-1C (docs/spec/clauses/16-notifications-and-attention.md#mus-spec-16-1c)
await check('toasts stay below the folded pill and above the composer',async()=>{
  const result=await place(1000,700,{card:{left:690,top:56,right:986,bottom:88},composer:{left:20,top:560,right:960,bottom:640},status:{left:20,top:650,right:960,bottom:674}},1);
  assert.ok(result.bottomEdge<=552,`the composer stays uncovered (stack bottom ${result.bottomEdge})`);
  assert.ok(result.topLimit>=96,`the pill stays uncovered (stack top limit ${result.topLimit})`);
});

// Spec: MUS-SPEC-16-1D (docs/spec/clauses/16-notifications-and-attention.md#mus-spec-16-1d)
await check('toasts stay in the window corner when the right pane is open',async()=>{
  const open={card:{left:546,top:56,right:846,bottom:340},composer:{left:200,top:640,right:824,bottom:720},status:{left:200,top:736,right:824,bottom:760}};
  const before=await place(1280,800,open,1);
  assert.equal(before.bottomEdge,728,'8px above the status row, over the pane');
  assert.ok(before.left>=884,'right of the card and the composer');
  assert.equal(before.topLimit,52,'the card does not limit it');
  layout.status={left:200,top:706,right:824,bottom:730};layout.composer={left:200,top:610,right:824,bottom:690};
  resize(1280,800);await delay(60);
  assert.equal(800-px(stack().style.bottom),698,'it follows the status row 30px up');
});

assert.deepEqual(errors,[]);
console.log('notice-placement-dom ok');
process.exit(0);
