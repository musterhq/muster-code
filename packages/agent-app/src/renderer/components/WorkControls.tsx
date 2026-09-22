import {transitionLayout} from '../layoutMotion';
import React, {useEffect,useRef,useState} from 'react';
import {Archive,ArchiveRestore,Check,Files,MoreHorizontal,PanelRight,Pencil,Pin,Share2,X} from 'lucide-react';
import {getState,activeChat,openFilesTab,pickFolder,setResourcesHidden,updateChat,notifyError} from '../store';
import {useStore} from '../useStore';
import {invoke} from '../bridge';
import './work-controls.css';
import {WorkspaceOverview} from './WorkspaceOverview';
import {PendingAttention} from './PendingAttention';

/** Always reachable from the conversation, including with the resource pane hidden. */
export function WorkControls(){
 const state=useStore(),chat=activeChat();
 const [open,setOpen]=useState(false);
 const [renaming,setRenaming]=useState(false),[title,setTitle]=useState(''),[notice,setNotice]=useState('');
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
 const renameInput=useRef<HTMLInputElement>(null);
 const folder=state.snapshot?.folders.find(f=>f.id===chat?.folderId);
 const close=(restore=false)=>{setOpen(false);if(restore)trigger.current?.focus();};
 useEffect(()=>{
  if(!open)return;
  const pointer=(e:PointerEvent)=>{if(!root.current?.contains(e.target as Node))setOpen(false);};
  const key=(e:KeyboardEvent)=>{if(e.key==='Escape'){e.preventDefault();setOpen(false);trigger.current?.focus();}};
  document.addEventListener('pointerdown',pointer);document.addEventListener('keydown',key);
  root.current?.querySelector<HTMLButtonElement>('.work-actions button')?.focus();
  return()=>{document.removeEventListener('pointerdown',pointer);document.removeEventListener('keydown',key);};
 },[open]);
 useEffect(()=>{if(renaming)requestAnimationFrame(()=>renameInput.current?.select());},[renaming]);
 const browse=()=>{close();if(folder)openFilesTab(folder.id,folder.name);else void pickFolder();};
 const copyLink=async()=>{if(!chat)return;try{await invoke('clipboard.write',{text:`muster://chat/${encodeURIComponent(chat.id)}`});setNotice('Local chat link copied');setTimeout(()=>setNotice(''),2200);}catch(error){notifyError(error);}finally{close();}};
 const beginRename=()=>{if(!chat)return;setTitle(chat.title);setRenaming(true);close();};
 const saveRename=async()=>{if(!chat)return;const next=title.trim();if(!next){renameInput.current?.focus();return;}try{if(await updateChat(chat.id,{title:next}))setRenaming(false);}catch(error){notifyError(error);}};
 return <div className="work-controls" ref={root} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <PendingAttention/>
  {notice&&<span className="work-control-notice" role="status">{notice}</span>}
  {chat&&<button className="icon-button" aria-label="Copy local chat link" title="Copy local chat link" onClick={()=>void copyLink()}><Share2 size={16}/></button>}
  <button ref={trigger} className="icon-button" aria-label="Conversation actions" title="Conversation actions" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={17}/></button>
  <button className="icon-button" aria-label={!state.resourcesHidden?'Hide resource pane':'Show resource pane'} title={!state.resourcesHidden?'Hide resource pane':'Show resource pane'} aria-pressed={!state.resourcesHidden} onClick={()=>{transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));}}><PanelRight size={16}/></button>
  {<div hidden={!open} className="work-actions" data-native-preview-overlay role="group" aria-label="Conversation actions">
   <WorkspaceOverview compact onNavigate={()=>close()}/>
   <button onClick={browse}><Files size={14}/>{folder?'Files and changes':'Open folder…'}</button>
   {<button onClick={()=>{transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));close(true);}}><PanelRight size={14}/>{state.resourcesHidden?'Show resources':'Hide resources'}</button>}
   {chat&&<button onClick={copyLink}><Share2 size={14}/>Copy local chat link</button>}
   {chat&&<button onClick={beginRename}><Pencil size={14}/>Rename chat</button>}
   {chat&&<button onClick={()=>{void updateChat(chat.id,{pinned:!chat.pinned});close(true);}}><Pin size={14}/>{chat.pinned?'Unpin chat':'Pin chat'}</button>}
   {chat&&<button onClick={()=>{void updateChat(chat.id,{archived:!chat.archived});close(true);}}>{chat.archived?<ArchiveRestore size={14}/>:<Archive size={14}/>} {chat.archived?'Restore chat':'Archive chat'}</button>}
  </div>}
  {renaming&&<form className="work-rename" onSubmit={event=>{event.preventDefault();void saveRename();}} data-native-preview-overlay>
   <label htmlFor="work-rename-title">Rename chat</label>
   <div><input ref={renameInput} id="work-rename-title" value={title} maxLength={256} onChange={event=>setTitle(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setRenaming(false);trigger.current?.focus();}}}/><button type="button" className="icon-button" aria-label="Cancel rename" onClick={()=>setRenaming(false)}><X size={14}/></button><button type="submit" className="icon-button" aria-label="Save chat name"><Check size={14}/></button></div>
  </form>}
 </div>;
}
