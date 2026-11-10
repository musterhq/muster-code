/** #844, DOM: an MCP app drawn under its tool row (the sandboxed frame, the bridge answering only that frame, tools/call routed
 *  to the host for this chat and row, the network opt-in) and the fallback to the tool's text result. linkedom runs no frame:
 *  the frame's window is a fake that records what the host posts to it. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html data-theme="dark"><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
Object.defineProperty(globalThis,'navigator',{value:{userActivation:{isActive:false},platform:'MacIntel',userAgent:'node'},configurable:true});
const computed={getPropertyValue:()=>'',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'};
Object.assign(globalThis,{getComputedStyle:()=>computed});window.getComputedStyle=()=>computed;
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:600,bottom:300,width:600,height:300};};
const calls:Array<[string,any]>=[];
let failOpen=false,app={html:'<h1>Board</h1>',uri:'ui://board/app.html',server:'board',tool:'show_board',title:'Board',toolInput:{board:'roadmap'},toolResult:{content:[{type:'text',text:'Board has 3 cards'}]},networkRequested:true,networkAllowed:false,domains:{connect:['https://api.example.com'],resource:[]}};
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){
  calls.push([command,input]);
  if(command==='mcpApps.open'){if(failOpen)throw new Error('The server board is not available.');return {url:`muster-report://${'d'.repeat(32)}/index.html?v=1`,token:'d'.repeat(32),app};}
  if(command==='mcp.apps.allowNetwork'){app={...app,networkAllowed:true};return {networkAllowed:true};}
  if(command==='mcp.apps.callTool')return {content:[{type:'text',text:`${input.name} ok`}]};
  return undefined;
}};
setTimeout(()=>{console.error('mcp-apps-844-dom: timed out');process.exit(4);},60_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=80)=>{root.render(node);await delay(wait);};
const until=async(test:()=>unknown,ms=6000)=>{for(let waited=0;waited<ms;waited+=25){if(test())return;await delay(25);}assert.fail('condition not reached: '+test.toString().slice(0,120));};
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);
const post=(source:unknown,origin:string,data:unknown)=>{const event=new window.Event('message') as any;event.source=source;event.origin=origin;event.data=data;window.dispatchEvent(event);};
const click=async(el:Element|null,wait=60)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};

const {default:McpAppCard}=await import('../src/renderer/components/rich/McpAppCard');

// Spec: MUS-SPEC-21-844I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844i)
await check('an MCP app row draws in the scripts-only sandbox and answers the app over the bridge',async()=>{
  await show(<McpAppCard chatId="c1" itemId="t1" title="board / show_board" fallback="Board has 3 cards"/>,200);
  await until(()=>$('iframe.sandboxed-html-frame'));
  const frame=$('iframe.sandboxed-html-frame')!;
  assert.deepEqual(calls.find(([command])=>command==='mcpApps.open')![1],{chatId:'c1',itemId:'t1'});
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts','scripts only, never same-origin');
  assert.equal(frame.getAttribute('referrerpolicy')??frame.getAttribute('referrerPolicy'),'no-referrer');
  assert.equal(frame.getAttribute('allow'),'','no permissions');
  assert.match(frame.getAttribute('src')!,/^muster-report:\/\/d{32}\/index\.html\?v=1/,'its own origin');
  const sent:any[]=[];const contentWindow={postMessage:(data:any)=>sent.push(data)};(frame as any).contentWindow=contentWindow;
  frame.dispatchEvent(new window.Event('load'));await delay(30);
  post(contentWindow,'null',{jsonrpc:'2.0',id:1,method:'ui/initialize',params:{appCapabilities:{}}});
  await until(()=>sent.some(message=>message.id===1));
  assert.equal(sent.find(message=>message.id===1).result.protocolVersion,'2026-01-26');
  post(contentWindow,'null',{jsonrpc:'2.0',method:'ui/notifications/initialized'});
  await until(()=>sent.some(message=>message.method==='ui/notifications/tool-result'));
  assert.deepEqual(sent.filter(message=>message.method).map(message=>message.method),['ui/notifications/tool-input','ui/notifications/tool-result']);
  assert.deepEqual(sent.find(message=>message.method==='ui/notifications/tool-input').params,{arguments:{board:'roadmap'}});
  post(contentWindow,'null',{jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'count',arguments:{column:'todo'}}});
  await until(()=>sent.some(message=>message.id===2));
  assert.deepEqual(calls.find(([command])=>command==='mcp.apps.callTool')![1],{chatId:'c1',itemId:'t1',name:'count',arguments:{column:'todo'}});
  assert.deepEqual(sent.find(message=>message.id===2).result,{content:[{type:'text',text:'count ok'}]});
  const before=sent.length,toolCalls=calls.filter(([command])=>command==='mcp.apps.callTool').length;
  post({postMessage(){}},'null',{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'move_card',arguments:{}}});
  post(contentWindow,'https://evil.example',{jsonrpc:'2.0',id:4,method:'tools/call',params:{name:'move_card',arguments:{}}});
  await delay(60);
  assert.equal(sent.length,before,'another window or origin gets no answer');
  assert.equal(calls.filter(([command])=>command==='mcp.apps.callTool').length,toolCalls,'and reaches no tool');
  // The resource asked for network: the card offers Allow for this page, which reopens it with the grant.
  const allow=[...document.querySelectorAll('.rich-network button')].find(button=>/Allow for this page/.test(button.textContent??''));
  assert.ok(allow,'Allow for this page is offered');
  const opens=calls.filter(([command])=>command==='mcpApps.open').length;
  await click(allow!,200);
  assert.deepEqual(calls.find(([command])=>command==='mcp.apps.allowNetwork')![1],{chatId:'c1',itemId:'t1'});
  await until(()=>calls.filter(([command])=>command==='mcpApps.open').length>opens);
  await until(()=>!$('.rich-network'));
  assert.deepEqual(errors,[]);
});

// Spec: MUS-SPEC-21-844H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-844h)
await check("an MCP app that cannot load shows the tool's text result instead",async()=>{
  await show(null,20);
  failOpen=true;
  await show(<McpAppCard chatId="c1" itemId="t2" title="board / show_board" fallback="Board has 3 cards"/>,200);
  await until(()=>$('.mcp-app-fallback'));
  assert.match($('.mcp-app-fallback')!.textContent??'',/Board has 3 cards/);
  assert.equal($('iframe'),null,'no frame');
  assert.equal($('.sandboxed-html-loading'),null,'no endless loading state');
  assert.deepEqual(errors,[]);
});
root.unmount();
process.exit(0);
