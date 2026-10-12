// #371 part 2: the image gallery in a reply: hero + thumbnail strip, selection, keyboard, lightbox, de-duplication, Download all.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const calls:string[]=[],downloads:any[]=[];
const DATA='data:image/png;base64,AAAA';
window.muster={invoke(command:string,input:any){
  if(command==='files.downloadImages'){downloads.push(input);return Promise.resolve({saved:true,fileName:'muster-images.zip',count:input.images.length});}
  calls.push(`${command}:${input.chatId??input.folderId}:${input.path}`);
  return Promise.resolve({mime:'image/png',dataUrl:DATA,size:4,width:4,height:3});
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ImageGallery,GalleryCoverage}=await import('../src/renderer/components/ImageGallery');
const {ImageThumbs}=await import('../src/renderer/components/ToolCard');
const {clearImageCache}=await import('../src/renderer/components/ChatImage');
const root=createRoot(document.getElementById('root')!);
const press=(node:EventTarget,name:string)=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});node.dispatchEvent(event);};
const until=async(ok:()=>unknown,ms=2000)=>{for(let t=0;t<ms&&!ok();t+=10)await delay(10);};
const six=Array.from({length:6},(_,i)=>`/tmp/render/view-${i+1}.png`);

// One image: the hero only, no strip.
root.render(<ImageGallery chatId="c1" paths={[six[0]!]}/>);
await until(()=>document.querySelector('.image-gallery-hero img'));
assert.ok(document.querySelector('.image-gallery-hero img'),'hero picture');
assert.equal(document.querySelector('.image-gallery-strip'),null,'no strip for one image');
assert.equal(document.querySelectorAll('.image-gallery-thumb').length,0);
assert.ok(document.querySelector('.image-gallery-canvas'),'Canvas badge');
assert.equal([...document.querySelectorAll('.image-gallery-link')].some(link=>link.textContent?.includes('Download all')),false,'nothing to download-all with one image');

// Six images: strip, selection, keyboard, lightbox.
clearImageCache();calls.length=0;
root.render(<ImageGallery chatId="c1" paths={six}/>);
await until(()=>document.querySelectorAll('.image-gallery-thumb img').length===6&&document.querySelector('.image-gallery-hero img'));
const thumbs=()=>[...document.querySelectorAll('.image-gallery-thumb')] as HTMLElement[];
const gallery=()=>document.querySelector('.image-gallery')!;
assert.equal(thumbs().length,6);
assert.equal(document.querySelector('.image-gallery-strip')!.getAttribute('role'),'listbox');
assert.equal(thumbs()[0]!.getAttribute('aria-selected'),'true');
assert.match(thumbs()[2]!.getAttribute('aria-label')!,/Image 3 of 6: view-3\.png/);
assert.equal(document.querySelector('.image-gallery-hero img')!.getAttribute('alt'),'view-1.png');
assert.equal(document.querySelector('.image-gallery-hero img')!.getAttribute('decoding'),'async');
thumbs()[3]!.click();await until(()=>document.querySelector('.image-gallery-hero img')?.getAttribute('alt')==='view-4.png');
assert.equal(thumbs()[3]!.getAttribute('aria-selected'),'true');assert.equal(thumbs()[0]!.getAttribute('aria-selected'),'false');
assert.equal(document.querySelector('.image-gallery-hero img')!.getAttribute('alt'),'view-4.png','clicking a thumbnail swaps the hero');
press(gallery(),'ArrowDown');await delay(10);
assert.equal(thumbs()[4]!.getAttribute('aria-selected'),'true','ArrowDown moves the selection');
press(gallery(),'ArrowUp');await delay(10);press(gallery(),'ArrowUp');await delay(10);
assert.equal(thumbs()[2]!.getAttribute('aria-selected'),'true','ArrowUp moves back');
press(gallery(),'End');await delay(10);assert.equal(thumbs()[5]!.getAttribute('aria-selected'),'true');
press(gallery(),'Home');await delay(10);assert.equal(thumbs()[0]!.getAttribute('aria-selected'),'true');
assert.equal(calls.filter(call=>call.endsWith('view-1.png')).length<=2,true,'cached reads: thumbnail size and hero size at most');

