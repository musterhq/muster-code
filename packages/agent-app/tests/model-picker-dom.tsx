// The shared ModelPicker (composer, new chat, default-model pickers, automations) in linkedom: opens on the current
// provider, compact rows without "unknown" badges, collapsed Auto routes, search across providers, hidden note,
// keyboard, the non-model first row and the reasoning control.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null; // React only wires native input events when the document advertises them.
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,CustomEvent:window.CustomEvent,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
// linkedom tracks no focus: record it.
let focused:any=null;
window.HTMLElement.prototype.focus=function(){focused=this;};
Object.defineProperty(window.document,'activeElement',{configurable:true,get:()=>focused??window.document.body});
window.muster={subscribe(){return()=>{}},async invoke(command:string){if(command==='models.policy.get')return {hidden:[],shown:[],pricing:{}};return null;}} as any;

const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ModelPicker}=await import('../src/renderer/components/ModelPicker');
const providers:any[]=[
  {id:'hybrow',name:'Hybrow OmniRoute',available:true,identityMasked:'',models:[
    {id:'claude/claude-fable-5',name:'Claude Fable 5',contextWindow:1_000_000,images:true},
    {id:'advisor',name:'Advisor'},{id:'executor',name:'Executor'},
    ...Array.from({length:40},(_,i)=>({id:`auto/route-${String(i).padStart(2,'0')}`,name:`Auto · route ${i}`})),
    ...Array.from({length:1300},(_,i)=>({id:`vendor/m-${i}`,name:`Vendor ${i}`,hiddenByDefault:true})),
  ]},
  {id:'openai-direct',name:'ChatGPT',available:true,identityMasked:'',models:[{id:'gpt-6',name:'GPT-6',contextWindow:400_000,images:true,efforts:['low','high']},{id:'gpt-6-mini',name:'GPT-6 Mini'}]},
  {id:'claude-code',name:'Claude Code',available:true,identityMasked:'',models:[{id:'claude-opus-5-5',name:'Claude Opus 5.5'}]},
];
const picked:string[]=[];let manage=0;const efforts:string[]=[];let empty=0;
const errors:unknown[]=[];
const host=document.getElementById('root')!;
let root=createRoot(host,{onUncaughtError:error=>errors.push(error)});
root.render(<ModelPicker providers={providers} selected={{providerId:'hybrow',model:'advisor'}} onSelect={model=>picked.push(`${model.providerId}:${model.id}`)}
  onManageHidden={()=>manage++} efforts={['low','high']} effort="high" onEffort={value=>efforts.push(value)}/>);
await delay(40);
assert.deepEqual(errors,[]);
const q=(selector:string)=>Array.from(document.querySelectorAll(selector)) as HTMLElement[];
const options=()=>q('.model-picker-list [role="option"]');
const names=()=>options().map(option=>option.querySelector('.model-picker-name')?.textContent);
const search=document.querySelector('[aria-label="Search models"]') as HTMLInputElement;
const type=async(value:string)=>{let proto=Object.getPrototypeOf(search),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(search,value);search.dispatchEvent(new window.Event('input',{bubbles:true}));await delay(30);};
const key=(target:Element,name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});target.dispatchEvent(event);};

