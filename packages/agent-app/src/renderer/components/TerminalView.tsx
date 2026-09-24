import React,{useEffect,useLayoutEffect,useRef,useState} from 'react';
import {ArrowDown,ChevronDown,ChevronUp,X} from 'lucide-react';
import type {Terminal} from '@xterm/xterm';
import type {FitAddon} from '@xterm/addon-fit';
import type {SearchAddon} from '@xterm/addon-search';
import {invoke,subscribe} from '../bridge';
import {copyText} from '../clipboard';
import {openBrowserTab} from '../store';
import type {TerminalReplay} from '../../shared/process-protocol';
import './terminal.css';

/** One xterm per PTY for the life of the window. Tab switches move its host element
 * between containers; the emulator, scrollback and selection are never rebuilt. */
interface Live {
  id:string;host:HTMLDivElement;term?:Terminal;fit?:FitAddon;search?:SearchAddon;
  opening?:Promise<void>;end:number;queue:{data:string;start:number}[];syncing:boolean;
  readOnly:boolean;omittedLines:number;truncatedBytes:number;following:boolean;
  listeners:Set<()=>void>;resizeTimer?:ReturnType<typeof setTimeout>;disposed:boolean;
}
const registry=new Map<string,Live>();
let unsubscribe:(()=>void)|undefined;
let xterm:Promise<{Terminal:typeof Terminal;FitAddon:typeof FitAddon;SearchAddon:typeof SearchAddon;WebLinksAddon:typeof import('@xterm/addon-web-links').WebLinksAddon}>|undefined;
const loadXterm=()=>xterm??=Promise.all([import('@xterm/xterm'),import('@xterm/addon-fit'),import('@xterm/addon-search'),import('@xterm/addon-web-links')])
  .then(([core,fit,search,links])=>({Terminal:core.Terminal,FitAddon:fit.FitAddon,SearchAddon:search.SearchAddon,WebLinksAddon:links.WebLinksAddon}))
  .catch(error=>{xterm=undefined;throw error;});
const notify=(live:Live)=>{for(const listener of live.listeners)listener();};

/** Apply a frame by stream offset: duplicates are skipped, overlaps trimmed, gaps resynced. */
function apply(live:Live,data:string,start:number):void {
  if(!live.term||live.syncing){live.queue.push({data,start});return;}
  if(start>live.end){void resync(live);return;}
  const fresh=start<live.end?data.slice(live.end-start):data;
  if(!fresh)return;
  live.end+=fresh.length;live.term.write(fresh);
}
async function resync(live:Live):Promise<void> {
  if(live.syncing||!live.term)return;
  live.syncing=true;live.queue=[];
  try{
    const replay:TerminalReplay=await invoke('terminal.snapshot',{id:live.id});
    if(live.disposed)return;
    live.term.reset();live.term.write(replay.data);live.end=replay.end;
    live.omittedLines=replay.omittedLines;live.truncatedBytes=replay.truncatedBytes;notify(live);
  }catch{/* The terminal was closed elsewhere; its row reports that. */}
  finally{live.syncing=false;const queued=live.queue;live.queue=[];for(const frame of queued)apply(live,frame.data,frame.start);}
}
function listen():void {
  unsubscribe??=subscribe(event=>{
    if(event.type==='terminalData'){const live=registry.get(event.id);if(live)apply(live,event.data,event.start);}
    else if(event.type==='terminalExit'){const live=registry.get(event.id);if(live){live.readOnly=true;if(live.term)live.term.options.disableStdin=true;notify(live);}}
  });
}
function css(name:string,fallback:string):string {
  try{return getComputedStyle(document.documentElement).getPropertyValue(name).trim()||fallback;}catch{return fallback;}
}
function live(id:string):Live {
  let entry=registry.get(id);
  if(!entry){
    const host=document.createElement('div');host.className='terminal-host';
    entry={id,host,end:0,queue:[],syncing:false,readOnly:false,omittedLines:0,truncatedBytes:0,following:true,listeners:new Set(),disposed:false};
    registry.set(id,entry);listen();
  }
  return entry;
}
/** Open the emulator once, inside an attached host so it can measure its cell size. */
function open(entry:Live,readOnly:boolean):Promise<void> {
  entry.readOnly=entry.readOnly||readOnly;
  return entry.opening??=loadXterm().then(async({Terminal,FitAddon,SearchAddon,WebLinksAddon})=>{
    if(entry.disposed)return;
    const term=new Terminal({
      fontFamily:css('--mono','ui-monospace, Menlo, monospace'),fontSize:12,lineHeight:1.25,scrollback:5000,
      cursorBlink:true,allowProposedApi:true,macOptionIsMeta:true,disableStdin:entry.readOnly,
      theme:{background:css('--bg','#161616'),foreground:css('--text','#e8e8e8'),cursor:css('--text','#e8e8e8'),selectionBackground:'rgba(145,171,194,0.35)'},
    });
    const fit=new FitAddon(),search=new SearchAddon();
    term.loadAddon(fit);term.loadAddon(search);
    term.loadAddon(new WebLinksAddon((event,uri)=>{event.preventDefault();openBrowserTab(uri);}));
    term.attachCustomKeyEventHandler(event=>{
      if(event.type!=='keydown'||!event.metaKey)return true;
      const key=event.key.toLowerCase();
      // Handled chords are consumed so the menu's ⌘F (Find in Chat) and ⌘K (Search Chats)
      // accelerators do not also fire while the terminal has focus.
      const consume=()=>{event.preventDefault();event.stopPropagation();return false;};
      if(key==='f'){window.dispatchEvent(new CustomEvent('muster-terminal-find',{detail:entry.id}));return consume();}
      if(key==='k'){term.clear();return consume();}
      if(key==='c'&&term.hasSelection()){void copyText(term.getSelection());return consume();}
      return true;
    });
    term.onData(data=>{if(!entry.readOnly)void invoke('terminal.input',{id:entry.id,data}).catch(()=>{});});
    term.onResize(({cols,rows})=>{
      if(entry.readOnly)return;
      clearTimeout(entry.resizeTimer);
      entry.resizeTimer=setTimeout(()=>void invoke('terminal.resize',{id:entry.id,cols,rows}).catch(()=>{}),60);
    });
    term.onScroll(()=>{const buffer=term.buffer.active,following=buffer.viewportY>=buffer.baseY;if(following!==entry.following){entry.following=following;notify(entry);}});
    term.open(entry.host);
    entry.term=term;entry.fit=fit;entry.search=search;
    try{fit.fit();}catch{}
    await resync(entry);
  });
}
/** Release the emulator when its PTY is closed; nothing else ever disposes it. */
export function disposeTerminal(id:string):void {
  const entry=registry.get(id);if(!entry)return;
  entry.disposed=true;clearTimeout(entry.resizeTimer);entry.term?.dispose();entry.host.remove();registry.delete(id);
  if(!registry.size){unsubscribe?.();unsubscribe=undefined;}
}
/** A hidden window receives no events: on return, resync any stream that moved on. */
export function reconcileTerminal(id:string,end:number|undefined):void {
  const entry=registry.get(id);
  if(entry?.term&&end!==undefined&&end!==entry.end)void resync(entry);
}
export function terminalText(id:string):string {
  const term=registry.get(id)?.term;if(!term)return '';
  if(term.hasSelection())return term.getSelection();
  const buffer=term.buffer.active,lines:string[]=[];
  for(let row=0;row<buffer.length;row++){const line=buffer.getLine(row);if(!line)continue;const text=line.translateToString(true);if(line.isWrapped&&lines.length)lines[lines.length-1]+=text;else lines.push(text);}
  return lines.join('\n').replace(/\s+$/,'')+'\n';
}
export function clearTerminal(id:string):void {registry.get(id)?.term?.clear();}
export function scrollTerminalToBottom(id:string):void {const term=registry.get(id)?.term;term?.scrollToBottom();term?.focus();}

