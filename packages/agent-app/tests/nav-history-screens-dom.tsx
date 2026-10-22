/** Back/forward walks app locations like a browser: chats, Settings sections and screens (Inbox, Projects), not only chats. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value)}});
const at=new Date(Date.now()-3600_000).toISOString();
const mk=(id:string)=>({id,title:id,folderId:'folder',status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow'});
const chats=[mk('one'),mk('two')];
window.muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='app.snapshot')return {version:1,chats,folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'one'};
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='automations.list')return [];
  return undefined;
}};
const store=await import('../src/renderer/store');
const {goBack,goForward,currentLocation}=await import('../src/renderer/menuActions');
await store.boot();await delay(50);
const where=()=>currentLocation();
goBack();// installs the history on the booted state (nothing earlier yet)
assert.equal(where(),'chat:one');
await store.selectChat('two');await delay(20);
store.openAppSettings('appearance');
store.setSettingsSection('chat');
store.openHubScreen();
store.openProjectsScreen();
assert.equal(where(),'screen:projects');
const steps:string[]=[];
for(let i=0;i<5;i++){assert.equal(goBack(),true,`back step ${i+1}`);await delay(20);steps.push(where()!);}
assert.deepEqual(steps,['screen:hub','settings:chat','settings:appearance','chat:two','chat:one'],'Back retraces screens and Settings sections, not only chats');
assert.equal(goBack(),false,'nothing before the first location');
assert.equal(goForward(),true);await delay(20);
assert.equal(where(),'chat:two');
assert.equal(goForward(),true);await delay(20);
assert.equal(where(),'settings:appearance');
assert.equal(store.getState().screen,'settings');
assert.equal(store.getState().settingsSection,'appearance');
console.log('PASS: back/forward walks chats, Settings sections and screens like a browser');
process.exit(0);
