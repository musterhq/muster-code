/** #400 renderer gates: settled rows never re-render while the tail streams; icon stacks; folds; keyboard. */
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import type {TimelineItem} from '../src/shared/protocol';
const require=createRequire(import.meta.url);
const {window}=require('linkedom').parseHTML('<html><body><div id="root"></div></body></html>');
window.innerWidth=1000;window.innerHeight=800;(window as any).getSelection=()=>({rangeCount:0});
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null;},setItem(){},removeItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{get(){return 600;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get(){return Number.parseFloat(this.querySelector('.timeline-inner')?.style.height||'600');}});
Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get(){return this.classList.contains('timeline-row')?30:600;}});
Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get(){return 800;}});
window.HTMLElement.prototype.getBoundingClientRect=function(){return{height:this.classList.contains('timeline-row')?30:600,width:800,top:0,left:0,bottom:600,right:800};};
window.HTMLElement.prototype.scrollTo=function({top}:any){this.scrollTop=Math.max(0,top);queueMicrotask(()=>this.dispatchEvent(new window.Event('scroll')));};
const invoked:string[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){invoked.push(command);if(command==='favicon.get')return {dataUrl:null};if(command==='review.baselines'||command==='review.marks')return [];if(command==='checkout.leases')return {leases:[]};throw new Error('unavailable');}};
const React=await import('react');const {createRoot}=await import('react-dom/client');
const {Timeline,setRowRenderProbe}=await import('../src/renderer/components/ChatView');
const {IconStack}=await import('../src/renderer/components/transcript/Primitives');

const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const at=(s:number)=>new Date(Date.UTC(2026,9,12,10,0,s)).toISOString();
let n=0;const item=(kind:TimelineItem['kind'],text='',extra:Partial<TimelineItem>={}):TimelineItem=>({id:`${kind}-${++n}`,chatId:'dom',kind,text,createdAt:at(n),status:'completed',...extra});

// 1. Icon stack: at most three icons, each ringed and overlapping the previous, then "+N"; hover lists every source.
const icons=['a.example','b.example','c.example','d.example','e.example'].map(host=>({kind:'site' as const,key:host,host}));
root.render(<IconStack icons={icons}/>);await delay(20);
assert.equal(document.querySelectorAll('.tx-stack-item').length,3,'three icons at most');
assert.equal(document.querySelector('.tx-stack-more')?.textContent,'+2','then +N');
assert.equal(document.querySelector('.tx-stack')?.getAttribute('aria-label'),icons.map(icon=>icon.host).join(', '),'every source is named (a styled tip lists them on hover)');
assert.equal(document.querySelector('.tx-stack')?.getAttribute('title'),null,'no native title');
assert.equal(document.querySelectorAll('.tx-letter').length,3,'a letter tile stands in until an icon arrives');
root.render(<IconStack icons={icons.slice(0,2)}/>);await delay(10);
assert.equal(document.querySelector('.tx-stack-more'),null,'no +N when everything fits');
const css=readFileSync(join(process.cwd(),'src/renderer/components/transcript/transcript.css'),'utf8');
const tokens=readFileSync(join(process.cwd(),'src/renderer/styles.css'),'utf8');
assert.match(css,/\.tx-stack-item \+ \.tx-stack-item \{ margin-left: var\(--icon-stack-overlap\); \}/);
assert.match(tokens,/--icon-stack: 16px;/);assert.match(tokens,/--icon-stack-overlap: -6px;/,'each icon overlaps the previous by about 40% of 16px');
assert.match(tokens,/--icon-stack-overlap-agent: -4px;/,'agent avatars overlap by 4px');
assert.match(css,/box-shadow: 0 0 0 var\(--icon-ring\) var\(--bg\)/);assert.match(tokens,/--icon-ring: 1\.5px;/,'with a 1.5px ring in the row background');

