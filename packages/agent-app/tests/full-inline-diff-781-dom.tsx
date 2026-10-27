import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const after='// header\nconst first = 2;\n// untouched middle\nconst second = 4;\n// footer\n';
let reads=0;
window.muster={subscribe:()=>()=>{},invoke:async(command:string,input:any)=>{
  assert.equal(command,'files.chatEdit');assert.deepEqual(input,{chatId:'chat',itemId:'edit',path:'file.ts'});reads++;
  return {path:'file.ts',text:after,truncated:false};
}};
const React=await import('react'),{createRoot}=await import('react-dom/client'),{flushSync}=await import('react-dom');
const {FileChangeView}=await import('../src/renderer/components/FileDiffEditor');
const root=createRoot(document.getElementById('root')!);
// Spec: MUS-SPEC-08-781F (docs/spec/clauses/08-git-changes-and-review.md#mus-spec-08-781f)
// Protected: complete inline diff in the existing editor, not a patch-only replacement.
await check('opening a scratch edit renders unchanged source and every changed block in both themes',async()=>{
  for(const theme of ['light','dark']){
    document.documentElement.dataset.theme=theme;
    flushSync(()=>root.render(<FileChangeView key={theme} path="file.ts" kind="update" edit={{chatId:'chat',itemId:'edit'}} patches={[{diff:'@@\n-const first = 1;\n+const first = 2;\n@@\n-const second = 2;\n+const second = 4;',adds:2,dels:2}]}/>));
    for(let i=0;i<100&&!document.querySelector('.fde-code');i++)await delay(5);
    assert.deepEqual(Array.from(document.querySelectorAll('.fde-code')).map(el=>el.textContent),['// header','const first = 1;','const first = 2;','// untouched middle','const second = 2;','const second = 4;','// footer']);
    assert.equal(document.querySelectorAll('.is-del').length,2);
    assert.equal(document.querySelectorAll('.is-add').length,2);
    assert.equal(document.querySelectorAll('.fde-gap,.fde-note').length,0);
    assert.deepEqual(Array.from(document.querySelectorAll('.is-context .fde-num')).map(el=>el.textContent),['1','3','5']);
  }
  assert.equal(reads,2);
});
root.unmount();
