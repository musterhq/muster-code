/** Bundled and run by scripts/test-renderer.mjs. #829 part 3: an office preview in the chat or the file viewer redraws
 *  when its file changes, only while it is on screen, and keeps the last pages when a refresh fails. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
const storage={getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>{saved.set(key,value);},removeItem:(key:string)=>{saved.delete(key);}};
/** A controllable IntersectionObserver: the test says whether the observed elements are on screen. */
const observers=new Set<{callback:(entries:{isIntersecting:boolean;target:Element}[])=>void;targets:Set<Element>}>();
class FakeIntersectionObserver{
  record:{callback:(entries:{isIntersecting:boolean;target:Element}[])=>void;targets:Set<Element>};
  constructor(callback:(entries:{isIntersecting:boolean;target:Element}[])=>void){this.record={callback,targets:new Set()};observers.add(this.record);}
  observe(target:Element){this.record.targets.add(target);this.record.callback([{isIntersecting:onScreen,target}]);}
  unobserve(target:Element){this.record.targets.delete(target);}
  disconnect(){this.record.targets.clear();observers.delete(this.record);}
}
let onScreen=true;
const setOnScreen=(value:boolean)=>{onScreen=value;for(const record of [...observers])record.callback([...record.targets].map(target=>({isIntersecting:value,target})));};
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},IntersectionObserver:FakeIntersectionObserver,requestAnimationFrame:(fn:()=>void)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:storage,sessionStorage:storage});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',display:'block',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
const listeners=new Set<(event:Record<string,unknown>)=>void>();
const calls:{command:string;input:Record<string,unknown>}[]=[];
let cell='Before',failRead=false;
const png=(text:string)=>`data:image/png;base64,${Buffer.from(text).toString('base64')}`;
window.muster={subscribe(listener:(event:Record<string,unknown>)=>void){listeners.add(listener);return()=>{listeners.delete(listener);};},async invoke(command:string,input:Record<string,unknown>){
  calls.push({command,input});
  if(command==='app.snapshot')return {version:1,chats:[],folders:[],projects:[]};
  if(command==='providers.list'||command==='plugins.list'||command==='files.annotations.list')return [];
  if(command==='office.live.watch')return {id:input.id,phase:'watching',version:0};
  if(command==='office.live.pages')return {pages:[png('new-1'),png('new-2')],pageCount:5,version:1};
  if(command==='files.workbook'){if(failRead)throw new Error('The workbook is open in another app.');return {revision:cell,sheets:[{name:'Sheet1',rows:[[cell]],formulas:{},limited:false}],limited:false};}
  return undefined;
}};
const emit=(event:Record<string,unknown>)=>{for(const listener of listeners)listener(event);};
const {createRoot}=await import('react-dom/client');
Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:false});
const {ToolCard}=await import('../src/renderer/components/ToolCard');
const {NativeDocument}=await import('../src/renderer/components/NativeDocument');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const of=(command:string)=>calls.filter(call=>call.command===command);
const status=()=>document.querySelector('.office-live-status')?.textContent??'';
const images=()=>[...document.querySelectorAll('.tool-shot img')].map(image=>Buffer.from((image.getAttribute('src')??'').replace(/^data:image\/png;base64,/,''),'base64').toString());

