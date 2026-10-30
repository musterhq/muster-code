/** Devices (#363) in the renderer: picker states, the live view and its controls, Settings, the PiP card for a device
 *  session (one card per session, docked while its tab is on screen, click opens the tab), and tab lifetimes.
 *  Bundled by scripts/test-renderer.mjs; frames and the helper are faked at the bridge. */
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
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:300,height:188,top:0,left:0,right:300,bottom:188});
(window as any).innerWidth=1400;(window as any).innerHeight=900;
const IPHONE='6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A';
const calls:{command:string;input:any}[]=[];
const chat={id:'c1',title:'Research',folderId:'repo',pinned:false,archived:false,draft:'',status:'idle',updatedAt:'',model:'test',mode:'agent'};
const snapshot={chats:[chat],folders:[{id:'repo',name:'repo',path:'/repo'}],projects:[],version:1,activeChatId:'c1'};
const ok=(detail:string)=>({available:true,detail});
let setup:any={enabled:false,agentControl:false,appleModels:true,models:[{id:'iphone',label:'iPhone',state:'absent'},{id:'ipad',label:'iPad',state:'absent'}],host:'darwin',helper:{state:'absent',version:'0.15.3',downloadMB:26,running:false},ios:{available:false,reason:'Xcode is not installed.',fix:['Install Xcode from the App Store.']},android:ok('Android SDK at ~/sdk'),node:ok('24.4.0')};
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
settingsRoot.render(<DeviceSettings/>);await until(()=>/Xcode is not installed/.test(text()),'the platform checks');
assert.match(text(),/Xcode is not installed/);assert.match(text(),/Install Xcode from the App Store/);
assert.match(text(),/about 26 MB/,'the download size is disclosed before turning it on');
const toggles=()=>[...document.querySelectorAll<HTMLButtonElement>('button[role=switch]')];
assert.equal(toggles()[0]!.getAttribute('aria-checked'),'false');assert.equal(toggles()[1]!.disabled,true,'agent access needs devices on');
toggles()[0]!.click();await until(()=>toggles()[0]?.getAttribute('aria-checked')==='true'&&calls.some(c=>c.command==='devices.installHelper'),'devices turned on');
assert.deepEqual(calls.filter(c=>c.command.startsWith('devices.configure')||c.command==='devices.installHelper').map(c=>c.command),['devices.configure','devices.installHelper']);
assert.equal(toggles()[0]!.getAttribute('aria-checked'),'true');assert.equal(toggles()[1]!.disabled,false);
toggles()[1]!.click();await until(()=>calls.at(-1)?.command==='devices.configure'&&!!calls.at(-1)?.input?.agentControl,'agent access turned on');
assert.deepEqual(calls.at(-1),{command:'devices.configure',input:{agentControl:true}});
assert.match(text(),/Downloads device models from apple.com the first time a 3D view needs one/,'the model download is disclosed');
assert.equal(toggles()[2]!.getAttribute('aria-checked'),'true','realistic models are on by default');
settingsRoot.unmount();

// 2. Picker: platform note for a missing Xcode, devices listed, Start/Open, a session opens its tab.
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<><ComputerPip/><Workspace/></>);
store.openTab({id:'devices',kind:'device',title:'Devices'});await until(()=>/Android Emulators/.test(text())&&/Pixel 9/.test(text()),'the picker with its devices');
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
for(const label of ['Home','App Switcher','Rotate','Lock','Shut Down Simulator'])assert.ok(document.querySelector(`[aria-label="${label}"]`),label);
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

