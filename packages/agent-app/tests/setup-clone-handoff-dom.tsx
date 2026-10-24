import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {check} from './dom-check.ts';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const storage=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:(k:string)=>storage.get(k)??null,setItem:(k:string,v:string)=>{storage.set(k,v);},removeItem:(k:string)=>{storage.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};

// ---- runtime fake ----
const calls:{command:string;input:any}[]=[];
const listeners=new Set<(event:any)=>void>();
const cli=(tool:string,installed:boolean,extra:any={})=>({tool,label:tool==='codex'?'Codex CLI':tool==='claude'?'Claude Code':'OpenCode',installed,version:installed?'1.0.0':null,managed:false,signedIn:false,signInUnknown:false,ready:false,account:'',loginCommand:`${tool} login`,detail:installed?'Installed, not signed in.':'Not installed.',...extra});
const status=(ready:boolean)=>({checkedAt:'2026-09-24T00:00:00Z',platform:'darwin',clis:[cli('codex',true,ready?{ready:true,signedIn:true,account:'g***@example.com'}:{}),cli('claude',false),cli('opencode',false)],connections:[],
  readyProviders:ready?[{id:'openai-direct',name:'OpenAI Direct'}]:[],git:{available:true,version:'2.50.1',detail:'Git 2.50.1'},docker:{installed:true,running:false,version:null,detail:'Docker Desktop is installed but not running. Start it to use sandboxes.'}});
let ready=false;
let progress:any={step:'welcome',startedAt:null,completedAt:null,dismissedAt:null,skipped:[]};
const providers=()=>[{id:'openai-direct',name:'OpenAI Direct',available:ready,identityMasked:'',models:ready?[{id:'gpt-6',name:'GPT-6'}]:[]}];
window.muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return {folders:[],chats:[],projects:[],version:1};
  if(command==='settings.get')return {values:{'general.sendKey':'enter','notifications.runs':'all','general.defaultModel':null}};
  if(command==='setup.status')return status(ready);
  if(command==='setup.progress')return progress;
  if(command==='setup.saveProgress'){progress={...progress,...input};return progress;}
  if(command==='setup.refresh')return {providers:providers()};
  if(command==='setup.openTerminal')return {opened:true,command:'codex login'};
  if(command==='providers.list')return providers();
  if(command==='computer.permissions')return {platform:'darwin',accessibility:'denied',screen:'granted'};
  return undefined;
}} as any;
const emit=(event:any)=>{for(const listener of [...listeners])listener(event);};

const React=await import('react');
const {act}=await import('react');
const {createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {SetupGuideHost,SetupChecklist,ConnectModelPrompt}=await import('../src/renderer/components/SetupGuide');
const flow=await import('../src/renderer/setupFlow');
const {getNewChatDraft,resetNewChatDraft}=await import('../src/renderer/newChatDraft');
(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;
const errors:unknown[]=[];
await store.boot();
assert.equal(store.getState().boot.phase,'ready');

const text=()=>document.body.textContent??'';
const button=(label:string)=>{const found=Array.from(document.querySelectorAll('button')).find(node=>(node.textContent??'').trim()===label) as HTMLButtonElement|undefined;assert.ok(found,`button "${label}" is shown`);return found!;};
const guide=()=>document.querySelector('[data-testid="setup-guide"]');
const saved=()=>calls.filter(call=>call.command==='setup.saveProgress').map(call=>call.input);
const settle=async(ms=40)=>{await act(async()=>{await delay(ms);});};
async function mount(node:React.ReactElement){const host=document.createElement('div');document.body.appendChild(host);const root=createRoot(host,{onUncaughtError:error=>errors.push(error)});await act(async()=>{root.render(node);});await settle();return ()=>act(async()=>{root.unmount();host.remove();});}


// Cloning from the folder step hands the guide back through the clone sheet's landing hook, not a poll that can fire much later.
ready=false;progress={step:'folder',startedAt:'2026-09-24T00:00:00Z',completedAt:null,dismissedAt:null,skipped:[]};flow.resetSetupGuide();calls.length=0;
const unmount=await mount(<SetupGuideHost/>);
assert.match(text(),/Add a folder/,'the guide is on the folder step');
const realSetInterval=globalThis.setInterval;let intervals=0;
(globalThis as any).setInterval=((...args:any[])=>{intervals++;return (realSetInterval as any)(...args);}) as any;
// Spec: MUS-SPEC-01-670A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-670a)
await check('cloning from the setup guide hands back through the clone sheet and leaves no background poll',async()=>{
  await act(async()=>{button('Clone a repository…').click();});await settle();
  assert.equal(flow.getSetupGuide().open,false,'the guide steps aside for the clone sheet');
  assert.equal(intervals,0,'no background poll is left running after the clone sheet is closed');
});
// Spec: MUS-SPEC-01-670B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-670b)
await check('a folder added later does not reopen the setup guide after an abandoned clone',async()=>{
  // The user abandons the clone, and later adds a folder some other way: the guide must stay closed.
  // Unchanged from before the check() wrap.
  const sheet=await import('../src/renderer/components/CloneRepositorySheet');
  sheet.closeCloneSheet();
  await act(async()=>{emit({type:'snapshot',snapshot:{folders:[{id:'f9',name:'late',path:'/late'}],chats:[],projects:[],version:2}});});
  await delay(1300);
  assert.equal(flow.getSetupGuide().open,false,'a folder added later does not pop the setup guide back open');
});
(globalThis as any).setInterval=realSetInterval;
await unmount();
assert.deepEqual(errors,[]);
console.log('setup-clone-handoff-dom: ok');
process.exit(0);
