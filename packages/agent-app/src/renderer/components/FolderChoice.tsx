/**
 * Where a project's files live on this Mac (#303): the three ways to say so, shared by Settings (a list row and the project's own row). A git repository gets a
 * worktree and a branch for each task; any other folder is used as it is; and Muster can make a folder of its own when the project has none.
 */
import React, { useCallback } from 'react';
import { invoke } from '../bridge';
import { notifyError, notifySuccess } from '../store';
import { plainError } from './resourceErrors';
import { device } from '../../shared/device-noun.ts';

/** A failed command, worded for people (no command label in front). */
export const fail = (cause: unknown): void => notifyError(plainError(cause));
export const FOLDER_COPY = 'Where each project’s files live on '+device().lower+'. A git repository gets its own worktree and branch; any other folder is used as it is.';

export function useBindFolder(orgId: string, projectId: string, done: () => void) {
  const say = (b: { projectName: string; path: string; kind?: string; devBranch: string }) =>
    notifySuccess(b.kind === 'folder' ? `${b.projectName} now works in ${b.path}.` : `${b.projectName} now works from ${b.path} (branch ${b.devBranch}).`);
  const pick = useCallback(async (requireGit: boolean) => {
    try {
      const folder = await invoke('folder.pick', undefined);
      if (!folder) return;
      say(await invoke('checkout.bind', { orgId, projectId, path: folder.path, ...(requireGit ? { requireGit: true } : {}) })); done();
    } catch (cause) { fail(cause); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, done]);
  const create = useCallback(async () => {
    try { say(await invoke('checkout.bind', { orgId, projectId, create: true })); done(); } catch (cause) { fail(cause); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orgId, projectId, done]);
  return { create, folder: () => pick(false), repo: () => pick(true) };
}

/** The three choices as buttons (inside a menu on list rows, open on the project's own row). */
export function FolderChoices({ orgId, projectId, done, bound, open }: { orgId: string; projectId: string; done: () => void; bound: boolean; open?: boolean }): React.ReactElement {
  const bind = useBindFolder(orgId, projectId, done);
  const buttons = <span className="ws-folder-options">
    <button type="button" className="settings-button secondary" data-folder-choice="new" onClick={() => void bind.create()}>Use a new folder Muster creates</button>
    <button type="button" className="settings-button secondary" data-folder-choice="folder" onClick={() => void bind.folder()}>Choose a folder…</button>
    <button type="button" className="settings-button secondary" data-folder-choice="repo" onClick={() => void bind.repo()}>Use a git repository…</button>
  </span>;
  return open ? buttons : <details className="ws-folder-menu"><summary className="settings-button secondary">{bound ? 'Change…' : 'Choose…'}</summary>{buttons}</details>;
}
