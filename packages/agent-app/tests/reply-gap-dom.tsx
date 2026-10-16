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
const at='2026-09-19T10:00:00Z';
const item=(id:string,kind:string,text:string):any=>({id,chatId:'one',kind,text,createdAt:at});
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const until=async(ok:()=>unknown,ms=2000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);};
root.render(<Timeline chatId="one" items={[item('u1','user','Go'),item('a1','assistant','First'),item('a2','assistant','Second'),item('a3','assistant','Third'),item('u2','user','Again'),item('a4','assistant','Fourth')]}/>);
await until(()=>document.querySelector('[data-item-id="a4"]'));
assert.deepEqual(errors,[]);
const cont=(id:string)=>document.querySelector(`[data-item-id="${id}"]`)!.classList.contains('is-reply-continuation');
assert.equal(cont('a1'),false,'first reply after the user message keeps its spacing');
assert.equal(cont('a2'),true,'a reply directly after a reply continues it');
assert.equal(cont('a3'),true);
assert.equal(cont('u2'),false,'user rows are untouched');
assert.equal(cont('a4'),false,'a reply after a user message keeps its spacing');
process.exit(0);
