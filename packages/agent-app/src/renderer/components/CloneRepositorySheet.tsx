import React, {useEffect, useRef, useState, useSyncExternalStore} from 'react';
import {FolderOpen, GitBranch} from 'lucide-react';
import type {Folder} from '../../shared/protocol';
import type {GitEvent} from '../../shared/domains/git-protocol';
import {invoke, subscribe} from '../bridge';
import {notifySuccess} from '../store';
import {openNewChat} from '../newChatDraft';
import {ModalSheet} from './ModalSheet';
import {cleanIpcError} from './resourceErrors';
import {destinationInParent as inParent, parentFolder} from '../cloneDestination';
import './clone-repository.css';

// A module-level open flag so any "Add folder" entry point (sidebar, spotlight) opens the one sheet mounted in the sidebar.
let open = false;
// GIT-10 draft-while-cloning: the sheet can step aside while its clone keeps running; the form stays mounted
// (hidden) so it still receives the clone's events, and reopens on failure.
let background = false;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export function openCloneSheet(): void { if (!open || background) { open = true; background = false; notify(); } }
export function closeCloneSheet(): void { if (open || background) { open = false; background = false; notify(); } }
function backgroundCloneSheet(): void { if (open) { open = false; background = true; notify(); } }
const view = () => open ? 'open' : background ? 'background' : 'closed';
export function useCloneSheetOpen(): boolean { return useCloneSheetView() === 'open'; }
function useCloneSheetView(): 'open' | 'background' | 'closed' { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, view, view); }

type Progress = {percent: number | null; message: string};

/**
 * GIT-10: "Clone repository…" from Add Folder. URL + destination (default ~/Code/<repo>), streamed progress,
 * Cancel; when the clone lands the folder is added and a New-chat draft targets it. Credentials never travel
 * in the URL: the user's git credential helper or SSH agent answers, exactly as in a terminal.
 */
export function CloneRepositorySheet(): React.ReactElement | null {
  const state = useCloneSheetView();
  return state === 'closed' ? null : <CloneForm hidden={state === 'background'}/>;
}

type CloneRequest = {url: string; destination?: string};

