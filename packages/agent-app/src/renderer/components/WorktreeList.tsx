import React, {useCallback, useEffect, useRef, useState} from 'react';
import {FolderGit2, Laptop, SquarePen, Trash2} from 'lucide-react';
import type {GitWorktree} from '../../shared/domains/git-protocol';
import {invoke, subscribe} from '../bridge';
import {createChat, notifyError} from '../store';
import {useStore} from '../useStore';
import {formatBytes} from '../gitSummary';
import {folderRunning} from './BranchPicker';

/** Worktrees of a folder's repository: open a chat in one, see size and state, retire clean ones. Hidden when there is only the main checkout. */
export function WorktreeList({folderId}: {folderId: string}): React.ReactElement | null {
  const state = useStore();
  const [list, setList] = useState<GitWorktree[]>();
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState('');
  const token = useRef(0);
  // Disk usage walks whole checkouts, so it is read once per worktree (on mount or when one appears), not on every file event.
  const sizes = useRef(new Map<string, Pick<GitWorktree, 'diskBytes' | 'diskTruncated'>>());
  const load = useCallback(async () => {
    const mine = ++token.current;
    const withSize = (entries: GitWorktree[]) => entries.map(entry => ({...entry, ...sizes.current.get(entry.path)}));
    try {
      const first = await invoke('git.worktree.list', {folderId});
      if (mine !== token.current || !Array.isArray(first)) return;
      setList(withSize(first));
      if (!first.some(entry => !entry.main && !entry.prunable && !sizes.current.has(entry.path))) return;
      const sized = await invoke('git.worktree.list', {folderId, usage: true});
      if (mine !== token.current || !Array.isArray(sized)) return;
      sizes.current = new Map(sized.filter(entry => entry.diskBytes !== undefined).map(entry => [entry.path, {diskBytes: entry.diskBytes, ...(entry.diskTruncated ? {diskTruncated: true} : {})}]));
      setList(sized);
    } catch { if (mine === token.current) setList(undefined); }
  }, [folderId]);
  useEffect(() => {
    void load();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const off = subscribe(event => { if (event.type === 'workspaceChanged' && event.folderId === folderId) { clearTimeout(timer); timer = setTimeout(() => void load(), 1500); } });
    return () => { off(); clearTimeout(timer); token.current++; };
  }, [folderId, load]);
  if (!list || list.length < 2) return null;

  const openChat = async (entry: GitWorktree) => {
    try { await createChat(entry.folderId ?? (await invoke('folder.add', {path: entry.path})).id); }
    catch (cause) { notifyError(cause); }
  };
  const remove = async (entry: GitWorktree) => {
    setBusy(entry.path); setConfirm('');
    try { const next = await invoke('git.worktree.remove', {folderId, path: entry.path}); token.current++; setList(next); void load(); }
    catch (cause) { notifyError(cause); }
    finally { setBusy(''); }
  };
  return <div className="worktree-list" aria-label="Worktrees">
    <div className="worktree-list-head">Worktrees</div>
    {list.map(entry => {
      const running = !!entry.folderId && folderRunning(state.snapshot, entry.folderId);
      const blocked = entry.main ? 'The main checkout stays' : entry.current ? 'Open the main checkout to remove this worktree'
        : entry.locked ? 'Locked; unlock it in a terminal' : entry.dirty ? 'Has uncommitted or untracked changes' : running ? 'A chat is running here' : '';
      const facts = [entry.main ? 'main checkout' : entry.prunable ? 'missing' : '', entry.dirty ? 'changes' : '',
        entry.diskBytes !== undefined ? formatBytes(entry.diskBytes, entry.diskTruncated) : ''].filter(Boolean).join(' · ');
      const confirming = confirm === entry.path;
      return <div key={entry.path} className="worktree-row" title={entry.path}>
        {entry.main ? <Laptop size={13} aria-hidden="true"/> : <FolderGit2 size={13} aria-hidden="true"/>}
        <span className="worktree-name">{entry.branch ?? 'detached'}</span>
        {facts && <span className="worktree-facts">{facts}</span>}
        {!entry.current && !entry.prunable && <button className="icon-button" aria-label={`New chat in ${entry.branch ?? entry.path}`} title="New chat here" onClick={() => void openChat(entry)}><SquarePen size={13}/></button>}
        {!entry.main && (confirming
          ? <button className="worktree-confirm" disabled={!!busy} onClick={() => void remove(entry)} onBlur={() => setConfirm('')} autoFocus>Remove</button>
          : <button className="icon-button" disabled={!!blocked || !!busy} aria-label={`Remove worktree ${entry.branch ?? entry.path}`} title={blocked || 'Remove worktree (the branch is kept)'} onClick={() => setConfirm(entry.path)}><Trash2 size={13}/></button>)}
      </div>;
    })}
  </div>;
}
