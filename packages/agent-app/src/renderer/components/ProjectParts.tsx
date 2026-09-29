/**
 * Building blocks of a Muster project's page (#193), kept from the old project screen so nothing is lost: click-to-edit
 * text, the Folders section (link, make primary, remove, new chat per folder) and the Chats section (move/copy chats).
 */
import { Menu } from '@base-ui/react/menu';
import { FolderOpen, FolderPlus, MessageSquare, MoreHorizontal, Plus, SquarePen, Star, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Chat, Folder } from '../../shared/protocol';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { exactTime } from '../relativeTime.ts';
import { useStore } from '../useStore';
import { ChatTransferSheet, type ChatTransferRequest } from './ChatTransferSheet';
import { relativeTime } from './ProjectTasks';
import { ResourceState } from './ResourceState';
import { StatusDot } from './StatusDot';
import { Tip } from './Tooltip';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

/** Click-to-edit text. Enter (⌘Enter when multiline) or blur saves; Escape cancels without leaving the screen. */
export function InlineText({ value, label, placeholder, multiline, maxLength, className, startSignal, onSave }: { value: string; label: string; placeholder: string; multiline?: boolean; maxLength: number; className: string; startSignal?: number; onSave: (next: string) => Promise<void> }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  const display = useRef<HTMLButtonElement>(null);
  const cancelled = useRef(false);
  const begin = () => { setDraft(value); setError(''); cancelled.current = false; setEditing(true); };
  useEffect(() => { if (startSignal) begin(); }, [startSignal]);
  useEffect(() => { if (editing) { field.current?.focus(); field.current?.select(); } }, [editing]);
  const saving = useRef(false);
  async function commit() {
    if (cancelled.current || saving.current) return;
    const next = multiline ? draft : draft.trim();
    if (next === value) { setEditing(false); return; }
    saving.current = true; setBusy(true); setError('');
    try { await onSave(next); setEditing(false); requestAnimationFrame(() => display.current?.focus()); }
    catch (err) { setError(message(err, `Could not save the ${label.toLowerCase()}.`)); }
    finally { saving.current = false; setBusy(false); }
  }
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancelled.current = true; setEditing(false); setError(''); requestAnimationFrame(() => display.current?.focus()); }
    else if (e.key === 'Enter' && (!multiline || e.metaKey || e.ctrlKey)) { e.preventDefault(); void commit(); }
  };
  if (!editing) return <Tip label={`Edit ${label.toLowerCase()}`}><button ref={display} type="button" className={`project-inline ${className}${value ? '' : ' is-empty'}`} aria-label={`Edit ${label.toLowerCase()}`} onClick={begin}>{value || placeholder}</button></Tip>;
  return <div className={`project-inline-edit ${className}`}>
    {multiline ? <textarea ref={field} aria-label={label} rows={3} maxLength={maxLength} value={draft} disabled={busy} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={keys} onBlur={() => void commit()}/>
      : <input ref={field} aria-label={label} maxLength={maxLength} value={draft} disabled={busy} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={keys} onBlur={() => void commit()}/>}
    <span className="project-inline-hint">{error ? <span role="alert" className="settings-error">{error}</span> : multiline ? '⌘Enter to save · Esc to cancel' : 'Enter to save · Esc to cancel'}</span>
  </div>;
}