// Lightbox: click the hero, step through the whole set, selection follows.
(document.querySelector('.image-gallery-hero-hit') as HTMLElement).click();await until(()=>document.querySelector('.chat-image-lightbox'));
let dialog=document.querySelector('.chat-image-lightbox[role="dialog"]')!;
assert.ok(dialog,'hero click opens the lightbox');
assert.match(dialog.textContent!,/1 \/ 6/);
(dialog.querySelector('button[aria-label="Next image"]') as HTMLElement).click();await delay(30);
dialog=document.querySelector('.chat-image-lightbox[role="dialog"]')!;
assert.match(dialog.textContent!,/2 \/ 6/);assert.equal(dialog.getAttribute('aria-label'),'view-2.png');
press(document,'ArrowRight');await until(()=>/3 \/ 6/.test(document.querySelector('.chat-image-lightbox')?.textContent??''));
assert.match(document.querySelector('.chat-image-lightbox')!.textContent!,/3 \/ 6/,'ArrowRight steps');
for(let i=0;i<3;i++){press(document,'ArrowLeft');await delay(10);}await until(()=>/6 \/ 6/.test(document.querySelector('.chat-image-lightbox')?.textContent??''));
assert.match(document.querySelector('.chat-image-lightbox')!.textContent!,/6 \/ 6/,'wraps around');
(document.querySelector('.chat-image-lightbox button[aria-label="Close image"]') as HTMLElement).click();await delay(10);
assert.equal(document.querySelector('.chat-image-lightbox'),null);
assert.equal(thumbs()[5]!.getAttribute('aria-selected'),'true','closing leaves the last viewed image selected');

// Download all: only paths that pass the chat-path gate (an absolute chat path or a folder file) are sent.
const mixed=['/tmp/render/a.png','relative-stray.png','/work/proj/b.png'];
root.render(<ImageGallery chatId="c1" paths={mixed} resolve={path=>path==='/work/proj/b.png'?{folderId:'f1',path:'b.png'}:undefined}/>);
await until(()=>document.querySelector('.image-gallery-link')?.textContent==='a.png');
const all=[...document.querySelectorAll('.image-gallery-link')].find(link=>link.textContent?.includes('Download all')) as HTMLElement;
assert.ok(all,'Download all link');
all.click();await until(()=>document.querySelector('.image-gallery-status'));
assert.equal(downloads.length,1);
assert.deepEqual(downloads[0],{chatId:'c1',images:[{path:'/tmp/render/a.png'},{folderId:'f1',path:'b.png'}]},'the relative stray with no source is never sent');
assert.match(document.querySelector('.image-gallery-status')!.textContent!,/muster-images\.zip/);
assert.equal(document.querySelectorAll('.image-gallery-links li button.image-gallery-link').length,4,'a link per image plus Download all');

// De-duplication: tool-row thumbnails collapse into a gallery that covers them.
const item={id:'t1',chatId:'c1',kind:'tool',text:'',status:'completed',data:{},createdAt:new Date().toISOString()} as any;
root.render(<div><GalleryCoverage.Provider value={new Set(six)}><ImageThumbs item={item} paths={six}/></GalleryCoverage.Provider><div id="plain"><ImageThumbs item={item} paths={six.slice(0,2)}/></div></div>);
await until(()=>document.querySelectorAll('#plain .chat-image img').length===2);
assert.equal(document.querySelectorAll('.tool-thumbs').length,1,'covered images render no thumbnail strip');
assert.equal(document.querySelectorAll('#plain .chat-image').length,2,'uncovered rows keep their thumbnails');
root.unmount();
console.log('image-gallery-dom ok');
process.exit(0);
