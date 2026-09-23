import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const store=new Map<string,string>();
Object.assign(globalThis,{
  window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,
  // diff-preferences.ts dispatches a same-realm CustomEvent on `window`; linkedom's dispatchEvent
  // rejects a cross-realm Event, so the global constructor must be linkedom's own here.
  CustomEvent:window.CustomEvent,Event:window.Event,
  localStorage:{getItem:(k:string)=>store.has(k)?store.get(k)!:null,setItem:(k:string,v:string)=>{store.set(k,v);},removeItem:(k:string)=>{store.delete(k);}},
  requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,
});
const calls:{command:string;input:any}[]=[];
const settingsValues:any={
  'general.sendKey':'enter','general.spellcheck':true,'appearance.textSize':100,
  'appearance.theme':'dark','appearance.reducedMotion':'system','appearance.reducedTransparency':'system','chat.inlineDiffs':true,
};
const memoryConfig:any={endpoint:'http://localhost:8888',hasApiKey:false,keyStorage:'none',autoRecall:true,autoRetain:'ask',source:'app'};
window.muster={
  subscribe(){return()=>{};},
  async invoke(command:string,input:any){
    calls.push({command,input});
    if(command==='settings.get')return {values:settingsValues};
    if(command==='settings.set'){Object.assign(settingsValues,{[input.key]:input.value});return {values:settingsValues};}
    if(command==='providers.list')return [{id:'codex',name:'Codex',available:true,identityMasked:'',models:[{id:'gpt-6',name:'GPT-6',efforts:['low','high'],defaultEffort:'high'}]},{id:'off',name:'Off',available:false,identityMasked:'',models:[{id:'x',name:'Hidden'}]}];
    if(command==='providers.usage')return [];
    if(command==='settings.diagnostics')return {collectedAt:new Date().toISOString(),app:{name:'Muster Agent',version:'0.0.0'},electron:null,chrome:null,node:process.version,platform:'darwin',arch:'arm64',osRelease:'',coreLifecycle:null,dataDir:'/data',logPath:'/data/logs/runtime.log',uptimeSeconds:1,processes:[],redactedText:''};
    if(command==='settings.storage')return {dataDir:'/data',total:0,categories:[]};
    if(command==='memory.config.get')return memoryConfig;
    if(command==='memory.config.set'){Object.assign(memoryConfig,input);return memoryConfig;}
    return undefined;
  },
} as any;

// Every 'settings.*' import must go through the same store so `state.screen`/`state.settingsSection`
// stay in sync regardless of entry point (sidebar Settings, Accounts & providers, app menu).
const {openAppSettings,openProvidersTab,getState}=await import('../src/renderer/store');
assert.equal(getState().screen,'work');
openProvidersTab();
assert.deepEqual({screen:getState().screen,section:getState().settingsSection},{screen:'settings',section:'providers'},'Accounts & providers opens the same Settings shell, on the Providers section');
openAppSettings();
assert.equal(getState().settingsSection,'providers','the app-menu Settings entry point (no section) reopens the same shell on its last section');
openAppSettings('general');
assert.deepEqual({screen:getState().screen,section:getState().settingsSection},{screen:'settings',section:'general'});

const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {PreferencesScreen}=await import('../src/renderer/components/PreferencesScreen');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
root.render(<PreferencesScreen/>);await delay(60);
assert.deepEqual(errors,[]);

const nav=()=>Array.from(document.querySelectorAll('.settings-nav-item')) as HTMLButtonElement[];
const navLabels=()=>nav().map(el=>el.textContent);
assert.deepEqual(navLabels(),['General','Appearance','Chat','Providers','Models','Memory','Skills & plugins','Environments','Automations','Shortcuts','Diagnostics','Storage'],'every real section is one consistent shell, not a one-setting page');
const go=(id:string)=>{(nav().find(el=>el.dataset.section===id) as HTMLButtonElement).click();};

// General: real, live settings (not placeholders) — a send-key choice, a working export/import pair,
// and toggling one persists through the runtime settings command, not just local UI state.
assert.match(document.body.textContent!,/Send messages with/);
assert.match(document.body.textContent!,/Export settings/);
const spellcheckSwitch=Array.from(document.querySelectorAll('.preference-switch')).find(el=>el.getAttribute('aria-label')==='Check spelling') as HTMLButtonElement;
assert.equal(spellcheckSwitch.getAttribute('aria-checked'),'true','spellcheck on by default');
spellcheckSwitch.click();await delay(10);
assert.equal(spellcheckSwitch.getAttribute('aria-checked'),'false','spellcheck off after click');
assert.ok(calls.some(call=>call.command==='settings.set'&&call.input.key==='general.spellcheck'&&call.input.value===false),'the row is wired to the real settings.set command, not a decorative control');

