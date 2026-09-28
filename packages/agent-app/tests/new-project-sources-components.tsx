// New project → Sources: tick several Muster folders, change the primary, add one with Choose folder… and one by
// cloning, then one project.create carries every folder and the primary. Never pass DOM nodes to assert.
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url);
const {parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,localStorage:{getItem(){return null},setItem(){}},requestAnimationFrame:(cb:any)=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout});
(window.HTMLElement.prototype as any).attachEvent=function(){};(window.HTMLElement.prototype as any).detachEvent=function(){};
const calls:{command:string;input:any}[]=[];
const listeners=new Set<(event:any)=>void>();
let failCreate=false;
const picked={id:'f4',name:'docs',path:'/Users/me/code/docs'};
const cloned={id:'f5',name:'repo',path:'/Users/me/Code/repo'};
window.muster={subscribe(listener:(event:any)=>void){listeners.add(listener);return()=>{listeners.delete(listener);}},async invoke(command:string,input:any){calls.push({command,input});
 if(command==='folder.pick')return picked;
 if(command==='git.clone.defaultDestination')return {path:'/Users/me/Code/repo'};
 if(command==='git.clone.start')return {id:'clone-1',name:'repo'};
 if(command==='project.create'){if(failCreate)throw new Error('Unknown folder: f9');return {id:'p1',name:input.name,goal:input.goal,folderIds:input.folderIds,primaryFolderId:input.primaryFolderId};}
 throw new Error(`unexpected ${command}`);
}} as any;
const React=await import('react');
const {createRoot}=await import('react-dom/client');
const {NewProjectForm,orderedSources}=await import('../src/renderer/components/NewProjectForm');
const {CloneRepositorySheet}=await import('../src/renderer/components/CloneRepositorySheet');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:error=>errors.push(error)});
const text=()=>document.body.textContent??'';
const click=(el:Element|null|undefined)=>{assert.ok(el,'element to click exists');(el as any).click();};
const button=(label:RegExp)=>[...document.querySelectorAll('button')].find(b=>label.test(b.textContent??'')||label.test(b.getAttribute('aria-label')??''));
// linkedom has no `oninput`, so React watches text fields the legacy way: focusin, then a key event after the change.
const type=(input:any,value:string)=>{input.dispatchEvent(new window.Event('focusin',{bubbles:true}));let proto=Object.getPrototypeOf(input),d;while(proto&&!(d=Object.getOwnPropertyDescriptor(proto,'value')))proto=Object.getPrototypeOf(proto);d!.set!.call(input,value);input.dispatchEvent(new window.Event('input',{bubbles:true}));input.dispatchEvent(new window.Event('keyup',{bubbles:true}));};
const row=(name:string)=>[...document.querySelectorAll('.new-project-sources li')].find(li=>li.querySelector('.project-edit-folder-name')?.textContent===name);
const tick=(name:string)=>click(row(name)?.querySelector('input[type="checkbox"]'));
const primaryName=()=>document.querySelector('.project-edit-primary')?.closest('li')?.querySelector('.project-edit-folder-name')?.textContent??null;
const until=async(ok:()=>boolean,what:string,ms=3000)=>{const end=Date.now()+ms;while(!ok()&&Date.now()<end)await delay(10);assert.ok(ok(),`timed out waiting for ${what}; calls=${calls.map(c=>c.command).join(',')}`);};
const submit=()=>document.querySelector('form.new-project')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));

assert.deepEqual(orderedSources(['a','b','c'],'c'),['c','a','b']);
assert.deepEqual(orderedSources(['a','b'],'gone'),['a','b'],'a primary that was unticked falls back to the first source');
assert.deepEqual(orderedSources([],null),[]);

const folders=[{id:'f1',name:'muster-code',path:'/Users/me/code/muster-code'},{id:'f2',name:'muster',path:'/Users/me/code/muster'},{id:'f3',name:'site',path:'/Users/me/code/site'},{id:'fx',name:'gone',path:'/Users/me/code/gone',missing:true}] as any;
let created:any=null,closed=0;
root.render(<><NewProjectForm folders={folders} onClose={()=>{closed++;}} onCreated={p=>{created=p;}}/><CloneRepositorySheet/></>);
await until(()=>!!document.querySelector('.new-project-sources'),'the Sources group');
assert.equal(document.querySelector('.new-project-sources')!.getAttribute('aria-label'),'Sources');
assert.deepEqual([...document.querySelectorAll('.new-project-source .project-edit-folder-name')].map(e=>e.textContent),['muster-code','muster','site'],'every present Muster folder is offered; missing ones are not');
assert.ok(button(/^Choose folder…$/),'Choose folder… is offered');
assert.ok(button(/^Clone repository…$/),'Clone repository… is offered');
assert.match(text(),/No sources yet/,'zero sources is allowed and explained');

type(document.querySelector('form.new-project input[type="text"]'),'Launch');
tick('muster');tick('muster-code');
await until(()=>document.querySelectorAll('.new-project-sources li.is-selected').length===2,'two ticked sources');
assert.equal(primaryName(),'muster','the first folder picked is primary');
assert.match(text(),/2 selected/);
click(button(/^Make muster-code primary$/));
await until(()=>primaryName()==='muster-code','muster-code to become primary');

click(button(/^Choose folder…$/));
await until(()=>!!row('docs')?.classList.contains('is-selected'),'the picked folder to be listed and ticked');

click(button(/^Clone repository…$/));
await until(()=>!!document.querySelector('[data-testid="clone-sheet"]'),'the clone sheet');
assert.match(text(),/added to the project once it lands/);
assert.equal(button(/Draft a chat meanwhile/),undefined);
type(document.querySelector('[data-testid="clone-sheet"] input[aria-label="Repository URL"]'),'https://github.com/me/repo.git');
document.querySelector('form.clone-form')!.dispatchEvent(new window.Event('submit',{bubbles:true,cancelable:true}));
await until(()=>calls.some(c=>c.command==='git.clone.start'),'the clone to start');
await delay(20);
for(const listener of listeners)listener({type:'gitClone',id:'clone-1',phase:'done',folder:cloned});
await until(()=>!!row('repo')?.classList.contains('is-selected'),'the cloned folder to be listed and ticked');
await until(()=>!document.querySelector('[data-testid="clone-sheet"]'),'the clone sheet to close');

failCreate=true;submit();
await until(()=>!!document.querySelector('.new-project [role="alert"]'),'the create error');
assert.match(document.querySelector('.new-project [role="alert"]')!.textContent??'',/Unknown folder/);
assert.equal(created,null);
failCreate=false;submit();
await until(()=>created!==null,'the project to be created');
const creates=calls.filter(c=>c.command==='project.create');
assert.deepEqual(creates.at(-1)?.input,{name:'Launch',goal:'',folderIds:['f1','f2','f4','f5'],primaryFolderId:'f1'},'one call carries every source with the primary first');
assert.equal(calls.filter(c=>c.command==='project.update').length,0,'no follow-up update is needed');

// Unticking the primary promotes the next source.
tick('muster-code');
await until(()=>primaryName()==='muster','the next source to become primary');
assert.equal(closed,0);
root.unmount();
assert.equal(errors.length,0,String(errors[0]??''));
console.log('new-project-sources-components: ok');
