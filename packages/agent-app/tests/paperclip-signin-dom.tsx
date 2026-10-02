import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
// Base UI's focus manager checks `instanceof KeyboardEvent` (and friends), which linkedom does not define.
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
const storage=new Map<string,string>();
let intervals=0;
const realSetInterval=globalThis.setInterval;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,
  localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,String(v));},removeItem:(k:string)=>{storage.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class {observe(){} unobserve(){} disconnect(){}},
  setInterval:((fn:any,ms:number)=>{intervals++;return realSetInterval(fn,ms);}) as typeof setInterval});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).getClientRects=function(){return [this.getBoundingClientRect()];};
for(const [key,value] of [['offsetHeight',800],['offsetWidth',1000],['scrollHeight',1600],['clientHeight',800],['scrollWidth',1000],['clientWidth',1000]] as const)Object.defineProperty(window.HTMLElement.prototype,key,{configurable:true,get(){return value;}});
Object.defineProperty(window.HTMLElement.prototype,'scrollTop',{configurable:true,get(){return this._top??0;},set(v){this._top=v;}});
(window.HTMLElement.prototype as any).scrollTo=function(){};
Object.defineProperty(window.document,'visibilityState',{get(){return 'visible';}});

/** Settings › Integrations › Muster Server (#285, #287): one address and one Connect. Every state, the plain-word errors, the window flow, Disconnect,
 *  the API-token path under "Other ways to connect", and the quiet Reconnect. No option cards, nobody picks a method. */
let config:any={mode:'off',baseUrl:'http://127.0.0.1:3100',hasToken:false,secureStorage:true,companyId:null,backend:null,compatibility:null,user:null,signedIn:null,signInNotice:null,serverVersion:null,connectedAt:null,signIn:[]};
let signin:any={phase:'idle'};
let localFound:any=null;
let probe:any={ok:false,stage:'service',message:'x'};
const calls:{command:string;input:any}[]=[];
let listener:((e:any)=>void)|null=null;
let startError='';
const HOSTED={ok:false,stage:'auth',backend:'paperclip',compatibility:'Paperclip-compatible',signIn:['browser'],message:'needs sign-in',baseUrl:'https://team.example.test'};
(window as any).muster={subscribe(l:any){listener=l;return()=>{listener=null;};},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='paperclip.config.get')return config;
  if(command==='paperclip.signin.status')return signin;
  if(command==='paperclip.signin.start'){if(startError)throw new Error(startError);signin={phase:'waiting',baseUrl:input.baseUrl,approvalUrl:input.baseUrl+'/cli-auth/abc?token=secret',expiresAt:new Date(Date.now()+300000).toISOString()};return signin;}
  if(command==='paperclip.signin.cancel'){signin={phase:'cancelled',baseUrl:input.baseUrl,message:'Sign-in cancelled.'};return signin;}
  if(command==='paperclip.disconnect'){config={...config,mode:'off',hasToken:false,signedIn:null,user:null,backend:null,reconnect:false,compatibility:null};return {config,revoked:true};}
  if(command==='paperclip.config.set'){config={...config,mode:input.mode,baseUrl:input.baseUrl,backend:input.backend??null,hasToken:Boolean(input.token),companyId:input.companyId??null,compatibility:input.backend==='paperclip'?'Paperclip-compatible':null,live:'socket'};return config;}
  if(command==='paperclip.test'){
    if(input.mode==='local')return localFound??{ok:false,stage:'network',message:'No server is answering on this Mac.'};
    if(input.token)return input.token==='good-token'?{ok:true,stage:'ok',backend:'muster-server',companies:[{id:'c1',name:'Acme',prefix:''}],message:'ok'}:{ok:false,stage:'auth',backend:'muster-server',message:'refused'};
    if(!input.baseUrl)return {ok:true,stage:'ok',companies:[{id:'c1',name:'MockCo',prefix:'MCK'},{id:'c2',name:'OtherCo',prefix:'OTH'}],message:'ok'};
    return probe;
  }
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  if(command==='paperclip.import.plan')return {company:{id:'c1',name:'MockCo'},companies:[],projects:[{id:'p',name:'Pipeline',repo:null,localFolder:null,taskCount:2,existing:'new'}],local:false};
  return undefined;
}};
const {createRoot}=await import('react-dom/client');
const {ConnectionPanel}=await import('../src/renderer/components/HubSetup');
const errors:unknown[]=[];
const text=(sel:string,scope:ParentNode=document)=>[...scope.querySelectorAll(sel)].map(e=>e.textContent?.trim()??'');
const click=async(el:Element|null|undefined,wait=80)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));await delay(wait);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent?.trim()??''));
const typeInto=async(el:Element,value:string)=>{const key=Object.keys(el).find(k=>k.startsWith('__reactProps'))!;Object.defineProperty(el,'value',{configurable:true,get:()=>value,set:()=>{}});(el as any)[key].onChange({target:el,currentTarget:el});await delay(60);};
const body=()=>document.body.textContent!;
const mount=async()=>{const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>{errors.push(e);},onRecoverableError:e=>{errors.push(e);}});root.render(<ConnectionPanel/>);for(let i=0;i<40&&!document.querySelector('.ws-connection');i++)await delay(40);await delay(150);return root;};
const configChanged=async()=>{(listener as any)?.({type:'projectsWorkspaceChanged',scopes:['config'],taskIds:[]});await delay(250);};

