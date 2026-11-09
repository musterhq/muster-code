/** #829 part 1, DOM: you edit any visual in the chat with a live preview. Mermaid, chart and html-report blocks and render_html
 *  cards get an Edit action; the editor shows the source beside a preview that redraws after a pause in typing and keeps the
 *  last good drawing when the source does not parse; Save keeps the edit as a new version of a Canvas linked to the chat and
 *  the visual (the original stays one click away); Cancel discards. The bridge is backed by the real canvas store on an
 *  in-memory SQLite database. linkedom has no layout: sizes are stubbed. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
// React only listens for `input` when the document says it supports it.
(window.document as any).oninput=null;
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
Object.defineProperty(globalThis,'navigator',{value:{userActivation:{isActive:true},platform:'MacIntel',userAgent:'node'},configurable:true});
const computed={getPropertyValue:()=>'',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'};
Object.assign(globalThis,{getComputedStyle:()=>computed});window.getComputedStyle=()=>computed;
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:600,bottom:300,width:600,height:300};};

// The bridge: canvas commands go to the real store; the desktop-only page commands are stubbed.
const {CanvasStore}=await import('../src/runtime/canvases.ts');
const db=new DatabaseSync(':memory:');
const store=new CanvasStore(()=>db);
const calls:Array<[string,any]>=[];
const page={id:'d'.repeat(32),title:'Revenue dashboard',html:'<h1>Revenue</h1>',networkRequested:false,networkAllowed:false,createdAt:'2026-11-01T00:00:00Z'};
let reportCount=0;
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){
  calls.push([command,input]);
  switch(command){
    case 'artifacts.canvas.list':return {canvases:store.list(input?.chatId)};
    case 'artifacts.canvas.get':return store.get(input.id);
    case 'artifacts.canvas.create':return store.create(input,'user');
    case 'artifacts.canvas.update':return store.update(input.id,input,'user');
    case 'artifacts.canvas.versions':return {versions:store.versions(input.id)};
    case 'artifacts.canvas.version':return store.version(input.id,input.version);
    case 'reports.open':reportCount++;return {url:`muster-report://${'a'.repeat(32)}/index.html?v=${reportCount}`,token:'a'.repeat(32)};
    case 'htmlRenders.open':return {url:`muster-report://${'c'.repeat(32)}/index.html?v=1`,token:'c'.repeat(32),page};
    default:return undefined;
  }
}};
setTimeout(()=>{console.error('visual-edit-829-dom: timed out');process.exit(4);},120_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=60)=>{root.render(node);await delay(wait);};
const until=async(test:()=>unknown,ms=4000)=>{for(let waited=0;waited<ms;waited+=25){if(test())return;await delay(25);}assert.fail('condition not reached: '+test.toString().slice(0,160));};
const click=async(el:Element|null,wait=40)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};
const type=(el:Element|null,value:string)=>{assert.ok(el,'a source box to type in');let proto=Object.getPrototypeOf(el),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(el,value);el!.dispatchEvent(new window.Event('input',{bubbles:true}));};
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);
const $$=(selector:string,scope:ParentNode=document)=>[...scope.querySelectorAll(selector)];
const labels=(scope:ParentNode)=>$$('.rich-head > .rich-actions > button, .rich-head > .rich-actions > [aria-label]',scope).map(el=>el.getAttribute('aria-label')??el.textContent??'');
const button=(text:string,scope:ParentNode=document)=>$$('button',scope).find(b=>b.textContent?.trim()===text)??null;

const {MessageBody}=await import('../src/renderer/components/MessageBody');
const {default:HtmlRenderCard}=await import('../src/renderer/components/rich/HtmlRenderCard');
const {setRichRenderers}=await import('../src/renderer/richRenderers');
const {richHash}=await import('../src/shared/rich-fence');
const visualEdits=await import('../src/renderer/visualEdits');

const svgFor=(text:string)=>`<svg width="200" height="100" viewBox="0 0 200 100"><text x="10" y="20">${text}</text></svg>`;
const mermaidSeen:string[]=[];let chartMounted=0,chartDisposed=0;
setRichRenderers({
  async mermaid(source){mermaidSeen.push(source);if(/INVALID/.test(source))throw new Error('Parse error on line 2: expecting a node, got INVALID');return {svg:svgFor(source.split('\n').slice(1).join(' ').trim()),width:200,height:100};},
  async chart(mount){chartMounted++;const values=(mount.spec as any).data?.values??[];mount.container.innerHTML=`<svg data-values="${values.map((row:any)=>row.u).join(',')}" width="10" height="10"></svg>`;return {async resize(){},toSvg:async()=>'<svg/>',toPng:async()=>new Blob(['x']),dispose(){chartDisposed++;}};},
});

let failed=0;
const recordFailure=async(error:unknown)=>{failed++;console.error(error);await show(<div/>);};
const CHAT='chat829';
const ORIGINAL='flowchart LR\n  Draft-->Review';
const reply=(fence:string)=>`Here it is.\n\n${fence}\n\nDone.`;
const diagram=(source=ORIGINAL)=><MessageBody text={reply('```mermaid\n'+source+'\n```')} reports chatId={CHAT}/>;
const stage=(scope:ParentNode=document)=>$('.rich-body .rich-stage',scope)?.innerHTML??'';

// Spec: MUS-SPEC-21-829A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829a)
await check('editing a diagram redraws the preview as you type and keeps the last good drawing on a parse error', async()=>{
  await show(diagram(),20);
  await until(()=>$('.rich-block[data-kind=diagram][data-status=ready] .rich-stage'));
  const block=$('.rich-block')!;
  assert.deepEqual(labels(block),['Edit','Show code','Copy source','Download','Open in tab','Full screen'],'Edit leads the existing header actions');
  const edit=$('[aria-label="Edit"]',block)!;
  assert.equal(edit.getAttribute('aria-pressed'),'false');
  await click(edit,80);
  assert.equal($('[aria-label="Edit"]',block)!.getAttribute('aria-pressed'),'true');
  const editor=$('.rich-edit',block);
  assert.ok(editor,'the editor replaces the drawing in the block body');
  const source=$('textarea',editor!) as HTMLTextAreaElement|null;
  assert.ok(source,'a source box');
  assert.equal(source!.value,ORIGINAL,'it holds the fence as written');
  await until(()=>/Draft--&gt;Review|Draft-->Review/.test(stage(editor!)));

  mermaidSeen.length=0;
  type(source,'flowchart LR\n  Draft-->Review-->Ship');
  await delay(60);
  assert.ok(!mermaidSeen.some(text=>/Ship/.test(text)),'not drawn on every keystroke');
  await until(()=>/Ship/.test(stage(editor!)),2000);
  assert.ok(mermaidSeen.some(text=>/Ship/.test(text)),'drawn once typing paused');

  type($('textarea',editor!),'flowchart LR\n  INVALID -->');
  await until(()=>$('.rich-edit-error[role=alert]',editor!),2000);
  assert.match($('.rich-edit-error',editor!)!.textContent!,/Parse error on line 2/,'the parse error is shown');
  assert.match(stage(editor!),/Ship/,'the last good drawing stays');
  assert.equal(errors.length,0,'nothing threw');
}).catch(recordFailure);

// Spec: MUS-SPEC-21-829B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829b)
await check('cancel closes the editor, draws the original and saves nothing', async()=>{
  await show(<div/>);visualEdits.resetVisualEdits();
  await show(diagram(),20);
  await until(()=>$('.rich-block[data-status=ready] .rich-stage'));
  await click($('[aria-label="Edit"]'),80);
  type($('.rich-edit textarea'),'flowchart LR\n  Draft-->Gone');
  await until(()=>/Gone/.test(stage($('.rich-edit')!)),2000);
  await click(button('Cancel',$('.rich-edit')!),80);
  assert.ok(!$('.rich-edit'),'the editor closes');
  await until(()=>/Draft--&gt;Review|Draft-->Review/.test(stage())&&!/Gone/.test(stage()));
  assert.ok(!$('.rich-switch[aria-label="Version"]'),'no version switch: there is no edit');
  assert.equal(store.list(CHAT).length,0,'nothing was saved');
  assert.ok(!calls.some(([command])=>command==='artifacts.canvas.create'||command==='artifacts.canvas.update'));
}).catch(recordFailure);

// Spec: MUS-SPEC-21-829C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829c)
await check('saving keeps the edit as version 2 of a linked canvas, the original stays one click away, and a reload draws the edit', async()=>{
  await show(<div/>);visualEdits.resetVisualEdits();
  await show(diagram(),20);
  await until(()=>$('.rich-block[data-status=ready] .rich-stage'));
  await click($('[aria-label="Edit"]'),80);
  type($('.rich-edit textarea'),'flowchart LR\n  Draft-->Review-->Ship');
  await until(()=>/Ship/.test(stage($('.rich-edit')!)),2000);
  await click(button('Save',$('.rich-edit')!),120);
  await until(()=>!$('.rich-edit'));

  const saved=store.list(CHAT);
  assert.equal(saved.length,1,'one canvas for this visual');
  assert.deepEqual(saved[0]!.visual,{kind:'diagram',key:`diagram:${richHash(ORIGINAL)}`},'linked to the chat and the diagram');
  assert.equal(saved[0]!.kind,'code');assert.equal(saved[0]!.language,'mermaid');
  assert.equal(saved[0]!.version,2);
  assert.equal(store.version(saved[0]!.id,1).content,ORIGINAL,'version 1 is the original');
  assert.equal(store.get(saved[0]!.id).content,'flowchart LR\n  Draft-->Review-->Ship','version 2 is the edit');

  await until(()=>/Ship/.test(stage()));
  const versions=$('.rich-switch[aria-label="Version"]');
  assert.ok(versions,'the header offers the original and the edit');
  const edited=$$('[role=radio]',versions!).find(item=>item.textContent==='Edited')!,original=$$('[role=radio]',versions!).find(item=>item.textContent==='Original')!;
  assert.equal(edited.getAttribute('aria-checked'),'true');
  await click(original,60);
  await until(()=>!/Ship/.test(stage())&&/Review/.test(stage()));
  assert.equal(original.getAttribute('aria-checked'),'true','the original is one click away');
  await click($$('.rich-switch[aria-label="Version"] [role=radio]').find(item=>item.textContent==='Edited')!,60);
  await until(()=>/Ship/.test(stage()));

  // A restart: nothing cached in the renderer, the reply mounts again and reads the link from the store.
  await show(<div/>);visualEdits.resetVisualEdits();
  await show(diagram(),20);
  await until(()=>/Ship/.test(stage()),3000);
  assert.ok($('.rich-switch[aria-label="Version"]'),'still an edit after a reload');
  assert.equal(errors.length,0,'nothing threw');
}).catch(recordFailure);

// Spec: MUS-SPEC-21-829D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829d)
await check('charts and html reports edit with a live preview and save as linked canvases', async()=>{
  await show(<div/>);visualEdits.resetVisualEdits();
  const chartSource='{"type":"bar","title":"Users","data":[{"w":"W1","u":3},{"w":"W2","u":5}],"x":"w","y":"u"}';
  await show(<MessageBody text={reply('```chart\n'+chartSource+'\n```')} chatId={CHAT}/>,20);
  await until(()=>$('.rich-block[data-kind=chart][data-status=ready] svg[data-values]'));
  const chart=$('.rich-block[data-kind=chart]')!;
  assert.equal(labels(chart)[0],'Edit','charts have Edit');
  await click($('[aria-label="Edit"]',chart),80);
  const editor=$('.rich-edit',chart)!;
  assert.equal(($('textarea',editor) as HTMLTextAreaElement).value,chartSource);
  await until(()=>$('.rich-edit-preview svg[data-values="3,5"]',editor));
  type($('textarea',editor),chartSource.replace('"u":5','"u":9'));
  await until(()=>$('.rich-edit-preview svg[data-values="3,9"]',editor),2000);
  const disposedBefore=chartDisposed;
  type($('textarea',editor),chartSource.replace('"u":5','"u":9').slice(0,-4));
  await until(()=>$('.rich-edit-error[role=alert]',editor),2000);
  assert.match($('.rich-edit-error',editor)!.textContent!,/JSON|parse|Unexpected|chart/i,'the parse error is shown');
  assert.ok($('.rich-edit-preview svg[data-values="3,9"]',editor),'the last good chart stays drawn');
  assert.equal(chartDisposed,disposedBefore,'and is not torn down');
  type($('textarea',editor),chartSource.replace('"u":5','"u":9'));
  await until(()=>!$('.rich-edit-error',editor),2000);
  await click(button('Save',editor),120);
  await until(()=>!$('.rich-edit',chart));
  const chartCanvas=store.list(CHAT).find(item=>item.visual?.kind==='chart')!;
  assert.ok(chartCanvas,'the chart edit is a canvas linked as a chart');
  assert.equal(chartCanvas.kind,'code');assert.equal(chartCanvas.language,'json');assert.equal(chartCanvas.version,2);
  await until(()=>$('.rich-block[data-kind=chart] .rich-body svg[data-values="3,9"]'));

  await show(<div/>);
  const reportSource='<!doctype html><title>Q3</title><h1>Quarter</h1>';
  await show(<MessageBody text={reply('```html-report\n'+reportSource+'\n```')} reports chatId={CHAT}/>,20);
  await until(()=>$('.rich-block[data-kind=report][data-status=ready]'));
  const report=$('.rich-block[data-kind=report]')!;
  assert.equal(labels(report)[0],'Edit','reports have Edit');
  await click($('[aria-label="Edit"]',report),120);
  const reportEditor=$('.rich-edit',report)!;
  assert.equal(($('textarea',reportEditor) as HTMLTextAreaElement).value,reportSource);
  await until(()=>$('.rich-edit-preview iframe',reportEditor));
  const opens=()=>calls.filter(([command])=>command==='reports.open').map(([,input])=>input);
  const before=opens().length;
  type($('textarea',reportEditor),reportSource.replace('Quarter','Quarter three'));
  await delay(60);
  assert.ok(!opens().slice(before).some(input=>/Quarter three/.test(input.html)),'not registered on every keystroke');
  await until(()=>opens().slice(before).some(input=>/Quarter three/.test(input.html)),3000);
  const registered=opens().slice(before).find(input=>/Quarter three/.test(input.html))!;
  assert.equal(registered.scripts,true,'the preview runs like the report, in the scripts-only sandbox');
  assert.equal($('.rich-edit-preview iframe',reportEditor)!.getAttribute('sandbox'),'allow-scripts');
  await click(button('Save',reportEditor),120);
  await until(()=>!$('.rich-edit',report));
  const reportCanvas=store.list(CHAT).find(item=>item.visual?.kind==='report')!;
  assert.ok(reportCanvas,'the report edit is a canvas linked as a report');
  assert.equal(reportCanvas.kind,'html');assert.equal(reportCanvas.visual!.key,`report:${richHash(reportSource)}`);
  assert.equal(store.get(reportCanvas.id).content,reportSource.replace('Quarter','Quarter three'));
  assert.ok($('.rich-switch[aria-label="Version"]',report),'the report shows its edit with the original one click away');
  assert.equal(errors.length,0,'nothing threw');
}).catch(recordFailure);

// Spec: MUS-SPEC-21-829E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829e)
await check('a render_html page edits with a live preview and the card shows the saved edit in its sandbox', async()=>{
  await show(<div/>);visualEdits.resetVisualEdits();
  await show(<HtmlRenderCard renderId={page.id} title="Revenue dashboard" chatId={CHAT}/>,120);
  await until(()=>$('.rich-block[data-status=ready] iframe'));
  await until(()=>calls.some(([command])=>command==='htmlRenders.open'));
  await until(()=>$('[aria-label="Edit"]'));
  const card=$('.rich-block')!;
  assert.equal(labels(card)[0],'Edit','a page the agent showed has Edit');
  await click($('[aria-label="Edit"]',card),120);
  const editor=$('.rich-edit',card)!;
  assert.equal(($('textarea',editor) as HTMLTextAreaElement).value,page.html,'the stored page is the source');
  type($('textarea',editor),'<h1>Revenue, by region</h1>');
  await until(()=>calls.some(([command,input])=>command==='reports.open'&&/by region/.test(input.html)),3000);
  await click(button('Save',editor),120);
  await until(()=>!$('.rich-edit',card));
  const saved=store.list(CHAT).find(item=>item.visual?.kind==='page')!;
  assert.ok(saved,'the page edit is a canvas linked as a page');
  assert.equal(saved.visual!.key,`page:${page.id}`);assert.equal(saved.kind,'html');assert.equal(saved.version,2);
  assert.equal(store.version(saved.id,1).content,page.html,'version 1 is the stored page');
  const shown=calls.filter(([command,input])=>command==='reports.open'&&/by region/.test(input.html)).at(-1)![1];
  assert.equal(shown.scripts,true);assert.equal(shown.themed,true,'the edit is drawn themed, like the page');
  const frame=$('.rich-body iframe',card)!;
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts','scripts-only, never same-origin');
  assert.ok($('.rich-switch[aria-label="Version"]',card),'the original page stays one click away');
  assert.equal(errors.length,0,'nothing threw');
}).catch(recordFailure);

await show(<div/>);
root.unmount();
if(failed){console.error(`visual-edit-829-dom: ${failed} check(s) failed`);process.exit(1);}
process.exit(0);