// Spec: MUS-SPEC-21-829O (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829o)
await check('an office_render row redraws its pages when the file changes, only while it is on screen',async()=>{
  const at=new Date(Date.now()-60_000).toISOString();
  const item={id:'tool-render-1',chatId:'chat-1',kind:'tool',status:'completed',text:'muster_office / office_render',createdAt:at,
    data:{type:'mcpToolCall',server:'muster_office',tool:'office_render',arguments:{path:'report.docx'},images:[{dataUrl:png('old-1')},{dataUrl:png('old-2')}]}};
  root.render(<ToolCard item={item as never}/>);await delay(40);
  assert.deepEqual(images(),['old-1','old-2'],'the row shows the pages the agent saw');
  const watches=of('office.live.watch');
  assert.equal(watches.length,1,'on screen, the row watches its file once');
  assert.deepEqual(watches[0]!.input,{id:'render:tool-render-1',source:{kind:'render',chatId:'chat-1',path:'report.docx',pages:2},since:Date.parse(at)});
  emit({type:'officeLiveChanged',id:'render:other',phase:'updated',version:1});await delay(20);
  assert.equal(of('office.live.pages').length,0,'another preview\'s change is not ours');
  emit({type:'officeLiveChanged',id:'render:tool-render-1',phase:'rendering',version:0});await delay(20);
  assert.match(status(),/Updating/);
  emit({type:'officeLiveChanged',id:'render:tool-render-1',phase:'updated',version:1});await delay(40);
  assert.deepEqual(of('office.live.pages').map(call=>call.input),[{id:'render:tool-render-1'}]);
  assert.deepEqual(images(),['new-1','new-2'],'the new pages replace the old ones');
  assert.match(status(),/Updated just now/);
  emit({type:'officeLiveChanged',id:'render:tool-render-1',phase:'failed',version:1,error:'LibreOffice exited with code 1.'});await delay(20);
  assert.deepEqual(images(),['new-1','new-2'],'a failed refresh keeps the last pages');
  assert.match(status(),/LibreOffice exited with code 1/);
  assert.equal(document.querySelector('.office-live-status')?.getAttribute('data-state'),'failed');

  setOnScreen(false);await delay(20);
  assert.deepEqual(of('office.live.unwatch').map(call=>call.input),[{id:'render:tool-render-1'}],'off screen it stops watching');
  setOnScreen(true);await delay(20);
  assert.equal(of('office.live.watch').length,2,'back on screen it watches again');
  root.render(<div/>);await delay(20);
  assert.equal(of('office.live.unwatch').length,2,'unmounting stops watching');

  // A row with no pages to show, a failed row and another server's tool never watch.
  calls.length=0;
  root.render(<>
    <ToolCard item={{...item,id:'tool-none',data:{...item.data,images:[]}} as never}/>
    <ToolCard item={{...item,id:'tool-failed',status:'failed'} as never}/>
    <ToolCard item={{...item,id:'tool-other',data:{...item.data,server:'other_server'}} as never}/>
  </>);await delay(40);
  assert.equal(of('office.live.watch').length,0);
  root.render(<div/>);await delay(20);
});

// Spec: MUS-SPEC-21-829P (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-829p)
await check("the file viewer's office preview redraws in place when the file changes and keeps the last preview on a failure",async()=>{
  calls.length=0;cell='Before';failRead=false;
  const revision={};
  root.render(<NativeDocument folderId="folder-1" path="book.xlsx" revision={revision}/>);await delay(60);
  const cellText=()=>document.querySelector('.native-document')?.textContent??'';
  assert.match(cellText(),/Before/);
  assert.deepEqual(of('office.live.watch').map(call=>({id:call.input.id,source:call.input.source})),[{id:'file:folder-1:book.xlsx',source:{kind:'file',folderId:'folder-1',path:'book.xlsx'}}]);
  const reads=of('files.workbook').length;
  cell='After';
  let sawLoading=false;
  const seen=new MutationObserver(()=>{if(document.querySelector('.pane-loading'))sawLoading=true;});
  seen.observe(document.body,{childList:true,subtree:true});
  emit({type:'officeLiveChanged',id:'file:folder-1:book.xlsx',phase:'updated',version:1});await delay(60);
  seen.disconnect();
  assert.equal(of('files.workbook').length,reads+1,'the change re-reads the file');
  assert.match(cellText(),/After/);assert.doesNotMatch(cellText(),/Before/);
  assert.equal(sawLoading,false,'the preview is redrawn in place, with no loading state');
  assert.match(status(),/Updated just now/);

  failRead=true;
  emit({type:'officeLiveChanged',id:'file:folder-1:book.xlsx',phase:'updated',version:2});await delay(60);
  assert.match(cellText(),/After/,'a failed re-read keeps the last preview');
  assert.match(status(),/open in another app/);

  root.render(<div/>);await delay(20);
  assert.deepEqual(of('office.live.unwatch').map(call=>call.input),[{id:'file:folder-1:book.xlsx'}],'closing the preview stops watching');
});
assert.deepEqual(errors,[]);
root.unmount();
console.log('office-live-829-dom: ok');
