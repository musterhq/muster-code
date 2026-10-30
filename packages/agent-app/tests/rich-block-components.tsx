/** Visuals program A, DOM: RichBlock chrome (every state, action order, full screen, exports, a11y), fences in a reply (a streaming fence stays code
 *  until it closes), the sandboxed-HTML frame, rich tabs, and the failure paths of each. linkedom has no layout: sizes are stubbed. */
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
const calls:Array<[string,any]>=[];
const clipboard:string[]=[];
let reportsFail=false;
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){
  calls.push([command,input]);
  if(command==='clipboard.write'){clipboard.push(input.text);return undefined;}
  if(command==='reports.open'){if(reportsFail)throw new Error('The desktop shell is not available.');return {url:`muster-report://${'a'.repeat(32)}/index.html?v=1`,token:'a'.repeat(32)};}
  if(command==='reports.pdf')return {saved:true,fileName:'Report.pdf'};
  return undefined;
}};
setTimeout(()=>{console.error('rich-block-components: timed out');process.exit(4);},90_000);

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode,wait=60)=>{root.render(node);await delay(wait);};
const until=async(check:()=>unknown,ms=6000)=>{for(let waited=0;waited<ms;waited+=25){if(check())return;await delay(25);}assert.fail('condition not reached: '+check.toString().slice(0,120));};
const click=async(el:Element|null,wait=40)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};
const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector);
const $$=(selector:string,scope:ParentNode=document)=>[...scope.querySelectorAll(selector)];
const labels=(scope:ParentNode)=>$$('.rich-actions button, .rich-actions [aria-label]',scope).map(el=>(el.getAttribute('aria-label')??el.textContent??'').replace('Source copied','Copy source'));

const {RichBlock}=await import('../src/renderer/components/RichBlock');
const {RichFence}=await import('../src/renderer/components/RichFence');
const {MessageBody}=await import('../src/renderer/components/MessageBody');
const {SandboxedHtml}=await import('../src/renderer/components/SandboxedHtml');
const {RichTab}=await import('../src/renderer/components/RichTab');
const {setRichRenderers}=await import('../src/renderer/richRenderers');
const {readWorkspace,saveWorkspace}=await import('../src/renderer/workspacePersistence');
const {richTabId}=await import('../src/shared/rich-block');

