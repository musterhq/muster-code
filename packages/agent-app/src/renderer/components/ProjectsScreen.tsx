import { ArrowLeft, FolderOpen, MessageSquare, Plus, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Chat, Folder, Project } from '../../shared/protocol';
import { invoke } from '../bridge';
import { selectChat } from '../store';
import { restoreFocus } from '../focus';
import { useStore } from '../useStore';
import { ProjectTasks } from './ProjectTasks';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './projects-screen.css';

/** Bounded Projects surface. Parent owns routing (onBack) and chat handoff (onStartChat). */
export function ProjectsScreen({ onBack, onStartChat }: { onBack: () => void; onStartChat: (projectId: string, folderId?: string) => void }) {
  const { snapshot } = useStore();
  const [creating, setCreating] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); }, []);
  const leave = () => { onBack(); restoreFocus(launcher.current); };
  const closeForm = (restore: boolean) => { setCreating(false); if (restore) requestAnimationFrame(() => restoreFocus(newProjectButton.current)); };
  const projects = snapshot?.projects ?? [];
  const folders = snapshot?.folders ?? [];
  const chats = snapshot?.chats ?? [];
  const selected = projects.find(p => p.id === selectedId) ?? null;
  return <section className="settings-screen" aria-label="Projects" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented) { e.preventDefault(); leave(); } }}>
    <header className="settings-topbar"><button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to work</button><span>Projects</span></header>
    <div className="settings-scroll"><div className="settings-content">
      <div className="settings-title"><div><h1>Projects</h1><p>A project carries one shared goal across multiple folders. Ordinary folder chats stay scoped to a single folder with no shared goal.</p></div>
        {!creating && <button ref={newProjectButton} className="settings-button" onClick={() => { setCreating(true); }}><Plus size={14}/>New project</button>}</div>
      {creating && <NewProjectForm folders={folders} onClose={() => closeForm(true)} onCreated={p => { closeForm(false); setSelectedId(p.id); }}/>}
      {projects.length === 0 && !creating && <p className="projects-empty" role="status">No projects yet. Create one to share a goal across folders.</p>}
      {projects.length > 0 && <ul className="projects-list">{projects.map(p =>
        <li key={p.id}><button type="button" className={`projects-item${p.id === selectedId ? ' is-selected' : ''}`} aria-pressed={p.id === selectedId} onClick={() => setSelectedId(p.id === selectedId ? null : p.id)}>
          <span className="projects-item-name">{p.name}</span>
          <span className="projects-item-meta">{p.folderIds.length} {p.folderIds.length === 1 ? 'folder' : 'folders'} · {chats.filter(c => c.projectId === p.id).length} {chats.filter(c => c.projectId === p.id).length === 1 ? 'chat' : 'chats'}</span>
        </button></li>)}</ul>}
      {selected && <ProjectOverview project={selected} folders={folders} chats={chats.filter(c => c.projectId === selected.id)} onStartChat={onStartChat} onOpenChat={id => { void selectChat(id); onBack(); }}/>}
    </div></div>
  </section>;
}

function NewProjectForm({ folders, onClose, onCreated }: { folders: Folder[]; onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => first.current?.focus(), []);
  function toggle(id: string) { setFolderIds(ids => ids.includes(id) ? ids.filter(f => f !== id) : [...ids, id]); }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setError(''); setBusy(true);
    try { onCreated(await invoke('project.create', { name: name.trim(), goal: goal.trim(), folderIds })); }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not create the project.'); }
    finally { setBusy(false); }
  }
  return <form className="new-project" onSubmit={e => void submit(e)} aria-label="New project" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h2>New project</h2><button type="button" className="icon-button" aria-label="Cancel new project" disabled={busy} onClick={onClose}><X size={16}/></button></header>
    <label>Name<input ref={first} required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="My project" disabled={busy}/></label>
    <label>Shared goal <span className="optional">shown to every chat in the project</span><textarea rows={3} maxLength={4000} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should this project achieve?" disabled={busy}/></label>
    <fieldset className="projects-folder-picker" disabled={busy}><legend>Attached folders <span className="optional">optional — a project can start empty</span></legend>
      {folders.length === 0 && <p className="field-help">No folders are open yet. Add a folder from the sidebar before creating a project with files.</p>}
      {folders.map(f => <label key={f.id} className="projects-folder-option"><input type="checkbox" checked={folderIds.includes(f.id)} onChange={() => toggle(f.id)}/><span>{f.name}</span><code>{f.path}</code></label>)}
    </fieldset>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="provider-actions">
      <button type="submit" className="settings-button" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

function ProjectOverview({ project, folders, chats, onStartChat, onOpenChat }: { project: Project; folders: Folder[]; chats: Chat[]; onStartChat: (projectId: string, folderId?: string) => void; onOpenChat: (chatId: string) => void }) {
  const attached = project.folderIds.map(id => folders.find(f => f.id === id)).filter((f): f is Folder => f !== undefined);
  const [chatFolderId, setChatFolderId] = useState<string | undefined>(undefined);
  useEffect(() => { setChatFolderId(attached.length === 1 ? attached[0].id : undefined); }, [project.id, attached.length]);
  return <article className="project-overview" aria-label={`Project ${project.name}`}>
    <div className="project-overview-top"><h2>{project.name}</h2>
      <div className="project-start">
        {attached.length > 1 && <label className="project-start-folder">Chat folder
          <select value={chatFolderId ?? ''} onChange={e => setChatFolderId(e.target.value || undefined)}>
            <option value="">Choose a folder</option>
            {attached.map(f => <option key={f.id} value={f.id}>{f.name}</option>)}
          </select></label>}
        <button type="button" className="settings-button" disabled={attached.length > 1 && !chatFolderId} onClick={() => onStartChat(project.id, chatFolderId)}><MessageSquare size={14}/>Start project chat</button>
      </div></div>
    <h3 className="settings-section-label">Shared goal</h3>
    <p className="project-goal">{project.goal || <span className="projects-empty">No shared goal was set.</span>}</p>
    <h3 className="settings-section-label">Attached folders</h3>
    {attached.length === 0 ? <p className="projects-empty">No folders attached. New chats use a private scratch folder.</p>
      : <ul className="project-folders">{attached.map(f => <li key={f.id}><FolderOpen size={14} aria-hidden="true"/><span>{f.name}</span><code>{f.path}</code></li>)}</ul>}
    <h3 className="settings-section-label">Project chats</h3>
    {chats.length === 0 ? <p className="projects-empty">No chats in this project yet.</p>
      : <ul className="project-chats">{chats.map(c => <li key={c.id}><button type="button" onClick={() => onOpenChat(c.id)}><span className="project-chat-title">{c.title || 'Untitled chat'}</span><span className="projects-item-meta">{new Date(c.updatedAt).toLocaleString()}</span></button></li>)}</ul>}
    <ProjectTasks project={project} folders={attached}/>
  </article>;
}
