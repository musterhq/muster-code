/**
 * #409: what each history-graph commit action does, in words the confirm dialog shows, and what blocks it.
 * Pure rules (no React, no store); components/CommitActions.tsx asks, runtime/git-commit-actions.ts enforces the same guards.
 */
import type {Chat, Folder, GitLocalStatus, Project} from '../shared/protocol.ts';
import type {GitCommit, GitCommitAction} from '../shared/domains/git-protocol.ts';
import {checkoutKey, isRunActive} from './parallelRuns.ts';

/** Where the commit action lands: the checked-out branch, or null when HEAD is detached. */
export interface CommitActionTarget {branch: string | null}

export function headLabel(target: CommitActionTarget): string { return target.branch ?? 'the checked-out commit'; }

/** Actions that change HEAD or the working tree. Creating a branch only does when it also switches to it. */
export function changesHead(action: GitCommitAction, checkout = false): boolean { return action !== 'branch' || checkout; }

export interface CommitActionCopy {title: string; description: string; confirm: string; destructive: boolean}

/** The dialog's title, one-paragraph description and confirm label: exactly what will happen. */
export function describeCommitAction(action: GitCommitAction, commit: Pick<GitCommit, 'short' | 'subject' | 'parents'>, target: CommitActionTarget, options: {checkout?: boolean; branchName?: string} = {}): CommitActionCopy {
  const named = `${commit.short} “${commit.subject}”`;
  const here = headLabel(target);
  const merge = commit.parents.length > 1 ? ' It is a merge commit, so its changes are taken against its first parent.' : '';
  const conflicts = ' If they conflict, the repository stops with the conflicted files for you to resolve in the conflict view, or abort.';
  switch (action) {
    case 'checkout':
      return {title: `Check out ${commit.short}?`, confirm: 'Check out', destructive: false,
        description: `Switches this folder to ${named} without a branch (detached HEAD).${target.branch ? ` ${target.branch} stays where it is.` : ''} Commits you make there belong to no branch until you create one.`};
    case 'branch': {
      const name = options.branchName?.trim() || 'the new branch';
      return {title: `Create a branch at ${commit.short}`, confirm: 'Create branch', destructive: false,
        description: options.checkout ? `Creates ${name} at ${named} and switches this folder to it.` : `Creates ${name} at ${named}. Nothing else changes; what is checked out stays as it is.`};
    }
    case 'cherry-pick':
      return {title: `Cherry-pick ${commit.short} onto ${here}?`, confirm: 'Cherry-pick', destructive: false,
        description: `Applies the changes from ${named} on top of ${here} as a new commit.${merge}${conflicts}`};
    case 'revert':
      return {title: `Revert ${commit.short}?`, confirm: 'Revert', destructive: true,
        description: `Adds a new commit on ${here} that undoes ${named}. The original commit stays in history.${merge}${conflicts}`};
  }
}

/** Tracked files with staged or unstaged changes: they block any action that changes HEAD. Untracked files do not. */
export function blockingChanges(status: Pick<GitLocalStatus, 'files'>): string[] {
  return status.files.filter(file => !file.untracked).map(file => file.path);
}

export function blockingMessage(paths: readonly string[], action: GitCommitAction): string {
  const verb = action === 'checkout' ? 'checking out this commit' : action === 'branch' ? 'switching to the new branch' : action === 'cherry-pick' ? 'the cherry-pick' : 'the revert';
  const shown = paths.slice(0, 5).join(', ') + (paths.length > 5 ? `, and ${paths.length - 5} more` : '');
  return `${paths.length === 1 ? '1 uncommitted file' : `${paths.length} uncommitted files`} (${shown}) would be affected by ${verb}. Commit or stash ${paths.length === 1 ? 'it' : 'them'} first; Muster won’t run this over uncommitted work.`;
}

/** Chats mid-run in this folder's checkout (same path) or in a project that includes the folder: changing HEAD moves the ground under them. */
export function runningChatsIn(folderId: string, snapshot: {chats: readonly Chat[]; folders: readonly Pick<Folder, 'id' | 'path'>[]; projects?: readonly Pick<Project, 'id' | 'folderIds'>[]} | null | undefined): Chat[] {
  if (!snapshot) return [];
  const key = checkoutKey(folderId, snapshot.folders);
  const projects = new Set((snapshot.projects ?? []).filter(project => project.folderIds.includes(folderId)).map(project => project.id));
  return snapshot.chats.filter(chat => !chat.archived && isRunActive(chat) && (checkoutKey(chat.folderId, snapshot.folders) === key || (!!chat.projectId && projects.has(chat.projectId))));
}

export function runningWarning(chats: readonly Pick<Chat, 'title'>[]): string {
  const names = chats.slice(0, 2).map(chat => `“${chat.title || 'Untitled chat'}”`).join(' and ') + (chats.length > 2 ? ` and ${chats.length - 2} more` : '');
  return `${names} ${chats.length === 1 ? 'is' : 'are'} running in this folder. Changing what is checked out under ${chats.length === 1 ? 'it' : 'them'} can mix up ${chats.length === 1 ? 'its' : 'their'} work.`;
}
