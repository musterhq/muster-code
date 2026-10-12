import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;// React only wires native input events when the document advertises them.
const saved=new Map<string,string>(),scrolls:string[]=[];
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',paddingTop:'0px',paddingBottom:'0px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:224,height:30,left:0,top:0,right:224,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){scrolls.push(this.dataset.chatId);};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
const focused:string[]=[];window.HTMLElement.prototype.focus=function(){focused.push(this.closest('[data-chat-id]')?.dataset.chatId??this.className);};
// SketchPad's canvas, for the draft's + → Sketch check: linkedom has no real 2D context or toBlob (see composer-components.tsx).
window.HTMLCanvasElement.prototype.getContext=()=>null;
(window.HTMLCanvasElement.prototype as any).toBlob=function(callback:(blob:Blob|null)=>void){callback(new Blob(['sketch'],{type:'image/png'}));};
const pointer=async(element:Element,type:string,props:Record<string,unknown>={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{button:0,pointerId:1,clientX:0,clientY:0,...props});element.dispatchEvent(event);await delay(20);};
// Sections, rows, disambiguation and header, against a fixture with a running chat inside a collapsed folder.
const NOW=Date.now(),ago=(ms:number)=>new Date(NOW-ms).toISOString(),DAY=86400_000;
const base={pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',status:'completed',updatedAt:ago(DAY*10)};
let chats:any[]=[
  {...base,id:'run',title:'Build the importer',folderId:'f1',status:'running',updatedAt:ago(20_000),providerId:'claude-code'},
  {...base,id:'pin',title:'Pinned thing',folderId:'f1',pinned:true,pinOrder:0,updatedAt:ago(3600_000),providerId:'openai-direct'},
  {...base,id:'unseen',title:'Fresh result',folderId:'f2',unread:true,updatedAt:ago(120_000)},
  {...base,id:'dupA',title:'ossmgr UI',folderId:'f1',updatedAt:ago(DAY*8)},
  {...base,id:'dupB',title:'ossmgr UI',folderId:'f2',updatedAt:ago(DAY*8)},
  ...Array.from({length:12},(_,index)=>({...base,id:`old${index}`,title:`Old ${index}`,updatedAt:ago(DAY*(20+index))})),
];
const folders=[{id:'f1',name:'redis-automation',path:'/Users/me/work/redis-automation'},{id:'f2',name:'redis-automation',path:'/Users/me/play/redis-automation'}];
const snapshot=()=>({version:1,chats,folders,projects:[],activeChatId:'pin'});
const listeners=new Set<(event:any)=>void>();
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='git.status')return {branch:input.folderId==='f1'?'dev':'main',detached:false,unborn:false,revision:'r',files:[],truncated:false,stagedCount:0,conflicted:false};
  if(command==='git.pullRequests')return {available:true,items:input.folderId==='f1'?[{number:1,title:'a',url:'u',state:'OPEN',headRefName:'dev',isDraft:false},{number:2,title:'b',url:'u',state:'OPEN',headRefName:'dev',isDraft:false},{number:3,title:'c',url:'u',state:'MERGED',headRefName:'dev',isDraft:false}]:[]};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='providers.list')return [];
  if(command==='processes.summary')return {revision:1,sessions:[]};
  if(command==='checkout.leases')return {leases:[]};
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store'),{Sidebar}=await import('../src/renderer/components/Sidebar');
const {WorkControls}=await import('../src/renderer/components/WorkControls');
const live=await import('../src/renderer/components/SidebarLive');
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Sidebar/>);await delay(400);
assert.deepEqual(errors,[]);
const titles=()=>Array.from(document.querySelector('.nav-scroll')!.children).map(el=>el.getAttribute('aria-label')??el.querySelector('.nav-section-title')?.textContent);
const text=(selector:string)=>document.querySelector(selector)?.textContent??'';

