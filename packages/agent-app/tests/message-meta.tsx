import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node});
const calls:string[]=[];let resolve!:()=>void,reject!:(reason:Error)=>void;
window.muster={invoke(command:string,input:{text:string}){assert.equal(command,'clipboard.write');calls.push(input.text);return new Promise<void>((yes,no)=>{resolve=yes;reject=no;});}};
const React=await import('react'),{createRoot}=await import('react-dom/client');
const {MessageMeta}=await import('../src/renderer/components/MessageMeta');
const root=createRoot(document.getElementById('root')!);
root.render(<MessageMeta text={'## Exact markdown\n\n| A | B |'} createdAt="2026-09-19T18:19:00.000Z"/>);await delay(15);
const button=document.querySelector('button')!;button.click();button.click();await delay(5);
assert.equal(calls.length,1);assert.equal(calls[0],'## Exact markdown\n\n| A | B |');
assert.equal(document.querySelector('time')!.getAttribute('dateTime')??document.querySelector('time')!.getAttribute('datetime'),'2026-09-19T18:19:00.000Z');
assert.match(document.querySelector('time')!.getAttribute('title')!,/2026/);
resolve();await delay(10);assert.match(document.querySelector('[role="status"]')!.textContent!,/Copied/);
button.click();await delay(5);reject(new Error('clipboard unavailable'));await delay(10);
assert.match(document.querySelector('[role="status"]')!.textContent!,/Could not copy/);
root.render(<MessageMeta text="later" createdAt="invalid"/>);await delay(10);assert.ok(!document.querySelector('time'));
assert.ok(!document.querySelector('[aria-label="Fork from here"]'),'no actions unless the timeline offers them');

