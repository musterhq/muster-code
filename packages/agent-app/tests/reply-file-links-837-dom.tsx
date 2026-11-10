/** #837: a path a reply names becomes a link when the file exists. Inside the chat's folder it is the file link; outside
 *  it is the outside-file link; a path to nothing stays plain text. The real reply renderer and store, a stubbed bridge. */
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {setTimeout as delay} from 'node:timers/promises';
import {check} from './dom-check.ts';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
const saved=new Map<string,string>();
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,ResizeObserver:class{observe(){}unobserve(){}disconnect(){}},requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,localStorage:{getItem:(key:string)=>saved.get(key)??null,setItem:(key:string,value:string)=>saved.set(key,value),removeItem:(key:string)=>saved.delete(key)}});
Object.assign(window,{setTimeout,clearTimeout});
window.HTMLElement.prototype.getBoundingClientRect=()=>({x:0,y:0,width:300,height:30,left:0,top:0,right:300,bottom:30});
setTimeout(()=>{console.error('reply-file-links-837-dom: timed out');process.exit(4);},60_000);

const HOME='/Users/me',FOLDER=`${HOME}/work`;
const inFolder=['notes.md','out/report.pdf'];
const onDisk=new Set([...inFolder.map(p=>`${FOLDER}/${p}`),`${HOME}/.muster-work/x/muster-memory.xlsx`,`${HOME}/Library/Application Support/Muster Agent/out/deck.pptx`]);
const inspected:string[]=[];
const snapshot=()=>({version:1,chats:[{id:'c1',title:'c1',folderId:'f1',status:'completed',updatedAt:new Date().toISOString(),pinned:false,archived:false,draft:'',model:'fixture',mode:'agent',providerId:'p'}],folders:[{id:'f1',name:'work',path:FOLDER}],projects:[],activeChatId:'c1'});
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){
  if(command==='app.snapshot')return snapshot();
  if(command==='chat.timeline')return {items:[],revision:1};
  if(command==='files.quickOpen'){const q=String(input.query);return {results:inFolder.filter(p=>p.includes(q)).map(path=>({path,name:path.split('/').pop()}))};}
  if(command==='files.external.inspect'){
    inspected.push(input.path);
    const path=input.path.startsWith('~/')?`${HOME}/${input.path.slice(2)}`:input.path,exists=onDisk.has(path);
    return {path,name:path.split('/').pop(),exists,...(exists?{kind:'file'}:{}),folderPath:path.split('/').slice(0,-1).join('/')};
  }
  if(command==='files.read'||command==='files.readFull')return {text:'%PDF',truncated:false};
  if(command==='providers.list'||command==='plugins.list'||command==='skills.list'||command==='files.list')return [];
  return undefined;
}};

const React=await import('react'),{createRoot}=await import('react-dom/client');
const store=await import('../src/renderer/store');
const {MessageBody}=await import('../src/renderer/components/MessageBody');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
await store.boot();
const reply=[
  `Inside: \`${FOLDER}/out/report.pdf\` and in prose ${FOLDER}/out/report.pdf here.`,
  '',
  'Outside: `~/.muster-work/x/muster-memory.xlsx`, `/Users/me/Library/Application Support/Muster Agent/out/deck.pptx`, and saved it to ~/.muster-work/x/muster-memory.xlsx for you.',
  '',
  'Missing: `/Users/me/nowhere/ghost.docx` and ~/gone/old.xls. See notes.md.',
].join('\n');
root.render(<MessageBody text={reply} linkFiles chatId="c1"/>);
await delay(300);
const paragraphs=()=>[...document.querySelectorAll('.md-body p')] as HTMLElement[];
const fileLinks=(p:HTMLElement)=>[...p.querySelectorAll('.md-file-link')].map(el=>el.textContent);
const externalLinks=(p:HTMLElement)=>[...p.querySelectorAll('.md-external-link')].map(el=>el.getAttribute('aria-label')?.split(' — ')[0]);

// Spec: MUS-SPEC-07-837B (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-837b)
await check("an absolute path inside the chat's folder becomes the file link and opens the file", async () => {
  const p=paragraphs()[0]!;
  assert.deepEqual(fileLinks(p),['report.pdf',`${FOLDER}/out/report.pdf`]);
  assert.deepEqual(externalLinks(p),[]);
  (p.querySelector('.md-file-link') as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));
  await delay(50);
  assert.ok(store.getState().tabs.some((tab:any)=>tab.kind==='file'&&tab.folderId==='f1'&&tab.path==='out/report.pdf'),JSON.stringify(store.getState().tabs));
});

// Spec: MUS-SPEC-07-837C (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-837c)
await check("an existing file outside the chat's folders becomes the outside-file link", () => {
  const p=paragraphs()[1]!;
  assert.deepEqual(fileLinks(p),[]);
  assert.deepEqual(externalLinks(p),[`${HOME}/.muster-work/x/muster-memory.xlsx`,`${HOME}/Library/Application Support/Muster Agent/out/deck.pptx`,`${HOME}/.muster-work/x/muster-memory.xlsx`]);
  assert.ok(p.textContent!.includes('~/.muster-work/x/muster-memory.xlsx'),'the prose label keeps the ~');
  const counts=inspected.reduce((m,path)=>m.set(path,(m.get(path)??0)+1),new Map<string,number>());
  assert.ok([...counts.values()].every(n=>n===1),`each path checked once: ${JSON.stringify([...counts])}`);
});

// Spec: MUS-SPEC-07-837D (docs/spec/clauses/07-files-editor-and-search.md#mus-spec-07-837d)
await check('a path that does not exist stays plain text, and a relative name still links in the folder', () => {
  const p=paragraphs()[2]!;
  assert.deepEqual(externalLinks(p),[]);
  assert.deepEqual(fileLinks(p),['notes.md']);
  assert.match(p.textContent!,/ghost\.docx/);
  assert.match(p.textContent!,/~\/gone\/old\.xls/);
  assert.equal(p.querySelectorAll('a,button').length,1,'only notes.md is a link');
});

assert.deepEqual(errors,[]);
root.unmount();
process.exit(0);
