import React, { useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useHiddenSideChats } from '../artifacts';
import { Dialog } from '@base-ui/react/dialog';
import { ArchiveRestore, Blocks, Brain, CalendarClock, ChevronsDown, Command, Download, FileSearch as FileSearchIcon, Folder as FolderIcon, FolderOpen, GitBranch, Layers, Settings2, SlidersHorizontal, SquarePen, SquareTerminal, Search } from 'lucide-react';
import type { Chat, Folder, Project } from '../../shared/protocol';
import { chatSlot, isMenuAction } from '../../shared/menu-protocol';
import type { GitRepoInfo } from '../../shared/domains/git-protocol';
import { invoke } from '../bridge';
import { focusComposer, isChord } from '../focus';
import { chatOrder } from '../navHistory';
import { readChatSort } from '../chatNavigation';
import { addFolderToDraft, closeNewChat, getNewChatDraft, openNewChat, useNewChatDraft } from '../newChatDraft';
import { toggleTerminal } from './ProcessesTab';
import { activeChat, getState, openGitTab, openAppSettings, openAutomationsScreen, openFile, openMemoryScreen, openPluginsScreen, openProjectsScreen, openProvidersTab, selectChat, stopChat } from '../store';
import { openProject } from '../projectFocus';
import { runMenuAction, useNavHistory } from '../menuActions';
import { COMMAND_PREFIX, commandRows, paletteEmptyState, parsePaletteQuery, type CommandContext, type CommandId, type CommandRow } from '../commandPalette';
import { FileTypeIcon } from './FileTypeIcon';
import { ResourceState } from './ResourceState';
import { useStore } from '../useStore';
import { StatusDot } from './StatusDot';
import { openStashes } from './PromptStashes';
import { openImportConversations } from './ImportConversations';
import {
  MAX_CHAT_RESULTS,
  defaultChatRows,
  fileRows,
  folderRows,
  mergeContentHits,
  moveHighlight,
  projectRows,
  quickActionRows,
  searchChatRows,
  settingsRows,
  splitHighlight,
  type QuickActionId,
  type SpotlightActionRow,
  type ContentHit,
  type SpotlightChatRow,
  type SpotlightFileRow,
  type SpotlightPlaceRow,
  type SpotlightSettingsRow,
} from '../spotlightModel';
import { SETTINGS_SECTIONS, type SectionInfo } from './settings/sections';
import './spotlight-search.css';

// ---------------------------------------------------------------------------
// Imperative open API. Kept as tiny module-level state (not store.ts, which other
// engineers currently own) so any caller — the ⌘K chord below, or the Sidebar's
// "Search chats" button once patched in — can open the palette without a prop chain.

const listeners = new Set<() => void>();
let openState = false;
/** What the input starts with on open: '' for search, '> ' for the command palette (⌘⇧P). */
let openQuery = '';