// Sections: Working, Pinned, folders, then Active and Settled for folderless chats.
assert.deepEqual(titles().slice(0,2),['Working','Pinned'],'running chats lead, then pins: '+JSON.stringify(titles()));
assert.ok(document.querySelector('.nav-working [data-chat-id="run"]'),'a running chat is listed under Working');
assert.equal(document.querySelectorAll('[data-chat-id="run"]').length,1,'and nowhere else');
// Collapse the folder that owns it: the running chat stays visible.
const folderHead=Array.from(document.querySelectorAll<HTMLElement>('.nav-section-head')).find(head=>head.textContent?.includes('redis-automation'))!;
(folderHead.querySelector('.nav-disclosure') as HTMLElement).click();await delay(60);
assert.ok(document.querySelector('[data-chat-id="run"]'),'a running chat stays visible when its folder is collapsed');

// Live timer: written through a ref by one shared ticker; the row does not re-render.
const timer=document.querySelector('[data-chat-id="run"] .chat-row-elapsed') as HTMLElement;
assert.match(timer.textContent??'',/^(19|20|21)s$/,'Working shows the live elapsed time: '+timer.textContent);
const before=timer.textContent;await delay(2100);
assert.notEqual(timer.textContent,before,'the elapsed text advances by itself');
assert.ok(timer.isConnected&&timer===document.querySelector('[data-chat-id="run"] .chat-row-elapsed'),'through the same node (no re-render)');
assert.equal(live.liveTimerCount(),1);

// Rows: chip, branch, PR count, provider icon, unseen dot, age and status.
const pin=document.querySelector('[data-chat-id="pin"]')!;
assert.equal(pin.querySelector('.chat-row-chip')?.textContent,'redis-automation','project/folder chip');
assert.equal(pin.querySelector('.chat-row-branch')?.textContent,'dev','branch');
assert.equal(pin.querySelector('.chat-row-prs')?.textContent,'2','open PRs for the branch only');
assert.ok(pin.querySelector('.chat-row-provider svg'),'provider icon');
assert.ok(pin.querySelector('.chat-row-age'),'age');
assert.ok(document.querySelector('[data-chat-id="unseen"] .status-unread-dot'),'unseen-completion dot');
assert.match(text('[data-chat-id="run"] .chat-row-working'),/Working/,'status');

// Disambiguation: same folder names and same chat names carry a hint.
const hints=Array.from(document.querySelectorAll('.nav-section-hint')).map(el=>el.textContent);
assert.deepEqual(hints.sort(),['me/play','me/work'],'identical folder names show their parent path');
(folderHead.querySelector('.nav-disclosure') as HTMLElement).click();await delay(60);
const dupHints=['dupA','dupB'].map(id=>document.querySelector(`[data-chat-id="${id}"] .chat-row-hint`)?.textContent);
assert.ok(dupHints.every(Boolean)&&dupHints[0]!==dupHints[1],'identical chat names are told apart: '+JSON.stringify(dupHints));

// Settled: ten shown, then Show more.
const settledIds=()=>Array.from(document.querySelectorAll('.nav-settled [data-chat-id]')).map(el=>(el as HTMLElement).dataset.chatId);
assert.equal(settledIds().length,10,'ten settled chats show first');
const more=document.querySelector('.nav-show-more') as HTMLElement;
assert.match(more.textContent??'',/Show more \(2\)/);
more.click();await delay(60);
assert.equal(settledIds().length,12);assert.ok(!document.querySelector('.nav-show-more'));

// Header: three primary actions plus the overflow menu.
root.render(<div className="center"><WorkControls/></div>);await delay(80);
const labels=Array.from(document.querySelectorAll('.work-controls > .tip, .work-controls > button, .work-controls button')).map(button=>button.getAttribute('aria-label')).filter(Boolean);
assert.ok(labels.filter(label=>label!=='Conversation actions').length<=3+0,'at most three primary icons besides the overflow: '+JSON.stringify(labels));
assert.ok(labels.includes('Conversation actions'),'one overflow menu');
assert.ok(!labels.includes('Fork conversation')&&!labels.includes('Copy local chat link'),'fork and copy link moved into the overflow');
root.unmount();
console.log('Sidebar sections passed: working, pinned, settled paging, row details, disambiguation, header actions.');
process.exit(0);
