/** Assign & start runs each Muster task in its own worktree of the project's folder, on a muster/<key> branch, which
 *  lives at <data>/worktrees/<repo>/muster-<key> and is linked to the project. Those folders belong under the project's
 *  task rows, so the sidebar's Folders list leaves them out (the chats in them stay reachable through the project). */
import type { Folder, Project } from '../shared/protocol';

const TASK_WORKTREE = /[/\\]worktrees[/\\][^/\\]+[/\\]muster-[^/\\]+$/;
export const isTaskWorktreePath = (path: string): boolean => TASK_WORKTREE.test(path);

/** Folders that are a project's task worktrees: linked to a project, not its primary folder, at a task worktree path. */
export function taskWorktreeFolderIds(snapshot: { folders: readonly Folder[]; projects: readonly Project[] }): Set<string> {
  const byId = new Map(snapshot.folders.map(f => [f.id, f]));
  const ids = new Set<string>();
  for (const project of snapshot.projects) {
    const primary = project.primaryFolderId ?? project.folderIds[0];
    for (const id of project.folderIds) { const folder = byId.get(id); if (id !== primary && folder && isTaskWorktreePath(folder.path)) ids.add(id); }
  }
  return ids;
}
