/** Devices #809 in the renderer: the Device settings panel beside the live view. It reads the device's settings, sends
 *  one typed change at a time, shows what the device reports back, keeps the confirmed settings when a change fails, and
 *  never lets an older read overwrite a newer answer. Only the platform's own controls appear.
 *  Bundled by scripts/test-renderer.mjs; the bridge is faked. */
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

const IPHONE='6B1F0C4A-2E7D-4C55-9A0B-1F2E3D4C5B6A';
const calls:{command:string;input:any}[]=[];
let settings:Record<string,any>={appearance:'light',textSize:'default',increaseContrast:false,reduceMotion:false};
let inFlight=0,maxInFlight=0;
let actionDelay=15,readDelay=0,failNext=false;
const detail=(platform:string,id:string)=>({deviceId:id,platform,settings:{...settings},foregroundApp:null,readAt:Date.now()});
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='devices.detail'){const answer=detail(input.id===IPHONE?'ios':'android',input.id);await delay(readDelay);return answer;}
  if(command==='devices.action'){
    inFlight++;maxInFlight=Math.max(maxInFlight,inFlight);
    try{
      await delay(actionDelay);
      if(failNext){failNext=false;throw new Error('Could not change the appearance: simctl failed.');}
      const a=input.action;
      if(a.type==='setAppearance')settings.appearance=a.value;
      if(a.type==='setTextSize')settings.textSize=a.value;
      if(a.type==='setToggle')settings[a.setting]=a.value;
      return detail(input.id===IPHONE?'ios':'android',input.id);
    }finally{inFlight--;}
  }
  return undefined;
}};
(window as any).musterDevices={onFrame(){return()=>{};},ack(){},input(){}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {DeviceView}=await import('../src/renderer/components/devices/DeviceView');
const until=async(ok:()=>boolean,what:string)=>{for(let i=0;i<150;i++){if(ok())return;await delay(10);}throw new Error(`timed out waiting for ${what}: ${document.body.textContent?.slice(0,400)}`);};
const q=<T extends Element>(selector:string)=>document.querySelector(selector) as T|null;
const pressed=(label:string)=>[...document.querySelectorAll('.device-tools-segment button')].find(b=>b.textContent===label)?.getAttribute('aria-pressed');
const segment=(label:string)=>[...document.querySelectorAll<HTMLButtonElement>('.device-tools-segment button')].find(b=>b.textContent===label)!;
const switchOn=(label:string)=>q(`[role=switch][aria-label="${label}"]`)?.getAttribute('aria-checked')==='true';
const errors:unknown[]=[];
const session=(platform:'ios'|'android',deviceId:string,name:string)=>({deviceId,name,platform,formFactor:'phone',openedBy:'user',control:'agent',state:'live',inputReady:true,openedAt:1});
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});

// Spec: MUS-SPEC-21-809G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809g)
await check('the device settings panel changes one setting at a time and shows what the device reports back', async () => {
  root.render(<DeviceView session={session('ios',IPHONE,'iPhone 17 Pro') as any} visible/>);
  await until(()=>!!q('[aria-label="Device settings"]'),'the rail');
  const rail=[...document.querySelectorAll('.device-rail button')].map(b=>b.getAttribute('aria-label'));
  assert.deepEqual(rail.slice(0,4),['Home','App Switcher','Rotate','Lock'],'the rail keeps its own buttons first');
  assert.equal(rail.at(-1),'Shut Down Simulator');
  q<HTMLButtonElement>('[aria-label="Device settings"]')!.click();
  await until(()=>pressed('Light')==='true','the read-back');
  assert.ok(calls.some(c=>c.command==='devices.detail'&&c.input.id===IPHONE),'opening reads the settings');
  assert.equal(q('[aria-label="Device settings"]')!.getAttribute('aria-pressed'),'true');
  segment('Dark').click();
  await until(()=>pressed('Dark')==='true','dark mode confirmed');
  assert.deepEqual(calls.filter(c=>c.command==='devices.action').map(c=>c.input),[{id:IPHONE,action:{type:'setAppearance',value:'dark'}}]);
  // Two quick changes run one after the other, never together.
  q<HTMLButtonElement>('[role=switch][aria-label="Increase Contrast"]')!.click();q<HTMLButtonElement>('[role=switch][aria-label="Reduce Motion"]')!.click();
  await until(()=>calls.filter(c=>c.command==='devices.action').length===3&&inFlight===0&&switchOn('Reduce Motion'),'both toggles applied');
  assert.equal(maxInFlight,1,'actions are serialised');
  assert.equal(switchOn('Increase Contrast'),true);
  // iOS controls: Liquid Glass, colour filter, push; no Android orientation.
  for(const label of ['Liquid Glass','Colour filter','Text size','Latitude','Longitude','URL','App id','Permission','Push message'])assert.ok(q(`[aria-label="${label}"]`),label);
  assert.equal(q('[aria-label="Orientation"]'),null,'iOS sets orientation with Rotate, not a picker');
  assert.match(document.body.textContent??'',/Shake is not supported on the iOS Simulator/);
});

