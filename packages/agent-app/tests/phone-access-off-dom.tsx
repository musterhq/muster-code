// Phone access stays hidden until the phone app ships: with default settings Settings › Integrations has no Phone section
// and Settings search finds nothing for it. linkedom DOM, the real Settings screen, stubbed bridge; no runtime.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:()=>null,setItem:()=>undefined,removeItem:()=>undefined},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
const calls:string[]=[];
const settingsValues:any={'general.sendKey':'enter','general.spellcheck':true,'appearance.textSize':100,'appearance.theme':'dark','appearance.lightTheme':'muster-light','appearance.darkTheme':'muster-dark','appearance.customThemes':[],'appearance.reducedMotion':'system','appearance.reducedTransparency':'system','chat.inlineDiffs':true};
const status={relayUrl:null,relay:'off',lan:{enabled:true,addresses:[]},relayError:null,secureStorage:true,desktopName:'Studio',pairing:null,devices:[]};
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push(command);
  if(command==='settings.get')return {values:settingsValues};
  if(command==='settings.set'){settingsValues[input.key]=input.value;return {values:settingsValues};}
  if(command==='mobile.status')return status;
  if(command==='paperclip.config.get')return {mode:'off',baseUrl:'',hasToken:false};
  if(command.endsWith('.list'))return [];
  return undefined;
}};
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=await import('react');
const {openAppSettings,getState,setSetting}=await import('../src/renderer/store');
const {PreferencesScreen}=await import('../src/renderer/components/PreferencesScreen');
const {filterSections}=await import('../src/renderer/components/settings/sections');
const host=document.getElementById('root')!;
const root=createRoot(host);
const text=()=>(host.textContent??'').replace(/\s+/g,' ');
const settle=async(ms=80)=>{await act(async()=>{await delay(ms);});};

// Spec: MUS-SPEC-23-25A (docs/spec/clauses/23-mobile.md#mus-spec-23-25a)
await check('Settings has no Phone section until phone access is turned on',async()=>{
  openAppSettings('integrations');
  await act(async()=>{root.render(<PreferencesScreen/>);});await settle(150);
  assert.equal(getState().settingsSection,'integrations');
  assert.match(text(),/Git hosts/,'the Integrations section is open');
  assert.doesNotMatch(text(),/Pair a phone|Phone access|Paired phones/,'no Phone section by default');
  assert.ok(!calls.includes('mobile.status'),'Settings never asks the runtime for phone status');
  // ("phone" still finds Chat through "microphone", for dictation.)
  const found=(query:string)=>filterSections(query,undefined,getState().settings).map(section=>section.id);
  assert.ok(!found('phone').includes('integrations'),'searching for "phone" does not lead to Integrations');
  assert.deepEqual(found('pair'),[],'searching for "pair" finds nothing');
  // Turned on (through the same settings store a saved settings file loads into), the section and its search terms are back.
  await act(async()=>{await setSetting('integrations.phoneAccess',true);});await settle(150);
  assert.match(text(),/Pair a phone/,'with phone access on, the Phone section shows');
  assert.ok(calls.includes('mobile.status'));
  assert.ok(found('phone').includes('integrations'),'"phone" finds Integrations again');
  assert.deepEqual(found('pair'),['integrations']);
});
await act(async()=>{root.unmount();});
console.log('phone-access-off-dom: ok');
