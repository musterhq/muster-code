/** Devices (#363) in the renderer: picker states, the live view and its controls, Settings, the PiP card for a device
 *  session (one card per session, docked while its tab is on screen, click opens the tab), and tab lifetimes.
 *  Bundled by scripts/test-renderer.mjs; frames and the helper are faked at the bridge. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
const memory={getItem:(key:string)=>storage.get(key)??null,setItem:(key:string,value:string)=>{storage.set(key,String(value));},removeItem:(key:string)=>{storage.delete(key);}};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,localStorage:memory,sessionStorage:memory,CustomEvent:window.CustomEvent});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});(window as any).getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:300,height:188,top:0,left:0,right:300,bottom:188});
(window as any).innerWidth=1400;(window as any).innerHeight=900;
const IPHONE='6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A';
const calls:{command:string;input:any}[]=[];
const chat={id:'c1',title:'Research',folderId:'repo',pinned:false,archived:false,draft:'',status:'idle',updatedAt:'',model:'test',mode:'agent'};
const snapshot={chats:[chat],folders:[{id:'repo',name:'repo',path:'/repo'}],projects:[],version:1,activeChatId:'c1'};
const ok=(detail:string)=>({available:true,detail});
let setup:any={enabled:false,agentControl:false,host:'darwin',helper:{state:'absent',version:'0.15.3',downloadMB:26,running:false},ios:{available:false,reason:'Xcode is not installed.',fix:['Install Xcode from the App Store.']},android:ok('Android SDK at ~/sdk'),node:ok('24.4.0')};
const list={devices:[{id:IPHONE,name:'iPhone 17 Pro',platform:'ios',osVersion:'iOS 26.0',state:'booted',formFactor:'phone'},{id:'avd:Pixel_9',name:'Pixel_9',platform:'android',osVersion:'Android',state:'shutdown',formFactor:'phone'}],errors:[],checkedAt:1};
let sessions:any[]=[];
const listeners=new Set<(event:any)=>void>();
const emit=(event:any)=>{for(const listener of [...listeners])listener(event);};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot;
  if(command==='chat.timeline')return {items:[],cursor:null};
  if(command==='devices.setup')return setup;
  if(command==='devices.configure'){setup={...setup,...input,...(input.enabled===false?{agentControl:false}:{})};return setup;}
  if(command==='devices.installHelper'){setup={...setup,helper:{...setup.helper,state:'installed'}};return setup;}
  if(command==='devices.list')return list;
  if(command==='devices.sessions')return sessions;
  if(command==='devices.open'){const device=list.devices.find(d=>d.id===input.id)!;sessions=[{deviceId:device.id,name:device.name,platform:device.platform,formFactor:'phone',openedBy:'user',control:'agent',state:'live',inputReady:true,openedAt:Date.now()}];emit({type:'deviceSessions',sessions});return sessions[0];}
  if(command==='devices.close'){sessions=sessions.filter(s=>s.deviceId!==input.id);emit({type:'deviceSessions',sessions});return;}
  return undefined;
}};
const inputs:any[]=[];
(window as any).musterDevices={onFrame(){return()=>{};},ack(){},input(id:string,input:any){inputs.push({id,input});}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const devicesUi=await import('../src/renderer/deviceSessions');
const {ComputerPip}=await import('../src/renderer/components/ComputerPip');
const {Workspace}=await import('../src/renderer/components/Workspace');
const {DeviceSettings}=await import('../src/renderer/components/devices/DeviceSettings');
const {DeviceTab}=await import('../src/renderer/components/devices/DeviceTab');
await store.boot();await delay(30);
const errors:unknown[]=[];
const until=async(check:()=>boolean,what:string)=>{for(let i=0;i<100;i++){if(check())return;await delay(20);}throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0,300)}`);};
const text=()=>document.body.textContent??'';
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>(b.textContent??'').trim()===label||b.getAttribute('aria-label')===label) as HTMLButtonElement|undefined;

// 1. Settings: checks with fix steps, off by default, enabling downloads the helper, agent access is separate.
const settingsRoot=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
settingsRoot.render(<DeviceSettings/>);await delay(60);
assert.match(text(),/Xcode is not installed/);assert.match(text(),/Install Xcode from the App Store/);
assert.match(text(),/about 26 MB/,'the download size is disclosed before turning it on');
const toggles=()=>[...document.querySelectorAll<HTMLButtonElement>('button[role=switch]')];
assert.equal(toggles()[0]!.getAttribute('aria-checked'),'false');assert.equal(toggles()[1]!.disabled,true,'agent access needs devices on');
toggles()[0]!.click();await delay(60);
assert.deepEqual(calls.filter(c=>c.command.startsWith('devices.configure')||c.command==='devices.installHelper').map(c=>c.command),['devices.configure','devices.installHelper']);
assert.equal(toggles()[0]!.getAttribute('aria-checked'),'true');assert.equal(toggles()[1]!.disabled,false);
toggles()[1]!.click();await delay(40);
assert.deepEqual(calls.at(-1),{command:'devices.configure',input:{agentControl:true}});
settingsRoot.unmount();

// 2. Picker: platform note for a missing Xcode, devices listed, Start/Open, a session opens its tab.
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<><ComputerPip/><Workspace/></>);
store.openTab({id:'devices',kind:'device',title:'Devices'});await until(()=>/Android Emulators/.test(text()),'the picker');
assert.match(text(),/Android Emulators/);assert.match(text(),/Pixel 9/,'AVD names read with spaces');
assert.match(text(),/Xcode is not installed/,'iOS group explains what is missing');
assert.ok(button('Start'),'a stopped AVD can be started');
// The iPhone is booted; the picker hides it only because Xcode is "missing" in this fixture. Make iOS available and refresh.
setup={...setup,ios:ok('Xcode 26.1')};
(document.querySelector('[aria-label="Refresh devices"]') as HTMLButtonElement).click();await until(()=>/iPhone 17 Pro/.test(text()),'the iPhone');
assert.match(text(),/iPhone 17 Pro/);
button('Open')!.click();await until(()=>!!document.querySelector('.device-view'),'the live view');
let state=store.getState();
assert.equal(state.activeTabId,`device:${IPHONE}`,'opening a device shows its tab');
assert.ok(document.querySelector('.device-view'),'the live view renders');
assert.equal(document.querySelectorAll('.pip-card:not([data-docked])').length,0,'its PiP card steps aside while the tab is on screen');
// Controls: Home goes through the command; touch on the screen goes to the device as normalized input.
for(const label of ['Home','App switcher','Rotate','Lock','Shut down the device'])assert.ok(document.querySelector(`[aria-label="${label}"]`),label);
assert.equal(document.querySelector('[aria-label="Back"]'),null,'iOS has no Back button');
(document.querySelector('[aria-label="Home"]') as HTMLButtonElement).click();await delay(20);
assert.deepEqual(calls.at(-1),{command:'devices.button',input:{id:IPHONE,button:'home'}});
assert.ok(calls.some(c=>c.command==='devices.view'&&c.input.active===true),'the visible tab registers as an active viewer');

// 3. PiP: another tab on screen -> the device shows as one card; clicking it focuses the device tab.
store.openTab({id:'files:repo',kind:'files',folderId:'repo',title:'repo'});await delay(80);
const cards=()=>[...document.querySelectorAll<HTMLElement>('.pip-card')];
assert.equal(cards().length,1,'one card per live session');
assert.equal(cards()[0]!.getAttribute('data-session'),`c1|device:${IPHONE}`);
assert.equal(cards()[0]!.hasAttribute('data-docked'),false);
assert.equal(document.querySelector('[aria-label="Take control"]'),null,'a session the user opened has no agent to take control from');
(cards()[0]!.querySelector('.pip-card-main') as HTMLButtonElement).click();await delay(60);
assert.equal(store.getState().activeTabId,`device:${IPHONE}`,'click focuses the existing tab');
assert.equal(store.getState().tabs.filter(t=>t.kind==='device'&&t.deviceId===IPHONE).length,1,'never a second tab');

// 4. An agent's session: Take control appears; closing the user's own session ends it with its tab.
sessions=[{...sessions[0],chatId:'c1',openedBy:'agent'}];emit({type:'deviceSessions',sessions});await delay(40);
assert.ok(button('Take control'),'the tab offers Take control for an agent session');
store.closeTab(`device:${IPHONE}`);await delay(60);
assert.ok(!calls.some(c=>c.command==='devices.close'),'closing the tab of an agent session keeps the session');
assert.equal(cards().filter(card=>!card.hasAttribute('data-docked')).length,1,'and its card is back in the PiP');
sessions=[{...sessions[0],chatId:undefined,openedBy:'user'}];emit({type:'deviceSessions',sessions});await delay(20);
store.openTab({id:`device:${IPHONE}`,kind:'device',deviceId:IPHONE,title:'iPhone 17 Pro'});await delay(40);
store.closeTab(`device:${IPHONE}`);await delay(60);
assert.deepEqual(calls.filter(c=>c.command==='devices.close').map(c=>c.input),[{id:IPHONE}],'closing the tab ends the user\'s own session');
assert.equal(cards().length,0,'no ghost card after the session ends');

// 5. Error state: plain words and Reconnect.
sessions=[{deviceId:IPHONE,name:'iPhone 17 Pro',platform:'ios',formFactor:'phone',openedBy:'user',control:'agent',state:'error',error:'No video arrived from the device. Reconnect to try again.',inputReady:false,openedAt:Date.now()}];
emit({type:'deviceSessions',sessions});
store.openTab({id:`device:${IPHONE}`,kind:'device',deviceId:IPHONE,title:'iPhone 17 Pro'});await until(()=>/Lost the connection/.test(text()),'the error card');
assert.match(text(),/Lost the connection to iPhone 17 Pro/);assert.ok(button('Reconnect'));
// Device tabs are never restored after a restart.
const {saveWorkspace,readWorkspace}=await import('../src/renderer/workspacePersistence');
const saved=new Map<string,string>();
saveWorkspace({setItem:(k,v)=>void saved.set(k,v)},{tabs:store.getState().tabs,activeTabId:null});
assert.equal(readWorkspace({getItem:k=>saved.get(k)??null}).tabs.some(tab=>(tab.kind as string)==='device'),false);
root.unmount();

// 6. No desktop bridge: a plain note, nothing else.
delete (window as any).musterDevices;
const noBridge=createRoot(document.getElementById('root')!);
noBridge.render(<DeviceTab tab={{id:'devices',title:'Devices'}} visible/>);await until(()=>/desktop app/.test(text()),'the note');
assert.match(text(),/Devices need the desktop app/);
noBridge.unmount();
void devicesUi;
assert.deepEqual(errors,[]);
console.log('devices-components: ok');
process.exit(0);
