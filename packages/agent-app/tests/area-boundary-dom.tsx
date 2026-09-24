// R3: one bad component is contained to its area; siblings keep rendering; Reload area remounts; details are redacted.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const copied:string[]=[];
window.muster={invoke(command:string,input:{text:string}){assert.equal(command,'clipboard.write');copied.push(input.text);return Promise.resolve();},subscribe(){return()=>{};}};
const logged:string[]=[];const realError=console.error;console.error=(...args:unknown[])=>{logged.push(args.map(String).join(' '));};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {AreaBoundary,redactFaultText}=await import('../src/renderer/components/AreaBoundary');

let broken=true;
function Boom():React.ReactElement{if(broken)throw new Error('render failed with token sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123 at /Users/alice/project/file.ts');return <p id="healed">healed</p>;}
const root=createRoot(document.getElementById('root')!);
root.render(<div>
  <p id="sibling">sidebar still here</p>
  <AreaBoundary area="the summary card" scope="card"><Boom/></AreaBoundary>
</div>);
await delay(20);
assert.equal(document.getElementById('sibling')?.textContent,'sidebar still here','a fault in one area never blanks the window');
const fault=document.querySelector('[data-area-fault]');
assert.ok(fault,'the faulted area shows the compact fault row');
assert.equal(fault!.getAttribute('role'),'alert');
assert.match(fault!.textContent!,/Something went wrong in the summary card/);
const buttons=Array.from(fault!.querySelectorAll('button')).map(button=>button.textContent);
assert.deepEqual(buttons,['Reload area','Copy details']);

// Logged and copied details are redacted.
const log=logged.find(line=>line.includes('render fault in the summary card'));
assert.ok(log,'the fault is logged');
assert.doesNotMatch(log!,/sk-ant-api03/);assert.doesNotMatch(log!,/\/Users\/alice/);
(Array.from(fault!.querySelectorAll('button')).find(button=>button.textContent==='Copy details') as HTMLButtonElement).click();await delay(10);
assert.equal(copied.length,1);assert.match(copied[0]!,/Area: the summary card/);assert.match(copied[0]!,/\[redacted\]/);assert.doesNotMatch(copied[0]!,/sk-ant-api03|alice/);
assert.match(document.querySelector('.area-fault-status')?.textContent??'',/Copied/);

// Reload area remounts the children once the cause is gone.
broken=false;
(Array.from(document.querySelectorAll('[data-area-fault] button')).find(button=>button.textContent==='Reload area') as HTMLButtonElement).click();await delay(20);
assert.ok(!document.querySelector('[data-area-fault]'),'fault row cleared');
assert.equal(document.getElementById('healed')?.textContent,'healed');

// resetKey change (a new chat or tab) clears a fault that belonged to the previous one.
broken=true;
root.render(<AreaBoundary area="this message" scope="item" resetKey="a"><Boom/></AreaBoundary>);await delay(20);
assert.match(document.querySelector('[data-area-fault]')?.textContent??'',/Something went wrong in this message/);
broken=false;
root.render(<AreaBoundary area="this message" scope="item" resetKey="b"><Boom/></AreaBoundary>);await delay(20);
assert.equal(document.getElementById('healed')?.textContent,'healed','a new reset key remounts the area');

// Redaction helper.
assert.equal(redactFaultText('Authorization: Bearer abcdefghijklmnop1234 in /home/bob/x and C:\\Users\\bob\\y'),'Authorization: Bearer [redacted] in ~/x and ~\\y');
assert.equal(redactFaultText('api_key=supersecretvalue ghp_abcdefghijklmnopqrstuvwxyz0123'),'api_key=[redacted] [redacted]');

root.unmount();console.error=realError;
console.log('✔ area-boundary-dom');
