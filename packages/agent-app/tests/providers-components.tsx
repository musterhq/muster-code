import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
// linkedom has no legacy attachEvent; react-dom's IE9 input polyfill probes for it on focusin.
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
const providers=[
  {id:'hybrow',name:'Hybrow OmniRoute',available:true,status:'ready',source:'Existing local provider profile',identityMasked:'g***@gmail.com',models:[{id:'codex/gpt-5.6-terra',name:'GPT 5.6 Terra'}],detail:'Local model catalog configured.'},
  {id:'custom_ready',name:'Available local API',available:true,status:'ready',source:'Added in Muster',identityMasked:'No account metadata',custom:true,endpoint:'http://127.0.0.1:8081/v1',models:[{id:'fixture-ready',name:'fixture-ready'}],detail:'Available.'},
  {id:'codex',name:'Codex CLI (ChatGPT)',available:false,status:'configured',source:'Local configuration discovery',identityMasked:'ChatGPT account on file',models:[],detail:'auth.json holds ChatGPT sign-in tokens (auth mode: chatgpt); not verified. No runnable adapter is enabled for this entry.'},
  {id:'custom_123',name:'Local compatible server',available:false,status:'configured',source:'Added in Muster',identityMasked:'No account metadata',custom:true,endpoint:'http://127.0.0.1:8080/v1',apiKeyEnv:'LOCAL_KEY',models:[{id:'fixture',name:'fixture'}],detail:'Model discovery succeeded. Chat execution is not enabled yet.'},
  {id:'openai-direct_abcdef0123',name:'OpenAI Direct · Work',available:true,status:'ready',source:'Codex account',identityMasked:'w***@example.com',models:[{id:'gpt-5.6-terra',name:'GPT 5.6 Terra'}],detail:'Ready.'},
  {id:'claude-code',name:'Claude Code',available:false,status:'not-detected',source:'Local configuration discovery',identityMasked:'',models:[],detail:'no Claude Code files found'},
];
const diagnosis=(id:string)=>id==='codex'?{id,stage:'auth-expired',summary:'The ChatGPT sign-in expired.',hint:'Run `codex login` in Terminal to sign in again.',command:'codex login',version:'codex-cli 0.99.0',checkedAt:'2026-09-22T12:00:00Z',diagnostics:'stage: auth-expired\nhome: ~'}:{id,stage:'ok',summary:'Ready.',version:null,checkedAt:'2026-09-22T12:00:00Z',diagnostics:'stage: ok'};
window.muster={subscribe(){return()=>{}},async invoke(command:string,input:any){calls.push({command,input});if(command==='providers.list')return providers;if(command==='providers.check')return providers[2];if(command==='providers.cancelCheck')return;
  if(command==='providers.identity')return {identity:'grawish06@gmail.com'};
  if(command==='providers.diagnose')return diagnosis(input.id);
  if(command==='providers.usage')return input.id==='hybrow'?[{providerId:'hybrow',primary:{usedPercent:42,windowMinutes:300,resetsAt:new Date(Date.now()+20*60_000).toISOString()},secondary:{usedPercent:8,windowMinutes:10080,resetsAt:null},source:'live',updatedAt:new Date().toISOString()}]:[];
  if(command==='providers.secret.status')return {stored:input.providerId==='custom_123',updatedAt:'2026-09-20T00:00:00Z',secureStorage:true};
  if(command==='providers.captureStatus')return {captured:true};
  if(command==='clipboard.write')return;
  if(command==='providers.accounts.list')return {accounts};
  if(command==='providers.accounts.remove'){accounts=accounts.filter(a=>a.id!==input.id);return {accounts};}
  if(command==='chat.defaults')return {providerId:'hybrow',model:'codex/gpt-5.6-terra',source:'runtime'};
  if(command==='settings.set')return undefined;}} as any;
let accounts=[{id:'default',label:'Default sign-in',providerIds:['hybrow','openai-direct'],ready:true,removable:false},{id:'abcdef0123',label:'Work',providerIds:['openai-direct_abcdef0123'],ready:true,removable:true}];
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
assert.equal(Array.from(document.querySelectorAll('.settings-provider h2')).filter(node=>node.textContent==='Available local API').length,1,'an available custom endpoint appears only in Ready for chats');
assert.equal(Array.from(document.querySelectorAll('.settings-provider h2')).filter(node=>node.textContent==='Local compatible server').length,1,'an unavailable custom endpoint appears only in Compatible endpoints');
assert.ok(calls.some(call=>call.command==='providers.list'));