// 1. Nothing connected: one address, one primary Connect, how it works. No option cards, no method to pick.
let root=await mount();
assert.equal(document.querySelectorAll('[role=radio],.ws-segmented').length,0,'no option cards: This Mac / Sign in / URL+token / Off are gone');
assert.ok(document.querySelector('input[type=url]'),'one Server address field');
const connectBtn=()=>button(/^Connect$/);
assert.ok(connectBtn()&&!connectBtn()!.className.includes('secondary'),'Connect is the primary button');
assert.ok(connectBtn()!.hasAttribute('disabled'),'it waits for an address');
assert.deepEqual(text('.ws-connect-steps li'),['Enter your team’s server address.','Your server’s own sign-in page opens in a window. Sign in there; Muster never sees your password.','Your team’s projects, tasks and agents appear under Projects and stay up to date live.']);
assert.equal(document.querySelector('.ws-connect-steps h4')?.textContent,'How connecting works');
const more=document.querySelector('details.ws-connection-more') as any;
assert.equal(text('summary',more)[0],'Other ways to connect');assert.ok(!more.hasAttribute('open'),'closed by default');
assert.match(more.textContent,/Use an API token instead/);assert.match(more.textContent,/For scripts and special cases/);
assert.ok(!/Paperclip|paperclip/.test(body()),'nothing here says Paperclip');
// 2. Errors in plain words, inline under the field.
probe={ok:false,stage:'network',message:'raw'};
await typeInto(document.querySelector('input[type=url]')!,'https://gone.example.test');await click(connectBtn());
assert.equal(text('.settings-error')[0],'Muster can’t reach gone.example.test. Check the address and that the server is running.');
probe={ok:false,stage:'service',message:'raw'};await click(connectBtn());
assert.equal(text('.settings-error')[0],'portal.example.test isn’t a Muster server. Check the address.'.replace('portal','gone'));
await typeInto(document.querySelector('input[type=url]')!,'http://team.example.test');
assert.match(text('.settings-error')[0]??'',/plain http/,'a remote http address is warned about before anything is sent');
// 3. Connect: the address decides; the server's own sign-in opens in a window.
probe=HOSTED;
await typeInto(document.querySelector('input[type=url]')!,'https://team.example.test');
assert.ok(!connectBtn()!.hasAttribute('disabled'),'enabled once an address is typed');
await click(connectBtn());
assert.deepEqual(calls.find(c=>c.command==='paperclip.test'&&c.input.baseUrl==='https://team.example.test')?.input,{mode:'custom',baseUrl:'https://team.example.test'},'the address is probed first');
assert.equal(calls.find(c=>c.command==='paperclip.signin.start')?.input.baseUrl,'https://team.example.test');
assert.deepEqual(calls.find(c=>c.command==='musterServer.signInWindow')?.input,{url:'https://team.example.test/cli-auth/abc?token=secret',baseUrl:'https://team.example.test'},'the server\'s own page opens in the app window');
assert.ok(!calls.some(c=>c.command==='link.open'),'not the system browser unless asked');
assert.match(body(),/Waiting for you to sign in on team\.example\.test…/);assert.match(body(),/expires at/);
assert.ok(button(/^Cancel$/),'Cancel while waiting');assert.ok(!document.querySelector('input[type=url]'),'the address field is out of the way');
await click(button(/Use my browser instead/));
assert.deepEqual(calls.filter(c=>c.command==='musterServer.signInWindow').at(-1)?.input,{baseUrl:'https://team.example.test',close:true});
assert.equal(calls.filter(c=>c.command==='link.open').at(-1)?.input.url,'https://team.example.test/cli-auth/abc?token=secret');
await click(button(/^Cancel$/));
assert.match(text('.settings-error')[0]??'',/Sign-in was cancelled\. Connect to try again\./);
// 4. Approved in the window: the runtime says so; the panel shows who and how live.
await click(connectBtn());
signin={phase:'signed-in',baseUrl:'https://team.example.test',user:{name:'Test Founder',email:'founder@example.test'}};
config={...config,mode:'custom',baseUrl:'https://team.example.test',hasToken:true,backend:'paperclip',compatibility:'Paperclip-compatible',signedIn:{name:'Test Founder',email:'founder@example.test'},serverVersion:'2026.1001.0',live:'socket',reconnect:false,session:'active'};
await configChanged();
assert.match(text('.ws-connection-detect')[0],/Connected to team\.example\.test as Test Founder \(founder@example\.test\)\. Live updates on\./);
assert.ok(button(/^Disconnect$/)&&button(/^Import a copy…$/),'Disconnect and Import a copy');
assert.ok(!button(/^Connect$/)&&!button(/Sign out|Test connection|^Save$/),'no Save, no Test, no Sign out: Disconnect replaces them');
const details=document.querySelector('details.ws-connection-more') as any;
assert.equal(text('summary',details)[0],'Details');assert.ok(!details.hasAttribute('open'));
assert.match(details.textContent,/Server version2026\.1001\.0/);assert.match(details.textContent,/CompatibilityPaperclip-compatible/,'the one place the word appears');
assert.equal(text('.ws-connection-detect')[0].includes('Paperclip'),false);
assert.ok(document.querySelector('.ws-select'),'two orgs: an Org picker');
// 5. The fallback: updates every few seconds, with a quiet Reconnect.
config={...config,live:'poll',reconnect:true,session:'expired'};await configChanged();
assert.match(text('.ws-connection-detect')[0],/Updates every few seconds\./);
assert.ok(button(/^Reconnect for live updates$/));
await click(button(/^Reconnect for live updates$/));
assert.deepEqual(calls.filter(c=>c.command==='musterServer.signInWindow').at(-1)?.input,{baseUrl:'https://team.example.test',url:'https://team.example.test'},'it reopens the server\'s page; no full sign-in');
config={...config,live:'socket',reconnect:false,session:'active'};await configChanged();
assert.ok(!button(/^Reconnect for live updates$/));
// 6. Import a copy, then Disconnect (revokes the key, clears the session, turns it off).
await click(button(/^Import a copy…$/));
assert.ok(calls.some(c=>c.command==='paperclip.import.plan'));assert.match(body(),/Import MockCo into Muster/);
await click(button(/^Cancel$/));
await click(button(/^Disconnect$/),150);
assert.ok(calls.some(c=>c.command==='paperclip.disconnect'));
assert.ok(!document.querySelector('.ws-connection-details')&&document.querySelector('input[type=url]'),'back to not connected');
root.unmount();
// 7. A server found on this Mac: one click, no sign-in when it is local-trusted.
config={...config,mode:'off',hasToken:false,signedIn:null,backend:null,compatibility:null,live:undefined};
localFound={ok:true,stage:'ok',backend:'paperclip',version:'2026.1001.0',baseUrl:'http://127.0.0.1:3100',companies:[{id:'c1',name:'Local',prefix:'LOC'}],message:'ok'};
probe={ok:true,stage:'ok',backend:'paperclip',companies:[{id:'c1',name:'Local',prefix:'LOC'}],baseUrl:'http://127.0.0.1:3100',message:'ok'};
root=await mount();
assert.match(text('.ws-connection-local')[0],/^Found a server on this Mac \(2026\.1001\.0\)\. Connect$/);
await click(document.querySelector('.ws-connection-local button'),150);
assert.deepEqual(calls.filter(c=>c.command==='paperclip.config.set').at(-1)?.input,{mode:'local',baseUrl:'http://127.0.0.1:3100',backend:'paperclip',companyId:'c1'},'linked with no sign-in');
assert.ok(!calls.filter(c=>c.command==='paperclip.signin.start').some(c=>c.input.baseUrl==='http://127.0.0.1:3100'));
assert.match(text('.ws-connection-detect')[0],/Connected to 127\.0\.0\.1:3100\./);
root.unmount();
// 8. Other ways to connect: an API token for an address, with its own Connect.
config={...config,mode:'off',hasToken:false,live:undefined};localFound=null;
root=await mount();
const disclosure=document.querySelector('details.ws-connection-more') as any;
disclosure.setAttribute('open','');
await typeInto(document.querySelector('input[type=url]')!,'https://api.example.test');
const tokenBtn=()=>button(/^Connect with token$/);
assert.ok(tokenBtn()!.hasAttribute('disabled'),'needs a token');
await typeInto(document.querySelector('input[type=password]')!,'bad-token');await click(tokenBtn());
assert.equal(text('.settings-error')[0],'The server didn’t accept that token.');
await typeInto(document.querySelector('input[type=password]')!,'good-token');await click(tokenBtn(),150);
assert.deepEqual(calls.filter(c=>c.command==='paperclip.config.set').at(-1)?.input,{mode:'custom',baseUrl:'https://api.example.test',token:'good-token',backend:'muster-server',companyId:'c1'});
assert.match(text('.ws-connection-detect')[0],/Connected to api\.example\.test with an API token\./);
assert.ok(button(/^Disconnect$/));
root.unmount();
// 9. An upgrade: a link a person already had opens straight in the connected state (a token link says so).
config={...config,mode:'custom',baseUrl:'https://old.example.test',hasToken:true,backend:'paperclip',compatibility:'Paperclip-compatible',signedIn:null,live:'poll'};
root=await mount();
assert.match(text('.ws-connection-detect')[0],/Connected to old\.example\.test with an API token\. Updates every few seconds\./);
root.unmount();
// 10. A server that revoked the key: not connected, the reason in plain words, Connect again.
config={...config,hasToken:false,signInNotice:'Signed out by Muster Server — sign in again.'};
root=await mount();
assert.ok(connectBtn());assert.match(text('.settings-error')[0],/Signed out by Muster Server — sign in again\./);
root.unmount();
assert.deepEqual(errors,[]);
console.log('paperclip-signin-dom: ok');
process.exit(0);
