/** #829 part 2, DOM: a render_html card whose page the agent updated in place keeps every version behind a "v2 of 3" switch.
 *  The versions are the page's linked canvas (part 1's model): version 1 the stored page, the user's edits drawn from their
 *  text, the agent's updates drawn from the stored page each names. The bridge is backed by the real canvas store on an
 *  in-memory SQLite database; canvas events come through the bridge's subscription like in the app. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
Object.defineProperty(globalThis,'navigator',{value:{userActivation:{isActive:true},platform:'MacIntel',userAgent:'node'},configurable:true});
const computed={getPropertyValue:()=>'',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'};
Object.assign(globalThis,{getComputedStyle:()=>computed});window.getComputedStyle=()=>computed;
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:600,bottom:300,width:600,height:300};};

const {CanvasStore}=await import('../src/runtime/canvases.ts');
const {summaryOf}=await import('../src/runtime/canvases.ts');
const db=new DatabaseSync(':memory:');
const store=new CanvasStore(()=>db);
const calls:Array<[string,any]>=[];
const stored=(id:string,title:string,html:string)=>({id,title,html,networkRequested:false,networkAllowed:false,createdAt:'2026-11-09T00:00:00Z'});
const original=stored('e'.repeat(32),'Revenue','<h1>Revenue</h1>');
const update=stored('f'.repeat(32),'Revenue by region','<h1>Revenue by region</h1>');
const final=stored('a'.repeat(32),'Revenue, final','<h1>Revenue, final</h1>');
const pages=new Map([original,update,final].map(page=>[page.id,page]));
const listeners=new Set<(event:any)=>void>();
let reportCount=0;
(window as any).muster={subscribe:(listener:(event:any)=>void)=>{listeners.add(listener);return ()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push([command,input]);
  switch(command){
    case 'artifacts.canvas.list':return {canvases:store.list(input?.chatId)};
    case 'artifacts.canvas.get':return store.get(input.id);
    case 'artifacts.canvas.versions':return {versions:store.versions(input.id)};
    case 'artifacts.canvas.version':return store.version(input.id,input.version);
    case 'artifacts.sideChat.list':return {sideChats:[]};
    case 'reports.open':reportCount++;return {url:`muster-report://${'b'.repeat(32)}/index.html?v=${reportCount}`,token:'b'.repeat(32)};
    case 'htmlRenders.open':{const page=pages.get(input.id);if(!page)throw new Error('This page is no longer available.');return {url:`muster-report://${'c'.repeat(32)}/index.html?id=${input.id}`,token:'c'.repeat(32),page};}
    default:return undefined;
  }
}};
setTimeout(()=>{console.error('visual-update-829-dom: timed out');process.exit(4);},120_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=60)=>{root.render(node);await delay(wait);};
const until=async(test:()=>unknown,ms=4000)=>{for(let waited=0;waited<ms;waited+=25){if(test())return;await delay(25);}assert.fail('condition not reached: '+test.toString().slice(0,160));};
const click=async(el:Element|null,wait=60)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);

const {default:HtmlRenderCard}=await import('../src/renderer/components/rich/HtmlRenderCard');
const {ensureArtifactSync}=await import('../src/renderer/artifacts');
ensureArtifactSync();

const CHAT='chat829u';
const visual={kind:'page' as const,key:`page:${original.id}`};

let failed=0;
const opened=()=>calls.filter(([command])=>command==='htmlRenders.open').map(([,input])=>input.id as string);
const reports=()=>calls.filter(([command])=>command==='reports.open').map(([,input])=>input);
const versionLabel=()=>$('[aria-label="Version"]')?.textContent?.replace(/\s+/g,' ').trim()??'';
const frameSrc=()=>$('.rich-body iframe')?.getAttribute('src')??'';

// Spec: MUS-SPEC-21-829K (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829k)
await check('the page card keeps earlier versions behind a v2-of-3 switch and follows the agent\'s update', async()=>{
  // Version 1 the page as shown, 2 the user's edit (part 1's Save), 3 the agent's update through render_html(replaces).
  const first=store.create({kind:'html',title:'Revenue',content:original.html,chatId:CHAT,visual,note:'Original from the chat'},'user');
  store.update(first.id,{content:'<h1>Revenue (mine)</h1>',baseVersion:1,note:'Edited in the chat'},'user');
  store.agentVisualVersion({chatId:CHAT,visual,title:update.title,original:original.html,content:update.html,note:`Updated by the agent (muster-html:${update.id})`});
  await show(<HtmlRenderCard renderId={original.id} title="Revenue" chatId={CHAT}/>,120);
  await until(()=>/v3 of 3/.test(versionLabel()),4000);
  await until(()=>opened().includes(update.id),4000);
  await until(()=>frameSrc().includes(`id=${update.id}`));
  assert.equal($('.rich-title')?.textContent,'Revenue by region','the header names the version shown');
  const previous=()=>$('[aria-label="Previous version"]') as HTMLButtonElement|null,next=()=>$('[aria-label="Next version"]') as HTMLButtonElement|null;
  assert.ok(previous()&&next(),'previous and next sit in the header');
  assert.equal(next()!.disabled,true,'the newest version is shown');

  const before=reports().length;
  await click(previous(),120);
  await until(()=>/v2 of 3/.test(versionLabel()));
  await until(()=>reports().slice(before).some(input=>/Revenue \(mine\)/.test(input.html)),3000);
  const drawn=reports().slice(before).find(input=>/Revenue \(mine\)/.test(input.html))!;
  assert.equal(drawn.scripts,true);assert.equal(drawn.themed,true,'the user\'s edit is drawn from its text, themed and scripts-only');
  assert.equal($('.rich-body iframe')!.getAttribute('sandbox'),'allow-scripts');

  await click(previous(),120);
  await until(()=>/v1 of 3/.test(versionLabel()));
  await until(()=>frameSrc().includes(`id=${original.id}`),3000);
  assert.equal(previous()!.disabled,true,'version 1 is the oldest');
  assert.equal($('.rich-title')?.textContent,'Revenue');

  await click(next(),120);
  await until(()=>/v2 of 3/.test(versionLabel()));
  await click(previous(),120);
  await until(()=>/v1 of 3/.test(versionLabel()));

  // The agent updates the page again while version 1 is shown: the card jumps to the newest.
  const result=store.agentVisualVersion({chatId:CHAT,visual,title:final.title,original:original.html,content:final.html,note:`Updated by the agent (muster-html:${final.id})`});
  for(const listener of [...listeners])listener({type:'canvasChanged',canvas:summaryOf(result.canvas)});
  await until(()=>/v4 of 4/.test(versionLabel()),3000);
  await until(()=>frameSrc().includes(`id=${final.id}`),3000);
  assert.equal($('.rich-title')?.textContent,'Revenue, final');
  assert.equal(errors.length,0,'nothing threw');
}).catch(async error=>{failed++;console.error(error);await show(<div/>);});

await show(<div/>);
root.unmount();
if(failed){console.error(`visual-update-829-dom: ${failed} check(s) failed`);process.exit(1);}
process.exit(0);
