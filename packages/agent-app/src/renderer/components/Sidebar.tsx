import {
  Archive,
  ArchiveRestore,
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
} from 'lucide-react';
import {Collapsible} from '@base-ui/react/collapsible';
import React, { useEffect, useRef, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import {
  createChat,
  openFilesTab,
  openProvidersTab,
  openProjectsScreen,
  pickFolder,
  selectChat,
  movePin,
  updateChat,
} from '../store';
import { useStore } from '../useStore';
import { focusComposer, isChord, restoreFocus } from '../focus';
import { readCollapsed, saveCollapsed } from '../sidebarDisclosure';
import { StatusDot } from './StatusDot';
import './sidebar-disclosure.css';

function chatOrder(a: Chat, b: Chat): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  if (a.pinned && b.pinned) {
    // Legacy pins may lack pinOrder; sink them below explicitly ordered pins.
    if ((a.pinOrder === undefined) !== (b.pinOrder === undefined)) return a.pinOrder === undefined ? 1 : -1;
    if (a.pinOrder !== undefined && b.pinOrder !== undefined && a.pinOrder !== b.pinOrder) return a.pinOrder - b.pinOrder;
  }
  return b.updatedAt.localeCompare(a.updatedAt);
}

function ChatRow({ chat }: { chat: Chat }): React.ReactElement {
  const state = useStore();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(chat.title);
  const active = state.activeChatId === chat.id;

  const commitRename = () => {
    setRenaming(false);
    const next = title.trim();
    if (next && next !== chat.title) void updateChat(chat.id, { title: next });
    else setTitle(chat.title);
  };

  return (
    <div className={`chat-row${active ? ' is-active' : ''}`}>
      {renaming ? (
        <input
          className="chat-rename"
          value={title}
          autoFocus
          aria-label="Chat title"
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commitRename}
          onKeyDown={(e) => {
            if (e.key === 'Enter') commitRename();
            else if (e.key === 'Escape') {
              setTitle(chat.title);
              setRenaming(false);
            }
          }}
        />
      ) : (
        <button
          type="button"
          className="chat-row-main"
          onClick={() => void selectChat(chat.id)}
          onDoubleClick={() => setRenaming(true)}
        >
          <StatusDot status={chat.status} />
          <span className="chat-title" title={chat.title}>
            {chat.title}
          </span>
          {chat.draft && <span className="chat-draft-dot" title="Unsent draft" />}
        </button>
      )}
      <span className="chat-row-actions">
        {chat.pinned && (
          <>
            <button
              type="button"
              className="icon-button"
              aria-label="Move pin up"
              onClick={() => void movePin(chat.id, 'up')}
            >
              <ChevronUp size={13} />
            </button>
            <button
              type="button"
              className="icon-button"
              aria-label="Move pin down"
              onClick={() => void movePin(chat.id, 'down')}
            >
              <ChevronDown size={13} />
            </button>
          </>
        )}
        <button
          type="button"
          className="icon-button"
          aria-label={chat.pinned ? 'Unpin chat' : 'Pin chat'}
          onClick={() => void updateChat(chat.id, { pinned: !chat.pinned })}
        >
          {chat.pinned ? <PinOff size={13} /> : <Pin size={13} />}
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Rename chat"
          onClick={() => setRenaming(true)}
        >
          <Pencil size={13} />
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label={chat.archived ? 'Restore chat' : 'Archive chat'}
          onClick={() => void updateChat(chat.id, { archived: !chat.archived })}
        >
          {chat.archived ? <ArchiveRestore size={13} /> : <Archive size={13} />}
        </button>
      </span>
    </div>
  );
}

function GroupHead({ title, tooltip, children }: {
  title: string;
  tooltip?: string;
  children?: React.ReactNode;
}): React.ReactElement {
  return (
    <header className="nav-section-head">
      <Collapsible.Trigger className="nav-disclosure">
        <ChevronRight size={13} className="nav-chevron"/>
        <span className="nav-section-title" title={tooltip ?? title}>
          {title}
        </span>
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
      <GroupHead title={folder.name} tooltip={folder.path}>
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
  const toggleGroup = (id: string, open: boolean) => {
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (open) next.delete(id); else next.add(id);
      return next;
    });
  };
  const isOpen = (id: string) => (searching && query.trim() !== '') || !collapsed.has(id);
  const snapshot = state.snapshot;

  if (!snapshot) {
    return <div className="nav-empty">Loading…</div>;
  }

  const matches = (c: Chat) => !query.trim() || c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const live = snapshot.chats.filter((c) => !c.archived && matches(c)).sort(chatOrder);
  const archived = snapshot.chats.filter((c) => c.archived && matches(c)).sort(chatOrder);
  const pinned = live.filter((c) => c.pinned);
  const unpinned = live.filter((c) => !c.pinned);
  const orphanChats = unpinned.filter(
    (c) => !c.folderId || !snapshot.folders.some((f) => f.id === c.folderId),
  );

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
        {searching && query.trim() !== '' && live.length === 0 && <p className="nav-empty" role="status">No chats match “{query.trim()}”.</p>}
        <button type="button" className="tool-button" onClick={openProjectsScreen}>
          <Layers size={15} /><span>Projects</span>
        </button>
      </div>
      <div className="nav-folders-head">
        <span>Folders</span>
        <button type="button" className="tool-button" onClick={() => void pickFolder()}>
          <FolderPlus size={14} />
          <span>Add folder</span>
        </button>
      </div>
      <div className="nav-scroll">
        {pinned.length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('pinned')} onOpenChange={value=>toggleGroup('pinned',value)}>
            <GroupHead title="Pinned" />
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
              <GroupHead title={project.name} tooltip={project.goal}>
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
            chats={unpinned.filter((c) => c.folderId === folder.id && !c.projectId)}
            open={isOpen(`folder:${folder.id}`)}
            onToggle={toggleGroup}
          />
        ))}
        {orphanChats.filter((c) => !c.projectId).length > 0 && (
          <Collapsible.Root className="nav-section" open={isOpen('chats')} onOpenChange={value=>toggleGroup('chats',value)}>
            <GroupHead title="Chats" />
            <Collapsible.Panel className="nav-group-panel">{orphanChats
              .filter((c) => !c.projectId)
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
          <Collapsible.Root className="nav-section" open={showArchived} onOpenChange={setShowArchived}>
            <header className="nav-section-head"><Collapsible.Trigger className="nav-disclosure"><ChevronRight size={13} className="nav-chevron"/><span className="nav-section-title">Archived ({archived.length})</span></Collapsible.Trigger></header>
            <Collapsible.Panel className="nav-group-panel">{archived.map((chat) => <ChatRow key={chat.id} chat={chat} />)}</Collapsible.Panel>
          </Collapsible.Root>
        )}
      </div>
      <footer className="nav-footer">
        <button type="button" className="tool-button" onClick={openProvidersTab}>
          <Settings2 size={15} /><span>Providers</span>
        </button>
        <span className="nav-footer-label">Muster</span>
      </footer>
    </div>
  );
}
