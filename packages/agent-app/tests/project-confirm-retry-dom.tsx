/** Archive / delete confirmation: a failed impact preview can be retried. */
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
let reads=0;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='project.preview'){reads++;if(reads===1)throw new Error('busy');return {chats:{total:1,running:0,items:[]},tasks:{total:0,open:0,running:0,items:[]}};}
  return undefined;}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ConfirmProjectAction}=await import('../src/renderer/components/ProjectEditDialog');
const until=async(cond:()=>boolean)=>{for(let i=0;i<100&&!cond();i++)await delay(10);assert.ok(cond(),'condition');};
const root=createRoot(document.getElementById('root')!);
root.render(<ConfirmProjectAction project={{id:'p',name:'P'} as any} action="archive" onClose={()=>{}} onArchived={()=>{}} onDeleted={()=>{}}/>);
await until(()=>/busy/.test(document.body.textContent??''));
const retry=[...document.querySelectorAll('button')].find(b=>/try again|retry/i.test(b.textContent??''));
assert.ok(retry,'a failed preview offers a retry');
retry!.dispatchEvent(new window.Event('click',{bubbles:true}));
await until(()=>document.querySelector('.project-impact')!==null);
console.log('project-confirm-retry-dom ok');
process.exit(0);
