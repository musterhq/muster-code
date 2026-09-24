import {browserURL, type BrowserBounds, type BrowserConsoleEntry, type BrowserConsoleLevel, type BrowserPickedElement} from '../shared/browser-protocol.ts';

/** Isolated world for Muster's picker: page scripts cannot see or call into it. */
export const BROWSER_PICK_WORLD=1047;
export const MAX_CONSOLE_ENTRIES=200;
const MAX_OUTER_HTML=4000, MAX_TEXT=1000, PICK_TIMEOUT_MS=120_000;

/** One overlay script for both modes. It resolves once: a picked element, a dragged
 * region (CSS pixels), or null on Escape, timeout or window.__musterPick.cancel(). */
export function browserPickScript(mode:'element'|'region'):string {
  return `(()=>new Promise(resolve=>{
const w=window;try{w.__musterPick&&w.__musterPick.cancel();}catch{}
const mode=${JSON.stringify(mode)},root=document.documentElement,z='2147483647';
const box=document.createElement('div'),tag=document.createElement('div'),shade=document.createElement('div');
box.style.cssText='position:fixed;pointer-events:none;z-index:'+z+';border:1.5px solid #4c8dff;background:rgba(76,141,255,.14);border-radius:2px;display:none;box-sizing:border-box';
tag.style.cssText='position:fixed;pointer-events:none;z-index:'+z+';font:500 11px/1.4 -apple-system,system-ui,sans-serif;color:#fff;background:#1f5fd6;padding:2px 6px;border-radius:4px;display:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis';
shade.style.cssText='position:fixed;inset:0;z-index:'+z+';cursor:crosshair;background:'+(mode==='region'?'rgba(0,0,0,.08)':'transparent');
if(mode==='element')shade.style.pointerEvents='none';
root.append(shade,box,tag);
let target=null,start=null,finished=false;
const place=(r)=>{box.style.display='block';box.style.left=r.x+'px';box.style.top=r.y+'px';box.style.width=r.width+'px';box.style.height=r.height+'px';};
const name=(el)=>el.tagName.toLowerCase()+(el.id?'#'+el.id:'')+(typeof el.className==='string'&&el.className.trim()?'.'+el.className.trim().split(/\\s+/).slice(0,2).join('.'):'');
const selector=(el)=>{const parts=[];for(let node=el;node&&node.nodeType===1&&parts.length<6;node=node.parentElement){
  if(node.id){parts.unshift('#'+CSS.escape(node.id));break;}
  let part=node.tagName.toLowerCase();const parent=node.parentElement;
  if(parent){const same=[...parent.children].filter(c=>c.tagName===node.tagName);if(same.length>1)part+=':nth-of-type('+(same.indexOf(node)+1)+')';}
  parts.unshift(part);if(node===document.body)break;}
  return parts.join(' > ');};
const finish=(value)=>{if(finished)return;finished=true;
  removeEventListener('mousemove',move,true);removeEventListener('mousedown',down,true);removeEventListener('mouseup',up,true);removeEventListener('click',block,true);removeEventListener('keydown',key,true);
  shade.remove();box.remove();tag.remove();clearTimeout(timer);if(w.__musterPick===api)delete w.__musterPick;resolve(value);};
const move=(e)=>{
  if(mode==='region'){if(!start)return;const x=Math.min(start.x,e.clientX),y=Math.min(start.y,e.clientY);place({x,y,width:Math.abs(e.clientX-start.x),height:Math.abs(e.clientY-start.y)});return;}
  const el=document.elementFromPoint(e.clientX,e.clientY);if(!el||el===box||el===tag||el===shade)return;
  target=el;const r=el.getBoundingClientRect();place(r);tag.textContent=name(el);tag.style.display='block';
  tag.style.left=Math.max(0,r.x)+'px';tag.style.top=(r.y>22?r.y-21:r.bottom+3)+'px';};
const down=(e)=>{e.preventDefault();e.stopPropagation();if(mode==='region')start={x:e.clientX,y:e.clientY};};
const up=(e)=>{e.preventDefault();e.stopPropagation();
  if(mode==='region'){if(!start)return;const x=Math.min(start.x,e.clientX),y=Math.min(start.y,e.clientY),width=Math.abs(e.clientX-start.x),height=Math.abs(e.clientY-start.y);start=null;
    if(width<4||height<4){box.style.display='none';return;}finish({rect:{x,y,width,height}});return;}
  if(!target)return;const r=target.getBoundingClientRect(),html=target.outerHTML||'';
  finish({selector:selector(target),tag:target.tagName.toLowerCase(),outerHTML:html.slice(0,${MAX_OUTER_HTML}),truncated:html.length>${MAX_OUTER_HTML},text:(target.innerText||target.textContent||'').replace(/\\s+/g,' ').trim().slice(0,${MAX_TEXT}),rect:{x:r.x,y:r.y,width:r.width,height:r.height}});};
const block=(e)=>{e.preventDefault();e.stopPropagation();};
const key=(e)=>{if(e.key==='Escape'){e.preventDefault();e.stopPropagation();finish(null);}};
addEventListener('mousemove',move,true);addEventListener('mousedown',down,true);addEventListener('mouseup',up,true);addEventListener('click',block,true);addEventListener('keydown',key,true);
const timer=setTimeout(()=>finish(null),${PICK_TIMEOUT_MS});
const api={cancel:()=>finish(null)};w.__musterPick=api;
}))()`;
}
export const BROWSER_CANCEL_PICK_SCRIPT='(()=>{try{window.__musterPick&&window.__musterPick.cancel();}catch{}})()';

