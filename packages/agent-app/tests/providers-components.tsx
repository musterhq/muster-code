import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
const calls:{command:string;input:any}[]=[];
const providers=[
  {id:'hybrow',name:'Hybrow OmniRoute',available:true,status:'ready',source:'Existing local provider profile',identityMasked:'Gateway profile · account hidden',models:[{id:'codex/gpt-5.6-terra',name:'GPT 5.6 Terra'}],detail:'Local model catalog configured.'},
  {id:'codex',name:'Codex CLI (ChatGPT)',available:false,status:'configured',source:'Local configuration discovery',identityMasked:'ChatGPT account on file',models:[],detail:'auth.json holds ChatGPT sign-in tokens (auth mode: chatgpt); not verified. No runnable adapter is enabled for this entry.'},
  {id:'custom_123',name:'Local compatible server',available:false,status:'configured',source:'Added in Muster',identityMasked:'No account metadata',custom:true,endpoint:'http://127.0.0.1:8080/v1',apiKeyEnv:'LOCAL_KEY',models:[{id:'fixture',name:'fixture'}],detail:'Model discovery succeeded. Chat execution is not enabled yet.'},
  {id:'claude-code',name:'Claude Code',available:false,status:'not-detected',source:'Local configuration discovery',identityMasked:'',models:[],detail:'no Claude Code files found'},
];
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});if(command==='providers.list')return providers;if(command==='providers.check')return providers[2];if(command==='providers.cancelCheck')return;}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {ProvidersScreen}=await import('../src/renderer/components/ProvidersScreen');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<ProvidersScreen/>);await delay(60);
assert.deepEqual(errors,[]);
assert.match(document.body.textContent!,/Accounts & providers/);
assert.match(document.body.textContent!,/default for new chats/);
assert.match(document.body.textContent!,/Ready for chats/);
assert.match(document.body.textContent!,/Profile detected · unavailable for chats/);
assert.match(document.body.textContent!,/No runnable model catalog reported/);
assert.match(document.body.textContent!,/Supported providers not detected/);
assert.match(document.body.textContent!,/Discovered · not available to chats/);
assert.match(document.body.textContent!,/Credentials from LOCAL_KEY/);
assert.ok(calls.some(call=>call.command==='providers.list'));
root.unmount();
console.log('Provider settings checks passed: default provenance, truthful availability, detected and absent profiles, and custom endpoint catalog status.');