// ---- RichBlock chrome ----------------------------------------------------------------------------------------------------
{
  const opened:string[]=[];let exported=0;
  const block=(extra:Record<string,unknown>={})=><RichBlock kind="diagram" title="Checkout flow" kindLabel="Flowchart" status="ready" source={'flowchart LR\n A-->B'} description="Flowchart: A to B"
    exports={[{id:'svg',label:'Download SVG',run:()=>{exported++;}},{id:'png',label:'Download PNG',run:()=>{throw new Error('Could not write the file.');}}]} onOpenInTab={()=>opened.push('tab')} {...extra}>
    {ctx=><div className="viewport" data-mode={ctx.mode} data-suspended={String(ctx.suspended)}>body</div>}
  </RichBlock>;
  await show(block());
  const figure=$('figure.rich-block')!;
  assert.ok(figure,'a figure');
  assert.equal(figure.getAttribute('aria-label'),'Flowchart: Checkout flow');
  assert.equal($('.rich-title',figure)!.textContent,'Checkout flow');
  assert.equal($('.rich-kind',figure)!.textContent,'Flowchart');
  assert.deepEqual(labels(figure),['Copy source','Download','Open in tab','Full screen'],'the standard actions, in the standard order');
  assert.equal($('.viewport')!.getAttribute('data-mode'),'inline');
  assert.equal(document.getElementById($('.rich-body')!.getAttribute('aria-describedby')!)!.textContent,'Flowchart: A to B','text alternative is wired with aria-describedby');
  await click($('[aria-label="Copy source"]'));
  assert.deepEqual(clipboard,['flowchart LR\n A-->B'],'copy source goes through the native clipboard');
  assert.equal($('[aria-label="Source copied"]')?.getAttribute('data-state'),'copied');
  await click($('[aria-label="Open in tab"]'));
  assert.deepEqual(opened,['tab']);
  assert.match($('[role=status][aria-live=polite]')!.textContent!,/Flowchart ready: Checkout flow/,'load is announced');

  // Full screen: the same chrome in a dialog, the viewport called again, the inline copy told it is suspended.
  await click($('[aria-label="Full screen"]'),150);
  const full=$('.rich-full');
  assert.ok(full,'full-screen dialog opens');
  assert.equal($('.viewport',full!)!.getAttribute('data-mode'),'fullscreen');
  assert.equal($$('.viewport').find(el=>el.getAttribute('data-mode')==='inline')!.getAttribute('data-suspended'),'true','the inline copy is suspended while full screen is open');
  assert.deepEqual(labels(full!),['Copy source','Download','Open in tab','Close full screen'],'full screen keeps the order and swaps Full screen for Close');
  await click($('[aria-label="Close full screen"]',full!),150);
  assert.ok(!$('.rich-full'),'closing returns to the message');
  assert.equal($('.viewport')!.getAttribute('data-suspended'),'false');
  await click($('[aria-label="Open in tab"]'));
  assert.equal(opened.length,2);

  // Download: with several exports the control is a menu trigger; with one it is a plain button that runs it.
  await show(block({exports:[{id:'only',label:'Download SVG',run:()=>{exported++;}}]}));
  await click($('[aria-label="Download SVG"]'));
  assert.equal(exported,1);
  await show(block({exports:[{id:'bad',label:'Download PNG',run:()=>{throw new Error('Could not write the file.');}}]}));
  await click($('[aria-label="Download PNG"]'),80);
  assert.match($('.rich-problem[role=alert]')!.textContent!,/Could not write the file/,'a failed export is reported in the block, never thrown');
  await show(block({exports:[{id:'async',label:'Download PNG',run:()=>Promise.reject(new Error('Disk full.'))}]}));
  await click($('[aria-label="Download PNG"]'),80);
  assert.match($('.rich-problem')!.textContent!,/Disk full/);

  // Tab variant: already a tab, so no "Open in tab" and no "Full screen".
  await show(block({variant:'tab'}));
  assert.equal($('.rich-block')!.getAttribute('data-variant'),'tab');
  assert.deepEqual(labels(document),['Copy source','Download']);
  assert.equal($('.viewport')!.getAttribute('data-mode'),'tab');

  // A live session has no source to copy; extras render before the standard actions; fullscreen can be turned off.
  await show(<RichBlock kind="device" title="iPhone 16" status="ready" live fullscreen={false} extras={<button type="button" aria-label="Rotate">r</button>}><div>stream</div></RichBlock>);
  assert.deepEqual(labels(document),['Rotate'],'live: no Copy source; no Full screen when disabled; extras shown');
  assert.equal($('.rich-kind')!.textContent,'Device');
}

