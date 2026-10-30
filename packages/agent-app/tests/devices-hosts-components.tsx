/** Remote device hosts (#812) in the renderer: Settings lists the SSH hosts with Connect and Disconnect and says why a
 *  host failed; the picker shows each connected host's simulators and emulators in their own labelled groups, and a
 *  Linux host's iOS group explains that iOS needs a Mac. Bundled by scripts/test-renderer.mjs; main is faked at the bridge. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
const memory={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,localStorage:memory,sessionStorage:memory,CustomEvent:window.CustomEvent});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
const ok=(detail:string)=>({available:true,detail});
const MAC='ssh-aaaaaaaaaaaa', LINUX='ssh-bbbbbbbbbbbb';
const calls:{command:string;input:any}[]=[];
const hosts:any[]=[
  {id:MAC,kind:'ssh',label:'build-mac',address:'me@mac.local',sshHostId:'rec-mac',state:'off'},
  {id:LINUX,kind:'ssh',label:'lab-linux',address:'me@lab:2222',sshHostId:'rec-linux',state:'failed',detail:'Node.js was not found on lab-linux. Install Node.js 20 or later there.'},
];
const setup=()=>({enabled:true,agentControl:false,appleModels:true,models:[],host:'darwin',helper:{state:'installed',version:'0.15.3',downloadMB:26,running:false},ios:ok('Xcode 26.1'),android:ok('Android SDK at ~/sdk'),node:ok('24.4.0'),hosts});
const list={devices:[
  {id:'6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A',name:'iPhone 17 Pro',platform:'ios',osVersion:'iOS 26.0',state:'booted',formFactor:'phone'},
  {id:`${MAC}:AAAAAAAA-1111`,name:'iPhone 17',platform:'ios',osVersion:'iOS 26.0',state:'shutdown',formFactor:'phone',hostId:MAC,hostLabel:'build-mac'},
  {id:`${LINUX}:emulator-5554`,name:'Pixel_9',platform:'android',osVersion:'Android 16',state:'booted',formFactor:'phone',hostId:LINUX,hostLabel:'lab-linux'},
],errors:[],checkedAt:1};
const listeners=new Set<(event:any)=>void>();
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {chats:[],folders:[],projects:[],version:1,activeChatId:null};
  if(command==='devices.setup')return setup();
  if(command==='devices.list')return list;
  if(command==='devices.sessions')return [];
  if(command==='devices.connectHost'){const host=hosts.find(h=>h.sshHostId===input.sshHostId);Object.assign(host,{state:'ready',detail:undefined,ios:ok('Xcode 26.1'),android:{available:false,reason:'No Android SDK on build-mac.'}});return host;}
  if(command==='devices.disconnectHost'){const host=hosts.find(h=>h.sshHostId===input.sshHostId);Object.assign(host,{state:'off',detail:undefined});return host;}
  return undefined;
}};
(window as any).musterDevices={onFrame(){return()=>{};},ack(){},input(){}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {DeviceSettings}=await import('../src/renderer/components/devices/DeviceSettings');
const {DeviceTab}=await import('../src/renderer/components/devices/DeviceTab');
await store.boot();await delay(30);
const until=async(test:()=>boolean,what:string)=>{for(let i=0;i<100;i++){if(test())return;await delay(20);}throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0,400)}`);};
const text=()=>document.body.textContent??'';
const row=(label:string)=>[...document.querySelectorAll('[data-host-state]')].find(li=>(li.textContent??'').includes(label))!;
const buttonIn=(el:Element,label:string)=>[...el.querySelectorAll('button')].find(b=>(b.textContent??'').trim()===label) as HTMLButtonElement;

// Spec: MUS-SPEC-21-812F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812f)
await check('settings: SSH hosts listed with Connect, a failed host says why, Connect and Disconnect call main', async () => {
  const root=createRoot(document.getElementById('root')!);
  root.render(<DeviceSettings/>);
  await until(()=>/Devices on other machines/.test(text()),'the hosts section');
  assert.match(text(),/~\/\.muster\/device-host and without sudo/);
  assert.match(text(),/iOS needs a Mac host/);
  assert.match(row('build-mac').textContent!,/me@mac\.local · Not used/);
  assert.match(row('lab-linux').textContent!,/Failed.*Node\.js was not found on lab-linux/);
  assert.ok(row('lab-linux').querySelector('[role=alert]'));
  buttonIn(row('build-mac'),'Connect').click();
  await until(()=>row('build-mac')?.getAttribute('data-host-state')==='ready','connected');
  assert.deepEqual(calls.find(c=>c.command==='devices.connectHost'),{command:'devices.connectHost',input:{sshHostId:'rec-mac'}});
  buttonIn(row('lab-linux'),'Stop using').click();
  await until(()=>row('lab-linux')?.getAttribute('data-host-state')==='off','stopped');
  assert.deepEqual(calls.find(c=>c.command==='devices.disconnectHost'),{command:'devices.disconnectHost',input:{sshHostId:'rec-linux'}});
  root.unmount();
});

// Spec: MUS-SPEC-21-812F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-812f)
await check('picker: a connected host\'s devices sit in their own groups named for the host; a Linux host explains iOS', async () => {
  Object.assign(hosts[1],{state:'ready',ios:{available:false,reason:'iOS Simulators need a Mac with Xcode, and lab-linux runs Linux. Only its Android Emulators are shown.'},android:ok('Android SDK at ~/Android/Sdk')});
  const root=createRoot(document.getElementById('root')!);
  root.render(<DeviceTab tab={{id:'devices',title:'Devices'}} visible/>);
  await until(()=>/iOS Simulators on build-mac/.test(text()),'host groups');
  const group=(label:string)=>document.querySelector(`section[aria-label="${label}"]`)!;
  assert.match(group('iOS Simulators').textContent!,/iPhone 17 Pro/);
  assert.doesNotMatch(group('iOS Simulators').textContent!,/iPhone 17[^ ]/,'remote devices are not mixed into the local group');
  assert.match(group('iOS Simulators on build-mac').textContent!,/iPhone 17/);
  assert.match(group('Android Emulators on build-mac').textContent!,/No Android SDK on build-mac/);
  assert.match(group('iOS Simulators on lab-linux').textContent!,/need a Mac with Xcode, and lab-linux runs Linux/);
  assert.match(group('Android Emulators on lab-linux').textContent!,/Pixel 9/);
  root.unmount();
});
console.log('devices-hosts-components: ok');
process.exit(0);
