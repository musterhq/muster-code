import { Menu } from '@base-ui/react/menu';
import { onNewProjectRequest, takeNewProjectRequest } from '../projectIntent';
import { Archive, ArchiveRestore, ArrowLeft, Clipboard, Download, FolderOpen, FolderPlus, Layers, MessageSquare, SquarePen, MoreHorizontal, Plus, Settings2, Star, Trash2, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Chat, Folder, Project } from '../../shared/protocol';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { openChangesTab, openMemoryScreen, selectChat } from '../store';
import { ProjectAgentsSection, ProjectChangesSection, ProjectEnvironmentsSection, ProjectMemorySection } from './ProjectSections';
import { restoreFocus } from '../focus';
import { onOpenProject, takePendingProject } from '../projectFocus';
import { useStore } from '../useStore';
import { ConfirmProjectAction, EditProjectDialog } from './ProjectEditDialog';
import { ProjectOverview, type ProjectTab } from './ProjectOverview';
import { MailboxInbox } from './MailboxInbox';
import { copyProjectExport, ProjectDecisionSection, ProjectTaskSection, relativeTime, saveProjectExport, useProjectWork, type TaskFilter } from './ProjectTasks';
import { StatusDot } from './StatusDot';
import { ProjectActivityPanel } from './ProjectActivityPanel';
import { ProjectMembersSection } from './ProjectMembers';
import { ChatTransferSheet, type ChatTransferRequest } from './ChatTransferSheet';
import { ResourceState } from './ResourceState';
import { exactTime } from '../relativeTime.ts';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './projects-screen.css';
import { ProjectDefaultModel } from './settings/ProjectDefaultModel';

const message = (err: unknown, fallback: string) => err instanceof Error ? err.message : fallback;
const fromSnapshot = (p: Project): ProjectDetails => ({ ...p, primaryFolderId: p.folderIds[0] ?? null, archived: false, archivedAt: null });

