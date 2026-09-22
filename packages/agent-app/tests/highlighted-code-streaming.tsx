import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';

const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
class HighlightWorker {
  onmessage?: (event:{data:{id:number;rows:{content:string;color?:string}[][]}})=>void;
  onerror?: ()=>void;
  postMessage({id,source}:{id:number;source:string}) {
    setTimeout(()=>this.onmessage?.({data:{id,rows:source.split('\n').map(line=>[{content:line,color:'#abcdef'}])}}),0);
  }
  terminate() {}
}
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,Worker:HighlightWorker});
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {HighlightedCode,HighlightedSourceTable}=await import('../src/renderer/components/HighlightedCode');
const root=createRoot(document.getElementById('root')!);

function render(source:string) {
  root.render(<div><HighlightedCode source={source} language="ts"/><HighlightedSourceTable source={source} language="ts"/></div>);
}

render('const x = 1;');
await delay(260);
assert.deepEqual(Array.from(document.querySelectorAll('code,.source-code-table')).map(node=>node.textContent),['const x = 1;','1const x = 1;']);

for (const source of ['const x = 12;','const x = 123;','x']) {
  render(source);
  await delay(20);
  const [fence,table]=Array.from(document.querySelectorAll('code,.source-code-table')).map(node=>node.textContent);
  assert.equal(fence,source,'a streaming fence always displays the current source before highlighting catches up');
  assert.equal(table,`1${source}`,'a source table never reuses tokens for a changed line');
}

render('first\nsecond');
await delay(20);
assert.equal(document.querySelector('code')?.textContent,'first\nsecond');
render('first');
await delay(20);
assert.equal(document.querySelector('code')?.textContent,'first','deleted lines disappear immediately');
root.unmount();
console.log('PASS: streaming code and source tables never display stale highlighted text');
