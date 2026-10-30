/** #787, DOM: Mermaid in chat. The Show code / Show diagram switch (source kept in the DOM for Find), the full-size view with Copy image and
 *  Save (PNG and SVG with the theme background baked in), Retry that really reloads a renderer chunk that failed to load, and old chats
 *  drawing with no migration. linkedom has no layout or canvas: sizes, Image and the canvas are stubbed. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
const computed={getPropertyValue:()=>'',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',transitionDuration:'0s',transitionDelay:'0s',animationName:'none'};
Object.assign(globalThis,{getComputedStyle:()=>computed});window.getComputedStyle=()=>computed;
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:600,bottom:300,width:600,height:300};};
// Rasterizing: an Image that loads at once and a canvas whose toBlob returns a tiny PNG.
class StubImage{onload:(()=>void)|null=null;onerror:(()=>void)|null=null;decoding='';set src(_value:string){setTimeout(()=>this.onload?.(),0);}}
Object.assign(globalThis,{Image:StubImage});
const createElement=window.document.createElement.bind(window.document);
(window.document as any).createElement=(tag:string,...rest:unknown[])=>tag.toLowerCase()==='canvas'
  ?{width:0,height:0,getContext:()=>({fillStyle:'',fillRect(){},drawImage(){}}),toBlob:(done:(blob:Blob)=>void)=>done(new Blob([new Uint8Array([0x89,0x50,0x4e,0x47])],{type:'image/png'}))}
  :createElement(tag,...rest);
// Downloads: capture the blob and the file name the link asks for.
const saved:Array<{name:string;blob:Blob}>=[];const urls=new Map<string,Blob>();let urlCount=0;
URL.createObjectURL=((blob:Blob)=>{const url=`blob:test/${++urlCount}`;urls.set(url,blob);return url;}) as typeof URL.createObjectURL;
URL.revokeObjectURL=()=>{};
(window.HTMLElement.prototype as any).click=function(this:HTMLElement){if(this.tagName==='A'&&this.getAttribute('download'))saved.push({name:this.getAttribute('download')!,blob:urls.get(this.getAttribute('href')!)!});};

const calls:Array<[string,any]>=[];
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){calls.push([command,input]);return undefined;}};
setTimeout(()=>{console.error('mermaid-787-dom: timed out');process.exit(4);},90_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=60)=>{root.render(node);await delay(wait);};
const until=async(test:()=>unknown,ms=4000)=>{for(let waited=0;waited<ms;waited+=25){if(test())return;await delay(25);}assert.fail('condition not reached: '+test.toString().slice(0,140));};
const fire=async(el:Element|null,type:string,wait=40)=>{assert.ok(el,`element for ${type} exists`);(el as HTMLElement).dispatchEvent(new window.Event(type,{bubbles:true,cancelable:true}));await delay(wait);};
const click=(el:Element|null,wait=40)=>fire(el,'click',wait);
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);
const $$=(selector:string,scope:ParentNode=document)=>[...scope.querySelectorAll(selector)];
const labels=(scope:ParentNode)=>$$('.rich-actions button, .rich-actions [aria-label]',scope).map(el=>el.getAttribute('aria-label')??el.textContent??'');

const fence=await import('../src/renderer/components/RichFence');
const {RichFence}=fence;
const {MessageBody}=await import('../src/renderer/components/MessageBody');
const {setRichRenderers}=await import('../src/renderer/richRenderers');
const setRichBodyLoaders=(fence as Record<string,unknown>).setRichBodyLoaders as undefined|((next:Record<string,()=>Promise<unknown>>)=>void);

const svgFor=(text:string)=>`<svg width="200" height="100" viewBox="0 0 200 100"><text x="10" y="20">${text}</text></svg>`;
let mermaidCalls=0;const mermaidFailures:string[]=[];
setRichRenderers({async mermaid(source){mermaidCalls++;const fail=mermaidFailures.shift();if(fail)throw new Error(fail);return {svg:svgFor(source.split('\n')[1]?.trim()??''),width:200,height:100};}});

const failed:string[]=[];
const run=async(name:string,body:()=>Promise<void>)=>{try{await check(name,body);}catch(error){failed.push(name);console.error(error);await show(<div/>);}};

// Spec: MUS-SPEC-21-787B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787b)
await run('a diagram header switches between Show code and Show diagram; the source stays in the DOM for Find', async()=>{
  await show(<MessageBody text={'Plan:\n\n```mermaid\nflowchart LR\n  Alpha-->Beta\n```'}/>,20);
  await until(()=>$('.rich-block[data-kind=diagram][data-status=ready] .rich-stage'));
  const block=$('.rich-block')!;
  assert.deepEqual(labels(block),['Show code','Copy source','Download','Open in tab','Full screen'],'the switch comes first, then the standard actions');
  const toggle=$('[aria-label="Show code"]',block)!;
  assert.equal(toggle.getAttribute('aria-pressed'),'false');
  const hidden=$('[data-rich-source]',block);
  assert.ok(hidden,'the source is in the DOM while the diagram shows');
  assert.match(hidden!.textContent!,/Alpha-->Beta/);
  assert.ok(hidden!.classList.contains('rich-sr'),'visually hidden, not unmounted, so in-chat Find still reaches it');
  assert.ok(!hidden!.closest('[hidden]')&&!hidden!.hasAttribute('aria-hidden'),'not display:none and not hidden from assistive tech');

  await click(toggle);
  const back=$('[aria-label="Show diagram"]',block);
  assert.ok(back,'the same button now offers Show diagram');
  assert.equal(back!.getAttribute('aria-pressed'),'true');
  assert.ok(!$('.rich-stage',block),'the drawing gives way to the source');
  const code=$('[data-rich-source]',block)!;
  assert.ok(!code.classList.contains('rich-sr'),'the source is now visible');
  assert.match(code.textContent!,/flowchart LR\n {2}Alpha-->Beta/,'the whole source, line breaks kept');

  await click(back);
  assert.ok($('.rich-stage',block),'Show diagram draws it again');
  assert.ok($('[aria-label="Show code"]',block));
  assert.ok($('[data-rich-source]',block)!.classList.contains('rich-sr'));
});

// Spec: MUS-SPEC-21-787C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787c)
await run('clicking a diagram opens it full size with Copy image and Save as PNG and SVG, the theme background baked in', async()=>{
  calls.length=0;saved.length=0;
  await show(<RichFence kind="diagram" source={'flowchart LR\n  Gamma-->Delta'}/>,20);
  await until(()=>$('.rich-block[data-status=ready] .rich-stage'));
  await click($('.rich-viewport[data-clickable]'),150);
  const full=$('.rich-full');
  assert.ok(full,'a click on the drawing opens the full-size view');
  assert.ok($('.rich-stage svg',full!),'the drawing is in it');
  const actions=labels(full!);
  assert.ok(actions.includes('Copy image'),`Copy image is offered full size (got ${actions.join(', ')})`);
  assert.ok(actions.includes('Download'),'Save (the Download menu) is offered full size');

  await click($('[aria-label="Copy image"]',full!),120);
  const copy=calls.find(([command])=>command==='clipboard.writeImage');
  assert.ok(copy,'Copy image goes to the native clipboard');
  assert.match(copy![1].dataUrl,/^data:image\/png;base64,[A-Za-z0-9+/]+=*$/,'as a PNG');
  assert.ok($('[aria-label="Image copied"]',full!),'the button confirms');

  await fire($('.rich-download',full!),'click',80);
  let items=$$('[role=menuitem]');
  if(!items.length){await fire($('.rich-download',full!),'pointerdown',80);items=$$('[role=menuitem]');}
  assert.deepEqual(items.map(item=>item.textContent),['Download SVG','Download PNG']);
  await click(items[0]!,80);
  await until(()=>saved.length===1);
  assert.equal(saved[0]!.name,'Flowchart.svg');
  const svg=await saved[0]!.blob.text();
  assert.match(svg,/^<\?xml/);
  assert.match(svg,/<svg[^>]*style="[^"]*background-color:\s*[^;"]+/,'the SVG carries the theme background, so it reads the same outside the app');
  await fire($('.rich-download',full!),'click',80);
  if(!$$('[role=menuitem]').length)await fire($('.rich-download',full!),'pointerdown',80);
  await click($$('[role=menuitem]').find(item=>item.textContent==='Download PNG')!,120);
  await until(()=>saved.length===2);
  assert.equal(saved[1]!.name,'Flowchart.png');assert.equal(saved[1]!.blob.type,'image/png');
});

// Spec: MUS-SPEC-21-787E (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787e)
await run('a renderer chunk that fails to load shows Retry, and Retry loads it again', async()=>{
  assert.ok(setRichBodyLoaders,'RichFence lets a test swap how a block body chunk loads');
  let loads=0;
  setRichBodyLoaders!({diagram:()=>{loads++;return loads===1?Promise.reject(new Error('Failed to fetch dynamically imported module: file:///app/renderer/MermaidBlock-x1.js')):import('../src/renderer/components/rich/MermaidBlock');}});
  await show(<RichFence kind="diagram" source={'flowchart LR\n  Eps-->Zeta'}/>,20);
  await until(()=>$('.rich-block[data-status=error]'));
  const card=$('.rich-body [role=alert]')!;
  assert.match(card.textContent!,/Couldn’t load the diagram renderer/);
  assert.match(card.textContent!,/Failed to fetch dynamically imported module/);
  await click($$('button',card).find(b=>/Retry/.test(b.textContent??''))!,60);
  await until(()=>$('.rich-block[data-status=ready] .rich-stage'));
  assert.equal(loads,2,'Retry fetched the chunk again instead of replaying the failure');
  setRichBodyLoaders!({});

  // The Mermaid library is its own chunk behind the block: the same Retry re-requests it.
  mermaidCalls=0;mermaidFailures.push('Failed to fetch dynamically imported module: file:///app/renderer/mermaid-y2.js');
  await show(<RichFence kind="diagram" source={'flowchart LR\n  Eta-->Theta'}/>,20);
  await until(()=>$('.rich-block[data-status=error]'));
  await click($$('.rich-body [role=alert] button').find(b=>/Retry/.test(b.textContent??''))!,60);
  await until(()=>$('.rich-block[data-status=ready] .rich-stage'));
  assert.equal(mermaidCalls,2);
});

// Spec: MUS-SPEC-21-787F (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787f)
await run('a mermaid fence saved in an older chat draws with the switch, with no migration', async()=>{
  // Exactly what a reply stored before this change holds: plain Markdown, no flags or metadata.
  const stored='Here is the deploy path.\n\n```mermaid\nsequenceDiagram\n  Iota->>Kappa: ship\n```\n\nDone.';
  await show(<MessageBody text={stored}/>,20);
  await until(()=>$('.rich-block[data-kind=diagram][data-status=ready]'));
  assert.ok($('[aria-label="Show code"]'),'the switch is there for an old reply too');
  assert.match($('[data-rich-source]')!.textContent!,/Iota->>Kappa: ship/);
  assert.match($('.md-body')!.textContent!,/Done\./,'prose after the block is kept');
});

assert.deepEqual(errors,[],'no uncaught render errors');
root.unmount();
if(failed.length){console.error(`mermaid-787-dom: ${failed.length} failing: ${failed.join(' | ')}`);process.exit(1);}
console.log('mermaid-787-dom: ok');
process.exit(0);