// ---- states ---------------------------------------------------------------------------------------------------------------
{
  await show(<RichBlock kind="chart" title="Sales" status="loading" source="{}"><div className="viewport">never</div></RichBlock>);
  assert.ok(!$('.viewport'),'the viewport is not drawn while loading');
  assert.equal($('.rich-body [role=status][aria-busy=true]')!.getAttribute('aria-label'),'Loading chart…','the shared skeleton, labelled');
  assert.deepEqual(labels(document),['Copy source'],'only Copy source while loading');

  let retried=0;
  await show(<RichBlock kind="diagram" title="Flowchart" status="error" source={'flowchart LR\n A[x'} error={{message:'Couldn’t render this diagram',detail:'Parse error on line 2',onRetry:()=>retried++}}><div className="viewport">never</div></RichBlock>);
  assert.ok(!$('.viewport'));
  const card=$('.rich-body [role=alert]')!;
  assert.match(card.textContent!,/Couldn’t render this diagram/);assert.match(card.textContent!,/Parse error on line 2/);
  assert.ok(!$('.rich-source'),'source is hidden until asked for');
  const showSource=$$('button',card).find(b=>b.textContent?.includes('Show source'))!;
  await click(showSource);
  assert.equal($('.rich-source')!.textContent,'flowchart LR\n A[x','the source is shown beside the error');
  assert.equal($$('button',card).find(b=>/Hide source/.test(b.textContent??''))?.getAttribute('aria-expanded'),'true');
  await click($$('button',card).find(b=>/Retry/.test(b.textContent??''))!);
  assert.equal(retried,1);
  assert.match($('[role=status][aria-live=polite]')!.textContent!,/Couldn’t render this diagram/,'the error is announced');
  assert.deepEqual(labels(document),['Copy source'],'no export or full screen on an error');

  await show(<RichBlock kind="report" title="Report" status="empty" emptyMessage="This report is empty."><div className="viewport">never</div></RichBlock>);
  assert.match($('.rich-body')!.textContent!,/This report is empty\./);
  await show(<RichBlock kind="chart" title="Chart" status="empty"><div/></RichBlock>);
  assert.match($('.rich-body')!.textContent!,/There is nothing to show in this chart\./,'default empty wording names the kind');
}

