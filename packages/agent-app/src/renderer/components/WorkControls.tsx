import {transitionLayout} from '../layoutMotion';
import React, {useEffect,useRef,useState} from 'react';
import {Files,MoreHorizontal,PanelRight,Pin} from 'lucide-react';
import {getState,activeChat,openFilesTab,pickFolder,setResourcesHidden,updateChat} from '../store';
import {useStore} from '../useStore';
import './work-controls.css';
import {WorkspaceOverview} from './WorkspaceOverview';

/** Always reachable from the conversation, including with the resource pane hidden. */
export function WorkControls(){
 const state=useStore(),chat=activeChat();
 const [open,setOpen]=useState(false);
 const root=useRef<HTMLDivElement>(null),trigger=useRef<HTMLButtonElement>(null);
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
 const browse=()=>{close();if(folder)openFilesTab(folder.id,folder.name);else void pickFolder();};
 return <div className="work-controls" ref={root} onBlur={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setOpen(false);}}>
  <button ref={trigger} className="icon-button" aria-label="Conversation actions" title="Conversation actions" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><MoreHorizontal size={17}/></button>
  <button className="icon-button" aria-label={!state.resourcesHidden?'Hide resource pane':'Show resource pane'} title={!state.resourcesHidden?'Hide resource pane':'Show resource pane'} aria-pressed={!state.resourcesHidden} onClick={()=>{transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));}}><PanelRight size={16}/></button>
  {<div hidden={!open} className="work-actions" data-native-preview-overlay role="group" aria-label="Conversation actions">
   <WorkspaceOverview compact onNavigate={()=>close()}/>
   <button onClick={browse}><Files size={14}/>{folder?'Files and changes':'Open folder…'}</button>
   {<button onClick={()=>{transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));close(true);}}><PanelRight size={14}/>{state.resourcesHidden?'Show resources':'Hide resources'}</button>}
   {chat&&<button onClick={()=>{void updateChat(chat.id,{pinned:!chat.pinned});close(true);}}><Pin size={14}/>{chat.pinned?'Unpin chat':'Pin chat'}</button>}
  </div>}
 </div>;
}
