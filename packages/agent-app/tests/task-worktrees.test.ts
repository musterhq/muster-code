/** Assign & start worktrees stay out of the sidebar's Folders list: they belong under their project's tasks. */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isTaskWorktreePath, taskWorktreeFolderIds } from '../src/renderer/taskWorktrees.ts';

test('a project’s task worktree folders are told apart from its own folders and from other worktrees', () => {
  assert.equal(isTaskWorktreePath('/Users/me/Library/Application Support/Muster Agent/worktrees/real-repo/muster-ba-3'), true);
  assert.equal(isTaskWorktreePath('C:\\Users\\me\\AppData\\Muster Agent\\worktrees\\repo\\muster-sp-1'), true);
  assert.equal(isTaskWorktreePath('/Users/me/data/worktrees/repo/feature-login'), false, 'a worktree you made yourself stays a folder');
  assert.equal(isTaskWorktreePath('/Users/me/code/muster-app'), false);
  const folders = [
    { id: 'repo', name: 'real-repo', path: '/Users/me/code/real-repo' },
    { id: 'wt', name: 'muster-ba-3', path: '/data/worktrees/real-repo/muster-ba-3' },
    { id: 'mine', name: 'feature', path: '/data/worktrees/real-repo/feature' },
    { id: 'loose', name: 'muster-x-1', path: '/data/worktrees/other/muster-x-1' },
  ];
  const projects = [{ id: 'p', name: 'BA', goal: '', folderIds: ['repo', 'wt', 'mine'], primaryFolderId: 'repo' }];
  assert.deepEqual([...taskWorktreeFolderIds({ folders, projects })], ['wt'], 'only the linked task worktree; an unlinked one still shows');
});
