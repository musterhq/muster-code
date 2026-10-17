/** My work: a failed read offers Retry, and Retry reads again. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'})});
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
let reads=0;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='orgs.work'){reads++;if(reads===1)throw new Error('server unreachable');return {connected:false,me:null,fetchedAt:new Date().toISOString(),orgs:[]};}
  return undefined;}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {MyWorkPage}=await import('../src/renderer/components/MyWorkPage');
const until=async(cond:()=>boolean)=>{for(let i=0;i<100&&!cond();i++)await delay(10);assert.ok(cond(),'condition');};
const root=createRoot(document.getElementById('root')!);
root.render(<MyWorkPage/>);
await until(()=>/could not be read/.test(document.body.textContent??''));
const retry=[...document.querySelectorAll('button')].find(b=>/retry/i.test(b.textContent??''));
assert.ok(retry,'a failed read offers Retry');
retry!.dispatchEvent(new window.Event('click',{bubbles:true}));
await until(()=>!/could not be read/.test(document.body.textContent??''));
assert.equal(reads,2);
console.log('my-work-retry-dom ok');
process.exit(0);