// Opens scoped to the current model's provider, with the search box focused.
assert.deepEqual(q('.model-picker-rail [role="tab"]').map(tab=>tab.getAttribute('aria-label')),['All providers','Hybrow OmniRoute','ChatGPT','Claude Code']);
assert.equal(q('.model-picker-rail [aria-selected="true"]').map(tab=>tab.getAttribute('aria-label')).join(),'Hybrow OmniRoute');
assert.equal(focused,search,'the search box takes focus');
assert.deepEqual(names(),['Advisor','Claude Fable 5','Executor'],'named agents and catalog models; 40 routes folded, 1300 hidden');
assert.equal(options().find(option=>option.getAttribute('aria-selected')==='true')?.dataset.model,'advisor');
assert.doesNotMatch(host.textContent??'',/unknown/i,'no unknown-capability badges');
assert.deepEqual(q('.model-picker-badges').map(node=>node.textContent),['1M'],'only declared capabilities (context and an image glyph)');
// Auto routes: collapsed by default, one toggle opens them.
const routes=document.querySelector('.model-picker-routes') as HTMLButtonElement;
assert.equal(routes.getAttribute('aria-expanded'),'false');
assert.match(routes.textContent??'',/Auto routes\s*40/);
routes.click();await delay(20);
assert.equal(routes.getAttribute('aria-expanded'),'true');
assert.equal(options().length,43);
routes.click();await delay(20);
assert.equal(options().length,3);
// Hidden-models note and Manage.
assert.match(host.textContent??'',/1300 hidden by your model settings · Manage/);
(q('.model-picker-hidden button')[0] as HTMLButtonElement).click();
assert.equal(manage,1);
// Rail: another provider; All lists every provider's section.
(document.querySelector('[role="tab"][aria-label="ChatGPT"]') as HTMLButtonElement).click();await delay(20);
assert.deepEqual(names(),['GPT-6','GPT-6 Mini']);
(document.querySelector('[role="tab"][aria-label="All providers"]') as HTMLButtonElement).click();await delay(20);
assert.deepEqual(q('.model-picker-section').map(node=>node.textContent),['Hybrow OmniRoute','ChatGPT','Claude Code']);
// Search spans every provider, whatever the tab; routes that match are listed inline.
(document.querySelector('[role="tab"][aria-label="Claude Code"]') as HTMLButtonElement).click();await delay(20);
await type('gpt 6');
assert.deepEqual(names(),['GPT-6','GPT-6 Mini']);
assert.equal(q('.model-picker-rail [aria-selected="true"]').length,0,'no tab reads as active while searching');
await type('route 1');
assert.ok(names().includes('Auto · route 12')&&names().every(name=>/^Auto · route \d*1/.test(name??'')),'matching routes are listed inline (every word matches)');
await type('nothing like this');
assert.match(host.textContent??'',/No models match this search/);
// Keyboard: ArrowDown from search enters the list; arrows wrap; Enter in search picks the first match.
await type('gpt');
key(search,'ArrowDown');
assert.equal(focused,options()[0]);
key(focused,'ArrowUp');
assert.equal(focused,options()[1],'ArrowUp wraps to the last option');
key(focused,'Home');
assert.equal(focused,options()[0]);
key(search,'Enter');
assert.deepEqual(picked,['openai-direct:gpt-6']);
options()[1]!.click();
assert.deepEqual(picked,['openai-direct:gpt-6','openai-direct:gpt-6-mini']);
// Reasoning control.
(q('[aria-label="Reasoning effort"] [role="radio"]').find(button=>button.textContent==='Light') as HTMLButtonElement).click();
assert.deepEqual(efforts,['low']);
root.unmount();

// Roving-focus host (default-model pickers): a first non-model row, focus on the current choice, one provider → no rail.
focused=null;
root=createRoot(host,{onUncaughtError:error=>(errors as unknown[]).push(error)});
root.render(<ModelPicker providers={[providers[1]]} selected={{providerId:'openai-direct',model:'gpt-6-mini'}} onSelect={model=>picked.push(model.id)} initialFocus="selected"
  emptyOption={{label:'Built-in default',selected:false,onSelect:()=>empty++}}/>);
await delay(40);
assert.equal(document.querySelector('.model-picker-rail'),null,'a single provider needs no rail');
assert.deepEqual(names(),['Built-in default','GPT-6','GPT-6 Mini']);
assert.equal(focused,options()[2],'focus lands on the current choice');
key(focused,'ArrowDown');
assert.equal(focused,options()[0]);
options()[0]!.click();
assert.equal(empty,1);
assert.equal(document.querySelector('.model-picker-effort'),null,'no reasoning control without efforts');
root.unmount();
assert.deepEqual(errors,[]);
console.log('Shared model picker passed: opens on the current provider, compact rows, collapsed Auto routes, cross-provider search, hidden note, keyboard, default row.');
