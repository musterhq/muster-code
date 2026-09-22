import {
  Archive,
  Brain,
  Blocks,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  FolderPlus,
  Layers,
  KeyRound,
  MessageSquarePlus,
  Pin,
  Search,
  Settings2,
  MoreHorizontal,
  ArrowDownWideNarrow,
  Check,
  MessageCircle,
} from 'lucide-react';
import {Collapsible} from '@base-ui/react/collapsible';
import {Menu} from '@base-ui/react/menu';
import {PreviewCard} from '@base-ui/react/preview-card';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import {
  createChat,
  openFilesTab,
  openProvidersTab,
  openPluginsScreen,
  openProjectsScreen,
  openMemoryScreen,
  openProcessesTab,
  pickFolder,
  selectChat,
  movePin,
  updateChat,
  notifyError,
  notifySuccess,
} from '../store';
import { useStore } from '../useStore';
import { focusComposer, isChord, restoreFocus } from '../focus';
import { readCollapsed, saveCollapsed } from '../sidebarDisclosure';
import { StatusDot } from './StatusDot';
import {chatGroup,compareChats,isChatRunning,isChatSort,readChatSort,saveChatSort,selectionReveal,type ChatSort} from '../chatNavigation';
import './sidebar-disclosure.css';
import {useProcessSummary} from '../processSummary';
import {isActiveProcess} from '../../shared/process-protocol';
import {invoke} from '../bridge';

function ChatRow({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const {summary: processSummary} = useProcessSummary();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [renameError,setRenameError]=useState('');
  const [renameBusy,setRenameBusy]=useState(false);
  const rowButton=useRef<HTMLElement|null>(null),renameInput=useRef<HTMLInputElement>(null);
  const renameCancelled=useRef(false),renamePending=useRef(false);
  const active = state.activeChatId === chat.id;
  const activeProcesses = processSummary?.sessions.filter(session => session.chatId === chat.id && isActiveProcess(session.status)).length ?? 0;
  const pendingAttention = state.snapshot?.attention?.chats.find(item => item.chatId === chat.id)?.requests.length ?? 0;
  const folder=state.snapshot?.folders.find(item=>item.id===chat.folderId);
  const updated=relativeTime(chat.updatedAt);
  const copyLocalLink=async()=>{try{await invoke('clipboard.write',{text:`muster://chat/${encodeURIComponent(chat.id)}`});notifySuccess('Local chat link copied');}catch(error){notifyError(error);}};

  const showNativeMenu=async(x:number,y:number)=>{
    try {
      const action=await invoke('chat.contextMenu',{id:chat.id,x,y});
      if(action==='pin')await updateChat(chat.id,{pinned:!chat.pinned});
      else if(action==='rename')beginRename();
      else if(action==='activity')openProcessesTab(chat.id,chat.title);
      else if(action==='files'&&folder)openFilesTab(folder.id,folder.name);
      else if(action==='copy-link')await copyLocalLink();
      else if(action==='pin-up')await movePin(chat.id,'up');
      else if(action==='pin-down')await movePin(chat.id,'down');
      else if(action==='archive')await updateChat(chat.id,{archived:!chat.archived});
    } catch(error) { notifyError(error); }
  };
  const openNativeMenuAtPointer=(event:React.MouseEvent<HTMLButtonElement>)=>{
    event.preventDefault();event.stopPropagation();
    const rect=event.currentTarget.getBoundingClientRect();
    void showNativeMenu(rect.right,rect.bottom);
  };

  const beginRename=()=>{renameCancelled.current=false;setTitle(chat.title);setRenameError('');setRenaming(true);};
  const finishRename=()=>{renameCancelled.current=true;setRenaming(false);requestAnimationFrame(()=>rowButton.current?.focus());};
  const commitRename = async () => {
    if(renamePending.current||renameCancelled.current)return;
    const next = title.trim();
    if(!next){setRenameError('Enter a chat title.');renameInput.current?.focus();return;}
    if(next===chat.title){finishRename();return;}
    renamePending.current=true;setRenameBusy(true);
    try {if(await updateChat(chat.id,{title:next}))finishRename();else {setRenameError('The title was not saved. Try again.');renameInput.current?.focus();}}
    finally {renamePending.current=false;setRenameBusy(false);}
  };
  return (
    <PreviewCard.Root><div className={`chat-row${active ? ' is-active' : ''}`} data-chat-id={chat.id} data-running={isChatRunning(chat)||undefined} onContextMenu={event=>{event.preventDefault();void showNativeMenu(event.clientX,event.clientY);}}>
      {renaming ? (
        <input
          ref={renameInput}
          className="chat-rename"
          value={title}
          autoFocus
          disabled={renameBusy}
          maxLength={256}
          aria-invalid={!!renameError}
          aria-label="Chat title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={()=>void commitRename()}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {e.preventDefault();void commitRename();}
            else if (e.key === 'Escape') {
              e.preventDefault();setTitle(chat.title);finishRename();
            }
          }}
        />
      ) : (
        <PreviewCard.Trigger
          ref={(element:HTMLAnchorElement|null)=>{rowButton.current=element;}}
          render={<button/>}
          type="button"
          className="chat-row-main"
          delay={520}
          closeDelay={80}
          aria-current={active?'page':undefined}
          onKeyDown={event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();const rect=event.currentTarget.getBoundingClientRect();void showNativeMenu(rect.left,rect.bottom);}}}
          onClick={() => { if(state.activeChatId!==chat.id)void selectChat(chat.id); }}
        >
          <StatusDot status={chat.status} />
          <span className="chat-title" title={chat.title}>
            {chat.title}
          </span>
          {(activeProcesses > 0 || pendingAttention > 0) && <span className="chat-row-status" aria-label={[activeProcesses ? `${activeProcesses} local command${activeProcesses === 1 ? '' : 's'} running` : '', pendingAttention ? `${pendingAttention} request${pendingAttention === 1 ? '' : 's'} need input` : ''].filter(Boolean).join(', ')} title={[activeProcesses ? `${activeProcesses} running` : '', pendingAttention ? `${pendingAttention} need input` : ''].filter(Boolean).join(' · ')}>
            {activeProcesses > 0 && <span className="chat-running-badge" aria-hidden="true">{activeProcesses}</span>}
            {pendingAttention > 0 && <span className="chat-attention-badge" aria-hidden="true">{pendingAttention}</span>}
          </span>}
          {chat.draft && <span className="chat-draft-dot" title="Unsent draft" />}
        </PreviewCard.Trigger>
      )}
      {renameError&&renaming&&<span className="chat-rename-error" role="alert">{renameError}</span>}
      {!renaming&&<span className="chat-row-actions"><button type="button" className="icon-button" aria-label={`Actions for ${chat.title}`} onClick={openNativeMenuAtPointer}><MoreHorizontal size={15}/></button></span>}
    </div>
    {!renaming&&<PreviewCard.Portal><PreviewCard.Positioner side="right" align="start" sideOffset={8} className="chat-preview-positioner"><PreviewCard.Popup className="chat-preview-card">
      <div className="chat-preview-title"><span>{chat.title}</span><StatusDot status={chat.status} showLabel={isChatRunning(chat)}/></div>
      <div className="chat-preview-meta"><span>{folder?.name??'Personal chat'}</span><span>{updated}</span></div>
      {(activeProcesses>0||pendingAttention>0)&&<div className="chat-preview-activity">{activeProcesses>0&&<span>{activeProcesses} command{activeProcesses===1?'':'s'} running</span>}{pendingAttention>0&&<span>{pendingAttention} request{pendingAttention===1?'':'s'} need input</span>}</div>}
    </PreviewCard.Popup></PreviewCard.Positioner></PreviewCard.Portal>}
    </PreviewCard.Root>
  );
}

