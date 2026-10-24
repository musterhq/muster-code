/** Inbox: a Group choice whose items are gone must not leave the list empty behind a hidden control. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'})});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='work.inbox.meta')return {items:[]};
  if(command==='paperclip.inbox.dismissed')return {items:[]};
  return undefined;}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=React as any;
const {InboxPage}=await import('../src/renderer/components/HubPages');
const now=new Date().toISOString();
const item=(id:string,group:string)=>({id,kind:'question',title:`Item ${id}`,why:'Waiting.',severity:'high',at:now,taskId:null,agentId:'a',runId:null,group,source:'paperclip'});
const snap=(inbox:any[])=>({paperclip:{origin:'x',company:{id:'c',name:'Co',prefix:'C'},companies:[],live:'socket'},tasks:[],agents:[],projects:[],goals:[],runs:[],inbox,counts:{liveRuns:0,inbox:inbox.length,failedRuns:0,openTasks:0},fetchedAt:now}) as any;
const nav={onOpenTask(){},onOpenAgent(){},onOpenChat(){}};
const until=async(cond:()=>boolean)=>{for(let i=0;i<100&&!cond();i++)await delay(10);assert.ok(cond(),'condition');};
const root=createRoot(document.getElementById('root')!);
const rows=()=>[...document.querySelectorAll('.ws-inbox-row')].length;
// Spec: MUS-SPEC-12-558A (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-558a)
await check('the Inbox shows the remaining items when the chosen group has none left', async () => {
  root.render(<InboxPage snapshot={snap([item('1','Alpha'),item('2','Beta')])} nav={nav}/>);
  await until(()=>rows()===2);
  const select=document.querySelector('select[aria-label="Group"]') as any;
  Object.defineProperty(select,'value',{value:'Alpha',configurable:true});
  select.dispatchEvent(new window.Event('change',{bubbles:true}));
  await until(()=>rows()===1);
  // Alpha's item is resolved: only Beta is left.
  root.render(<InboxPage snapshot={snap([item('2','Beta')])} nav={nav}/>);
  await delay(100);
  assert.equal(rows(),1,'the remaining item is shown, not an empty list behind a hidden Group control');
});
console.log('inbox-group-stale-dom ok');
process.exit(0);
