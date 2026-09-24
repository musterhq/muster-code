import {promises as fs} from 'node:fs';
import {commitGit, createWorktree, fetchGit, gitInfo, headMessage, listBranches, listWorktrees, removeWorktree, switchBranch} from '../git-local.ts';
import {blameFile, commitDetail, compareRefs, listCommits, refDiff} from '../git-history.ts';
import {conflictFile, conflictState, continueOperation, markResolved, writeConflict} from '../git-conflicts.ts';
import {cancelClone, defaultDestination, disposeClones, startClone} from '../git-clone.ts';
import type {Folder} from '../../shared/protocol.ts';
import type {DomainContext, DomainModule} from './types.ts';

/** Git domain. Handlers are keyed by the command names in shared/domains/git-protocol.ts. All git runs with GIT_TERMINAL_PROMPT=0 (git-local). */
export function createGitDomain(context: DomainContext): DomainModule {
  const folder = (value: unknown): Folder => {
    if (typeof value !== 'string' || !value || value.length > 128) throw new Error('Choose a folder.');
    return context.folderFor(value);
  };
  const revision = (value: unknown) => {
    if (typeof value !== 'string' || !value || value.length > 64) throw new Error('Refresh the repository status and try again.');
    return value;
  };
  /** A run in the folder (directly, or through a project that includes it) owns its working tree. */
  const busy = (folderId: string) => {
    const snapshot = context.store.snapshot();
    const projects = new Set(snapshot.projects.filter(project => project.folderIds.includes(folderId)).map(project => project.id));
    return snapshot.chats.some(chat => (chat.status === 'running' || chat.status === 'stopping') && (chat.folderId === folderId || (!!chat.projectId && projects.has(chat.projectId))));
  };
  const folderAt = async (path: string) => {
    const real = await fs.realpath(path).catch(() => path);
    return context.store.snapshot().folders.find(entry => entry.path === real || entry.path === path);
  };
  const changed = (target: Folder) => context.emit({type: 'workspaceChanged', folderId: target.id});
  const worktrees = async (target: Folder, usage: boolean) => {
    const list = await listWorktrees(target.path, usage);
    return Promise.all(list.map(async entry => { const match = await folderAt(entry.path); return match ? {...entry, folderId: match.id} : entry; }));
  };
  return {handlers: {
    'git.branches': input => listBranches(folder(input.folderId).path),
    'git.info': input => gitInfo(folder(input.folderId).path),
    'git.headMessage': async input => ({message: await headMessage(folder(input.folderId).path)}),
    'git.switch': async input => {
      const target = folder(input.folderId);
      if (busy(target.id)) throw new Error('A chat is running in this folder. Stop it before switching branches.');
      const result = await switchBranch(target.path, {branch: input.branch, create: input.create === true, ...(input.base === undefined || input.base === '' ? {} : {base: input.base}), revision: revision(input.revision), carry: input.carry === true});
      if (!result.blocked) changed(target);
      return result;
    },
    'git.fetch': async input => { const target = folder(input.folderId); const result = await fetchGit(target.path); changed(target); return result; },
    'git.commit': async input => {
      const target = folder(input.folderId);
      const result = await commitGit(target.path, {revision: revision(input.revision), message: input.message, amend: input.amend === true, push: input.push === true});
      changed(target); return result;
    },
    'git.worktree.create': async input => {
      const source = folder(input.folderId);
      const created = await createWorktree(source.path, context.dataDir, {branch: input.branch, ...(input.base === undefined || input.base === '' ? {} : {base: input.base})});
      const added = await context.invoke('folder.add', {path: created.path});
      return {folder: added, ...created};
    },
    'git.worktree.list': input => worktrees(folder(input.folderId), input.usage === true),
    'git.worktree.remove': async input => {
      const source = folder(input.folderId);
      if (typeof input.path !== 'string') throw new Error('Choose a worktree.');
      const owner = await folderAt(input.path);
      if (owner && busy(owner.id)) throw new Error('A chat is running in this worktree. Stop it before removing the worktree.');
      await removeWorktree(source.path, input.path);
      if (owner) changed(owner);
      return worktrees(source, false);
    },
    // History, compare, blame (GIT-11): read-only.
    'git.log': input => listCommits(folder(input.folderId).path, {ref: input.ref, skip: input.skip, limit: input.limit, path: input.path}),
    'git.commitDetail': input => commitDetail(folder(input.folderId).path, input.sha),
    'git.compare': input => compareRefs(folder(input.folderId).path, {base: input.base, head: input.head}),
    'git.refDiff': input => refDiff(folder(input.folderId).path, {base: input.base, head: input.head, path: input.path, previousPath: input.previousPath}),
    'git.blame': input => blameFile(folder(input.folderId).path, input.path),
    // Merge conflicts (GIT-13). Writes emit workspaceChanged so the Changes pane and open file tabs refresh.
    'git.conflicts': input => conflictState(folder(input.folderId).path),
    'git.conflictFile': input => conflictFile(folder(input.folderId).path, input.path),
    'git.conflictWrite': async input => {
      const target = folder(input.folderId);
      const state = await writeConflict(target.path, {path: input.path, content: input.content, revision: input.revision, markResolved: input.markResolved === true});
      changed(target); return state;
    },
    'git.conflictMarkResolved': async input => { const target = folder(input.folderId); const state = await markResolved(target.path, input.paths); changed(target); return state; },
    'git.conflictContinue': async input => {
      const target = folder(input.folderId);
      if (busy(target.id)) throw new Error('A chat is running in this folder. Stop it before continuing or aborting.');
      const result = await continueOperation(target.path, input.action);
      changed(target); return result;
    },
    // Clone (GIT-10): progress streams as gitClone events; the finished checkout is added as a folder before the done event.
    'git.clone.start': input => startClone({url: input.url, destination: input.destination}, event => context.emit(event), path => context.invoke('folder.add', {path})),
    'git.clone.cancel': input => { cancelClone(input.id); },
    'git.clone.defaultDestination': input => defaultDestination(input.url, input.parent),
    'git.clone.pickDestination': async () => { throw new Error('The destination picker is only available from the desktop window.'); },
  }, dispose() { disposeClones(); }};
}