export function FoldersTab({ project, folders, allFolders, chats, highlight, onUpdated, onStartChat }: { project: ProjectDetails; folders: Folder[]; allFolders: Folder[]; chats: Chat[]; highlight: string | null; onUpdated: (p: ProjectDetails) => void; onStartChat: (folderId?: string) => void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState('');
  const available = allFolders.filter(f => !project.folderIds.includes(f.id));
  const [pick, setPick] = useState('');
  useEffect(() => { if (pick && !available.some(f => f.id === pick)) setPick(''); }, [available, pick]);
  const run = async (key: string, fn: () => Promise<ProjectDetails | null>) => {
    setBusy(key); setError('');
    try { const next = await fn(); if (next) onUpdated(next); }
    catch (err) { setError(message(err, 'Could not update the project folders.')); }
    finally { setBusy(null); }
  };
  const link = (folderId: string) => run('link', () => invoke('project.linkFolder', { id: project.id, folderId }));
  const browse = () => run('browse', async () => { const folder = await invoke('folder.pick', undefined); return folder ? invoke('project.linkFolder', { id: project.id, folderId: folder.id }) : null; });
  const runningIn = (folderId: string) => chats.find(c => c.folderId === folderId && (c.status === 'running' || c.status === 'stopping'));

  return <section aria-label="Folders" className="project-section">
    <p className="project-section-note">Chats and task runs work in one of these folders. The primary folder is the default for new chats.</p>
    {folders.length === 0 ? <p className="projects-empty">No folders linked. New chats use a private scratch folder, and tasks need a folder before they can run.</p>
      : <ul className="project-folder-list">{folders.map(f => { const busyChat = runningIn(f.id), primary = f.id === project.primaryFolderId; return <li key={f.id} data-ref={f.id} className={f.id === highlight ? 'is-highlighted' : undefined}>
        <FolderOpen size={15} aria-hidden="true"/>
        <span className="project-folder-text"><span className="project-folder-name">{f.name}{primary && <span className="project-badge">Primary</span>}</span><code>{f.path}</code></span>
        <span className="project-folder-actions">
          {!project.archived && <Tip label={`New chat in ${f.name}`}><button type="button" className="icon-button" aria-label={`New chat in ${f.name}`} onClick={() => onStartChat(f.id)}><SquarePen size={14}/></button></Tip>}
          {!primary && <Tip label="Make primary"><button type="button" className="icon-button" aria-label={`Make ${f.name} primary`} disabled={Boolean(busy)} onClick={() => void run(`primary:${f.id}`, () => invoke('project.update', { id: project.id, primaryFolderId: f.id }))}><Star size={14}/></button></Tip>}
          <Tip label={busyChat ? `"${busyChat.title}" is running here. Stop it first.` : 'Remove from project'}><button type="button" className="icon-button" aria-label={`Remove ${f.name} from project`} disabled={Boolean(busy) || Boolean(busyChat)} onClick={() => void run(`remove:${f.id}`, () => invoke('project.unlinkFolder', { id: project.id, folderId: f.id }))}><X size={14}/></button></Tip>
        </span>
      </li>; })}</ul>}
    <div className="project-folder-add">
      {available.length > 0 && <>
        <label className="sr-only" htmlFor="project-folder-pick">Folder to link</label>
        <select id="project-folder-pick" value={pick} onChange={e => setPick(e.target.value)} disabled={Boolean(busy)}>
          <option value="">Link an open folder…</option>
          {available.map(f => <option key={f.id} value={f.id}>{f.name} — {f.path}</option>)}
        </select>
        <button type="button" className="settings-button secondary" disabled={!pick || Boolean(busy)} onClick={() => void link(pick)}><Plus size={13}/>{busy === 'link' ? 'Linking…' : 'Link'}</button>
      </>}
      <button type="button" className="settings-button secondary" disabled={Boolean(busy)} onClick={() => void browse()}><FolderPlus size={13}/>{busy === 'browse' ? 'Choosing…' : 'Choose folder…'}</button>
    </div>
    {error && <p role="alert" className="settings-error">{error}</p>}
  </section>;
}

export function ChatsTab({ project, chats, folders, onOpenChat, onStartChat, onStatus }: { project: ProjectDetails; chats: Chat[]; folders: Folder[]; onOpenChat: (id: string) => void; onStartChat: (folderId?: string) => void; onStatus: (text: string) => void }) {
  const { snapshot } = useStore();
  const [transfer, setTransfer] = useState<ChatTransferRequest | null>(null);
  const sorted = [...chats].sort((a, b) => Number(a.archived) - Number(b.archived) || b.updatedAt.localeCompare(a.updatedAt));
  // PRJ-17: only chats outside this Project can be brought in; nothing joins automatically.
  const outside = (snapshot?.chats ?? []).filter(c => c.projectId !== project.id && !c.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const done = ({ mode, projectId }: { mode: 'move' | 'copy'; projectId: string | null }) => onStatus(projectId ? `Chat ${mode === 'copy' ? 'copied' : 'moved'} into ${project.name}.` : `Chat ${mode === 'copy' ? 'copied' : 'moved'} out of ${project.name}.`);
  return <section aria-label="Chats" className="project-section">
    {!project.archived && outside.length > 0 && <div className="project-section-toolbar"><button type="button" className="settings-button secondary" onClick={() => setTransfer({ projectId: project.id, mode: 'move', projectName: project.name })}><Plus size={13}/>Add an existing chat…</button></div>}
    {sorted.length === 0 ? <ResourceState kind="empty" message="No chats in this project yet. Project chats see the shared goal, instructions and decisions.">{!project.archived && <button type="button" className="settings-button" onClick={() => onStartChat(project.folderIds[0])}><MessageSquare size={13}/>Start a project chat</button>}</ResourceState>
      : <ul className="project-chat-rows is-full">{sorted.map(c => <li key={c.id} className="project-chat-row"><button type="button" onClick={() => onOpenChat(c.id)}>
        <StatusDot status={c.status}/><span className="project-chat-title">{c.title || 'Untitled chat'}</span>
        {c.archived && <span className="project-badge">Archived</span>}
        <span className="projects-item-meta" title={exactTime(c.updatedAt)}>{folders.find(f => f.id === c.folderId)?.name ?? 'Scratch'} · {relativeTime(c.updatedAt)}</span>
      </button>
      <Menu.Root>
        <Menu.Trigger className="icon-button project-chat-more" aria-label={`Actions for ${c.title || 'Untitled chat'}`}><MoreHorizontal size={14}/></Menu.Trigger>
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="project-menu-positioner"><Menu.Popup className="ui-menu project-menu">
          <Menu.Item onClick={() => setTransfer({ chatId: c.id, projectId: null, mode: 'move', projectName: project.name })}>Move out of project…</Menu.Item>
          <Menu.Item onClick={() => setTransfer({ chatId: c.id, projectId: null, mode: 'copy', projectName: project.name })}>Copy out of project…</Menu.Item>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root></li>)}</ul>}
    <ChatTransferSheet request={transfer} candidates={outside} onClose={() => setTransfer(null)} onDone={done}/>
  </section>;
}
