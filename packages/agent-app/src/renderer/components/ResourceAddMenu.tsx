import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {Popover} from '@base-ui/react/popover';
import {Bot, Inbox, Files as FileIcon, GitCompare, Globe, History, MessagesSquare, NotebookPen, Plus, Search, SquareTerminal} from 'lucide-react';
import {createCanvas, openSideChat, selectedText, sideChatBindingForTab} from '../artifacts';
import {openBrowserTab, openChangesTab, openFile, openFilesTab, openInboxTab, openSubagentsTab, openTab, pickFolder, type WorkspaceTab} from '../store';
import {useStore} from '../useStore';
import {browserAddress} from '../../shared/browser-protocol';
import {useFileSearch} from './FileSearch';
import {FileTypeIcon, ResourceTabIcon} from './FileTypeIcon';
import {openTerminalTab} from './ProcessesTab';

// ---------------------------------------------------------------------------
// Recently closed resources: a bounded, window-lifetime list recorded by the workspace's close path.

const RECENT_LIMIT = 10;
const closed: WorkspaceTab[] = [];

export function recordClosedTab(tab: WorkspaceTab): void {
  const index = closed.findIndex(item => item.id === tab.id);
  if (index >= 0) closed.splice(index, 1);
  closed.unshift({...tab});
  closed.length = Math.min(closed.length, RECENT_LIMIT);
}

export function recentlyClosedTabs(): readonly WorkspaceTab[] {
  return closed;
}

/** Reopen a closed descriptor; its body reloads through the normal open/hydrate path. */
export function reopenClosedTab(tab: WorkspaceTab): void {
  const index = closed.findIndex(item => item.id === tab.id);
  if (index >= 0) closed.splice(index, 1);
  if (tab.kind === 'file' && tab.folderId && tab.path) void openFile(tab.folderId, tab.path, tab.line);
  else if (tab.kind === 'browser') openBrowserTab(tab.url);
  else openTab(tab);
}

/** Only address-shaped input is offered as a browser destination; file names like notes.md stay files. */
export function addressFromQuery(query: string): string | null {
  const value = query.trim();
  if (!value || /\s/.test(value)) return null;
  const shaped = /^[a-z][a-z\d+.-]*:\/\//i.test(value) || /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(value)
    || /^(www\.)?[a-z\d-]+(\.[a-z\d-]+)*\.(com|org|net|io|dev|app|ai|co|edu|gov|so|sh|me|xyz|info|us|uk|in|de|fr|jp|ca|au)(:\d+)?(\/\S*)?$/i.test(value);
  if (!shaped) return null;
  try { return browserAddress(value); } catch { return null; }
}

type Option = {id: string; label: string; detail?: string; icon: React.ReactNode; run: () => void; disabled?: boolean; group: 'files' | 'new' | 'recent'};

/** '+' after the resource tabs: search files or a URL, open a resource type, or reopen a recent tab. */
export function ResourceAddMenu(): React.ReactElement {
  const [open, setOpen] = useState(false);
  return <Popover.Root open={open} onOpenChange={setOpen}>
    <Popover.Trigger className="icon-button resource-add-trigger" aria-label="Open a resource" title="Open a resource"><Plus size={14}/></Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner side="bottom" align="start" sideOffset={4} className="resource-add-positioner">
        <Popover.Popup className="resource-add-popup" data-native-preview-overlay aria-label="Open a resource">
          {open && <ResourceAddContent close={() => setOpen(false)}/>}
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>;
}

