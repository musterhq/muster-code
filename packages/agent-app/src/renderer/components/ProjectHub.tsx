/**
 * Project-scoped Roster and Outputs (#115, #117, #128): each project has its own hierarchy and its own outputs, so the
 * Roster graph, "talking now" edges, memory badges, Pulse and Outputs are all filtered to one project. Used as tabs in
 * every project's page (ProjectPage.tsx).
 */
import React, { useMemo } from 'react';
import type { WorkspaceSnapshot } from '../../shared/domains/paperclip-protocol';
import { NAMES } from '../../shared/workspace-names';
import { openHub, useWorkspace } from '../hubStore';
import { ListPage, PulseBoard, type HubNav } from './HubPages';
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
  if (project?.source === 'local') keep.add('user:local');
  // A Muster project's Roster is its own members, whether or not they have work yet.
  for (const a of snapshot.agents) if (a.projectId === projectId) keep.add(a.id);
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
    <PulseBoard snapshot={scoped} nav={nav} scoped projectId={projectId}/>
  </div>;
}

/** Project › Outputs: files and documents produced for this project. */
export function ProjectOutputs({ projectId }: { projectId: string }): React.ReactElement {
  return <div className="ws-project-outputs"><ListPage kind="artifacts" embedded projectId={projectId}/></div>;
}