function relativeTime(value:string):string {
  const timestamp=new Date(value).getTime();
  if(!Number.isFinite(timestamp))return 'Updated recently';
  const elapsed=Math.max(0,Date.now()-timestamp);
  const minutes=Math.floor(elapsed/60000);
  if(minutes<1)return 'Updated now';
  if(minutes<60)return `Updated ${minutes}m ago`;
  const hours=Math.floor(minutes/60);
  if(hours<24)return `Updated ${hours}h ago`;
  return `Updated ${Math.floor(hours/24)}d ago`;
}

function GroupHead({ title, tooltip, chats=[], children, icon }: {
  title: string;
  tooltip?: string;
  chats?: Chat[];
  children?: React.ReactNode;
  icon?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="nav-section-head">
      <Collapsible.Trigger className="nav-disclosure">
        <ChevronRight size={13} className="nav-chevron"/>
        {icon&&<span className="nav-section-icon" aria-hidden="true">{icon}</span>}
        <span className="nav-section-title" title={tooltip ?? title}>
          {title}
        </span>
        {chats.some(isChatRunning)&&<span className="nav-running-count" title={`${chats.filter(isChatRunning).length} working or stopping`} aria-label={`${chats.filter(isChatRunning).length} active chats`}>{chats.filter(isChatRunning).length}</span>}
      </Collapsible.Trigger>
      {children && <span className="nav-section-actions">{children}</span>}
    </header>
  );
}

