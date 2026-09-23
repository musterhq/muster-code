// W5-E.b2: the read-only viewer authorizes against the chat, then reads by handle; refusals are shown, never bypassed.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const calls:string[]=[];let refuse=false;
window.muster={invoke(command:string,input:Record<string,string>){
  calls.push(`${command}:${input.path??input.handle}`);
  if(command==='artifacts.authorize')return refuse?Promise.reject(new Error('Only files this chat’s agent wrote or used can be opened from here.')):Promise.resolve({handle:'h1',path:input.path,name:'out.md',size:9});
  if(command==='artifacts.read')return Promise.resolve({handle:'h1',path:'/tmp/out.md',name:'out.md',size:9,text:'one\ntwo\nthree',truncated:false,binary:false});
  return Promise.reject(new Error('unexpected '+command));
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ArtifactContents:ArtifactViewer}=await import('../src/renderer/components/ArtifactViewer');
const root=createRoot(document.getElementById('root')!);

root.render(<ArtifactViewer chatId="c1" path="/tmp/out.md" line={2}/>);await delay(40);
assert.deepEqual(calls,['artifacts.authorize:/tmp/out.md','artifacts.read:h1']);
const body=document.querySelector('.artifact-viewer-body');
assert.ok(body,'contents render');
assert.equal(body!.textContent,'one\ntwo\nthree\n');
assert.equal(document.querySelector('.artifact-viewer-line[data-current]')?.textContent,'two\n','the referenced line is marked');
assert.match(document.body.textContent!,/Read-only/);
assert.equal(document.querySelectorAll('textarea,input,[contenteditable="true"]').length,0,'nothing is editable');
refuse=true;calls.length=0;
root.render(<ArtifactViewer chatId="c1" path="/etc/hosts"/>);await delay(40);
assert.deepEqual(calls,['artifacts.authorize:/etc/hosts'],'no read without a grant');
assert.match(document.querySelector('[role="alert"]')!.textContent!,/agent wrote or used/);
root.unmount();
console.log('artifact-viewer: ok');
