// #788: right-click (and the keyboard) on any chat image asks main for one native image menu; Cmd+C in the viewer copies the image.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const DATA='data:image/png;base64,AAAA';
const menus:any[]=[],copies:any[]=[];
let menuResult:string|null=null,copyResult={copied:true};
window.muster={invoke(command:string,input:any){
  if(command==='image.contextMenu'){menus.push(input);return Promise.resolve(menuResult);}
  if(command==='image.copy'){copies.push(input);return Promise.resolve(input.dataUrl?{copied:true}:copyResult);}
  if(command==='files.chatImage'||command==='files.asset')return Promise.resolve({mime:'image/png',dataUrl:DATA,size:4,width:4,height:3});
  return Promise.resolve(undefined);
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ImageGallery}=await import('../src/renderer/components/ImageGallery');
const {ImageThumbs}=await import('../src/renderer/components/ToolCard');
const {ChatImage,clearImageCache}=await import('../src/renderer/components/ChatImage');
const root=createRoot(document.getElementById('root')!);
const until=async(ok:()=>unknown,what:string,ms=5000)=>{for(const end=Date.now()+ms;Date.now()<end;await delay(10))if(ok())return;assert.fail(`timed out waiting for ${what}`);};
const rightClick=(node:Element,x=40,y=30)=>{const event=new window.Event('contextmenu',{bubbles:true,cancelable:true});Object.defineProperty(event,'clientX',{value:x});Object.defineProperty(event,'clientY',{value:y});node.dispatchEvent(event);return event;};
const key=(node:EventTarget,name:string,extra:Record<string,unknown>={})=>{const event=new window.Event('keydown',{bubbles:true,cancelable:true});Object.defineProperty(event,'key',{value:name});for(const [k,v] of Object.entries(extra))Object.defineProperty(event,k,{value:v});node.dispatchEvent(event);return event;};
const q=(selector:string)=>document.querySelector(selector) as HTMLElement;

// Spec: MUS-SPEC-21-788A (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788a)
await check('Right-click on every chat image surface asks for the image menu with its path',async()=>{
  clearImageCache();menus.length=0;
  const paths=['/tmp/render/hero.png','/work/site/shot.png'];
  const resolve=(path:string)=>path.startsWith('/work/site/')?{folderId:'f1',path:path.slice('/work/site/'.length)}:undefined;
  root.render(<ImageGallery chatId="c1" paths={paths} resolve={resolve} onOpenFile={()=>{}}/>);
  await until(()=>q('.image-gallery-hero img')&&document.querySelectorAll('.image-gallery-thumb img').length===2,'the gallery');
  const hero=rightClick(q('.image-gallery-hero-hit'),40,30);
  await until(()=>menus.length===1,'the hero menu');
  assert.equal(hero.defaultPrevented,true,'the browser menu is suppressed');
  assert.deepEqual(menus[0],{image:{chatId:'c1',path:'/tmp/render/hero.png'},x:40,y:30,canvas:true},'gallery hero');
  rightClick(document.querySelectorAll('.image-gallery-thumb')[1]!,5,6);
  await until(()=>menus.length===2,'the strip menu');
  assert.deepEqual(menus[1].image,{chatId:'c1',path:'/work/site/shot.png',folderId:'f1',folderPath:'shot.png'},'gallery thumbnail (folder image)');
  rightClick(document.querySelectorAll('.image-gallery-link')[1]!);
  await until(()=>menus.length===3,'the link menu');
  assert.deepEqual(menus[2].image,{chatId:'c1',path:'/work/site/shot.png',folderId:'f1',folderPath:'shot.png'},'gallery file link');

  // A tool row's thumbnail.
  const item={id:'t1',chatId:'c2',kind:'tool',text:'',status:'completed',data:{},createdAt:new Date().toISOString()} as any;
  root.render(<ImageThumbs item={item} paths={['/tmp/render/tool.png']}/>);
  await until(()=>q('.chat-image img'),'the tool thumbnail');
  rightClick(q('.chat-image'));
  await until(()=>menus.length===4,'the tool-row menu');
  assert.deepEqual(menus[3].image,{chatId:'c2',path:'/tmp/render/tool.png'},'tool-row thumbnail');

  // An inline image in a reply, then the viewer it opens.
  root.render(<ChatImage chatId="c1" path="/tmp/render/inline.png" variant="inline"/>);
  await until(()=>q('.chat-image-inline img')?.getAttribute('alt')==='inline.png','the inline picture');
  rightClick(q('.chat-image-inline'));
  await until(()=>menus.length===5,'the inline menu');
  assert.deepEqual(menus[4].image,{chatId:'c1',path:'/tmp/render/inline.png'},'inline reply image');
  q('.chat-image-inline').click();
  await until(()=>q('.chat-image-lightbox .image-file'),'the viewer');
  const viewer=rightClick(q('.chat-image-lightbox-stage'));
  await until(()=>menus.length===6,'the viewer menu');
  assert.equal(viewer.defaultPrevented,true);
  assert.deepEqual(menus[5].image,{chatId:'c1',path:'/tmp/render/inline.png'},'image viewer');
  (q('.chat-image-lightbox button[aria-label="Close image"]')).click();
  await until(()=>!q('.chat-image-lightbox'),'the viewer to close');
});

// Spec: MUS-SPEC-21-788B (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788b)
await check('Cmd+C in the image viewer copies the image',async()=>{
  clearImageCache();copies.length=0;copyResult={copied:true};
  root.render(<ChatImage chatId="c1" path="/tmp/render/copy.png" variant="inline"/>);
  await until(()=>q('.chat-image-inline img')?.getAttribute('alt')==='copy.png','the inline picture');
  q('.chat-image-inline').click();
  await until(()=>q('.chat-image-lightbox .image-file'),'the viewer');
  const event=key(q('.chat-image-lightbox'),'c',{metaKey:true});
  await until(()=>copies.length===1,'the copy');
  assert.equal(event.defaultPrevented,true);
  assert.deepEqual(copies[0],{image:{chatId:'c1',path:'/tmp/render/copy.png'}});
  (q('.chat-image-lightbox button[aria-label="Close image"]')).click();
  await until(()=>!q('.chat-image-lightbox'),'the viewer to close');
});

// Spec: MUS-SPEC-21-788C (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788c)
await check('ContextMenu key and Shift+F10 open the image menu on a focused image',async()=>{
  clearImageCache();menus.length=0;
  root.render(<ChatImage chatId="c1" path="/tmp/render/keys.png" variant="inline"/>);
  await until(()=>q('.chat-image-inline img')?.getAttribute('alt')==='keys.png','the inline picture');
  const image=q('.chat-image-inline');image.focus();
  const first=key(image,'ContextMenu');
  await until(()=>menus.length===1,'the ContextMenu key menu');
  assert.equal(first.defaultPrevented,true);
  key(image,'F10',{shiftKey:true});
  await until(()=>menus.length===2,'the Shift+F10 menu');
  await delay(30);
  assert.equal(menus.length,2,'one menu per press');
  for(const menu of menus)assert.deepEqual(menu.image,{chatId:'c1',path:'/tmp/render/keys.png'});
  assert.equal(q('.chat-image-lightbox'),null,'the key does not also open the viewer');
  key(image,'F10');await delay(30);
  assert.equal(menus.length,2,'F10 alone is not a menu key');
});

// Spec: MUS-SPEC-21-788D (docs/spec/clauses/21-visuals-and-artifacts.md#mus-spec-21-788d)
await check('A missing file copies the image from its loaded pixels',async()=>{
  clearImageCache();menus.length=0;copies.length=0;menuResult='copy-pixels';
  root.render(<ChatImage chatId="c1" path="/tmp/render/gone.png" variant="inline"/>);
  await until(()=>q('.chat-image-inline img')?.getAttribute('alt')==='gone.png','the inline picture');
  rightClick(q('.chat-image-inline'));
  await until(()=>copies.length===1,'the pixel copy');
  assert.deepEqual(copies[0],{image:{chatId:'c1',path:'/tmp/render/gone.png'},dataUrl:DATA},'the loaded picture is sent when the file is gone');
  menuResult=null;
});
root.unmount();
console.log('image-context-menu-788-dom ok');
process.exit(0);
