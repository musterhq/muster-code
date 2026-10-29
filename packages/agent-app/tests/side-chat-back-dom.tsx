/** Bundled and run by scripts/test-renderer.mjs. The side chat tab has a way back to the conversation it was opened from. */
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
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.getAttribute('aria-label')??this.className);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const at=new Date().toISOString();
const mk=(id:string,extra:Record<string,unknown>={})=>({id,title:id,folderId:'folder',status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow',...extra});
// "main" is the conversation the side chats were opened from.
let chats:Record<string,unknown>[]=[mk('main',{title:'Main conversation'}),mk('side1',{title:'About a.ts'}),mk('side2',{title:'About b.ts'}),mk('side3',{title:'About c.ts'})];
const binding={kind:'file',folderId:'folder',path:'a.ts'};
const sideChats=[
  {chatId:'side1',parentChatId:'main',binding,label:'a.ts',createdAt:at},
  {chatId:'side2',binding,label:'b.ts',createdAt:at},
  {chatId:'side3',parentChatId:'deleted-chat',binding,label:'c.ts',createdAt:at},
];
window.muster={subscribe(){return()=>{};},async invoke(command:string,_input:unknown){
  if(command==='app.snapshot')return JSON.parse(JSON.stringify({version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'main'}));
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='artifacts.sideChat.list')return {sideChats};
  if(command==='providers.list')return [];
  return undefined;
}};
// Dynamic imports: the app modules must load after the linkedom globals above exist.
const {createRoot}=await import('react-dom/client');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:false});
const store=await import('../src/renderer/store'),{ensureArtifactSync}=await import('../src/renderer/artifacts');
const {SideChatTab}=await import('../src/renderer/components/SideChatTab');
const React=await import('react');
const tabFor=(chatId:string)=>({id:`sidechat:${chatId}`,kind:'sideChat' as const,chatId,title:`Side ${chatId}`});
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();ensureArtifactSync();await delay(60);
const button=(label:string)=>document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

// A stateful stand-in for the resource pane: it owns the maximize toggle exactly as ResourcePane does, and the
// conversation's composer sits beside it.
function Pane({chatId}:{chatId:string}){
  const [maximized,setMaximized]=React.useState(true);
  return <div data-maximized={maximized}><textarea aria-label="Message"/><SideChatTab tab={tabFor(chatId)} onToggleResourceMaximize={()=>setMaximized(value=>!value)} resourceMaximized={maximized}/></div>;
}

// Spec: MUS-SPEC-21-43A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-43a)
await check('Back to chat opens the parent conversation and keeps the side chat tab',async()=>{
  await store.selectChat('side3');// a conversation that is not the parent is in front
  root.render(<Pane chatId="side1"/>);await delay(60);
  assert.equal(store.getState().activeChatId,'side3');
  assert.equal(document.querySelector('[data-maximized]')!.getAttribute('data-maximized'),'true','the pane covers the conversation');
  const back=button('Back to chat');
  assert.ok(back,'the side chat header offers Back to chat');
  back!.click();await delay(80);
  assert.equal(store.getState().activeChatId,'main','the parent conversation is now the active chat');
  assert.equal(store.getState().screen,'work');
  assert.equal(document.querySelector('[data-maximized]')!.getAttribute('data-maximized'),'false','the pane is restored so the conversation shows');
  assert.ok(focused.includes('Message'),'the conversation composer takes focus');
  assert.ok(document.querySelector('.side-chat'),'the side chat is still showing');
});

// Spec: MUS-SPEC-21-43B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-43b)
await check('No Back to chat control without a parent conversation',async()=>{
  for(const id of ['side2','side3']){
    root.render(<Pane chatId={id}/>);await delay(60);
    assert.ok(document.querySelector('.side-chat'),`${id} renders`);
    assert.equal(button('Back to chat'),null,`${id} has no way back to a parent that does not exist`);
    assert.ok(button('Open the resource')&&button('Promote to a full chat')&&button('Discard side chat'),`${id} keeps its other controls`);
  }
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('side-chat-back-dom: ok');
process.exit(0);