/** Projects surface: a project rail and a first-class project view with editable header and sections. Parent owns routing (onBack) and chat handoff (onStartChat). */
export function ProjectsScreen({ onBack, onStartChat }: { onBack: () => void; onStartChat: (projectId: string, folderId?: string) => void }) {
  const { snapshot } = useStore();
  const [details, setDetails] = useState<ProjectDetails[] | null>(null);
  const [creating, setCreating] = useState(takeNewProjectRequest);
  useEffect(() => onNewProjectRequest(() => setCreating(true)), []);
  const [selectedId, setSelectedId] = useState<string | null>(() => takePendingProject());
  const [showArchived, setShowArchived] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
  const newProjectButton = useRef<HTMLButtonElement>(null);
  useEffect(() => { launcher.current = document.activeElement; back.current?.focus(); }, []);
  useEffect(() => onOpenProject(id => { setCreating(false); setSelectedId(id); }), []);
  const version = snapshot?.version;
  useEffect(() => {
    let cancelled = false;
    invoke('project.list', undefined).then(list => { if (!cancelled) setDetails(list); }).catch(() => { if (!cancelled) setDetails(null); });
    return () => { cancelled = true; };
  }, [version]);
  const leave = () => { onBack(); restoreFocus(launcher.current); };
  const folders = snapshot?.folders ?? [];
  const chats = snapshot?.chats ?? [];
  const known = new Set((snapshot?.projects ?? []).map(p => p.id));
  const listed = new Set(details?.map(p => p.id));
  // A project created since the last project.list shows from the snapshot until the list catches up.
  const projects = [...(details ?? []).filter(p => known.has(p.id)), ...(snapshot?.projects ?? []).filter(p => !listed.has(p.id)).map(fromSnapshot)];
  const active = projects.filter(p => !p.archived), archived = projects.filter(p => p.archived);
  const selected = projects.find(p => p.id === selectedId) ?? (creating ? null : active[0] ?? null);
  useEffect(() => { if (selected?.archived) setShowArchived(true); }, [selected?.id, selected?.archived]);
  const upsert = (next: ProjectDetails) => setDetails(list => list ? list.map(p => p.id === next.id ? next : p) : list);
  const chatCount = (id: string) => chats.filter(c => c.projectId === id && !c.archived).length;
  const railItem = (p: ProjectDetails) => <li key={p.id}><button type="button" className={`project-rail-item${p.id === selected?.id ? ' is-selected' : ''}`} aria-current={p.id === selected?.id ? 'page' : undefined} onClick={() => { setCreating(false); setSelectedId(p.id); }}>
    <Layers size={14} aria-hidden="true"/><span className="project-rail-name">{p.name}</span><span className="project-rail-count">{chatCount(p.id) || ''}</span>
  </button></li>;

  return <section className="project-screen" aria-label="Projects" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && e.currentTarget.contains(e.target as Node)) { e.preventDefault(); leave(); } }}>
    <header className="project-topbar"><button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>
      <span className="project-crumb">Projects{selected && !creating ? <> <span aria-hidden="true">/</span> <strong>{selected.name}</strong></> : null}</span></header>
    <div className="project-body">
      <nav className="project-rail" aria-label="Projects list">
        <button ref={newProjectButton} type="button" className="project-rail-new" onClick={() => setCreating(true)}><Plus size={14}/>New project</button>
        {active.length > 0 && <ul>{active.map(railItem)}</ul>}
        {archived.length > 0 && <>
          <button type="button" className="project-rail-group" aria-expanded={showArchived} onClick={() => setShowArchived(v => !v)}><Archive size={13}/>Archived <span>{archived.length}</span></button>
          {showArchived && <ul>{archived.map(railItem)}</ul>}
        </>}
      </nav>
      <div className="project-main">
        {creating ? <div className="project-main-inner"><NewProjectForm folders={folders} onClose={() => { setCreating(false); requestAnimationFrame(() => restoreFocus(newProjectButton.current)); }} onCreated={p => { setCreating(false); setSelectedId(p.id); }}/></div>
          : selected ? <ProjectDetail key={selected.id} project={selected} allFolders={folders} chats={chats.filter(c => c.projectId === selected.id)} onUpdated={upsert}
              onStartChat={folderId => onStartChat(selected.id, folderId)} onOpenChat={id => { void selectChat(id); onBack(); }} onLeave={onBack}
              onDeleted={() => { setSelectedId(active.find(p => p.id !== selected.id)?.id ?? null); }}/>
          : <div className="project-blank"><Layers size={22} aria-hidden="true"/><h1>Projects</h1><p>A project carries one shared goal, tasks and decisions across several folders. Folder chats stay scoped to a single folder.</p>
              <button type="button" className="settings-button" onClick={() => setCreating(true)}><Plus size={14}/>New project</button></div>}
      </div>
    </div>
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
    catch (err) { setError(message(err, 'Could not create the project.')); }
    finally { setBusy(false); }
  }
  return <form className="new-project" onSubmit={e => void submit(e)} aria-label="New project" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); e.preventDefault(); if (!busy) onClose(); } }}>
    <header><h2>New project</h2><button type="button" className="icon-button" aria-label="Cancel new project" disabled={busy} onClick={onClose}><X size={16}/></button></header>
    <label>Name<input ref={first} required maxLength={200} value={name} onChange={e => setName(e.target.value)} placeholder="My project" disabled={busy}/></label>
    <label>Shared goal <span className="optional">shown to every chat in the project</span><textarea rows={3} maxLength={4000} value={goal} onChange={e => setGoal(e.target.value)} placeholder="What should this project achieve?" disabled={busy}/></label>
    <fieldset className="projects-folder-picker" disabled={busy}><legend>Folders <span className="optional">optional — link more later; the first is primary</span></legend>
      {folders.length === 0 && <p className="field-help">No folders are open yet. You can link folders from the project's Folders tab.</p>}
      {folders.map(f => <label key={f.id} className="projects-folder-option"><input type="checkbox" checked={folderIds.includes(f.id)} onChange={() => toggle(f.id)}/><span>{f.name}</span><code>{f.path}</code></label>)}
    </fieldset>
    {error && <p role="alert" className="settings-error">{error}</p>}
    <div className="provider-actions">
      <button type="submit" className="settings-button" disabled={busy || !name.trim()}>{busy ? 'Creating…' : 'Create project'}</button>
      <button type="button" className="settings-button secondary" disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </form>;
}

/** Click-to-edit text. Enter (⌘Enter when multiline) or blur saves; Escape cancels without leaving the screen. */
function InlineText({ value, label, placeholder, multiline, maxLength, className, startSignal, onSave }: { value: string; label: string; placeholder: string; multiline?: boolean; maxLength: number; className: string; startSignal?: number; onSave: (next: string) => Promise<void> }) {
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
  if (!editing) return <button ref={display} type="button" className={`project-inline ${className}${value ? '' : ' is-empty'}`} aria-label={`Edit ${label.toLowerCase()}`} title={`Edit ${label.toLowerCase()}`} onClick={begin}>{value || placeholder}</button>;
  return <div className={`project-inline-edit ${className}`}>
    {multiline ? <textarea ref={field} aria-label={label} rows={3} maxLength={maxLength} value={draft} disabled={busy} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={keys} onBlur={() => void commit()}/>
      : <input ref={field} aria-label={label} maxLength={maxLength} value={draft} disabled={busy} placeholder={placeholder} onChange={e => setDraft(e.target.value)} onKeyDown={keys} onBlur={() => void commit()}/>}
    <span className="project-inline-hint">{error ? <span role="alert" className="settings-error">{error}</span> : multiline ? '⌘Enter to save · Esc to cancel' : 'Enter to save · Esc to cancel'}</span>
  </div>;
}