// PRO-09: the masked field holds a fixed placeholder; no character of the identity (or the runtime's partial mask) is in the DOM.
const html=()=>document.body.innerHTML;
for(const leak of ['g***','@gmail','grawish'])assert.ok(!html().includes(leak),`masked DOM leaks ${leak}`);
const field=()=>Array.from(document.querySelectorAll('.provider-identity-field')).find(node=>node.getAttribute('aria-label')!.includes('Hybrow')) as HTMLButtonElement|undefined;
assert.ok(field(),'the whole identity field is the reveal button');
assert.equal(field()!.getAttribute('aria-pressed'),'false');
assert.match(field()!.textContent!,/••••••.*ChatGPT account/);
assert.ok(!calls.some(call=>call.command==='providers.identity'),'the identity is not fetched until reveal');
field()!.click();await delay(30);
assert.ok(calls.some(call=>call.command==='providers.identity'&&call.input.id==='hybrow'));
assert.match(field()!.textContent!,/grawish06@gmail\.com/);
assert.equal(field()!.getAttribute('aria-pressed'),'true');
field()!.click();await delay(30);
assert.ok(!html().includes('grawish'),'hiding drops the identity from the DOM');

// PRO-03/PRO-11: staged diagnosis with a fix, CLI version and redacted diagnostics.
const codexCard=Array.from(document.querySelectorAll('.settings-provider')).find(node=>node.querySelector('h2')?.textContent==='Codex CLI (ChatGPT)')!;
assert.ok(codexCard.querySelector('.provider-diagnosis[data-stage="auth-expired"]'));
assert.match(codexCard.textContent!,/Sign-in expired/);
assert.match(codexCard.textContent!,/codex-cli 0\.99\.0/);
assert.match(codexCard.textContent!,/Open in Terminal/);
assert.match(codexCard.textContent!,/codex login/);
(Array.from(codexCard.querySelectorAll('button')).find(node=>node.textContent==='Copy diagnostics') as HTMLButtonElement).click();await delay(20);
assert.equal(calls.find(call=>call.command==='clipboard.write')?.input.text,'stage: auth-expired\nhome: ~');
assert.match(codexCard.textContent!,/Copied/);

// PRO-06: usage windows with reset time.
const hybrowCard=Array.from(document.querySelectorAll('.settings-provider')).find(node=>node.querySelector('h2')?.textContent==='Hybrow OmniRoute')!;
assert.match(hybrowCard.textContent!,/5-hour42% used/);
assert.match(hybrowCard.textContent!,/resets in 20 min/);
assert.match(hybrowCard.textContent!,/Weekly8% used/);

// PRO-02: in-app key with masked status; entry is a password field with paste and a capture warning.
const customCard=Array.from(document.querySelectorAll('.settings-provider')).find(node=>node.querySelector('h2')?.textContent==='Local compatible server')!;
assert.match(customCard.textContent!,/Stored in Keychain/);
(Array.from(customCard.querySelectorAll('button')).find(node=>node.textContent==='Replace key') as HTMLButtonElement).click();await delay(20);
const keyInput=customCard.querySelector('.provider-key-input input') as HTMLInputElement;
assert.equal(keyInput.getAttribute('type'),'password');
assert.ok(customCard.querySelector('[aria-label="Paste API key from clipboard"]'));
keyInput.dispatchEvent(new window.Event('focus',{bubbles:true}));keyInput.dispatchEvent(new window.Event('focusin',{bubbles:true}));await delay(30);
assert.match(customCard.textContent!,/being captured or shared/);
// PRO-X2 / USER-35: account switcher with an active indicator, masked identities and remove.
const accountRow=(id:string)=>document.querySelector(`.provider-account[data-account="${id}"]`)!;
assert.match(accountRow('default').textContent!,/Active for new chats/);
assert.match(accountRow('abcdef0123').textContent!,/Signed in/);
assert.match(accountRow('abcdef0123').textContent!,/••••••/);
for(const leak of ['w***','@example'])assert.ok(!html().includes(leak),`account row leaks ${leak}`);
(Array.from(accountRow('abcdef0123').querySelectorAll('button')).find(node=>node.textContent==='Use for new chats') as HTMLButtonElement).click();await delay(40);
const switched=calls.find(call=>call.command==='settings.set');
assert.deepEqual(switched?.input,{key:'general.defaultModel',value:{providerId:'openai-direct_abcdef0123',model:'gpt-5.6-terra'}});
assert.match(accountRow('abcdef0123').textContent!,/Active for new chats/);
assert.doesNotMatch(accountRow('default').textContent!,/Active for new chats/);
assert.equal(accountRow('default').querySelector('[aria-label^="Remove"]'),null,'the default sign-in cannot be removed');
(accountRow('abcdef0123').querySelector('[aria-label="Remove Work"]') as HTMLButtonElement).click();await delay(20);
assert.match(accountRow('abcdef0123').textContent!,/sign-in files stay on disk/);
(Array.from(accountRow('abcdef0123').querySelectorAll('button')).find(node=>node.textContent==='Remove account') as HTMLButtonElement).click();await delay(40);
assert.deepEqual(calls.filter(call=>call.command==='settings.set').at(-1)?.input,{key:'general.defaultModel',value:null},'removing the active account returns new chats to the default');
assert.equal(document.querySelector('.provider-account[data-account="abcdef0123"]'),null);
assert.match(accountRow('default').textContent!,/Active for new chats/);
root.unmount();
console.log('Provider settings checks passed: default provenance, truthful availability, detected and absent profiles, custom endpoint catalog status, leak-free masking, staged diagnosis, usage and in-app keys.');
