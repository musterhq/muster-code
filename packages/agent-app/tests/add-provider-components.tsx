import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
let checkFails=true;
const providers=[
  {id:'custom_existing',name:'Work gateway',available:true,status:'ready',source:'Added in Muster',identityMasked:'',custom:true,endpoint:'https://gw.example.com/v1',models:[{id:'m',name:'m'}],detail:'Available.'},
  {id:'codex',name:'Codex CLI (ChatGPT)',available:false,status:'installed',identityMasked:'',models:[],detail:'installed'},
];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});
  if(command==='providers.list')return providers;
  if(command==='providers.save')return {id:input.id??'custom_draft',name:input.name,endpoint:input.endpoint,available:false,identityMasked:'',models:[]};
  if(command==='providers.secret.set')return {stored:true};
  if(command==='providers.check'){if(checkFails)throw new Error("Error invoking remote method 'providers.check': Error: The endpoint rejected the API key (HTTP 401). Paste a valid key and check again.");return {id:input.id,name:'x',available:true,identityMasked:'',models:[{id:'a',name:'a'},{id:'b',name:'b'}]};}
  if(command==='providers.remove')return;
  if(command==='providers.usage')return [];
  if(command==='providers.diagnose')return {id:input.id,stage:'auth-missing',summary:'No sign-in found.',hint:'',command:'codex login',diagnostics:''};
  if(command==='providers.secret.status')return {stored:false,secureStorage:true};
  if(command==='providers.accounts.list')return {accounts:[]};
  if(command==='providers.captureStatus')return {captured:false};
  if(command==='terminal.create')return {id:'t1'};
  return undefined;}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ProvidersScreen}=await import('../src/renderer/components/ProvidersScreen');
