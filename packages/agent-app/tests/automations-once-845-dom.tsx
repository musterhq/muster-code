// #845 (DOM): the automation editor offers "Once at a date and time" in its existing Repeat picker, with a date and time
// control and the time zone, and a once automation that already ran reads Done with its run's chat linked.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
// React only listens for input events when the document says it has them.
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});

const TZ=Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC';
const run={id:'r1',automationId:'a1',scheduledFor:'2026-09-18T19:00:00.000Z',trigger:'schedule',status:'completed',startedAt:'2026-09-18T19:00:01.000Z',endedAt:'2026-09-18T19:00:31.000Z',chatId:'c1',version:1};
const done={id:'a1',name:'Ship notes',prompt:'Write the release notes.',target:{kind:'new',mode:'agent'},schedule:{kind:'once',at:'2026-09-18T15:00'},timezone:'America/New_York',permissionMode:'workspace',overlap:'skip',catchUp:'one',paused:false,createdAt:'',updatedAt:'',version:1,summary:'Once on Fri, Sep 18, 2026 at 3:00 PM (America/New_York)',issues:[],ext:{variables:[],approval:false,activityGate:false,webhook:false},awaiting:0,lastRun:run,done:true};
const calls:{command:string;input:any}[]=[];
let refuse='';
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {chats:[{id:'c1',title:'Release notes chat',folderId:null,projectId:null,archived:false,status:'completed',mode:'agent'}],folders:[],projects:[],version:1,activeChatId:null};
  if(command==='automations.list')return [done];
  if(command==='automations.runs')return [run];
  if(command==='automations.preview')return input.schedule.kind==='once'?{next:['2026-12-01T14:00:00.000Z'],summary:'Once',issues:[]}:{next:[],summary:'',issues:[]};
  if(command==='automations.create'){if(refuse)throw new Error(`automations.create: ${refuse}`);return {...done,id:'a2',name:input.name,schedule:input.schedule,done:undefined,lastRun:undefined,nextRunAt:'2026-12-01T14:00:00.000Z'};}
  if(command==='providers.list'||command==='automations.gate.list')return command==='automations.gate.list'?{items:[]}:[];
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {AutomationsPanel}=await import('../src/renderer/components/AutomationsScreen');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<AutomationsPanel header={button=><div className="header">{button}</div>}/>);await delay(80);

const setValue=async(element:HTMLInputElement|HTMLTextAreaElement,value:string)=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor?.set?descriptor.set.call(element,value):((element as any).value=value);element.dispatchEvent(new window.Event('input',{bubbles:true}));element.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
// linkedom's select.value has no setter: pick the option the way a click on it does.
const pick=async(select:HTMLSelectElement,value:string)=>{for(const option of Array.from(select.querySelectorAll('option')))option.toggleAttribute('selected',option.getAttribute('value')===value);select.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(30);};
// linkedom does not turn a submit button click into a form submit: send the event the click would.
const submit=async()=>{const button=document.querySelector('.automation-editor button[type="submit"]') as HTMLButtonElement;assert.equal(button.disabled,false,'the form is ready to save');document.querySelector('.automation-editor')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(60);};
const labelled=(text:RegExp)=>Array.from(document.querySelectorAll('.automation-editor label')).find(label=>text.test(label.childNodes[0]?.textContent??''));

// Spec: MUS-SPEC-14-845F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-845f)
await check('#845 the editor schedules a once run with a date and time in a named zone, and a run once automation reads Done with its chat linked',async()=>{
  const item=document.querySelector('.automation-item') as HTMLElement;
  assert.ok(item,'the automation is listed, not deleted');
  assert.equal(item.querySelector('.automation-item-when')!.textContent,'Done');
  assert.equal(item.getAttribute('data-state'),'done');
  assert.equal(item.querySelector('.automation-item-meta')!.textContent,'Once on Fri, Sep 18, 2026 at 3:00 PM (America/New_York)');
  (item.querySelector('.automation-item-main') as HTMLButtonElement).click();await delay(60);
  const link=Array.from(item.querySelectorAll('.automation-history .automation-link')).find(node=>/Release notes chat/.test(node.textContent??''));
  assert.ok(link,'its run links the chat it ran in');

  (Array.from(document.querySelectorAll('.header button')).find(button=>/New automation/.test(button.textContent??'')) as HTMLButtonElement).click();await delay(60);
  await setValue(labelled(/^Name/)!.querySelector('input')!,'Launch check');
  await setValue(labelled(/^Prompt/)!.querySelector('textarea')!,'Check the launch page.');
  const repeat=labelled(/^Repeat/)!.querySelector('select') as HTMLSelectElement;
  assert.ok(Array.from(repeat.querySelectorAll('option')).some(option=>option.getAttribute('value')==='once'&&option.textContent==='Once at a date and time'),'the existing Repeat picker offers Once');
  await pick(repeat,'once');
  const when=labelled(/^On/)?.querySelector('input') as HTMLInputElement;
  assert.ok(when,'a date and time control');assert.equal(when.getAttribute('type'),'datetime-local');
  assert.match(when.value,/^\d{4}-\d{2}-\d{2}T09:00$/,'defaults to 9:00 tomorrow');
  assert.equal((labelled(/^Time zone/)!.querySelector('input') as HTMLInputElement).value,TZ,'the zone shows, defaulting to this computer’s');
  await setValue(when,'2026-12-01T09:00');
  await delay(300);
  const preview=calls.filter(call=>call.command==='automations.preview').at(-1)!;
  assert.deepEqual(preview.input.schedule,{kind:'once',at:'2026-12-01T09:00'});
  assert.match(document.querySelector('.automation-preview')!.textContent!,/^Runs at/);
  assert.equal(document.querySelectorAll('.automation-presets [aria-pressed="true"]').length,0,'no repeating preset reads as picked');

  refuse='That time has already passed. Choose a time in the future.';
  await submit();
  assert.equal(document.querySelector('.automation-editor [role="alert"]')!.textContent,refuse,'a refused past time is shown in the editor');
  refuse='';
  await submit();
  const created=calls.filter(call=>call.command==='automations.create').at(-1)!.input;
  assert.deepEqual(created.schedule,{kind:'once',at:'2026-12-01T09:00'});assert.equal(created.timezone,TZ);
  assert.equal(document.querySelector('.automation-editor'),null,'the editor closes on save');
  assert.deepEqual(errors,[]);
});
root.unmount();
