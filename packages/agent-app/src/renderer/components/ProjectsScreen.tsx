import { ArrowDownUp, ArrowLeft, ChevronRight, Eye, EyeOff, FolderClosed, Plus } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { Project } from '../../shared/protocol';
import type { ProjectDetails } from '../../shared/domains/projects-protocol';
import type { WorkspaceProject } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { invoke } from '../bridge';
import { restoreFocus } from '../focus';
import { openHub, refreshWorkspace, useWorkspace } from '../hubStore';
import { onNewProjectRequest, takeNewProjectRequest } from '../projectIntent';
import { clearPendingProject, onOpenProject, peekPendingProject } from '../projectFocus';
import { notifyError, selectChat } from '../store';
import { PROJECT_STATUS_LABEL, PROJECT_STATUSES, isOverdue, type ProjectStatus } from '../../shared/domains/work-protocol';
import { StarButton, dayLabel } from './WorkParts';
import { Tip } from './Tooltip';
import { useStore } from '../useStore';
import type { HubNav } from './HubPages';
import { NewProjectForm } from './NewProjectForm';
import { ProjectPage } from './ProjectPage';
import { ResourceState } from './ResourceState';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './projects-screen.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './workspace.css';

const fromSnapshot = (p: Project): ProjectDetails => ({ ...p, primaryFolderId: p.folderIds[0] ?? null, archived: false, archivedAt: null });

/**
 * Projects (#193), like Paperclip's: a list of projects (yours, and the linked Paperclip's, tagged), and one project page
 * for every project (Tasks · Roster · Outputs · Settings · Budget). The parent owns routing (onBack) and chat handoff
 * (onStartChat). While it is on screen it keeps the workspace snapshot live (hubStore.useWorkspace).
 */
export function ProjectsScreen({ onBack, onStartChat }: { onBack: () => void; onStartChat: (projectId: string, folderId?: string) => void }) {
  const { snapshot } = useStore();
  const ws = useWorkspace();
  const [details, setDetails] = useState<ProjectDetails[] | null>(null);
  const [creating, setCreating] = useState(takeNewProjectRequest);
  useEffect(() => onNewProjectRequest(() => setCreating(true)), []);
  // Peek in the initializer and consume in an effect: a first render React throws away never loses the request.
  const [selectedId, setSelectedId] = useState<string | null>(() => peekPendingProject());
  useEffect(() => { clearPendingProject(selectedId); }, []);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
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
  const selected = selectedId ? projects.find(p => p.id === selectedId) ?? null : null;
  const upsert = (next: ProjectDetails) => setDetails(list => list ? list.map(p => p.id === next.id ? next : p) : list);
  // An agent opened from a project's Roster keeps that project as its breadcrumb (not the hub's last page, the Inbox).
  const nav: HubNav = { onOpenTask: id => openHub('task', id), onOpenAgent: id => openHub('agent', id, selected ? { page: 'project', arg: selected.id } : undefined), onOpenChat: id => { void selectChat(id); onBack(); } };
  const toList = () => { setCreating(false); setSelectedId(null); };

  return <section className="project-screen" aria-label={NAMES.projects} onKeyDown={e => {
    if (e.key !== 'Escape' || e.defaultPrevented || !e.currentTarget.contains(e.target as Node) || (e.target as HTMLElement).closest('input,textarea,select,[role="dialog"],[role="menu"]')) return;
    e.preventDefault(); if (selected || creating) toList(); else leave();
  }}>
    <header className="project-topbar"><button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15}/>Back to app</button>
      <span className="ws-crumb">{selected || creating ? <><button type="button" className="ws-crumb-link" onClick={toList}>{NAMES.projects}</button><ChevronRight size={13} aria-hidden="true"/><strong>{creating ? 'New project' : selected!.name}</strong></> : <strong>{NAMES.projects}</strong>}</span></header>
    <div className="project-main pp-host">
      {creating ? <div className="project-main-inner"><NewProjectForm folders={folders} onClose={toList} onCreated={p => { setCreating(false); setSelectedId(p.id); }}/></div>
        : selected ? <ProjectPage key={selected.id} snapshot={ws.snapshot} projectId={selected.id} nav={nav}
            muster={{ project: selected, allFolders: folders, chats: chats.filter(c => c.projectId === selected.id), onUpdated: upsert, onStartChat: folderId => onStartChat(selected.id, folderId), onOpenChat: nav.onOpenChat, onLeave: onBack, onDeleted: toList }}/>
        : selectedId && details ? <ResourceState kind="empty" message="This project no longer exists."><button type="button" className="settings-button secondary" onClick={toList}>All projects</button></ResourceState>
        : <ProjectList projects={projects} workspace={ws.snapshot?.projects ?? []} onOpen={setSelectedId} onCreate={() => setCreating(true)}/>}
    </div>
  </section>;
}

