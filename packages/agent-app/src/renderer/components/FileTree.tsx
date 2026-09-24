import React, {createContext, useContext, useEffect, useMemo, useState, useSyncExternalStore} from 'react';
import {ChevronDown, ChevronRight, Copy, FolderOpen as RevealIcon, Paperclip, Trash2, X} from 'lucide-react';
import {activeChat, closeTab, dirKey, getState, loadDir, makeTabPermanent, notifyError, openFile, pushNotice, setComposerDraft} from '../store';
import {useStoreSelector} from '../useStore';
import {expansionRevision, isExpanded, setExpanded, subscribeExpansion} from '../resourceViewState';
import {FileActions} from './FileActions';
import {gitBadgeMap, type GitBadge} from '../fileTreePrefs';
import {FileTypeIcon} from './FileTypeIcon';
import {ResourceState} from './ResourceState';
import {cleanIpcError} from './resourceErrors';
import {invoke} from '../bridge';
import {copyText} from '../clipboard';
import {insertWorkspaceReference} from './composerMenus';
import {ConfirmSheet} from './ConfirmSheet';
import {clearSelection,extendSelectionByArrow,isToggleClick,keepSelected,selectAll,selectionKeyAction,selectRange,toggleSelection,topLevelPaths,withFallbackAnchor,type MultiSelectState} from '../multiSelect';
import { plural } from '../../shared/wording.ts';
import {Tip} from './Tooltip';

/** runtime/files.ts returns at most this many entries per directory (sorted first). */
const HOST_LISTING_LIMIT = 2000;
const PAGE = 200;
const IS_MAC=typeof navigator!=='undefined'&&/mac/i.test(navigator.platform||navigator.userAgent||'');
const parentOf=(path:string)=>path.includes('/')?path.slice(0,path.lastIndexOf('/')):'';

/** UX-22: selection lives on the root FileTree instance (one per Files tab) and is shared with every
 *  recursive FileTree call for an expanded subfolder through context, so Cmd/Shift-click and Shift+Arrow
 *  work across the whole tree, not just one directory's rows. */
type TreeSelection = {state: MultiSelectState; setState: React.Dispatch<React.SetStateAction<MultiSelectState>>};
const SelectionContext = createContext<TreeSelection | null>(null);

/** WAI-ARIA tree keys over the rendered rows: Up/Down move, Right expands or enters, Left collapses or climbs. */
export function onTreeKeyDown(event: React.KeyboardEvent<HTMLElement>): void {
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const current = event.target as HTMLElement;
  if (current.getAttribute('role') !== 'treeitem') return;
  const items = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]'));
  const index = items.indexOf(current);
  const level = Number(current.getAttribute('aria-level'));
  const expanded = current.getAttribute('aria-expanded');
  let target: HTMLElement | undefined;
  switch (event.key) {
    case 'ArrowDown': target = items[index + 1]; break;
    case 'ArrowUp': target = items[index - 1]; break;
    case 'Home': target = items[0]; break;
    case 'End': target = items[items.length - 1]; break;
    case 'ArrowRight':
      if (expanded === 'false') { event.preventDefault(); current.click(); return; }
      if (expanded === 'true' && Number(items[index + 1]?.getAttribute('aria-level')) > level) target = items[index + 1];
      break;
    case 'ArrowLeft':
      if (expanded === 'true') { event.preventDefault(); current.click(); return; }
      for (let at = index - 1; at >= 0; at--) if (Number(items[at].getAttribute('aria-level')) < level) { target = items[at]; break; }
      break;
    default: return;
  }
  event.preventDefault();
  target?.focus();
}