function setOpenState(next: boolean): void {
  if (openState === next) return;
  openState = next;
  for (const listener of listeners) listener();
}
function subscribeOpenState(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function readOpenState(): boolean {
  return openState;
}
/** Whether the palette is currently open. Lets other renderer code (e.g. the menu-action
 * dispatcher) avoid double-handling a chord -- like Cmd+1-9 -- that both the global app menu
 * and the palette's own filtered list react to. */
export function isSpotlightSearchOpen(): boolean {
  return openState;
}

/** Opens the Spotlight search palette. Safe to call from anywhere (menu, button, shortcut). */
export function openSpotlightSearch(): void {
  if (!openState) openQuery = '';
  setOpenState(true);
}
/** NAV-12: opens the same panel in command mode ("> " prefilled). Safe to call from anywhere (⌘⇧P, the View menu). */
export function openCommandPalette(): void {
  openQuery = `${COMMAND_PREFIX} `;
  if (openState) { for (const listener of paletteListeners) listener(openQuery); return; }
  setOpenState(true);
}
const paletteListeners = new Set<(query: string) => void>();
/** Closes it, if open. Exported mainly for tests; the panel closes itself on Esc/outside click/activation. */
export function closeSpotlightSearch(): void {
  setOpenState(false);
}

// ---------------------------------------------------------------------------
// Mount hook: render <SpotlightSearchHost/> once, near the app root (see the
// mount patch in the delivery notes). It owns the ⌘K shortcut and the panel itself;
// nothing renders while closed.

/** Mount once near the app root. Wires ⌘K and renders the palette; a no-op host while closed. */
export function SpotlightSearchHost(): React.ReactElement | null {
  const open = useSyncExternalStore(subscribeOpenState, readOpenState);
  useEffect(() => {
    // Capture phase + stopImmediatePropagation so this wins the ⌘K chord over any other
    // window-level 'keydown' listener registered without capture (e.g. an older bubble-phase
    // handler elsewhere), without needing to touch that other listener's file.
    const onKeyDown = (event: KeyboardEvent) => {
      if (isCommandPaletteChord(event)) { event.preventDefault(); event.stopImmediatePropagation(); openCommandPalette(); return; }
      if (!isChord(event, 'k')) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openSpotlightSearch();
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, []);
  if (!open) return null;
  return <SpotlightSearchPanel onClose={closeSpotlightSearch} initialQuery={openQuery} />;
}

/** ⌘⇧P / Ctrl+Shift+P: exactly Cmd-or-Ctrl plus Shift, no Alt, not during IME composition or key repeat. */
export function isCommandPaletteChord(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'isComposing' | 'repeat' | 'defaultPrevented'>): boolean {
  if (event.isComposing || event.repeat || event.defaultPrevented || event.altKey || !event.shiftKey) return false;
  if (event.metaKey === event.ctrlKey) return false;
  return event.key.toLowerCase() === 'p';
}

// ---------------------------------------------------------------------------

const isMac = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent || '');

/** Dispatches the same chord QuickOpenHost already listens for, so "Search files" opens the
 *  existing quick-open dialog without this file reaching into Workspace.tsx. */
function dispatchQuickOpenChord(): void {
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'p', metaKey: isMac, ctrlKey: !isMac, bubbles: true, cancelable: true }));
}

function ActionIcon({ id }: { id: QuickActionId }): React.ReactElement {
  if (id === 'new-chat') return <SquarePen size={14} />;
  if (id === 'open-folder') return <FolderOpen size={14} />;
  if (id === 'search-files') return <FileSearchIcon size={14} />;
  if (id === 'settings') return <SlidersHorizontal size={14} />;
  if (id === 'providers') return <Settings2 size={14} />;
  if (id === 'plugins') return <Blocks size={14} />;
  if (id === 'memory') return <Brain size={14} />;
  if (id === 'automations') return <CalendarClock size={14} />;
  if (id === 'stashes') return <ArchiveRestore size={14} />;
  if (id === 'import-conversations') return <Download size={14} />;
  return <SquareTerminal size={14} />;
}

function Highlighted({ text, ranges }: { text: string; ranges: SpotlightChatRow['titleRanges'] }): React.ReactElement {
  return <>{splitHighlight(text, ranges).map((part, index) =>
    part.highlighted ? <mark key={index}>{part.text}</mark> : <React.Fragment key={index}>{part.text}</React.Fragment>,
  )}</>;
}


/** Message-content hits per page (the runtime caps at 50); a full page means "Show more" can fetch the next. */
const CONTENT_PAGE = 20;

type PaletteRow =
  | { kind: 'chat'; key: string; row: SpotlightChatRow }
  | { kind: 'more'; key: string }
  | { kind: 'file'; key: string; row: SpotlightFileRow; folderId: string }
  | { kind: 'folder'; key: string; row: SpotlightPlaceRow<Folder> }
  | { kind: 'project'; key: string; row: SpotlightPlaceRow<Project> }
  | { kind: 'action'; key: string; row: SpotlightActionRow }
  | { kind: 'setting'; key: string; row: SpotlightSettingsRow<SectionInfo> }
  | { kind: 'command'; key: string; row: CommandRow };

const SECTION_LABEL: Record<PaletteRow['kind'], string> = {
  chat: 'Chats', more: 'Chats', file: 'Files', folder: 'Folders', project: 'Projects', action: 'Quick actions', setting: 'Settings', command: 'Commands',
};

interface ContentState { query: string; hits: ContentHit[]; more: boolean; loading: boolean }
const NO_CONTENT: ContentState = { query: '', hits: [], more: false, loading: false };

