/** Local checkouts settings: a value the runtime rejects is not left showing as if saved. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  if(command==='checkout.bindings')return {bindings:[],orgs:[{id:'o',name:'Org',projects:[{id:'p',name:'P'}]}]};
  if(command==='checkout.settings'){if(input.staleHours!==undefined&&input.staleHours>720)throw new Error('staleHours must be 0 to 720');return {staleHours:8,deviceName:'MacBook'};}
  return undefined;}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {LocalCheckoutsCard}=await import('../src/renderer/components/OrgsCard');
const until=async(cond:()=>boolean)=>{for(let i=0;i<100&&!cond();i++)await delay(10);assert.ok(cond(),'condition');};
const root=createRoot(document.getElementById('root')!,{onUncaughtError:(e:unknown)=>console.log('UNCAUGHT',String(e))});
// Spec: MUS-SPEC-12-558C (docs/spec/clauses/12-projects-orgs-and-tasks.md#mus-spec-12-558c)
await check('a quiet-hours value the runtime rejects is replaced by the saved value', async () => {
  root.render(<LocalCheckoutsCard/>);
  await until(()=>document.querySelector('input[type="number"]')!==null);
  const input=document.querySelector('input[type="number"]') as any;
  {let proto=Object.getPrototypeOf(input),d:any;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);input.dispatchEvent(new window.Event('focusin',{bubbles:true}));d.set.call(input,'9999');}
  input.dispatchEvent(new window.Event('input',{bubbles:true}));
  await delay(20);
  input.dispatchEvent(new window.Event('focusout',{bubbles:true}));
  input.dispatchEvent(new window.Event('blur'));
  await delay(150);
  const shown=(document.querySelector('input[type="number"]') as any).value;
  assert.equal(String(shown),'8','the rejected 9999 is replaced by the saved value');
});
console.log('checkout-settings-reject-dom ok');
process.exit(0);
