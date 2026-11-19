// Settings › Integrations with a Multica server (#890): Connect on a Multica address opens the token field with Multica's own instructions
// (no sign-in window), Connect with token saves it as a Multica server, a refused token shows Multica's words, and the list marks the row
// Multica. linkedom DOM, the real ServerList and ConnectionPanel, a stubbed bridge; no network, no Electron.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
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
const click=async(el:Element|undefined|null)=>{assert.ok(el,'click target');await act(async()=>{(el as HTMLElement).click();await delay(30);});await settle();};
const type=async(el:Element|null,value:string)=>{assert.ok(el,'input');let proto=Object.getPrototypeOf(el),descriptor:PropertyDescriptor|undefined;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);await act(async()=>{descriptor!.set!.call(el,value);el!.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(20);});};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(text(b)));

const ORIGIN='https://projects.acme.example';
const NEEDS_TOKEN='Multica at projects.acme.example needs a personal access token. In Multica, create one (it starts with mul_) and paste it under Other ways to connect.';
const REFUSED='Multica at projects.acme.example did not accept this token: invalid token. Create a new personal access token in Multica and connect again.';
let servers:any[]=[];
const calls:{command:string;input:any}[]=[];
const config={mode:'off',baseUrl:'http://127.0.0.1:3100',hasToken:false,secureStorage:true,companyId:null,backend:null,compatibility:null,user:null,signedIn:null,signInNotice:null,serverVersion:null,connectedAt:null,signIn:[]};
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='musterServer.list')return {servers,secureStorage:true};
  if(command==='musterServer.check')return {servers};
  if(command==='musterServer.projects')return {projects:servers.length?[{id:'p1',name:'Website',goal:'',archived:false,openUrl:null,serverId:'s1',serverName:'Acme',org:'Acme'}]:[],errors:[]};
  if(command==='paperclip.config.get')return config;
  if(command==='paperclip.signin.status')return {phase:'idle'};
  if(command==='paperclip.test'){
    if(input.mode==='local')return {ok:false,stage:'network',message:'No server is answering.'};
    if(!input.token)return {ok:false,stage:'auth',backend:'multica',compatibility:'Multica',signIn:[],message:NEEDS_TOKEN,baseUrl:ORIGIN};
    if(input.token!=='mul_good_token_0123456789')return {ok:false,stage:'auth',backend:'multica',compatibility:'Multica',signIn:[],message:REFUSED,baseUrl:ORIGIN};
    return {ok:true,stage:'ok',backend:'multica',compatibility:'Multica',signIn:[],baseUrl:ORIGIN,companies:[{id:'ws1',name:'Acme',prefix:'ACME'}],message:'Connected to Multica. 1 workspace.'};
  }
  if(command==='paperclip.config.set'){servers=[{id:'s1',name:'Acme',url:input.baseUrl,kind:'multica',account:'Dana Founder · API token',state:'online',error:null,checkedAt:null,serverVersion:null,connectedAt:null,workspace:true,orgs:['Acme']}];return {...config,mode:'custom',baseUrl:input.baseUrl,hasToken:true,backend:'multica',compatibility:'Multica',serverId:'s1',serverName:'Acme'};}
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  if(command==='orgs.list')return {connected:false,server:null,me:null,orgs:[]};
  if(command==='checkout.bindings')return {bindings:[],orgs:[]};
  return undefined;
}};

const {ServerList}=await import('../src/renderer/components/settings/ServerList');
const host=document.getElementById('root')!;
const root=createRoot(host);
await act(async()=>{root.render(<ServerList/>);await delay(80);});
await settle(120);

// Spec: MUS-SPEC-13-890D (docs/spec/clauses/13-muster-server.md#mus-spec-13-890d)
await check('Connect on a Multica address opens the token field with Multica’s instructions and no sign-in window', async()=>{
  await type(host.querySelector('input[type=url]'),ORIGIN);
  await click(button(/^Connect$/));
  assert.equal(calls.some(c=>c.command==='paperclip.signin.start'||c.command==='musterServer.signInWindow'),false,'no browser sign-in is started for Multica');
  assert.equal(text(host.querySelector('[role=alert]')),NEEDS_TOKEN,'Multica’s own instruction, word for word');
  assert.ok((host.querySelector('details.ws-connection-more') as any)?.hasAttribute('open'),'Other ways to connect is open');
  assert.ok(host.querySelector('input[type=password]'),'the token field is on screen');
  assert.match(text(host.querySelector('details.ws-connection-more')),/personal access token that starts with mul_/);
});

// Spec: MUS-SPEC-13-890E (docs/spec/clauses/13-muster-server.md#mus-spec-13-890e)
await check('a refused Multica token shows Multica’s words; a good one adds the server, listed as Multica', async()=>{
  await type(host.querySelector('input[type=password]'),'mul_wrong');
  await click(button(/^Connect with token$/));
  assert.equal(text(host.querySelector('[role=alert]')),REFUSED,'the server’s own refusal, not a generic sentence');
  assert.equal(calls.some(c=>c.command==='paperclip.config.set'),false,'nothing is saved for a refused token');
  await type(host.querySelector('input[type=password]'),'mul_good_token_0123456789');
  await click(button(/^Connect with token$/));
  await settle(150);
  const set=calls.find(c=>c.command==='paperclip.config.set')!.input;
  assert.deepEqual({mode:set.mode,baseUrl:set.baseUrl,token:set.token,backend:set.backend,companyId:set.companyId},{mode:'custom',baseUrl:ORIGIN,token:'mul_good_token_0123456789',backend:'multica',companyId:'ws1'});
  const row=host.querySelector('tr[data-server-id="s1"]');
  assert.ok(row,'the server joins the list');
  assert.equal(text(row!.querySelector('[data-cell="name"]')),'Acme · Multica');
  assert.equal(text(row!.querySelector('[data-cell="account"]')),'Dana Founder · API token');
  assert.equal(host.textContent!.includes('mul_good_token'),false,'the token is not on screen');
});

await act(async()=>{root.unmount();});
console.log('multica-connect-dom: ok');
process.exit(0);
