import { Archive, FolderOpen, FolderPlus, Layers, MessageSquare, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Folder } from '../../shared/protocol';
import type { ProjectDetails, ProjectImpact } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { plural } from '../../shared/wording.ts';
import { ModalSheet } from './ModalSheet';
import { ResourceState } from './ResourceState';
import { projectEditPatch, shortPath } from '../projectSurface';
export { projectEditPatch, shortPath, toProjectDetails } from '../projectSurface';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './project-surface.css';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;

/** Codex's Edit project dialog: name, source folders with a Primary marker, remove (×), Add folder, then Save. Nothing changes until Save. */
export function EditProjectDialog({ project, allFolders, open, selectName, onClose, onSaved, onArchive }: {
  project: ProjectDetails; allFolders: Folder[]; open: boolean; selectName?: boolean;
  onClose: () => void; onSaved: (p: ProjectDetails) => void; onArchive?: () => void;
}) {
  const primaryFirst = () => { const primary = project.primaryFolderId ?? project.folderIds[0]; return primary ? [primary, ...project.folderIds.filter(id => id !== primary)] : [...project.folderIds]; };
  const [name, setName] = useState(project.name);
  const [goal, setGoal] = useState(project.goal);
  const [folderIds, setFolderIds] = useState<string[]>(primaryFirst);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const nameField = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!open) return;
    setName(project.name); setGoal(project.goal); setFolderIds(primaryFirst()); setAdding(false); setError('');
    if (selectName) requestAnimationFrame(() => nameField.current?.select());
  }, [open, project.id]);
  const byId = (id: string) => allFolders.find(f => f.id === id);
  const available = allFolders.filter(f => !folderIds.includes(f.id) && !f.missing);
  const patch = projectEditPatch(project, { name, goal, folderIds });
  const makePrimary = (id: string) => setFolderIds(ids => [id, ...ids.filter(f => f !== id)]);
  const add = (id: string) => { setFolderIds(ids => ids.includes(id) ? ids : [...ids, id]); setAdding(false); };
  async function browse() {
    setError('');
    try { const folder = await invoke('folder.pick', undefined); if (folder) add(folder.id); }
    catch (err) { setError(message(err, 'Could not add that folder.')); }
  }
  async function save(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy || !name.trim()) return;
    if (!patch) { onClose(); return; }
    setBusy(true); setError('');
    try { onSaved(await invoke('project.update', patch)); onClose(); }
    catch (err) { setError(message(err, 'Could not save the project.')); }
    finally { setBusy(false); }
  }
  return <ModalSheet open={open} className="project-edit-dialog" testId="project-edit-dialog" title="Edit project" initialFocus={nameField} onClose={() => { if (!busy) onClose(); }}>
    <form onSubmit={e => void save(e)}>
      <button type="button" className="icon-button project-edit-close" aria-label="Close" disabled={busy} onClick={onClose}><X size={15}/></button>
      <label className="project-edit-name"><Layers size={15} aria-hidden="true"/><span className="sr-only">Project name</span>
        <input ref={nameField} required maxLength={256} value={name} disabled={busy} placeholder="Name this project" onChange={e => setName(e.target.value)}/></label>
      <label className="project-edit-goal"><span>Shared goal</span>
        <textarea rows={2} maxLength={32768} value={goal} disabled={busy} placeholder="What should every chat in this project work toward?" onChange={e => setGoal(e.target.value)}/></label>
      <div className="project-edit-folders" role="group" aria-label="Source folders">
        <span className="project-edit-label">Source folders</span>
        <ul>
          {folderIds.map((id, i) => { const f = byId(id); const label = f?.name ?? 'Unknown folder'; return <li key={id} title={f ? f.path : undefined}>
            <FolderOpen size={14} aria-hidden="true"/><span className="project-edit-folder-name">{label}{f?.missing ? <small> · missing</small> : null}</span>
            {i === 0 ? <span className="project-edit-primary">Primary</span>
              : <button type="button" className="project-edit-make-primary" disabled={busy} onClick={() => makePrimary(id)}>Make primary</button>}
            <button type="button" className="icon-button" aria-label={`Remove ${label} from project`} disabled={busy} onClick={() => setFolderIds(ids => ids.filter(f => f !== id))}><X size={13}/></button>
          </li>; })}
          {!adding ? <li><button type="button" className="project-edit-add" disabled={busy} onClick={() => available.length ? setAdding(true) : void browse()}><FolderPlus size={14} aria-hidden="true"/>Add folder</button></li>
            : <li className="project-edit-picker"><ul aria-label="Folders to add">
                {available.map(f => <li key={f.id}><button type="button" onClick={() => add(f.id)}><FolderOpen size={14} aria-hidden="true"/><span>{f.name}</span><code>{shortPath(f.path)}</code></button></li>)}
                <li><button type="button" onClick={() => { setAdding(false); void browse(); }}><FolderPlus size={14} aria-hidden="true"/><span>Choose another folder…</span></button></li>
              </ul></li>}
        </ul>
        {folderIds.length === 0 && <p className="project-edit-hint">No folders. New chats use a private scratch folder, and tasks need a folder before they can run.</p>}
      </div>
      {error && <p role="alert" className="settings-error">{error}</p>}
      <div className="project-edit-actions">
        {onArchive && !project.archived && <button type="button" className="project-edit-archive" disabled={busy} onClick={onArchive}><Archive size={13} aria-hidden="true"/>Archive project…</button>}
        <span className="project-edit-spacer"/>
        <button type="button" className="project-edit-cancel" disabled={busy} onClick={onClose}>Cancel</button>
        <button type="submit" className="project-edit-save" disabled={busy || !name.trim()}>{busy ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  </ModalSheet>;
}