/** Roving tab stop: the last focused row is the one Tab returns to. */
export function onTreeFocus(event: React.FocusEvent<HTMLElement>): void {
  const item = event.target as HTMLElement;
  if (item.getAttribute('role') !== 'treeitem') return;
  for (const other of Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"][tabindex="0"]'))) if (other !== item) other.tabIndex = -1;
  item.tabIndex = 0;
}

/** Git status on a tree row: a coloured letter for a file, a dot for a folder with changes inside. */
function GitDot({badge, folder = false}: {badge?: GitBadge; folder?: boolean}): React.ReactElement | null {
  if (!badge) return null;
  const label = folder ? 'Contains changes' : badge.label;
  return <span className={`tree-git-badge tree-git-${badge.tone}${folder ? ' tree-git-folder' : ''}`} title={label} aria-label={label}>{folder ? '' : badge.letter}</span>;
}

export const FileTree = React.memo(function FileTreeView({
  folderId,
  path,
  activePath,
  level = 1,
}: {
  folderId: string;
  path: string;
  activePath?: string;
  /** aria-level of this listing's rows; 1 renders the tree root. */
  level?: number;
}): React.ReactElement {
  const entries = useStoreSelector(state=>state.files[dirKey(folderId,path)]);
  // Git badges reuse the Changes list the Files tab already loads for this folder (no git call per row).
  const changes = useStoreSelector(state=>state.gitChanges[folderId]?.value);
  const badges = useMemo(()=>gitBadgeMap(changes),[changes]);
  // Expansion lives outside the component so it survives resource tab switches (WRK-05).
  useSyncExternalStore(subscribeExpansion, expansionRevision);
  const root = level === 1;
  // UX-22: the root instance owns the selection; every recursive call for an expanded subfolder reads
  // and writes it through context instead of keeping its own (see SelectionContext above).
  const inheritedSelection = useContext(SelectionContext);
  const [ownSelectionState, setOwnSelectionState] = useState<MultiSelectState>(clearSelection);
  const selectionState = root ? ownSelectionState : inheritedSelection?.state ?? clearSelection();
  const setSelectionState = root ? setOwnSelectionState : inheritedSelection?.setState ?? setOwnSelectionState;
  const [confirmDeleteSelected, setConfirmDeleteSelected] = useState(false);
  const [deleteSelectedBusy, setDeleteSelectedBusy] = useState(false);
  const [visible,setVisible] = useState(PAGE);
  useEffect(()=>{setVisible(PAGE);},[folderId,path]);
  useEffect(()=>{
    const index=entries?.value?.findIndex(entry=>entry.path===activePath || activePath?.startsWith(entry.path+'/')) ?? -1;
    if(index>=0)setVisible(count=>Math.max(count,Math.ceil((index+1)/PAGE)*PAGE));
  },[entries?.value,activePath]);

  useEffect(() => {
    if (activePath?.startsWith(path ? path+'/' : '')) {
      const child=activePath.slice(path ? path.length+1 : 0).split('/');
      if(child.length>1)setExpanded(folderId,path ? path+'/'+child[0] : child[0],true);
    }
  }, [activePath,path,folderId]);
  useEffect(() => {
    if (!entries) void loadDir(folderId, path);
  }, [entries, folderId, path]);

  if (!entries || (entries.phase === 'loading' && !entries.value) || entries.phase === 'idle') {
    return <ResourceState kind="loading" label={`Loading ${path || 'files'}`} rows={level === 1 ? 4 : 2} compact/>;
  }
  if (entries.phase === 'error') {
    return <ResourceState kind="error" message={cleanIpcError(entries.error) || 'This folder could not be listed.'} onRetry={() => void loadDir(folderId, path)} compact/>;
  }
  const items = entries.value ?? [];
  // Cmd/Ctrl-click toggles; Shift-click ranges from the anchor over every currently rendered row (files
  // and folders, across expanded subfolders too) — read straight from the DOM, the same source of truth
  // onTreeKeyDown already uses for Up/Down navigation.
  const handleEntryClick = (entryPath: string, event: React.MouseEvent<HTMLElement>) => {
    if (isToggleClick(event, IS_MAC)) { setSelectionState(previous => toggleSelection(previous, entryPath)); return; }
    if (event.shiftKey) {
      const container = (event.currentTarget as HTMLElement).closest('[role="tree"]');
      const order = container ? Array.from(container.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(el => el.getAttribute('data-path') ?? '') : [entryPath];
      // No anchor yet: the range starts at the open file when it is on screen.
      setSelectionState(previous => selectRange(withFallbackAnchor(previous, activePath, order), order, entryPath));
      return;
    }
    setSelectionState(previous => previous.selected.size ? clearSelection() : previous);
  };
  const selectedPaths = () => [...selectionState.selected];
  const copySelectedPaths = () => void copyText(selectedPaths().join('\n'));
  const revealSelected = () => { for (const entryPath of selectedPaths()) void invoke('files.reveal', {folderId, path: entryPath}).catch(notifyError); };
  const attachSelectedToComposer = () => {
    const chat = activeChat();
    if (!chat) return;
    let text = chat.draft;
    for (const entryPath of selectedPaths()) text = insertWorkspaceReference(text, entryPath).text;
    setComposerDraft(chat.id, text);
  };
  const deleteSelected = async () => {
    setDeleteSelectedBusy(true);
    // A folder and a file inside it both selected: trashing the folder takes the file, so only top-level paths go.
    const paths = topLevelPaths(selectedPaths());
    // A folder counts as dirty when any open tab under it has unsaved edits (trashing it would lose them).
    const dirtyPrefix = `file:${folderId}:`;
    const dirtyTabPaths = Object.entries(getState().dirtyTabs).filter(([id, dirty]) => dirty && id.startsWith(dirtyPrefix)).map(([id]) => id.slice(dirtyPrefix.length));
    const dirty = paths.filter(entryPath => dirtyTabPaths.some(tabPath => tabPath === entryPath || tabPath.startsWith(`${entryPath}/`)));
    const clean = paths.filter(entryPath => !dirty.includes(entryPath));
    const failed: string[] = [];
    for (const entryPath of clean) {
      try {
        await invoke('files.trash', {folderId, path: entryPath});
        void loadDir(folderId, parentOf(entryPath));
        const prefix = `${entryPath}/`;
        for (const tab of getState().tabs) {
          if (tab.folderId === folderId && tab.kind === 'file' && tab.path && (tab.path === entryPath || tab.path.startsWith(prefix))) closeTab(tab.id);
        }
      } catch (error) { failed.push(entryPath); notifyError(error); }
    }
    if (dirty.length) pushNotice(`${plural(dirty.length, 'item')} with unsaved changes ${dirty.length === 1 ? 'was' : 'were'} kept — save or discard the edits first.`, {kind: 'info'});
    // What was kept (unsaved edits) or failed stays selected; everything trashed leaves the selection.
    setDeleteSelectedBusy(false); setConfirmDeleteSelected(false); const untouched = [...dirty, ...failed];
    setSelectionState(previous => keepSelected(previous, [...previous.selected].filter(entryPath => untouched.some(kept => entryPath === kept || entryPath.startsWith(`${kept}/`)))));
  };
  const onTreeRootKeyDown = (event: React.KeyboardEvent<HTMLElement>) => {
    const current = event.target as HTMLElement;
    if (current.getAttribute('role') === 'treeitem') {
      const entryPath = current.getAttribute('data-path');
      if (entryPath && event.shiftKey && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        const order = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(el => el.getAttribute('data-path') ?? '');
        const extended = extendSelectionByArrow(selectionState, order, entryPath, event.key === 'ArrowDown' ? 'down' : 'up');
        event.preventDefault();
        setSelectionState(extended.state);
        Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')).find(el => el.getAttribute('data-path') === extended.focus)?.focus();
        return;
      }
      // Selection keys, scoped to a focused row: Esc clears, Space toggles the row, Cmd/Ctrl+A selects every rendered row.
      const action = selectionKeyAction(event, IS_MAC);
      if (action === 'clear') { if (selectionState.selected.size) { event.preventDefault(); setSelectionState(clearSelection()); } return; }
      if (action === 'toggle' && entryPath) { event.preventDefault(); setSelectionState(previous => toggleSelection(previous, entryPath)); return; }
      if (action === 'all') {
        event.preventDefault();
        setSelectionState(selectAll(Array.from(event.currentTarget.querySelectorAll<HTMLElement>('[role="treeitem"]')).map(el => el.getAttribute('data-path') ?? '').filter(Boolean), entryPath));
        return;
      }
    }
    onTreeKeyDown(event);
  };
  const rows = items.slice(0,visible).map((entry, index) => {
    const tabStop = root && index === 0 ? 0 : -1;
    if (entry.kind === 'directory') {
      const open = isExpanded(folderId, entry.path);
      return <li key={entry.path} role="none">
        <div className="tree-item-line" onContextMenu={event => { event.preventDefault(); (event.currentTarget.querySelector('.file-action-trigger') as HTMLElement | null)?.click(); }}>
          <button
            type="button"
            role="treeitem"
            aria-level={level}
            aria-expanded={open}
            aria-selected={selectionState.selected.has(entry.path)}
            tabIndex={tabStop}
            data-path={entry.path}
            className={`tree-row${selectionState.selected.has(entry.path)?' is-selected':''}`} title={entry.path}
            onClick={event => { if(event.metaKey||event.ctrlKey||event.shiftKey){event.preventDefault();handleEntryClick(entry.path,event);return;} handleEntryClick(entry.path,event); setExpanded(folderId, entry.path, !open); }}
          >
            {open ? <ChevronDown size={13} aria-hidden="true"/> : <ChevronRight size={13} aria-hidden="true"/>}<FileTypeIcon path={entry.path} directory open={open}/>
            <span>{entry.name}</span>
            <GitDot badge={badges.get(`dir:${entry.path}`)} folder/>
          </button>
          <FileActions folderId={folderId} path={entry.path} kind="directory"/>
        </div>
        {open && <FileTree folderId={folderId} path={entry.path} activePath={activePath} level={level + 1}/>}
      </li>;
    }
    return <li key={entry.path} role="none">
      <div className="tree-item-line" onContextMenu={event => { event.preventDefault(); (event.currentTarget.querySelector('.file-action-trigger') as HTMLElement | null)?.click(); }}>
        <button
          type="button"
          role="treeitem"
          aria-level={level}
          aria-selected={selectionState.selected.has(entry.path)}
          tabIndex={tabStop}
          data-path={entry.path}
          className={`tree-row tree-file${selectionState.selected.has(entry.path)?' is-selected':''}`} title={entry.path}
          aria-current={entry.path===activePath ? 'page' : undefined}
          onClick={event => { if(event.metaKey||event.ctrlKey||event.shiftKey){event.preventDefault();handleEntryClick(entry.path,event);return;} handleEntryClick(entry.path,event); void openFile(folderId, entry.path, undefined, {preview: true}); }}
          onDoubleClick={() => { void openFile(folderId, entry.path); makeTabPermanent(`file:${folderId}:${entry.path}`); }}
        >
          <FileTypeIcon path={entry.path}/>
          <span>{entry.name}</span>
          <GitDot badge={badges.get(entry.path)}/>
        </button>
        <FileActions folderId={folderId} path={entry.path} kind="file"/>
      </div>
    </li>;
  });
  const more = items.length>visible && <li role="none"><button type="button" className="tree-row tree-more" onClick={()=>setVisible(count=>count+PAGE)}>Show {Math.min(PAGE,items.length-visible)} more items ({items.length-visible} remaining)</button></li>;
  const limited = items.length >= HOST_LISTING_LIMIT && <li role="none" className="tree-limit">Showing the first {HOST_LISTING_LIMIT.toLocaleString()} entries. Use Find files to reach the rest.</li>;
  if (!root) return items.length === 0 ? <p className="tree-empty tree-nested-empty">Empty folder</p> : <ul className="tree" role="group">{rows}{more}{limited}</ul>;
  return (
    <SelectionContext.Provider value={{state: selectionState, setState: setSelectionState}}>
    <div className="visually-hidden" aria-live="polite">{selectionState.selected.size>0?`${plural(selectionState.selected.size, 'file')} selected`:''}</div>
    {selectionState.selected.size>0 && (
      <div className="tree-selection-bar" role="toolbar" aria-label="Selected files" onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); setSelectionState(clearSelection()); } }}>
        <span className="tree-selection-count">{selectionState.selected.size} selected</span>
        <span className="tree-selection-actions">
          <Tip label="Copy paths"><button type="button" className="icon-button" aria-label="Copy selected paths" onClick={copySelectedPaths}><Copy size={14}/></button></Tip>
          <Tip label="Reveal in file manager"><button type="button" className="icon-button" aria-label="Reveal selected files" onClick={revealSelected}><RevealIcon size={14}/></button></Tip>
          <Tip label="Attach to composer"><button type="button" className="icon-button" aria-label="Attach selected files to the composer" onClick={attachSelectedToComposer}><Paperclip size={14}/></button></Tip>
          <Tip label="Delete"><button type="button" className="icon-button tree-selection-danger" aria-label="Delete selected files" onClick={()=>setConfirmDeleteSelected(true)}><Trash2 size={14}/></button></Tip>
        </span>
        <Tip label="Clear selection" shortcut="Esc"><button type="button" className="icon-button" aria-label="Clear selection" onClick={()=>setSelectionState(clearSelection())}><X size={14}/></button></Tip>
      </div>
    )}
    {path === '' && <div className="file-tree-actions"><FileActions folderId={folderId} path="" kind="directory" root/></div>}
    {items.length === 0 ? <ResourceState kind="empty" message="This folder is empty." compact/> :
      <ul className="tree" role="tree" aria-label="Files" aria-multiselectable="true" onKeyDown={onTreeRootKeyDown} onKeyUp={event => { if (event.key === ' ' && (event.target as HTMLElement).getAttribute('role') === 'treeitem') event.preventDefault(); }} onFocus={onTreeFocus}>{rows}{more}{limited}</ul>}
    <ConfirmSheet
      open={confirmDeleteSelected}
      title={`Move ${plural(selectionState.selected.size, 'item')} to Trash?`}
      description="Files with unsaved changes are kept — save or discard the edits first, then delete them. Everything else moves to your system Trash; you can restore it there."
      busy={deleteSelectedBusy}
      testId="file-tree-delete-confirm"
      onCancel={()=>{if(!deleteSelectedBusy)setConfirmDeleteSelected(false);}}
      actions={[
        {label:'Cancel', run:()=>setConfirmDeleteSelected(false)},
        {label:'Move to Trash', primary:true, run:()=>void deleteSelected()},
      ]}
    />
    </SelectionContext.Provider>
  );
});
