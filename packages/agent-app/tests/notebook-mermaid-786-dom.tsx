/** #786, DOM: notebook (.ipynb) and Mermaid file (.mmd) previews in a file tab, driven through the real FileTab, store and preview
 *  components with a stubbed bridge. linkedom has no layout or IntersectionObserver: a fake observer stands in for scrolling (the test
 *  says which outputs are near the viewport) and the frames' heights arrive as the report-height message the real page sends; the real
 *  layout and CSP are checked in headless Chrome by tests/html-sandbox-security.suite.ts. Mermaid is a stand-in renderer. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html data-theme="dark"><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};

// The highlighter worker's stand-in: colours every token one colour.
const COLOUR='#abcdef';
class FakeHighlightWorker{onmessage?:(event:{data:unknown})=>void;onerror?:()=>void;postMessage(message:{id:number;type?:string;source?:string}){setTimeout(()=>{if(message.type)return;this.onmessage?.({data:{id:message.id,rows:(message.source??'').split('\n').map(line=>line?[{content:line,color:COLOUR}]:[])}});},0);}terminate(){}}
// IntersectionObserver's stand-in: the test decides which observed outputs are near the viewport.
interface Entry{target:Element;isIntersecting:boolean}
class FakeIntersectionObserver{targets=new Set<Element>();disconnected=false;constructor(public callback:(entries:Entry[])=>void,public options?:{root?:Element}){observers.push(this);}observe(target:Element){this.targets.add(target);}unobserve(target:Element){this.targets.delete(target);}disconnect(){this.disconnected=true;this.targets.clear();}}
const observers:FakeIntersectionObserver[]=[];
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},
  requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage,Worker:FakeHighlightWorker,IntersectionObserver:FakeIntersectionObserver});
Object.defineProperty(globalThis,'navigator',{value:{userActivation:{isActive:true},platform:'MacIntel',userAgent:'node',clipboard:{writeText:async()=>{}}},configurable:true});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',visibility:'visible',color:'rgb(0, 0, 0)',animationName:'none',transitionProperty:'none',transitionDuration:'0s',transitionDelay:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
Object.assign(window,{setTimeout,clearTimeout});
window.HTMLElement.prototype.getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:800,bottom:500,width:800,height:500};};
window.HTMLElement.prototype.scrollIntoView=function(){};

const PNG='iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==';
const nb=(cells:unknown[])=>JSON.stringify({nbformat:4,nbformat_minor:5,metadata:{language_info:{name:'python'}},cells});
const FILES:Record<string,string>={
  'analysis.ipynb':nb([
    {cell_type:'markdown',metadata:{},source:['# Quarterly results\n','Revenue grew **12%**.']},
    {cell_type:'code',metadata:{},execution_count:1,source:['import pandas as pd\n','df = pd.read_csv("q3.csv")\n','df.head()'],outputs:[
      {output_type:'stream',name:'stdout',text:['loaded 12 rows\n']},
      {output_type:'execute_result',metadata:{},data:{'text/html':'<table><tr><td>42</td></tr></table><script>window.ran=1</script>','text/plain':'   a\n0  42'}},
      {output_type:'display_data',metadata:{},data:{'image/png':PNG,'text/plain':'<Figure>'}},
    ]},
  ]),
  'observations.ipynb':nb(Array.from({length:20},(_,cell)=>({cell_type:'code',metadata:{},source:[],outputs:Array.from({length:100},(_,output)=>({output_type:'display_data',data:{'text/html':`<p>saved ${cell}-${output}</p>`}}))}))),
  'flow.mmd':'---\ntitle: Checkout flow\n---\nflowchart LR\n  A[Cart] --> B[Pay]',
  'broken.mmd':'flowchart LR\n  A --> ',
  'tracker.mmd':'flowchart LR\n  A --> B\n  click A href "https://example.com/track"',
  'config.mermaid':'%%{init: {"securityLevel": "loose"}}%%\nflowchart LR\n  A --> B',
};
const at=new Date().toISOString();
const calls:Array<[string,any]>=[];
const pages=new Map<string,string>();// token -> html registered
let tokens=0;
window.muster={subscribe(){return()=>{};},async invoke(command:string,input:any){
  calls.push([command,input]);
  if(command==='app.snapshot')return JSON.parse(JSON.stringify({version:1,chats:[{id:'c1',title:'Chat',folderId:'folder',status:'completed',updatedAt:at,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow'}],folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'c1'}));
  if(command==='files.read')return {path:input.path,text:FILES[input.path]??'',truncated:false,revision:'r1'};
  if(command==='reports.open'){const token=(++tokens).toString(16).padStart(32,'0');pages.set(token,input.html);return {url:`muster-report://${token}/index.html?v=1`,token};}
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='settings.get')return {values:{}};
  if(command==='files.openWith.apps')return {apps:[]};
  if(command==='files.annotations.list'||command==='files.list'||command==='review.baselines')return [];
  if(command==='providers.list')return [];
  return undefined;
}};
setTimeout(()=>{console.error('notebook-mermaid-786-dom: timed out');process.exit(4);},90_000);

const React=await import('react');
const {createRoot}=await import('react-dom/client');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:false});
const store=await import('../src/renderer/store');
const {FileTab}=await import('../src/renderer/components/FileTab');
const {setRichRenderers}=await import('../src/renderer/richRenderers');
const errors:unknown[]=[];
const host=document.getElementById('root')!;
const root=createRoot(host,{onUncaughtError:error=>errors.push(error),onRecoverableError:error=>errors.push(error)});
await store.boot();await delay(30);

const $=(selector:string,scope:ParentNode=document)=>scope.querySelector(selector) as HTMLElement|null;
const $$=(selector:string,scope:ParentNode=document)=>[...scope.querySelectorAll(selector)] as HTMLElement[];
const until=async(ok:()=>unknown,label:string,ms=4000)=>{for(let waited=0;waited<ms;waited+=20){if(ok())return;await delay(20);}assert.fail(`condition not reached: ${label}`);};
const click=async(el:Element|null,wait=60)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(wait);};
const open=async(path:string)=>{await store.openFile('folder',path);const tab=store.getState().tabs.find(item=>item.path===path)!;root.render(<FileTab key={tab.id} tab={tab}/>);await delay(80);};
const frames=()=>$$('.notebook-preview iframe');
const pageOf=(frame:Element)=>pages.get(/^muster-report:\/\/([0-9a-f]{32})\//.exec(frame.getAttribute('src')!)![1]!)!;
const notebookObserver=()=>observers.filter(observer=>!observer.disconnected&&observer.options?.root).at(-1)!;
/** Scroll: the outputs whose id passes `near` are within the observer's margin, every other one is not. */
const scroll=async(near:(id:string)=>boolean)=>{const observer=notebookObserver();observer.callback([...observer.targets].map(target=>({target,isIntersecting:near((target as HTMLElement).dataset.notebookOutput!)})));await delay(80);};
const post=(source:unknown,data:unknown)=>{const event=new window.Event('message') as any;event.source=source;event.origin='null';event.data=data;window.dispatchEvent(event);};
const alert=()=>$('[role="alert"]');
let mermaidCalls:Array<{source:string;dark:boolean}>=[];
let mermaidFails='';
setRichRenderers({mermaid:async(source,theme)=>{mermaidCalls.push({source,dark:theme.dark});if(mermaidFails)throw new Error(mermaidFails);return {svg:'<svg width="200" height="80" viewBox="0 0 200 80"><path d="M0 0L10 10"/><text>Cart</text></svg>',width:200,height:80};}});

