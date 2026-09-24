import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
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

// 1. A provider is already ready: no onboarding, silently.
ready=true;
let unmount=await mount(<SetupGuideHost/>);
assert.equal(guide(),null,'no setup guide when a provider is ready');
await unmount();

// 2. Nothing signed in: the guide opens on launch; Get started → Connect; Set up later dismisses and remembers.
ready=false;flow.resetSetupGuide();calls.length=0;
unmount=await mount(<SetupGuideHost/>);
assert.ok(guide(),'the guide opens when nothing is signed in');
assert.match(text(),/Welcome to Muster/);
assert.ok(saved().some(input=>typeof input.startedAt==='string'),'first launch is recorded');
await act(async()=>{button('Get started').click();});await settle();
assert.match(text(),/Connect a model/);
assert.deepEqual(saved().at(-1),{step:'connect'});
assert.match(text(),/ChatGPT \(Codex CLI\)/);
assert.match(text(),/Not signed in/);
assert.match(text(),/codex login/,'the exact sign-in command is shown');
await act(async()=>{button('Sign in').click();});await settle();
assert.ok(calls.some(call=>call.command==='setup.openTerminal'&&call.input.tool==='codex'),'with no chat open, sign-in opens in Terminal');
assert.match(text(),/Muster notices the sign-in on its own/);
// The sign-in lands: the runtime pushes the new list; a notice names it.
ready=true;
await act(async()=>{emit({type:'providersChanged',providers:providers(),connected:[{id:'openai-direct',name:'OpenAI Direct',models:1}],reason:'files'});});await settle();
assert.equal(store.getState().providers.value?.[0]?.available,true,'the model picker list updates without a rescan');
assert.ok(store.getState().notices.some(notice=>notice.message==='ChatGPT connected · 1 model available'));
assert.match(text(),/Ready/);
await act(async()=>{button('Set up later').click();});await settle();
assert.equal(guide(),null);
assert.equal(typeof saved().at(-1).dismissedAt,'string','Set up later is persisted');
await unmount();

// 3. Resume at the saved step, navigate back/forward, skip the optional step, finish with a starter draft.
ready=false;progress={step:'folder',startedAt:'2026-09-24T00:00:00Z',completedAt:null,dismissedAt:null,skipped:[]};flow.resetSetupGuide();calls.length=0;
unmount=await mount(<SetupGuideHost/>);
assert.match(text(),/Add a folder/,'resumes at the saved step');
await act(async()=>{button('Back').click();});await settle();
assert.match(text(),/Connect a model/);
await act(async()=>{button('Continue without a model').click();});await settle();
await act(async()=>{button('Skip for now').click();});await settle();
assert.match(text(),/Optional capabilities/);
assert.deepEqual(saved().at(-1).skipped,['folder']);
assert.match(text(),/Screen Recording/);assert.match(text(),/Off/);
assert.match(text(),/Docker Desktop is installed but not running/);
await act(async()=>{button('Skip').click();});await settle();
assert.match(text(),/You’re ready/);
assert.deepEqual(saved().at(-1).skipped,['folder','capabilities']);
resetNewChatDraft();
await act(async()=>{button('Explain this codebase').click();});await settle();
assert.equal(guide(),null);
assert.equal(typeof saved().find(input=>input.completedAt)?.completedAt,'string');
assert.match(getNewChatDraft().text,/tour of this codebase/,'a starter draft is filled, not sent');
assert.equal(getNewChatDraft().open,true);
assert.ok(!calls.some(call=>call.command==='chat.send'));
await unmount();

// 4. Settings › General checklist shows live status and reopens the guide at the right step.
unmount=await mount(<><SetupChecklist/><SetupGuideHost/></>);
assert.match(text(),/Connect a model/);assert.match(text(),/No provider can run a chat yet/);
assert.match(text(),/Screen Recording on · Accessibility off/);
await act(async()=>{button('Set up').click();});await settle();
assert.equal(flow.getSetupGuide().open,true);
assert.equal(flow.getSetupGuide().step,'connect');
await unmount();
flow.resetSetupGuide();

// 5. The inline empty state offers the connect actions instead of a raw error.
calls.length=0;
unmount=await mount(<ConnectModelPrompt/>);
assert.match(text(),/Connect a model to start/);
await act(async()=>{button('Sign in with ChatGPT').click();});await settle();
assert.ok(calls.some(call=>call.command==='setup.openTerminal'&&call.input.tool==='codex'));
await act(async()=>{button('Add API connection').click();});await settle();
assert.deepEqual(flow.getSetupGuide(),{open:true,step:'connect',addConnection:true});
await unmount();

assert.deepEqual(errors,[]);
console.log('setup-guide-dom: ok');
process.exit(0);
