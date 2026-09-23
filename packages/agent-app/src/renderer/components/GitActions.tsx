import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FolderGit2} from 'lucide-react';
import type {GitLocalStatus} from '../../shared/protocol';
import {invoke, subscribe} from '../bridge';
import {loadGitChanges, notifySuccess} from '../store';
import {gitErrorMessage, isNotGitRepository} from './resourceErrors';
import {Tip} from './Tooltip';
import './git-actions.css';
import './git-review.css';

/**
 * The local repository behind the Git tab's Changes view: `git status` (kept live on workspaceChanged),
 * stage/unstage, Stage all and Commit (optionally amend, optionally push). One instance per mounted view;
 * mutations are serialised so a double click never races the index.
 */
export interface GitRepository {
  status?: GitLocalStatus;
  error: string;
  loading: boolean;
  busy: false | 'change' | 'commit' | 'push';
  notRepo: boolean;
  refresh: () => Promise<void>;
  stage: (paths: string[]) => Promise<void>;
  unstage: (paths: string[]) => Promise<void>;
  stageAll: () => Promise<void>;
  commit: (options: {message: string; amend: boolean; push: boolean}) => Promise<boolean>;
}

export function useGitRepository(folderId: string): GitRepository {
  const [status, setStatus] = useState<GitLocalStatus>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<GitRepository['busy']>(false);
  const request = useRef(0), alive = useRef(true), locked = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; request.current++; }; }, []);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    try {
      const next = await invoke('git.status', {folderId});
      if (alive.current && token === request.current) { setStatus(next ?? undefined); setError(''); }
    } catch (cause) {
      if (alive.current && token === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { if (alive.current && token === request.current) setLoading(false); }
  }, [folderId]);
  useEffect(() => {
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(event => {
      if (event.type !== 'workspaceChanged' || event.folderId !== folderId || locked.current) return;
      clearTimeout(timer); timer = setTimeout(() => void refresh(), 200);
    });
    return () => { unsubscribe(); clearTimeout(timer); request.current++; };
  }, [folderId, refresh]);
  const run = async (kind: Exclude<GitRepository['busy'], false>, work: () => Promise<void>): Promise<boolean> => {
    if (!status || locked.current) return false;
    locked.current = true; setBusy(kind); setError(''); request.current++;
    try { await work(); return true; }
    catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); return false; }
    finally { locked.current = false; if (alive.current) setBusy(false); }
  };
  const mutate = (operation: 'stage' | 'unstage', paths: string[]) => run('change', async () => {
    if (!paths.length) return;
    const next = await invoke('git.mutate', {folderId, operation, revision: status!.revision, paths});
    if (!alive.current) return;
    setStatus(next); void loadGitChanges(folderId);
  }).then(() => undefined);
  const stageAll = () => run('change', async () => {
    await invoke('review.stageAll', {folderId});
    if (!alive.current) return;
    setStatus(await invoke('git.status', {folderId})); void loadGitChanges(folderId);
  }).then(() => undefined);
  const commit = ({message, amend, push}: {message: string; amend: boolean; push: boolean}) => run(push ? 'push' : 'commit', async () => {
    const result = await invoke('git.commit', {folderId, revision: status!.revision, message, amend, push});
    if (!alive.current) return;
    setStatus(result.status);
    if (result.pushError) setError(`Committed, but the push failed: ${result.pushError}`);
    else notifySuccess(push ? `${amend ? 'Amended' : 'Committed'} and pushed to ${result.status.upstream ?? 'the remote'}` : amend ? 'Amended the last commit' : 'Committed');
    void loadGitChanges(folderId);
  });
  return {status, error, loading, busy, notRepo: !status && isNotGitRepository(error), refresh, stage: paths => mutate('stage', paths), unstage: paths => mutate('unstage', paths), stageAll, commit};
}