// Spec: MUS-SPEC-21-786H (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786h)
await check('a notebook opens as cells: Markdown rendered, code highlighted, saved outputs shown and nothing run',async()=>{
  await open('analysis.ipynb');
  const preview=$('.notebook-preview');
  assert.ok(preview,'the notebook preview, not the JSON source');
  assert.equal(preview!.getAttribute('aria-label'),'Notebook preview of analysis.ipynb');
  assert.equal($('.notebook-status')!.textContent,'2 cells · python');
  assert.equal($('.notebook-notice')!.textContent,'Saved outputs only. Code is never executed.');
  assert.ok(!$('.code-scroll'),'no source table');
  const [markdown,code]=$$('.notebook-cell');
  assert.equal(markdown!.getAttribute('aria-label'),'Cell 1');
  assert.equal($('.notebook-markdown .md-body h1',markdown)!.textContent,'Quarterly results','Markdown cells go through the chat Markdown renderer');
  assert.equal($('.notebook-markdown strong',markdown)!.textContent,'12%');
  assert.equal($('.notebook-cell-head',code)!.textContent,'python · 2');
  await until(()=>$$('.notebook-code span[style]',code).some(span=>span.getAttribute('style')!.includes('abcdef')),'code cells are syntax coloured');
  assert.equal($('.notebook-code',code)!.textContent,'import pandas as pd\ndf = pd.read_csv("q3.csv")\ndf.head()');
  const outputs=$$('.notebook-output',code);
  assert.deepEqual(outputs.map(output=>output.dataset.kind),['text','html','image']);
  assert.equal($('pre',outputs[0])!.textContent,'loaded 12 rows\n','stream text as pre');
  assert.equal($('img',outputs[2])!.getAttribute('src'),`data:image/png;base64,${PNG}`,'images inline from their saved data');
  assert.equal($('img',outputs[2])!.getAttribute('alt'),'Cell 2 output 3');
  // The HTML output: mounted once near the viewport, in the shared sandbox frame, measure-only.
  assert.equal(frames().length,0,'no frame before the observer reports the output near the viewport');
  await scroll(()=>true);
  await until(()=>frames().length===1,'the HTML output gets a frame');
  const frame=frames()[0]!;
  assert.equal(frame.getAttribute('sandbox'),'allow-scripts','opaque origin: never allow-same-origin');
  assert.equal(frame.getAttribute('title'),'Cell 2 output 2');
  assert.match(frame.getAttribute('src')!,/^muster-report:\/\/[0-9a-f]{32}\/index\.html\?v=1$/,'served from its own origin, not srcdoc under the app CSP');
  const request=calls.filter(([command])=>command==='reports.open').at(-1)![1];
  assert.equal(request.scripts,false,'the output never runs');
  assert.equal(request.measure,true,'only Muster’s height reporter runs (the CSP allows it by hash)');
  assert.match(request.html,/<td>42<\/td>/);
  assert.ok(!calls.some(([command])=>/kernel|execute|terminal|process/i.test(command)),'nothing asks to run code');
  // Back to the JSON source and to the notebook again, with the tab's own toggle.
  await click($('[aria-label="View source"]'));
  assert.ok($('.code-scroll'),'View source shows the file');
  assert.ok(!$('.notebook-preview'));
  await click($('[aria-label="View notebook"]'));
  assert.ok($('.notebook-preview'),'View notebook returns');
  assert.equal(errors.length,0,String(errors[0]));
});

