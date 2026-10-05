// DOM checks for #305: every output of a server project opens on this Mac (fetched into the cache and shown in Muster's viewer, or the
// same file from the Work locally folder), with Download and Open on server; pull requests and local projects behave as before.
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'}),URL:Object.assign(URL,{createObjectURL:()=>'blob:x',revokeObjectURL(){}})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
(window as any).open=()=>null;

const now=new Date().toISOString();
const calls:{command:string;input:any}[]=[];
const last=(command:string)=>calls.filter(c=>c.command===command).at(-1);
const count=(command:string)=>calls.filter(c=>c.command===command).length;
const issue={id:'i-1',identifier:'RAG-1',title:'Remediate'};
const ref=(source:string,extra:object={})=>({source,issueId:'i-1',issueKey:'RAG-1',contentType:null,href:'https://pc.example.com/RAG/issues/RAG-1#x',downloadable:false,...extra});
const serverRows:any[]=[
  {id:'document:d1',title:'Launch plan',detail:'RAG-1 · document',status:'document',at:now,source:'paperclip',projectId:'p-srv',taskId:'i-1',output:ref('document',{documentKey:'plan',contentType:'text/markdown',href:'https://pc.example.com/RAG/issues/RAG-1#document-plan',downloadable:true})},
  {id:'attachment:a1',title:'report.pdf',detail:'RAG-1 · file',status:'attachment',at:now,source:'paperclip',projectId:'p-srv',taskId:'i-1',output:ref('attachment',{contentPath:'/api/attachments/a1/content',downloadable:true})},
  {id:'work_product:w1',title:'notes.md',detail:'RAG-1',status:'work_product',at:now,source:'paperclip',projectId:'p-srv',taskId:'i-1',output:ref('work_product',{openPath:'/srv/ws/docs/notes.md'})},
  {id:'work_product:w2',title:'Fix login',detail:'RAG-1',status:'work_product',at:now,source:'paperclip',projectId:'p-srv',taskId:'i-1',output:ref('work_product',{openPath:'https://github.com/acme/widgets/pull/3'})},
  {id:'file:p:docs/plan.md',title:'plan.md',detail:'P · CTO · docs/plan.md',status:'added',at:now,source:'local',projectId:'p',path:'docs/plan.md',taskId:'t1',agent:'CTO'},
];
const behaviour:{fetch:(input:any)=>Promise<any>}={fetch:async()=>({kind:'cached',id:'x',name:'Launch plan.md',path:'/data/server-outputs/a/b/Launch plan.md',mime:'text/markdown',size:18})};
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'paperclip.list':return {kind:'artifacts',rows:serverRows,note:''};
  case 'paperclip.output.fetch':return behaviour.fetch(input);
  case 'paperclip.output.preview':return {kind:'text',name:'Launch plan.md',mime:'text/markdown',size:18,text:'# Launch\n\nShip it.\n'};
  case 'paperclip.output.save':return {saved:true,fileName:'Launch plan.md'};
  case 'work.outputs.state':return {states:{},seenAt:null,pullRequests:[{id:'pr:L1',title:'Fix login (PR)',detail:'acme/widgets#12 · open',url:'https://github.com/acme/widgets/pull/12',taskId:'t1',state:'open',at:now}]};
  case 'files.read':return {path:input.path,text:'local text',truncated:false};
  case 'link.open':return undefined;
  case 'app.snapshot':return {folders:[{id:'f1',name:'repo',path:'/repo'},{id:'fb',name:'bound',path:'/bound'}],chats:[],projects:[{id:'p',name:'P',goal:'',folderIds:['f1'],primaryFolderId:'f1'}],version:1};
  default:return {};
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
await store.boot();
const {OutputsPanel}=await import('../src/renderer/components/WorkOutputs');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=()=>document.body.textContent??'';
let inflight=0;const realInvoke=window.muster.invoke.bind(window.muster);window.muster.invoke=async(command:string,input:any)=>{inflight++;try{return await realInvoke(command,input);}finally{inflight--;}};
const quiet=async()=>{let before='',still=0;for(let i=0;i<75&&still<3;i++){await delay(40);const now=document.body.textContent??'';still=inflight===0&&now===before?still+1:0;before=now;}};
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(ms);await quiet();};
const byLabel=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.getAttribute('aria-label')??'')||label.test(b.textContent??''));
const show=async(node:React.ReactNode,ms=60)=>{root.render(<>{node}</>);await delay(ms);await quiet();};
const nav={onOpenTask(){},onOpenAgent(){},onOpenChat(){}};
const snap:any={paperclip:null,tasks:[{id:'i-1',key:'RAG-1',title:'Remediate',status:'todo'}],agents:[],projects:[],goals:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:'1'};
const title=(name:string)=>[...document.querySelectorAll('.work-output-open')].find(b=>b.textContent===name);

