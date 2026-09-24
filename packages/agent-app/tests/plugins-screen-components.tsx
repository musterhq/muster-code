/** S3-F (QA-#19/#20): Discover dedupes curated sources, installed → Manage, unsupported behind a filter, one icon tile; Installed hides .system skills. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
const logo={kind:'image',dataUrl:'data:image/png;base64,AA=='};
const caps={mcpServers:[],apps:[],hooks:[],skills:[],commands:[],agents:[]};
const pkg=(source:string,name:string,extra:any={})=>({id:`${source}:${name}`,sourceId:source,sourceLabel:source,name,kind:'plugin',displayName:name[0].toUpperCase()+name.slice(1),version:'1.0.0',capabilities:caps,compatibility:{format:'codex',supported:true,unsupported:[],notes:[]},...extra});
const catalog=[pkg('openai-curated','figma'),pkg('openai-curated-remote','figma'),pkg('openai-curated','slack'),pkg('openai-curated-remote','slack'),pkg('claude','hookify',{compatibility:{format:'claude',supported:false,unsupported:['hooks'],notes:[]}}),pkg('claude','notion')];
const plugins=[{id:'/cache/slack',name:'slack',displayName:'Slack',version:'0.1.8',provenance:'openai-curated-remote',path:'/cache/slack',skills:[],mcpServers:[],apps:[],readError:null,icon:logo},{id:'/cache/figma',name:'figma',displayName:'Figma',version:'1',provenance:'openai-curated',path:'/cache/figma',skills:[],mcpServers:[],apps:[],readError:null,icon:logo}];
const skills=[{id:'/h/.codex/skills/pdf',name:'pdf',provenance:'~/.codex/skills',path:'/h/.codex/skills/pdf',readme:null,readError:null},{id:'/h/.codex/skills/.system/imagegen',name:'imagegen',provenance:'~/.codex/skills',path:'/h/.codex/skills/.system/imagegen',readme:null,readError:null}];
(window as any).muster={subscribe(){return()=>{};},async invoke(command:string){
  if(command==='app.snapshot')return {chats:[],folders:[],projects:[],version:1,activeChatId:null};
  if(command==='extensions.sources.list')return [{id:'openai-curated',kind:'local',label:'openai-curated',addedAt:''},{id:'claude',kind:'local',label:'claude',addedAt:''}];
  if(command==='extensions.catalog')return catalog;
  if(command==='extensions.installed')return [];
  if(command==='extensions.enablement.list')return [];
  if(command==='extensions.inventory')return {skills,plugins};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {PluginsScreen}=await import('../src/renderer/components/PluginsScreen');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<PluginsScreen/>);await delay(80);
assert.deepEqual(errors,[]);
Array.from(document.querySelectorAll<HTMLButtonElement>('.plugins-view-tabs [role="tab"]')).find(tab=>/Discover/.test(tab.textContent??''))!.click();await delay(30);
const names=()=>Array.from(document.querySelectorAll('.plugins-card-text strong')).map(node=>node.textContent);
assert.deepEqual(names(),['Figma','Slack','Notion'],'no duplicates across curated sources; unsupported hidden by default');
assert.equal(document.querySelector('.plugins-view-tabs [role="tab"] span')?.textContent,'3','Discover counts what it shows');
// Installed anywhere (here: in Codex) → Manage, never Install.
assert.ok(document.querySelector('[aria-label="Manage Slack"]'));
assert.equal(document.querySelector('[aria-label="Install Slack"]'),null);
assert.match(document.querySelector('.plugins-card.is-installed')?.textContent??'',/Installed in Codex/);
assert.ok(document.querySelector('[aria-label="Install Notion"]'));
// Every card icon sits in the same 36px tile; real logos where a manifest has one.
const tiles=Array.from(document.querySelectorAll<HTMLElement>('.plugins-card .plugins-tile'));
assert.equal(tiles.length,3);assert.ok(tiles.every(tile=>tile.style.width==='36px'&&tile.style.height==='36px'));
assert.equal(document.querySelectorAll('.plugins-card .plugins-tile.is-image').length,2,'Figma and Slack show their logos, Notion a monogram');
// Unsupported entries live behind a filter.
const filter=document.querySelector<HTMLButtonElement>('.plugins-unsupported-filter');
assert.ok(filter);assert.match(filter!.textContent??'',/Unsupported\s*1/);
filter!.click();await delay(30);
assert.deepEqual(names(),['Figma','Slack','Hookify','Notion']);
assert.match(Array.from(document.querySelectorAll('.plugins-card')).find(card=>/Hookify/.test(card.textContent??''))?.textContent??'',/Unsupported/);
// Manage jumps to the Installed detail of that plugin.
document.querySelector<HTMLButtonElement>('[aria-label="Manage Slack"]')!.click();await delay(30);
assert.equal(document.querySelector('[role="tab"][aria-selected="true"]')?.textContent?.startsWith('Installed'),true);
assert.equal(document.querySelector('.plugin-detail-name')?.textContent,'Slack');
// Installed: the .system skill is not a user skill; rows use the same 28px tile.
document.querySelector<HTMLButtonElement>('.plugins-detail-back')!.click();await delay(30);
const rows=Array.from(document.querySelectorAll('.plugins-row .plugins-card-text strong')).map(node=>node.textContent);
assert.ok(rows.includes('pdf'));assert.ok(!rows.includes('imagegen'),'.system skills are excluded');
assert.ok(Array.from(document.querySelectorAll<HTMLElement>('.plugins-row .plugins-tile')).every(tile=>tile.style.width==='28px'));
root.unmount();
assert.deepEqual(errors,[]);
console.log('Plugins screen checks passed: deduped Discover, Manage for installed, unsupported filter, uniform icon tiles and logos, .system skills excluded.');
