import {test} from 'node:test';
import assert from 'node:assert/strict';
import {parseHTML} from 'linkedom';
import {runInNewContext} from 'node:vm';
import {settingsHtml} from '../src/settings-view.js';
import {MUSTER_THEMES} from '../src/appearance.js';
test('appearance offers all palettes, real controls, and routes theme selection without changing model policy',()=>{
  const {window}=parseHTML(settingsHtml('test:'));const document=window.document;const posted:any[]=[];
  const sandbox={window,document,console,acquireVsCodeApi:()=>({postMessage:(m:any)=>posted.push(m)})};
  for(const script of document.querySelectorAll('script'))runInNewContext(script.textContent!,sandbox);
  const event=new window.Event('message');(event as any).data={type:'section',section:'appearance',data:{themes:MUSTER_THEMES,active:'Muster Dark',density:'comfortable',fontSize:13,accent:''}};window.dispatchEvent(event);
  assert.equal(document.querySelectorAll('[data-theme]').length,5);
  (document.querySelector('[data-theme="Muster Sand"]') as any).click();assert.equal(posted.at(-1).type,'theme');assert.equal(posted.at(-1).name,'Muster Sand');
  assert.equal(document.querySelectorAll('[data-appearance]').length,4); assert.equal((document.querySelector('[data-appearance="ui.glass"]') as any).hasAttribute('checked'), true);
});

test('general access copy does not present an unbound selector',()=>{
  const {window}=parseHTML(settingsHtml('test:'));const document=window.document;
  const sandbox={window,document,console,acquireVsCodeApi:()=>({postMessage:()=>{}})};
  for(const script of document.querySelectorAll('script'))runInNewContext(script.textContent!,sandbox);
  const event=new window.Event('message');(event as any).data={type:'section',section:'general',data:{account:null,limits:null,access:[{id:'full',label:'Full access'}],settings:{model:'astra',effort:'high',completions:false}}};window.dispatchEvent(event);
  assert.equal(document.getElementById('acc'),null);assert.match(document.getElementById('main')!.textContent!,/selected per thread/i);
});

test('rules and MCP switches emit one domain action each',()=>{
  const {window}=parseHTML(settingsHtml('test:'));const document=window.document;const posted:any[]=[];
  const sandbox={window,document,console,acquireVsCodeApi:()=>({postMessage:(m:any)=>posted.push(m)})};
  for(const script of document.querySelectorAll('script'))runInNewContext(script.textContent!,sandbox);
  let event=new window.Event('message');(event as any).data={type:'section',section:'rules',data:{rules:[{name:'style',source:'project',kind:'always',enabled:true,path:'/style.md'}]}};window.dispatchEvent(event);
  (document.querySelector('[data-rule]') as any).click();assert.equal(posted.at(-1).type,'toggleRule');assert.equal(posted.at(-1).name,'style');assert.equal(posted.filter((m)=>m.type==='set').length,0);
  event=new window.Event('message');(event as any).data={type:'section',section:'mcp',data:{servers:[{name:'docs',enabled:true,tools:[]}]}};window.dispatchEvent(event);
  (document.querySelector('[data-mcp]') as any).click();assert.equal(posted.at(-1).type,'toggleMcp');assert.equal(posted.at(-1).name,'docs');assert.equal(posted.filter((m)=>m.type==='set').length,0);
});