// A server project: every output title is a button (it was plain text before), and the row has Download and Open on server.
await show(<OutputsPanel snapshot={snap} projectId="p-srv" local={false} nav={nav}/>,200);
for(const name of ['Launch plan','report.pdf','notes.md','Fix login'])assert.ok(title(name),`${name} is openable`);
assert.ok(byLabel(/^Download Launch plan$/)&&byLabel(/^Download report\.pdf$/),'documents and attachments download');
assert.equal(byLabel(/^Download Fix login$/),undefined,'a web link has nothing to download');assert.ok(byLabel(/^Download notes\.md$/),'a workspace file work product offers Download (it says so if the server has no copy)');
assert.ok(byLabel(/^Open notes\.md on server$/),'every row links to the server');
assert.ok(!/plan\.md/.test(text().replace('notes.md','')),'a local project\'s row is not listed in a server project');

// Opening shows a spinner while the server answers, then Muster's viewer with the downloaded text.
let release:(v:any)=>void=()=>{};
behaviour.fetch=()=>new Promise(resolve=>{release=resolve;});
await click(title('Launch plan'),40);
assert.deepEqual(last('paperclip.output.fetch')!.input,{id:'document:d1',projectId:'p-srv'});
assert.ok(document.querySelector('.work-output-spinner'),'a spinner shows while it loads');
release({kind:'cached',id:'document:d1',name:'Launch plan.md',path:'/data/server-outputs/a/b/Launch plan.md',mime:'text/markdown',size:18});
await delay(60);await quiet();
assert.ok(!document.querySelector('.work-output-spinner'),'the spinner goes');
assert.match(text(),/# Launch/);assert.match(text(),/Ship it\./);assert.match(text(),/Read-only copy from the server/);
assert.deepEqual(last('paperclip.output.preview')!.input,{path:'/data/server-outputs/a/b/Launch plan.md'});
await click(document.querySelector('[aria-label="Open Launch plan on server"]'));
assert.deepEqual(last('link.open')!.input,{url:'https://pc.example.com/RAG/issues/RAG-1#document-plan'});
await click(document.querySelector('[aria-label="Close"]'),80);
assert.ok(!/Ship it\./.test(text()),'the viewer closes');

// Download… asks main to save (main shows the dialog and writes the file).
await click(byLabel(/^Download report\.pdf$/));
assert.deepEqual(last('paperclip.output.save')!.input,{id:'attachment:a1',projectId:'p-srv'});

// The server refuses: an honest sentence on the row, no command label, nothing opens.
behaviour.fetch=async()=>{throw new Error("paperclip.output.fetch: Error invoking remote method 'muster:invoke': Error: The server will not let you open this output (403). You may not have access to its task.");};
await click(title('report.pdf'));
const alert=document.querySelector('.work-output-error[role=alert]');
assert.ok(alert);assert.equal(alert!.textContent,'The server will not let you open this output (403). You may not have access to its task.');

// A work product that is a web address opens as a link; one in the Work locally folder opens the local file in Muster's own viewer.
behaviour.fetch=async()=>({kind:'link',id:'work_product:w2',name:'Fix login',path:'',mime:'text/uri-list',size:0,url:'https://github.com/acme/widgets/pull/3'});
await click(title('Fix login'));assert.deepEqual(last('link.open')!.input,{url:'https://github.com/acme/widgets/pull/3'});
behaviour.fetch=async()=>({kind:'local',id:'work_product:w1',name:'notes.md',path:'/bound/docs/notes.md',mime:'text/markdown',size:10,folderPath:'/bound',relPath:'docs/notes.md'});
const before=count('files.read');
await click(title('notes.md'),80);
assert.deepEqual(last('paperclip.output.fetch')!.input,{id:'work_product:w1',projectId:'p-srv'});
assert.deepEqual(last('files.read')!.input,{folderId:'fb',path:'docs/notes.md'});assert.equal(count('files.read'),before+1,'the local file opens through the normal file viewer');
assert.equal(count('folder.add'),0,'the bound folder was already known');

// A local Muster project is unchanged: its file opens from its own folder, the pull request opens on GitHub, and no server fetch happens.
const fetches=count('paperclip.output.fetch');
await show(<OutputsPanel snapshot={snap} projectId="p" local nav={nav}/>,200);
assert.ok(title('plan.md')&&title('Fix login (PR)'));assert.equal(title('Launch plan'),undefined);
await click(title('plan.md'),80);assert.deepEqual(last('files.read')!.input,{folderId:'f1',path:'docs/plan.md'});
await click(title('Fix login (PR)'));assert.deepEqual(last('link.open')!.input,{url:'https://github.com/acme/widgets/pull/12'});
assert.equal(count('paperclip.output.fetch'),fetches,'no server fetch for a local project');
assert.equal(byLabel(/^Open plan\.md on server$/),undefined);
assert.deepEqual(errors,[],'no React errors');
root.unmount();
