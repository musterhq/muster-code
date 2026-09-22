import {
  Archive,
  ArchiveRestore,
  Brain,
  Blocks,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  FolderOpen,
  FolderPlus,
  Layers,
  KeyRound,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
  Search,
  Settings2,
  MoreHorizontal,
  ArrowDownWideNarrow,
  Check,
} from 'lucide-react';
import {Collapsible} from '@base-ui/react/collapsible';
import {Menu} from '@base-ui/react/menu';
import {ContextMenu} from '@base-ui/react/context-menu';
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import {
  createChat,
  openFilesTab,
  openProvidersTab,
  openPluginsScreen,
  openProjectsScreen,
  openMemoryScreen,
  pickFolder,
  selectChat,
  movePin,
  updateChat,
} from '../store';
import { useStore } from '../useStore';
import { focusComposer, isChord, restoreFocus } from '../focus';
import { readCollapsed, saveCollapsed } from '../sidebarDisclosure';
import { StatusDot } from './StatusDot';
import {chatGroup,compareChats,isChatRunning,isChatSort,readChatSort,saveChatSort,selectionReveal,type ChatSort} from '../chatNavigation';
import './sidebar-disclosure.css';
import {useProcessSummary} from '../processSummary';
import {isActiveProcess} from '../../shared/process-protocol';

function ChatRow({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const {summary: processSummary} = useProcessSummary();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const [renameError,setRenameError]=useState('');
  const [renameBusy,setRenameBusy]=useState(false);
  const [menuOpen,setMenuOpen]=useState(false);
  const rowButton=useRef<HTMLButtonElement>(null),moreButton=useRef<HTMLButtonElement>(null),renameInput=useRef<HTMLInputElement>(null);
  const renameCancelled=useRef(false),renamePending=useRef(false);
  const active = state.activeChatId === chat.id;
  const activeProcesses = processSummary?.sessions.filter(session => session.chatId === chat.id && isActiveProcess(session.status)).length ?? 0;
  const pendingAttention = state.snapshot?.attention?.chats.find(item => item.chatId === chat.id)?.requests.length ?? 0;

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
  const menuItems=()=> <>
    <Menu.Item onClick={()=>void updateChat(chat.id,{pinned:!chat.pinned})}>{chat.pinned?<PinOff size={14}/>:<Pin size={14}/>}<span>{chat.pinned?'Unpin chat':'Pin chat'}</span></Menu.Item>
    <Menu.Item onClick={beginRename}><Pencil size={14}/><span>Rename chat</span></Menu.Item>
    {chat.pinned&&!chat.archived&&<><Menu.Separator className="chat-menu-separator"/><Menu.Item onClick={()=>void movePin(chat.id,'up')}><ChevronUp size={14}/><span>Move pin up</span></Menu.Item><Menu.Item onClick={()=>void movePin(chat.id,'down')}><ChevronDown size={14}/><span>Move pin down</span></Menu.Item></>}
    <Menu.Separator className="chat-menu-separator"/>
    <Menu.Item onClick={()=>void updateChat(chat.id,{archived:!chat.archived})}>{chat.archived?<ArchiveRestore size={14}/>:<Archive size={14}/>}<span>{chat.archived?'Restore chat':'Archive chat'}</span></Menu.Item>
  </>;
  const finalFocus=()=>renameInput.current??rowButton.current??document.querySelector<HTMLElement>('.nav-scroll');

  return (
    <ContextMenu.Root><ContextMenu.Trigger className={`chat-row${active ? ' is-active' : ''}`} data-chat-id={chat.id} data-running={isChatRunning(chat)||undefined}>
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
        <button
          ref={rowButton}
          type="button"
          className="chat-row-main"
          aria-current={active?'page':undefined}
          onKeyDown={event=>{if(event.key==='ContextMenu'||(event.shiftKey&&event.key==='F10')){event.preventDefault();moreButton.current?.click();}}}
          onClick={() => void selectChat(chat.id)}
          onDoubleClick={beginRename}
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
        </button>
      )}
      {renameError&&renaming&&<span className="chat-rename-error" role="alert">{renameError}</span>}
      {!renaming&&<span className="chat-row-actions"><Menu.Root open={menuOpen} onOpenChange={setMenuOpen}>
        <Menu.Trigger ref={moreButton} className="icon-button" aria-label={`Actions for ${chat.title}`}><MoreHorizontal size={15}/></Menu.Trigger>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="chat-menu-positioner"><Menu.Popup className="chat-menu" finalFocus={finalFocus}>{menuItems()}</Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root></span>}
    </ContextMenu.Trigger><ContextMenu.Portal><ContextMenu.Positioner className="chat-menu-positioner"><ContextMenu.Popup className="chat-menu" finalFocus={finalFocus}>{menuItems()}</ContextMenu.Popup></ContextMenu.Positioner></ContextMenu.Portal></ContextMenu.Root>
  );
}

function GroupHead({ title, tooltip, chats=[], children }: {
  title: string;
  tooltip?: string;
  chats?: Chat[];
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="nav-section-head">
      <Collapsible.Trigger className="nav-disclosure">
        <ChevronRight size={13} className="nav-chevron"/>
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
      <GroupHead title={folder.name} tooltip={folder.path} chats={chats}>
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
            <GroupHead title="Pinned" chats={pinned}/>
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
              <GroupHead title={project.name} tooltip={project.goal} chats={chats}>
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
            <GroupHead title="Chats" chats={orphanChats}/>
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
            <GroupHead title={`Archived (${archived.length})`} chats={archived}/>
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