// 6. A 30 fps stream paints each frame outside React: viewers re-render on the first picture and on a size change
//    (rotation), never per frame.
{
  const frameListeners=new Set<(frame:any)=>void>();let acks=0;
  (window as any).musterDevices={onFrame(listener:any){frameListeners.add(listener);return()=>frameListeners.delete(listener);},ack(){acks++;},input(){}};
  let size={width:390,height:844};
  (globalThis as any).createImageBitmap=async()=>({...size,close(){}});
  const {useDeviceFeed,useFeedPaint}=await import('../src/renderer/devices/deviceFeed');
  let renders=0,paints=0;
  function Viewer(){renders++;const {feed}=useDeviceFeed(IPHONE,true);useFeedPaint(feed,()=>{paints++;});return <span data-size={feed?.width?`${feed.width}x${feed.height}`:'none'}/>;}
  const host=document.createElement('div');document.body.appendChild(host);
  const viewerRoot=createRoot(host);viewerRoot.render(<Viewer/>);
  await until(()=>frameListeners.size===1,'the viewer subscribing to frames');
  const push=async(n:number)=>{for(let i=0;i<n;i++){for(const listener of [...frameListeners])listener({deviceId:IPHONE,codec:'jpeg',key:true,data:new Uint8Array([0xff,0xd8,0xff,0xd9])});await delay(1);}};
  await push(1);await until(()=>host.querySelector('[data-size="390x844"]')!==null,'the first picture');
  const afterFirst=renders;
  await push(30);await until(()=>paints>=31,'every frame painted');
  assert.equal(renders,afterFirst,'thirty more frames re-render nothing');
  assert.equal(acks,31,'each decoded frame is acknowledged, so main sends the next');
  size={width:844,height:390};await push(1);await until(()=>host.querySelector('[data-size="844x390"]')!==null,'the rotated picture');
  assert.ok(renders>afterFirst&&renders<=afterFirst+2,'a size change re-renders once');
  viewerRoot.unmount();
  assert.equal(frameListeners.size,0,'unmounting the last viewer releases the feed');
  assert.ok(calls.some(c=>c.command==='devices.view'&&c.input.active===false),'and tells main the viewer left');
  host.remove();
}

// 6b. iOS H.264: the feed configures WebCodecs from the AVCC description and decodes the frames that follow (queued while
//     the decoder is being set up); a description this window cannot decode makes main stream MJPEG instead.
// Spec: MUS-SPEC-21-363D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-363d)
await check('iOS H.264 decodes with WebCodecs and falls back to MJPEG when the profile cannot be decoded', async () => {
  const frameListeners=new Set<(frame:any)=>void>();let acks=0;
  (window as any).musterDevices={onFrame(listener:any){frameListeners.add(listener);return()=>frameListeners.delete(listener);},ack(){acks++;},input(){}};
  let supported=true;const configs:any[]=[],decoded:string[]=[];
  (globalThis as any).EncodedVideoChunk=class{type:string;constructor(init:any){this.type=init.type;}};
  (globalThis as any).VideoDecoder=class{state='unconfigured';output:any;decodeQueueSize=0;constructor(init:any){this.output=init.output;}
    static async isConfigSupported(config:any){return {supported,config};}
    configure(config:any){configs.push(config);this.state='configured';}
    decode(chunk:any){decoded.push(chunk.type);this.output({displayWidth:1179,displayHeight:2556,close(){}});}
    close(){this.state='closed';}};
  const {acquireFeed,releaseFeed}=await import('../src/renderer/devices/deviceFeed');
  const deviceId='AVCC-1111-2222';
  const before=calls.length;
  const feed=acquireFeed(deviceId);
  const send=(frame:any)=>{for(const listener of [...frameListeners])listener({deviceId,...frame});};
  send({codec:'h264',format:'avcc',config:true,key:false,data:new Uint8Array([1,0x64,0x00,0x33,0xff])});
  // These arrive while the decoder is still being configured: they are kept and decoded in order.
  send({codec:'h264',format:'avcc',key:true,data:new Uint8Array([0,0,0,1,0x65])});
  send({codec:'h264',format:'avcc',key:false,data:new Uint8Array([0,0,0,1,0x41])});
  await until(()=>decoded.length===2,'both frames decoded');
  assert.equal(configs[0].codec,'avc1.640033');assert.deepEqual([...configs[0].description],[1,0x64,0x00,0x33,0xff]);assert.equal(configs[0].optimizeForLatency,true);
  assert.deepEqual(decoded,['key','delta']);assert.equal(acks,2,'each decoded frame is acknowledged');
  assert.equal(feed.width,1179);assert.equal(feed.height,2556);
  // A description this window cannot decode: main is asked once to stream MJPEG.
  supported=false;
  send({codec:'h264',format:'avcc',config:true,key:false,data:new Uint8Array([1,0x64,0x00,0x33,0xff])});
  await until(()=>calls.slice(before).some(c=>c.command==='devices.streamFallback'),'the MJPEG fallback request');
  assert.deepEqual(calls.slice(before).filter(c=>c.command==='devices.streamFallback').map(c=>c.input),[{id:deviceId}]);
  releaseFeed(feed);
  delete (globalThis as any).VideoDecoder;delete (globalThis as any).EncodedVideoChunk;
});

