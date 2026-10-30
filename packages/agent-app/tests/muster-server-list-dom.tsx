// Settings › Integrations holds several Muster Servers in one list (#803): a row per server with its name, URL, signed-in account and status,
// Rename / Re-authenticate / Disconnect / Remove on each, an unreachable server's own error and Retry, and Add server opening the add flow.
// linkedom DOM, stubbed bridge; no network, no Electron.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
// Base UI's focus manager checks `instanceof KeyboardEvent` (and friends), which linkedom does not define.
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:()=>null,setItem:()=>undefined,removeItem:()=>undefined},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',userAgent:'linkedom',clipboard:{writeText:async()=>undefined}}});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=await import('react');
const settle=async(ms=60)=>{await act(async()=>{await delay(ms);});};
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const click=async(el:Element|undefined|null)=>{assert.ok(el,'click target');await act(async()=>{(el as HTMLElement).click();await delay(30);});};
const type=async(el:Element|null,value:string)=>{assert.ok(el,'input');let proto=Object.getPrototypeOf(el),descriptor:PropertyDescriptor|undefined;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);await act(async()=>{descriptor!.set!.call(el,value);el!.dispatchEvent(new window.Event('input',{bubbles:true}));el!.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(10);});};
const byText=(root:Element,selector:string,t:string)=>[...root.querySelectorAll(selector)].find(e=>text(e)===t||text(e).includes(t));
/** Row actions live in the row's "…" menu: open it and press one. */
const menuAction=async(r:Element|undefined,label:string)=>{
  assert.ok(r,'row');
  await click(r.querySelector('[aria-label^="Actions for"]'));await settle(40);
  const item=[...document.querySelectorAll('[role=menuitem]')].find(i=>text(i)===label);
  assert.ok(item,`menu item ${label}`);
  await click(item);await settle();
};
const menuLabels=async(r:Element)=>{
  await click(r.querySelector('[aria-label^="Actions for"]'));await settle(40);
  const labels=[...document.querySelectorAll('[role=menuitem]')].map(i=>text(i));
  await act(async()=>{document.dispatchEvent(new (window as any).KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay(30);});
  await act(async()=>{(document.activeElement as HTMLElement|null)?.dispatchEvent(new (window as any).KeyboardEvent('keydown',{key:'Escape',bubbles:true}));await delay(30);});
  return labels;
};

const entry=(id:string,name:string,url:string,extra:Record<string,unknown>={})=>({id,name,url,kind:'muster-server',account:null,state:'online',error:null,checkedAt:null,serverVersion:'0.3.0',connectedAt:null,workspace:false,...extra});
let servers:any[]=[
  entry('s1','Alpha HQ','https://alpha.example.com',{account:'Olivia Owner (@olivia)',workspace:true}),
  entry('s2','beta.example.com','https://beta.example.com',{account:'Mel Member (@mel)',state:'checking'}),
  entry('s3','gamma.example.com','https://gamma.example.com',{state:'disconnected'}),
];
const calls:{command:string;input:any}[]=[];
let listeners:Array<(e:any)=>void>=[];
const workspace={mode:'custom',baseUrl:'https://alpha.example.com',hasToken:true,secureStorage:true,companyId:'muster-server',backend:'muster-server',compatibility:null,user:{username:'olivia',displayName:'Olivia Owner',role:'owner'},signedIn:null,signInNotice:null,serverVersion:'0.3.0',connectedAt:null,signIn:['browser'],live:'poll',serverId:'s1',serverName:'Alpha HQ'};
(window as any).muster={subscribe(listener:(e:any)=>void){listeners.push(listener);return()=>{listeners=listeners.filter(l=>l!==listener);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='musterServer.list')return {servers,secureStorage:true};
  if(command==='musterServer.check'){
    // Checking all: beta cannot be reached. Retrying beta alone: it answers.
    const retry=input?.serverId==='s2';
    servers=servers.map(s=>s.id!=='s2'?s:retry?{...s,state:'online',error:null}:{...s,state:'unreachable',error:'Muster can’t reach beta.example.com. Check the address and that the server is running.'});
    return {servers};
  }
  if(command==='musterServer.projects')return {projects:[{id:'a1',name:'Support desk',goal:'',archived:false,openUrl:null,serverId:'s1',serverName:'Alpha HQ',org:null}],errors:servers.find(s=>s.id==='s2').state==='unreachable'?[{serverId:'s2',serverName:'beta.example.com',message:'unreachable'}]:[]};
  if(command==='musterServer.rename'){servers=servers.map(s=>s.id===input.serverId?{...s,name:input.name}:s);return servers.find(s=>s.id===input.serverId);}
  if(command==='musterServer.remove'){servers=servers.filter(s=>s.id!==input.serverId);return {servers};}
  if(command==='paperclip.disconnect'){servers=servers.map(s=>s.id===input.serverId?{...s,state:'disconnected',account:null}:s);return {config:workspace,revoked:false};}
  if(command==='musterServer.useForWorkspace'){servers=servers.map(s=>({...s,workspace:s.id===input.serverId}));return {servers};}
  if(command==='paperclip.config.get')return workspace;
  if(command==='paperclip.signin.status')return {phase:'idle'};
  if(command==='paperclip.test')return input.baseUrl==='http://127.0.0.1:7472'?{ok:true,stage:'ok',message:'Connected',backend:'muster-server',baseUrl:input.baseUrl,companies:[{id:'server',name:'QA Org 2',prefix:''}]}:{ok:false,stage:'network',message:'No server is answering.',baseUrl:input.baseUrl};
  if(command==='paperclip.config.set'){const added=entry('s9','QA Org 2',input.baseUrl,{account:'QA Owner 2 · API token'});servers=[...servers,added];return {...workspace,baseUrl:input.baseUrl,serverId:'s9',serverName:'QA Org 2',user:null};}
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  if(command==='orgs.list')return {orgs:[]};
  return undefined;
}};

const {ServerList}=await import('../src/renderer/components/settings/ServerList');
const host=document.getElementById('root')!;
const root=createRoot(host);
const visibleButtons=(r:Element)=>[...r.querySelector('[data-cell=actions]')!.querySelectorAll('button')].filter(b=>!b.getAttribute('aria-label')?.startsWith('Actions for')).map(b=>text(b));
const row=(name:string)=>[...host.querySelectorAll('tr[data-server-id]')].find(r=>text(r.querySelector('[data-cell=name]'))===name) as Element|undefined;

// Spec: MUS-SPEC-13-803F (docs/spec/clauses/13-muster-server.md#mus-spec-13-803f)
await check('the Integrations list shows every server with its actions, and Add server opens the add flow',async()=>{
  await act(async()=>{root.render(<ServerList signInAvailable/>);});await settle(120);
  const rows=[...host.querySelectorAll('tr[data-server-id]')];
  assert.equal(rows.length,3,'one row per server, side by side');
  assert.ok(host.querySelector('table.server-table'),'the rows use the Settings table the SSH hosts use');
  assert.deepEqual(rows.map(r=>[text(r.querySelector('[data-cell=name]')),text(r.querySelector('[data-cell=url]')),text(r.querySelector('[data-cell=account]'))]),[
    ['Alpha HQ','https://alpha.example.com','Olivia Owner (@olivia)'],['beta.example.com','https://beta.example.com','Mel Member (@mel)'],['gamma.example.com','https://gamma.example.com','Not signed in'],
  ]);
  assert.ok(calls.some(c=>c.command==='musterServer.check'&&!c.input?.serverId),'every server is checked when the list opens');
  assert.match(text(row('Alpha HQ')!.querySelector('[data-cell=status]')),/Online/);
  assert.match(text(row('gamma.example.com')!.querySelector('[data-cell=status]')),/Disconnected/);
  // The unreachable server shows its own error and a Retry; the others are untouched.
  const beta=row('beta.example.com')!;
  assert.match(text(beta.querySelector('[data-cell=status]')),/Can’t reach/);
  assert.match(text(host),/Muster can’t reach beta\.example\.com/);
  assert.equal(host.querySelectorAll('[role=alert]').length,1,'one error, on the server that failed');
  // One line per row: at most one visible button (Use for Projects, when it applies) and the rest in the row's "…" menu.
  for(const r of rows){
    const visible=[...r.querySelector('[data-cell=actions]')!.querySelectorAll('button')].filter(b=>!b.getAttribute('aria-label')?.startsWith('Actions for')).map(b=>text(b));
    assert.ok(visible.length<=1&&visible.every(v=>v==='Use for Projects'),`only Use for Projects stays visible (${visible.join(', ')})`);
    assert.ok(r.querySelector('[aria-label^="Actions for"]'),'each row has a "…" menu');
  }
  assert.deepEqual(visibleButtons(row('beta.example.com')!),['Use for Projects'],'a connected server that does not feed Projects offers Use for Projects');
  assert.deepEqual(visibleButtons(row('Alpha HQ')!),[],'the one that feeds Projects does not');
  assert.deepEqual(await menuLabels(row('Alpha HQ')!),['Rename','Re-authenticate','Disconnect','Remove'],'a connected server can be disconnected');
  assert.deepEqual(await menuLabels(row('gamma.example.com')!),['Rename','Re-authenticate','Remove'],'a disconnected one cannot be disconnected again');
  assert.match(text(host),/Projects, Roster and Inbox/,'the list says which server feeds Projects, Roster and Inbox');
  assert.match(text(host),/Support desk/,'server projects are listed under their server');
  await click(byText(beta,'button','Retry'));await settle();
  assert.deepEqual(calls.filter(c=>c.command==='musterServer.check').at(-1)!.input,{serverId:'s2'},'Retry checks only that server');
  assert.match(text(row('beta.example.com')!.querySelector('[data-cell=status]')),/Online/);
  assert.equal(host.querySelectorAll('[role=alert]').length,0);
  // Rename edits one row in place.
  await menuAction(row('beta.example.com'),'Rename');
  await type(host.querySelector('input[aria-label="Server name"]'),'Finance team');
  await click(byText(host,'button','Save name'));await settle();
  assert.deepEqual(calls.find(c=>c.command==='musterServer.rename')!.input,{serverId:'s2',name:'Finance team'});
  assert.ok(row('Finance team'),'the new name shows');
  assert.ok(row('Alpha HQ'),'the others keep theirs');
  // Disconnect and Remove act on their own row.
  await menuAction(row('Finance team'),'Disconnect');
  assert.deepEqual(calls.find(c=>c.command==='paperclip.disconnect')!.input,{serverId:'s2'});
  await menuAction(row('gamma.example.com'),'Remove');
  assert.deepEqual(calls.find(c=>c.command==='musterServer.remove')!.input,{serverId:'s3'});
  assert.equal(host.querySelectorAll('tr[data-server-id]').length,2);
  // Re-authenticate opens the add flow with that server's address, aimed at that server.
  await menuAction(row('Finance team'),'Re-authenticate');
  const address=host.querySelector('input[type=url]') as HTMLInputElement;
  assert.ok(address,'the add flow opens');assert.equal(address.value,'https://beta.example.com');
  await click(byText(host,'button','Cancel'));await settle();
  assert.equal(host.querySelector('input[type=url]'),null);
  // Add server opens the existing add flow, empty.
  await click(byText(host,'button','Add server'));await settle();
  const fresh=host.querySelector('input[type=url]') as HTMLInputElement;
  assert.ok(fresh,'Add server shows the address form');assert.equal(fresh.value,'');
  assert.match(text(host),/How connecting works/,'it is the same add flow as before');
  await type(fresh,'https://delta.example.com');
  await click(byText(host,'button','Connect'));await settle();
  assert.equal(calls.filter(c=>c.command==='paperclip.test').at(-1)!.input.baseUrl,'https://delta.example.com');
  assert.equal(host.querySelectorAll('tr[data-server-id]').length,2,'adding never replaces a server already in the list');
});

// Spec: MUS-SPEC-13-803I (docs/spec/clauses/13-muster-server.md#mus-spec-13-803i)
await check('after adding a server the status line names the server just added, and the Projects line names its own server',async()=>{
  // Still in the add flow from the check above: connect a second real server with a token.
  await type(host.querySelector('input[type=url]'),'http://127.0.0.1:7472');
  await click(byText(host,'button','Connect'));await settle(120);
  assert.equal(host.querySelector('input[type=url]'),null,'the add flow closes once the server is added');
  assert.ok(row('QA Org 2'),'the new server has its row');
  const status=[...host.querySelectorAll('[role=status]')].map(e=>text(e));
  assert.ok(status.some(t=>/^Connected to QA Org 2\b/.test(t)),`a status line names the server just added (${status.join(' | ')})`);
  assert.equal(status.some(t=>/Connected to alpha\.example\.com/.test(t)),false,'no line still says the first server is the one connected');
  assert.ok(status.some(t=>/Projects, Roster and Inbox sync from Alpha HQ/.test(t)),'the Projects line says which server it is about');
});
await act(async()=>{root.unmount();});
process.exit(0);
