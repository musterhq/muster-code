import {copyText} from '../clipboard';
import React,{useEffect,useRef,useState} from 'react';
import {Check,Copy,Maximize2,Minimize2} from 'lucide-react';
import './markdown-table.css';

import {serializeTable} from './tableSerialization';
import {Tip} from './Tooltip';

/** Interaction reference: T3 Code ChatMarkdown's scroll/wrap/copy table workflow. */
export function MarkdownTable({children,...props}:React.ComponentProps<'table'>){
 const root=useRef<HTMLDivElement>(null),table=useRef<HTMLTableElement>(null),copyButton=useRef<HTMLButtonElement>(null);
 const [wrap,setWrap]=useState(false),[menu,setMenu]=useState(false),[feedback,setFeedback]=useState('');
 const timer=useRef<ReturnType<typeof setTimeout>|undefined>(undefined);
 useEffect(()=>()=>clearTimeout(timer.current),[]);
 useEffect(()=>{if(!menu)return;root.current?.querySelector<HTMLButtonElement>('.md-table-copy-menu button')?.focus();const close=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setMenu(false);};document.addEventListener('pointerdown',close);return()=>document.removeEventListener('pointerdown',close);},[menu]);
 const copy=async(format:'markdown'|'csv')=>{
  const rows=Array.from(table.current?.rows??[]).map(row=>Array.from(row.cells).map(cell=>cell.textContent??''));
  try{await copyText(serializeTable(rows,format));setFeedback('Copied');}catch{setFeedback('Copy failed');}
  setMenu(false);copyButton.current?.focus();clearTimeout(timer.current);timer.current=setTimeout(()=>setFeedback(''),1600);
 };
 return <div className="md-table" ref={root} data-wrap={wrap} onKeyDown={e=>{if(e.key==='Escape'){setMenu(false);copyButton.current?.focus();}}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setMenu(false);}}>
  <div className="md-table-scroll" tabIndex={0} role="region" aria-label="Message table"><table ref={table} {...props}>{children}</table></div>
  <div className="md-table-toolbar">
   <Tip label={wrap?'Collapse table cells':'Expand table cells'}><button className="md-copy" aria-label={wrap?'Collapse table cells':'Expand table cells'} aria-pressed={wrap} onClick={()=>setWrap(v=>!v)}>{wrap?<Minimize2 size={13}/>:<Maximize2 size={13}/>}</button></Tip>
   <span className="md-table-feedback" role="status">{feedback}</span>
   <button ref={copyButton} className="md-copy" aria-label="Copy table" title="Copy table" aria-expanded={menu} onClick={()=>setMenu(v=>!v)}>{feedback==='Copied'?<Check size={13}/>:<Copy size={13}/>}</button>
   {menu&&<div className="md-table-copy-menu" role="group" aria-label="Copy table format"><button onClick={()=>void copy('markdown')}>Copy as Markdown</button><button onClick={()=>void copy('csv')}>Copy as CSV</button></div>}
  </div>
 </div>;
}
