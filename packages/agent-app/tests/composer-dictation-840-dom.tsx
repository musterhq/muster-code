/** #840: dictation in the composer. A fake MediaRecorder and getUserMedia stand in for the microphone and a fake
 *  `dictation.transcribe` for the transcription service: no real microphone, no network. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
(window.document as any).oninput=null;
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,HTMLButtonElement:window.HTMLButtonElement,Element:window.Element,Node:window.Node,Event:window.Event,CustomEvent:window.CustomEvent,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
const styles=()=>({getPropertyValue:()=>'',direction:'ltr',position:'static',overflow:'visible',overflowX:'visible',overflowY:'visible',display:'block',visibility:'visible',animationName:'none',transitionProperty:'none',transitionDuration:'0s',animationDuration:'0s',lineHeight:'20px',paddingTop:'3px',paddingBottom:'3px',paddingLeft:'0px',paddingRight:'0px'});
Object.assign(globalThis,{getComputedStyle:styles});window.getComputedStyle=styles;
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:600,height:30,left:0,top:0,right:600,bottom:30});
window.HTMLElement.prototype.getClientRects=function(){return [this.getBoundingClientRect()];};
window.HTMLElement.prototype.scrollIntoView=function(){};
window.HTMLTextAreaElement.prototype.setSelectionRange=function(start:number,end:number){this.selectionStart=start;this.selectionEnd=end;};
window.HTMLCanvasElement.prototype.getContext=()=>null;

// The fake microphone: getUserMedia hands out a track that records whether it was stopped.
const AUDIO=new Uint8Array([0x1a,0x45,0xdf,0xa3,...Array.from('FAKE-OPUS',c=>c.charCodeAt(0))]);
const tracks:{stopped:boolean;stop():void}[]=[];let microphoneOpens=0;
class FakeRecorder{
  static isTypeSupported(type:string){return type.startsWith('audio/webm');}
  state='inactive';mimeType:string;ondataavailable:((event:{data:Blob})=>void)|null=null;onstop:(()=>void)|null=null;onerror:((event:unknown)=>void)|null=null;
  constructor(_stream:unknown,options?:{mimeType?:string}){this.mimeType=options?.mimeType??'audio/webm';}
  start(){this.state='recording';}
  stop(){if(this.state==='inactive')return;this.state='inactive';setTimeout(()=>{this.ondataavailable?.({data:new Blob([AUDIO],{type:this.mimeType})});this.onstop?.();},0);}
}
Object.defineProperty(globalThis,'navigator',{configurable:true,value:{userAgent:'Mozilla/5.0 Muster Electron/39.0.0',language:'en-US',platform:'MacIntel',
  mediaDevices:{async getUserMedia(constraints:any){assert.deepEqual(Object.keys(constraints),['audio'],'audio only');microphoneOpens++;const track={stopped:false,stop(){this.stopped=true;}};tracks.push(track);return {getTracks:()=>[track]};}}}});
Object.assign(globalThis,{MediaRecorder:FakeRecorder});(window as any).MediaRecorder=FakeRecorder;

const twoHoursAgo=new Date(Date.now()-2*3600_000).toISOString();
let chat:any={id:'one',title:'one',folderId:'folder',status:'completed',updatedAt:twoHoursAgo,pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'hybrow'};
const listeners=new Set<(event:any)=>void>();
const snapshot=()=>JSON.parse(JSON.stringify({version:1,chats:[chat],folders:[{id:'folder',name:'Folder',path:'/fixture'}],projects:[],activeChatId:'one'}));
const emit=()=>{for(const fn of listeners)fn({type:'snapshot',snapshot:snapshot()});};
const calls:{command:string;input:any}[]=[];
const view=(backend:string,extra:Record<string,unknown>={})=>({backend,ready:backend==='cloud',...(backend==='cloud'?{}:{reason:'Choose a dictation service in Settings › Chat.'}),
  backends:[{id:'off',label:'Off',available:true},{id:'cloud',label:'Cloud',available:true},{id:'macos',label:'On-device',available:false,reason:'Coming in a later version.'}],
  cloud:{connectionId:null,endpoint:'',model:'whisper-1',keyStored:false,secureStorage:true},...extra});
let config:any=view('cloud',{cloud:{connectionId:null,endpoint:'https://speech.example/v1',model:'whisper-1',keyStored:true,secureStorage:true}});
let microphone:any={granted:true,status:'granted'};
let transcript='ship the release notes';let transcribeGate:Promise<void>=Promise.resolve();
window.muster={subscribe(fn:any){listeners.add(fn);return()=>{listeners.delete(fn);};},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:0};
  if(command==='chat.send')return {runId:'run'};
  if(command==='chat.steer')return {steered:true};
  if(command==='chat.update'){chat={...chat,...input};return chat;}
  if(command==='chat.contextTelemetry')return {usedTokens:null,windowTokens:null,source:null,compacted:false,updatedAt:null};
  if(command==='providers.list')return [{id:'hybrow',name:'Hybrow',available:true,models:[{id:'fixture',name:'Fixture'}]},{id:'custom-router',name:'Router',available:true,custom:true,endpoint:'https://router.example/v1',models:[]}];
  if(command==='plugins.list'||command==='plugins.inventory'||command==='skills.list'||command==='files.list')return [];
  if(command==='files.search')return {entries:[],truncated:false};
  if(command==='artifacts.sideChat.list')return {sideChats:[]};
  if(command==='computer.permissions')return {accessibility:'granted',screen:'granted'};
  if(command==='settings.get')return {values:{}};
  if(command==='dictation.config.get')return config;
  if(command==='dictation.config.set'){
    const cloud={...config.cloud,...(input.endpoint!==undefined?{endpoint:input.endpoint}:{}),...(input.model!==undefined?{model:input.model}:{}),...(input.connectionId!==undefined?{connectionId:input.connectionId}:{}),...(input.apiKey?{keyStored:true}:{})};
    config=view(input.backend??config.backend,{cloud});return config;
  }
  if(command==='dictation.microphone')return microphone;
  if(command==='dictation.transcribe'){await transcribeGate;return {text:transcript};}
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {Composer}=await import('../src/renderer/components/Composer');
const {PreferencesScreen}=await import('../src/renderer/components/PreferencesScreen');
function Screen(){const active=store.activeChat();return active?<Composer chat={active}/>:null;}
const errors:unknown[]=[];const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
await store.boot();root.render(<Screen/>);await delay(400);
assert.deepEqual(errors,[]);
const until=async(ok:()=>unknown,what:string,ms=3000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);assert.ok(ok(),what);};
const $=(selector:string)=>document.querySelector(selector) as HTMLElement|null;
const field=()=>$('[data-testid="composer-input"]') as HTMLTextAreaElement;
const mic=()=>$('[data-testid="composer-mic"]') as HTMLButtonElement|null;
const status=()=>document.querySelector('.composer-status.is-dictation')?.textContent??'';
const press=async(target:Element,type:'keydown'|'keyup',key:string,extra:Record<string,unknown>={})=>{const event=new window.Event(type,{bubbles:true,cancelable:true});Object.assign(event,{key,...extra});target.dispatchEvent(event);await delay(30);return event;};
const count=(command:string)=>calls.filter(call=>call.command===command).length;
const setDraft=async(text:string)=>{store.setComposerDraft('one',text);await delay(40);};

// Spec: MUS-SPEC-01-840A (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840a)
await check('clicking the mic records, the transcript fills the composer, and Enter sends it',async()=>{
  await until(()=>mic(),'the mic shows in the desktop app');
  let open!:()=>void;transcribeGate=new Promise(resolve=>{open=resolve;});
  mic()!.click();
  await until(()=>mic()?.getAttribute('aria-pressed')==='true','the mic shows it is recording');
  assert.equal(microphoneOpens,1);
  assert.match(status(),/Listening/);assert.match(status(),/Esc/);
  mic()!.click();
  await until(()=>count('dictation.transcribe')===1,'the recording is sent for transcription');
  const sent=calls.find(call=>call.command==='dictation.transcribe')!.input;
  assert.match(sent.mime,/^audio\/webm/);
  assert.deepEqual([...Buffer.from(sent.audio,'base64')],[...AUDIO],'the recording travels as base64');
  await until(()=>/Transcribing/.test(status()),'the status says it is transcribing');
  assert.equal(tracks.at(-1)!.stopped,true,'the microphone is released when recording stops');
  open();
  await until(()=>field().value==='ship the release notes','the transcript fills the composer');
  assert.notEqual(mic()!.getAttribute('aria-pressed'),'true');
  await press(field(),'keydown','Enter');
  await until(()=>calls.some(call=>call.command==='chat.send'),'Enter sends');
  assert.equal(calls.find(call=>call.command==='chat.send')!.input.text,'ship the release notes');
});
transcribeGate=Promise.resolve();
await setDraft('');

// Spec: MUS-SPEC-01-840B (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840b)
await check('Esc while recording cancels and keeps the draft unchanged',async()=>{
  await setDraft('keep me');
  const before=count('dictation.transcribe');
  mic()!.click();
  await until(()=>mic()?.getAttribute('aria-pressed')==='true','recording');
  await press(field(),'keydown','Escape');
  await until(()=>mic()?.getAttribute('aria-pressed')!=='true','Esc stops recording');
  await delay(80);
  assert.equal(tracks.at(-1)!.stopped,true,'the microphone is released');
  assert.equal(count('dictation.transcribe'),before,'nothing is transcribed');
  assert.equal(field().value,'keep me');
});
await setDraft('');

// Spec: MUS-SPEC-01-840C (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840c)
await check('holding the dictation shortcut records until the key is released',async()=>{
  transcript='held words';
  const before=count('dictation.transcribe');
  await press(field(),'keydown','d',{metaKey:true,shiftKey:true,code:'KeyD'});
  await until(()=>mic()?.getAttribute('aria-pressed')==='true','the shortcut starts recording');
  await delay(500);
  assert.equal(count('dictation.transcribe'),before,'still recording while held');
  await press(field(),'keyup','d',{metaKey:true,shiftKey:true,code:'KeyD'});
  await until(()=>count('dictation.transcribe')===before+1,'release transcribes');
  await until(()=>field().value==='held words','the words are inserted');
});
await setDraft('');

// Spec: MUS-SPEC-01-840D (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840d)
await check('a denied microphone shows how to allow it and records nothing',async()=>{
  microphone={granted:false,status:'denied',message:'Microphone access is off for Muster. Turn it on in System Settings › Privacy & Security › Microphone.'};
  const opens=microphoneOpens;
  mic()!.click();
  await until(()=>/System Settings › Privacy & Security › Microphone/.test(document.body.textContent??''),'the message says how to allow the microphone');
  assert.equal(microphoneOpens,opens,'getUserMedia is never called');
  assert.notEqual(mic()!.getAttribute('aria-pressed'),'true');
  microphone={granted:true,status:'granted'};
});
await setDraft('');

// Spec: MUS-SPEC-01-840E (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840e)
await check('dictation works in the steer composer while a chat runs',async()=>{
  chat={...chat,status:'running'};emit();await delay(60);
  transcript='use the smaller fixture';
  mic()!.click();
  await until(()=>mic()?.getAttribute('aria-pressed')==='true','recording while the chat runs');
  mic()!.click();
  await until(()=>field().value==='use the smaller fixture','the transcript fills the steer composer');
  const sends=count('chat.send');
  await press(field(),'keydown','Enter');
  await until(()=>calls.some(call=>call.command==='chat.steer'),'Enter steers');
  assert.equal(calls.find(call=>call.command==='chat.steer')!.input.text,'use the smaller fixture');
  assert.equal(count('chat.send'),sends,'not a new send');
  chat={...chat,status:'completed'};emit();await delay(40);
});

// Spec: MUS-SPEC-01-840F (docs/spec/clauses/01-chat-and-composer.md#mus-spec-01-840f)
await check('Settings › Chat chooses the dictation service and saves a cloud key',async()=>{
  config=view('off');
  store.openAppSettings('chat');
  root.render(<PreferencesScreen/>);
  const segment=(label:string)=>[...document.querySelectorAll('[aria-label="Dictation"] button')].find(button=>button.textContent===label) as HTMLButtonElement|undefined;
  await until(()=>segment('Cloud'),'Settings › Chat shows Dictation with a Cloud option');
  assert.match(document.body.textContent??'',/leaves this computer only/,'the privacy promise is stated');
  segment('Cloud')!.click();
  await until(()=>$('[aria-label="Transcription endpoint"]'),'the cloud fields appear');
  const type=(selector:string,value:string)=>{const element=$(selector) as HTMLInputElement;let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);descriptor!.set!.call(element,value);element.dispatchEvent(new window.Event('input',{bubbles:true}));};
  type('[aria-label="Transcription endpoint"]','https://speech.example/v1');await delay(20);
  type('[aria-label="Transcription model"]','whisper-1');await delay(20);
  type('[aria-label="Transcription API key"]','sk-typed-key');await delay(20);
  ([...document.querySelectorAll('button')].find(button=>button.textContent==='Save') as HTMLButtonElement).click();
  await until(()=>calls.some(call=>call.command==='dictation.config.set'&&call.input.apiKey==='sk-typed-key'),'Save sends the key');
  const merged=Object.assign({},...calls.filter(call=>call.command==='dictation.config.set').map(call=>call.input));
  assert.equal(merged.backend,'cloud');
  assert.equal(merged.endpoint,'https://speech.example/v1');
  assert.equal(merged.model,'whisper-1');
  await until(()=>($('[aria-label="Transcription API key"]') as HTMLInputElement).value==='','the key field is cleared after saving');
  assert.match(document.body.textContent??'',/Key saved/);
  assert.equal((document.body.innerHTML).includes('sk-typed-key'),false,'the key is not shown back');
});
assert.deepEqual(errors,[]);
process.exit(0);