// Spec: MUS-SPEC-21-809G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809g)
await check('a failed change keeps the confirmed settings, and an older read never overwrites a newer answer', async () => {
  failNext=true;
  segment('Light').click();
  await until(()=>!!q('.device-tools-error'),'the error');
  assert.match(q('.device-tools-error')!.textContent??'',/simctl failed/);
  assert.equal(pressed('Dark'),'true','the last confirmed appearance stays');
  // Reopen: the read is slow and the change is quick; the change's answer wins.
  q<HTMLButtonElement>('[aria-label="Close device settings"]')!.click();
  await until(()=>!q('.device-tools'),'the panel closed');
  readDelay=120;actionDelay=5;settings.appearance='dark';
  const before=calls.length;
  q<HTMLButtonElement>('[aria-label="Device settings"]')!.click();
  await until(()=>!!q('.device-tools-segment'),'the panel again');
  // The read answers "dark" late; the user switches to Light before it lands.
  segment('Light').click();
  await until(()=>pressed('Light')==='true','light confirmed');
  await delay(180);
  assert.equal(pressed('Light'),'true','the late read did not overwrite the answer');
  assert.deepEqual(calls.slice(before).map(c=>c.command),['devices.detail','devices.action']);
  readDelay=0;actionDelay=15;
});

// Spec: MUS-SPEC-21-809G (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-809g)
await check('an Android emulator shows its own controls: orientation, animations and network, no push', async () => {
  settings={appearance:'dark',textSize:'small',reduceMotion:true,networkEnabled:true};
  root.render(<DeviceView session={session('android','emulator-5554','Pixel 9') as any} visible/>);
  await until(()=>!!q('[aria-label="Device settings"]')&&!!q('.device-rail[data-os="android"]'),'the Android rail');
  if(!q('.device-tools'))q<HTMLButtonElement>('[aria-label="Device settings"]')!.click();
  await until(()=>!!q('[aria-label="Remove animations"]')&&pressed('Dark')==='true','the Android read-back');
  assert.equal(switchOn('Remove animations'),true);
  assert.equal(switchOn('Wi-Fi and mobile data'),true);
  assert.ok(q('[aria-label="Orientation"]'),'Android picks an exact orientation');
  for(const label of ['Liquid Glass','Colour filter','Push message','Increase Contrast','VoiceOver'])assert.equal(q(`[aria-label="${label}"]`),null,`${label} is iOS only`);
  assert.equal([...document.querySelectorAll('.device-tools button')].some(b=>b.textContent==='Clear'),false,'the emulator cannot clear its location');
  assert.equal([...document.querySelectorAll('.device-tools button')].some(b=>b.textContent==='Reset'),false,'Android permissions are granted or revoked');
  assert.match(document.body.textContent??'',/Shake is not supported on the Android Emulator/);
  assert.equal((q<HTMLSelectElement>('select[aria-label="Text size"]')!).value,'small');
});

root.unmount();
assert.deepEqual(errors,[]);
console.log('device-tools-dom: ok');
process.exit(0);