// Default model: a real provider + model + reasoning picker listing only ready providers, saved through settings.set.
const modelTrigger=document.querySelector('.default-model-trigger') as HTMLButtonElement;
assert.match(modelTrigger.textContent!,/Built-in default/);
modelTrigger.click();await delay(10);
const modelOptions=()=>Array.from(document.querySelectorAll('.default-model-list [role="option"]')) as HTMLButtonElement[];
assert.deepEqual(modelOptions().map(el=>el.textContent),['Built-in default','GPT-6'],'only ready providers\' models are offered');
modelOptions()[1]!.click();await delay(10);
assert.deepEqual(settingsValues['general.defaultModel'],{providerId:'codex',model:'gpt-6'});
const low=Array.from(document.querySelectorAll('.default-model-segments button')).find(el=>el.textContent==='Light') as HTMLButtonElement;
low.click();await delay(10);
assert.deepEqual(settingsValues['general.defaultModel'],{providerId:'codex',model:'gpt-6',effort:'low'},'reasoning effort saves with the model');
assert.match((document.querySelector('.default-model-trigger') as HTMLElement).textContent!,/GPT-6.*Light/);
// Keyboard: the listbox has roving focus — opening lands on the current choice, arrows move, Home/End jump.
{
  // linkedom tracks no focus: a local shim for this block, removed again at its end.
  let focused:any=null;const originalFocus=window.HTMLElement.prototype.focus;
  window.HTMLElement.prototype.focus=function(){focused=this;};
  Object.defineProperty(window.document,'activeElement',{configurable:true,get:()=>focused??window.document.body});
  const listKey=(name:string)=>{const target=focused??document.querySelector('.default-model-list')!;const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});target.dispatchEvent(event);};
  const focusedOption=()=>modelOptions().indexOf(focused);
  modelTrigger.click();await delay(10); // close
  modelTrigger.click();await delay(10); // reopen
  assert.equal(focusedOption(),1,'opening focuses the selected option');
  listKey('ArrowDown');await delay(0);
  assert.equal(focusedOption(),0,'ArrowDown wraps from the last option to the first');
  listKey('End');await delay(0);
  assert.equal(focusedOption(),1);
  listKey('ArrowUp');await delay(0);
  assert.equal(focusedOption(),0);
  assert.ok(modelOptions().every(option=>option.getAttribute('tabindex')==='-1'),'options stay out of the Tab order');
  modelTrigger.click();await delay(10);
  window.HTMLElement.prototype.focus=originalFocus;
  delete (window.document as any).activeElement;
}

// Appearance: text size, motion/transparency overrides, and the summary card's real, wired toggle.
go('appearance');await delay(10);
assert.match(document.body.textContent!,/Show summary card/);
const allSwitches=Array.from(document.querySelectorAll('.preference-switch'));
const summarySwitch=allSwitches.find(el=>el.getAttribute('aria-label')==='Show summary card') as HTMLButtonElement;
assert.equal(summarySwitch.getAttribute('aria-checked'),'true','the summary card is visible by default');
summarySwitch.click();await delay(10);
assert.equal(summarySwitch.getAttribute('aria-checked'),'false','summary card hidden after click');
assert.equal(store.get('muster.summaryHidden'),'true','the toggle persists through the same store the summary card reads');
summarySwitch.click();await delay(10);
assert.equal(store.get('muster.summaryHidden'),'false');

// Chat: inline diffs plus the real global diff defaults (split/unified, wrap, ignore whitespace, full file, text size).
go('chat');await delay(10);
assert.match(document.body.textContent!,/Diff view defaults/);
const diffLayout=Array.from(document.querySelectorAll('.preference-segmented')).find(el=>el.getAttribute('aria-label')==='Diff layout') as HTMLElement;
const splitButton=Array.from(diffLayout.querySelectorAll('button')).find(el=>el.textContent==='Split') as HTMLButtonElement;
assert.equal(splitButton.getAttribute('aria-checked'),'false','unified is the default diff layout');
splitButton.click();await delay(10);
assert.equal(splitButton.getAttribute('aria-checked'),'true','split after click');
assert.equal(JSON.parse(store.get('muster.diff.preferences')!).split,true,'the diff default is the same preference every diff pane reads');

// Providers is embedded in the same shell (no separate full-screen route), reached at its section.
go('providers');await delay(10);
assert.ok(document.querySelector('.settings-embed-providers'),'Providers renders inside the settings shell');
assert.equal(getState().screen,'settings','opening Providers never leaves the settings shell');

// Memory: the Hindsight endpoint and auto-retain setting are surfaced with their live value directly
// in the section, the same as every other row, not only behind the 'Open Memory' link-out.
go('memory');await delay(10);
assert.match(document.body.textContent!,/localhost:8888/,'the live Hindsight endpoint shows in the section itself');
const recallSwitch=Array.from(document.querySelectorAll('.preference-switch')).find(el=>el.getAttribute('aria-label')==='Use memory in agent runs') as HTMLButtonElement;
assert.equal(recallSwitch.getAttribute('aria-checked'),'true','auto-recall on by default from the live config');
recallSwitch.click();await delay(10);
assert.equal(recallSwitch.getAttribute('aria-checked'),'false','off after click');
assert.ok(calls.some(call=>call.command==='memory.config.set'&&call.input.autoRecall===false),'the row is wired to the real memory.config.set command, not local-only UI state');

// The nav is filtered by the same filterSections() the search box calls onChange (unit-tested with
// full search-term coverage in tests/settings.test.ts); here we only check the box itself is real and wired.
const search=document.querySelector('.settings-search input') as HTMLInputElement;
assert.equal(search.getAttribute('aria-label'),'Search settings');
assert.equal(search.getAttribute('type'),'search');

console.log('settings-shell: ok');
