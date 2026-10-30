// #776 (DOM): Skills & plugins › Installed lists Muster's plugins, each with a picker for Muster's version, an installed one or off.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});

const muster=(id:string,form='skill')=>({id:`muster:${id}`,origin:'muster',form,name:id,source:'Muster',version:'0.9.0',path:`/app/skills/${id}`});
const installedDocs={id:'/h/.codex/plugins/cache/other/documents',origin:'installed',form:'plugin',name:'Documents',source:'Plugin cache · other',version:'1.4.0',path:'/h/.codex/plugins/cache/other/documents'};
const installedDocx={id:'/h/.codex/skills/docx',origin:'installed',form:'skill',name:'docx',source:'Skills folder · ~/.codex/skills',version:'3.1',path:'/h/.codex/skills/docx'};
const installedViz={id:'/h/.codex/plugins/cache/bundled/visualize',origin:'installed',form:'plugin',name:'Visualize',source:'Plugin cache · bundled',version:'1.0.57',path:'/h/.codex/plugins/cache/bundled/visualize'};
const choices:Record<string,{choice:string;installedId?:string}>={visualize:{choice:'installed',installedId:installedViz.id}};
const rows=()=>[
  {id:'documents',displayName:'Documents',muster:muster('documents'),installed:[installedDocs,installedDocx]},
  {id:'visualize',displayName:'Visualize',muster:muster('visualize','tool'),installed:[]},
].map(row=>{
  const stored=choices[row.id]??{choice:'muster'};
  const picked=stored.choice==='installed'?row.installed.find(entry=>entry.id===stored.installedId)??null:null;
  const missing=stored.choice==='installed'&&!picked;
  return {...row,choice:stored.choice,...(stored.installedId?{installedId:stored.installedId}:{}),active:stored.choice==='off'?null:picked??row.muster,...(missing?{missing:true}:{})};
});
const sets:any[]=[];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  if(command==='app.snapshot')return {chats:[],folders:[],projects:[],version:1,activeChatId:null};
  if(command==='extensions.sources.list'||command==='extensions.catalog'||command==='extensions.installed'||command==='extensions.enablement.list')return [];
  if(command==='extensions.inventory')return {skills:[],plugins:[]};
  if(command==='extensions.providers.list')return rows();
  if(command==='extensions.providers.set'){sets.push(input);choices[input.capability]={choice:input.choice,...(input.installedId?{installedId:input.installedId}:{})};return rows();}
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {PluginsScreen}=await import('../src/renderer/components/PluginsScreen');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<PluginsScreen/>);await delay(80);
Array.from(document.querySelectorAll<HTMLButtonElement>('.plugins-view-tabs [role="tab"]')).find(tab=>/Installed/.test(tab.textContent??''))!.click();await delay(40);

const group=()=>Array.from(document.querySelectorAll('.plugins-group')).find(node=>node.querySelector('h3')?.textContent==="Muster's plugins");
const row=(name:string)=>Array.from(group()?.querySelectorAll('.plugins-row')??[]).find(node=>node.querySelector('.plugins-card-text strong')?.textContent===name) as HTMLElement|undefined;
const picker=(name:string)=>row(name)?.querySelector('select') as HTMLSelectElement|null|undefined;
const pick=async(name:string,value:string)=>{const select=picker(name)!;select.value=value;select.dispatchEvent(new window.Event('change',{bubbles:true}));await delay(40);};

// Spec: MUS-SPEC-14-776F (docs/spec/clauses/14-agents-skills-plugins-and-automations.md#mus-spec-14-776f)
await check("#776 each plugin row picks Muster's version, an installed one or off",async()=>{
  assert.ok(group(),"a Muster's plugins group on the Installed tab");
  assert.deepEqual(Array.from(group()!.querySelectorAll('.plugins-row .plugins-card-text strong')).map(node=>node.textContent),['Documents','Visualize']);
  assert.ok(row('Documents')!.querySelector('.plugins-tile'),'the usual row tile');
  assert.match(row('Documents')!.querySelector('.plugins-card-text em')!.textContent!,/Muster's · 0\.9\.0/);
  const options=Array.from(picker('Documents')!.querySelectorAll('option')).map(option=>option.textContent);
  assert.deepEqual(options,["Muster's",'Documents 1.4.0 · Plugin cache · other','docx 3.1 · Skills folder · ~/.codex/skills','Off']);
  assert.equal(picker('Documents')!.getAttribute('aria-label'),'Documents version');
  assert.equal(picker('Documents')!.value,'muster',"Muster's is selected by default");

  await pick('Documents',`installed:${installedDocs.id}`);
  assert.deepEqual(sets.at(-1),{capability:'documents',choice:'installed',installedId:installedDocs.id});
  assert.match(row('Documents')!.querySelector('.plugins-card-text em')!.textContent!,/Documents · 1\.4\.0 · Plugin cache · other/);
  assert.equal(picker('Documents')!.value,`installed:${installedDocs.id}`);

  await pick('Documents','off');
  assert.deepEqual(sets.at(-1),{capability:'documents',choice:'off'});
  assert.match(row('Documents')!.querySelector('.plugins-card-text em')!.textContent!,/Off/);
  assert.ok(row('Documents')!.classList.contains('is-disabled'),'an off row looks like a disabled row');

  // The installed Visualize that was chosen is gone: the row says Muster's is in use.
  assert.match(row('Visualize')!.querySelector('.plugins-badge')?.textContent??'',/Installed version missing · Muster's in use/);
  assert.match(row('Visualize')!.querySelector('.plugins-card-text em')!.textContent!,/Muster's · 0\.9\.0/);
  assert.deepEqual(errors,[]);
});
root.unmount();
