/** Settings > Memory: a failed save must not undo a later toggle that succeeded. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const store=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:(k:string)=>store.has(k)?store.get(k)!:null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
const server:any={endpoint:'http://localhost:8888',hasApiKey:false,keyStorage:'none',autoRecall:true,autoRetain:'ask',source:'app'};
let sets=0;
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  if(command==='settings.get')return {values:{}};
  if(command==='memory.config.get')return {...server};
  if(command==='memory.config.set'){
    const n=++sets;
    if(n===1){await delay(80);throw new Error('write failed');}
    server.autoRecall=input.autoRecall;server.autoRetain=input.autoRetain;return {...server};
  }
  return undefined;}} as any;
const {openAppSettings}=await import('../src/renderer/store');
openAppSettings('memory');
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {PreferencesScreen}=await import('../src/renderer/components/PreferencesScreen');
const root=createRoot(document.getElementById('root')!);
root.render(<PreferencesScreen/>);
const until=async(cond:()=>boolean)=>{for(let i=0;i<200&&!cond();i++)await delay(10);assert.ok(cond(),'condition');};
await until(()=>document.querySelector('[aria-label="Use memory in agent runs"]')!==null);
(document.querySelector('[aria-label="Use memory in agent runs"]') as HTMLButtonElement).click();
await delay(10);
const retain=()=>[...document.querySelectorAll('[aria-label="After a run completes"] button')] as HTMLButtonElement[];
retain().find(b=>b.textContent==='After runs')!.click();
await delay(250);
const picked=retain().find(b=>b.getAttribute('aria-checked')==='true')!.textContent;
assert.equal(picked,'After runs','the later toggle that succeeded is still shown');
console.log('memory-settings-rollback-dom ok');
process.exit(0);
