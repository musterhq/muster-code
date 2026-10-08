/** #309 owner popover above the New task dialog, #310 compact chat reply rhythm + leading-label emphasis, #311 the Stopped banner stays in the chat column.
 *  linkedom has no layout or cascade, so computed style is resolved here from the real stylesheets: rules that match the element, highest specificity then source order. */
import {createRequire} from 'node:module';
import assert from 'node:assert/strict';
import {readFileSync,readdirSync} from 'node:fs';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
const require=createRequire(import.meta.url),{parseHTML}=require('linkedom');
const {window}=parseHTML('<html><body><div id="root"></div></body></html>');
Object.assign(globalThis,{window,document:window.document,HTMLElement:window.HTMLElement,Element:window.Element,Node:window.Node,MutationObserver:window.MutationObserver,requestAnimationFrame:(fn:any)=>setTimeout(fn,0),cancelAnimationFrame:clearTimeout,
  localStorage:{getItem:()=>null,setItem:()=>{}},ResizeObserver:class{observe(){}unobserve(){}disconnect(){}}});
Object.assign(window,{setTimeout,clearTimeout});
(window.HTMLElement.prototype as any).getBoundingClientRect=function(){return {x:0,y:0,top:0,left:0,right:300,bottom:30,width:300,height:30};};
const calls:string[]=[];
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string){calls.push(command);return undefined;}};
setTimeout(()=>{console.error('chat-polish-dom: timed out');process.exit(4);},60_000);

