import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {ArrowLeft, Check, FolderGit2, GitBranch, GitBranchPlus, Loader2, Search} from 'lucide-react';
import type {Snapshot} from '../../shared/protocol';
import type {GitBranches} from '../../shared/domains/git-protocol';
import {invoke} from '../bridge';
import {createChat, loadGitChanges, notifyError, notifySuccess, openChangesTab, openConflictTab} from '../store';
import {useStore} from '../useStore';
import {GitSync} from './GitStatus';
import './branch-picker.css';
import { plural } from '../../shared/wording.ts';

export type BranchMode = 'switch' | 'create' | 'worktree';
type Folder = {id: string; name: string};
type Option = {id: string; label: string; detail?: React.ReactNode; icon: React.ReactNode; run: () => void; disabled?: boolean; title?: string; current?: boolean; group: 'recent' | 'branches' | 'actions'};

/** A run owns its folder's working tree (directly or through a project); switching under it would corrupt its view. */
export function folderRunning(snapshot: Snapshot | null | undefined, folderId: string): boolean {
  if (!snapshot) return false;
  const projects = new Set(snapshot.projects.filter(project => project.folderIds.includes(folderId)).map(project => project.id));
  return snapshot.chats.some(chat => (chat.status === 'running' || chat.status === 'stopping') && (chat.folderId === folderId || (!!chat.projectId && projects.has(chat.projectId))));
}

/** After a branch switch that merged carried changes with conflicts: open Changes (its conflict banner lists every file) and the first file's resolver. */
export function routeSwitchConflicts(folder: Folder, conflicts: readonly string[]): void {
  openChangesTab(folder.id, folder.name);
  const first = conflicts[0];
  if (first) openConflictTab(folder.id, first);
  notifyError(new Error(`${conflicts.length === 1 ? '1 file conflicts' : `${conflicts.length} files conflict`} with the branch you switched to. Resolve ${conflicts.length === 1 ? 'it' : 'them'} in the conflict view.`));
}

/** Create a worktree on `branch` (new or existing) and start a chat in it. */
export async function startWorktreeChat(folderId: string, branch: string): Promise<boolean> {
  try {
    const {folder} = await invoke('git.worktree.create', {folderId, branch});
    await createChat(folder.id);
    notifySuccess(`New chat in worktree ${branch}`);
    return true;
  } catch (cause) { notifyError(cause); return false; }
}

/**
 * Searchable branch switcher (combobox in a popover): switch, create a branch, or
 * spin up a worktree for a parallel chat. Tracked local changes are confirmed before
 * they are carried to the new branch; switching is locked while a chat runs here.
 */
