/** Bundled and run by scripts/test-renderer.mjs. A muster_office tool row shows what a first download is doing. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
const listeners=new Set<(event:Record<string,unknown>)=>void>();
window.muster={subscribe(listener:(event:Record<string,unknown>)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},async invoke(command:string){
  if(command==='app.snapshot')return {version:1,chats:[],folders:[],projects:[]};
  if(command==='providers.list'||command==='plugins.list')return [];
  return undefined;
}};
const emit=(event:Record<string,unknown>)=>{for(const listener of listeners)listener(event);};
const {createRoot}=await import('react-dom/client');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:false});
const {ToolCard}=await import('../src/renderer/components/ToolCard');
const at=new Date().toISOString();
const item=(status:'running'|'completed',server='muster_office')=>({id:`tool-${status}-${server}`,chatId:'chat-1',kind:'tool',status,text:`${server} / office_render`,createdAt:at,data:{type:'mcpToolCall',server,tool:'office_render',arguments:{path:'report.docx'}}});
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const status=()=>document.querySelector('[role="status"]')?.textContent??null;

// Spec: MUS-SPEC-21-789P (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-789p)
await check('A running office tool row shows the first download progress and clears it when done',async()=>{
  root.render(<ToolCard item={item('running') as never}/>);await delay(40);
  assert.equal(status(),null,'nothing to say before a download starts');
  emit({type:'officeToolProgress',chatId:'another-chat',message:'Downloading LibreOffice for the first render… 1 MB of 298 MB (0%)'});await delay(20);
  assert.equal(status(),null,'another chat\'s download is not shown here');
  emit({type:'officeToolProgress',chatId:'chat-1',message:'Downloading LibreOffice for the first render… 150 MB of 298 MB (50%)'});await delay(20);
  assert.match(status()??'',/Downloading LibreOffice.*50%/);
  emit({type:'officeToolProgress',chatId:'chat-1',message:null});await delay(20);
  assert.equal(status(),null,'cleared when the tool is done');
  root.render(<ToolCard item={item('completed') as never}/>);await delay(20);
  emit({type:'officeToolProgress',chatId:'chat-1',message:'Installing LibreOffice…'});await delay(20);
  assert.equal(status(),null,'a finished row shows no progress');
  root.render(<ToolCard item={item('running','other_server') as never}/>);await delay(20);
  emit({type:'officeToolProgress',chatId:'chat-1',message:'Installing LibreOffice…'});await delay(20);
  assert.equal(status(),null,'only muster_office rows show it');
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('office-tool-progress-789-dom: ok');