/** Commit message + Amend + Commit / Commit & Push. The primary button names how many staged files it commits. */
export function CommitBox({folderId, repo}: {folderId: string; repo: GitRepository}): React.ReactElement | null {
  const [amend, setAmend] = useState(false);
  const [message, setMessage] = useState('');
  const {status, busy, loading} = repo;
  if (!status) return null;
  const toggleAmend = async (next: boolean) => {
    setAmend(next);
    if (!next || message.trim()) return;
    try { const {message: last} = await invoke('git.headMessage', {folderId}); if (last) setMessage(current => current.trim() ? current : last); }
    catch { /* the user can still type a message */ }
  };
  const submit = async (push: boolean) => {
    if (await repo.commit({message, amend, push})) { setMessage(''); setAmend(false); }
  };
  const staged = status.stagedCount;
  const why = status.conflicted ? 'Resolve the merge conflicts first'
    : status.truncated ? 'Too many changes to commit here; use the terminal'
    : !amend && staged === 0 ? 'Stage the files you want to commit first'
    : amend && (status.unborn || status.detached) ? 'There is no branch commit to amend'
    : !message.trim() ? 'Write a commit message first'
    : null;
  const canCommit = !why && !busy && !loading;
  const commitLabel = busy === 'commit' ? 'Committing…' : amend ? 'Amend commit' : staged ? `Commit ${staged} staged` : 'Commit';
  return <form className="git-commit-box" aria-label="Commit" onSubmit={event => { event.preventDefault(); if (canCommit) void submit(false); }}>
    <textarea aria-label="Commit message" placeholder={amend ? 'Amended commit message' : staged ? `Message for ${staged} staged ${staged === 1 ? 'file' : 'files'}` : 'Commit message'} value={message} maxLength={32768} rows={2} disabled={!!busy}
      onChange={event => setMessage(event.target.value)}
      onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && canCommit) { event.preventDefault(); void submit(event.shiftKey && !!status.pushRemote); } }}/>
    <div className="git-commit-row">
      <Tip label={status.unborn ? 'There is no commit to amend yet' : 'Replace the last commit with the staged changes and this message'}>
        <label className="git-amend">
          <input type="checkbox" checked={amend} disabled={!!busy || status.unborn || status.detached} onChange={event => void toggleAmend(event.target.checked)}/>Amend
        </label>
      </Tip>
      <Tip label={status.pushRemote ? `Commit, then push to ${status.upstream ?? status.pushRemote}` : 'Add a remote to push'} shortcut="⇧⌘↵" disabledReason={why ?? (status.pushRemote ? null : 'This repository has no remote to push to')}>
        <button type="button" disabled={!canCommit || !status.pushRemote} onClick={() => void submit(true)}>{busy === 'push' ? 'Pushing…' : amend ? 'Amend & Push' : 'Commit & Push'}</button>
      </Tip>
      <Tip label={amend ? 'Amend the last commit' : 'Commit the staged files'} shortcut="⌘↵" disabledReason={why}>
        <button type="submit" className="is-primary" disabled={!canCommit}>{commitLabel}</button>
      </Tip>
    </div>
  </form>;
}

/**
 * Standalone commit panel for a folder (outside the Git tab). A folder that isn't a Git repository
 * collapses to one quiet line: per-turn change tracking already works without Git.
 */
export function GitActions({folderId}: {folderId: string}): React.ReactElement {
  const repo = useGitRepository(folderId);
  if (repo.notRepo) return <div className="git-actions git-actions-neutral">
    <FolderGit2 size={15} aria-hidden="true"/><span>Not a Git repository — changes are tracked per turn</span>
  </div>;
  return <div className="git-actions" aria-busy={!!repo.busy || repo.loading}>
    {repo.error && <p className="git-action-error" role="alert">{gitErrorMessage(repo.error) ?? 'Repository status unavailable.'}</p>}
    {repo.loading && !repo.status && <p role="status" className="git-clean">Reading repository…</p>}
    <CommitBox folderId={folderId} repo={repo}/>
  </div>;
}