// 7. Each device wears its own frame, picked from what it reports (simctl device type, AVD config, the picture's shape
//    for a foldable's posture); the rail uses the device's own OS terms.
// Spec: MUS-SPEC-21-363G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-363g)
await check('each device wears its own frame and the rail uses its own OS terms', async () => {
  const frameListeners=new Set<(frame:any)=>void>();
  (window as any).musterDevices={onFrame(listener:any){frameListeners.add(listener);return()=>frameListeners.delete(listener);},ack(){},input(){}};
  let size={width:1080,height:2400};
  (globalThis as any).createImageBitmap=async()=>({...size,close(){}});
  const {DeviceView}=await import('../src/renderer/components/devices/DeviceView');
  const F=await import('../src/shared/device-frames');
  const ios=(type:string,name:string)=>({platform:'ios',name,frame:F.iosFrame(`com.apple.CoreSimulator.SimDeviceType.${type}`,name)});
  const avd=(config:string,name:string)=>({platform:'android',name,frame:F.androidFrame(F.parseIni(config),name)});
  const cases:[string,any,{width:number;height:number},string,string][]=[
    ['iPhone with Dynamic Island',ios('iPhone-17-Pro','iPhone 17 Pro'),{width:1206,height:2622},'iphone-island','island'],
    ['iPhone with notch',ios('iPhone-16e','iPhone 16e'),{width:1170,height:2532},'iphone-notch','notch'],
    ['iPhone SE',ios('iPhone-SE-3rd-generation','iPhone SE (3rd generation)'),{width:750,height:1334},'iphone-home','none'],
    ['iPad without Home button',ios('iPad-Pro-13-inch-M5','iPad Pro 13-inch (M5)'),{width:2064,height:2752},'ipad','none'],
    ['iPad with Home button',ios('iPad-9th-generation','iPad (9th generation)'),{width:1620,height:2160},'ipad-home','none'],
    ['Pixel',avd('hw.device.name=pixel_8','Pixel_8_API_35'),{width:1080,height:2400},'pixel','punch-center'],
    ['Pixel Fold, open',avd('hw.device.name=pixel_9_pro_fold\nhw.sensor.hinge=yes','Pixel_9_Pro_Fold'),{width:2076,height:2152},'pixel-fold','punch-side'],
    ['Pixel Fold, folded',avd('hw.device.name=pixel_9_pro_fold\nhw.sensor.hinge=yes','Pixel_9_Pro_Fold'),{width:1080,height:2092},'pixel-fold-folded','punch-center'],
    ['Pixel Tablet',avd('hw.device.name=pixel_tablet','Pixel_Tablet'),{width:2560,height:1600},'pixel-tablet','none'],
    ['Samsung-style phone',avd('hw.device.name=SM-S921B\nhw.device.manufacturer=Samsung','Centre_Punch'),{width:1080,height:2340},'android-centre-punch','punch-center'],
    ['Wear OS',avd('hw.device.name=wearos_large_round\ntag.id=android-wear','Wear'),{width:454,height:454},'wear-round','none'],
    ['TV',avd('hw.device.name=tv_1080p\ntag.id=google-tv','TV'),{width:1920,height:1080},'android-tv','none'],
    ['unknown phone',avd('hw.device.name=acme_x1\nhw.lcd.width=1200\nhw.lcd.height=2640\nhw.lcd.density=480','Acme_X1'),{width:1200,height:2640},'android-generic-phone','none'],
    ['a session with no spec (name only)',{platform:'android',name:'Pixel_9_API_36'},{width:1080,height:2424},'pixel-pill','punch-center'],
  ];
  const host=document.createElement('div');document.body.appendChild(host);
  const viewRoot=createRoot(host);
  for(const [label,device,picture,frameId,cutout] of cases){
    size=picture;
    const session={deviceId:`dev-${frameId}-${picture.width}`,formFactor:'phone',openedBy:'user',control:'agent',state:'live',inputReady:true,openedAt:1,...device};
    viewRoot.render(<DeviceView session={session} visible/>);
    // Frames go out on every check until the new view (which subscribes after its first render) has drawn one.
    const push=()=>{for(const listener of [...frameListeners])listener({deviceId:session.deviceId,codec:'jpeg',key:true,data:new Uint8Array([0xff,0xd8,0xff,0xd9])});};
    await until(()=>{push();return host.querySelector(`.device-frame[data-frame="${frameId}"]`)!==null&&host.querySelector('.device-view')?.getAttribute('data-state')==='live';},`${label}: frame ${frameId} (got ${host.querySelector('.device-frame')?.getAttribute('data-frame')})`);
    const frame=host.querySelector('.device-frame')!;
    assert.equal(frame.getAttribute('data-os'),device.platform,`${label}: the frame is its own OS's`);
    assert.equal(frame.getAttribute('data-cutout'),cutout,`${label}: cut-out`);
    assert.equal(host.querySelectorAll('.device-frame-cutout').length,cutout==='none'?0:1,`${label}: the cut-out is drawn once, over the screen`);
    if(frameId.endsWith('-home'))assert.ok(host.querySelector('.device-frame-home'),`${label}: a Home button`);
    if(frameId==='android-tv')assert.ok(host.querySelector('.device-frame-stand'),'a TV stands on its stand');
    // The rail speaks the device's OS.
    const rail=[...host.querySelectorAll('.device-rail button')].map(b=>b.getAttribute('aria-label'));
    if(device.platform==='ios'){
      assert.deepEqual(rail.slice(0,4),['Home','App Switcher','Rotate','Lock'],`${label}: iOS controls`);
      assert.ok(!rail.includes('Back')&&!rail.includes('Recents'),`${label}: no Android buttons on iOS`);
      assert.equal(rail.at(-1),'Shut Down Simulator');
    }else{
      const handheld=!['android-tv','wear-round'].includes(frameId);
      assert.deepEqual(rail.slice(0,handheld?5:3),handheld?['Back','Home','Recents','Rotate','Power']:['Back','Home','Power'],`${label}: Android controls`);
      assert.ok(!rail.includes('Lock')&&!rail.includes('App Switcher'),`${label}: no iOS buttons on Android`);
      assert.equal(host.querySelectorAll('.device-rail svg.device-nav-glyph').length,handheld?3:2,'Back, Home (and Recents) use Android\'s own glyphs');
      assert.equal(rail.at(-1),'Stop emulator');
    }
  }
  viewRoot.unmount();host.remove();
});

