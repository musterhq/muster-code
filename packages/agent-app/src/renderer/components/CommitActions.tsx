import React, {useEffect, useRef, useState} from 'react';
import {Menu} from '@base-ui/react/menu';
import {Dialog} from '@base-ui/react/dialog';
import {Copy, GitBranchPlus, GitCommitHorizontal, Undo2, Cherry, TriangleAlert, X} from 'lucide-react';
import type {GitCommit, GitCommitAction} from '../../shared/domains/git-protocol';
import {invoke} from '../bridge';
import {loadGitChanges, notifyError, notifySuccess, openChangesTab, openConflictTab} from '../store';
import {useStoreSelector} from '../useStore';
import {blockingChanges, blockingMessage, changesHead, describeCommitAction, headLabel, runningChatsIn, runningWarning, type CommitActionTarget} from '../gitCommitActions';
import {cleanIpcError} from './resourceErrors';
import './file-actions.css';
import './commit-actions.css';

type Anchor = Element | {getBoundingClientRect(): DOMRect};
/** An open commit menu: the commit, where it sits (cursor point or the row), and where focus returns. */
export interface CommitMenuRequest {commit: GitCommit; anchor: Anchor; returnFocus?: HTMLElement | null}
export interface CommitActionRequest {action: GitCommitAction; commit: GitCommit; returnFocus?: HTMLElement | null}

/** Opens the menu from the keyboard (Shift+F10 or the ContextMenu key) or a right-click on a commit row. */
export function commitMenuKey(event: React.KeyboardEvent): boolean {
  return event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey);
}

/**
 * #409: the commit row's menu in the history graph. Copy actions run at once; everything that changes the repository
 * opens CommitActionDialog first. `onHead` says every listed commit is already on the checked-out branch (the History
 * list shows HEAD's own history), so there is nothing to cherry-pick from it.
 */
export function CommitActionsMenu({folderId, request, target, onHead, onClose, onAction}: {
  folderId: string; request: CommitMenuRequest | null; target: CommitActionTarget; onHead: boolean;
  onClose(): void; onAction(request: CommitActionRequest): void;
}): React.ReactElement {
  const commit = request?.commit;
  const here = headLabel(target);
  const copy = (text: string) => void invoke('clipboard.write', {text}).catch(notifyError);
  const copyMessage = async (value: GitCommit) => {
    try {
      const detail = await invoke('git.commitDetail', {folderId, sha: value.sha});
      copy(detail.body.trim() || value.subject);
    } catch { copy(value.subject); }
  };
  const begin = (action: GitCommitAction) => { if (commit) onAction({action, commit, returnFocus: request?.returnFocus ?? null}); };
  const pickBlocked = !!commit && (onHead || commit.head);
  const checkedOut = !!commit && commit.head && target.branch === null;
  return <Menu.Root open={request !== null} onOpenChange={next => { if (!next) onClose(); }}>
    <Menu.Portal><Menu.Positioner anchor={request?.anchor ?? null} side="bottom" align="start" sideOffset={2} className="file-action-positioner">
      <Menu.Popup className="ui-menu file-action-menu commit-action-menu" aria-label={commit ? `Actions for commit ${commit.short}` : 'Commit actions'} finalFocus={request?.returnFocus ? {current: request.returnFocus} : true}>
        {commit && <>
          <Menu.Item onClick={() => copy(commit.sha)}><Copy size={14}/>Copy SHA</Menu.Item>
          <Menu.Item onClick={() => void copyMessage(commit)}><Copy size={14}/>Copy message</Menu.Item>
          <Menu.Separator/>
          <Menu.Item disabled={checkedOut} title={checkedOut ? 'This commit is already checked out' : undefined} onClick={() => begin('checkout')}><GitCommitHorizontal size={14}/>Check out this commit…</Menu.Item>
          <Menu.Item onClick={() => begin('branch')}><GitBranchPlus size={14}/>Create branch here…</Menu.Item>
          <Menu.Separator/>
          <Menu.Item disabled={pickBlocked} title={pickBlocked ? `Already on ${here}. Show another branch’s commits to pick one from it.` : undefined} onClick={() => begin('cherry-pick')}><Cherry size={14}/>Cherry-pick onto {here}…</Menu.Item>
          <Menu.Item onClick={() => begin('revert')}><Undo2 size={14}/>Revert this commit…</Menu.Item>
        </>}
      </Menu.Popup>
    </Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}

type Check = {phase: 'checking'} | {phase: 'ready'; revision: string; blockers: string[]} | {phase: 'error'; message: string};

/** Opens Changes and the first file's resolver after a pick or revert stopped on conflicts (the repo is left in git's conflict state). */
function routeConflicts(folderId: string, folderName: string, action: GitCommitAction, conflicts: readonly string[]): void {
  openChangesTab(folderId, folderName);
  if (conflicts[0]) openConflictTab(folderId, conflicts[0]);
  const count = conflicts.length === 1 ? '1 conflicting file' : `${conflicts.length} conflicting files`;
  notifyError(new Error(`The ${action} stopped on ${count}. Resolve ${conflicts.length === 1 ? 'it' : 'them'} in the conflict view, then continue or abort.`));
}

/**
 * The confirm step for one commit action. It reads the status first: tracked uncommitted changes are named and the action
 * cannot run (the runtime refuses the same case); a chat running in this checkout is named and the confirm says "anyway".
 */
