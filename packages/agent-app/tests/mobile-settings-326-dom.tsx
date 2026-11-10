// Settings › Integrations › Phone (#326): the relay address, Pair a phone with its QR and link, the paired phones with their
// access switch, and Revoke. linkedom DOM, stubbed bridge; no runtime, no network.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
for(const name of ['KeyboardEvent','MouseEvent','PointerEvent','FocusEvent'])if(!(window as any)[name])(window as any)[name]=class extends window.Event {constructor(type:string,init:any={}){super(type,init);Object.assign(this,init);}};
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true,window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:()=>null,setItem:()=>undefined,removeItem:()=>undefined},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{platform:'MacIntel',userAgent:'linkedom',clipboard:{writeText:async()=>undefined}}});
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {act}=await import('react');
const settle=async(ms=60)=>{await act(async()=>{await delay(ms);});};
const text=(el:Element|null|undefined)=>(el?.textContent??'').replace(/\s+/g,' ').trim();
const click=async(el:Element|undefined|null)=>{assert.ok(el,'click target');await act(async()=>{(el as HTMLElement).click();await delay(30);});};
const button=(label:string)=>[...document.querySelectorAll('button')].find(b=>text(b)===label||b.getAttribute('aria-label')===label);

const link='muster://pair?v=1&r=wss%3A%2F%2Frelay.example.com&d=0123456789abcdef0123456789abcdef&k=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&c=BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB&n=Studio';
const expiresAt=new Date(Date.now()+5*60_000).toISOString();
let status:any={relayUrl:'wss://relay.example.com',relay:'online',relayError:null,secureStorage:true,desktopName:'Studio',pairing:null,devices:[]};
const calls:{command:string;input:any}[]=[];
const phone=(access:string)=>({id:'p1',name:'Dhairya’s iPhone',platform:'ios',fingerprint:'ab12 cd34 ef56 7890',access,pairedAt:new Date().toISOString(),lastSeenAt:new Date().toISOString(),connected:true});
let listeners:Array<(e:any)=>void>=[];
const changed=()=>{for(const l of listeners)l({type:'mobileChanged'});};
(window as any).muster={subscribe(listener:(e:any)=>void){listeners.push(listener);return()=>{listeners=listeners.filter(l=>l!==listener);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='mobile.status')return status;
  if(command==='mobile.pair.start'){status={...status,pairing:{expiresAt,pending:null}};return {link,expiresAt};}
  if(command==='mobile.pair.link')return status.pairing?{link,expiresAt}:null;
  if(command==='mobile.pair.confirm'){status={...status,pairing:null,devices:[phone('read-only')]};return status;}
  if(command==='mobile.reset'){status={...status,pairing:null,devices:[]};return status;}
  if(command==='mobile.devices.setAccess'){status={...status,devices:status.devices.map((d:any)=>d.id===input.id?{...d,access:input.access}:d)};return status;}
  if(command==='mobile.devices.revoke'){status={...status,devices:status.devices.filter((d:any)=>d.id!==input.id)};return status;}
  if(command==='mobile.relay.set'){status={...status,relayUrl:input.url};return status;}
  return undefined;
}};

const {PhoneSettings}=await import('../src/renderer/components/settings/PhoneSettings');
const host=document.getElementById('root')!;
const root=createRoot(host);

// Spec: MUS-SPEC-23-5A (docs/spec/clauses/23-mobile.md#mus-spec-23-5a)
await check('Phone settings show the pairing QR, list the phone read-only, and revoke it',async()=>{
  await act(async()=>{root.render(<PhoneSettings/>);});await settle(120);
  assert.match(text(host),/No phones paired yet/);
  await click(button('Pair a phone'));await settle();
  assert.ok(calls.some(c=>c.command==='mobile.pair.start'),'pairing started');
  const svg=host.querySelector('svg[data-qr-size]');
  assert.ok(svg,'a QR code is shown');
  const size=Number(svg!.getAttribute('data-qr-size'));
  assert.ok(size>=21&&(size-17)%4===0,`a QR has 17+4n modules a side (${size})`);
  // The top-left finder pattern: a 7×7 dark ring (row 0 fully dark, row 1 dark only at its ends).
  const dark=new Set((svg!.querySelector('path')!.getAttribute('d')??'').match(/M\d+ \d+/g)!.map(m=>m.slice(1)));
  for(let x=0;x<7;x++)assert.ok(dark.has(`${x} 0`),`finder row 0 at ${x}`);
  assert.ok(dark.has('0 1')&&!dark.has('1 1')&&dark.has('6 1'),'finder ring');
  assert.ok(text(host).includes(link),'the link is shown for a phone that can’t scan');
  assert.match(text(host),/Expires at/);
  // A phone used the code: it waits for the owner to compare check codes.
  status={...status,pairing:{expiresAt,pending:{name:'Dhairya’s iPhone',platform:'ios',checkCode:'123456',fingerprint:'ab12 cd34 ef56 7890'}}};
  await act(async()=>{changed();await delay(40);});await settle();
  assert.match(text(host),/Dhairya’s iPhone/);
  assert.match(text(host),/123 456/);
  assert.match(text(host),/iOS/);
  assert.ok(button('Reject'),'the pending phone can be rejected');
  await click(button('Add phone'));await settle();
  assert.deepEqual(calls.find(c=>c.command==='mobile.pair.confirm')?.input,{checkCode:'123456'});
  await act(async()=>{changed();await delay(40);});await settle();
  const row=host.querySelector('tr[data-phone-id="p1"]');
  assert.ok(row,'the phone is listed');
  assert.match(text(row),/Dhairya’s iPhone/);
  assert.match(text(row),/Read only/);
  assert.match(text(row),/iOS/);
  assert.match(text(row),/ab12 cd34 ef56 7890/);
  assert.equal(host.querySelector('svg[data-qr-size]'),null,'the QR goes away once used');
  const toggle=row!.querySelector('[role=switch]');
  assert.equal(toggle?.getAttribute('aria-checked'),'false');
  await click(toggle);await settle();
  assert.deepEqual(calls.find(c=>c.command==='mobile.devices.setAccess')?.input,{id:'p1',access:'act'});
  assert.match(text(host.querySelector('tr[data-phone-id="p1"]')),/Can act/);
  await click(button('Revoke Dhairya’s iPhone'));await settle();
  assert.equal(calls.some(c=>c.command==='mobile.devices.revoke'),false,'Revoke asks first');
  await click(button('Revoke now'));await settle();
  assert.deepEqual(calls.find(c=>c.command==='mobile.devices.revoke')?.input,{id:'p1'});
  assert.equal(host.querySelector('tr[data-phone-id="p1"]'),null,'the row goes away');
});
// Spec: MUS-SPEC-23-8B (docs/spec/clauses/23-mobile.md#mus-spec-23-8b)
await check('Reset phone access asks first, then rotates the keys',async()=>{
  status={...status,devices:[phone('act')]};
  await act(async()=>{changed();await delay(40);});await settle();
  assert.ok(host.querySelector('tr[data-phone-id="p1"]'));
  await click(button('Reset phone access'));await settle();
  assert.equal(calls.some(c=>c.command==='mobile.reset'),false,'it asks first');
  assert.match(text(host),/unpairs every phone/i);
  await click(button('Reset now'));await settle();
  assert.ok(calls.some(c=>c.command==='mobile.reset'));
  assert.equal(host.querySelector('tr[data-phone-id="p1"]'),null);
});
await act(async()=>{root.unmount();});
process.exit(0);