const {PROVIDER_CATALOG}=await import('../src/shared/provider-catalog');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<ProvidersScreen/>);await delay(80);
const $=(s:string)=>document.querySelector(s) as HTMLElement|null;
const click=async(el:Element|null|undefined,ms=40)=>{assert.ok(el,'element to click');(el as HTMLElement).click();await delay(ms);};
const type=async(element:HTMLInputElement,value:string)=>{element.dispatchEvent(new window.Event('focusin',{bubbles:true}));let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));element.dispatchEvent(new window.Event('keyup',{bubbles:true}));await delay(35);};
// linkedom does not submit a form on a submit button's click, so the submit event is dispatched on the form.
const submit=async(scope:ParentNode,ms=80)=>{scope.querySelector('form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(ms);};
const button=(scope:ParentNode,text:string)=>Array.from(scope.querySelectorAll('button')).find(b=>b.textContent?.trim()===text) as HTMLButtonElement|undefined;

// The card grid: one card per catalog entry, each with a logo, a name, a description and a status chip.
assert.equal($('.add-provider'),null);
await click(button(document,'Add provider')!);
assert.equal(document.querySelectorAll('.provider-tile').length,PROVIDER_CATALOG.length);
for(const tile of Array.from(document.querySelectorAll('.provider-tile'))){assert.ok(tile.querySelector('svg, [aria-hidden]'),'logo');assert.ok(tile.querySelector('.provider-tile-name')?.textContent);assert.ok(tile.querySelector('.provider-tile-desc')?.textContent);assert.ok(tile.querySelector('.provider-chip')?.textContent);}
assert.equal($('[data-provider="codex"] .provider-chip')!.textContent,'Installed, not signed in');
assert.equal($('[data-provider="claude-code"] .provider-chip')!.textContent,'Not installed');
assert.equal($('[data-provider="ollama"] .provider-chip')!.textContent,'Not connected');

// API key sheet: one key field and Get a key; no URL or name unless Advanced is opened.
await click($('[data-provider="openai-api"]'));
const sheet=$('.provider-sheet')!;
assert.equal(sheet.getAttribute('role'),'dialog');
assert.equal(sheet.querySelectorAll('input[type="password"]').length,1);
assert.equal(sheet.querySelectorAll('input[type="url"]').length,1,'the base URL exists only inside Advanced');
assert.ok(sheet.querySelector('details.sheet-advanced input[type="url"]'));
assert.match(sheet.textContent!,/Get a key/);
const testButton=()=>button(sheet,'Test connection')!;
assert.equal(testButton().disabled,true,'a key is required');
await type(sheet.querySelector('input[type="password"]') as HTMLInputElement,'sk-test');
assert.equal(testButton().disabled,false);
await submit(sheet);
assert.match(sheet.textContent!,/The endpoint rejected the API key \(HTTP 401\)/);
assert.doesNotMatch(sheet.textContent!,/Error invoking remote method/,'plain English, no IPC wrapper');
checkFails=false;
await submit(sheet);
assert.match(sheet.textContent!,/Connected\. Found 2 models/);
await submit(sheet);
assert.equal($('.provider-sheet'),null);
const saves=calls.filter(c=>c.command==='providers.save');
assert.deepEqual(saves.map(c=>c.input.id),[undefined,'custom_draft'],'a retry updates the same draft row');
assert.equal(saves[0].input.endpoint,'https://api.openai.com/v1');
assert.deepEqual(calls.filter(c=>c.command==='providers.secret.set').map(c=>c.input),[{providerId:'custom_draft',value:'sk-test'}]);
assert.ok(!calls.some(c=>c.command==='providers.remove'),'a saved connection is kept');

// Local sheet: URL prefilled with the default, key optional.
await click(button(document,'Add provider')!);
await click($('[data-provider="ollama"]'));
const local=$('.provider-sheet')!;
assert.equal((local.querySelector('input[type="url"]') as HTMLInputElement).value,'http://127.0.0.1:11434/v1');
assert.match(local.textContent!,/API key \(optional\)/);
assert.equal(button(local,'Test connection')!.disabled,false);await type(local.querySelector('input[type="url"]') as HTMLInputElement,'');assert.equal(button(local,'Test connection')!.disabled,true,'an empty address cannot be tested');await type(local.querySelector('input[type="url"]') as HTMLInputElement,'http://127.0.0.1:11434/v1');
// Cancelling after a failed test removes only the draft this sheet made.
checkFails=true;calls.length=0;
await submit(local);
await click(button(local,'Cancel')!,80);
assert.deepEqual(calls.filter(c=>c.command==='providers.remove').map(c=>c.input),[{id:'custom_draft'}]);

// Sign-in sheet: installed but signed out offers Sign in, which types the login command; no fields.
await click($('[data-provider="codex"]'));
const signin=$('.provider-sheet')!;
assert.equal(signin.querySelectorAll('input').length,0);
await delay(40);
calls.length=0;
await click(button(signin,'Sign in')!,60);
assert.ok(calls.some(c=>c.command==='terminal.input'||c.command==='terminal.create'||c.command==='clipboard.write'));
await click(button(signin,'Close')!);
// Not installed shows install instructions.
await click($('[data-provider="claude-code"]'));
assert.match($('.provider-sheet')!.textContent!,/not installed on this Mac/);
assert.match($('.provider-sheet')!.textContent!,/npm install -g @anthropic-ai\/claude-code/);
await click(button($('.provider-sheet')!,'Close'));

// Existing connections still render, with their per-connection actions, and no add call ever touched them or the server.
assert.ok(Array.from(document.querySelectorAll('.settings-provider h2')).some(n=>n.textContent==='Work gateway'));
assert.ok(button(document,'Edit'));
const all=calls.concat();
assert.ok(!all.some(c=>c.input&&c.input.id==='custom_existing'||c.input?.providerId==='custom_existing'),'existing rows untouched');
assert.ok(!all.some(c=>/^(server|paperclip|muster-server)\./.test(c.command)),'no server command');
assert.deepEqual(errors,[]);
root.unmount();
console.log('Add provider checks passed: card grid, API-key, local and sign-in sheets, draft cleanup, existing rows untouched.');