// Spec: MUS-SPEC-21-786I (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786i)
await check('only HTML outputs near the viewport get frames, at most 16, each sized to its content and kept as a placeholder when it leaves',async()=>{
  await open('observations.ipynb');
  assert.equal($$('.notebook-output[data-kind="html"]').length,2000,'all 2000 saved outputs are in the page');
  assert.equal(notebookObserver().targets.size,2000,'and observed');
  assert.equal(frames().length,0);
  // The top of the notebook: 40 outputs within the margin.
  await scroll(id=>Number(id.split('-')[0])===0&&Number(id.split('-')[1])<40);
  await until(()=>frames().length>0,'frames mount for the outputs near the top');
  assert.equal(frames().length,16,'no more than 16 frames however many outputs are near');
  const first=frames()[0]!;
  assert.match(pageOf(first),/saved 0-0</,'the first frame is the first output');
  assert.match(pageOf(frames()[15]!),/saved 0-15</,'in document order');
  // The page reports its height: the frame takes it.
  const own={postMessage(){}};Object.defineProperty(first,'contentWindow',{configurable:true,value:own});
  first.dispatchEvent(new window.Event('load'));
  post(own,{muster:'report-height',height:137});
  post({},{muster:'report-height',height:999});
  await delay(60);
  const box=first.closest('.notebook-html-output') as HTMLElement;
  assert.equal(box.style.height,'137px','the frame fits the content height it reported (another window’s message is ignored)');
  post(own,{muster:'report-height',height:212});await delay(60);
  assert.equal(box.style.height,'212px','and follows it when the content changes');
  // Scroll to the end: the top outputs leave, the last ones arrive.
  await scroll(id=>Number(id.split('-')[0])===19&&Number(id.split('-')[1])>=90);
  await until(()=>frames().some(frame=>/saved 19-99</.test(pageOf(frame))),'the last output gets a frame');
  assert.ok(frames().length<=16,'still at most 16');
  assert.equal(first.isConnected,false,'the first frame is unmounted once it leaves');
  const placeholder=$('[data-notebook-output="0-0"]')!;
  assert.equal(placeholder.style.minHeight,'212px','its place keeps its last height, so the page does not jump');
  // Back to the top.
  await scroll(id=>id==='0-0'||id==='0-1');
  await until(()=>frames().length===2&&/saved 0-0</.test(pageOf(frames()[0]!)),'the first output is framed again');
  assert.equal($('[data-notebook-output="0-0"]')!.style.minHeight,'','a mounted output has no placeholder height');
  assert.equal(errors.length,0,String(errors[0]));
});

