/** #446: each org in the sidebar reaches that org's full Tasks board, Dashboard and Roster (switching the org first), and My work shows the last copy at once
 *  while the slow read refreshes it. Assert on text and booleans only, never on DOM nodes. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const store=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  localStorage:{getItem:(k:string)=>store.get(k)??null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
  ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'})});
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});
setTimeout(()=>{console.error('org-sidebar-pages-dom: timed out');process.exit(4);},60_000);
const iso=(h:number)=>new Date(Date.now()-h*3_600_000).toISOString();
const work={connected:true,me:{id:'u-me',name:'Me'},fetchedAt:iso(0),orgs:[
  {org:{id:'rag',name:'Ragnar',prefix:'RAG',server:'srv'},sidebar:'mine',open:1,tasks:[{id:'rag-1',key:'RAG-1',title:'Mine',status:'todo',priority:'medium',orgId:'rag',orgName:'Ragnar',projectId:'p',projectName:'P',createdAt:iso(2),updatedAt:iso(1),why:'mine',assignee:null,checkout:null}],projects:[],inbox:[]},
  {org:{id:'hyb',name:'Hybrow',prefix:'HYB',server:'srv'},sidebar:'mine',open:0,tasks:[],projects:[],inbox:[]},
]};
const calls:{command:string;input:any}[]=[];
let releaseWork:(()=>void)|null=null;
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){calls.push({command,input});
  switch(command){
    case 'orgs.work':if(releaseWork===null)return work;await new Promise<void>(r=>{releaseWork=r;});return work;
    case 'orgs.open':return {ok:true};
    case 'paperclip.snapshot':return {fetchedAt:iso(0),tasks:[],agents:[],projects:[],runs:[],inbox:[],paperclip:{company:{id:input?.x??'rag',name:'Ragnar',prefix:'RAG'}}};
    default:return undefined;
  }}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {OrgSidebar}=await import('../src/renderer/components/OrgSidebar');
const {hubRoute}=await import('../src/renderer/hubStore');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const until=async(ok:()=>unknown,ms=3000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);return Boolean(ok());};
const text=(sel:string)=>[...document.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));};
const byText=(sel:string,t:string)=>[...document.querySelectorAll(sel)].find(e=>e.textContent?.trim()===t);

root.render(<OrgSidebar/>);
assert.ok(await until(()=>document.querySelectorAll('.org-toggle').length===2),'two orgs');
click(document.querySelectorAll('.org-toggle')[1]);// open Hybrow, an org that is not the active one
assert.ok(await until(()=>document.querySelector('.org-body')),'the org opens');
assert.deepEqual(text('.org-body .org-page').map(s=>s.replace(/\s+/g,' ')),['All tasks','Dashboard','Roster'],'every org reaches its full board, Dashboard and Roster');
click(byText('.org-body .org-page','All tasks'));
assert.ok(await until(()=>hubRoute().page==='tasks'),'All tasks opens the Tasks page');
const opened=calls.filter(c=>c.command==='orgs.open').map(c=>c.input.companyId);
assert.deepEqual(opened,['hyb'],'the org is made active first');
assert.ok(calls.findIndex(c=>c.command==='orgs.open')<calls.findIndex(c=>c.command==='paperclip.snapshot'),'and the pages re-read for it');
assert.equal(JSON.parse(store.get('muster.tasks.view.all')??'{}').layout,'board','in board view');
click(byText('.org-body .org-page','Dashboard'));
assert.ok(await until(()=>hubRoute().page==='dashboard'),'Dashboard opens the Dashboard');
assert.deepEqual(errors,[]);

// My work from the last copy: a fresh mount shows the cached orgs at once while the slow read is still running.
root.render(<React.Fragment key="again"><div/></React.Fragment>);await delay(20);
const {resetMyWorkForTests}=await import('../src/renderer/orgStore');
resetMyWorkForTests();
releaseWork=()=>{};// the next orgs.work read hangs until released
root.render(<React.Fragment key="third"><OrgSidebar/></React.Fragment>);
assert.ok(await until(()=>document.querySelectorAll('.org-toggle').length===2,500),'the last copy shows before the slow read answers');
releaseWork?.();
assert.deepEqual(errors,[]);
console.log('org-sidebar-pages-dom: ok');
process.exit(0);
