import assert from 'node:assert/strict';
import type {TimelineItem} from '../src/shared/protocol';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
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
const at='2026-09-19T10:00:00Z';
const item=(id:string,kind:string,text:string):any=>({id,chatId:'one',kind,text,createdAt:at});
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const until=async(ok:()=>unknown,ms=2000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);};
root.render(<Timeline chatId="one" items={[item('u1','user','مرحبا، هل يمكنك مراجعة الملف؟ (README.md)'),item('u2','user','Hello there'),item('a1','assistant','مرحبا\n\n- أولا\n- ثانيا')]}/>);
await until(()=>document.querySelector('[data-item-id="u2"]'));
assert.deepEqual(errors,[]);
const dirOf=(id:string)=>document.querySelector(`[data-item-id="${id}"] .msg-user .msg-text`)!.getAttribute('dir');
// Spec: MUS-SPEC-01-554C (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-554c)
await check('each user message takes its text direction from its own first strong character',async()=>{
  assert.equal(dirOf('u1'),'auto','a right-to-left message takes its direction from its own text');
  assert.equal(dirOf('u2'),'auto','every message decides its direction from its first strong character');
});
await until(()=>document.querySelector('[data-item-id="a1"] li'));
// Spec: MUS-SPEC-01-554D (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-554d)
await check('paragraphs and list items in a reply take their own text direction',async()=>{
  for(const el of ['p','ul','li'])assert.equal(document.querySelector(`[data-item-id="a1"] .md-body ${el}`)!.getAttribute('dir'),'auto',`${el} in a reply takes its own direction (list markers follow it)`);
});
process.exit(0);
