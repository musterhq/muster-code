import { FolderOpen, FolderPlus, GitBranch, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Folder, Project } from '../../shared/protocol';
import { invoke } from '../bridge';
import { shortPath } from '../projectSurface';
import { openCloneSheet, releaseCloneLanding } from './CloneRepositorySheet';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './project-surface.css';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

/** The primary source first, then the rest in the order they were picked. */
export function orderedSources(folderIds: string[], primary: string | null): string[] {
  const first = primary && folderIds.includes(primary) ? primary : folderIds[0];
  return first ? [first, ...folderIds.filter(id => id !== first)] : [];
}

/**
 * New project: name, shared goal and its sources. Tick any folders already in Muster, or add one with
 * "Choose folder…" (native picker) or "Clone repository…". The first source picked is primary until the user
 * makes another one primary. One project.create carries the folders and primary, so nothing is half-created.
 */
export function NewProjectForm({ folders, onClose, onCreated }: { folders: Folder[]; onClose: () => void; onCreated: (p: Project) => void }) {
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [primary, setPrimary] = useState<string | null>(null);
  // Folders added by the picker or a clone, shown before the next snapshot lists them.
  const [added, setAdded] = useState<Folder[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const first = useRef<HTMLInputElement>(null);
  // The clone sheet holds one stable handler; it forwards to the latest include() and is released on unmount.
  const includeRef = useRef<(folder: Folder) => void>(() => {});
  const landed = useRef((folder: Folder) => includeRef.current(folder)).current;
  useEffect(() => first.current?.focus(), []);
  useEffect(() => () => releaseCloneLanding(landed), [landed]);
  const known = [...folders, ...added.filter(a => !folders.some(f => f.id === a.id))];
  const listed = known.filter(f => !f.missing || folderIds.includes(f.id));
  const sources = orderedSources(folderIds, primary);
  const primaryId = sources[0] ?? null;
  const include = (folder: Folder) => {
    if (!folders.some(f => f.id === folder.id)) setAdded(list => list.some(f => f.id === folder.id) ? list : [...list, folder]);
    setFolderIds(ids => ids.includes(folder.id) ? ids : [...ids, folder.id]);
  };
  includeRef.current = include;
  const toggle = (id: string) => setFolderIds(ids => ids.includes(id) ? ids.filter(f => f !== id) : [...ids, id]);
  async function browse() {
    setError('');
    try { const folder = await invoke('folder.pick', undefined); if (folder) include(folder); }
    catch (err) { setError(message(err, 'Could not add that folder.')); }
  }
  function clone() { setError(''); openCloneSheet({ onLanded: landed }); }
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !name.trim()) return;
    setError(''); setBusy(true);
    try { onCreated(await invoke('project.create', { name: name.trim(), goal: goal.trim(), folderIds: sources, primaryFolderId: primaryId })); }
    catch (err) { setError(message(err, 'Could not create the project.')); }
    finally { setBusy(false); }
  }
  return <form className="new-project" onSubmit={e => void submit(e)} aria-label="New project" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h2>New project</h2><button type="button" className="icon-button" aria-label="Cancel new project" disabled={busy} onClick={onClose}><X size={16}/></button></header>
    <label>Name<input ref={first} type="text" required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="My project" disabled={busy}/></label>
    <label>Shared goal <span className="optional">shown to every chat in the project</span><textarea rows={3} maxLength={4000} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should this project achieve?" disabled={busy}/></label>
    <div className="project-edit-folders new-project-sources" role="group" aria-label="Sources">
      <span className="project-edit-label">Sources <span className="optional">{sources.length ? `${sources.length} selected · the primary folder is where chats and task runs start` : 'pick one or more folders; the first is primary'}</span></span>
      <ul>
        {listed.map(f => { const on = folderIds.includes(f.id), isPrimary = f.id === primaryId; return <li key={f.id} className={on ? 'is-selected' : undefined} title={f.path}>
          <label className="new-project-source"><input type="checkbox" checked={on} disabled={busy} onChange={() => toggle(f.id)}/>
            <FolderOpen size={14} aria-hidden="true"/><span className="project-edit-folder-name">{f.name}{f.missing ? <small> · missing</small> : null}</span><code>{shortPath(f.path)}</code></label>
          {on && (isPrimary ? <span className="project-edit-primary">Primary</span>
            : <button type="button" className="project-edit-make-primary" disabled={busy} aria-label={`Make ${f.name} primary`} onClick={() => setPrimary(f.id)}>Make primary</button>)}
        </li>; })}
        <li className="new-project-source-actions">
          <button type="button" className="project-edit-add" disabled={busy} onClick={() => void browse()}><FolderPlus size={14} aria-hidden="true"/>Choose folder…</button>
          <button type="button" className="project-edit-add" disabled={busy} onClick={clone}><GitBranch size={14} aria-hidden="true"/>Clone repository…</button>
        </li>
      </ul>
      {sources.length === 0 && <p className="project-edit-hint">{listed.length ? 'No sources yet. ' : 'No folders in Muster yet. '}A project without sources starts chats in a private scratch folder, and its tasks need a folder before they can run.</p>}
    </div>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="provider-actions">
      <button type="submit" className="settings-button" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}
