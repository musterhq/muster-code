import {
  Archive,
  ArchiveRestore,
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
import React, { useEffect, useRef, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import {
  createChat,
  openFilesTab,
  openProvidersTab,
  openProjectsScreen,
  pickFolder,
  selectChat,
  updateChat,
} from '../store';
import { useStore } from '../useStore';
import { focusComposer, isChord, restoreFocus } from '../focus';
import { StatusDot } from './StatusDot';

function chatOrder(a: Chat, b: Chat): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
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

function FolderSection({ folder, chats }: { folder: Folder; chats: Chat[] }): React.ReactElement {
  return (
    <section className="nav-section">
      <header className="nav-section-head">
        <span className="nav-section-title" title={folder.path}>
          {folder.name}
        </span>
        <span className="nav-section-actions">
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
        </span>
      </header>
      {chats.map((chat) => (
        <ChatRow key={chat.id} chat={chat} />
      ))}
    </section>
  );
}

export function Sidebar(): React.ReactElement {
  const state = useStore();
  const [showArchived, setShowArchived] = useState(false);
  const [searching, setSearching] = useState(false);
  const [query, setQuery] = useState('');
  const searchButton = useRef<HTMLButtonElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

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
  const snapshot = state.snapshot;

  if (!snapshot) {
    return <div className="nav-empty">Loading…</div>;
  }

  const matches = (c: Chat) => !query.trim() || c.title.toLocaleLowerCase().includes(query.trim().toLocaleLowerCase());
  const live = snapshot.chats.filter((c) => !c.archived && matches(c)).sort(chatOrder);
  const archived = snapshot.chats.filter((c) => c.archived).sort(chatOrder);
  const orphanChats = live.filter(
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
        {snapshot.projects.map((project) => {
          const chats = live.filter((c) => c.projectId === project.id);
          return (
            <section className="nav-section" key={project.id}>
              <header className="nav-section-head">
                <span className="nav-section-title nav-project" title={project.goal}>
                  {project.name}
                </span>
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
              </header>
              {chats.map((chat) => (
                <ChatRow key={chat.id} chat={chat} />
              ))}
            </section>
          );
        })}
        {snapshot.folders.map((folder) => (
          <FolderSection
            key={folder.id}
            folder={folder}
            chats={live.filter((c) => c.folderId === folder.id && !c.projectId)}
          />
        ))}
        {orphanChats.filter((c) => !c.projectId).length > 0 && (
          <section className="nav-section">
            <header className="nav-section-head">
              <span className="nav-section-title">Chats</span>
            </header>
            {orphanChats
              .filter((c) => !c.projectId)
              .map((chat) => (
                <ChatRow key={chat.id} chat={chat} />
              ))}
          </section>
        )}
        {snapshot.folders.length === 0 && live.length === 0 && (
          <div className="nav-empty">
            <p>No folders yet.</p>
            <p>Add a folder to start a chat grounded in real files.</p>
          </div>
        )}
        {archived.length > 0 && (
          <section className="nav-section">
            <header className="nav-section-head">
              <button
                type="button"
                className="nav-section-title nav-archived-toggle"
                aria-expanded={showArchived}
                onClick={() => setShowArchived((v) => !v)}
              >
                Archived ({archived.length})
              </button>
            </header>
            {showArchived && archived.map((chat) => <ChatRow key={chat.id} chat={chat} />)}
          </section>
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
