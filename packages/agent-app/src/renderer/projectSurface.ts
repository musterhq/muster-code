/** S3-G / PRJ-X3 pure helpers for the Projects surface (Edit project dialog, sidebar hover card, Agents section). No DOM, no bridge. */
import type { Chat } from '../shared/protocol.ts';
import type { ProjectDetails, ProjectTaskView, TaskAttempt } from '../shared/domains/projects-protocol.ts';

/** "~/code/app" for paths under the user's home; anything else unchanged. Display only. */
export function shortPath(path: string): string { return path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~'); }

/** The sidebar's snapshot Project as the dialogs expect it (primary defaults to the first folder). */
export function toProjectDetails(p: { id: string; name: string; goal: string; folderIds: string[]; primaryFolderId?: string | null; archived?: boolean }): ProjectDetails {
  return { id: p.id, name: p.name, goal: p.goal, folderIds: p.folderIds, primaryFolderId: p.primaryFolderId ?? p.folderIds[0] ?? null, archived: Boolean(p.archived), archivedAt: null };
}

export interface ProjectDraft { name: string; goal: string; folderIds: string[] }
/** The one project.update the Edit project dialog sends, or null when nothing changed. Primary is the first folder. */
export function projectEditPatch(project: Pick<ProjectDetails, 'id' | 'name' | 'goal' | 'folderIds' | 'primaryFolderId'>, draft: ProjectDraft): { id: string; name?: string; goal?: string; folderIds?: string[]; primaryFolderId?: string | null } | null {
  const patch: { id: string; name?: string; goal?: string; folderIds?: string[]; primaryFolderId?: string | null } = { id: project.id };
  const name = draft.name.trim();
  if (name !== project.name) patch.name = name;
  if (draft.goal !== project.goal) patch.goal = draft.goal;
  const currentPrimary = project.primaryFolderId ?? project.folderIds[0] ?? null;
  const sameSet = draft.folderIds.length === project.folderIds.length && draft.folderIds.every(id => project.folderIds.includes(id));
  if (!sameSet) patch.folderIds = draft.folderIds;
  if ((draft.folderIds[0] ?? null) !== currentPrimary) patch.primaryFolderId = draft.folderIds[0] ?? null;
  return Object.keys(patch).length > 1 ? patch : null;
}

/** What the hover card needs beyond the snapshot: open/running task counts and the newest activity time. */
export interface ProjectGlance { openTasks: number; runningTasks: number; lastActivityAt: string | null }
const OPEN = new Set(['todo', 'running', 'needs-input', 'blocked', 'review', 'implemented']);
const RUNNING = new Set(['running', 'needs-input']);

export function projectGlance(tasks: readonly Pick<ProjectTaskView, 'state' | 'updatedAt'>[], activityAt: string | null, chats: readonly Pick<Chat, 'updatedAt' | 'archived'>[]): ProjectGlance {
  const times = [activityAt, ...tasks.map(t => t.updatedAt), ...chats.filter(c => !c.archived).map(c => c.updatedAt)].filter((t): t is string => Boolean(t));
  const lastActivityAt = times.length ? times.reduce((a, b) => (Date.parse(b) > Date.parse(a) ? b : a)) : null;
  return { openTasks: tasks.filter(t => OPEN.has(t.state)).length, runningTasks: tasks.filter(t => RUNNING.has(t.state)).length, lastActivityAt };
}

export interface AgentRun { task: Pick<ProjectTaskView, 'id' | 'title' | 'state'>; attempt: TaskAttempt }
/** Every task-run attempt, running first, then newest. Capped so a long-lived Project stays quick to scan. */
export function agentRuns(tasks: readonly ProjectTaskView[], limit = 30): AgentRun[] {
  return tasks.flatMap(task => task.attempts.map(attempt => ({ task, attempt })))
    .sort((a, b) => Number(b.attempt.status === 'running') - Number(a.attempt.status === 'running') || b.attempt.startedAt.localeCompare(a.attempt.startedAt))
    .slice(0, limit);
}