function FolderSection({ folder, chats, open, onToggle }: {
  folder: Folder;
  chats: Chat[];
  open: boolean;
  onToggle: (id: string, open: boolean) => void;
}): React.ReactElement {
  return (
    <Collapsible.Root className="nav-section" open={open} onOpenChange={value=>onToggle(`folder:${folder.id}`,value)}>
      <GroupHead title={folder.name} tooltip={folder.path} chats={chats} icon={<FolderOpen size={12}/> }>
        <button
          type="button"
          className="icon-button"
          aria-label={`Browse files in ${folder.name}`}
          onClick={() => openFilesTab(folder.id, folder.name)}
        >
          <FolderOpen size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={`New chat in ${folder.name}`}
          onClick={() => void createChat(folder.id)}
        >
          <MessageSquarePlus size={13} />
        </button>
      </GroupHead>
      <Collapsible.Panel className="nav-group-panel">{chats.map((chat) => (
        <ChatRow key={chat.id} chat={chat} />
      ))}</Collapsible.Panel>
    </Collapsible.Root>
  );
}

export function Sidebar(): React.ReactElement {
  const state = useStore();
  const [showArchived, setShowArchived] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [collapsed, setCollapsed] = useState(() => readCollapsed(localStorage));
  const [sort,setSort]=useState<ChatSort>(()=>readChatSort(localStorage));
  const nav=useRef<HTMLDivElement>(null);
  const lastSelection=useRef<string|null>(state.activeChatId),revealPending=useRef<string|null>(null);
  const snapshot = state.snapshot;

  useLayoutEffect(()=>{
    if(!snapshot)return;
    const reveal=selectionReveal(lastSelection.current,snapshot.chats.find(chat=>chat.id===state.activeChatId),snapshot);
    if(!reveal)return;
    lastSelection.current=reveal.id;revealPending.current=reveal.id;
    setQuery('');
    if(reveal.group==='archived')setShowArchived(true);
    else setCollapsed(previous=>{if(!previous.has(reveal.group))return previous;const next=new Set(previous);next.delete(reveal.group);return next;});
  },[state.activeChatId,snapshot]);
  useLayoutEffect(()=>{
    if(!revealPending.current)return;
    const selectedId=revealPending.current;
    const frame=requestAnimationFrame(()=>{
      const row=Array.from(nav.current?.querySelectorAll<HTMLElement>('[data-chat-id]')??[]).find(element=>element.dataset.chatId===selectedId);
      if(row){row.scrollIntoView?.({block:'nearest',inline:'nearest'});revealPending.current=null;}
    });
    return()=>cancelAnimationFrame(frame);
  });

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isChord(e, 'n')) {
        e.preventDefault();
        void createChat().then(() => focusComposer());
      } else if (isChord(e, 'k')) {
        e.preventDefault();
        setSearching(true);
        searchInput.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const closeSearch = (restore: boolean) => {
    setQuery('');
    setSearching(false);
    if (restore) restoreFocus(searchButton.current);
  };
  useEffect(() => { saveCollapsed(localStorage, collapsed); }, [collapsed]);
  useEffect(()=>{saveChatSort(localStorage,sort);},[sort]);
  const toggleGroup = (id: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id); else next.add(id);
      return next;
    });
  };
  const isOpen = (id: string) => (searching && query.trim() !== '') || !collapsed.has(id);

  if (!snapshot) {
    return <div className="nav-empty">Loading…</div>;
  }

  const matches = (c: Chat) => !query.trim() || c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const live = snapshot.chats.filter((c) => !c.archived && matches(c)).sort(compareChats(sort));
  const archived = snapshot.chats.filter((c) => c.archived && matches(c)).sort(compareChats(sort));
  const pinned = live.filter((c) => c.pinned);
  const unpinned = live.filter((c) => !c.pinned);
  const orphanChats = unpinned.filter(chat=>chatGroup(chat,snapshot)==='chats');

  return (
    <div className="nav-inner">
      <div className="nav-toolbar">
        <button type="button" className="tool-button" onClick={() => void createChat().then(() => focusComposer())}>
          <MessageSquarePlus size={15} /><span>New chat</span>
        </button>
        <button ref={searchButton} type="button" className="tool-button" onClick={() => (searching ? closeSearch(false) : setSearching(true))} aria-expanded={searching}>
          <Search size={15} /><span>Search chats</span>
        </button>
        {searching && <input ref={searchInput} autoFocus className="nav-search" aria-label="Search chats" placeholder="Search chats…" value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{if(e.key==='Escape'){e.stopPropagation();closeSearch(true);}}} />}
        {searching && query.trim() !== '' && live.length === 0 && archived.length===0 && <p className="nav-empty" role="status">No chats match “{query.trim()}”.</p>}
        <button type="button" className="tool-button" onClick={openProjectsScreen}>
          <Layers size={15} /><span>Projects</span>
        </button>
      </div>
      <button type="button" className="tool-button" onClick={() => openMemoryScreen(state.snapshot?.chats.find(c => c.id === state.activeChatId)?.folderId)}><Brain size={15}/><span>Memory</span></button>
      <div className="nav-folders-head">
        <span>Folders</span>
        <Menu.Root><Menu.Trigger className="icon-button nav-sort-trigger" aria-label="Sort chats" title={`Sort chats: ${sort==='recent'?'Recent activity':sort==='name'?'Name':'Active first'}`}><ArrowDownWideNarrow size={14}/></Menu.Trigger><Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="chat-menu-positioner"><Menu.Popup className="chat-menu"><Menu.RadioGroup value={sort} onValueChange={value=>{if(isChatSort(value))setSort(value);}}>{([['recent','Recent activity'],['name','Name'],['active','Active first']] as const).map(([value,label])=><Menu.RadioItem key={value} value={value}><span className="chat-sort-check">{sort===value&&<Check size={14}/>}</span><span>{label}</span></Menu.RadioItem>)}</Menu.RadioGroup></Menu.Popup></Menu.Positioner></Menu.Portal></Menu.Root>
        <button type="button" className="tool-button" onClick={() => void pickFolder()}>
          <FolderPlus size={14} />
          <span>Add folder</span>
        </button>
      </div>
      <div className="nav-scroll" ref={nav} tabIndex={-1}>
        {pinned.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('pinned')} onOpenChange={value=>toggleGroup('pinned',value)}>
            <GroupHead title="Pinned" chats={pinned} icon={<Pin size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel">{pinned.map((chat) => (
              <ChatRow key={chat.id} chat={chat} />
            ))}</Collapsible.Panel>
          </Collapsible.Root>
        )}
        {snapshot.projects.map((project) => {
          const chats = unpinned.filter((c) => c.projectId === project.id);
          const gid = `project:${project.id}`;
          return (
            <Collapsible.Root className="nav-section" key={project.id} open={isOpen(gid)} onOpenChange={value=>toggleGroup(gid,value)}>
              <GroupHead title={project.name} tooltip={project.goal} chats={chats} icon={<Layers size={12}/> }>
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`New chat in project ${project.name}`}
                  onClick={() => project.folderIds.length === 1
                    ? void createChat(project.folderIds[0], project.id)
                    : openProjectsScreen()}
                >
                  <MessageSquarePlus size={13} />
                </button>
              </GroupHead>
              <Collapsible.Panel className="nav-group-panel">{chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} />
              ))}</Collapsible.Panel>
            </Collapsible.Root>
          );
        })}
        {snapshot.folders.map((folder) => (
          <FolderSection
            key={folder.id}
            folder={folder}
            chats={unpinned.filter(chat=>chatGroup(chat,snapshot)===`folder:${folder.id}`)}
            open={isOpen(`folder:${folder.id}`)}
            onToggle={toggleGroup}
          />
        ))}
        {orphanChats.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('chats')} onOpenChange={value=>toggleGroup('chats',value)}>
            <GroupHead title="Chats" chats={orphanChats} icon={<MessageCircle size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel">{orphanChats
              .map((chat) => (
                <ChatRow key={chat.id} chat={chat} />
              ))}</Collapsible.Panel>
          </Collapsible.Root>
        )}
        {snapshot.folders.length === 0 && live.length === 0 && (
          <div className="nav-empty">
            <p>No folders yet.</p>
            <p>Add a folder to start a chat grounded in real files.</p>
          </div>
        )}
        {archived.length > 0 && (
          <Collapsible.Root className="nav-section" open={showArchived||(searching&&query.trim()!=='')} onOpenChange={setShowArchived}>
            <GroupHead title={`Archived (${archived.length})`} chats={archived} icon={<Archive size={12}/>}/>
            <Collapsible.Panel className="nav-group-panel">{archived.map((chat) => <ChatRow key={chat.id} chat={chat} />)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
      </div>
      <footer className="nav-footer">
        <button type="button" className="nav-footer-action" onClick={()=>openPluginsScreen('skills')}>
          <Blocks size={15} aria-hidden="true"/><span>Skills &amp; plugins</span>
        </button>
        <button type="button" className="nav-footer-action" onClick={openProvidersTab}>
          <Settings2 size={15} aria-hidden="true"/><span>Accounts &amp; providers</span>
        </button>
      </footer>
    </div>
  );
}