function CloneForm({hidden}: {hidden: boolean}): React.ReactElement {
  const [url, setUrl] = useState('');
  const [destination, setDestination] = useState('');
  const [suggested, setSuggested] = useState('');
  const [edited, setEdited] = useState(false);
  const [parent, setParent] = useState('');
  const [error, setError] = useState('');
  const [clone, setClone] = useState<{id: string; progress: Progress} | null>(null);
  const [cancelling, setCancelling] = useState(false);
  // The exact inputs of the last clone that failed, so Retry re-runs it unchanged (the failed clone already
  // removed or emptied its destination, so the same folder is valid again).
  const [retry, setRetry] = useState<CloneRequest | null>(null);
  const lastRequest = useRef<CloneRequest | null>(null);
  const urlInput = useRef<HTMLInputElement>(null);
  const finished = useRef(false);
  // Suggest <parent>/<repo> (parent: the picked folder, else ~/Code) for the typed URL until the user types a destination themselves.
  useEffect(() => {
    const value = url.trim();
    if (!value || edited) return;
    let live = true;
    const timer = setTimeout(() => {
      invoke('git.clone.defaultDestination', {url: value, ...(parent ? {parent} : {})}).then(result => { if (live) { setSuggested(result.path); setDestination(result.path); setError(''); } }, () => { if (live) setSuggested(''); });
    }, 250);
    return () => { live = false; clearTimeout(timer); };
  }, [url, edited, parent]);
  // Listen from mount, not from when `git.clone.start` answers: a clone that fails at once (a bad local path, git
  // missing) emits its terminal event before the reply arrives. Events for an id not known yet are held for it.
  const cloneId = useRef<string | null>(null);
  const early = useRef(new Map<string, Extract<GitEvent, {type: 'gitClone'}>>());
  const apply = (event: Extract<GitEvent, {type: 'gitClone'}>) => {
    if (event.phase === 'progress') setClone(current => current && current.id === event.id ? {...current, progress: {percent: event.percent, message: event.message}} : current);
    else if (event.phase === 'done') { finished.current = true; landed(event.folder); }
    else {
      cloneId.current = null; setClone(null); setCancelling(false); setError(event.phase === 'cancelled' ? '' : event.error);
      setRetry(event.phase === 'failed' ? lastRequest.current : null);
      // A clone that fails while the user drafts comes back to the front with its reason and Retry.
      if (event.phase === 'failed') openCloneSheet(); else if (!open) closeCloneSheet();
    }
  };
  const applyRef = useRef(apply); applyRef.current = apply;
  useEffect(() => subscribe(event => {
    if (event.type !== 'gitClone') return;
    if (event.id === cloneId.current) applyRef.current(event);
    else if (cloneId.current === null && (event.phase !== 'progress' || !early.current.has(event.id))) { early.current.set(event.id, event); if (early.current.size > 16) early.current.delete(early.current.keys().next().value!); }
  }), []);
  const landed = (folder: Folder) => {
    closeCloneSheet();
    notifySuccess(`Cloned ${folder.name}`);
    openNewChat({folderId: folder.id});
  };
  const run = async (request: CloneRequest) => {
    if (clone) return;
    setError(''); setRetry(null);
    lastRequest.current = request;
    try {
      const started = await invoke('git.clone.start', request);
      cloneId.current = started.id;
      setClone({id: started.id, progress: {percent: 0, message: `Cloning into ${started.name}…`}});
      const pending = early.current.get(started.id); early.current.clear();
      if (pending) apply(pending);
    } catch (cause) { setError(cleanIpcError(cause) || 'The clone could not start.'); }
  };
  const start = (event: React.FormEvent) => {
    event.preventDefault();
    void run({url: url.trim(), ...(destination.trim() ? {destination: destination.trim()} : {})});
  };
  // Leave the sheet while git works: a New-chat draft opens now and is aimed at the folder once it lands.
  // After the sheet has closed, so its focus restore does not pull focus back out of the composer.
  const draftWhileCloning = () => { backgroundCloneSheet(); setTimeout(() => openNewChat(), 0); };
  const cancel = () => {
    if (!clone) { closeCloneSheet(); return; }
    setCancelling(true);
    void invoke('git.clone.cancel', {id: clone.id}).catch(() => {});
  };
  // "Choose…" picks the PARENT folder (e.g. ~/Code); the repository's own folder is appended inside it.
  const choose = async () => {
    try {
      const current = destination || suggested;
      const picked = await invoke('git.clone.pickDestination', current ? {suggested: parentFolder(current)} : {});
      if (!picked) return;
      // The picked parent sticks: a URL typed or changed afterwards still lands in <parent>/<repo>.
      setParent(picked.path); setDestination(await inParent(picked.path, url.trim(), current, input => invoke('git.clone.defaultDestination', input))); setEdited(false); setError('');
    } catch (cause) { setError(cleanIpcError(cause) || 'The folder picker is unavailable.'); }
  };
  const percent = clone?.progress.percent ?? null;
  return <ModalSheet open={!hidden} title="Clone repository" description="Git uses your saved credentials or SSH key, as in a terminal. Nothing is stored by Muster." className="composer-confirm clone-sheet" testId="clone-sheet" initialFocus={urlInput} onClose={() => { if (!clone) closeCloneSheet(); }}>
    <form className="clone-form" onSubmit={start}>
      <label className="clone-field">
        <span>Repository URL</span>
        <input ref={urlInput} type="text" value={url} placeholder="https://github.com/owner/repo.git or git@github.com:owner/repo.git" spellCheck={false} autoComplete="off" maxLength={2048} disabled={!!clone} onChange={event => { setUrl(event.target.value); setRetry(null); }} aria-label="Repository URL"/>
      </label>
      <label className="clone-field">
        <span>Clone into</span>
        <div className="clone-destination">
          <input type="text" value={destination} placeholder="~/Code/repo" spellCheck={false} autoComplete="off" maxLength={4096} disabled={!!clone} onChange={event => { setDestination(event.target.value); setEdited(true); setRetry(null); }} aria-label="Destination folder"/>
          <button type="button" className="clone-choose" disabled={!!clone} title="Choose a folder" onClick={() => void choose()}><FolderOpen size={13} aria-hidden="true"/>Choose…</button>
        </div>
      </label>
      {error && <p className="git-action-error clone-error" role="alert">{error}</p>}
      {clone && <div className="clone-progress" role="status" aria-live="polite" data-testid="clone-progress">
        <div className="clone-bar" role="progressbar" aria-valuemin={0} aria-valuemax={100} {...(percent === null ? {} : {'aria-valuenow': percent})} data-indeterminate={percent === null || undefined}><div className="clone-bar-fill" style={{width: `${percent ?? 30}%`}}/></div>
        <span className="clone-message">{cancelling ? 'Cancelling…' : clone.progress.message}</span>
      </div>}
      <div className="composer-confirm-actions">
        <button type="button" onClick={cancel} disabled={cancelling}>{clone ? 'Cancel clone' : 'Cancel'}</button>
        {clone && !cancelling && <button type="button" onClick={draftWhileCloning}>Draft a chat meanwhile</button>}
        {!clone && retry && <button type="button" className="is-primary" title={`Clone ${retry.url} again${retry.destination ? ` into ${retry.destination}` : ''}`} onClick={() => void run(retry)}>Retry</button>}
        <button type="submit" className={retry && !clone ? undefined : 'is-primary'} disabled={!!clone || !url.trim()}>{clone ? 'Cloning…' : 'Clone'}</button>
      </div>
    </form>
    <p className="clone-hint"><GitBranch size={11} aria-hidden="true"/>The default branch is checked out; a new chat opens in the folder once it lands.</p>
  </ModalSheet>;
}