const finite=(value:unknown):value is number=>typeof value==='number' && Number.isFinite(value);
/** Page-derived values are untrusted: bound every field before it reaches chat context. */
export function pickedRect(value:unknown):BrowserBounds|undefined {
  const rect=value as BrowserBounds|undefined;
  if(!rect || ![rect.x,rect.y,rect.width,rect.height].every(finite) || rect.width<=0 || rect.height<=0) return undefined;
  const x=Math.max(0,Math.round(rect.x)),y=Math.max(0,Math.round(rect.y));
  return {x,y,width:Math.min(16384,Math.round(rect.width+Math.min(0,rect.x))),height:Math.min(16384,Math.round(rect.height+Math.min(0,rect.y)))};
}
export function pickedElement(value:unknown,url:string):BrowserPickedElement|null {
  const raw=value as Partial<BrowserPickedElement>|null|undefined;
  if(!raw || typeof raw!=='object' || typeof raw.selector!=='string' || !raw.selector) return null;
  const text=(input:unknown,max:number)=>typeof input==='string'?input.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,max):'';
  const outerHTML=text(raw.outerHTML,MAX_OUTER_HTML);
  return {url,selector:text(raw.selector,512),tag:text(raw.tag,64)||'element',outerHTML,truncated:raw.truncated===true || (typeof raw.outerHTML==='string' && raw.outerHTML.length>MAX_OUTER_HTML),text:text(raw.text,MAX_TEXT),rect:pickedRect(raw.rect)??{x:0,y:0,width:0,height:0}};
}

const LEVELS:BrowserConsoleLevel[]=['debug','info','warning','error'];
/** Electron >= 35 passes one details event; older runtimes pass (event, level, message, line, source). */
export function consoleEntry(args:unknown[],at:number):BrowserConsoleEntry|undefined {
  const [details,level,message,line,source]=args as [Record<string,unknown>|undefined,unknown,unknown,unknown,unknown];
  const modern=details && typeof details.message==='string';
  const rawLevel=modern?details!.level:level, rawMessage=modern?details!.message:message;
  if(typeof rawMessage!=='string') return undefined;
  const named=typeof rawLevel==='string' && (LEVELS as string[]).includes(rawLevel)?rawLevel as BrowserConsoleLevel:typeof rawLevel==='number'?LEVELS[Math.max(0,Math.min(3,rawLevel))]:'info';
  const rawLine=modern?details!.lineNumber:line, rawSource=modern?details!.sourceId:source;
  return {level:named,message:rawMessage.slice(0,2000),source:typeof rawSource==='string'?rawSource.slice(0,512):'',line:finite(rawLine)?Math.max(0,Math.floor(rawLine)):0,at};
}

/** Downloaded names never carry a path, control characters or a hidden prefix. */
export function downloadFilename(value:unknown):string {
  const base=(typeof value==='string'?value:'').split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f<>:"|?*]/g,'_').replace(/^[.\s]+/,'').trim().slice(0,180);
  return base || 'download';
}
/** "name.ext", then "name (1).ext" ... against names already taken. */
export function uniqueFilename(name:string,taken:(candidate:string)=>boolean):string {
  if(!taken(name)) return name;
  const dot=name.lastIndexOf('.'),stem=dot>0?name.slice(0,dot):name,ext=dot>0?name.slice(dot):'';
  for(let index=1;index<1000;index++){const candidate=`${stem} (${index})${ext}`;if(!taken(candidate))return candidate;}
  return `${stem} (${Date.now()})${ext}`;
}

/** First HTTP(S) favicon, or undefined. */
export function faviconURL(value:unknown):string|undefined {
  if(!Array.isArray(value)) return undefined;
  for(const item of value){try{const url=browserURL(item);if(url!=='about:blank')return url;}catch{/* skip */}}
  return undefined;
}
