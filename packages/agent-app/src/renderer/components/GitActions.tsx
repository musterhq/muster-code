import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Collapsible} from '@base-ui/react/collapsible';
import {ChevronRight, GitBranch, Plus, Minus, RefreshCw} from 'lucide-react';
import type {GitLocalStatus} from '../../shared/protocol';
import {invoke, subscribe} from '../bridge';
import {loadGitChanges, openDiff} from '../store';
import {useDisclosure} from './useDisclosure';
import './git-actions.css';

export function GitActions({folderId}: {folderId: string}) {
  const [open, setOpen] = useDisclosure('git:' + folderId);
  const [status, setStatus] = useState<GitLocalStatus>();
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const request = useRef(0), alive = useRef(true), locked = useRef(false);
  useEffect(() => {alive.current = true; return () => {alive.current = false; request.current++;};}, []);
  const refresh = useCallback(async () => {
    const token = ++request.current;
    setLoading(true);
    try {
      const next = await invoke('git.status', {folderId});
      if (alive.current && token === request.current) {setStatus(next); setError('');}
    } catch (cause) {
      if (alive.current && token === request.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {if (alive.current && token === request.current) setLoading(false);}
  }, [folderId]);
  useEffect(() => {
    if (!open) return;
    void refresh();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = subscribe(event => {
      if (event.type !== 'workspaceChanged' || event.folderId !== folderId || locked.current) return;
      clearTimeout(timer); timer = setTimeout(() => void refresh(), 200);
    });
    return () => {unsubscribe(); clearTimeout(timer); request.current++;};
  }, [open, folderId, refresh]);
  const mutate = async (operation: 'stage'|'unstage'|'commit', path?: string) => {
    if (!status || locked.current || loading) return;
    locked.current = true; setBusy(true); setError(''); request.current++;
    try {
      const next = await invoke('git.mutate', {folderId, operation, revision: status.revision,
        ...(path ? {paths: [path]} : {}), ...(operation === 'commit' ? {message} : {})});
      if (!alive.current) return;
      setStatus(next);
      if (operation === 'commit') setMessage('');
      void loadGitChanges(folderId);
    } catch (cause) {
      if (alive.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {locked.current = false; if (alive.current) setBusy(false);}
  };
  return <Collapsible.Root open={open} onOpenChange={setOpen} className="git-actions">
    <Collapsible.Trigger className="git-actions-trigger"><GitBranch size={15}/><span>Repository</span><ChevronRight size={13} className="tool-chevron"/></Collapsible.Trigger>
    <Collapsible.Panel className="activity-disclosure">
      <div className="git-actions-body" aria-busy={busy || loading}>
        <header><span title={status?.branch}>{status?.detached ? 'Detached HEAD' : status?.branch || 'Local Git'}{status?.unborn ? ' · No commits yet' : ''}</span>
          <button className="icon-button" disabled={busy || loading} aria-label="Refresh repository status" onClick={() => void refresh()}><RefreshCw size={13}/></button></header>
        {error && <p className="git-action-error" role="alert">{error}</p>}
        {loading && !status && <p role="status">Reading repository…</p>}
        {status && <>
          {status.conflicted && <p className="git-action-error">Resolve merge conflicts before committing.</p>}
          {!status.files.length && <p className="git-clean">Working tree clean</p>}
          <ul className="git-action-files">{status.files.map(file => <li key={file.path}>
            <span className="git-index-state" title={file.conflict ? 'Conflict' : `${file.staged ? 'Staged' : 'Not staged'}; working tree: ${file.worktree}`}>{file.conflict ? '!' : file.index + file.worktree}</span>
            <button className="git-file-link" title={file.previousPath ? `${file.previousPath} → ${file.path}` : file.path} onClick={() => void openDiff(folderId, file.path)}>{file.path}</button>
            {file.staged && <button className="icon-button" disabled={busy || loading} aria-label={`Unstage ${file.path}`} title="Unstage" onClick={() => void mutate('unstage',file.path)}><Minus size={13}/></button>}
            {(file.untracked || file.worktree !== ' ') && <button className="icon-button" disabled={busy || loading} aria-label={`Stage ${file.path}`} title="Stage changes" onClick={() => void mutate('stage',file.path)}><Plus size={13}/></button>}
          </li>)}</ul>
          {status.truncated && <p className="git-clean">Showing the first 500 paths. Review all changes and commit in the repository terminal.</p>}
          <form onSubmit={event => {event.preventDefault(); void mutate('commit');}}>
            <textarea aria-label="Commit message" placeholder="Commit message" value={message} maxLength={32768} rows={2} disabled={busy} onChange={event => setMessage(event.target.value)}/>
            <button type="submit" disabled={busy || loading || status.truncated || status.conflicted || status.stagedCount === 0 || !message.trim()}>{busy ? 'Working…' : `Commit staged (${status.stagedCount})`}</button>
          </form>
        </>}
      </div>
    </Collapsible.Panel>
  </Collapsible.Root>;
}
