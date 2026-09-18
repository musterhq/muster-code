import React,{useEffect,useRef,useState} from 'react';
import {FileDiff,ChevronDown} from 'lucide-react';
import type {Chat,TimelineItem} from '../../shared/protocol';
import {openDiff} from '../store';
import {useStore} from '../useStore';
import './turn-changes.css';

export function TurnChanges({chat,items}:{chat:Chat;items:TimelineItem[]}){
 const state=useStore(),[open,setOpen]=useState(false),root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const turn=items.slice(items.findLastIndex(item=>item.kind==='user')+1);
 const changes=new Map<string,{path:string;adds:number;dels:number}>();
 for(const item of turn){if(item.kind!=='tool'||item.data?.type!=='fileChange'||item.status!=='completed'||!Array.isArray(item.data.changes))continue;
  for(const value of item.data.changes){if(!value||typeof value.path!=='string')continue;
   const path=value.path,diff=typeof value.diff==='string'?value.diff:'';
   const entry=changes.get(path)??{path,adds:0,dels:0};
   for(const line of diff.split('\n')){if(line.startsWith('+')&&!line.startsWith('+++'))entry.adds++;if(line.startsWith('-')&&!line.startsWith('---'))entry.dels++;}changes.set(path,entry);
  }
 }
 const entries=[...changes.values()];
 const project=state.snapshot?.projects.find(p=>p.id===chat.projectId);
 const folders=(state.snapshot?.folders??[]).filter(f=>f.id===chat.folderId||project?.folderIds.includes(f.id));
 useEffect(()=>{if(!open)return;const down=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};document.addEventListener('pointerdown',down);return()=>document.removeEventListener('pointerdown',down);},[open]);
 if(!entries.length)return null;
 return <div className="turn-changes" ref={root} onKeyDown={e=>{if(e.key==='Escape'){setOpen(false);trigger.current?.focus();}}} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <button ref={trigger} className="changes-pill" aria-expanded={open} title="Files edited in the latest turn. Open a file to review its current workspace diff." onClick={()=>setOpen(value=>!value)}><FileDiff size={13}/>{entries.length} {entries.length===1?'file':'files'} changed <ChevronDown size={12}/></button>
  {open&&<div className="turn-change-list" role="group" aria-label="Files edited in the latest turn">
   <div className="turn-change-heading">Latest turn · current workspace diffs</div>
   {entries.map(entry=>{const folder=folders.find(f=>entry.path.startsWith(f.path+'/'))??(!entry.path.startsWith('/')&&folders.length===1?folders[0]:undefined);const relative=folder&&entry.path.startsWith(folder.path+'/')?entry.path.slice(folder.path.length+1):entry.path;
    return <button key={entry.path} disabled={!folder} title={folder?entry.path:'File is outside this chat’s folders'} onClick={()=>{if(folder)void openDiff(folder.id,relative);setOpen(false);}}><span>{entry.path.split('/').at(-1)}</span>{entry.adds>0&&<span className="change-adds">+{entry.adds}</span>}{entry.dels>0&&<span className="change-dels">−{entry.dels}</span>}</button>;})}
  </div>}
 </div>;
}
