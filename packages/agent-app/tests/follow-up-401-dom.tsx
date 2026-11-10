/** #401: the suggested follow-up in the composer (ghost text, Tab, click, modifier-click) and the transcript divider
 *  where the model or effort changed. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div><div id="transcript"></div></body></html>');
window.innerWidth=1000;window.innerHeight=800;
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;(window as any).getSelection=()=>({anchorNode:null,anchorOffset:0,focusNode:null,focusOffset:0,rangeCount:0});
class Highlight extends Set<any>{constructor(...ranges:any[]){super(ranges);}}
Object.assign(globalThis,{Highlight,CSS:{highlights:new Map<string,Highlight>()}});
Object.defineProperty(window.HTMLElement.prototype,'clientHeight',{get(){return 350;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollHeight',{get(){return Number.parseFloat(this.querySelector?.('.timeline-inner')?.style.height||'350');}});
Object.defineProperty(window.HTMLElement.prototype,'offsetHeight',{get(){return this.classList.contains('timeline-row')?70:350;}});
Object.defineProperty(window.HTMLElement.prototype,'offsetWidth',{get(){return 800;}});
window.HTMLElement.prototype.getBoundingClientRect=function(){return{x:0,y:0,height:this.classList.contains('timeline-row')?70:350,width:800,top:0,left:0,bottom:350,right:800};};
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLElement.prototype.scrollTo=function({top}:any){this.scrollTop=Math.max(0,Math.min(top,this.scrollHeight-this.clientHeight));};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
window.HTMLCanvasElement.prototype.getContext=()=>null;
(globalThis as any).CustomEvent=window.CustomEvent;

const at=new Date(Date.now()-60_000).toISOString();
const mk=(id:string,extra:Record<string,unknown>={})=>({id,title:id,folderId:'folder',status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'gpt-5.5',mode:'agent',providerId:'hybrow',...extra});
let chats:any[]=[mk('one')];
const timeline=[
  {id:'u1',chatId:'one',kind:'user',text:'fix the build',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'gpt-5.5',effort:'medium'}}},
  {id:'a1',chatId:'one',kind:'assistant',text:'Fixed. The tests are next.',status:'completed',createdAt:at},
  {id:'u2',chatId:'one',kind:'user',text:'go on',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'gpt-5.5',effort:'medium'},followUp:'Run the tests again'}},
  {id:'a2',chatId:'one',kind:'assistant',text:'Done.',status:'completed',createdAt:at},
];
const calls:{command:string;input:any}[]=[];
const snapshot=()=>JSON.parse(JSON.stringify({version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'one'}));
const listeners=new Set<(event:any)=>void>();
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:timeline,revision:1};
  if(command==='chat.send')return {runId:'run'};
  if(command==='settings.get')return {values:{'chat.suggestFollowUps':true}};
  if(command==='chat.update'){chats=chats.map(chat=>chat.id===input.id?{...chat,...input}:chat);return chats.find(chat=>chat.id===input.id);}
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow',available:true,models:[{id:'gpt-5.5',name:'GPT-5.5',efforts:['low','medium','high'],defaultEffort:'medium'},{id:'fable-5',name:'Fable 5',efforts:['low','medium','high']}]}];
  if(command==='plugins.list'||command==='plugins.inventory'||command==='skills.list'||command==='files.list')return [];
  if(command==='files.search')return {entries:[],truncated:false};
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='computer.permissions')return {accessibility:'granted',screen:'granted'};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {Composer}=await import('../src/renderer/components/Composer');
const {Timeline}=await import('../src/renderer/components/ChatView');
const {useStoreSlice}=await import('../src/renderer/useStore');
function Screen(){useStoreSlice('snapshot','activeChatId');const chat=store.activeChat();return chat?<Composer chat={chat}/>:null;}
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Screen/>);await delay(300);
const until=async(ok:()=>unknown,ms=3000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);};
await until(()=>store.getState().timelines.one?.value);await delay(50);
assert.deepEqual(errors,[]);
const field=()=>document.querySelector('[data-testid="composer-input"]') as any;
const ghost=()=>document.querySelector('[data-testid="composer-follow-up"]') as any;
const draft=()=>store.getState().composerDrafts.one?.text??'';
const key=(name:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.assign(event,{key:name,...extra});field().dispatchEvent(event);};
const click=(element:any,extra:Record<string,unknown>={})=>{const event=new window.Event('click',{bubbles:true,cancelable:true});Object.assign(event,{button:0,...extra});element.dispatchEvent(event);};
const clear=async()=>{store.setComposerDraft('one','');await delay(40);};

// Spec: MUS-SPEC-01-401A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-401a)
await check('the suggested follow-up shows as ghost text in an empty composer and Tab fills it',async()=>{
  await until(()=>ghost());
  assert.ok(ghost(),'the suggestion is shown in the empty composer');
  assert.match(ghost().textContent,/Run the tests again/);
  assert.match(ghost().textContent,/Tab/,'with a Tab hint');
  assert.equal(field().getAttribute('placeholder')??'','','the usual placeholder steps aside');
  key('Tab');await until(()=>draft()==='Run the tests again');
  assert.equal(draft(),'Run the tests again','Tab puts exactly the suggestion in the composer');
  assert.equal(calls.filter(call=>call.command==='chat.send').length,0,'and sends nothing');
});

// Spec: MUS-SPEC-01-401B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-401b)
await check('clicking the suggestion fills the composer, and a modifier-click sends it',async()=>{
  await clear();await until(()=>ghost());
  click(ghost());
  await until(()=>draft()==='Run the tests again');
  assert.equal(draft(),'Run the tests again','a click fills the composer');
  assert.equal(calls.filter(call=>call.command==='chat.send').length,0,'a click sends nothing');
  await clear();await until(()=>ghost());
  click(ghost(),{metaKey:true,ctrlKey:true});
  await until(()=>calls.some(call=>call.command==='chat.send'));
  const sent=calls.filter(call=>call.command==='chat.send');
  assert.equal(sent.length,1,'a modifier-click sends one message');
  assert.equal(sent[0]!.input.text,'Run the tests again','and that message is the suggestion');
});

// Spec: MUS-SPEC-01-401C (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-401c)
await check('the suggestion hides once you type and while a turn runs',async()=>{
  await until(()=>!store.getState().sending.one);await clear();await until(()=>ghost());
  assert.ok(ghost(),'shown again on an empty composer');
  store.setComposerDraft('one','w');await delay(60);
  assert.equal(ghost(),null,'gone once anything is typed');
  await clear();
  chats=[mk('one',{status:'running'})];for(const fn of listeners)fn({type:'snapshot',snapshot:snapshot()});await delay(120);
  assert.equal(store.activeChat()?.status,'running','the chat is running');
  assert.equal(ghost(),null,'not shown while a turn runs');
});

const transcript=[
  {id:'m1',chatId:'two',kind:'user',text:'one',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'gpt-5.5',effort:'medium'}}},
  {id:'m2',chatId:'two',kind:'user',text:'two',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'gpt-5.5',effort:'medium'}}},
  {id:'m3',chatId:'two',kind:'user',text:'three',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'gpt-5.5',effort:'high'}}},
  {id:'m4',chatId:'two',kind:'user',text:'four',createdAt:at,data:{ranWith:{providerId:'hybrow',model:'fable-5',effort:'high'}}},
  {id:'m5',chatId:'two',kind:'user',text:'five',createdAt:at},
] as any[];
const second=createRoot(document.getElementById('transcript')!,{onUncaughtError:error=>(errors as unknown[]).push(error)});
second.render(<Timeline chatId="two" items={transcript} running={false}/>);
await until(()=>document.querySelector('#transcript [data-item-id="m5"]'));
// Spec: MUS-SPEC-01-401D (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-401d)
await check('a divider marks the message where the model or effort changed',async()=>{
  const markerAbove=(id:string)=>{const row=document.querySelector(`#transcript [data-item-id="${id}"]`)!;const holder=row.closest('[data-index]')??row.parentElement!;return holder.querySelector('[data-testid="model-divider"]')?.textContent??null;};
  assert.equal(document.querySelectorAll('#transcript [data-testid="model-divider"]').length,2,'two changes, two dividers');
  assert.equal(markerAbove('m3'),'Switched to GPT-5.5 · high effort');
  assert.equal(markerAbove('m4'),'Switched to Fable 5 · high effort');
  for(const id of ['m1','m2','m5'])assert.equal(markerAbove(id),null,`no divider above ${id}`);
  assert.ok(document.querySelector('#transcript [data-testid="model-divider"]')!.classList.contains('day-divider'),'it uses the day divider style');
});
assert.deepEqual(errors,[]);
process.exit(0);