// Result actions: Edit is immediate; Fork and Retry show progress and ignore a second click while running.
const {MessageEditor,ForkOrigin}=await import('../src/renderer/components/MessageMeta');
const done:string[]=[];let finishFork!:()=>void;
root.render(<MessageMeta text="answer" createdAt="2026-09-19T18:19:00.000Z" actions={{onEdit:()=>done.push('edit'),onRetry:async()=>{done.push('retry');},onFork:()=>new Promise<void>(yes=>{done.push('fork');finishFork=yes;})}}/>);await delay(10);
const action=(label:string)=>document.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`)!;
action('Edit message').click();action('Retry').click();action('Fork from here').click();await delay(5);
assert.equal(action('Fork from here').getAttribute('aria-busy'),'true');action('Fork from here').click();await delay(5);
assert.equal(done.join(','),'edit,retry,fork','each action runs once');
finishFork();await delay(10);assert.ok(!action('Fork from here').hasAttribute('aria-busy'));

// Edit: Replace is offered only when the runtime allows it; blocked reasons and a dirty checkout are spelled out.
const submits:string[]=[];let cancelled=0;
root.render(<MessageEditor text="implement it" loadOptions={async()=>({canReplace:false,replaceBlockedReason:'Files were edited after this message and would not be rewound.',dirtyFiles:2})} onSubmit={async(text,mode)=>{submits.push(`${mode}:${text}`);return true;}} onCancel={()=>cancelled++}/>);await delay(15);
const editor=document.querySelector('.message-editor')!;
const hint=editor.querySelector('.message-editor-hint')!;assert.match(hint.textContent!,/Sends as a new branch/);assert.match(hint.getAttribute('title')!,/fork from before this message/);assert.match(hint.getAttribute('title')!,/would not be rewound/);assert.match(editor.querySelector('.message-editor-warn')!.textContent!,/2 uncommitted changes/);assert.ok(editor.querySelector('.message-editor-send'),'round send control like the composer');
assert.ok(!Array.from(editor.querySelectorAll('button')).some(b=>b.textContent==='Replace in this chat'),'no Replace when files were edited later');
editor.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));await delay(10);
assert.equal(submits.join(','),'fork:implement it','Resend forks by default');
Array.from(editor.querySelectorAll('button')).find(b=>b.textContent==='Cancel')!.click();await delay(5);assert.equal(cancelled,1);
root.render(<MessageEditor key="replaceable" text="draft" loadOptions={async()=>({canReplace:true,dirtyFiles:0})} onSubmit={async(text,mode)=>{submits.push(`${mode}:${text}`);return true;}} onCancel={()=>{}}/>);await delay(15);
const replace=Array.from(document.querySelectorAll<HTMLButtonElement>('.message-editor button')).find(b=>b.textContent==='Replace in this chat')!;
assert.ok(replace);assert.doesNotMatch(document.querySelector('.message-editor')!.textContent!,/uncommitted/);
replace.click();await delay(10);assert.equal(submits.at(-1),'replace:draft');

// CHAT-18: when later work touched files, Restore files… previews the owned files and needs an explicit confirm.
const restoreSubmits:string[]=[];let previews=0,accept=true;
const preview={available:true,runId:'run-2',files:[{path:'src/a.ts',action:'restore' as const,afterHash:'h1',adds:3,dels:1},{path:'new.ts',action:'delete' as const,afterHash:'h2',adds:0,dels:4}],left:['keep.ts'],external:2};
const blockedOptions=async()=>({canReplace:false,replaceBlockedReason:'Files were edited after this message and would not be rewound.',dirtyFiles:0});
root.render(<MessageEditor key="restorable" text="edit less" loadOptions={blockedOptions} loadRestore={async()=>{previews++;return preview;}} onSubmit={async(text,mode,files)=>{restoreSubmits.push(`${mode}:${text}:${files?.map(f=>`${f.path}@${f.afterHash}`).join('|')??''}`);return accept;}} onCancel={()=>{}}/>);await delay(15);
const buttons=()=>Array.from(document.querySelectorAll<HTMLButtonElement>('.message-editor button'));
assert.equal(previews,0,'the preview is loaded only on request');
buttons().find(b=>b.textContent==='Restore files…')!.click();await delay(15);
assert.equal(previews,1);
const panel=document.querySelector('.message-restore')!;
assert.match(panel.textContent!,/these 2 files/);assert.match(panel.textContent!,/Restoresrc\/a\.ts\+3 −1/);assert.match(panel.textContent!,/Deletenew\.ts/);
assert.match(panel.textContent!,/1 other changed file was not made by this chat/);assert.match(panel.textContent!,/2 commands or tool calls ran after this message\. Their effects .* are not undone/);
assert.ok(!document.querySelector('.message-editor-send'),'confirming is the only send while the preview is open');
accept=false;buttons().find(b=>b.textContent==='Restore 2 files and replace')!.click();await delay(15);
assert.equal(restoreSubmits.at(-1),'restore:edit less:src/a.ts@h1|new.ts@h2','the exact previewed list is sent');
assert.ok(!document.querySelector('.message-restore'),'a refused restore drops the stale preview');
assert.equal(document.querySelector<HTMLTextAreaElement>('.message-editor textarea')!.value,'edit less','the edited text is kept');
buttons().find(b=>b.textContent==='Restore files…')!.click();await delay(15);
buttons().find(b=>b.textContent==='Back')!.click();await delay(5);assert.ok(!document.querySelector('.message-restore'),'Back closes the preview without sending');
root.render(<MessageEditor key="restore-blocked" text="x" loadOptions={blockedOptions} loadRestore={async()=>({available:false,reason:'“Other” is working in this folder.',files:[],left:[],external:0})} onSubmit={async()=>true} onCancel={()=>{}}/>);await delay(15);
buttons().find(b=>b.textContent==='Restore files…')!.click();await delay(15);
assert.match(document.querySelector('.message-restore')!.textContent!,/working in this folder\. Resend it as a fork instead/);
assert.ok(!buttons().some(b=>/^Restore \d/.test(b.textContent??'')),'no confirm when the restore is blocked');

let opened=0;
root.render(<ForkOrigin title="Parser rewrite" onOpen={()=>opened++}/>);await delay(5);
assert.match(document.querySelector('.fork-origin')!.textContent!,/Forked from Parser rewrite/);(document.querySelector('.fork-origin button') as HTMLButtonElement).click();assert.equal(opened,1);
root.render(<ForkOrigin/>);await delay(5);assert.match(document.querySelector('.fork-origin')!.textContent!,/no longer exists/);assert.ok(!document.querySelector('.fork-origin button'));
root.unmount();console.log('Message copy preserves text and timestamps; Edit, Retry and Fork run once each; the editor forks by default, offers Replace only when allowed, previews and confirms Restore files, warns about uncommitted files; forks link back to their origin.');