// PRJ-X3: work first (tasks, agents, chats, changes), then the record (activity, decisions, memory), then plumbing.
const TABS: { id: ProjectTab; label: string }[] = [{ id: 'overview', label: 'Overview' }, { id: 'tasks', label: 'Tasks' }, { id: 'agents', label: 'Agents' }, { id: 'chats', label: 'Chats' }, { id: 'changes', label: 'Changes' },
  { id: 'activity', label: 'Activity' }, { id: 'decisions', label: 'Decisions' }, { id: 'memory', label: 'Memory' }, { id: 'inbox', label: 'Inbox' }, { id: 'environments', label: 'Environments' }, { id: 'settings', label: 'Settings' }];

function ProjectDetail({ project, allFolders, chats, onUpdated, onStartChat, onOpenChat, onLeave, onDeleted }: { project: ProjectDetails; allFolders: Folder[]; chats: Chat[]; onUpdated: (p: ProjectDetails) => void; onStartChat: (folderId?: string) => void; onOpenChat: (id: string) => void; onLeave?: () => void; onDeleted: () => void }) {
  const [tab, setTab] = useState<ProjectTab>('overview');
  const [filter, setFilter] = useState<TaskFilter>('all');
  const [highlight, setHighlight] = useState<string | null>(null);
  const [goalSignal, setGoalSignal] = useState(0);
  const [addSignal, setAddSignal] = useState(0);
  const [status, setStatus] = useState('');
  const [confirm, setConfirm] = useState<'archive' | 'delete' | null>(null);
  const [editing, setEditing] = useState(false);
  const { work, error, reload } = useProjectWork(project.id);
  const folders = useMemo(() => project.folderIds.map(id => allFolders.find(f => f.id === id)).filter((f): f is Folder => Boolean(f)), [project.folderIds, allFolders]);
  const tabRefs = useRef<Partial<Record<ProjectTab, HTMLButtonElement | null>>>({});
  useEffect(() => { if (tab !== 'tasks') setAddSignal(0); }, [tab]);
  useEffect(() => { if (!status) return; const t = setTimeout(() => setStatus(''), 6000); return () => clearTimeout(t); }, [status]);
  useEffect(() => {
    if (!highlight) return;
    const frame = requestAnimationFrame(() => document.querySelector(`[data-ref="${CSS.escape(highlight)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    const t = setTimeout(() => setHighlight(null), 2400);
    return () => { cancelAnimationFrame(frame); clearTimeout(t); };
  }, [highlight, tab]);
  const save = async (patch: { name?: string; goal?: string }) => onUpdated(await invoke('project.update', { id: project.id, ...patch }));
  const resolveRef = (refId: string): string | null => work?.tasks.items.some(t => t.id === refId) ? 'task' : work?.decisions.items.some(d => d.id === refId) ? 'decision' : chats.some(c => c.id === refId) ? 'chat' : folders.some(f => f.id === refId) ? 'folder' : null;
  const openRef = (refId: string) => {
    const kind = resolveRef(refId);
    if (kind === 'chat') onOpenChat(refId);
    else if (kind === 'task') { setFilter('all'); setTab('tasks'); setHighlight(refId); }
    else if (kind === 'decision') { setTab('decisions'); setHighlight(refId); }
    else if (kind === 'folder') { setTab('environments'); setHighlight(refId); }
  };
  const tabKeys = (e: React.KeyboardEvent) => {
    const i = TABS.findIndex(t => t.id === tab), next = e.key === 'ArrowRight' ? (i + 1) % TABS.length : e.key === 'ArrowLeft' ? (i + TABS.length - 1) % TABS.length : e.key === 'Home' ? 0 : e.key === 'End' ? TABS.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault(); setTab(TABS[next].id); tabRefs.current[TABS[next].id]?.focus();
  };
  const count = (id: ProjectTab) => id === 'tasks' ? work?.tasks.items.filter(t => t.status !== 'verified').length : id === 'agents' ? work?.tasks.items.filter(t => t.state === 'running' || t.state === 'needs-input').length : id === 'chats' ? chats.filter(c => !c.archived).length : undefined;
  const restore = async () => { try { onUpdated(await invoke('project.restore', { id: project.id })); setStatus('Project restored. Task runs can start again.'); } catch (err) { setStatus(message(err, 'Could not restore the project.')); } };

  return <article className="project-detail" aria-label={`Project ${project.name}`}>
    <header className="project-head">
      <div className="project-head-text">
        <InlineText className="project-name" label="Project name" placeholder="Name this project" maxLength={256} value={project.name} onSave={name => save({ name })}/>
        <InlineText className="project-goal" label="Shared goal" placeholder="Add a shared goal every chat in this project can see" multiline maxLength={32768} value={project.goal} startSignal={goalSignal} onSave={goal => save({ goal })}/>
      </div>
      <div className="project-head-actions">
        {!project.archived && <ProjectDefaultModel projectId={project.id}/>}
        {!project.archived && <button type="button" className="settings-button" onClick={() => onStartChat(folders[0]?.id)} title={folders[0] ? `New chat in ${folders[0].name} (primary)` : 'New chat in a private scratch folder'}><SquarePen size={14}/>New chat</button>}
        <Menu.Root>
          <Menu.Trigger className="icon-button project-more" aria-label="Project actions"><MoreHorizontal size={16}/></Menu.Trigger>
          <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="project-menu-positioner"><Menu.Popup className="project-menu">
            <Menu.Item onClick={() => setEditing(true)}><Settings2 size={14}/>Edit project…</Menu.Item>
            <Menu.Separator className="project-menu-separator"/>
            <Menu.Item onClick={() => void copyProjectExport(project, folders.length).then(setStatus)}><Clipboard size={14}/>Copy export JSON</Menu.Item>
            <Menu.Item onClick={() => void saveProjectExport(project).then(setStatus)}><Download size={14}/>Save export JSON…</Menu.Item>
            <Menu.Separator className="project-menu-separator"/>
            {project.archived ? <Menu.Item onClick={() => void restore()}><ArchiveRestore size={14}/>Restore project</Menu.Item>
              : <Menu.Item onClick={() => setConfirm('archive')}><Archive size={14}/>Archive project…</Menu.Item>}
            <Menu.Item className="project-menu-destructive" onClick={() => setConfirm('delete')}><Trash2 size={14}/>Delete project…</Menu.Item>
          </Menu.Popup></Menu.Positioner></Menu.Portal>
        </Menu.Root>
      </div>
    </header>
    {project.archived && <div className="project-archived-banner" role="status"><Archive size={14}/><span>Archived{project.archivedAt ? ` ${relativeTime(project.archivedAt)}` : ''}. Task runs are paused until you restore it.</span><button type="button" className="settings-button secondary" onClick={() => void restore()}><ArchiveRestore size={13}/>Restore</button></div>}
    {status && <p className="project-status" role="status">{status}</p>}
    <div className="project-tabs" role="tablist" aria-label="Project sections" onKeyDown={tabKeys}>
      {TABS.map(t => { const n = count(t.id); return <button key={t.id} ref={el => { tabRefs.current[t.id] = el; }} type="button" role="tab" id={`project-tab-${t.id}`} aria-controls="project-tabpanel" aria-selected={tab === t.id} tabIndex={tab === t.id ? 0 : -1} className="project-tab" onClick={() => setTab(t.id)}>{t.label}{n ? <span>{n}</span> : null}</button>; })}
    </div>
    <div className="project-panel" role="tabpanel" id="project-tabpanel" aria-labelledby={`project-tab-${tab}`}>
      {tab === 'environments' ? <ProjectEnvironmentsSection chats={chats} folders={allFolders} onOpenChat={onOpenChat}><FoldersTab project={project} folders={folders} allFolders={allFolders} chats={chats} highlight={highlight} onUpdated={onUpdated} onStartChat={onStartChat}/></ProjectEnvironmentsSection>
        : tab === 'changes' ? <ProjectChangesSection folders={folders} onReview={f => { openChangesTab(f.id, f.name); onLeave?.(); }}/>
        : tab === 'memory' ? <ProjectMemorySection projectId={project.id} onOpenMemory={() => openMemoryScreen(`project:${project.id}`)}/>
        : tab === 'chats' ? <ChatsTab project={project} chats={chats} folders={allFolders} onOpenChat={onOpenChat} onStartChat={onStartChat} onStatus={setStatus}/>
        : tab === 'settings' ? <section aria-label="Project settings" className="project-section"><ProjectMembersSection project={project} folders={folders}/></section>
        : tab === 'inbox' ? <MailboxInbox projectId={project.id} title="Mail between this project’s chats, its task runs and you. Agents send and reply with the mailbox tools."/>
        : tab === 'activity' ? <ProjectActivityPanel projectId={project.id} resolveRef={resolveRef} onOpenRef={openRef}/>
        : error ? <ResourceState kind="error" message="This project’s work could not be loaded." detail={error} onRetry={reload}/>
        : !work ? <ResourceState kind="loading" label="Loading project" rows={4}/>
        : tab === 'overview' ? <ProjectOverview project={project} folders={folders} chats={chats} work={work} onTab={setTab} onTasks={f => { setFilter(f); setTab('tasks'); }} onOpenChat={onOpenChat} onOpenRef={openRef} resolveRef={resolveRef}
            onEditGoal={() => setGoalSignal(n => n + 1)} onStartChat={() => onStartChat(folders[0]?.id)} onAddTask={() => { setFilter('all'); setTab('tasks'); setAddSignal(n => n + 1); }} onChanged={reload}/>
        : tab === 'tasks' ? <ProjectTaskSection project={project} folders={folders} work={work} archived={project.archived} filter={filter} onFilter={setFilter} highlightId={highlight} addSignal={addSignal} onChanged={reload}/>
        : tab === 'agents' ? <ProjectAgentsSection work={work} chats={chats} onOpenChat={onOpenChat} onShowTasks={() => { setFilter('all'); setTab('tasks'); }}/>
        : tab === 'decisions' ? <ProjectDecisionSection projectId={project.id} work={work} highlightId={highlight} onChanged={reload}/>
        : null}
    </div>
    <EditProjectDialog project={project} allFolders={allFolders} open={editing} onClose={() => setEditing(false)} onSaved={p => { onUpdated(p); setStatus('Project saved.'); }} onArchive={() => { setEditing(false); setConfirm('archive'); }}/>
    <ConfirmProjectAction project={project} action={confirm} onClose={() => setConfirm(null)} onArchived={p => { onUpdated(p); setStatus('Project archived. Task runs are paused.'); }} onDeleted={onDeleted}/>
  </article>;
}

function FoldersTab({ project, folders, allFolders, chats, highlight, onUpdated, onStartChat }: { project: ProjectDetails; folders: Folder[]; allFolders: Folder[]; chats: Chat[]; highlight: string | null; onUpdated: (p: ProjectDetails) => void; onStartChat: (folderId?: string) => void }) {
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
          {!project.archived && <button type="button" className="icon-button" aria-label={`New chat in ${f.name}`} title={`New chat in ${f.name}`} onClick={() => onStartChat(f.id)}><SquarePen size={14}/></button>}
          {!primary && <button type="button" className="icon-button" aria-label={`Make ${f.name} primary`} title="Make primary" disabled={Boolean(busy)} onClick={() => void run(`primary:${f.id}`, () => invoke('project.update', { id: project.id, primaryFolderId: f.id }))}><Star size={14}/></button>}
          <button type="button" className="icon-button" aria-label={`Remove ${f.name} from project`} title={busyChat ? `"${busyChat.title}" is running here. Stop it first.` : 'Remove from project'} disabled={Boolean(busy) || Boolean(busyChat)} onClick={() => void run(`remove:${f.id}`, () => invoke('project.unlinkFolder', { id: project.id, folderId: f.id }))}><X size={14}/></button>
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

function ChatsTab({ project, chats, folders, onOpenChat, onStartChat, onStatus }: { project: ProjectDetails; chats: Chat[]; folders: Folder[]; onOpenChat: (id: string) => void; onStartChat: (folderId?: string) => void; onStatus: (text: string) => void }) {
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
        <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="project-menu-positioner"><Menu.Popup className="project-menu">
          <Menu.Item onClick={() => setTransfer({ chatId: c.id, projectId: null, mode: 'move', projectName: project.name })}>Move out of project…</Menu.Item>
          <Menu.Item onClick={() => setTransfer({ chatId: c.id, projectId: null, mode: 'copy', projectName: project.name })}>Copy out of project…</Menu.Item>
        </Menu.Popup></Menu.Positioner></Menu.Portal>
      </Menu.Root></li>)}</ul>}
    <ChatTransferSheet request={transfer} candidates={outside} onClose={() => setTransfer(null)} onDone={done}/>
  </section>;
}
