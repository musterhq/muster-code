/** #html-preview, DOM: the sandboxed frame of an agent page (sandbox attributes, theme fragment and live theme message, height
 *  batching, link gating, lazy mount), the render_html card (network opt-in), the unreachable page and the local server
 *  cards. linkedom has no layout: sizes are stubbed. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html data-theme="dark"><body><div id="root"></div></body></html>');
let observers:Array<{callback:(entries:Array<{isIntersecting:boolean}>)=>void;disconnected:boolean}>=[];
class FakeIntersectionObserver{entry:{callback:(entries:Array<{isIntersecting:boolean}>)=>void;disconnected:boolean};constructor(callback:(entries:Array<{isIntersecting:boolean}>)=>void){this.entry={callback,disconnected:false};observers.push(this.entry);}observe(){}disconnect(){this.entry.disconnected=true;}unobserve(){}}
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},IntersectionObserver:FakeIntersectionObserver});
Object.defineProperty(globalThis,'navigator',{value:{userActivation:{isActive:true},platform:'MacIntel',userAgent:'node'},configurable:true});
const computed={getPropertyValue:()=>'',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'};
Object.assign(globalThis,{getComputedStyle:()=>computed});window.getComputedStyle=()=>computed;
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:600,bottom:300,width:600,height:300};};
const calls:Array<[string,any]>=[];
let page={id:'b'.repeat(32),title:'Revenue dashboard',html:'<h1 style="color:var(--foreground)">Revenue</h1>',networkRequested:true,networkAllowed:false,createdAt:'2026-10-18T00:00:00Z'};
let ports:any[]=[];
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){
  calls.push([command,input]);
  if(command==='reports.open')return {url:`muster-report://${'a'.repeat(32)}/index.html?v=1`,token:'a'.repeat(32)};
  if(command==='htmlRenders.open')return {url:`muster-report://${'c'.repeat(32)}/index.html?v=1`,token:'c'.repeat(32),page};
  if(command==='htmlRenders.allowNetwork'){page={...page,networkAllowed:true};return page;}
  if(command==='processes.ports')return {chatId:input.chatId,ports,supported:true,scannedAt:''};
  if(command==='previews.open')return {owner:'agent:c1',profileId:'personal',url:input.url};
  return undefined;
}};
setTimeout(()=>{console.error('html-preview-components: timed out');process.exit(4);},90_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=60)=>{root.render(node);await delay(wait);};
const until=async(check:()=>unknown,ms=6000)=>{for(let waited=0;waited<ms;waited+=25){if(check())return;await delay(25);}assert.fail('condition not reached: '+check.toString().slice(0,120));};
const click=async(el:Element|null,wait=40)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);
const $$=(selector:string,scope:ParentNode=document)=>[...scope.querySelectorAll(selector)];
const post=(source:unknown,origin:string,data:unknown)=>{const event=new window.Event('message') as any;event.source=source;event.origin=origin;event.data=data;window.dispatchEvent(event);};

const {SandboxedHtml,linkAllowed}=await import('../src/renderer/components/SandboxedHtml');
const {default:HtmlRenderCard}=await import('../src/renderer/components/rich/HtmlRenderCard');
const {PreviewUnreachable}=await import('../src/renderer/components/PreviewUnreachable');
const {LocalServerCards,webServers}=await import('../src/renderer/components/LocalServerCards');
const {getState}=await import('../src/renderer/store');
const {THEME_FRAGMENT_KEY}=await import('../src/shared/html-render');

// ---- the frame of an agent page --------------------------------------------------------------------------------------------
{
  await show(<SandboxedHtml html="<p>hi</p>" scripts themed title="Page" storeKey="p1"/>,300);
  const frame=$('iframe.sandboxed-html-frame')!;
  assert.ok(frame,'a frame');
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts','never allow-same-origin, popups, forms, downloads or top navigation');
  assert.doesNotMatch(frame.getAttribute('sandbox')!,/same-origin/);
  assert.equal(frame.getAttribute('referrerpolicy')??frame.getAttribute('referrerPolicy'),'no-referrer');
  assert.equal(frame.getAttribute('allow'),'','no camera, microphone, clipboard or other permission');
  const src=frame.getAttribute('src')!;
  assert.match(src,/^muster-report:\/\/a{32}\/index\.html\?v=1#muster-theme=/,'served from its own origin, the theme in the fragment for the first paint');
  const theme=JSON.parse(decodeURIComponent(src.slice(src.indexOf(`${THEME_FRAGMENT_KEY}=`)+THEME_FRAGMENT_KEY.length+1)));
  assert.equal(theme.appearance,'dark');
  for(const name of ['--background','--foreground','--chart-1','--chart-6','--font-sans','--border']) assert.ok(name in theme.variables,name);
  assert.deepEqual(calls.find(([command])=>command==='reports.open')![1],{html:'<p>hi</p>',scripts:true,key:'p1',themed:true});
  assert.equal($('.sandboxed-html')!.getAttribute('data-themed'),'true');

  // On load the frame gets the theme as one message; a theme switch sends another, without reloading the frame.
  const sent:any[]=[];(frame as any).contentWindow={postMessage:(data:any,target:string)=>sent.push([data,target])};
  frame.dispatchEvent(new window.Event('load'));await delay(30);
  assert.equal(sent.at(-1)[0].muster,'report-theme');assert.equal(sent.at(-1)[0].theme.appearance,'dark');
  document.documentElement.setAttribute('data-theme','light');await delay(60);
  assert.equal(sent.at(-1)[0].theme.appearance,'light','a theme change reaches the open page');
  assert.equal($('iframe')!.getAttribute('src'),src,'the frame is not reloaded for a theme change');

  // Heights: only this frame, and one layout write per frame however often the page reports.
  const heights:number[]=[];
  await show(<SandboxedHtml html="<p>hi</p>" scripts themed title="Page" storeKey="p1" onHeight={h=>heights.push(h)}/>,100);
  const own=(frame as any).contentWindow;
  for(const h of [100,200,300,412.2])post(own,'null',{muster:'report-height',height:h});
  post({},'null',{muster:'report-height',height:999});
  post(own,'https://evil.example',{muster:'report-height',height:998});
  await delay(20);
  assert.deepEqual(heights,[413],'coalesced to the last height, foreign sources ignored');

  // Links: only http(s), only from this frame while it has focus and the person just used the app.
  const tabsBefore=getState().tabs.length;
  post(own,'null',{muster:'report-link',url:'https://example.com/docs'});
  await delay(20);
  assert.equal(getState().tabs.length,tabsBefore,'an unfocused frame cannot open a link');
  assert.equal(linkAllowed(frame as any,own,frame,true),true);
  assert.equal(linkAllowed(frame as any,own,frame,false),false,'no recent user activation');
  assert.equal(linkAllowed(frame as any,{} as any,frame,true),false,'another window');
  assert.equal(linkAllowed(frame as any,own,document.body,true),false,'frame not focused');
  (frame as any).focus=()=>{};Object.defineProperty(document,'activeElement',{configurable:true,get:()=>frame});
  post(own,'null',{muster:'report-link',url:'file:///etc/passwd'});
  post(own,'null',{muster:'report-link',url:'javascript:alert(1)'});
  await delay(20);
  assert.equal(getState().tabs.length,tabsBefore,'file: and javascript: links never open');
  post(own,'null',{muster:'report-link',url:'https://example.com/docs'});
  await delay(20);
  assert.equal(getState().tabs.length,tabsBefore+1,'a focused, just-used frame opens an https link in the in-app browser');
  assert.equal(getState().tabs.at(-1)!.kind,'browser');
  Object.defineProperty(document,'activeElement',{configurable:true,get:()=>document.body});

  // An unthemed page (a file preview) ignores link requests altogether and gets no theme.
  await show(<SandboxedHtml key="file" html="<p>file</p>" title="File"/>,200);
  assert.equal($('iframe')!.getAttribute('sandbox'),'','a page that must not run gets every restriction');
  assert.doesNotMatch($('iframe')!.getAttribute('src')!,/muster-theme/);
}

// ---- lazy mount ------------------------------------------------------------------------------------------------------------
{
  await show(null,10);
  observers=[];const before=calls.length;
  await show(<SandboxedHtml html="<p>lazy</p>" scripts themed lazy title="Lazy"/>,200);
  assert.ok(!$('iframe'),'an offscreen page has no frame');
  assert.equal(calls.slice(before).filter(([command])=>command==='reports.open').length,0,'and is not even registered');
  observers.at(-1)!.callback([{isIntersecting:false}]);await delay(60);
  assert.ok(!$('iframe'));
  observers.at(-1)!.callback([{isIntersecting:true}]);
  await until(()=>$('iframe'));
  assert.equal(observers.at(-1)!.disconnected,true,'stops observing once mounted');
}

// ---- render_html card ------------------------------------------------------------------------------------------------------
{
  await show(null,10);
  observers=[];
  await show(<HtmlRenderCard renderId={'b'.repeat(32)} title="Revenue dashboard" chatId="c1"/>,300);
  assert.ok(!$('.rich-block[data-kind=report] iframe'),'not mounted until it nears the viewport');
  observers.at(-1)!.callback([{isIntersecting:true}]);
  await until(()=>$('.rich-block[data-kind=report] iframe'));
  assert.equal($('.rich-title')!.textContent,'Revenue dashboard');
  assert.equal($('.rich-kind')!.textContent,'Page');
  assert.deepEqual(calls.filter(([command])=>command==='htmlRenders.open').at(-1)![1],{id:'b'.repeat(32)},'the renderer names the page; main supplies it and its network grant');
  assert.equal($('iframe')!.getAttribute('sandbox'),'allow-scripts');
  assert.match($('iframe')!.getAttribute('src')!,/^muster-report:\/\/c{32}\/index\.html\?v=1#muster-theme=/);
  const note=$('.rich-network');
  assert.ok(note,'a page that asked for network says so, quietly');
  assert.match(note!.textContent!,/https only/);
  const opens=calls.filter(([command])=>command==='htmlRenders.open').length;
  await click($('.rich-network button'),200);
  assert.deepEqual(calls.filter(([command])=>command==='htmlRenders.allowNetwork').at(-1)![1],{id:'b'.repeat(32)});
  await until(()=>!$('.rich-network'));
  await until(()=>calls.filter(([command])=>command==='htmlRenders.open').length>opens);
  const labels=$$('.rich-actions [aria-label]').map(el=>el.getAttribute('aria-label'));
  assert.deepEqual(labels,['Copy source','Download','Open in tab','Full screen'],'the standard chrome');
  await click($('[aria-label="Full screen"]'),200);
  assert.ok($('.rich-full'),'full screen');
  assert.ok($('.rich-full [aria-label="Zoom in"]'),'full screen has zoom');
  await click($('.rich-full [aria-label="Zoom in"]'),60);
  assert.equal($('.rich-full .rich-zoom-level')!.textContent,'125%');
  await click($('[aria-label="Close full screen"]'),200);
}

// ---- unreachable page ------------------------------------------------------------------------------------------------------
{
  await show(null,10);
  let reloads=0;
  await show(<PreviewUnreachable url="http://localhost:5173/" code={-102} description="ERR_CONNECTION_REFUSED" onReload={()=>reloads++} onOpenExternal={()=>{}}/>,60);
  assert.match($('[role=alert]')!.textContent!,/This preview isn’t running/);
  assert.match($('[role=alert]')!.textContent!,/localhost:5173: Connection refused/);
  assert.match($('[role=alert]')!.textContent!,/ERR_CONNECTION_REFUSED/);
  assert.ok(!$$('button').some(b=>/default browser/.test(b.textContent??'')),'a local server that is down is not sent to another browser');
  await click($$('button').find(b=>b.textContent==='Details')!);
  assert.match($('.browser-unreachable-tips')!.textContent!,/dev server is running/);
  await click($$('button').find(b=>b.textContent==='Reload')!);
  assert.equal(reloads,1);
  await show(<PreviewUnreachable url="https://nowhere.example/" code={-105} description="ERR_NAME_NOT_RESOLVED" onReload={()=>{}} onOpenExternal={()=>{}}/>,60);
  assert.match($('[role=alert]')!.textContent!,/This site can’t be reached[\s\S]*DNS address could not be found/);
}

// ---- local server cards ----------------------------------------------------------------------------------------------------
{
  await show(null,10);
  const port=(id:string,n:number,web:boolean|undefined,owner='agent')=>({id,port:n,address:'*',name:'node',owner,source:owner==='agent'?{kind:'agent'}:{kind:'terminal',id:'t1'},...(web===undefined?{}:{web})});
  assert.deepEqual(webServers([port('a',5173,true),port('b',9229,false),port('c',3000,undefined),port('d',5173,true,'user')] as any,new Set()).map(p=>p.id),['a'],'only web servers, one card per port');
  ports=[port('a',5173,true),port('b',9229,false)];
  await show(<LocalServerCards chatId="c1"/>,200);
  await until(()=>$('.local-server'));
  assert.equal($$('.local-server').length,1);
  assert.match($('.local-server')!.textContent!,/Local server[\s\S]*localhost:5173/);
  await click($$('.local-server-action').find(b=>/Preview/.test(b.textContent??''))!);
  assert.deepEqual(calls.filter(([command])=>command==='previews.open').at(-1)![1],{chatId:'c1',url:'http://localhost:5173'});
  const before=getState().tabs.length;
  await click($$('.local-server-action').find(b=>/Open/.test(b.textContent??''))!);
  assert.equal(getState().tabs.length,before+1,'Open puts it in the right pane');
  await click($('.local-server-dismiss'));
  assert.ok(!$('.local-server'),'dismissed');
}

await show(null,10);
assert.deepEqual(errors,[],'no uncaught render errors');
console.log('html-preview-components: ok');
process.exit(0);
