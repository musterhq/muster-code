/** #448/#449 DOM: the Limited chip and notice row, its per-chat choice and fallback model, the queue note, and the two General settings. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const local=new Map<string,string>();
Object.assign(globalThis,{
  window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,
  CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:(k:string)=>local.has(k)?local.get(k)!:null,setItem:(k:string,v:string)=>{local.set(k,v);},removeItem:(k:string)=>{local.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
});
window.MouseEvent=class extends window.Event {};
const calls:{command:string;input:any}[]=[];
const values:any={'general.sendKey':'enter','general.spellcheck':true,'chats.resumeAfterLimit':true,'chats.resumeAfterRestart':true};
window.muster={
  subscribe(){return()=>{};},
  async invoke(command:string,input:any){
    calls.push({command,input});
    if(command==='settings.get')return {values};
    if(command==='settings.set'){values[input.key]=input.value;return {values};}
    if(command==='providers.list')return [{id:'codex',name:'Codex',available:true,identityMasked:'',models:[{id:'gpt-6',name:'GPT-6'}]},{id:'backup',name:'Backup',available:true,identityMasked:'',models:[{id:'b-1',name:'Backup One'}]}];
    if(command==='providers.usage')return [];
    return {};
  },
} as any;

const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {RecoveryNotice}=await import('../src/renderer/components/RecoveryNotice');
const {StatusDot}=await import('../src/renderer/components/StatusDot');
const {QueuedMessages}=await import('../src/renderer/components/QueuedMessages');
const {displayStatus}=await import('../src/renderer/components/runStatus');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const banner=()=>document.querySelector('.chat-error-banner') as HTMLElement|null;
const button=(id:string)=>document.querySelector(`[data-testid="${id}"]`) as HTMLButtonElement;

const resetAt=new Date(Date.now()+42*60_000);
const clock=resetAt.toLocaleTimeString([],{hour:'numeric',minute:'2-digit'});
const base={id:'chat-1',title:'Chat',pinned:false,archived:false,draft:'',status:'failed' as const,updatedAt:'',model:'gpt-6',providerId:'codex',mode:'agent' as const,
  error:'The provider attempt failed: You\'ve hit your usage limit.',recovery:{kind:'failed' as const,retryable:false,reason:'The provider attempt failed: You\'ve hit your usage limit.'}};
const limited={...base,autoResume:{resumeAt:resetAt.toISOString(),resume:true,attempts:0,reason:'usage' as const}};

// The chip: a limited chat reads Limited (header and sidebar share displayStatus and StatusDot).
assert.equal(displayStatus(limited,[]),'limited');
assert.equal(displayStatus({...limited,status:'running'},[]),'running','a continuation that runs shows Working, not Limited');
assert.equal(displayStatus({...limited,autoResume:{...limited.autoResume,gaveUp:true}},[]),'failed');
root.render(<StatusDot status="limited" showLabel/>);await delay(20);
const dot=document.querySelector('.status-dot') as HTMLElement;
assert.equal(dot.dataset.status,'limited');assert.equal(dot.getAttribute('aria-label'),'Limited');assert.equal(dot.textContent,'Limited');

// The notice row: when it resets, what happens then, and this chat's choice (Resume at reset by default).
root.render(<RecoveryNotice chat={limited}/>);await delay(30);
assert.equal(banner()?.dataset.recovery,'limited');
assert.ok(banner()!.textContent!.includes(`Usage limit reached · resets ${clock}.`),banner()!.textContent!);
assert.ok(banner()!.textContent!.includes('Muster continues this chat then. Queued messages follow in order.'));
assert.equal(button('limit-resume').getAttribute('aria-pressed'),'true');
assert.equal(button('limit-dont-resume').getAttribute('aria-pressed'),'false');
assert.ok(!banner()!.textContent!.includes('Continue anyway'),'a limit is not a recovery check');
button('limit-dont-resume').click();await delay(20);
assert.deepEqual(calls.filter(call=>call.command==='chat.autoResume').map(call=>call.input),[{id:'chat-1',resume:false}]);
button('limit-resume').click();await delay(20);
assert.equal(calls.filter(call=>call.command==='chat.autoResume').length,1,'choosing the current option sends nothing');
root.render(<RecoveryNotice chat={{...limited,autoResume:{...limited.autoResume,resume:false}}}/>);await delay(20);
assert.ok(banner()!.textContent!.includes('Send a message when it resets.'));
assert.equal(button('limit-dont-resume').getAttribute('aria-pressed'),'true');

// A rate limit says so; giving up says so once and offers to try again at reset.
root.render(<RecoveryNotice chat={{...limited,autoResume:{...limited.autoResume,reason:'rate'}}}/>);await delay(20);
assert.ok(banner()!.textContent!.includes(`Rate limited by the provider · retrying at ${clock}.`));
root.render(<RecoveryNotice chat={{...limited,autoResume:{...limited.autoResume,gaveUp:true,resumeAt:null}}}/>);await delay(20);
assert.ok(banner()!.textContent!.includes('Still limited after repeated tries. Muster stopped continuing this chat.'));
assert.equal(document.querySelectorAll('[data-testid="limit-dont-resume"]').length,0);

// Fallback model: off by default; choosing one is saved for this chat.
root.render(<RecoveryNotice chat={limited}/>);await delay(40);
const trigger=document.querySelector('.limit-fallback .default-model-trigger') as HTMLButtonElement;
assert.match(trigger.textContent!,/No fallback model/);
trigger.click();await delay(30);
const option=Array.from(document.querySelectorAll('[role="option"]')).find(el=>/Backup One/.test(el.textContent??'')) as HTMLElement;
assert.ok(option,'ready models are listed');option.click();await delay(30);
assert.deepEqual(calls.filter(call=>call.command==='chat.fallbacks').map(call=>call.input),[{id:'chat-1',fallbacks:[{providerId:'backup',model:'b-1'}]}]);

// A running chat shows no limit row; a plain failure keeps the old banner.
root.render(<RecoveryNotice chat={{...limited,status:'running'}}/>);await delay(20);
assert.notEqual(banner()?.dataset.recovery,'limited');
root.render(<RecoveryNotice chat={base}/>);await delay(20);
assert.equal(banner()?.dataset.recovery,'failed');

// The queue banner while it waits for the reset.
root.render(<QueuedMessages chatId="chat-1" items={[{id:'q',text:'then ship it',requestId:'r',attachmentIds:[],createdAt:''}]} paused="limited"/>);await delay(20);
assert.ok(document.body.textContent!.includes('Queue waits for the usage limit to reset'));

// Settings › General: both switches, on by default, wired to settings.set.
const {PreferencesScreen}=await import('../src/renderer/components/PreferencesScreen');
const {openAppSettings}=await import('../src/renderer/store');
openAppSettings('general');
root.render(<PreferencesScreen/>);await delay(80);
const toggle=(label:string)=>Array.from(document.querySelectorAll('.preference-switch')).find(el=>el.getAttribute('aria-label')===label) as HTMLButtonElement;
for(const label of ['Continue when a usage limit resets','Continue interrupted chats after a restart'])assert.equal(toggle(label)?.getAttribute('aria-checked'),'true',`${label} is on by default`);
toggle('Continue interrupted chats after a restart').click();await delay(20);
assert.ok(calls.some(call=>call.command==='settings.set'&&call.input.key==='chats.resumeAfterRestart'&&call.input.value===false));
assert.equal(toggle('Continue interrupted chats after a restart').getAttribute('aria-checked'),'false');
toggle('Continue when a usage limit resets').click();await delay(20);
assert.ok(calls.some(call=>call.command==='settings.set'&&call.input.key==='chats.resumeAfterLimit'&&call.input.value===false));

assert.deepEqual(errors,[]);
root.unmount();
console.log('limit-resume-dom: ok');
process.exit(0);