// 2. Render-count gate: while a reply streams, settled rows render zero times.
const settled=[item('user','First'),item('reasoning','Plan'),item('tool','',{data:{type:'commandExecution',command:'ls',exitCode:0}}),item('assistant','Answer one.'),
  item('user','Second'),item('tool','',{data:{type:'fileChange',changes:[{path:'a.ts',kind:'update',diff:'@@ -1 +1 @@\n-a\n+b'}]}}),item('assistant','Answer two.')];
const prompt=item('user','Third',{status:undefined,createdAt:new Date(Date.now()-5000).toISOString()});
const renders=new Map<string,number>();setRowRenderProbe(key=>renders.set(key,(renders.get(key)??0)+1));
let streaming=item('assistant','',{status:'running',createdAt:new Date().toISOString()});
const render=async(items:TimelineItem[])=>{root.render(<Timeline key="dom" chatId="dom" items={items} running/>);await delay(5);};
await render([...settled,prompt,streaming]);await delay(30);
const settledKeys=[...renders.keys()].filter(key=>!key.includes(streaming.id)&&!key.startsWith('live:'));
assert.ok(settledKeys.length>=4,'settled rows rendered once');
renders.clear();
const TOKENS=2000;
for(let i=0;i<TOKENS;i+=40){streaming={...streaming,text:streaming.text+'token '.repeat(40)};await render([...settled,prompt,streaming]);}
await delay(30);
const settledRenders=settledKeys.reduce((sum,key)=>sum+(renders.get(key)??0),0);
console.log(`[x1] settled-row renders during a ${TOKENS}-token stream: ${settledRenders} (streaming row: ${renders.get(streaming.id)??0})`);
assert.equal(settledRenders,0,'settled rows never re-render while the tail streams');
assert.ok((renders.get(streaming.id)??0)>0,'the streaming row does');
setRowRenderProbe(undefined);
assert.ok(document.querySelector('.tx-live'),'the live row is on screen');
assert.match(document.querySelector('.tx-live-step')?.textContent??'',/Responding/);

// 3. Folds: a settled turn shows its fold line, the answer and the card; opening it shows the work without remounting.
await render([...settled,prompt,{...streaming,status:'completed'}]);
root.render(<Timeline key="dom2" chatId="dom2" items={settled.map(entry=>({...entry,chatId:'dom2'}))}/>);await delay(40);
const folds=()=>[...document.querySelectorAll('.tx-fold')] as HTMLButtonElement[];
assert.equal(folds().length,2,'each settled turn with work has a fold line');
assert.match(folds()[0]!.textContent??'',/^Worked for \d+s.*Ran 1 command/);
assert.equal(folds()[0]!.getAttribute('aria-expanded'),'false');
assert.ok(!document.querySelector('.tx-thought'),'folded thoughts are not rendered');
assert.ok(document.querySelector('.tx-files'),'the changed-files card sits under the reply');
assert.equal(document.querySelector('.tx-files .tx-file-name')?.textContent,'a.ts');
const timeline=document.querySelector('.timeline');
folds()[0]!.click();await delay(30);
assert.equal(folds()[0]!.getAttribute('aria-expanded'),'true');
assert.ok(document.querySelector('.tx-thought'),'opening shows the turn’s thought');
assert.equal(document.querySelector('.timeline'),timeline,'no remount');

// 4. Keyboard: e closes the current turn again; typing in a field is never captured.
const key=(name:string,target:EventTarget=window)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});target.dispatchEvent(event);return event;};
const field=document.createElement('textarea');document.body.appendChild(field);
assert.equal(key('e',field).defaultPrevented,false,'keys typed into a field pass through');
key('k');await delay(40);key('e');await delay(30);
assert.ok(folds().some(fold=>fold.getAttribute('aria-expanded')==='false'),'e toggles the current turn');
root.unmount();assert.deepEqual(errors,[]);
console.log('Transcript DOM checks passed: icon stack cap and overlap, zero settled re-renders while streaming, folds, changed-files card, keyboard.');
