import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible',position:'static',overflow:'visible',animationName:'none',animationDuration:'0s',animationDelay:'0s',transitionDuration:'0s',transitionDelay:'0s'};
window.getComputedStyle=()=>style;
window.HTMLElement.prototype.getBoundingClientRect=()=>({height:200,width:600,top:0,left:0,right:600,bottom:200,x:0,y:0});
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,ShadowRoot:window.ShadowRoot,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
// Archived conversations do not auto-start a terminal after a successful empty list.
const chat={id:'retry-chat',title:'Retry checks',archived:true,status:'completed',mode:'agent',permissionMode:'workspace'};
// A live conversation: an empty list auto-starts exactly one shell, however many loads failed first.
const live={id:'live-chat',title:'Live',archived:false,status:'completed',mode:'agent',permissionMode:'workspace'},fresh={...live,id:'fresh-chat',title:'Fresh'};
let calls=0,failures=1,creates=0;const listed:string[]=[];
const listeners=new Set<(event:any)=>void>();
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string){
  if(command==='app.snapshot')return {chats:[chat,live,fresh],folders:[],projects:[],version:1};
  if(command==='terminal.list'){calls++;listed.push(arguments[1].chatId);if(failures-->0)throw new Error("Error invoking remote method 'muster:invoke': Error: Backend not ready");return [];}
  if(command==='terminal.create'){creates++;return {id:`t${creates}`,chatId:arguments[1].chatId,title:'zsh',cwd:'/tmp',status:'running',exitCode:null,owner:'user'};}
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {TerminalsPanel}=await import('../src/renderer/components/ProcessesTab');
const store=await import('../src/renderer/store');
await store.boot();
const root=createRoot(document.getElementById('root')!);
const mount=()=>root.render(<TerminalsPanel chatId="retry-chat" active/>);
const until=async(check:()=>boolean,label:string)=>{
  for(let end=Date.now()+2500;Date.now()<end;){if(check())return;await delay(10);}
  assert.ok(check(),label);
};
const retry=()=>[...document.querySelectorAll('button')].find(button=>button.textContent==='Retry');
mount();
await until(()=>calls>=2,'a failed terminal list must retry automatically');
await until(()=>!document.querySelector('[role="alert"]')&&!!document.querySelector('.processes-empty'),'recovery clears the error and loading state');
assert.equal(calls,2,'stop retrying after success');
assert.equal(creates,0,'list retries never create a session');

root.render(null);await delay(30);
calls=0;failures=100;mount();
await until(()=>!!retry(),'exhausted retries expose a Retry action');
assert.equal(calls,3,'only two automatic retries are allowed');
assert.match(document.body.textContent??'',/Backend not ready/);
assert.doesNotMatch(document.body.textContent??'',/invoking remote method|muster:invoke/,'the raw IPC wrapper is never shown');
await delay(800);assert.equal(calls,3,'retries remain bounded');
failures=0;retry()!.click();
await until(()=>calls===4&&!document.querySelector('[role="alert"]'),'manual Retry reloads and clears the error');
assert.equal(creates,0);

// Unmount while a retry is scheduled: no background list request survives.
root.render(null);await delay(30);calls=0;failures=100;mount();
await until(()=>calls===1,'initial load');
root.render(null);await delay(800);
assert.equal(calls,1,'unmount cancels the pending retry');

// Switching chats while a retry is scheduled cancels it: the old chat is never listed again.
calls=0;listed.length=0;failures=100;mount();
await until(()=>calls===1,'initial load before the switch');
failures=0;root.render(<TerminalsPanel chatId="live-chat" active/>);
await until(()=>creates===1,'the new chat loads and auto-starts its one shell');
await delay(800);
assert.deepEqual(listed,['retry-chat','live-chat'],'the old chat retry was cancelled by the switch');
assert.equal(creates,1,'one shell for the live chat');

// Two failed loads then an empty list on a fresh chat: exactly one shell, and a revisit starts none.
root.render(null);await delay(30);
calls=0;failures=2;creates=0;
root.render(<TerminalsPanel chatId="fresh-chat" active/>);
await until(()=>creates===1,'auto-start after the retried load succeeds');
await delay(800);
assert.equal(calls,3,'two retries, then success');
assert.equal(creates,1,'retries never start extra shells');
root.render(null);await delay(30);calls=0;failures=0;
root.render(<TerminalsPanel chatId="fresh-chat" active/>);
await until(()=>calls===1,'revisit lists once');await delay(100);
assert.equal(creates,1,'auto-start happens at most once per chat per window');
root.unmount();
console.log('PASS terminal load recovery, bounded retries, manual Retry, cancellation on unmount and chat switch, plain errors, no extra shells');