export function CommitActionDialog({folderId, request, target, onClose, onDone}: {
  folderId: string; request: CommitActionRequest | null; target: CommitActionTarget; onClose(): void; onDone(): void;
}): React.ReactElement {
  const snapshot = useStoreSelector(state => state.snapshot);
  const folderName = snapshot?.folders.find(folder => folder.id === folderId)?.name ?? 'Repository';
  const [check, setCheck] = useState<Check>({phase: 'checking'});
  const [name, setName] = useState('');
  const [checkout, setCheckout] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [nonce, setNonce] = useState(0);
  const input = useRef<HTMLInputElement>(null), confirmRef = useRef<HTMLButtonElement>(null);
  const action = request?.action, commit = request?.commit;
  useEffect(() => {
    if (!request) return;
    let live = true;
    setCheck({phase: 'checking'});
    invoke('git.status', {folderId}).then(status => { if (live) setCheck({phase: 'ready', revision: status.revision, blockers: blockingChanges(status)}); },
      cause => { if (live) setCheck({phase: 'error', message: cleanIpcError(cause) || 'The repository status could not be read.'}); });
    return () => { live = false; };
  }, [folderId, request, nonce]);
  useEffect(() => { if (request) { setName(''); setCheckout(false); setError(''); setBusy(false); } }, [request]);
  if (!request || !action || !commit) return <Dialog.Root open={false}/>;
  const moves = changesHead(action, checkout);
  const running = moves ? runningChatsIn(folderId, snapshot) : [];
  const copy = describeCommitAction(action, commit, target, {checkout, branchName: name});
  const blockers = moves && check.phase === 'ready' ? check.blockers : [];
  const needsName = action === 'branch' && !name.trim();
  const disabled = busy || check.phase !== 'ready' || blockers.length > 0 || needsName;
  const label = check.phase === 'checking' ? 'Checking…' : busy ? 'Working…' : `${copy.confirm}${running.length ? ' anyway' : ''}`;
  const submit = async (event: React.SyntheticEvent) => {
    event.preventDefault();
    if (disabled || check.phase !== 'ready') return;
    setBusy(true); setError('');
    try {
      const result = await invoke('git.commitAction', {folderId, action, sha: commit.sha, revision: check.revision,
        ...(action === 'branch' ? {branch: name.trim(), checkout} : {}), ...(running.length ? {allowRunning: true} : {})});
      onClose();
      void loadGitChanges(folderId);
      onDone();
      if (result.conflicts?.length) { routeConflicts(folderId, folderName, action, result.conflicts); return; }
      const here = headLabel(target);
      notifySuccess(action === 'checkout' ? `Checked out ${commit.short} (detached HEAD)`
        : action === 'branch' ? `Created branch ${result.branch ?? name.trim()}${checkout ? ' and switched to it' : ''}`
        : action === 'cherry-pick' ? `Cherry-picked ${commit.short} onto ${here}` : `Reverted ${commit.short} on ${here}`);
    } catch (cause) {
      setError(cleanIpcError(cause) || 'Git could not finish this.');
      setNonce(n => n + 1); // a stale revision or a new blocker: read the status again before another try
    } finally { setBusy(false); }
  };
  return <Dialog.Root open onOpenChange={open => { if (!open && !busy) onClose(); }}>
    <Dialog.Portal><Dialog.Backdrop className="file-dialog-backdrop"/>
      <Dialog.Popup className="file-dialog commit-action-dialog" data-testid="commit-action-dialog" initialFocus={action === 'branch' ? input : confirmRef} finalFocus={request.returnFocus ? {current: request.returnFocus} : true}>
        <div className="file-dialog-heading"><Dialog.Title>{copy.title}</Dialog.Title><Dialog.Close className="icon-button" disabled={busy} aria-label="Close"><X size={16}/></Dialog.Close></div>
        <Dialog.Description>{copy.description}</Dialog.Description>
        <form onSubmit={event => void submit(event)} aria-busy={busy}>
          {action === 'branch' && <>
            <label>Branch name<input ref={input} type="text" aria-label="Branch name" value={name} onChange={event => setName(event.target.value)} disabled={busy} maxLength={200} autoComplete="off" spellCheck={false} placeholder="fix/something"/></label>
            <label className="commit-action-check"><input type="checkbox" checked={checkout} disabled={busy} onChange={event => setCheckout(event.target.checked)}/>Switch to it</label>
          </>}
          {blockers.length > 0 && <p className="file-action-error" role="alert">{blockingMessage(blockers, action)}</p>}
          {running.length > 0 && <p className="commit-action-warning" role="status"><TriangleAlert size={13} aria-hidden="true"/>{runningWarning(running)}</p>}
          {check.phase === 'error' && <p className="file-action-error" role="alert">{check.message}</p>}
          {error && <p className="file-action-error" role="alert">{error}</p>}
          <footer>
            <Dialog.Close disabled={busy}>Cancel</Dialog.Close>
            <button ref={confirmRef} type="submit" onClick={event => void submit(event)} data-testid="commit-action-confirm" className={copy.destructive ? 'file-action-destructive' : 'file-action-primary'} disabled={disabled}>{label}</button>
          </footer>
        </form>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}
