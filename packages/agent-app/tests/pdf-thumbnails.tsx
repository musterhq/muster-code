// USER-34: PDF attachment thumbnails (lazy, cached, serialized) and the viewer's page thumbnail rail.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const invoked:string[]=[];
window.muster={invoke(command:string,input:{id:string}){invoked.push(`${command}:${input.id}`);if(command!=='attachments.document')return Promise.reject(new Error('unexpected '+command));return Promise.resolve({base64:Buffer.from('%PDF-1.4 '+input.id).toString('base64'),revision:'r',sourceFormat:'pdf',converted:false,size:12});}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const thumbs=await import('../src/renderer/pdfThumbnail');

// 1. Cache, serialization and bounds with a fake renderer (pdf.js is not loaded in tests).
let active=0,peak=0;const rendered:string[]=[];
thumbs.setPdfThumbnailRenderer(async(bytes,width)=>{active++;peak=Math.max(peak,active);await delay(3);active--;const text=Buffer.from(bytes).toString();rendered.push(text);return `data:image/png;base64,${width}-${text}`;});
assert.equal(thumbs.isPdf('Report.PDF'),true);assert.equal(thumbs.isPdf('x.txt','application/pdf'),true);assert.equal(thumbs.isPdf('x.png','image/png'),false);
const [a,b,again]=await Promise.all([thumbs.attachmentPdfThumbnail('c1','a1'),thumbs.attachmentPdfThumbnail('c1','a2'),thumbs.attachmentPdfThumbnail('c1','a1')]);
assert.equal(a,again,'same attachment is rendered once');assert.notEqual(a,b);
assert.equal(invoked.filter(call=>call==='attachments.document:a1').length,1,'bytes fetched once per attachment');
assert.equal(peak,1,'renders are serialized');assert.match(a,/^data:image\/png;base64,96-/,'renders at the thumbnail width');
for(let i=0;i<60;i++)await thumbs.blobPdfThumbnail(`k${i}`,new Blob(['%PDF '+i]));
assert.ok(thumbs.pdfThumbnailCacheSize()<=48,'cache is bounded');
await assert.rejects(thumbs.blobPdfThumbnail('big',{size:thumbs.MAX_THUMB_SOURCE_BYTES+1} as Blob),/No thumbnail/);
thumbs.setPdfThumbnailRenderer(async()=>{throw new Error('broken');});
await assert.rejects(thumbs.blobPdfThumbnail('bad',new Blob(['x'])),/broken/);
thumbs.setPdfThumbnailRenderer(async bytes=>`data:image/png;base64,ok-${bytes.byteLength}`);
assert.match(await thumbs.blobPdfThumbnail('bad',new Blob(['x'])),/ok-1/,'a failed render is not cached');

// 2. Composer tiles: a PDF shows its first page; other files keep their icon.
const {AttachmentStrip}=await import('../src/renderer/components/AttachmentStrip');
const root=createRoot(document.getElementById('root')!);
const tile=(over:Record<string,unknown>)=>({localId:'l1',key:'k-pdf',name:'spec.pdf',mime:'application/pdf',size:12,kind:'file' as const,state:'ready' as const,file:new Blob(['%PDF spec']),...over});
root.render(<AttachmentStrip chatId="c1" items={[tile({}),tile({localId:'l2',key:'k-txt',name:'notes.txt',mime:'text/plain',file:new Blob(['hi'])})]} onRemove={()=>{}} onRetry={()=>{}}/>);await delay(5);
await delay(20);
const images=[...document.querySelectorAll('.attachment-pdf-thumb')];
assert.equal(images.length,1,'only the PDF tile gets a page thumbnail');
assert.match(images[0]!.getAttribute('src')!,/^data:image\/png;base64,ok-/);
assert.equal(document.querySelectorAll('[data-testid="attachment-tile"]').length,2);
// A staged PDF without a local blob asks the runtime for its bytes.
invoked.length=0;
root.render(<AttachmentStrip chatId="c1" items={[tile({localId:'l3',key:'k3',file:undefined,ref:{id:'att9',chatId:'c1',name:'spec.pdf',mime:'application/pdf',size:12,kind:'file',state:'staged'}})]} onRemove={()=>{}} onRetry={()=>{}}/>);await delay(5);
await delay(20);
assert.deepEqual(invoked,['attachments.document:att9']);
assert.equal(document.querySelectorAll('.attachment-pdf-thumb').length,1);
// A failed tile never renders.
root.render(<AttachmentStrip chatId="c1" items={[tile({localId:'l4',key:'k4',state:'failed',file:new Blob(['never'])})]} onRemove={()=>{}} onRetry={()=>{}}/>);await delay(5);
await delay(20);
assert.equal(document.querySelectorAll('.attachment-pdf-thumb').length,0);

// 3. The viewer's thumbnail rail: one thumb per page, current page marked, click and arrow keys jump.
const {PdfThumbnailRail}=await import('../src/renderer/components/PdfThumbnailRail');
const painted:number[]=[];
const fakePdf={getPage:async(n:number)=>({getViewport:({scale}:{scale:number})=>({width:612*scale,height:792*scale}),render:()=>{painted.push(n);return {promise:Promise.resolve(),cancel(){}};}})} as never;
const jumps:number[]=[];
const rail=(current:number)=><PdfThumbnailRail pdf={fakePdf} aspects={Array.from({length:12},()=>792/612)} current={current} onJump={page=>jumps.push(page)} visible/>;
root.render(rail(3));await delay(5);
await delay(20);
const buttons=[...document.querySelectorAll<HTMLButtonElement>('.pdf-rail-thumb')];
assert.equal(buttons.length,12);
assert.equal(document.querySelector('.pdf-rail-thumb[aria-current="page"]')?.getAttribute('aria-label'),'Page 3');
assert.deepEqual([...new Set(painted)].sort((x,y)=>x-y),[1,2,3,4,5,6,7,8],'without IntersectionObserver only the first eight paint');
buttons[9]!.click();assert.deepEqual(jumps,[10]);
const key=(name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});document.querySelector('.pdf-rail')!.dispatchEvent(event);};
key('ArrowDown');key('End');
assert.deepEqual(jumps,[10,4,12]);
root.render(rail(7));await delay(5);
assert.equal(document.querySelector('.pdf-rail-thumb[aria-current="page"]')?.getAttribute('aria-label'),'Page 7');
root.unmount();await delay(5);
console.log('pdf-thumbnails: ok');