// 7b. A real frame from the user's own tools (Xcode chrome or SDK skin) is drawn upright with the live screen in its
//     screen rectangle and the cut-out on it; a turned device uses the parametric frame.
{
  const {DeviceFrameFlat}=await import('../src/renderer/components/devices/DeviceFrameFlat');
  const F=await import('../src/shared/device-frames');
  const spec=F.iosFrame(undefined,'iPhone 17 Pro');
  const chrome:any={source:'xcode',detail:'Xcode DeviceKit chrome phone11',width:436,height:902,image:{rect:{x:10,y:8,w:416,h:886},dataUrl:'data:image/png;base64,AA=='},screen:{x:17,y:14,w:402,h:874,radii:[55,55,55,55]},buttons:[{rect:{x:0,y:160,w:12,h:40},dataUrl:'data:image/png;base64,AA==',onTop:false}]};
  const host=document.createElement('div');document.body.appendChild(host);const frameRoot=createRoot(host);
  frameRoot.render(<DeviceFrameFlat spec={spec} chrome={chrome} picture={{width:1206,height:2622}}><canvas className="device-screen"/></DeviceFrameFlat>);
  await until(()=>host.querySelector('.device-frame.is-native')!==null,'the native frame');
  const native=host.querySelector('.device-frame')!;
  assert.equal(native.getAttribute('data-frame-source'),'xcode');
  assert.equal(host.querySelectorAll('img.device-native-part').length,2,'the frame picture and its button');
  const glass=host.querySelector('.device-frame-glass') as HTMLElement;
  assert.equal(glass.style.left,`${(17/436)*100}%`);assert.equal(glass.style.width,`${(402/436)*100}%`);
  assert.ok(glass.querySelector('canvas.device-screen'),'the live screen sits in the real screen rectangle');
  assert.equal(host.querySelectorAll('.device-frame-cutout').length,1,'the island is drawn over the screen');
  frameRoot.render(<DeviceFrameFlat spec={spec} chrome={chrome} picture={{width:2622,height:1206}} orientation="landscape_left"><canvas className="device-screen"/></DeviceFrameFlat>);
  await until(()=>!host.querySelector('.device-frame.is-native'),'the parametric frame for a turned device');
  assert.equal(host.querySelector('.device-frame')!.getAttribute('data-turns'),'1');
  frameRoot.unmount();host.remove();
}

// 8. No desktop bridge: a plain note, nothing else.
delete (window as any).musterDevices;
const noBridge=createRoot(document.getElementById('root')!);
noBridge.render(<DeviceTab tab={{id:'devices',title:'Devices'}} visible/>);await until(()=>/desktop app/.test(text()),'the note');
assert.match(text(),/Devices need the desktop app/);
noBridge.unmount();
void devicesUi;
assert.deepEqual(errors,[]);
console.log('devices-components: ok');
process.exit(0);
