import {
  Archive,
  ArchiveRestore,
  FolderOpen,
  FolderPlus,
  KeyRound,
  MessageSquarePlus,
  Pencil,
  Pin,
  PinOff,
} from 'lucide-react';
import React, { useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import {
  createChat,
  openFilesTab,
  openProvidersTab,
  pickFolder,
  selectChat,
  updateChat,
} from '../store';
import { useStore } from '../useStore';
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
  const snapshot = state.snapshot;

  if (!snapshot) {
    return <div className="nav-empty">Loading…</div>;
  }

  const live = snapshot.chats.filter((c) => !c.archived).sort(chatOrder);
  const archived = snapshot.chats.filter((c) => c.archived).sort(chatOrder);
  const orphanChats = live.filter(
    (c) => !c.folderId || !snapshot.folders.some((f) => f.id === c.folderId),
  );

  return (
    <div className="nav-inner">
      <div className="nav-toolbar">
        <button type="button" className="tool-button" onClick={() => void pickFolder()}>
          <FolderPlus size={14} />
          <span>Add folder</span>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-label="Providers"
          onClick={openProvidersTab}
        >
          <KeyRound size={14} />
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
                  onClick={() => void createChat(undefined, project.id)}
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
    </div>
  );
}
