// #160: Settings › Providers › Add provider › ACP agent. Real components in linkedom; the runtime is a fake bridge.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
let checkResult:'fail'|'ok'='fail';
const providers:any[]=[{id:'custom_existing',name:'Work gateway',available:true,status:'ready',source:'Added in Muster',identityMasked:'',custom:true,endpoint:'https://gw.example.com/v1',models:[{id:'m',name:'m'}],detail:'Available.'}];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='providers.list')return providers;
  if(command==='providers.acp.save')return {id:input.id??'acp_draft',name:input.name,driver:'acp-agent',custom:true,available:false,identityMasked:'',models:[],acp:{command:input.command,args:input.args,envNames:Object.keys(input.env??{})}};
  if(command==='providers.acp.check'){if(checkResult==='fail')return {id:input.id,name:'Gemini CLI',driver:'acp-agent',custom:true,available:false,status:'error',identityMasked:'',models:[],error:'`gemini` was not found on this computer. npm install -g @google/gemini-cli, then run gemini once to sign in.'};
    return {id:input.id,name:'Gemini CLI',driver:'acp-agent',custom:true,available:true,status:'ready',identityMasked:'',models:[{id:'acp_draft/gemini-2.5-pro',name:'Gemini 2.5 Pro'},{id:'acp_draft/gemini-2.5-flash',name:'Gemini 2.5 Flash'}]};}
  if(command==='providers.remove')return;
  if(command==='providers.usage')return [];
  if(command==='providers.diagnose')return {id:input.id,stage:'ok',summary:'',hint:'',command:'',diagnostics:''};
  if(command==='providers.secret.status')return {stored:false,secureStorage:true};
  if(command==='providers.accounts.list')return {accounts:[]};
  if(command==='providers.captureStatus')return {captured:false};
  return undefined;}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ProvidersScreen}=await import('../src/renderer/components/ProvidersScreen');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<ProvidersScreen/>);await delay(80);
const $=(s:string)=>document.querySelector(s) as HTMLElement|null;
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as HTMLElement).click();await delay(ms);};
const setValue=async(element:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,value:string,event='input')=>{if(element.tagName==='SELECT'){for(const o of Array.from((element as HTMLSelectElement).options))o.selected=o.value===value;try{Object.defineProperty(element,'value',{configurable:true,get:()=>value});}catch{}element.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(35);return;}element.dispatchEvent(new window.Event('focusin',{bubbles:true}));let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.dispatchEvent(new window.Event(event,{bubbles:true}));element.dispatchEvent(new window.Event('keyup',{bubbles:true}));await delay(35);};
const submit=async(scope:ParentNode,ms=80)=>{scope.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(scope:ParentNode,text:string)=>Array.from(scope.querySelectorAll('button')).find(b=>b.textContent?.trim()===text) as HTMLButtonElement|undefined;
const field=(scope:ParentNode,label:string)=>Array.from(scope.querySelectorAll('label')).find(l=>l.textContent?.startsWith(label))!.querySelector('input,select,textarea') as HTMLInputElement;

// Spec: MUS-SPEC-03-160K (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160k)
await check('Add ACP agent: a preset fills the command and shows how to install it; Test starts it, Save keeps it', async()=>{
  await click(button(document,'Add provider')!);
  const tile=$('[data-provider="acp"]');
  assert.ok(tile,'an ACP agent card in the grid'); assert.match(tile!.textContent!,/Agent Client Protocol/);
  await click(tile);
  const sheet=$('.acp-sheet')!;
  assert.equal(sheet.getAttribute('role'),'dialog');
  assert.equal(button(sheet,'Test agent')!.disabled,true,'a command is required');
  const presets=Array.from(sheet.querySelectorAll('select option')).map(o=>o.textContent);
  assert.ok(presets.includes('Gemini CLI')&&presets.includes('Other command'),'presets plus a manual command');
  await setValue(field(sheet,'Agent'),'gemini','change');
  assert.equal(field(sheet,'Command').value,'gemini'); assert.equal(field(sheet,'Arguments').value,'--experimental-acp'); assert.equal(field(sheet,'Name').value,'Gemini CLI');
  assert.match(sheet.textContent!,/Muster does not install it/); assert.match(sheet.querySelector('.provider-command')!.textContent!,/npm install -g @google\/gemini-cli/);
  assert.ok(!calls.some(c=>/terminal\.|providers\.acp/.test(c.command)),'choosing a preset runs nothing');
  await setValue(field(sheet,'Environment variables') as any,'GEMINI_API_KEY=abc 123');
  await submit(sheet);
  assert.match(sheet.textContent!,/`gemini` was not found on this computer/); assert.doesNotMatch(sheet.textContent!,/Error invoking/);
  checkResult='ok';
  await submit(sheet);
  assert.match(sheet.textContent!,/Started Gemini CLI\. Found 2 models\./);
  const saves=calls.filter(c=>c.command==='providers.acp.save');
  assert.deepEqual(saves.map(c=>c.input.id),[undefined,'acp_draft'],'a retry updates the same draft');
  assert.deepEqual(saves[0]!.input,{name:'Gemini CLI',command:'gemini',args:['--experimental-acp'],env:{GEMINI_API_KEY:'abc 123'},preset:'gemini'});
  await submit(sheet);
  assert.equal($('.acp-sheet'),null,'Save closes the sheet');
  assert.ok(!calls.some(c=>c.command==='providers.remove'),'a saved agent is kept');
});

// Spec: MUS-SPEC-03-160L (docs/spec/clauses/03-providers-models-and-accounts.md#mus-spec-03-160l)
await check('Add ACP agent: cancelling an untested draft removes only that draft', async()=>{
  checkResult='fail'; calls.length=0;
  await click(button(document,'Add provider')!);
  await click($('[data-provider="acp"]'));
  const sheet=$('.acp-sheet')!;
  await setValue(field(sheet,'Command'),'/usr/local/bin/my-agent');
  await setValue(field(sheet,'Arguments'),`--mode acp --label "two words"`);
  await submit(sheet);
  assert.deepEqual(calls.find(c=>c.command==='providers.acp.save')!.input.args,['--mode','acp','--label','two words']);
  await click(button(sheet,'Cancel')!,80);
  assert.deepEqual(calls.filter(c=>c.command==='providers.remove').map(c=>c.input),[{id:'acp_draft'}]);
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('Add ACP agent checks passed.');