// ---- fences inside a reply ------------------------------------------------------------------------------------------------
const svgFor=(text:string)=>`<svg width="200" height="100" viewBox="0 0 200 100"><text x="10" y="20">${text}</text></svg>`;
let mermaidCalls=0,mermaidFail='',chartMounted=0,chartDisposed=0,chartFail='';
setRichRenderers({
  async mermaid(source){mermaidCalls++;if(mermaidFail)throw new Error(mermaidFail);return {svg:svgFor(source.split('\n')[0]!),width:200,height:100};},
  async chart(mount){chartMounted++;if(chartFail)throw new Error(chartFail);mount.container.innerHTML='<svg width="10" height="10"></svg>';return {async resize(){},toSvg:async()=>'<svg/>',toPng:async()=>new Blob(['x']),dispose(){chartDisposed++;}};},
});
{
  const reply=(fence:string)=>`Here is the picture.\n\n${fence}\n\nAfter the block.`;
  const closed='```mermaid\nflowchart LR\n  A-->B\n```';
  const open='```mermaid\nflowchart LR\n  A-->B';
  // Spec: MUS-SPEC-21-361A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361a)
  // Spec: MUS-SPEC-21-771C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771c)
  await check('a closed mermaid fence in a reply draws as a diagram; while streaming it stays code', async()=>{
  mermaidCalls=0;
  await show(<MessageBody text={reply(open)}/>);
  assert.ok(!$('.rich-block'),'a streaming fence stays an ordinary code block');
  assert.ok($('.md-code'),'it is shown as code');
  assert.equal(mermaidCalls,0,'nothing is rendered until the fence closes');
  await show(<MessageBody text={`Here is the picture.\n\n${open}\n\`\`\``}/>,20);
  await until(()=>$('.rich-block[data-kind=diagram][data-status=ready]'));
  assert.ok($('.rich-block[data-kind=diagram]'),'once the closing fence arrives the block appears');
  assert.ok(!$('.md-code'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'ready');
  assert.equal(mermaidCalls,1);
  assert.equal($('.rich-title')!.textContent,'Flowchart');
  assert.match($('.rich-stage')!.innerHTML,/flowchart LR/,'the renderer output is placed in the stage');
  assert.match($('.md-body')!.textContent!,/Here is the picture\./,'prose before the block is kept');

  // Cached: the same source remounts without rendering again (a block scrolling back into a virtual list).
  await show(<div/>);await show(<MessageBody text={reply(closed)}/>,20);await until(()=>$('.rich-block[data-status=ready]'));
  assert.equal(mermaidCalls,1,'a block seen before is served from the cache');
  });

  // Spec: MUS-SPEC-21-361B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361b)
  // Spec: MUS-SPEC-21-787D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-787d)
  // Spec: MUS-SPEC-21-771D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-771d)
  await check('an invalid mermaid fence shows the error card with the parse error and its source', async()=>{
  // Parse failure: error card with the source, never a blank block.
  mermaidFail='Parse error on line 2: expected node';
  await show(<MessageBody text={reply('```mermaid\nflowchart LR\n  A[\n```')}/>,20);await until(()=>$('.rich-block[data-status=error]'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'error');
  assert.match($('.rich-body')!.textContent!,/Couldn’t render this diagram/);
  assert.match($('.rich-body')!.textContent!,/Parse error on line 2/);
  await click($$('.rich-body button').find(b=>/Show source/.test(b.textContent??''))!);
  assert.match($('.rich-source')!.textContent!,/A\[/);
  mermaidFail='';
  });

  // Other languages are untouched; unknown fences stay code.
  await show(<MessageBody text={'```json\n{"a":1}\n```\n\n```html\n<p>x</p>\n```'}/>);
  assert.ok(!$('.rich-block'));assert.equal($$('.md-code').length,2);

  // Spec: MUS-SPEC-21-361C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361c)
  await check('a chart fence draws a Vega chart with its title, a table view and disposal on unmount', async()=>{
  // Charts: parse errors are caught before any library loads; good specs mount a view and dispose it on unmount.
  chartMounted=0;
  await show(<MessageBody text={reply('```chart\n{"type":"bar","title":"Users","data":[{"w":"W1","u":3},{"w":"W2","u":5}],"x":"w","y":"u"}\n```')}/>,20);
  await until(()=>$('.rich-block[data-kind=chart][data-status=ready]'));

  const chart=$('.rich-block[data-kind=chart]')!;
  assert.equal(chart.getAttribute('data-status'),'ready');
  assert.equal($('.rich-title',chart)!.textContent,'Users');assert.equal($('.rich-kind',chart)!.textContent,'Bar chart');
  await until(()=>chartMounted===1);
  assert.equal(chartMounted,1);
  assert.deepEqual(labels(chart),['Show','Chart','Table','Copy source','Download','Open in tab','Full screen'],'chart extras come first, then the standard order');
  await click($$('.rich-switch button',chart).find(b=>/Table/.test(b.textContent??''))!);
  assert.equal($$('.rich-table th',chart).map(th=>th.textContent).join(),'w,u','the table view shows the data');
  assert.equal($$('.rich-table tbody tr',chart).length,2);
  assert.ok(chartDisposed>=1,'switching to the table disposes the chart view');
  await click($$('.rich-switch button',chart).find(b=>/Chart/.test(b.textContent??'')&&!/Table/.test(b.textContent??''))!,150);
  await until(()=>chartMounted===2);
  assert.equal(chartMounted,2,'back to the chart draws it again');
  const disposedBefore=chartDisposed;
  await show(<div/>);
  assert.ok(chartDisposed>disposedBefore,'unmounting disposes the view');
  });

  await show(<MessageBody text={reply('```chart\n{"type":"bar",}\n```')}/>,20);await until(()=>$('.rich-block[data-status=error]'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'error');assert.match($('.rich-body')!.textContent!,/not valid JSON/);
  await show(<MessageBody text={reply('```chart\n{"data":{"url":"https://example.com/x.csv"},"mark":"bar"}\n```')}/>,20);await until(()=>/inline data/.test($('.rich-body')?.textContent??''));
  assert.match($('.rich-body')!.textContent!,/inline data/,'a remote data source is refused with a reason');
  await show(<MessageBody text={reply('```chart\n{"type":"bar","title":"Nothing","data":[],"x":"a","y":"b"}\n```')}/>,20);await until(()=>$('.rich-block[data-status=empty]'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'empty');
  chartFail='Vega could not draw this.';
  await show(<MessageBody text={reply('```chart\n{"type":"bar","data":[{"a":"x","b":1}],"x":"a","y":"b"}\n```')}/>,20);await until(()=>$('.rich-block[data-status=error]'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'error','a renderer failure becomes the error card');
  assert.match($('.rich-body')!.textContent!,/Vega could not draw this\./);
  chartFail='';
}

// ---- reports and the sandboxed frame ---------------------------------------------------------------------------------------
{
  // Spec: MUS-SPEC-21-361D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-361d)
  await check('a report frame is scripts-only: no same-origin, served from its own muster-report origin', async()=>{
  calls.length=0;
  await show(<SandboxedHtml html="<p>hi</p>" scripts title="Report" storeKey="k1"/>,420);
  const frame=$('iframe.sandboxed-html-frame')!;
  assert.ok(frame,'a frame');
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts','scripts only: no same-origin, popups, forms or top navigation');
  assert.equal(frame.getAttribute('referrerpolicy')??frame.getAttribute('referrerPolicy'),'no-referrer');
  assert.equal(frame.getAttribute('allow'),'');
  assert.match(frame.getAttribute('src')!,/^muster-report:\/\/a{32}\/index\.html\?v=1$/);
  assert.deepEqual(calls.find(([command])=>command==='reports.open')![1],{html:'<p>hi</p>',scripts:true,key:'k1'});
  await show(<SandboxedHtml html="<p>hi</p>" title="Report"/>,420);
  assert.equal($('iframe')!.getAttribute('sandbox'),'','a page that must not run gets an empty sandbox (every restriction)');
  assert.deepEqual(calls.at(-1)![1],{html:'<p>hi</p>',scripts:false});
  });

  // Height messages are accepted only from this frame and only as a finite number.
  const heights:number[]=[];
  await show(<SandboxedHtml html="<p>x</p>" scripts title="R" onHeight={h=>heights.push(h)}/>,420);
  const own=$('iframe')!;
  const post=(source:unknown,origin:string,data:unknown)=>{const event=new window.Event('message') as any;event.source=source;event.origin=origin;event.data=data;window.dispatchEvent(event);};
  (own as any).contentWindow={};
  post((own as any).contentWindow,'null',{muster:'report-height',height:412.2});
  await delay(10); // heights are applied once per animation frame
  post((own as any).contentWindow,'null',{muster:'report-height',height:'tall'});
  post((own as any).contentWindow,'null',{muster:'report-height',height:Infinity});
  post((own as any).contentWindow,'https://evil.example',{muster:'report-height',height:999});
  post({},'null',{muster:'report-height',height:998});
  post((own as any).contentWindow,'null',{muster:'something-else',height:997});
  post((own as any).contentWindow,'null',{muster:'report-height',height:9e9});
  await delay(10);
  assert.deepEqual(heights,[413,100000],'only the own frame, only numbers, bounded');

  reportsFail=true;
  await show(<SandboxedHtml html="<p>changed</p>" scripts title="R"/>,420);
  assert.ok(!$('iframe'),'no frame when the shell cannot register the page');
  assert.match($('[role=alert]')!.textContent!,/Couldn’t open this page/);assert.match($('[role=alert]')!.textContent!,/not available/);
  reportsFail=false;
  await click($$('[role=alert] button').find(b=>/Retry/.test(b.textContent??''))!,420);
  assert.ok($('iframe'),'Retry opens it again');

  // A report as a rich block: title from the page, sandboxed frame inside the block, HTML and PDF exports.
  await show(<RichFence kind="report" source={'<!doctype html><title>Release readiness</title><h1>Hi</h1>'}/>,20);await until(()=>$('.rich-block[data-kind=report] iframe'));
  const report=$('.rich-block[data-kind=report]')!;
  assert.equal($('.rich-title',report)!.textContent,'Release readiness');
  assert.ok($('iframe[sandbox="allow-scripts"]',report));
  assert.deepEqual(labels(report),['Copy source','Download','Open in tab','Full screen']);
  await click($('.rich-download',report));
  await show(<RichFence kind="report" source="" />,20);await until(()=>$('.rich-block[data-status=empty]'));
  assert.equal($('.rich-block')!.getAttribute('data-status'),'empty');
}

// ---- reports only where the text is an agent's or the user's own ----------------------------------------------------------------
{
  const text='Look.\n\n```html-report\n<title>Hello</title><p>x</p>\n```';
  await show(<MessageBody text={text}/>,20);
  assert.ok(!$('.rich-block'),'a README, a comment or a skill never runs a report: the fence stays code');
  assert.ok($('.md-code'));
  await show(<MessageBody text={text} reports/>,20);
  await until(()=>$('.rich-block[data-kind=report] iframe'));
  assert.ok(!$('.md-code'),'with reports on (chat replies, Canvas) the same fence is drawn');
  await show(<MessageBody text={'```mermaid\nflowchart LR\n A-->B\n```'}/>,20);
  await until(()=>$('.rich-block[data-kind=diagram][data-status=ready]'));
  assert.ok(true,'diagrams and charts are safe everywhere');
}

// ---- rich tabs: open, restore, persistence caps -----------------------------------------------------------------------------
{
  const {openRichTab}=await import('../src/renderer/richTabs');
  const store=await import('../src/renderer/store');
  openRichTab('diagram','flowchart LR\n  A-->B');
  const tab=store.getState().tabs.find(t=>t.kind==='rich')!;
  assert.ok(tab,'the tab opens');
  assert.equal(tab.id,richTabId('diagram','flowchart LR\n  A-->B'));
  assert.equal(tab.title,'Flowchart');assert.equal(tab.richKind,'diagram');
  openRichTab('diagram','flowchart LR\n  A-->B');
  assert.equal(store.getState().tabs.filter(t=>t.kind==='rich').length,1,'opening the same block again focuses its tab');
  assert.equal(store.getState().activeTabId,tab.id);
  await show(<RichTab tab={tab}/>,20);await until(()=>$('.rich-block[data-status=ready]'));
  assert.equal($('.rich-block')!.getAttribute('data-variant'),'tab');
  assert.equal($('.rich-block')!.getAttribute('data-status'),'ready');
  await show(<RichTab tab={{id:'rich:x',kind:'rich',title:'x'}}/>);
  assert.match($('[role=alert]')!.textContent!,/can’t be opened/,'a tab saved without content says so instead of rendering nothing');

  const memory=new Map<string,string>();
  const storage={getItem:(k:string)=>memory.get(k)??null,setItem:(k:string,v:string)=>{memory.set(k,v);}};
  const small={...tab};
  const big={id:'rich:report:big',kind:'rich' as const,richKind:'report' as const,richSource:'x'.repeat(20_000),title:'Big'};
  assert.ok(saveWorkspace(storage,{tabs:[small,big],activeTabId:small.id}));
  const restored=readWorkspace(storage);
  assert.deepEqual(restored.tabs.map(t=>t.id),[tab.id],'a rich tab restores with its source; one too large to save is left out');
  assert.equal(restored.tabs[0]!.richSource,'flowchart LR\n  A-->B');
  memory.set('muster.workspace.v2:personal',JSON.stringify({version:2,scope:'personal',tabs:[
    {id:'rich:diagram:z',kind:'rich',richKind:'bogus',richSource:'x',title:'t'},{id:'rich:diagram:y',kind:'rich',richKind:'diagram',richSource:'',title:'t'},
    {id:'rich:diagram:w',kind:'rich',richKind:'diagram',richSource:'x'.repeat(20_000),title:'t'},{id:'rich:model:v',kind:'rich',richKind:'model',richSource:'x',title:'t'},
  ],activeTabId:null}));
  assert.deepEqual(readWorkspace(storage).tabs,[],'malformed, empty, oversized and non-text rich tabs are all refused on restore');
}

assert.deepEqual(errors,[],'no uncaught render errors');
root.unmount();
console.log('rich-block-components: ok');
process.exit(0);