function ResourceAddContent({close}: {close: () => void}): React.ReactElement {
  const state = useStore();
  const chat = state.snapshot?.chats.find(item => item.id === state.activeChatId);
  const folder = state.snapshot?.folders.find(item => item.id === chat?.folderId);
  const [query, setQuery] = useState('');
  // Read before the search field takes focus, which would move the selection.
  const [excerpt] = useState(() => selectedText(document.getElementById('active-resource-panel')));
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  const search = useFileSearch(folder?.id, '', query);
  const needle = query.trim().toLowerCase();
  const options = useMemo(() => {
    const act = (run: () => void) => () => { close(); run(); };
    const list: Option[] = [];
    const address = addressFromQuery(query);
    for (const entry of search.result?.entries.slice(0, 8) ?? []) list.push({id: `file:${entry.path}`, group: 'files', label: entry.name, detail: entry.path, icon: <FileTypeIcon path={entry.path}/>, run: act(() => void openFile(folder!.id, entry.path))});
    if (address) list.push({id: 'url', group: 'files', label: `Open ${address}`, detail: 'Browser', icon: <Globe size={14} aria-hidden="true"/>, run: act(() => openBrowserTab(address))});
    const kinds: Option[] = [
      {id: 'browser', group: 'new', label: 'Browser', icon: <Globe size={14} aria-hidden="true"/>, run: act(() => openBrowserTab())},
      {id: 'terminal', group: 'new', label: 'Terminal', detail: chat ? undefined : 'Starts with the chat', icon: <SquareTerminal size={14} aria-hidden="true"/>, disabled: !chat, run: act(() => chat && openTerminalTab(chat.id, 'Terminal', 'terminals'))},
      {id: 'files', group: 'new', label: 'Files', detail: folder ? folder.name : 'Choose a folder…', icon: <FileIcon size={14} aria-hidden="true"/>, run: act(() => folder ? openFilesTab(folder.id, folder.name) : void pickFolder())},
      {id: 'changes', group: 'new', label: 'Git', detail: folder ? `Changes, history, pull requests · ${folder.name}` : 'Choose a folder…', icon: <GitCompare size={14} aria-hidden="true"/>, run: act(() => folder ? openChangesTab(folder.id, folder.name) : void pickFolder())},
      {id: 'canvas', group: 'new', label: 'Canvas', detail: chat ? 'Co-edit with the agent' : 'Markdown, code or HTML', icon: <NotebookPen size={14} aria-hidden="true"/>, run: act(() => void createCanvas())},
      ...(() => {
        // WRK-13: a side chat about the resource on screen (and the text selected in it).
        const current = state.tabs.find(tab => tab.id === state.activeTabId);
        const binding = current ? sideChatBindingForTab(current) : null;
        return binding && current ? [{id: 'sidechat', group: 'new' as const, label: 'Side chat', detail: current.title, icon: <MessagesSquare size={14} aria-hidden="true"/>, run: act(() => { const withSelection = sideChatBindingForTab(current, excerpt); if (withSelection) void openSideChat(withSelection); })}] : [];
      })(),
      {id: 'inbox', group: 'new', label: 'Inbox', detail: chat ? undefined : 'Open a chat first', icon: <Inbox size={14} aria-hidden="true"/>, disabled: !chat, run: act(() => chat && openInboxTab(chat.id, chat.title || 'Chat'))},
      {id: 'subagents', group: 'new', label: 'Subagents', detail: chat ? undefined : 'Open a chat first', icon: <Bot size={14} aria-hidden="true"/>, disabled: !chat, run: act(() => chat && openSubagentsTab(chat.id, folder?.id, folder?.name ?? chat.title))},
    ];
    list.push(...kinds.filter(option => !needle || option.label.toLowerCase().includes(needle)));
    for (const tab of recentlyClosedTabs()) {
      if (needle && !`${tab.title} ${tab.path ?? ''} ${tab.url ?? ''}`.toLowerCase().includes(needle)) continue;
      list.push({id: `recent:${tab.id}`, group: 'recent', label: tab.title, detail: tab.kind === 'file' ? tab.path : tab.kind === 'browser' && tab.url !== 'about:blank' ? tab.url : undefined, icon: <ResourceTabIcon tab={tab} className="resource-add-icon"/>, run: act(() => reopenClosedTab(tab))});
    }
    return list;
  }, [query, needle, search.result, chat, folder, close, state.tabs, state.activeTabId, excerpt]);
  const enabled = options.filter(option => !option.disabled);
  const current = enabled[Math.min(active, enabled.length - 1)];
  const move = (delta: number) => setActive(index => enabled.length ? (Math.min(index, enabled.length - 1) + delta + enabled.length) % enabled.length : 0);
  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home' && !query) { event.preventDefault(); setActive(0); }
    else if (event.key === 'End' && !query) { event.preventDefault(); setActive(enabled.length - 1); }
    else if (event.key === 'Enter' && current) { event.preventDefault(); current.run(); }
  };
  const optionId = (option: Option) => `${listId}-${option.id.replace(/[^\w-]/g, '_')}`;
  // Keyboard movement keeps the active row visible inside the bounded list.
  const currentId = current ? optionId(current) : '';
  useEffect(() => { if (currentId) document.getElementById(currentId)?.scrollIntoView?.({block: 'nearest'}); }, [currentId]);
  const heading = {files: 'Files', new: 'Open', recent: 'Recently closed'} as const;
  const searching = Boolean(needle && folder);
  return <>
    <label className="resource-add-search">
      <Search size={13} aria-hidden="true"/>
      <input ref={input} autoFocus type="text" role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={current ? optionId(current) : undefined} aria-label="Open file or URL" placeholder={folder ? 'Open file or URL…' : 'Open a URL…'}
        maxLength={256} spellCheck={false} autoComplete="off" value={query} onChange={event => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown}/>
    </label>
    <div className="resource-add-list" role="listbox" id={listId} aria-label="Resources">
      {searching && !search.result && !search.error && <div className="resource-add-note" role="status">Finding files…</div>}
      {searching && search.error && <div className="resource-add-note is-error" role="alert">{search.error} <button type="button" onClick={search.retry}>Retry</button></div>}
      {searching && search.result && !search.result.entries.length && <div className="resource-add-note">No matching files.</div>}
      {(['files', 'new', 'recent'] as const).map(group => {
        const items = options.filter(option => option.group === group);
        if (!items.length) return null;
        return <div key={group} role="group" aria-label={heading[group]} className="resource-add-group">
          {group !== 'files' && <div className="resource-add-heading" aria-hidden="true">{group === 'recent' ? <><History size={11}/>{heading[group]}</> : heading[group]}</div>}
          {items.map(option => <div key={option.id} id={optionId(option)} role="option" aria-selected={option === current} aria-disabled={option.disabled || undefined}
            className="resource-add-option" data-active={option === current}
            onMouseMove={() => { if (!option.disabled) setActive(enabled.indexOf(option)); }}
            onMouseDown={event => event.preventDefault()}
            onClick={() => { if (!option.disabled) option.run(); }}>
            {option.icon}<span className="resource-add-label">{option.label}</span>{option.detail && <span className="resource-add-detail">{option.detail}</span>}
          </div>)}
        </div>;
      })}
      {search.result?.truncated && <div className="resource-add-note">More files match; keep typing to narrow.</div>}
    </div>
  </>;
}