// ---- a small cascade over the app's stylesheets ----
const renderer=join(process.cwd(),'src','renderer');
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.name.endsWith('.css')?[join(dir,e.name)]:[]);
type Rule={selector:string;decls:Map<string,string>;order:number};
const rules:Rule[]=[];let order=0;const tokens=new Map<string,string>();
for(const file of walk(renderer).sort()){
  const css=readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  for(const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const selector=m[1]!.trim(),decls=new Map<string,string>();
    for(const d of m[2]!.split(';')){const i=d.indexOf(':');if(i>0)decls.set(d.slice(0,i).trim(),d.slice(i+1).trim());}
    if(selector==='\:root'||selector===':root'){for(const [k,v] of decls)if(k.startsWith('--')&&!tokens.has(k))tokens.set(k,v);continue;}
    if(selector.startsWith('@')||selector.startsWith(':root['))continue;
    rules.push({selector,decls,order:order++});
  }
}
const parts=(selector:string)=>{const out:string[]=[];let depth=0,cur='';for(const c of selector){if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===','&&!depth){out.push(cur.trim());cur='';}else cur+=c;}out.push(cur.trim());return out;};
const specificity=(s:string)=>{const strip=s.replace(/:where\([^)]*\)/g,'');return (strip.match(/#[\w-]+/g)?.length??0)*10000+((strip.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length??0))*100+(strip.replace(/\[[^\]]*\]|\([^)]*\)/g,'').match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length??0);};
const resolveVar=(v:string):string=>v.replace(/var\((--[\w-]+)\)/g,(_,n)=>resolveVar(tokens.get(n)??''));
function style(el:Element,prop:string):string|undefined{
  let best:{spec:number;order:number;value:string}|undefined;
  for(const rule of rules){
    const value=rule.decls.get(prop);if(value===undefined)continue;
    for(const part of parts(rule.selector)){let hit=false;try{hit=el.matches(part);}catch{hit=false;}
      if(!hit)continue;const spec=specificity(part);
      if(!best||spec>best.spec||(spec===best.spec&&rule.order>best.order))best={spec,order:rule.order,value};}
  }
  return best&&resolveVar(best.value);
}
const num=(v:string|undefined)=>Number.parseFloat(v??'NaN');

const React=await import('react'),{createRoot}=await import('react-dom/client');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const show=async(node:React.ReactNode)=>{root.render(node);await delay(40);};
const click=async(el:Element|null)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(40);};

// ---- #309: New task > Owner opens above the dialog ----
{
  const {NewTaskSheet}=await import('../src/renderer/components/HubSetup');
  const snapshot:any={projects:[{id:'p1',name:'Redis',source:'paperclip'}],agents:[{id:'a1',name:'CTO',title:'Chief Technology Officer',status:'idle',source:'paperclip',memberId:'m1'}],people:[{id:'u-me',name:'Dhairya',me:true},{id:'u-ann',name:'Ann Lee'}],tasks:[],goals:[],labels:[]};
  await show(<NewTaskSheet open snapshot={snapshot} projectId="p1" onClose={()=>{}} onCreated={()=>{}}/>);
  const dialog=document.querySelector('.ws-new-task')!;assert.ok(dialog,'the New task dialog renders');
  await click(dialog.querySelector('.owner-trigger'));
  const pop=document.querySelector('.owner-pop');assert.ok(pop,'the owner list opens');
  assert.ok(!dialog.contains(pop),'the list is portalled out of the dialog, so its overflow cannot clip it');
  const dialogZ=num(style(dialog,'z-index')),backdropZ=num(style(document.querySelector('.composer-access-backdrop')!,'z-index')),popZ=num(style(pop!,'z-index'));
  assert.ok(dialogZ>=111&&backdropZ>=110,`dialog layers are known (${dialogZ}/${backdropZ})`);
  assert.ok(popZ>dialogZ&&popZ>backdropZ,`the owner list (z ${popZ}) stacks above the dialog (z ${dialogZ}) and its backdrop (z ${backdropZ})`);
  assert.equal(style(pop!,'position'),'absolute','base rule');
  // Every popover and menu layer sits above the modal layer, so any picker opened inside a dialog is usable.
  for(const cls of ['ui-menu-positioner','branch-picker-positioner','project-menu-positioner','file-action-positioner','resource-add-positioner','env-menu-positioner','subagent-menu-positioner','review-baseline-positioner','pending-attention-positioner','chat-menu-positioner'])
    assert.ok(num(style(Object.assign(document.createElement('div'),{className:cls}),'z-index'))>dialogZ,`${cls} stacks above dialogs`);
  const option=[...document.querySelectorAll('.owner-option')].find(o=>o.textContent?.includes('Ann Lee'))!;
  option.dispatchEvent(new window.Event('mousedown',{bubbles:true,cancelable:true}));await delay(40);
  assert.ok(!document.querySelector('.owner-pop'),'choosing closes the list');
  assert.equal(dialog.querySelector('.owner-current')?.textContent,'Ann Lee','the option is clickable and sets the owner');
  await show(null);
}

// ---- #310: compact reply rhythm ----
{
  const {MessageBody}=await import('../src/renderer/components/MessageBody');
  const sample=['First paragraph of the answer.','','Second paragraph, closely related.','','Root cause: the cache key ignored the tenant id.','','- **Bold item**: with a *slanted* word','- Plain item','','Next step: ship it.'].join('\n');
  await show(<div className="timeline-row"><div className="msg msg-assistant"><MessageBody text={sample} linkFiles/></div></div>);
  const body=document.querySelector('.md-body')!,paragraph=body.querySelector('p')!,list=body.querySelector('ul')!;
  assert.equal(tokens.get('--md-gap'),'0.55em');
  const gap=num(style(paragraph,'margin-block'));assert.ok(gap>=0.5&&gap<=0.6,`paragraph margin ${gap}em is 0.5-0.6em`);
  assert.equal(style(paragraph,'margin-block'),style(list,'margin-block'),'paragraph to list uses the same compact gap');
  const lh=num(style(body,'line-height'));assert.ok(lh>=1.5&&lh<=1.55,`body line-height ${lh}`);
  const strong=document.querySelector('strong')!;
  const weight=num(style(strong,'font-weight'));assert.ok(weight>=600&&weight<=650,`bold weight ${weight}`);
  assert.equal(style(strong,'color'),tokens.get('--text-strong'),'bold uses the stronger foreground token');
  assert.notEqual(tokens.get('--text-strong'),tokens.get('--text'));
  assert.equal(style(document.querySelector('em')!,'font-style'),'italic');
  const h=document.createElement('h2');body.appendChild(h);const hm=(style(h,'margin')??'').split(/\s+/);
  assert.ok(num(hm[0])<=1.1&&num(hm[2]??hm[0])<=0.5,`heading margin ${hm.join(' ')} is modest`);
  const blockquote=document.createElement('blockquote');body.appendChild(blockquote);assert.equal(style(blockquote,'margin-block'),style(paragraph,'margin-block'),'blockquotes use the paragraph gap');
  // code stays readable
  assert.ok(num(style(Object.assign(document.createElement('div'),{className:'md-code-body'}),'line-height'))>=1.5,'code blocks keep their leading');
  // the label rule: bold labels in paragraphs and list items; the text itself is unchanged
  assert.deepEqual([...body.querySelectorAll('strong.md-label')].map(s=>s.textContent),['Root cause:','Next step:'],'leading labels are bold');
  assert.ok(!body.querySelector('li strong.md-label'),'authored bold stays authored (no double wrap)');
  assert.equal(body.textContent?.replace(/\s+/g,' ').trim().startsWith('First paragraph of the answer. Second paragraph, closely related. Root cause: the cache key ignored the tenant id.'),true,'text reads exactly as sent');
  // negatives, rendered end to end
  const negatives=['Meet at 10:30 tomorrow.','https://example.com/docs is the link.','See `config: value` for details.','Here is what I found in the logs: nothing.','The answer, in short: yes.','Path src/app.py:12 is hot.','**Note:** already bold.','[Docs: intro](https://x.dev) is a link.','A very long label that goes on and on forever: x'].join('\n\n');
  await show(<div className="timeline-row"><div className="msg msg-assistant"><MessageBody text={negatives} linkFiles/></div></div>);
  const added=[...document.querySelectorAll('.md-body strong.md-label')].map(s=>s.textContent);
  assert.deepEqual(added,[],`no label rule fires on: ${added.join(', ')}`);
  assert.equal(document.querySelectorAll('.md-body strong').length,1,'only the authored bold exists');
  assert.ok(!document.querySelector('code strong, a strong'),'nothing inside code or links');
  // list items
  await show(<div className="timeline-row"><div className="msg msg-assistant"><MessageBody text={'- Note: first item\n- plain item\n1. Risk: slow path'} linkFiles/></div></div>);
  assert.deepEqual([...document.querySelectorAll('li strong.md-label')].map(s=>s.textContent),['Note:','Risk:'],'list items get the label rule');
  await show(null);
}

// ---- #311: the Stopped banner is in the chat column, in flow ----
{
  const {RecoveryNotice}=await import('../src/renderer/components/RecoveryNotice');
  const chat={id:'c1',title:'RAG-121',pinned:false,archived:false,draft:'',status:'interrupted' as const,updatedAt:'',model:'m',mode:'agent' as const,error:'Stopped.',recovery:{kind:'cancelled' as const,retryable:false,reason:'Stopped. The provider process for this turn was shut down.'}};
  await show(<div className="app"><nav className="nav"/><main className="center" data-summary="reserve"><div className="chat"><header className="chat-head"/><RecoveryNotice chat={chat as any}/></div></main></div>);
  const banner=document.querySelector('.chat-error-banner')!;assert.ok(banner,'the banner renders');
  assert.ok(banner.closest('.chat'),'it is a descendant of the chat column');
  assert.ok(!banner.closest('.nav'),'it is not inside the sidebar');
  assert.equal(banner.previousElementSibling?.className,'chat-head','it comes right after the chat header');
  const position=style(banner,'position');assert.ok(!position||position==='static'||position==='relative'||position==='sticky',`banner position is ${position}, never fixed or absolute`);
  assert.equal(style(banner,'translate'),undefined,'the summary-card room shift does not move it (that shift made it span the sidebar)');
  assert.equal(style(document.querySelector('.chat-head')!,'translate'),undefined);
  const composer=Object.assign(document.createElement('div'),{className:'composer'});document.querySelector('.chat')!.appendChild(composer);
  assert.ok(style(composer,'translate')!==undefined,'the room shift still applies to the composer');
  await show(null);
}
assert.deepEqual(errors,[],'no React errors');
root.unmount();
console.log('Chat polish DOM checks passed: owner list above dialogs, compact reply rhythm and label emphasis, banner inside the chat column.');
process.exit(0);
