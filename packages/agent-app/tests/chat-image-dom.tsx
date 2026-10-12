// #371: thumbnails and reply images show the real picture, resolved through the chat when the path is outside every folder.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const calls:string[]=[];
const DATA='data:image/png;base64,AAAA';
window.muster={invoke(command:string,input:{chatId?:string;folderId?:string;path:string}){
  calls.push(`${command}:${input.chatId??input.folderId}:${input.path}`);
  if(input.path.endsWith('bad.png'))return Promise.reject(new Error('nope'));
  return Promise.resolve({mime:'image/png',dataUrl:DATA,size:4,width:4,height:3});
}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {ChatImage,resolveImageSource,clearImageCache,makeThumb}=await import('../src/renderer/components/ChatImage');

// Source resolution: folder paths read through the folder, other absolute paths through the chat, relative strays have none.
assert.deepEqual(resolveImageSource('c1','/work/a.png',{folderId:'f1',path:'a.png'}),{kind:'folder',folderId:'f1',path:'a.png'});
assert.deepEqual(resolveImageSource('c1','/tmp/shot.png'),{kind:'chat',chatId:'c1',path:'/tmp/shot.png'});
assert.deepEqual(resolveImageSource('c1','C:\\Users\\me\\shot.png'),{kind:'chat',chatId:'c1',path:'C:\\Users\\me\\shot.png'});
assert.equal(resolveImageSource('c1','shot.png'),null);
assert.equal(resolveImageSource(undefined,'/tmp/shot.png'),null);
// Small images are used as they are (no resize needed), and where createImageBitmap is missing the original is kept.
assert.equal(await makeThumb(DATA,184,{width:4,height:3}),DATA);
assert.equal(await makeThumb(DATA,184,{width:4000,height:3000}),DATA);

const root=createRoot(document.getElementById('root')!);
root.render(<div><ChatImage chatId="c1" path="/tmp/render/one.png"/><ChatImage chatId="c1" path="/tmp/render/one.png"/><ChatImage chatId="c1" path="relative.png"/><ChatImage chatId="c1" path="/tmp/render/bad.png"/></div>);
await delay(30);
const tiles=[...document.querySelectorAll('.chat-image')];
assert.equal(tiles.length,4);
const pictures=[...document.querySelectorAll('.chat-image img')];
assert.equal(pictures.length,2,'two real pictures, not placeholders');
assert.equal(pictures[0]!.getAttribute('src'),DATA);assert.equal(pictures[0]!.getAttribute('decoding'),'async');
assert.equal(calls.filter(call=>call==='files.chatImage:c1:/tmp/render/one.png').length,1,'the same image is read once (cached)');
assert.equal(tiles[2]!.className.includes('is-missing'),true,'a relative path outside every folder has no preview');
assert.equal(tiles[3]!.className.includes('is-failed'),true);

// An inline image is larger and opens a zoom dialog on click.
clearImageCache();
root.render(<ChatImage chatId="c1" path="/tmp/render/two.png" variant="inline"/>);
await delay(30);
const inline=document.querySelector('.chat-image-inline') as HTMLElement;
assert.ok(inline,'inline variant');assert.equal(inline.querySelector('img')!.getAttribute('alt'),'two.png');
inline.click();
await delay(30);
const dialog=document.querySelector('.chat-image-lightbox[role="dialog"]');
assert.ok(dialog,'click opens the zoomable viewer');
assert.ok(dialog!.querySelector('.image-file'),'the viewer has the zoom controls');
(dialog!.querySelector('button[aria-label="Close image"]') as HTMLElement).click();
await delay(10);
assert.equal(document.querySelector('.chat-image-lightbox'),null,'close removes it');

// Local image links in a reply.
const {localImagePath,isServerAttachment}=await import('../src/renderer/components/MessageBody');
assert.equal(localImagePath('/tmp/a/shot.png'),'/tmp/a/shot.png');
assert.equal(localImagePath('file:///tmp/a%20b/shot.JPG'),'/tmp/a b/shot.JPG');
assert.equal(localImagePath('https://example.com/x.png'),undefined);
assert.equal(localImagePath('/tmp/a/notes.txt'),undefined);
assert.equal(localImagePath('relative/x.png'),undefined);
// #395: a picture attached on the connected server is recognised by its attachment route (fetched with the connection's sign-in), nothing else is.
assert.equal(isServerAttachment('/api/attachments/0000aaaa-0000-4000-8000-000000000001/content'),true);
assert.equal(isServerAttachment('https://pc.example.com/api/attachments/0000aaaa-0000-4000-8000-000000000001/content'),true);
assert.equal(isServerAttachment('/api/issues/RAG-1'),false);
assert.equal(isServerAttachment('https://example.com/x.png'),false);
assert.equal(localImagePath('/api/attachments/0000aaaa-0000-4000-8000-000000000001/content'),undefined,'not mistaken for a local file');
root.unmount();
console.log('chat-image-dom ok');
process.exit(0);
