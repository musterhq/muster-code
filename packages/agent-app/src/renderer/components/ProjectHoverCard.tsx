import { CircleDot, FolderOpen, Layers, ListChecks, Settings2 } from 'lucide-react';
import React, { useEffect, useState } from 'react';
import type { Chat, Folder, Project } from '../../shared/protocol';
import type { ProjectTaskView } from '../../shared/domains/projects-protocol';
import { invoke } from '../bridge';
import { agoLabel, exactTime } from '../relativeTime.ts';
import { plural } from '../../shared/wording.ts';
import { projectGlance, shortPath } from '../projectSurface';

// A short cache so sweeping the pointer down the sidebar does not refetch every project each time.
const cache = new Map<string, { at: number; tasks: ProjectTaskView[]; activityAt: string | null }>();
const FRESH_MS = 15_000;

/** Codex's project hover card: name, goal, task counts, source folders, last activity and Edit project. Fetches on open only. */
export function ProjectHoverCard({ project, folders, chats, onEdit, onOpen }: { project: Project; folders: readonly Folder[]; chats: readonly Chat[]; onEdit: () => void; onOpen: () => void }) {
  const cached = cache.get(project.id);
  const [data, setData] = useState(cached ?? null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (cached && Date.now() - cached.at < FRESH_MS) return;
    let cancelled = false;
    invoke('project.work', { projectId: project.id, activityLimit: 1 })
      .then(work => { const next = { at: Date.now(), tasks: work.tasks.items, activityAt: work.activity.items[0]?.createdAt ?? null }; cache.set(project.id, next); if (!cancelled) setData(next); })
      .catch(() => { if (!cancelled) setFailed(true); });
    return () => { cancelled = true; };
  }, [project.id]);
  const primary = project.primaryFolderId ?? project.folderIds[0];
  const linked = project.folderIds.map(id => folders.find(f => f.id === id)).filter((f): f is Folder => Boolean(f));
  const runningChats = chats.filter(c => !c.archived && (c.status === 'running' || c.status === 'stopping')).length;
  const glance = projectGlance(data?.tasks ?? [], data?.activityAt ?? null, chats);
  const running = glance.runningTasks + runningChats;
  return <div className="project-hover" data-testid="project-hover-card">
    <div className="project-hover-title"><Layers size={14} aria-hidden="true"/><span>{project.name}</span>{project.archived && <small>Archived</small>}</div>
    <p className={`project-hover-goal${project.goal.trim() ? '' : ' is-empty'}`}>{project.goal.trim() || 'No shared goal yet.'}</p>
    <div className="project-hover-stats">
      <span><ListChecks size={13} aria-hidden="true"/>{data ? plural(glance.openTasks, 'open task') : failed ? 'Tasks unavailable' : 'Loading tasks…'}</span>
      {running > 0 && <span className="is-running"><CircleDot size={13} aria-hidden="true"/>{running} running</span>}
    </div>
    <ul className="project-hover-folders" aria-label="Source folders">
      {linked.length === 0 ? <li className="is-empty">No folders linked</li>
        : linked.slice(0, 4).map(f => <li key={f.id} title={f.path}><FolderOpen size={13} aria-hidden="true"/><span>{shortPath(f.path)}</span>{f.id === primary && linked.length > 1 && <small>Primary</small>}</li>)}
      {linked.length > 4 && <li className="is-empty">+{linked.length - 4} more</li>}
    </ul>
    <div className="project-hover-foot">
      <span title={glance.lastActivityAt ? exactTime(glance.lastActivityAt) : undefined}>{glance.lastActivityAt ? `Active ${agoLabel(glance.lastActivityAt)}` : data ? 'No activity yet' : ''}</span>
      <span className="project-hover-actions">
        <button type="button" onClick={onOpen}>Open</button>
        <button type="button" onClick={onEdit}><Settings2 size={13} aria-hidden="true"/>Edit project</button>
      </span>
    </div>
  </div>;
}
