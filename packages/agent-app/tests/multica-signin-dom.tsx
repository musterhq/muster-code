// Settings › Integrations, signing in to a Multica server on its own page (#894): Connect on a Multica address starts the browser sign-in and
// opens the sign-in window on Multica's /login, Connect stays the primary action, the token path stays under Other ways to connect, a failed
// sign-in shows Multica's words and opens the token path, and success closes the window. linkedom DOM, the real ServerList and
// ConnectionPanel, a stubbed bridge; no network, no Electron.
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
// linkedom does not track focus: record the element focus() was last called on.
let focused:Element|null=null;
(window.HTMLElement.prototype as any).focus=function(){focused=this;};
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
const LOGIN=`${ORIGIN}/login?cli_callback=${encodeURIComponent('http://127.0.0.1:53111/callback')}&cli_state=${'a'.repeat(32)}`;
const FAILED='Multica at projects.acme.example could not give Muster a token: 404 page not found. This Multica server may be too old to sign in from Muster. In Multica, create a personal access token (it starts with mul_) and paste it under Other ways to connect.';
const calls:{command:string;input:any}[]=[];
let listeners:((event:any)=>void)[]=[];
let status:any={phase:'idle'};
const config={mode:'off',baseUrl:'http://127.0.0.1:3100',hasToken:false,secureStorage:true,companyId:null,backend:null,compatibility:null,user:null,signedIn:null,signInNotice:null,serverVersion:null,connectedAt:null,signIn:[]};
(window as any).muster={subscribe(listener:(event:any)=>void){listeners.push(listener);return()=>{listeners=listeners.filter(l=>l!==listener);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='musterServer.list')return {servers:[],secureStorage:true};
  if(command==='musterServer.check')return {servers:[]};
  if(command==='musterServer.projects')return {projects:[],errors:[]};
  if(command==='paperclip.config.get')return config;
  if(command==='paperclip.signin.status')return status;
  if(command==='paperclip.signin.start'){status={phase:'waiting',baseUrl:ORIGIN,approvalUrl:LOGIN,expiresAt:new Date(Date.now()+300_000).toISOString()};return status;}
  if(command==='paperclip.signin.cancel'){status={phase:'cancelled',baseUrl:ORIGIN,message:'Sign-in cancelled.'};return status;}
  if(command==='musterServer.signInWindow')return {opened:!input.close};
  if(command==='paperclip.test'){
    if(input.mode==='local')return {ok:false,stage:'network',message:'No server is answering.'};
    return {ok:false,stage:'auth',backend:'multica',compatibility:'Multica',signIn:['browser'],message:NEEDS_TOKEN,baseUrl:ORIGIN};
  }
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  if(command==='orgs.list')return {connected:false,server:null,me:null,orgs:[]};
  if(command==='checkout.bindings')return {bindings:[],orgs:[]};
  return undefined;
}};
const changed=async(next:any)=>{status=next;await act(async()=>{for(const l of [...listeners])l({type:'projectsWorkspaceChanged',scopes:['config'],taskIds:[]});await delay(30);});await settle();};

const {ServerList}=await import('../src/renderer/components/settings/ServerList');
const host=document.getElementById('root')!;
const root=createRoot(host);
await act(async()=>{root.render(<ServerList/>);await delay(80);});
await settle(120);

// Spec: MUS-SPEC-13-894G (docs/spec/clauses/13-muster-server.md#mus-spec-13-894g)
await check('Connect on a Multica address opens Multica’s sign-in page in the window, and a failed sign-in points to the token path', async()=>{
  assert.equal(button(/^Connect$/)!.className.includes('secondary'),false,'Connect is the primary action');
  assert.match(text(host.querySelectorAll('.ws-connect-steps li')[1]),/^Your server’s own sign-in page opens in a window/,'the steps say to sign in on your server’s page');
  assert.ok(host.querySelector('details.ws-connection-more input[type=password]'),'the token path stays under Other ways to connect');
  await type(host.querySelector('input[type=url]'),new URL(ORIGIN).host);
  await click(button(/^Connect$/));
  const started=calls.find(c=>c.command==='paperclip.signin.start');
  assert.ok(started,'the browser sign-in is started');
  assert.equal(started!.input.baseUrl,ORIGIN);
  const opened=calls.find(c=>c.command==='musterServer.signInWindow'&&!c.input.close);
  assert.deepEqual(opened?.input,{url:LOGIN,baseUrl:ORIGIN},'the sign-in window opens on Multica’s own page');
  assert.match(text(host),/Your Multica sign-in page is open in a window\. Sign in there; Muster never sees your password\./);
  assert.equal(text(host).includes('press Approve'),false,'Multica has no Approve step');
  assert.ok(button(/^Cancel$/),'Cancel is offered while waiting');
  assert.equal(text(host).includes(NEEDS_TOKEN),false,'the token instruction is not shown when the sign-in can run');
  await changed({phase:'failed',baseUrl:ORIGIN,message:FAILED});
  assert.equal(text(host.querySelector('[role=alert]')),FAILED,'Multica’s words, and the way out');
  assert.ok((host.querySelector('details.ws-connection-more') as any)?.hasAttribute('open'),'Other ways to connect opens');
  assert.ok(host.querySelector('input[type=password]'),'with the token field');
  calls.length=0;
  await click(button(/^Connect$/));
  assert.ok(calls.some(c=>c.command==='musterServer.signInWindow'&&!c.input.close),'Connect tries again');
  await changed({phase:'signed-in',baseUrl:ORIGIN,user:{name:'Dana Founder',email:'dana@acme.example'}});
  const closed=calls.find(c=>c.command==='musterServer.signInWindow'&&c.input.close);
  assert.deepEqual(closed?.input,{baseUrl:ORIGIN,close:true},'success closes the sign-in window');
});

await act(async()=>{root.unmount();});
console.log('multica-signin-dom: ok');
process.exit(0);