// Spec: MUS-SPEC-21-786J (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786j)
await check('a Mermaid file draws as a diagram, toggles to its source and back, and Expand opens it full size and closes',async()=>{
  mermaidCalls=[];
  await open('flow.mmd');
  await until(()=>$('.mermaid-file-stage svg path'),'the diagram is drawn');
  assert.equal(mermaidCalls[0]!.source,FILES['flow.mmd'],'the file text is what Mermaid draws');
  assert.equal($('.mermaid-file-kind')!.textContent,'Flowchart · Checkout flow');
  assert.equal($('.mermaid-file-stage [role="img"]')!.getAttribute('aria-label'),'Flowchart: Checkout flow');
  assert.ok($('[aria-label="Zoom in"]'),'zoom controls');
  await click($('[aria-label="Expand diagram"]'),150);
  const dialog=$('.mermaid-file-full');
  assert.ok(dialog,'Expand opens the diagram full size');
  assert.equal(dialog!.getAttribute('aria-label'),'Checkout flow (full size)');
  assert.ok($('.rich-viewport[data-mode="fullscreen"] svg path',dialog!),'the same drawing, full size');
  await click($('[aria-label="Close full size view"]',dialog!),150);
  assert.ok(!$('.mermaid-file-full'),'Close returns to the tab');
  await click($('[aria-label="View source"]'));
  assert.ok($('.code-scroll'),'the source');
  assert.match($('.code-scroll')!.textContent!,/A\[Cart\] --> B\[Pay\]/);
  assert.ok(!$('.mermaid-file'));
  await click($('[aria-label="View diagram"]'));
  await until(()=>$('.mermaid-file-stage svg path'),'the diagram is back');
  assert.equal(alert(),null,'no error at any point');
  assert.equal(errors.length,0,String(errors[0]));
});

// Spec: MUS-SPEC-21-786K (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786k)
await check('an invalid Mermaid file shows the error with its source; a file with a URL or configuration is never handed to Mermaid',async()=>{
  mermaidCalls=[];mermaidFails='Parse error on line 2: Expecting a node';
  await open('broken.mmd');
  await until(()=>alert(),'the error shows');
  assert.equal($('.mermaid-file-error > span')!.textContent,'Unable to render diagram: Parse error on line 2: Expecting a node');
  assert.equal($('.mermaid-file-source')!.textContent,FILES['broken.mmd'],'with the source');
  assert.ok($('.mermaid-file-error button'),'and Retry');
  mermaidFails='';
  await click($('.mermaid-file-error button'),150);
  await until(()=>$('.mermaid-file-stage svg'),'Retry draws once the renderer succeeds');
  for(const [path,reason] of [['tracker.mmd','a URL'],['config.mermaid','a %%{ }%% configuration block']] as const){
    mermaidCalls=[];
    await open(path);
    await delay(120);
    assert.equal($('.mermaid-file-error > span')!.textContent,`This diagram contains ${reason}, so Muster does not draw it. Its source is shown below.`);
    assert.equal($('.mermaid-file-source')!.textContent,FILES[path]);
    assert.ok(!$('.mermaid-file-error button'),'nothing to retry');
    assert.deepEqual(mermaidCalls,[],`${path} never reaches Mermaid`);
  }
  assert.equal(errors.length,0,String(errors[0]));
});

// Spec: MUS-SPEC-21-786L (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-786l)
await check('both previews follow the app theme: HTML outputs are framed in the active colours and diagrams redraw in light and dark',async()=>{
  document.documentElement.setAttribute('data-theme','dark');
  await open('analysis.ipynb');
  await scroll(()=>true);
  await until(()=>frames().length===1,'the output is framed');
  assert.match(pageOf(frames()[0]!),/color-scheme:dark/,'dark theme: the output document is dark');
  document.documentElement.setAttribute('data-theme','light');
  await until(()=>frames().length===1&&/color-scheme:light/.test(pageOf(frames()[0]!)),'light theme: the output is re-served in light colours');
  mermaidCalls=[];
  await open('flow.mmd');
  await until(()=>mermaidCalls.length>0,'drawn');
  assert.equal(mermaidCalls.at(-1)!.dark,false,'light');
  document.documentElement.setAttribute('data-theme','dark');
  await until(()=>mermaidCalls.at(-1)!.dark===true,'the diagram redraws in the dark theme');
  assert.ok($('.mermaid-file-stage svg path'));
  assert.equal(errors.length,0,String(errors[0]));
});

root.unmount();
setRichRenderers({});
process.exit(0);