export function BranchPicker({folder, className, children, label, side = 'bottom', align = 'start', open: controlled, onOpenChange, mode: requested}: {
  folder: Folder; className: string; children: React.ReactNode; label: string; side?: 'top' | 'bottom'; align?: 'start' | 'end';
  open?: boolean; onOpenChange?: (open: boolean) => void; mode?: BranchMode;
}): React.ReactElement {
  const [own, setOwn] = useState(false);
  const open = controlled ?? own;
  const setOpen = (next: boolean) => { if (controlled === undefined) setOwn(next); onOpenChange?.(next); };
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className={className} aria-label={label} title={label}>{children}</Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side={side} align={align} sideOffset={6} className="branch-picker-positioner">
        <Popover.Popup className="branch-picker" data-native-preview-overlay aria-label="Branches">
          {open && <BranchPickerContent folder={folder} initialMode={requested ?? 'switch'} close={() => setOpen(false)}/>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

function BranchPickerContent({folder, initialMode, close}: {folder: Folder; initialMode: BranchMode; close: () => void}): React.ReactElement {
  const state = useStore();
  const running = folderRunning(state.snapshot, folder.id);
  const [mode, setMode] = useState<BranchMode>(initialMode);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const [branches, setBranches] = useState<GitBranches>();
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [carry, setCarry] = useState<{branch: string; create: boolean; revision: string; files: string[]; total: number}>();
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    invoke('git.branches', {folderId: folder.id}).then(value => { if (alive.current && value) setBranches(value); }, cause => { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { alive.current = false; };
  }, [folder.id]);
  useEffect(() => { input.current?.focus(); setActive(0); }, [mode, carry]);

  const doSwitch = async (branch: string, create: boolean, confirmed?: {revision: string}) => {
    if (busy) return;
    setBusy(true); setError('');
    try {
      const revision = confirmed?.revision ?? (await invoke('git.status', {folderId: folder.id})).revision;
      const result = await invoke('git.switch', {folderId: folder.id, branch, create, revision, carry: !!confirmed});
      if (!alive.current) return;
      if (result.blocked) { setCarry({branch, create, revision, files: result.files, total: result.total}); return; }
      void loadGitChanges(folder.id);
      close();
      // GIT-06: a carried change that conflicted with the target lands in the conflict banner and resolver, not in an error toast.
      if (result.conflicts?.length) routeSwitchConflicts(folder, result.conflicts);
    } catch (cause) { if (alive.current) setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const doWorktree = async (branch: string) => {
    if (busy) return;
    setBusy(true); setError('');
    const ok = await startWorktreeChat(folder.id, branch);
    if (!alive.current) return;
    setBusy(false);
    if (ok) close();
  };

  const name = query.trim();
  const needle = name.toLowerCase();
  const current = branches?.current ?? null;
  const options = useMemo(() => {
    const list: Option[] = [];
    if (!branches) return list;
    const byName = new Map(branches.local.map(branch => [branch.name, branch]));
    const match = (value: string) => !needle || value.toLowerCase().includes(needle);
    if (mode === 'create') {
      if (name) list.push({id: 'create', group: 'actions', label: `Create and switch to “${name}”`, detail: current ? `from ${current}` : 'from HEAD', icon: <GitBranchPlus size={14}/>, disabled: running || byName.has(name), title: byName.has(name) ? 'A branch with this name already exists' : undefined, run: () => void doSwitch(name, true)});
      return list;
    }
    const seen = new Set<string>();
    const add = (branchName: string, group: Option['group']) => {
      const branch = byName.get(branchName);
      if (!branch || seen.has(branchName) || !match(branchName)) return;
      seen.add(branchName);
      const elsewhere = !!branch.worktreePath && branchName !== current;
      const counts = branch.ahead || branch.behind || branch.gone ? <>{branch.gone ? <span className="branch-picker-gone" title="Its remote branch was deleted">gone</span> : null}<GitSync ahead={branch.ahead} behind={branch.behind}/></> : undefined;
      if (mode === 'worktree') {
        list.push({id: `b:${branchName}`, group, label: branchName, detail: elsewhere || branchName === current ? 'checked out' : counts || undefined, icon: <GitBranch size={14}/>,
          disabled: elsewhere || branchName === current, title: branch.worktreePath ? `Checked out at ${branch.worktreePath}` : undefined, run: () => void doWorktree(branchName)});
      } else {
        list.push({id: `b:${branchName}`, group, label: branchName, detail: elsewhere ? 'in worktree' : counts || undefined, icon: <GitBranch size={14} className={branchName === current ? 'branch-picker-current' : undefined}/>, current: branchName === current,
          disabled: elsewhere || running, title: elsewhere ? `Checked out in another worktree at ${branch.worktreePath}` : running ? 'Stop the running chat to switch branches' : undefined,
          run: () => void (branchName === current ? close() : doSwitch(branchName, false))});
      }
    };
    if (!needle && current && mode === 'switch') add(current, 'recent');
    if (!needle) for (const recent of branches.recent) add(recent, 'recent');
    for (const branch of branches.local) add(branch.name, 'branches');
    const exact = byName.has(name);
    if (mode === 'worktree') {
      if (name && !exact) list.push({id: 'wt-new', group: 'actions', label: `New worktree on “${name}”`, detail: current ? `from ${current}` : undefined, icon: <FolderGit2 size={14}/>, run: () => void doWorktree(name)});
    } else {
      if (name && !exact) list.push({id: 'create-q', group: 'actions', label: `Create branch “${name}”`, detail: current ? `from ${current}` : undefined, icon: <GitBranchPlus size={14}/>, disabled: running, title: running ? 'Stop the running chat to switch branches' : undefined, run: () => void doSwitch(name, true)});
      else list.push({id: 'create', group: 'actions', label: 'Create branch…', icon: <GitBranchPlus size={14}/>, disabled: running, title: running ? 'Stop the running chat to switch branches' : undefined, run: () => { setMode('create'); setQuery(''); }});
      list.push({id: 'worktree', group: 'actions', label: 'New worktree for a parallel chat…', icon: <FolderGit2 size={14}/>, run: () => { setMode('worktree'); setQuery(name && !exact ? name : ''); }});
    }
    return list;
  }, [branches, needle, name, mode, current, running]);

  const enabled = options.filter(option => !option.disabled);
  const focused = enabled[Math.min(active, enabled.length - 1)];
  const move = (delta: number) => setActive(index => enabled.length ? (Math.min(index, enabled.length - 1) + delta + enabled.length) % enabled.length : 0);
  const optionId = (option: Option) => `${listId}-${option.id.replace(/[^\w-]/g, '_')}`;
  const focusedId = focused ? optionId(focused) : '';
  useEffect(() => { if (focusedId) document.getElementById(focusedId)?.scrollIntoView?.({block: 'nearest'}); }, [focusedId]);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter' && focused && !busy) { event.preventDefault(); focused.run(); }
    else if (event.key === 'Backspace' && !query && mode !== initialMode) { event.preventDefault(); setMode(initialMode); }
  };

  if (carry) return <div className="branch-picker-confirm" role="alertdialog" aria-label="Bring local changes">
    <p><b>{plural(carry.total, 'changed file')}</b> will come with you to <b>{carry.branch}</b>.</p>
    <ul>{carry.files.slice(0, 5).map(file => <li key={file} title={file}>{file}</li>)}{carry.total > 5 && <li className="branch-picker-faint">and {carry.total - 5} more</li>}</ul>
    {error && <p className="branch-picker-error" role="alert">{error}</p>}
    <div className="branch-picker-buttons">
      <button type="button" onClick={() => { setCarry(undefined); setError(''); }} disabled={busy}>Cancel</button>
      <button type="button" className="is-primary" autoFocus disabled={busy} onClick={() => void doSwitch(carry.branch, carry.create, {revision: carry.revision})}>{busy ? <Loader2 size={13} className="branch-picker-spin"/> : null}Bring changes</button>
    </div>
  </div>;

  const placeholder = mode === 'create' ? 'New branch name' : mode === 'worktree' ? 'Branch for the worktree' : 'Search branches';
  const heading = {recent: 'Recent', branches: mode === 'worktree' ? 'Check out an existing branch' : 'Branches', actions: ''} as const;
  return <>
    <label className="branch-picker-search">
      {mode === 'switch' ? <Search size={13} aria-hidden="true"/> : <button type="button" className="branch-picker-back" aria-label="Back to branches" onClick={() => { setMode('switch'); setQuery(''); }}><ArrowLeft size={13}/></button>}
      <input ref={input} type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-activedescendant={focusedId || undefined}
        aria-label={placeholder} placeholder={placeholder} maxLength={200} spellCheck={false} autoComplete="off" value={query}
        onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}/>
      {busy && <Loader2 size={13} className="branch-picker-spin" aria-label="Working"/>}
    </label>
    {mode === 'worktree' && <p className="branch-picker-note">A worktree is a separate checkout with its own chat, so both can work at once.</p>}
    {mode === 'switch' && running && <p className="branch-picker-note">A chat is running here. Stop it to switch branches.</p>}
    {error && <p className="branch-picker-error" role="alert">{error}</p>}
    <div className="branch-picker-list" role="listbox" id={listId} aria-label="Branches">
      {!branches && !error && <div className="branch-picker-note" role="status">Reading branches…</div>}
      {branches && mode === 'create' && !name && <div className="branch-picker-note">Type a name. The branch starts from {current ?? 'HEAD'} and keeps your changes.</div>}
      {branches && mode !== 'create' && needle && !options.some(option => option.group !== 'actions') && <div className="branch-picker-note">No matching branches.</div>}
      {(['recent', 'branches', 'actions'] as const).map(group => {
        const items = options.filter(option => option.group === group);
        if (!items.length) return null;
        return <div key={group} role="group" aria-label={heading[group] || 'Actions'} className="branch-picker-group">
          {heading[group] && <div className="branch-picker-heading" aria-hidden="true">{heading[group]}</div>}
          {items.map(option => <div key={option.id} id={optionId(option)} role="option" aria-selected={option === focused} aria-disabled={option.disabled || undefined}
            className="branch-picker-option" data-active={option === focused} title={option.title}
            onMouseMove={() => { if (!option.disabled) setActive(enabled.indexOf(option)); }}
            onMouseDown={event => event.preventDefault()}
            onClick={() => { if (!option.disabled && !busy) option.run(); }}>
            {option.icon}<span className="branch-picker-label">{option.label}</span>
            {option.detail && <span className="branch-picker-detail">{option.detail}</span>}
            {option.current && <Check size={13} className="branch-picker-check" aria-label="Current branch"/>}
          </div>)}
        </div>;
      })}
      {branches?.truncated && <div className="branch-picker-note">Showing the 500 most recent branches; type to narrow.</div>}
    </div>
  </>;
}
