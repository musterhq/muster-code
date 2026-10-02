// Muster Server UI (#199, #202, #204): the desktop Settings › Integrations panel, the web-only Settings › Server section with the
// admin console, and the desktop-only state shown in the web UI. linkedom DOM, stubbed bridges; no network, no Electron.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div><div id="root2"></div><div id="root3"></div></body></html>');
(window.document as any).oninput=null; // React only wires native input events when the document advertises them.
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:()=>null,setItem:()=>undefined,removeItem:()=>undefined},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
// Node 24 defines a read-only global navigator; replace it for the panels' keychain wording and Copy button.
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',userAgent:'linkedom',clipboard:{writeText:async()=>undefined}}});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=await import('react');
const settle=async(ms=60)=>{await act(async()=>{await delay(ms);});};
const text=(el:Element|null)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const click=async(el:Element|undefined|null)=>{assert.ok(el,'click target');await act(async()=>{(el as HTMLElement).click();await delay(30);});};
const type=async(el:Element|null,value:string)=>{assert.ok(el,'input');let proto=Object.getPrototypeOf(el),descriptor:PropertyDescriptor|undefined;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);await act(async()=>{descriptor!.set!.call(el,value);el!.dispatchEvent(new window.Event('input',{bubbles:true}));el!.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(10);});};
const byText=(root:Element,selector:string,t:string)=>[...root.querySelectorAll(selector)].find(e=>text(e).includes(t));

// ---------------------------------------------------------------- desktop: Settings › Integrations › Muster Server (the one connection)
const calls:{command:string;input:any}[]=[];
let config:any={mode:'off',baseUrl:'http://127.0.0.1:3100',hasToken:false,secureStorage:true,companyId:null,backend:null,compatibility:null,user:null,signedIn:null,signInNotice:null,serverVersion:null,connectedAt:null,signIn:[]};
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='paperclip.config.get')return config;
  if(command==='paperclip.signin.status')return {phase:'idle'};
  if(command==='paperclip.test')return input.mode==='local'?{ok:false,stage:'network',message:'No server is answering on this Mac.'}:{ok:false,stage:'auth',backend:'muster-server',compatibility:null,signIn:['password'],message:'This Muster Server needs you to sign in.',baseUrl:input.baseUrl};
  if(command==='musterServer.connect'){if(input.password!=='right-password-1')throw new Error('Wrong username or password.');config={...config,mode:'custom',baseUrl:'https://muster.example.com',hasToken:true,backend:'muster-server',user:{username:'olivia',displayName:'Olivia Owner',role:'owner'},serverVersion:'0.2.10',connectedAt:'2026-10-01T00:00:00Z'};return {connected:true};}
  if(command==='musterServer.disconnect'){config={...config,mode:'off',hasToken:false,user:null,backend:null};return {connected:false};}
  if(command==='paperclip.snapshot')return {paperclip:null,goals:[],approvals:[],labels:[],tasks:[],agents:[],projects:[],runs:[],inbox:[],counts:{liveRuns:0,inbox:0,failedRuns:0,openTasks:0},fetchedAt:new Date().toISOString()};
  if(command==='paperclip.watch')return {live:'off'};
  return undefined;
}};
const {isWebHost}=await import('../src/renderer/webHost');
const {visibleSections}=await import('../src/renderer/components/settings/sections');
assert.equal(isWebHost(),false);
assert.equal(visibleSections(false).some(s=>s.id==='server'),false,'the desktop app never shows the Server section');
assert.equal(visibleSections(true).some(s=>s.id==='server'),true,'the web UI does');
assert.equal(visibleSections(false).some(s=>/paperclip/i.test(`${s.label} ${s.description} ${s.keywords}`)),false,'no Settings section, description or search keyword names Paperclip');

const {ConnectionPanel}=await import('../src/renderer/components/HubSetup');
const host=document.getElementById('root')!;
const root=createRoot(host);
await act(async()=>{root.render(<ConnectionPanel compact/>);});await settle();
assert.deepEqual([...host.querySelectorAll('.ws-segment-label')].map(e=>text(e)),['This Mac','Sign in to Muster Server','URL + API token','Off'],'one connection, four choices');
assert.match(text(host),/Nothing leaves this Mac/,'off until you connect');
await click(byText(host,'button','Your account on a server'));
const field=(i:number)=>host.querySelectorAll('input')[i]??null; // URL, then (after detection) username and password
const signInButton=()=>[...host.querySelectorAll('button')].find(b=>text(b)==='Sign in') as HTMLButtonElement|undefined;
assert.equal(signInButton()?.disabled,true,'Sign in waits for a URL');
await type(field(0),'https://muster.example.com');
await click(signInButton());await settle();
assert.equal(calls.find(c=>c.command==='paperclip.test'&&c.input.baseUrl==='https://muster.example.com')?.input.mode,'custom','the address is checked first: nobody says which kind of server it is');
assert.ok(host.querySelector('input[type=password]'),'a Muster Server asks for a username and password');
await type(field(1),'olivia');
await type(field(2),'wrong-password-1');
await click(signInButton());await settle();
assert.match(text(host.querySelector('[role=alert]')),/Wrong username or password/);
await type(field(2),'right-password-1');
await click(signInButton());await settle();
assert.match(text(host.querySelector('.ws-connection-details')),/Connected tohttps:\/\/muster\.example\.com.*Signed in asOlivia Owner \(@olivia, owner\).*Server version0\.2\.10/);
assert.ok(!/Compatibility/.test(text(host.querySelector('.ws-connection-details'))),'the compatibility line appears only for a Paperclip-compatible backend');
assert.deepEqual(calls.find(c=>c.command==='musterServer.connect'&&c.input.password==='right-password-1')?.input,{url:'https://muster.example.com',method:'password',username:'olivia',password:'right-password-1',mode:'custom'});
assert.ok(byText(host,'button','Import from Muster Server'),'import is part of the same section');
assert.equal(calls.some(c=>c.command==='link.open'),false,'a connected Muster Server never opens in the browser');
await click(byText(host,'button','Sign out'));await settle();
assert.match(text(host),/Nothing leaves this Mac/);
await act(async()=>{root.unmount();});

