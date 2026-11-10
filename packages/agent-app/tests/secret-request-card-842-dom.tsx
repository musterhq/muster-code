// #842 (DOM): the private secret card in the chat. A masked field, the reason and who asks; the value goes to the main
// process once and the field is cleared; one-time is the default. Compare strings and booleans, never DOM nodes.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:(id:any)=>clearTimeout(id),ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},matchMedia:()=>({matches:false,addEventListener(){},removeEventListener(){}})});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});return undefined;}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {PendingQuestion}=await import('../src/renderer/components/PendingQuestion');
const root=createRoot(document.getElementById('root')!);
const text=()=>document.body.textContent??'';
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click exists');(el as any).dispatchEvent(new window.Event('click',{bubbles:true}));};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
const setValue=async(el:any,value:string)=>{assert.ok(el,'field to set');let proto=Object.getPrototypeOf(el),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(el,value);el.dispatchEvent(new window.Event('input',{bubbles:true}));el.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
const card=(status:string,extra:Record<string,unknown>={})=>({id:'s-item',chatId:'chat',kind:'question' as const,text:'Fixture agent asks for DEPLOY_TOKEN',status,createdAt:new Date().toISOString(),
  data:{method:'muster/secretRequest',request:'secret',name:'DEPLOY_TOKEN',env:'DEPLOY_TOKEN',reason:'Push the release to staging',requester:'Fixture agent',canRemember:true,rememberLabel:'Remember for this folder',onePassword:false,expiresAt:new Date(Date.now()+60_000).toISOString(),...extra}});

// Spec: MUS-SPEC-19-842J (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842j)
await check('the secret card takes a masked value, sends it once and clears the field', async()=>{
  root.render(<PendingQuestion item={card('pending')}/>);await delay(40);
  assert.match(text(),/Fixture agent/);assert.match(text(),/DEPLOY_TOKEN/);assert.match(text(),/Push the release to staging/);
  const field=document.querySelector('input[aria-label="Value for DEPLOY_TOKEN"]') as any;
  assert.ok(field,'a value field');assert.equal(field.getAttribute('type'),'password','the value is masked');assert.equal(field.getAttribute('autocomplete')??field.getAttribute('autoComplete'),'off','autocomplete is off (linkedom keeps the React attribute case)');
  const remember=[...document.querySelectorAll('label')].find(l=>/Remember for this folder/.test(l.textContent??''))?.querySelector('input') as any;
  assert.ok(remember,'Remember is offered');assert.equal(remember.checked,false,'one-time is the default');
  assert.equal((button(/Send privately/) as any).disabled,true,'nothing to send yet');
  await setValue(field,'qv7plainsecret3391mzk');
  click(button(/Send privately/));await delay(40);
  const sent=calls.filter(c=>c.command==='secret.answer');
  assert.equal(sent.length,1);assert.deepEqual(sent[0]!.input,{id:'s-item',value:'qv7plainsecret3391mzk',remember:false});
  assert.equal((document.querySelector('input[aria-label="Value for DEPLOY_TOKEN"]') as any)?.value??'','', 'the field is cleared after sending');
  click(button(/Decline/));await delay(30);
  assert.deepEqual(calls.filter(c=>c.command==='secret.decline').map(c=>c.input),[{id:'s-item'}]);
});

// Spec: MUS-SPEC-19-842K (docs/spec/clauses/19-security-and-redaction.md#mus-spec-19-842k)
await check('a sudo card, a 1Password pick and a settled card read plainly and never show a value', async()=>{
  calls.length=0;
  root.render(<PendingQuestion item={card('pending',{request:'sudo',name:'sudo password',env:'',reason:'[sudo] password for dhairya:',rememberLabel:'Remember in the keychain'})}/>);await delay(40);
  assert.match(text(),/sudo/);assert.match(text(),/Remember in the keychain/);
  root.render(<PendingQuestion item={card('pending',{onePassword:true})}/>);await delay(40);
  click(button(/1Password/));await delay(30);
  const reference=document.querySelector('input[aria-label="1Password reference"]') as any;assert.ok(reference,'a reference field');
  await setValue(reference,'op://Dev/deploy/token');
  click(button(/Send privately/));await delay(40);
  assert.deepEqual(calls.filter(c=>c.command==='secret.answer').at(-1)!.input,{id:'s-item',onePassword:'op://Dev/deploy/token',remember:false});
  root.render(<PendingQuestion item={card('answered',{source:'typed'})}/>);await delay(40);
  assert.match(text(),/Sent privately/);assert.equal(document.querySelector('input[type="password"]'),null,'no field once answered');
  root.render(<PendingQuestion item={card('answered',{source:'saved'})}/>);await delay(40);
  assert.match(text(),/saved value/i);click(button(/Forget/));await delay(30);
  assert.deepEqual(calls.filter(c=>c.command==='secret.forget').map(c=>c.input),[{id:'s-item'}]);
  root.render(<PendingQuestion item={card('expired')}/>);await delay(40);
  assert.match(text(),/No answer in time/);
});
root.unmount();
