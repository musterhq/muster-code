/** #425: reply tables never clip a cell. Long inline-code chips and long words wrap inside the cell (no nowrap, no
 *  ellipsis, no overflow:hidden), a wide table scrolls inside its own container, and Copy table copies full values.
 *  linkedom has no layout or cascade, so computed style is resolved here from the real stylesheets: rules that match
 *  the element, highest specificity then source order. */
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
const copied:string[]=[];
(window as any).muster={subscribe:()=>()=>{},async invoke(command:string,input:any){if(command==='clipboard.write')copied.push(input.text);return undefined;}};
setTimeout(()=>{console.error('markdown-table-dom: timed out');process.exit(4);},60_000);

// ---- a small cascade over the app's stylesheets ----
const renderer=join(process.cwd(),'src','renderer');
const walk=(dir:string):string[]=>readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?walk(join(dir,e.name)):e.name.endsWith('.css')?[join(dir,e.name)]:[]);
type Rule={selector:string;decls:Map<string,string>;order:number};
const rules:Rule[]=[];let order=0;
for(const file of walk(renderer).sort()){
  const css=readFileSync(file,'utf8').replace(/\/\*[\s\S]*?\*\//g,'');
  for(const m of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)){
    const selector=m[1]!.trim(),decls=new Map<string,string>();
    for(const d of m[2]!.split(';')){const i=d.indexOf(':');if(i>0)decls.set(d.slice(0,i).trim(),d.slice(i+1).trim());}
    if(selector.startsWith('@')||selector.startsWith(':root'))continue;
    rules.push({selector,decls,order:order++});
  }
}
const parts=(selector:string)=>{const out:string[]=[];let depth=0,cur='';for(const c of selector){if(c==='('||c==='[')depth++;if(c===')'||c===']')depth--;if(c===','&&!depth){out.push(cur.trim());cur='';}else cur+=c;}out.push(cur.trim());return out;};
const specificity=(s:string)=>{const strip=s.replace(/:where\([^)]*\)/g,'');return (strip.match(/#[\w-]+/g)?.length??0)*10000+((strip.match(/\.[\w-]+|\[[^\]]+\]|:(?!:)[\w-]+/g)?.length??0))*100+(strip.replace(/\[[^\]]*\]|\([^)]*\)/g,'').match(/(?:^|[\s>+~])[a-z][\w-]*/gi)?.length??0);};
function style(el:Element,prop:string):string|undefined{
  let best:{spec:number;order:number;value:string}|undefined;
  for(const rule of rules){
    const value=rule.decls.get(prop);if(value===undefined)continue;
    for(const part of parts(rule.selector)){let hit=false;try{hit=el.matches(part);}catch{hit=false;}
      if(!hit)continue;const spec=specificity(part);
      if(!best||spec>best.spec||(spec===best.spec&&rule.order>best.order))best={spec,order:rule.order,value};}
  }
  return best?.value;
}
/** Inherited properties walk up to the nearest ancestor that sets them. */
function inherited(el:Element|null,prop:string):string|undefined{for(let n=el;n;n=n.parentElement){const v=style(n,prop);if(v!==undefined&&v!=='inherit')return v;}return undefined;}

const React=await import('react'),{createRoot}=await import('react-dom/client');
const {MarkdownTable}=await import('../src/renderer/components/MarkdownTable');
const errors:unknown[]=[];
const root=createRoot(document.getElementById('root')!,{onUncaughtError:e=>errors.push(e),onRecoverableError:e=>errors.push(e)});
const click=async(el:Element|null)=>{assert.ok(el,'element to click exists');(el as HTMLElement).dispatchEvent(new window.Event('click',{bubbles:true,cancelable:true}));await delay(40);};

const longCode='settings.requirePermissionPromptForEveryToolInvocationAcrossAllWorkspaces';
const longWord='Environment-variable-REDIS_CLUSTER_CONNECTION_STRING_WITH_A_VERY_LONG_SUFFIX_THAT_NEVER_BREAKS';
root.render(<div className="md-body"><MarkdownTable>
  <thead><tr><th>Setting</th><th>Meaning</th></tr></thead>
  <tbody><tr><td><code>{longCode}</code></td><td>{longWord} and some ordinary prose that keeps going for a while.</td></tr></tbody>
</MarkdownTable></div>);
await delay(60);

const table=document.querySelector('.md-table')!;assert.ok(table,'the table renders');
const scroll=table.querySelector('.md-table-scroll')!;
assert.equal(style(scroll,'overflow-x'),'auto','a wide table scrolls inside its own container');

const check=(label:string)=>{
  for(const cell of Array.from(table.querySelectorAll('td'))){
    assert.notEqual(style(cell,'text-overflow'),'ellipsis',`${label}: td has no ellipsis`);
    assert.notEqual(style(cell,'overflow'),'hidden',`${label}: td does not hide overflow`);
    assert.notEqual(inherited(cell,'white-space'),'nowrap',`${label}: td text wraps`);
    assert.equal(inherited(cell,'overflow-wrap'),'anywhere',`${label}: long words in a td break`);
  }
  const chip=table.querySelector('td code')!;assert.ok(chip,'the inline-code chip renders');
  assert.notEqual(style(chip,'text-overflow'),'ellipsis',`${label}: code chip has no ellipsis`);
  assert.notEqual(style(chip,'overflow'),'hidden',`${label}: code chip does not hide overflow`);
  assert.ok(['normal','break-spaces','pre-wrap'].includes(inherited(chip,'white-space')??'normal'),`${label}: code chip wraps`);
  assert.equal(inherited(chip,'overflow-wrap'),'anywhere',`${label}: a long code chip breaks anywhere`);
  assert.ok(!/^(\d|min\()/.test(style(chip,'max-width')??'none'),`${label}: code chip has no fixed max-width`);
};
assert.equal(table.getAttribute('data-wrap'),'false');
check('default');
await click(table.querySelector('[aria-label="Expand table cells"]'));
assert.equal(table.getAttribute('data-wrap'),'true','Expand table cells toggles');
check('expanded');
assert.equal(style(table.querySelector('td')!,'max-width'),'none','expanded cells have no width cap');

await click(table.querySelector('[aria-label="Copy table"]'));
await click(Array.from(table.querySelectorAll('.md-table-copy-menu button')).find(b=>b.textContent==='Copy as Markdown')??null);
assert.equal(copied.length,1,'Copy table writes to the clipboard');
assert.ok(copied[0]!.includes(longCode),'the copy has the full code value');
assert.ok(copied[0]!.includes(longWord),'the copy has the full long word');

assert.deepEqual(errors,[]);
root.unmount();
console.log('markdown-table-dom: ok');
process.exit(0);
