// A gallery image that cannot be read collapses: compact line for a failed hero, no failed thumbnails, one line per image when all fail.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
window.muster={invoke(command:string,input:any){
  if(String(input.path).includes('bad'))return Promise.reject(new Error('unreadable'));
  return Promise.resolve({mime:'image/png',dataUrl:'data:image/png;base64,AAAA',size:4,width:4,height:3});
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ImageGallery}=await import('../src/renderer/components/ImageGallery');
const root=createRoot(document.getElementById('root')!);
const until=async(ok:()=>unknown,ms=2000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);assert.ok(ok(),'timed out waiting for DOM state');};
const q=(selector:string)=>document.querySelectorAll(selector);

// Hero fails (first image), the others work: one compact line, no empty hero box, the failed thumbnail is gone.
root.render(<ImageGallery key="g1" chatId="c1" paths={['/tmp/g1/bad-a.png','/tmp/g1/ok-b.png','/tmp/g1/ok-c.png']}/>);
await until(()=>q('.image-gallery-failure').length===1&&q('.image-gallery-thumb img').length===2);
assert.match(q('.image-gallery-failure')[0]!.textContent!,/bad-a\.png could not be read/);
assert.equal(q('.image-gallery-hero').length,0,'no empty hero box');
assert.equal(q('.image-gallery-canvas').length,0,'no Canvas for an unreadable hero');
assert.equal(q('.image-gallery-thumb').length,2,'failed thumbnail hidden');
(q('.image-gallery-thumb')[0] as HTMLElement).click();
await until(()=>q('.image-gallery-hero img').length===1);
assert.equal(q('.image-gallery-failure').length,0,'a working image behaves as before');
assert.ok(q('.image-gallery-canvas').length===1);

// One thumbnail fails while the hero works: hero unchanged, strip omits it.
root.render(<ImageGallery key="g2" chatId="c1" paths={['/tmp/g2/ok-a.png','/tmp/g2/bad-b.png','/tmp/g2/ok-c.png']}/>);
await until(()=>q('.image-gallery-hero img[alt="ok-a.png"]').length===1&&q('.image-gallery-thumb').length===2&&q('.image-gallery-thumb img').length===2);
assert.equal(q('.image-gallery-failure').length,0);
assert.ok(q('.image-gallery-canvas').length===1);
assert.deepEqual([...q('.image-gallery-thumb')].map(node=>node.getAttribute('title')),['ok-a.png','ok-c.png']);

// Every image fails: one line per image, no strip, no Canvas, no hero.
root.render(<ImageGallery key="g3" chatId="c1" paths={['/tmp/g3/bad-a.png','/tmp/g3/bad-b.png']}/>);
await until(()=>q('.image-gallery-failure').length===2&&q('.image-gallery-failure')[0]!.textContent!.includes('bad-a'));
await until(()=>!q('.image-gallery-strip').length);
assert.equal(q('.image-gallery-strip').length,0);assert.equal(q('.image-gallery-thumb').length,0);
assert.equal(q('.image-gallery-canvas').length,0);assert.equal(q('.image-gallery-hero').length,0);

// A single failed image: one line.
root.render(<ImageGallery key="g4" chatId="c1" paths={['/tmp/g4/bad-only.png']}/>);
await until(()=>q('.image-gallery-failure').length===1);
assert.equal(q('.image-gallery-canvas').length,0);
process.exit(0);