/** Archive and delete both show what they touch before anything changes. */
export function ConfirmProjectAction({ project, action, onClose, onArchived, onDeleted }: { project: ProjectDetails; action: 'archive' | 'delete' | null; onClose: () => void; onArchived: (p: ProjectDetails) => void; onDeleted: () => void }) {
  const [impact, setImpact] = useState<ProjectImpact | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!action) return;
    let cancelled = false;
    setImpact(null); setError('');
    invoke('project.preview', { id: project.id }).then(p => { if (!cancelled) setImpact(p); }).catch(err => { if (!cancelled) setError(message(err, 'Could not preview this change.')); });
    return () => { cancelled = true; };
  }, [action, project.id]);
  const running = impact ? impact.chats.running + impact.tasks.running : 0;
  const blocked = action === 'delete' && running > 0;
  async function confirm() {
    setBusy(true); setError('');
    try {
      if (action === 'archive') onArchived(await invoke('project.archive', { id: project.id }));
      else { await invoke('project.delete', { id: project.id }); onDeleted(); }
      onClose();
    } catch (err) { setError(message(err, 'Could not complete this change.')); }
    finally { setBusy(false); }
  }
  return <ModalSheet open={action !== null} className="composer-access-dialog project-confirm" title={action === 'delete' ? `Delete ${project.name}?` : `Archive ${project.name}?`}
    description={action === 'delete' ? 'Chats leave the project and keep their history. Tasks, decisions and activity are deleted.' : 'The project moves to Archived and no task starts a new agent run until you restore it. Chats stay available.'} onClose={() => { if (!busy) onClose(); }}>
    {!impact && !error && <ResourceState kind="loading" compact label="Checking what this affects" rows={2}/>}
    {impact && <section className="project-impact" aria-label="Affected chats and tasks">
      <p><strong>{plural(impact.chats.total, 'chat')}</strong>{impact.chats.running ? ` · ${impact.chats.running} running` : ''} · <strong>{plural(impact.tasks.total, 'task')}</strong>{impact.tasks.open ? ` · ${impact.tasks.open} open` : ''}{impact.tasks.running ? ` · ${impact.tasks.running} running` : ''}</p>
      {(impact.chats.items.length > 0 || impact.tasks.items.length > 0) && <ul>
        {impact.chats.items.slice(0, 4).map(c => <li key={c.id}><MessageSquare size={13} aria-hidden="true"/><span>{c.title}</span><small>{c.status === 'running' || c.status === 'stopping' ? 'Running' : 'Chat'}</small></li>)}
        {impact.tasks.items.slice(0, 4).map(t => <li key={t.id}><Layers size={13} aria-hidden="true"/><span>{t.title}</span><small>{t.status === 'running' ? 'Running' : 'Task'}</small></li>)}
      </ul>}
      {action === 'archive' && impact.tasks.running > 0 && <p className="project-impact-note">Running tasks finish their current run; nothing new starts.</p>}
      {blocked && <p className="settings-error">Stop the running {impact.chats.running ? 'chats' : 'tasks'} before deleting this project.</p>}
    </section>}
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div><button type="button" onClick={onClose} disabled={busy}>Cancel</button>
      <button type="button" className={action === 'delete' ? 'is-danger' : undefined} disabled={busy || !impact || blocked} onClick={() => void confirm()}>{busy ? (action === 'delete' ? 'Deleting…' : 'Archiving…') : action === 'delete' ? 'Delete project' : 'Archive project'}</button></div>
  </ModalSheet>;
}
