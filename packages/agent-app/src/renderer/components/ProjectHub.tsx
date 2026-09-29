/**
 * Project-scoped Roster and Outputs (#115, #117, #128): each project has its own hierarchy and its own outputs, so the
 * Roster graph, "talking now" edges, memory badges, Pulse and Outputs are all filtered to one project. Used as tabs in
 * Muster's project view and on a Paperclip project's page.
 */
import { FolderClosed } from 'lucide-react';
import React, { useMemo, useState } from 'react';
import type { WorkspaceSnapshot, WorkspaceTask } from '../../shared/domains/paperclip-protocol';
import { OPEN_STATUSES } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { openHub, useWorkspace } from '../hubStore';
import { agoLabel, exactTime } from '../relativeTime';
import { ListPage, PageHeader, PulseBoard, type HubNav } from './HubPages';
import { TaskStatusIcon } from './HubParts';
import { ResourceState } from './ResourceState';
import { RosterGraph } from './RosterGraph';
import { selectChat, closeSettings } from '../store';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './hub.css';

/** One project's slice: its tasks and runs, the agents working on them plus everyone they report to, its inbox. */
export function scopeToProject(snapshot: WorkspaceSnapshot, projectId: string): WorkspaceSnapshot {
  const tasks = snapshot.tasks.filter(t => t.projectId === projectId), taskIds = new Set(tasks.map(t => t.id));
  const byId = new Map(snapshot.agents.map(a => [a.id, a])), keep = new Set<string>();
  const project = snapshot.projects.find(p => p.id === projectId);
  if (project?.source === 'local') { keep.add('user:local'); keep.add(`agent:${projectId}`); }
  for (const t of tasks) if (t.assigneeId) keep.add(t.assigneeId);
  for (const r of snapshot.runs) if (r.taskId && taskIds.has(r.taskId) && r.agentId) keep.add(r.agentId);
  for (const id of [...keep]) { let boss = byId.get(id)?.reportsTo; const seen = new Set<string>(); while (boss && byId.has(boss) && !seen.has(boss)) { seen.add(boss); keep.add(boss); boss = byId.get(boss)?.reportsTo; } }
  return {
    ...snapshot, tasks, agents: snapshot.agents.filter(a => keep.has(a.id)), projects: project ? [project] : [],
    runs: snapshot.runs.filter(r => r.taskId && taskIds.has(r.taskId)), inbox: snapshot.inbox.filter(i => i.projectId === projectId || (i.taskId && taskIds.has(i.taskId))),
  };
}

const defaultNav: HubNav = { onOpenTask: id => openHub('task', id), onOpenAgent: id => openHub('agent', id), onOpenChat: id => { void selectChat(id); closeSettings(); } };

/** Project › Roster: this project's org graph and its Pulse. */
export function ProjectRoster({ projectId, nav = defaultNav }: { projectId: string; nav?: HubNav }): React.ReactElement {
  const { snapshot, error } = useWorkspace();
  const scoped = useMemo(() => snapshot ? scopeToProject(snapshot, projectId) : null, [snapshot, projectId]);
  if (error && !scoped) return <ResourceState kind="error" message="The roster could not be read." detail={error}/>;
  if (!scoped) return <ResourceState kind="loading" label="Loading the roster" rows={3}/>;
  const working = scoped.agents.filter(a => a.status === 'running').length;
  return <div className="ws-project-roster">
    <p className="ws-project-note">{scoped.agents.filter(a => a.role !== 'board').length} agents on this project · {working} working now. Lines show who reports to whom; a dashed blue line is a live conversation.</p>
    {scoped.agents.length ? <RosterGraph snapshot={scoped} onOpenAgent={nav.onOpenAgent} onOpenTask={nav.onOpenTask}/> : <ResourceState kind="empty" message="No agents have worked on this project yet."/>}
    <PulseBoard snapshot={scoped} nav={nav} scoped/>
  </div>;
}

/** Project › Outputs: files and documents produced for this project. */
export function ProjectOutputs({ projectId }: { projectId: string }): React.ReactElement {
  return <div className="ws-project-outputs"><ListPage kind="artifacts" embedded projectId={projectId}/></div>;
}

/** A Paperclip project's page (Muster projects use their own project view): Tasks, Roster, Outputs. */
export function ProjectPage({ snapshot, projectId, nav }: { snapshot: WorkspaceSnapshot; projectId: string; nav: HubNav }): React.ReactElement {
  const [tab, setTab] = useState<'tasks' | 'roster' | 'outputs'>('tasks');
  const project = snapshot.projects.find(p => p.id === projectId);
  if (!project) return <ResourceState kind="empty" message="This project is no longer in the linked Paperclip."/>;
  return <div className="ws-page ws-page-fill">
    <PageHeader title={project.name} detail={<>{project.repo ?? project.cwd ?? 'No repository'} · {project.openCount} open of {project.taskCount} {project.source === 'paperclip' && <span className="ws-source">{NAMES.paperclip}</span>}</>}>
      <div className="ws-segmented is-inline" role="tablist" aria-label="Project views">{([['tasks', NAMES.tasks], ['roster', NAMES.roster], ['outputs', NAMES.outputs]] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className="ws-segment" onClick={() => setTab(id)}><span className="ws-segment-label">{label}</span></button>)}</div>
    </PageHeader>
    {tab === 'roster' ? <ProjectRoster projectId={projectId} nav={nav}/> : tab === 'outputs' ? <ProjectOutputs projectId={projectId}/> : <ProjectTaskList snapshot={snapshot} projectId={projectId} nav={nav}/>}
  </div>;
}

function ProjectTaskList({ snapshot, projectId, nav }: { snapshot: WorkspaceSnapshot; projectId: string; nav: HubNav }): React.ReactElement {
  const tasks = snapshot.tasks.filter(t => t.projectId === projectId);
  const ids = new Set(tasks.map(t => t.id));
  const rank = (t: WorkspaceTask) => t.live ? 0 : OPEN_STATUSES.includes(t.status) ? 1 : 2;
  const sorted = (list: WorkspaceTask[]) => [...list].sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt));
  const rows: { task: WorkspaceTask; depth: number }[] = [];
  const walk = (t: WorkspaceTask, depth: number) => { rows.push({ task: t, depth }); for (const c of sorted(tasks.filter(x => x.parentId === t.id))) walk(c, depth + 1); };
  for (const t of sorted(tasks.filter(t => !t.parentId || !ids.has(t.parentId)))) walk(t, 0);
  if (!rows.length) return <ResourceState kind="empty" icon={<FolderClosed size={20}/>} message="No tasks in this project yet."/>;
  return <ul className="ws-rows ws-project-tasks">{rows.map(({ task: t, depth }) => <li key={t.id}><button type="button" className="ws-row" style={{ paddingLeft: 12 + depth * 20 }} onClick={() => nav.onOpenTask(t.id)}>
    <TaskStatusIcon status={t.status}/><span className="ws-key">{t.key}</span><span className="ws-row-title ws-grow">{t.title}</span>
    {t.live && <span className="ws-live"><span className="ws-live-dot"/>live</span>}
    <span className="ws-row-count">{t.assigneeLabel ?? 'Unassigned'}</span><span className="ws-row-age" title={exactTime(t.updatedAt)}>{agoLabel(t.updatedAt)}</span>
  </button></li>)}</ul>;
}