export function TerminalView({id,readOnly=false,visible=true}:{id:string;readOnly?:boolean;visible?:boolean}) {
  const container=useRef<HTMLDivElement>(null);
  const [,render]=useState(0),[finding,setFinding]=useState(false),[query,setQuery]=useState(''),[error,setError]=useState('');
  const entry=live(id);
  useLayoutEffect(()=>{
    const parent=container.current;if(!parent)return;
    parent.appendChild(entry.host);
    const changed=()=>render(value=>value+1);entry.listeners.add(changed);
    void open(entry,readOnly).then(()=>{if(entry.disposed)return;try{entry.fit?.fit();}catch{}if(!readOnly&&visible)entry.term?.focus();},cause=>setError(cause instanceof Error?cause.message:String(cause)));
    const observer=typeof ResizeObserver==='function'?new ResizeObserver(()=>{if(parent.clientWidth>0&&parent.clientHeight>0)try{entry.fit?.fit();}catch{}}):undefined;
    observer?.observe(parent);
    return()=>{observer?.disconnect();entry.listeners.delete(changed);if(entry.host.parentElement===parent)parent.removeChild(entry.host);};
  },[id]);
  useEffect(()=>{if(readOnly&&!entry.readOnly){entry.readOnly=true;if(entry.term)entry.term.options.disableStdin=true;}},[readOnly]);
  useEffect(()=>{
    const find=(event:Event)=>{if((event as CustomEvent).detail===id)setFinding(true);};
    window.addEventListener('muster-terminal-find',find);return()=>window.removeEventListener('muster-terminal-find',find);
  },[id]);
  const step=(forward:boolean)=>{if(!query)return;const options={decorations:{matchOverviewRuler:'#91abc2',activeMatchColorOverviewRuler:'#e8e8e8',matchBackground:'rgba(145,171,194,0.25)',activeMatchBackground:'rgba(145,171,194,0.55)'}};forward?entry.search?.findNext(query,options):entry.search?.findPrevious(query,options);};
  const closeFind=()=>{setFinding(false);entry.search?.clearDecorations();entry.term?.focus();};
  return <div className="terminal-view">
    {entry.omittedLines>0&&<p className="terminal-omitted" role="status">{entry.omittedLines.toLocaleString()} earlier {entry.omittedLines===1?'line was':'lines were'} omitted. Terminals keep the newest 5,000 lines.</p>}
    {finding&&<form className="terminal-find" role="search" onSubmit={event=>{event.preventDefault();step(true);}}>
      <input autoFocus aria-label="Find in terminal" placeholder="Find" value={query} spellCheck={false} onChange={event=>setQuery(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();closeFind();}else if(event.key==='Enter'&&event.shiftKey){event.preventDefault();step(false);}}}/>
      <button type="button" aria-label="Previous match" onClick={()=>step(false)}><ChevronUp size={13}/></button>
      <button type="submit" aria-label="Next match"><ChevronDown size={13}/></button>
      <button type="button" aria-label="Close find" onClick={closeFind}><X size={13}/></button>
    </form>}
    <div className="terminal-surface" ref={container}/>
    {!entry.following&&<button type="button" className="terminal-jump" onClick={()=>scrollTerminalToBottom(id)}><ArrowDown size={12}/>Jump to latest</button>}
    {error&&<p className="process-error" role="alert">{error}</p>}
  </div>;
}
export function openTerminalFind(id:string):void {window.dispatchEvent(new CustomEvent('muster-terminal-find',{detail:id}));}