type ProjectSort = 'name' | 'recent';
/** Paperclip's project list: an icon, name and goal, task count and state; Paperclip projects are tagged and open in the hub. */
function ProjectList({ projects, workspace, onOpen, onCreate }: { projects: ProjectDetails[]; workspace: WorkspaceProject[]; onOpen: (id: string) => void; onCreate: () => void }): React.ReactElement {
  const [sort, setSort] = useState<ProjectSort>('name');
  const [showArchived, setShowArchived] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const stats = useMemo(() => new Map(workspace.map(p => [p.id, p])), [workspace]);
  const all = [
    ...projects.filter(p => showArchived || !p.archived).map(p => { const w = stats.get(p.id); return { id: p.id, name: p.name, detail: p.goal, source: 'local' as const, archived: p.archived, paused: w?.paused ?? false, tasks: w?.taskCount ?? null, open: w?.openCount ?? null, status: (PROJECT_STATUSES.includes(w?.status as ProjectStatus) ? w!.status : 'in_progress') as ProjectStatus, targetDate: w?.targetDate ?? null, starred: Boolean(w?.starred), hidden: Boolean(w?.hidden) }; }),
    ...workspace.filter(p => p.source === 'paperclip').map(p => ({ id: p.id, name: p.name, detail: p.description, source: 'paperclip' as const, archived: false, paused: p.paused, tasks: p.taskCount, open: p.openCount, status: 'in_progress' as ProjectStatus, targetDate: null as string | null, starred: false, hidden: false })),
  ];
  // Starred projects first; hidden ones fold away behind a toggle (the sidebar is not touched).
  const hiddenCount = all.filter(r => r.hidden).length;
  const rows = all.filter(r => showHidden || !r.hidden).sort((a, b) => Number(b.starred) - Number(a.starred) || (sort === 'name' ? a.name.localeCompare(b.name) : (b.open ?? 0) - (a.open ?? 0) || a.name.localeCompare(b.name)));
  const archived = projects.filter(p => p.archived).length;
  const mark = (id: string, patch: { starred?: boolean; hidden?: boolean }) => void invoke('work.star.set', { kind: 'project', id, ...patch }).then(() => refreshWorkspace(), notifyError);
  return <div className="ws-page pp-list">
    <div className="task-toolbar">
      <button type="button" className="settings-button secondary" onClick={() => setSort(s => s === 'name' ? 'recent' : 'name')}><ArrowDownUp size={14}/>Sort: {sort === 'name' ? 'Name' : 'Most open'}</button>
      {archived > 0 && <button type="button" className="ws-filter" aria-pressed={showArchived} onClick={() => setShowArchived(v => !v)}>Archived<span>{archived}</span></button>}
      {hiddenCount > 0 && <button type="button" className="ws-filter" aria-pressed={showHidden} onClick={() => setShowHidden(v => !v)}>Hidden<span>{hiddenCount}</span></button>}
      <span className="task-toolbar-spacer"/>
      <button type="button" className="settings-button secondary" onClick={onCreate}><Plus size={14}/>New project</button>
    </div>
    <div className="ws-section-head"><h2 className="ws-group-title">My projects</h2><span className="ws-row-count">{rows.length} {rows.length === 1 ? 'project' : 'projects'}</span></div>
    {rows.length === 0 ? <ResourceState kind="empty" icon={<FolderClosed size={20}/>} title={hiddenCount ? 'Every project is hidden' : 'No projects yet'} message={hiddenCount ? 'Use the Hidden filter to bring them back.' : 'A project holds tasks, a Roster of agents that work on them, and the folders they work in.'}>
        {!hiddenCount && <button type="button" className="settings-button" onClick={onCreate}><Plus size={14}/>New project</button>}
      </ResourceState>
      : <ul className="ws-rows">{rows.map(r => <li key={r.id} className="pp-list-item" data-hidden={r.hidden || undefined}><button type="button" className="ws-row pp-list-row" onClick={() => r.source === 'paperclip' ? openHub('project', r.id) : onOpen(r.id)}>
          <span className="pp-icon" aria-hidden="true"><FolderClosed size={14}/></span>
          <span className="ws-row-text"><span className="ws-row-title">{r.name}</span><span className="ws-row-meta">{r.detail || 'No goal yet'}</span></span>
          {r.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}
          {r.tasks !== null && <span className="ws-row-count">{r.tasks} {r.tasks === 1 ? 'task' : 'tasks'}</span>}
          {r.targetDate && <span className="ws-chip" data-tone={isOverdue(r.status, r.targetDate) ? 'danger' : undefined} title="Target date">{dayLabel(r.targetDate)}</span>}
          <span className="ws-chip" data-tone={r.archived ? 'faint' : r.paused ? 'warn' : r.status === 'completed' ? 'ok' : r.status === 'cancelled' || r.status === 'backlog' ? 'faint' : 'accent'}>{r.archived ? 'archived' : r.paused ? 'paused' : PROJECT_STATUS_LABEL[r.status].toLowerCase()}</span>
        </button>
        {r.source === 'local' && <><StarButton starred={r.starred} label={r.name} onToggle={() => mark(r.id, { starred: !r.starred })}/>
          <Tip label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`}><button type="button" className="icon-button" aria-pressed={r.hidden} aria-label={r.hidden ? `Show ${r.name}` : `Hide ${r.name}`} onClick={() => mark(r.id, { hidden: !r.hidden })}>{r.hidden ? <Eye size={14}/> : <EyeOff size={14}/>}</button></Tip></>}
        </li>)}</ul>}
  </div>;
}
