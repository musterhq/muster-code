// #147 SSH workspaces: the Settings › Environments panel with a stubbed bridge (no ssh, no Electron).
// Never pass DOM nodes to assert.equal (util.inspect walks the linkedom graph); compare strings, counts and booleans.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const memory=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,KeyboardEvent:window.KeyboardEvent??window.Event,localStorage:{getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  getComputedStyle:()=>({getPropertyValue:()=>'',display:'block',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:1000,bottom:800,width:1000,height:800};};
(window.HTMLElement.prototype as any).scrollIntoView=function(){};

const FP='SHA256:'+'Q'.repeat(43);
const calls:{command:string;input:any}[]=[];
const last=(c:string)=>calls.filter(x=>x.command===c).at(-1);
let events:((e:any)=>void)[]=[];
const state:any={hosts:[] as any[],status:[] as any[],entries:[{alias:'devbox',hostName:'10.0.0.5',user:'dev',port:22,added:false}]};
(window as any).muster={subscribe(l:any){events.push(l);return()=>{events=events.filter(x=>x!==l);};},async invoke(command:string,input:any){calls.push({command,input});
 switch(command){
  case 'remote.hosts.list':return {hosts:state.hosts,status:state.status};
  case 'remote.hosts.config':return {file:'/home/me/.ssh/config',entries:state.entries.map((e:any)=>({...e,added:state.hosts.some((h:any)=>h.host===e.alias)}))};
  case 'remote.hosts.save':{const h={id:'h1',name:input.host,source:input.source,host:input.host,trusted:null};state.hosts=[h];return h;}
  case 'remote.hosts.connect':return {hostId:input.id,state:'hostkey-unknown',detail:'Muster does not know devbox’s host key yet. Compare its fingerprint and trust it to connect.',at:'now',hostKey:{type:'ed25519',fingerprint:FP}};
  case 'remote.hosts.trust':return {hostId:input.id,state:'connected',detail:'Connected to devbox.',at:'now'};
  case 'remote.folder.add':return {id:'f1',path:'ssh://devbox/home/dev/app',name:'app'};
  case 'remote.hosts.agentCredentials':{state.hosts=state.hosts.map((h:any)=>h.id===input.id?{...h,agentCredentials:input.credentials}:h);return state.hosts[0];}
  default:return undefined;
 }
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=false;
const store=await import('../src/renderer/store');
await store.boot();
const {RemoteHostsPanel}=await import('../src/renderer/components/settings/RemoteHostsPanel');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const text=()=>document.body.textContent??'';
const click=async(el:Element|null|undefined,ms=60)=>{assert.ok(el,'element to click');(el as any).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');const set=Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value')?.set;if(set)set.call(el,value);else el.value=value;el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};

// Spec: MUS-SPEC-15-147D (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147d)
await check('the SSH workspaces panel adds a config host and shows the fingerprint before trusting', async () => {
  root.render(<RemoteHostsPanel/>);await delay(120);
  assert.match(text(),/SSH workspaces/);assert.match(text(),/never stores a key or asks for a password/);
  assert.match(text(),/dev@10\.0\.0\.5 · from ~\/\.ssh\/config/);
  await click(button(/^Add devbox$/),200);
  assert.deepEqual(last('remote.hosts.save')!.input,{source:'config',host:'devbox'});
  assert.match(text(),/devbox/);assert.ok(!button(/^Add devbox$/),'an added host is no longer offered');
  await click(button(/^\s*Connect$/),120);
  assert.match(text(),/Check host key/);assert.ok(text().includes(FP),'the fingerprint is on screen before trusting');
  assert.equal(calls.filter(c=>c.command==='remote.hosts.trust').length,0,'nothing trusted by connecting');
  await click(button(/Trust this host/),120);
  assert.deepEqual(last('remote.hosts.trust')!.input,{id:'h1',fingerprint:FP});
  assert.match(text(),/Connected/);
  await setValue(document.querySelector('[aria-label="Folder on devbox"]'),'~/app');
  await click(button(/Open folder/),120);
  assert.deepEqual(last('remote.folder.add')!.input,{hostId:'h1',path:'~/app'});
});
// Spec: MUS-SPEC-15-147E (docs/spec/clauses/15-settings-and-themes.md#mus-spec-15-147e)
await check('agents on a host sign in with the host’s own login unless you choose to pass your key', async () => {
  const select=document.querySelector('[aria-label="Agent sign-in on devbox"]') as any;
  assert.ok(select,'the sign-in choice is shown for the host');
  assert.equal(select.value,'host');
  assert.match(text(),/Muster sends no key/);
  for(const option of select.querySelectorAll('option'))option.toggleAttribute('selected',option.getAttribute('value')==='muster');
  assert.equal(select.value,'muster');select.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(150);
  assert.deepEqual(last('remote.hosts.agentCredentials')!.input,{id:'h1',credentials:'muster'});
  assert.match(text(),/environment variable for that run only\. It is never written on the host/);
});
assert.equal(errors.length,0,String(errors[0]));
root.unmount();
console.log('ssh-workspaces-147-dom: ok');
process.exit(0);