// ---------------------------------------------------------------- web: Settings › Server, admin console
const rpc:{command:string;input:any}[]=[];
const people=[{id:'u1',username:'olivia',displayName:'Olivia Owner',role:'owner',status:'active',activeSessions:1,projects:[],lastLoginAt:null},
  {id:'u2',username:'mel',displayName:'Mel Member',role:'member',status:'active',activeSessions:2,projects:[{projectId:'p1',name:'Support desk',role:'editor'}],lastLoginAt:null}];
let me:any=people[0];
(window as any).muster={host:'web',subscribe(){return()=>{};},async invoke(){return undefined;}};
(window as any).musterServer={ready:Promise.resolve(),info:()=>({user:me,server:{version:'0.2.10',name:'Muster Server'}}),signOut:async()=>{rpc.push({command:'signOut',input:null});},
  async invoke(command:string,input:any={}){
    rpc.push({command,input});
    if(command==='server.users.list')return people;
    if(command==='server.invites.list')return [];
    if(command==='server.invites.create')return {url:'https://muster.example.com/invite/mi_abc',invite:{role:input.role}};
    if(command==='server.access.list')return {projects:[{id:'p1',name:'Support desk'}],access:[{projectId:'p1',userId:'u2',role:'editor'}]};
    if(command==='server.cost')return {lines:[{key:'u2',label:'Mel Member (@mel)',turns:3,inputTokens:3600,outputTokens:120,costUsd:0.0126,unpricedTurns:0}],totals:{key:'total',label:'Total',turns:3,inputTokens:3600,outputTokens:120,costUsd:0.0126,unpricedTurns:0},ledger:{ok:true,entries:3}};
    if(command==='server.sessions.list')return [{id:'s1',username:'olivia',lastSeenAt:'2026-10-01T00:00:00Z',ip:'127.0.0.1',current:true},{id:'s2',username:'mel',lastSeenAt:'2026-10-01T00:00:00Z',ip:'10.0.0.2',current:false}];
    if(command==='server.connectors.list')return [{id:'c1',name:'acme-slack',label:'Slack',enabled:true,available:true,health:{state:'ok',lastError:'old error'},rules:[{}]},{id:'c2',name:'disc',label:'Discord',enabled:true,available:false,health:{state:'unsupported',lastError:null},rules:[]}];
    if(command==='server.users.revoke')return {sessions:2,tokens:0};
    if(command==='server.audit.verify')return {ok:true,entries:42};
    return {ok:true};
  }};
assert.equal(isWebHost(),true);
const {ServerSettings}=await import('../src/renderer/components/settings/ServerSettings');
const host2=document.getElementById('root2')!;
const root2=createRoot(host2);
await act(async()=>{root2.render(<ServerSettings/>);});await settle(120);
for(const heading of ['Your account','People and roles','Invites','Project access','Usage and cost, last 30 days','Active sessions','Chat channels','Remote agents','Audit'])assert.ok(byText(host2,'h3',heading),heading);
assert.match(text(host2),/Mel Member \(@mel\).*\$0\.0126/);
assert.match(text(host2),/Ledger verified · 3 turns/);
assert.equal(text(host2).includes('old error'),false,'a healthy connector hides its last error');
assert.match(text(host2),/disc.*coming soon/);
await click(byText(host2,'button','Create link'));await settle();
assert.match(text(host2),/https:\/\/muster\.example\.com\/invite\/mi_abc/);
assert.deepEqual(rpc.find(c=>c.command==='server.invites.create')?.input,{role:'member',expires:'7d'});
const melRow=[...host2.querySelectorAll('tr')].find(r=>text(r).includes('@mel')&&text(r).includes('Mel Member'))!;
await click(byText(melRow,'button','Revoke'));await settle();
assert.deepEqual(rpc.find(c=>c.command==='server.users.revoke')?.input,{userId:'u2'});
await click(byText(host2,'button','Verify'));await settle();
assert.match(text(host2),/Verified · 42 entries/);
await act(async()=>{root2.unmount();});

// A member sees their account, not the console.
me=people[1];rpc.length=0;
const root3=createRoot(document.getElementById('root3')!);
await act(async()=>{root3.render(<ServerSettings/>);});await settle(80);
const host3=document.getElementById('root3')!;
assert.ok(byText(host3,'h3','Your account'));
assert.equal(byText(host3,'h3','People and roles'),undefined);
assert.match(text(host3),/managed by this server’s owners and admins/);
assert.equal(rpc.some(c=>c.command.startsWith('server.users')),false,'a member’s browser never asks for the people list');
await act(async()=>{root3.unmount();});

// The desktop-only state stands in for host-only surfaces in the web UI.
const {DesktopOnlyState}=await import('../src/renderer/components/DesktopOnlyState');
const host4=document.createElement('div');document.body.appendChild(host4);
const root4=createRoot(host4);
await act(async()=>{root4.render(<DesktopOnlyState feature="The built-in browser"/>);});await settle();
assert.match(text(host4),/Desktop only.*The built-in browser runs on your own computer, so it is available in the Muster desktop app/);
await act(async()=>{root4.unmount();});
console.log('muster-server-components: ok');
process.exit(0);
