import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
(globalThis as any).require=require;
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
window.document.oninput=null;
const style={getPropertyValue:()=>'',display:'block',visibility:'visible'};
window.getComputedStyle=()=>style;
Object.assign(globalThis,{window,document:window.document,Node:window.Node,HTMLElement:window.HTMLElement,Element:window.Element,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}disconnect(){}},localStorage:{getItem(){return null;},setItem(){}},requestAnimationFrame:(callback:any)=>setTimeout(callback,0),cancelAnimationFrame:clearTimeout,getComputedStyle:()=>style});
// SBX-08/15/16 sandbox settings panel. Never pass DOM nodes to assert.equal (heap cap).
const calls:{command:string;input:any}[]=[],listeners=new Set<(event:any)=>void>();
const emit=(event:any)=>{for(const listener of listeners)listener(event);};
let status:any={id:'computer_1',scope:{kind:'project',id:'p1'},label:'App',provider:'local-docker',state:'running',workspacePreserved:true,durability:'durable',image:'node',user:'1000:1000',bootGeneration:2,limits:{network:'none',memoryMiB:512,cpus:1,processes:256,maxRunning:2,maxTimeoutMs:7_200_000}};
const service={id:'svc_000000000001',name:'dev server',command:'npm run dev',cwd:'/workspace/app',env:{},restart:'on-failure',state:'running',bootGeneration:2,restarts:1,lastExitCode:null,reason:'Restarted after the sandbox restarted.',output:'listening on 3000\n'};
let services:any={computerId:'computer_1',bootGeneration:2,services:[service,{...service,id:'svc_000000000002',name:'old job',restart:'never',state:'lost',bootGeneration:1,restarts:0,reason:'Stopped when the sandbox restarted. Its restart policy is never.'}]};
(window as any).muster={subscribe(listener:any){listeners.add(listener);return()=>listeners.delete(listener);},async invoke(command:string,input:any){
  calls.push({command,input});
  if(command==='computer.inspect')return status;
  if(command==='computer.history')return [];
  if(command==='computer.files.list')return {path:'',entries:[],truncated:false};
  if(command==='computer.usage')return {computerId:'computer_1',running:true,memoryBytes:480*1024**2,memoryLimitBytes:512*1024**2,cpuPercent:50,pids:12,sampledAt:'t'};
  if(command==='computer.services.list')return services;
  if(command==='computer.services.stop'){services={...services,services:services.services.map((s:any)=>s.id===input.serviceId?{...s,state:'stopped',reason:'Stopped.'}:s)};return services.services[0];}
  if(command==='computer.services.register')return {...input.service,id:'svc_000000000003',state:'running',bootGeneration:2,restarts:0,lastExitCode:null,output:''};
  if(command==='computer.setLimits'){status={...status,limits:{...status.limits,...input.limits}};return status;}
  if(command==='computer.layers.sources')return {sources:[{id:'skills',label:'Skills',available:true},{id:'tools',label:'Sandbox tools',available:false,reason:'Nothing to mount yet.'}],active:status.layers??[]};
  if(command==='computer.layers.set'){status={...status,layers:input.layers.map((id:string)=>({id,label:'Skills',version:'abcdef123456',target:`/opt/muster/${id}`}))};return status;}
  if(command==='computer.export')return {savedTo:'/Users/me/Downloads/App-sandbox.tar.gz',manifestPath:'/Users/me/Downloads/App-sandbox.tar.gz.manifest.json',manifest:{format:'muster-sandbox-export/1',files:3,directories:1,symlinks:1,bytes:2048,archiveBytes:900}};
  return undefined;
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ScopedComputerTab}=await import('../src/renderer/components/ScopedComputerTab');
const {parseEnvLines,usagePercent}=await import('../src/renderer/components/SandboxControls');
const errors:unknown[]=[],root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const button=(label:string)=>{const node=Array.from(document.querySelectorAll('button')).find(item=>(item.textContent??'').trim()===label||item.getAttribute('aria-label')===label) as HTMLButtonElement|undefined;assert.ok(node,`missing button ${label}`);return node!;};
const setValue=async(element:HTMLInputElement|HTMLSelectElement|HTMLTextAreaElement,value:string,event='input')=>{let proto=Object.getPrototypeOf(element),descriptor;while(proto&&!(descriptor=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);if(descriptor?.set)descriptor.set.call(element,value);else if(element.tagName!=='SELECT')(element as HTMLInputElement).value=value;else for(const option of Array.from(element.querySelectorAll('option')) as HTMLOptionElement[]){if(option.getAttribute('value')===value)option.setAttribute('selected','');else option.removeAttribute('selected');}element.dispatchEvent(new window.Event(event,{bubbles:true}));await delay(30);};
const field=(label:string)=>{const node=document.querySelector(`[aria-label="${label}"]`) as any;assert.ok(node,`missing field ${label}`);return node;};

root.render(<ScopedComputerTab scope={{kind:'project',id:'p1'}}/>);await delay(80);
assert.equal(errors.length,0);
assert.ok(!text().includes('Read-only layers'),'settings start collapsed');
button('Settings').click();await delay(120);
// SBX-08: live usage meters and limit controls.
assert.match(text(),/480 MB of 512 MB/);assert.match(text(),/50\.0% of 1 CPU/);assert.match(text(),/12 of 256/);
assert.equal(field('Memory usage').getAttribute('aria-valuenow'),'94');
assert.ok(document.querySelector('.sbx-meter-fill.is-high'),'high memory use is highlighted');
await setValue(field('Memory limit'),'2048','change');await setValue(field('CPU limit'),'2','change');
assert.match(text(),/Applying recreates the container/);
button('Apply').click();await delay(60);
assert.deepEqual(calls.find(call=>call.command==='computer.setLimits')!.input,{scope:{kind:'project',id:'p1'},limits:{memoryMiB:2048,cpus:2,processes:256}});
assert.match(text(),/2048 MiB · 2 CPU · 256 processes/);
// SBX-15: services with boot generation, restart policy and an earlier-boot marker.
assert.match(text(),/Services boot 2/);assert.match(text(),/dev server/);assert.match(text(),/Restart on failure · boot 2 · 1 restart/);assert.match(text(),/Never restart · boot 1 \(earlier\)/);assert.match(text(),/Lost/);
button('Stop dev server').click();await delay(60);assert.ok(calls.some(call=>call.command==='computer.services.stop'&&call.input.serviceId==='svc_000000000001'));
button('dev server').click();await delay(30);assert.match(text(),/listening on 3000/);
emit({type:'computerServices',computerId:'computer_1',bootGeneration:3,services:[]});await delay(30);assert.match(text(),/Services boot 3/);assert.match(text(),/No services/);
button('Register').click();await delay(30);
await setValue(field('Service name'),'db');await setValue(field('Service command'),'postgres');await setValue(field('Service environment'),'PGPORT=5433\n# comment');
await setValue(field('Restart policy'),'always','change');
Array.from(document.querySelectorAll('.sbx-service-form button')).find(node=>node.textContent==='Register')!.dispatchEvent(new window.Event('click',{bubbles:true}));
(document.querySelector('.sbx-service-form') as HTMLFormElement).dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(60);
const registered=calls.find(call=>call.command==='computer.services.register')!;
assert.deepEqual(registered.input,{scope:{kind:'project',id:'p1'},service:{name:'db',command:'postgres',cwd:'/workspace',env:{PGPORT:'5433'},restart:'always'},start:true});
// SBX-16: layers and export.
assert.match(text(),/Nothing to mount yet/);
const skills=Array.from(document.querySelectorAll('.sbx-layers input')).at(0) as HTMLInputElement;skills.checked=true;skills.dispatchEvent(new window.Event('click',{bubbles:true}));await delay(30);
(Array.from(document.querySelectorAll('[aria-label="Read-only layers"] button')).find(node=>node.textContent==='Apply') as HTMLButtonElement).click();await delay(80);
assert.deepEqual(calls.find(call=>call.command==='computer.layers.set')!.input,{scope:{kind:'project',id:'p1'},layers:['skills']});
assert.match(text(),/\/opt\/muster\/skills · vabcdef123456/);
button('Export workspace archive…').click();await delay(60);
assert.match(text(),/Saved App-sandbox\.tar\.gz · 3 files, 1 folders, 1 links \(kept as links\)/);
assert.deepEqual(parseEnvLines('A=1\n\n# x\nB==2'),{A:'1',B:'=2'});assert.throws(()=>parseEnvLines('oops'),/NAME=value/);
assert.equal(usagePercent(null,10),null);assert.equal(usagePercent(20,10),100);
// SBX-11: the environment menu says where the browser runs.
const {browserPlacementLabel}=await import('../src/renderer/components/EnvironmentFooter');
assert.equal(browserPlacementLabel({browser:'host'}),'Browser runs on this Mac');
assert.equal(browserPlacementLabel({browser:'sandbox',browserService:{state:'running',endpoint:'http://127.0.0.1:9222'}}),'Browser runs in the sandbox · running');
assert.equal(browserPlacementLabel({browser:'sandbox',browserService:{state:'failed',endpoint:'x'}}),'Browser runs in the sandbox · not running');
assert.equal(errors.length,0);
root.unmount();
console.log('sandbox-controls-components ok');
process.exit(0);