function SpotlightSearchPanel({ onClose, initialQuery = '' }: { onClose: () => void; initialQuery?: string }): React.ReactElement {
  const state = useStore();
  const snapshot = state.snapshot;
  const draft = useNewChatDraft();
  const history = useNavHistory();
  const hiddenSide = useHiddenSideChats();
  const [query, setQuery] = useState(initialQuery);
  const [activeIndex, setActiveIndex] = useState(0);
  const [status, setStatus] = useState('');
  const [gitInfo, setGitInfo] = useState<Record<string, GitRepoInfo | null>>({});
  const inputRef = useRef<HTMLInputElement>(null);
  const listId = useId();
  const { mode, text } = parsePaletteQuery(query);

  // ⌘⇧P while already open switches the open panel into command mode.
  useEffect(() => {
    const listener = (next: string) => { setQuery(next); inputRef.current?.focus(); };
    paletteListeners.add(listener);
    return () => { paletteListeners.delete(listener); };
  }, []);

  const sort = useMemo(() => readChatSort(localStorage), []);
  const titleRows = useMemo<SpotlightChatRow[]>(() => {
    if (!snapshot || mode !== 'search') return [];
    return text
      ? searchChatRows(snapshot.chats.filter((c) => !hiddenSide.has(c.id)), snapshot.folders, snapshot.projects, text)
      : defaultChatRows(chatOrder(snapshot, sort).filter((c) => !hiddenSide.has(c.id)), snapshot.folders, snapshot.projects);
  }, [snapshot, mode, text, sort, hiddenSide]);

  // NAV-11 message content through the runtime index: debounced, stale responses dropped, paged by "Show more".
  const [content, setContent] = useState<ContentState>(NO_CONTENT);
  const contentToken = useRef(0);
  const fetchContent = (q: string, offset: number) => {
    const token = ++contentToken.current;
    setContent((prev) => ({ ...(offset ? prev : { ...NO_CONTENT, query: q }), loading: true }));
    void invoke('chat.search', { query: q, offset, limit: CONTENT_PAGE }).then((rows) => {
      if (token !== contentToken.current) return;
      setContent((prev) => ({ query: q, hits: offset ? [...prev.hits, ...rows] : rows, more: rows.length === CONTENT_PAGE, loading: false }));
    }, () => { if (token === contentToken.current) setContent((prev) => ({ ...prev, more: false, loading: false })); });
  };
  useEffect(() => {
    contentToken.current++;
    if (mode !== 'search' || text.length < 2) { setContent(NO_CONTENT); return; }
    setContent({ ...NO_CONTENT, query: text, loading: true });
    const timer = window.setTimeout(() => fetchContent(text, 0), 180);
    return () => { window.clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, text]);

  // Files: quick open over the folder in view (the draft's target, else the active chat's).
  const activeFolderId = draft.open ? draft.target.folderId : activeChat()?.folderId;
  const [files, setFiles] = useState<{ query: string; paths: string[]; loading: boolean }>({ query: '', paths: [], loading: false });
  useEffect(() => {
    if (mode !== 'search' || !text || !activeFolderId) { setFiles({ query: '', paths: [], loading: false }); return; }
    let live = true;
    setFiles((prev) => ({ ...prev, loading: true }));
    const timer = window.setTimeout(() => {
      void invoke('files.quickOpen', { folderId: activeFolderId, query: text }).then(
        (value) => { if (live) setFiles({ query: text, paths: value.results.map((row) => row.path), loading: false }); },
        () => { if (live) setFiles({ query: text, paths: [], loading: false }); },
      );
    }, 120);
    return () => { live = false; window.clearTimeout(timer); };
  }, [mode, text, activeFolderId]);

  const commandContext = useMemo<CommandContext>(() => {
    const chat = activeChat();
    const folder = chat?.folderId ? snapshot?.folders.find((f) => f.id === chat.folderId) : undefined;
    const ordered = snapshot ? chatOrder(snapshot, sort) : [];
    return {
      screen: state.screen,
      draftOpen: draft.open,
      chat: chat ? { id: chat.id, title: chat.title, status: chat.status, archived: chat.archived, pinned: chat.pinned, unread: !!chat.unread, snoozed: !!(chat.snoozedUntil || chat.snoozeUntilActivity), ...(folder ? { folderName: folder.name } : {}) } : null,
      canBack: history.canBack,
      canForward: history.canForward,
      slotTitles: ordered.slice(0, 9).map((c) => c.title),
      chatCount: ordered.filter((c) => !c.archived && !hiddenSide.has(c.id)).length,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [snapshot, state.screen, state.activeChatId, draft.open, history, sort, hiddenSide]);

  const rows = useMemo<PaletteRow[]>(() => {
    if (mode === 'commands') return commandRows(text, commandContext).map((row) => ({ kind: 'command', key: `command:${row.command.id}`, row }));
    const out: PaletteRow[] = [];
    const hits = content.query === text ? content.hits : [];
    const chats = snapshot ? mergeContentHits(titleRows, hits, snapshot.chats, snapshot.folders, snapshot.projects, hiddenSide) : titleRows;
    for (const row of chats) out.push({ kind: 'chat', key: `chat:${row.chat.id}`, row });
    if (content.more && content.query === text) out.push({ kind: 'more', key: 'more' });
    if (activeFolderId && files.query === text) for (const row of fileRows(text, files.paths)) out.push({ kind: 'file', key: `file:${row.path}`, row, folderId: activeFolderId });
    if (snapshot) {
      for (const row of folderRows(text, snapshot.folders)) out.push({ kind: 'folder', key: `folder:${row.item.id}`, row });
      for (const row of projectRows(text, snapshot.projects)) out.push({ kind: 'project', key: `project:${row.item.id}`, row });
    }
    for (const row of quickActionRows(text)) out.push({ kind: 'action', key: `action:${row.action.id}`, row });
    for (const row of settingsRows(text, SETTINGS_SECTIONS)) out.push({ kind: 'setting', key: `setting:${row.entry.id}`, row });
    return out;
  }, [mode, text, commandContext, content, titleRows, snapshot, hiddenSide, activeFolderId, files]);

  const chatRows = useMemo(() => rows.flatMap((row) => (row.kind === 'chat' ? [row.row] : [])), [rows]);
  const rowCount = rows.length;
  const effectiveIndex = rowCount === 0 ? -1 : Math.min(Math.max(activeIndex, 0), rowCount - 1);
  const pending = mode === 'search' && ((content.loading && text.length >= 2) || (files.loading && !!activeFolderId));

  // The visible set changes with every keystroke; keep the highlight sane (defaults to the top row).
  useEffect(() => { setActiveIndex(0); setStatus(''); }, [query]);

  // Cheap, per-folder "is this a worktree?" lookup (git.info; see git-local.ts's gitInfo — a
  // path-only rev-parse, not a full worktree listing) for the visible rows only, cached for the panel's lifetime.
  useEffect(() => {
    const folderIds = new Set<string>();
    for (const row of chatRows) if (row.chat.folderId) folderIds.add(row.chat.folderId);
    const missing = [...folderIds].filter((id) => !(id in gitInfo));
    if (!missing.length) return;
    let cancelled = false;
    for (const folderId of missing) {
      void invoke('git.info', { folderId }).then(
        (value) => { if (!cancelled) setGitInfo((prev) => (folderId in prev ? prev : { ...prev, [folderId]: value })); },
        () => { if (!cancelled) setGitInfo((prev) => (folderId in prev ? prev : { ...prev, [folderId]: null })); },
      );
    }
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chatRows]);

  const activateChat = (chat: Chat) => {
    onClose();
    closeNewChat();
    if (getState().activeChatId !== chat.id) void selectChat(chat.id).then(() => focusComposer());
    else focusComposer();
  };

  const activateAction = (id: QuickActionId) => {
    if (id === 'new-chat') { onClose(); openNewChat(); return; }
    if (id === 'open-folder') { onClose(); void addFolderToDraft(); return; } // pickFolder (inside) reports its own errors via notifyError
    if (id === 'settings') { onClose(); openAppSettings('general'); return; }
    if (id === 'providers') { onClose(); openProvidersTab(); return; }
    if (id === 'plugins') { onClose(); openPluginsScreen('skills'); return; }
    if (id === 'memory') { onClose(); openMemoryScreen(activeChat()?.folderId); return; }
    if (id === 'automations') { onClose(); openAutomationsScreen(); return; }
    if (id === 'stashes') { onClose(); focusComposer(); window.setTimeout(openStashes, 160); return; } // CMP-19: the focused composer opens its Stashes list
    if (id === 'import-conversations') { onClose(); window.setTimeout(() => openImportConversations(), 160); return; } // CHAT-01: after this panel's exit settles, so the sheet keeps focus
    if (id === 'terminal') { const chat = getNewChatDraft().open ? null : activeChat(); onClose(); if (chat) toggleTerminal(chat.id, chat.title); return; } // UX-24: never the chat behind a draft
    // Close first, then dispatch once this panel's own exit has settled, so QuickOpen's own
    // initialFocus is the last thing to move focus (avoids a focus-restore race between the two dialogs).
    onClose();
    window.setTimeout(dispatchQuickOpenChord, 160);
  };

  /** NAV-12: a disabled command never runs; it says why, in place, and the palette stays open. */
  const activateCommand = (row: CommandRow) => {
    if (!row.state.enabled) { setStatus(`${row.label} is unavailable: ${row.state.reason ?? 'not available here'}.`); return; }
    const id: CommandId = row.command.id;
    if (id === 'search-chats') { setQuery(''); inputRef.current?.focus(); return; }
    if (id === 'search-files') { activateAction('search-files'); return; }
    if (id === 'open-folder' || id === 'new-chat' || id === 'providers' || id === 'plugins' || id === 'memory' || id === 'automations' || id === 'stashes' || id === 'import-conversations') { activateAction(id); return; }
    onClose();
    if (id === 'stop') { const chat = activeChat(); if (chat) void stopChat(chat.id); return; }
    if (id === 'projects') { openProjectsScreen(); return; }
    if (id === 'git-changes' || id === 'git-history' || id === 'git-pull-request') {
      const folderId = activeChat()?.folderId;
      const folder = folderId ? getState().snapshot?.folders.find(item => item.id === folderId) : undefined;
      if (folder) openGitTab(folder.id, folder.name, id === 'git-changes' ? 'changes' : id === 'git-history' ? 'history' : 'pullRequest');
      return;
    }
    // Everything else is a native-menu intent: run exactly what the menu item runs, after this panel has closed
    // (the ⌘1…9 path ignores intents while the palette is open).
    if (isMenuAction(id)) { if (chatSlot(id)) closeNewChat(); runMenuAction(id); }
  };

  const activateRow = (index: number) => {
    const row = rows[index];
    if (!row) return;
    switch (row.kind) {
      case 'chat': activateChat(row.row.chat); return;
      case 'more': fetchContent(text, content.hits.length); return;
      case 'file': onClose(); void openFile(row.folderId, row.row.path); return;
      case 'folder': onClose(); openNewChat({ folderId: row.row.item.id }); return;
      case 'project': onClose(); openProject(row.row.item.id); return;
      case 'action': activateAction(row.row.action.id); return;
      case 'setting': onClose(); openAppSettings(row.row.entry.id); return;
      case 'command': activateCommand(row.row); return;
    }
  };

  const renderRow = (row: PaletteRow, index: number): React.ReactElement => {
    const active = index === effectiveIndex;
    const disabled = row.kind === 'command' && !row.row.state.enabled;
    const common = {
      id: `spotlight-row-${index}`,
      role: 'option' as const,
      'aria-selected': active,
      'aria-disabled': disabled || undefined,
      className: `spotlight-row${disabled ? ' is-disabled' : ''}`,
      'data-active': active ? '' : undefined,
      onMouseEnter: () => setActiveIndex(index),
      onClick: () => activateRow(index),
    };
    switch (row.kind) {
      case 'chat': {
        const info = row.row.chat.folderId ? gitInfo[row.row.chat.folderId] : null;
        const chatIndex = chatRows.indexOf(row.row);
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon">{info?.worktree ? <GitBranch size={14} /> : <StatusDot status={row.row.chat.status} unread={row.row.chat.unread} />}</span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={row.row.chat.title} ranges={row.row.titleRanges} /></span>
            {row.row.snippet && <span className="spotlight-row-snippet"><Highlighted text={row.row.snippet} ranges={row.row.snippetRanges ?? []} /></span>}
          </span>
          <span className="spotlight-row-location">{row.row.location}</span>
          {chatIndex >= 0 && chatIndex < MAX_CHAT_RESULTS && <kbd className="spotlight-shortcut">⌘{chatIndex + 1}</kbd>}
        </button>;
      }
      case 'more':
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon"><ChevronsDown size={14} /></span>
          <span className="spotlight-row-title">{content.loading ? 'Loading more message matches…' : 'Show more message matches'}</span>
        </button>;
      case 'file':
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon"><FileTypeIcon path={row.row.path} /></span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={row.row.name} ranges={row.row.nameRanges} /></span>
            {row.row.dir && <span className="spotlight-row-snippet">{row.row.dir}</span>}
          </span>
          <span className="spotlight-row-location">File</span>
        </button>;
      case 'folder':
        return <button key={row.key} type="button" {...common} title={`New chat in ${row.row.item.name}`}>
          <span className="spotlight-row-icon"><FolderIcon size={14} /></span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={row.row.item.name} ranges={row.row.labelRanges} /></span>
            <span className="spotlight-row-snippet">{row.row.detail}</span>
          </span>
          <span className="spotlight-row-location">Folder</span>
        </button>;
      case 'project':
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon"><Layers size={14} /></span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={row.row.item.name} ranges={row.row.labelRanges} /></span>
            <span className="spotlight-row-snippet">{row.row.detail}</span>
          </span>
          <span className="spotlight-row-location">Project</span>
        </button>;
      case 'action':
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon"><ActionIcon id={row.row.action.id} /></span>
          <span className="spotlight-row-title"><Highlighted text={row.row.action.label} ranges={row.row.labelRanges} /></span>
          <kbd className="spotlight-shortcut">{row.row.action.shortcut}</kbd>
        </button>;
      case 'setting':
        return <button key={row.key} type="button" {...common}>
          <span className="spotlight-row-icon"><SlidersHorizontal size={14} /></span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={row.row.entry.label} ranges={row.row.labelRanges} /></span>
            <span className="spotlight-row-snippet">{row.row.entry.description}</span>
          </span>
          <span className="spotlight-row-location">Settings</span>
        </button>;
      case 'command': {
        const { state: commandState, command, label, labelRanges } = row.row;
        const detail = commandState.enabled ? commandState.scope : commandState.reason;
        return <button key={row.key} type="button" {...common} title={commandState.enabled ? undefined : commandState.reason}>
          <span className="spotlight-row-icon"><Command size={14} /></span>
          <span className="spotlight-row-text">
            <span className="spotlight-row-title"><Highlighted text={label} ranges={labelRanges} /></span>
            {detail && <span className="spotlight-row-snippet">{detail}</span>}
          </span>
          <span className="spotlight-row-location">{command.group}</span>
          {command.shortcut && <kbd className="spotlight-shortcut">{command.shortcut}</kbd>}
        </button>;
      }
    }
  };

  const sections: Array<{ label: string; rows: Array<{ row: PaletteRow; index: number }> }> = [];
  rows.forEach((row, index) => {
    const label = SECTION_LABEL[row.kind];
    const last = sections.at(-1);
    if (last && last.label === label) last.rows.push({ row, index }); else sections.push({ label, rows: [{ row, index }] });
  });
  const empty = paletteEmptyState(query);
  const label = mode === 'commands' ? 'Command palette' : 'Search chats';

  return (
    <Dialog.Root open onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Backdrop className="spotlight-backdrop" />
        <Dialog.Popup className="spotlight-panel" initialFocus={inputRef} aria-label={label}>
          <label className="spotlight-search-field">
            {mode === 'commands' ? <Command size={16} aria-hidden="true" /> : <Search size={16} aria-hidden="true" />}
            <input
              ref={inputRef}
              type="text"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={mode === 'commands' ? 'Run a command' : 'Search chats, messages, files, folders — type > for commands'}
              aria-label={label}
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={effectiveIndex >= 0 ? `spotlight-row-${effectiveIndex}` : undefined}
              autoComplete="off"
              spellCheck={false}
              maxLength={256}
              onFocus={(event) => { const input = event.currentTarget; if (initialQuery) input.setSelectionRange(input.value.length, input.value.length); }}
              onKeyDown={(event) => {
                if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex(moveHighlight(rowCount, effectiveIndex, 1)); }
                else if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex(moveHighlight(rowCount, effectiveIndex, -1)); }
                else if (event.key === 'Enter') { event.preventDefault(); activateRow(effectiveIndex); }
                else {
                  const slot = ['1', '2', '3', '4', '5', '6', '7', '8', '9'].findIndex((digit) => isChord(event.nativeEvent, digit));
                  if (slot === -1) return;
                  const row = chatRows[slot];
                  if (!row) return;
                  event.preventDefault();
                  activateChat(row.chat);
                }
              }}
            />
          </label>
          <div className="spotlight-results" id={listId} role="listbox" aria-label={mode === 'commands' ? 'Commands' : 'Search results'} aria-busy={pending || undefined}>
            {rowCount === 0
              ? pending
                ? <ResourceState kind="loading" label="Searching" rows={3} compact />
                : <ResourceState kind="empty" compact icon={mode === 'commands' ? <Command size={16} /> : <Search size={16} />} title={empty.title} message={empty.message} />
              : sections.map((section) => (
                <div key={`${section.label}:${section.rows[0].index}`} className="spotlight-section">
                  <div className="spotlight-section-label">{section.label}</div>
                  {section.rows.map(({ row, index }) => renderRow(row, index))}
                </div>
              ))}
          </div>
          <p className="spotlight-status" role="status" aria-live="polite">{status}</p>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
