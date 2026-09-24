import {transitionLayout} from '../layoutMotion';
import React, {useEffect,useRef,useState,useSyncExternalStore} from 'react';
import {Check,GitBranch,ListTodo,LoaderCircle,MoreHorizontal,PanelBottom,PanelRight,Share2,X} from 'lucide-react';
import {forkChat} from '../messageActions';
import {getState,activeChat,setResourcesHidden,toggleSummary,updateChat,notifyError} from '../store';
import {openChatMenu} from '../chatMenu';
import {useNewChatDraft} from '../newChatDraft';
import {useStore} from '../useStore';
import {invoke} from '../bridge';
import './work-controls.css';
import {PendingAttention} from './PendingAttention';
import {Tip} from './Tooltip';
import {toggleTerminal} from './ProcessesTab';
import {subscribeTerminalDock,terminalDock} from '../processSummary';

const MAC=typeof navigator!=='undefined'&&/Mac/.test(navigator.platform);

/** Header toggle for the conversation's terminal: the bottom panel by default, or the right-pane Terminal tab
 * when Settings › "Default terminal location" is Right. Same action as ⌘J and ⌃`. */
function TerminalToggle({chatId,title}:{chatId:string;title:string}){
 const dock=useSyncExternalStore(subscribeTerminalDock,terminalDock);
 const open=dock.placement==='panel'&&dock.open,label=open?'Hide terminal':'Show terminal';
 return <Tip label={label} shortcut={MAC?'⌘J':'Ctrl+J'}><button className="icon-button" aria-label={label} aria-pressed={dock.placement==='panel'?open:undefined} onClick={()=>toggleTerminal(chatId,title)}><PanelBottom size={16}/></button></Tip>;
}

/**
 * Header entry to the summary card: the only control that hides or shows it, at every width. The card
 * itself carries its own collapse-to-pill chevron (with this chat's change stats) when it has to sit
 * over the transcript, so the header no longer doubles as a pill.
 */
function SummaryToggle(){
 const state=useStore();
 const shown=!state.summaryHidden;
 const label=shown?'Hide summary':'Show summary';
 return <Tip label={label}><button className="icon-button summary-toggle" aria-label={label} aria-pressed={shown} onClick={toggleSummary}>
  <ListTodo size={16}/>
 </button></Tip>;
}

/** Always reachable from the conversation, including with the resource pane hidden. The ⋯ menu is the same native
 *  menu as the sidebar row (plus Open Terminal and Open in Finder), so the two surfaces never drift. */
export function WorkControls(){
 // UX-24: same reasoning as SummaryToggle — a draft in progress is not "this chat" yet, so Copy link,
 // Fork, Rename and the ⋯ menu must not bind to whatever chat was active before New chat was opened.
 const state=useStore(),draft=useNewChatDraft(),chat=draft.open?null:activeChat();
 const [menuOpen,setMenuOpen]=useState(false);
 const [forking,setForking]=useState(false);
 const [renaming,setRenaming]=useState(false),[title,setTitle]=useState(''),[notice,setNotice]=useState('');
 const trigger=useRef<HTMLButtonElement>(null),renameInput=useRef<HTMLInputElement>(null);
 useEffect(()=>{if(renaming)requestAnimationFrame(()=>renameInput.current?.select());},[renaming]);
 useEffect(()=>{setRenaming(false);},[chat?.id]);
 // F25: publish the controls' real width so the header reserves exactly that much room; the title and
 // folder chip then ellipsize before them instead of sliding underneath (a fixed guess broke whenever
 // PendingAttention or another control joined the row).
 const root=useRef<HTMLDivElement>(null);
 useEffect(()=>{
  const element=root.current,center=element?.parentElement;
  if(!element||!center)return;
  const apply=()=>{center.style.setProperty('--work-controls-width',`${Math.ceil(element.getBoundingClientRect().width)}px`);center.dataset.workControls='measured';};
  apply();
  const observer=typeof ResizeObserver==='undefined'?undefined:new ResizeObserver(apply);
  observer?.observe(element);
  return()=>{observer?.disconnect();center.style.removeProperty('--work-controls-width');delete center.dataset.workControls;};
 },[]);
 const copyLink=async()=>{if(!chat)return;try{await invoke('clipboard.write',{text:`muster://chat/${encodeURIComponent(chat.id)}`});setNotice('Local chat link copied');setTimeout(()=>setNotice(''),2200);}catch(error){notifyError(error);}};
 /** Branch the whole conversation into a new chat (Codex ⋯ › Fork); per-message forks live on each message. */
 const fork=async()=>{if(!chat||forking)return;setForking(true);try{await forkChat(chat.id);}finally{setForking(false);}};
 const beginRename=()=>{if(!chat)return;setTitle(chat.title);setRenaming(true);};
 const openMenu=async()=>{
  if(!chat||!trigger.current||menuOpen)return;
  const rect=trigger.current.getBoundingClientRect();
  setMenuOpen(true);
  try{await openChatMenu(chat,rect.left,rect.bottom+4,'header',beginRename);}finally{setMenuOpen(false);if(!renaming&&document.activeElement===document.body)trigger.current?.focus();}
 };
 const saveRename=async()=>{if(!chat)return;const next=title.trim();if(!next){renameInput.current?.focus();return;}try{if(await updateChat(chat.id,{title:next}))setRenaming(false);}catch(error){notifyError(error);}};
 return <div ref={root} className="work-controls">
  <PendingAttention/>
  {notice&&<span className="work-control-notice" role="status">{notice}</span>}
  {chat&&<Tip label="Copy local chat link"><button className="icon-button" aria-label="Copy local chat link" aria-description="Opens this chat on this Mac; use Conversation actions › Export Conversation… to share with someone else" onClick={()=>void copyLink()}><Share2 size={16}/></button></Tip>}
  {chat&&<SummaryToggle/>}
  {chat&&<Tip label="Fork into a new chat" disabledReason="Forking…"><button className="icon-button" aria-label="Fork conversation" disabled={forking} aria-busy={forking||undefined} onClick={()=>void fork()}>{forking?<LoaderCircle size={16}/>:<GitBranch size={16}/>}</button></Tip>}
  {chat&&<Tip label="Conversation actions"><button ref={trigger} className="icon-button" aria-label="Conversation actions" aria-haspopup="menu" aria-expanded={menuOpen} onClick={()=>void openMenu()} onKeyDown={event=>{if(event.key==='ArrowDown'){event.preventDefault();void openMenu();}}}><MoreHorizontal size={17}/></button></Tip>}
  {chat&&<TerminalToggle chatId={chat.id} title={chat.title}/>}
  <Tip label={state.resourcesHidden?'Show resource pane':'Hide resource pane'}><button className="icon-button" aria-label={state.resourcesHidden?'Show resource pane':'Hide resource pane'} aria-pressed={!state.resourcesHidden} onClick={()=>{transitionLayout(()=>setResourcesHidden(!getState().resourcesHidden));}}><PanelRight size={16}/></button></Tip>
  {renaming&&<form className="work-rename" onSubmit={event=>{event.preventDefault();void saveRename();}} data-native-preview-overlay>
   <label htmlFor="work-rename-title">Rename chat</label>
   <div><input ref={renameInput} id="work-rename-title" value={title} maxLength={256} onChange={event=>setTitle(event.target.value)} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();setRenaming(false);trigger.current?.focus();}}}/><button type="button" className="icon-button" aria-label="Cancel rename" onClick={()=>setRenaming(false)}><X size={14}/></button><button type="submit" className="icon-button" aria-label="Save chat name"><Check size={14}/></button></div>
  </form>}
 </div>;
}
