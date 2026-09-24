import {
  Copy,
  MessagesSquare,
  Files as FileIcon,
  GitCompare,
  Globe,
  Pin,
  PinOff,
  Search,
  SquareTerminal,
  X,
  XCircle,
} from 'lucide-react';
import { Menu } from '@base-ui/react/menu';
import React, { useDeferredValue, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { subscribe, invoke } from '../bridge';
import './resource-tabs.css';
import {
  activateTab,
  closeOtherTabs,
  getState,
  closeTab,
  closeTabsToRight,
  hydrateTab,
  makeTabPermanent,
  moveTabDirection,
  openDiff,
  openBrowserTab,
  openChangesTab,
  openFile,
  openFilesTab,
  notifyError,
  notifySuccess,
  pickFolder,
  pinTab,
  reorderTab,
  updateBrowserTabUrl,
  type WorkspaceTab,
} from '../store';
import { useStore, useStoreSelector } from '../useStore';
import {cleanIpcError} from './resourceErrors';
import {useRevealedPath} from './fileReveal';
import {addFolderToDraft, useNewChatDraft} from '../newChatDraft';
import {saveScrollOffset, scrollOffset} from '../resourceViewState';
import {FileTree} from './FileTree';
import {FileTypeIcon, ResourceTabIcon} from './FileTypeIcon';
import {ResourceAddMenu, recordClosedTab, recentlyClosedTabs, reopenClosedTab} from './ResourceAddMenu';
import {ResourceState} from './ResourceState';
import {FileTab} from './FileTab';
import {AttachmentTab} from './AttachmentTab';
import {DiffView} from './DiffView';
import {ConflictTab} from './ConflictTab';
import {GitTab} from './GitTab';
import {LazyBoundary,LazyScopedComputerTab} from '../lazyScreens';
import {AreaBoundary} from './AreaBoundary';
import {ProcessesTab, openTerminalTab} from './ProcessesTab';
import {BrowserTab} from './BrowserTab';
import {SubagentsTab} from './SubagentsTab';
import {MailboxInbox} from './MailboxInbox';
import {CanvasTab} from './CanvasTab';
import {SideChatTab} from './SideChatTab';
import {PluginUiTab} from './PluginUiTab';
import {ensureArtifactSync, openSideChat, selectedText, sideChatBindingForTab} from '../artifacts';
import {QuickOpenHost} from './QuickOpen';
import type {FileContentMatch} from '../../shared/domains/files-protocol';
import {Tip} from './Tooltip';


// ---------------------------------------------------------------------------
// Browser favicons

// Only inline raster/SVG images: the renderer CSP allows data: images and nothing remote.
const FAVICON = /^data:image\/(?:png|x-icon|vnd\.microsoft\.icon|gif|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/;
/** Favicons reported with browser state, keyed by tab id (the browser surface owner). */
// Survives the pane unmounting (hidden or maximized chat) so tabs do not flash back to the globe.
let faviconCache: Record<string, string> = {};
function useBrowserFavicons(): Readonly<Record<string, string>> {
  const [icons, setState] = useState(faviconCache);
  const setIcons = (update: (previous: Record<string, string>) => Record<string, string>) => setState(previous => (faviconCache = update(previous)));
  useEffect(() => subscribe(event => {
    if (event.type === 'browserClosed') { setIcons(previous => { if (!(event.owner in previous)) return previous; const next = {...previous}; delete next[event.owner]; return next; }); return; }
    if (event.type !== 'browserState') return;
    // Main already inlines favicons as data: URLs (≤64 KB); re-check before handing one to <img>.
    const raw = event.state.favicon;
    const icon = raw && raw.length <= 96 * 1024 && FAVICON.test(raw) ? raw : '';
    setIcons(previous => (previous[event.state.owner] ?? '') === icon ? previous : {...previous, [event.state.owner]: icon});
  }), []);
  return icons;
}

// ---------------------------------------------------------------------------
// Content search (WRK-07): snippets with a click to jump to the matched line.

function FileContentSearch({folderId, onOpen}: {folderId: string; onOpen: () => void}): React.ReactElement {
  const [query, setQuery] = useState('');
  const deferredQuery = useDeferredValue(query);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [regex, setRegex] = useState(false);
  const [matches, setMatches] = useState<FileContentMatch[] | null>(null);
  const [truncated, setTruncated] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const trimmed = deferredQuery.trim();
    if (!trimmed) { setMatches(null); setError(''); setTruncated(false); return; }
    let live = true;
    // Globally unique per search: a per-component counter would collide across two
    // FileContentSearch instances (e.g. two folders' Files tabs open at once), letting
    // one tab's cleanup cancel another tab's in-flight search on the runtime side.
    const id = crypto.randomUUID();
    const timer = setTimeout(() => {
      void invoke('files.searchContent', {folderId, query: trimmed, caseSensitive, regex, requestId: id}).then(
        value => { if (live) { setMatches(value.matches); setTruncated(value.truncated); setError(''); } },
        cause => { if (live) setError(cleanIpcError(cause) || 'Search failed.'); },
      );
    }, 250);
    return () => { live = false; clearTimeout(timer); void invoke('files.searchContent.cancel', {requestId: id}).catch(() => {}); };
  }, [folderId, deferredQuery, caseSensitive, regex]);
  const byFile = new Map<string, FileContentMatch[]>();
  for (const match of matches ?? []) { const list = byFile.get(match.path) ?? []; list.push(match); byFile.set(match.path, list); }
  return <div className="file-content-search">
    <div className="file-content-search-controls">
      <label className="file-search"><Search size={13}/><input type="search" aria-label="Search file contents" placeholder="Search in files…" maxLength={512} value={query} onChange={event => setQuery(event.target.value)} autoFocus/></label>
      <button type="button" className="file-content-search-toggle" aria-pressed={caseSensitive} title="Match case" onClick={() => setCaseSensitive(v => !v)}>Aa</button>
      <button type="button" className="file-content-search-toggle" aria-pressed={regex} title="Use regular expression" onClick={() => setRegex(v => !v)}>.*</button>
    </div>
    <div className="file-content-search-results">
      {!query.trim() ? null
        : error ? <ResourceState kind="error" message={error} compact/>
        : !matches ? <ResourceState kind="loading" label="Searching" rows={3} compact/>
        : matches.length === 0 ? <ResourceState kind="empty" message="No matches." compact/>
        : <>
          {[...byFile.entries()].map(([path, hits]) => <div key={path}>
            <div className="file-content-search-file" title={path}>{path}</div>
            {hits.map((hit, index) => <button key={index} type="button" className="file-content-search-hit" onClick={() => { onOpen(); void openFile(folderId, hit.path, hit.line); }}>
              <span className="file-content-search-line">{hit.line}</span>
              <span className="file-content-search-snippet">{hit.text}</span>
            </button>)}
          </div>)}
          {truncated && <p className="file-format-note" role="status">Partial results: search limits or inaccessible folders were encountered. Narrow your search.</p>}
        </>}
    </div>
  </div>;
}

// ---------------------------------------------------------------------------
// Changes and Files tabs

/**
 * The Files tab is the folder tree, as in Codex: clicking a file opens it in its own tab, so the
 * viewer never shares its width with a second tree. The header toggles content search (WRK-07).
 */
function FilesTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const folderId = tab.folderId!;
  const [searching, setSearching] = useState(false);
  const revealed = useRevealedPath(folderId);
  const activeFile = useStoreSelector(state => { const active = state.tabs.find(item => item.kind === 'file' && item.folderId === folderId && item.id === state.activeTabId); return active?.path; });
  const highlighted = revealed ?? activeFile;
  // Scroll the revealed row into view once the tree has painted it.
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!revealed) return;
    const frame = requestAnimationFrame(() => {
      const row = Array.from(host.current?.querySelectorAll<HTMLElement>('.tree-row') ?? []).find(item => item.title === revealed);
      if (!row) return;
      const scroller = row.closest<HTMLElement>('.workspace-body');
      if (scroller) scroller.scrollTop += row.getBoundingClientRect().top - scroller.getBoundingClientRect().top - scroller.clientHeight / 3;
      row.focus({preventScroll: true});
    });
    return () => cancelAnimationFrame(frame);
  }, [revealed]);
  return <div className="files-tab files-explorer" ref={host}>
    <section className="files-browser">
      <header className="files-section-head">
        <span>Files</span>
        <Tip label={searching ? 'Browse files' : 'Search file contents'}><button type="button" className="icon-button" aria-pressed={searching} aria-label={searching ? 'Browse files' : 'Search file contents'} onClick={() => setSearching(v => !v)}>
          {searching ? <X size={12}/> : <Search size={12}/>}
        </button></Tip>
      </header>
      {searching ? <FileContentSearch folderId={folderId} onOpen={() => setSearching(false)}/> : <FileTree folderId={folderId} path="" activePath={highlighted}/>}
    </section>
  </div>;
}

// ---------------------------------------------------------------------------
// File contents

// ---------------------------------------------------------------------------
// Shell

function TabBody({ tab, visible, onToggleResourceMaximize, resourceMaximized }: { tab: WorkspaceTab; visible:boolean; onToggleResourceMaximize?:()=>void; resourceMaximized?:boolean }): React.ReactElement {
  useEffect(() => hydrateTab(tab), [tab.id]);
  switch (tab.kind) {
    case 'computer':
      return <LazyBoundary label="sandbox"><LazyScopedComputerTab scope={tab.scope!}/></LazyBoundary>;
    case 'processes':
      return <ProcessesTab chatId={tab.chatId!} active={visible}/>;
    case 'browser':
      return <BrowserTab owner={tab.id} profileId={tab.browserProfileId ?? 'personal'} initialUrl={tab.url} active={visible} onUrlChange={url=>updateBrowserTabUrl(tab.id,url)}/>;
    case 'files':
      return <FilesTab tab={tab} />;
    case 'git':
    case 'changes':
    case 'history':
    case 'pullRequest':
      // One Git surface per folder; older in-memory kinds render the same tab on their segment.
      return <GitTab tab={tab} />;
    case 'file':
      return <FileTab tab={tab} onToggleResourceMaximize={onToggleResourceMaximize} resourceMaximized={resourceMaximized}/>;
    case 'attachment':
      return <AttachmentTab tab={tab}/>;
    case 'diff':
      return <DiffView tab={tab} />;
    case 'subagents':
      return <SubagentsTab tab={tab} />;
    case 'inbox':
      return tab.chatId ? <MailboxInbox chatId={tab.chatId} /> : <p className="subagents-status is-error" role="status">This saved tab has no conversation reference.</p>;
    case 'conflict':
      return <ConflictTab tab={tab} />;
    case 'canvas':
      return <CanvasTab tab={tab} />;
    case 'sideChat':
      return <SideChatTab tab={tab} />;
    case 'pluginUi':
      return <PluginUiTab tab={tab} />;
  }
}

/** Every terminal surface is called "Terminal" (tab, tile, + menu, summary), whatever older saved titles say. */
export function resourceTabTitle(tab: WorkspaceTab, folderName?: string): string {
  if (tab.kind === 'git' || tab.kind === 'changes' || tab.kind === 'history' || tab.kind === 'pullRequest') return `Git · ${folderName ?? tab.title.replace(/^(?:Git|Changes|History) · /, '')}`;
  return tab.kind === 'processes' ? 'Terminal' : tab.title;
}

type Launcher = {label: string; icon: React.ReactNode; run: () => void};
/**
 * Empty pane: Codex's four centred tiles (Changes, Browser, Terminal, Files), scoped to the chat or
 * the new-chat draft. A tile that cannot work here is left out and one line says why; nothing is inert.
 */
function ResourceLaunchers({draft}: {draft?: {folderId?: string; projectId?: string}}): React.ReactElement {
  const state = useStore();
  const chat = draft ? undefined : state.snapshot?.chats.find(c => c.id === state.activeChatId);
  const project = draft?.projectId ? state.snapshot?.projects.find(item => item.id === draft.projectId) : undefined;
  const folderId = draft ? draft.folderId ?? (project?.primaryFolderId ?? project?.folderIds[0]) : chat?.folderId;
  const folder = state.snapshot?.folders.find(f => f.id === folderId && !f.missing);
  const tiles: Launcher[] = [];
  if (folder) tiles.push({label: 'Changes', icon: <GitCompare size={18} strokeWidth={1.6}/>, run: () => { showInDraft(`git:${folder.id}`); openChangesTab(folder.id, folder.name); }});
  tiles.push({label: 'Browser', icon: <Globe size={18} strokeWidth={1.6}/>, run: () => openBrowserTab()});
  // A real PTY shell in the chat's folder; a draft has no conversation to own one yet.
  if (chat) tiles.push({label: 'Terminal', icon: <SquareTerminal size={18} strokeWidth={1.6}/>, run: () => openTerminalTab(chat.id, 'Terminal', 'terminals')});
  if (folder) tiles.push({label: 'Files', icon: <FileIcon size={18} strokeWidth={1.6}/>, run: () => { showInDraft(`files:${folder.id}`); openFilesTab(folder.id, folder.name); }});
  const reasons: string[] = [];
  // NAV-13: a folderless chat names where work runs instead of inventing a repository; attaching one is explicit.
  const missing = !!state.snapshot?.folders.some(f => f.id === folderId && f.missing);
  if (missing) reasons.push(draft ? 'That folder is missing. Pick another to browse its files and changes.' : 'This chat’s folder is missing. Relink it from the sidebar to browse its files and changes.');
  else if (!folder) reasons.push(draft ? 'Attach a folder to browse its files and changes.' : 'Files and Changes appear when the chat has a folder.');
  if (chat && !chat.folderId) reasons.push('Terminal opens in this chat’s private scratch folder, not in your files.');
  if (!chat && draft) reasons.push('Terminal opens once the chat starts.');
  const canAttach = !folder && !missing && (draft ? true : !!chat && !chat.archived && chat.status !== 'running' && chat.status !== 'stopping');
  const attach = async () => {
    if (draft) { await addFolderToDraft(); return; }
    if (!chat) return;
    const picked = await pickFolder();
    if (!picked) return;
    try { await invoke('chat.update', {id: chat.id, folderId: picked.id}); notifySuccess(`${picked.name} attached · the next message runs there`); }
    catch (cause) { notifyError(cause); }
  };
  return <div className="resource-empty">
    <div className="resource-launchers" role="group" aria-label="Open a resource" data-count={tiles.length}>
      {tiles.map(tile => <button key={tile.label} type="button" onClick={tile.run}>{tile.icon}<span>{tile.label}</span></button>)}
    </div>
    {reasons.length > 0 && <p className="resource-launchers-note">{reasons.join(' ')}</p>}
    {canAttach && <button type="button" className="resource-launchers-attach" onClick={() => void attach()}>Attach Folder…</button>}
  </div>;
}

/** Tabs that belonged to the chat on screen when New chat was pressed; the draft never shows them. */
let draftHiddenTabs: Set<string> | null = null;
let draftOpenedOver: string | null = null;
/** A resource opened from the draft is shown even if the previous chat already had it open. */
function showInDraft(id: string): void { draftHiddenTabs?.delete(id); }

export function Workspace({headerAction, onToggleResourceMaximize, resourceMaximized=false}: {headerAction?:React.ReactNode; onToggleResourceMaximize?:()=>void; resourceMaximized?:boolean}): React.ReactElement | null {
  const state = useStore();
  const draft = useNewChatDraft();
  if (draft.open) {
    if (!draftHiddenTabs) { draftHiddenTabs = new Set(state.tabs.map(tab => tab.id)); draftOpenedOver = state.activeTabId; }
    // Anything activated after the draft opened (from the + menu, a link, a tile) belongs to the draft view.
    else if (state.activeTabId && state.activeTabId !== draftOpenedOver) draftHiddenTabs.delete(state.activeTabId);
  } else { draftHiddenTabs = null; draftOpenedOver = null; }
  // A new-chat draft starts from an empty pane; anything opened from the draft itself still shows.
  const tabs = draftHiddenTabs ? state.tabs.filter(tab => !draftHiddenTabs!.has(tab.id)) : state.tabs;
  const favicons = useBrowserFavicons();
  useEffect(ensureArtifactSync, []);
  const tabButtons = useRef(new Map<string, HTMLButtonElement>());
  const strip = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const tabCount = tabs.length;
  const activeId = tabs.find((t) => t.id === state.activeTabId)?.id ?? tabs[0]?.id;
  // Edge fades: mark which side(s) of the strip still hide tabs. Attributes go on the
  // shell (the strip's parent) so the fades sit outside the scrolling box.
  useEffect(() => {
    const el = strip.current;
    if (!el) return;
    const shell = el.parentElement;
    const update = () => {
      const max = Math.max(0, (el.scrollWidth ?? 0) - (el.clientWidth ?? 0));
      const left = el.scrollLeft ?? 0;
      shell?.setAttribute('data-fade-start', String(max > 0 && left > 1));
      shell?.setAttribute('data-fade-end', String(max > 0 && left < max - 1));
    };
    update();
    el.addEventListener('scroll', update, {passive: true});
    // Vertical wheel scrolls the strip horizontally (React's onWheel is passive, so bind natively).
    const wheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if ((el.scrollWidth ?? 0) <= (el.clientWidth ?? 0)) return;
      event.preventDefault();
      el.scrollLeft += event.deltaY;
    };
    el.addEventListener('wheel', wheel, {passive: false});
    const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : undefined;
    observer?.observe(el);
    for (const child of Array.from(el.children)) observer?.observe(child);
    return () => { el.removeEventListener('scroll', update); el.removeEventListener('wheel', wheel); observer?.disconnect(); };
  }, [tabCount]);
  // Keep the active tab fully in view. Scroll only the strip: Element.scrollIntoView also scrolls
  // clipped ancestors (the pane, the app shell), which shifted the whole header and cut off the first tab.
  useLayoutEffect(() => {
    const el = strip.current;
    const target = activeId ? tabButtons.current.get(activeId)?.closest<HTMLElement>('.workspace-tab') : undefined;
    if (!el || !target || typeof target.offsetLeft !== 'number') return;
    const inset = 24; // clear the edge fade
    const start = target.offsetLeft - el.offsetLeft, end = start + target.offsetWidth;
    if (start - inset < el.scrollLeft) el.scrollLeft = Math.max(0, start - inset);
    else if (end + inset > el.scrollLeft + el.clientWidth) el.scrollLeft = end + inset - el.clientWidth;
  }, [activeId, tabCount]);
  // The panel scroller is shared by every tab; give each tab back its own offset (WRK-05).
  useLayoutEffect(() => {
    if (body.current && activeId) body.current.scrollTop = scrollOffset(`body:${activeId}`) ?? 0;
  }, [activeId]);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<{id: string; side: 'before' | 'after'} | null>(null);
  // Cmd+Shift+T reopens the most recently closed resource; a chord check so a bare Shift+T never fires it.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isChord = (event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 't';
      if (!isChord) return;
      const last = recentlyClosedTabs()[0];
      if (!last) return;
      event.preventDefault();
      reopenClosedTab(last);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  if (tabs.length === 0) return <><div className="workspace-head workspace-head-empty">{headerAction}</div><ResourceLaunchers draft={draft.open ? draft.target : undefined}/><QuickOpenHost/></>;
  const active = tabs.find((t) => t.id === state.activeTabId) ?? tabs[0];
  const folderNames = new Map((state.snapshot?.folders ?? []).map(folder => [folder.id, folder.name] as const));
  const titleOf = (tab: WorkspaceTab) => resourceTabTitle(tab, tab.folderId ? folderNames.get(tab.folderId) : undefined);
  const focusTab = (id: string) => requestAnimationFrame(() => tabButtons.current.get(id)?.focus());
  const closeAndFocus = (id: string) => {
    if (state.dirtyTabs[id] && !window.confirm('This file has unsaved changes. Close it anyway?')) return;
    const index = tabs.findIndex(t => t.id === id);
    const remaining = tabs.filter(t => t.id !== id);
    // Every close from the strip is reopenable from the '+' menu's Recently closed list or Cmd+Shift+T.
    if (index >= 0) recordClosedTab(tabs[index]);
    closeTab(id);
    const next = id === active.id ? remaining[Math.min(index, remaining.length - 1)] : active;
    if (next) focusTab(next.id);
  };
  const navigate = (event: React.KeyboardEvent, id: string) => {
    if (event.altKey && event.shiftKey && !event.metaKey && !event.ctrlKey && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
      event.preventDefault();
      moveTabDirection(id, event.key === 'ArrowLeft' ? 'left' : 'right');
      focusTab(id);
      return;
    }
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const index = tabs.findIndex(t => t.id === id);
    const target = event.key === 'ArrowRight' ? (index + 1) % tabs.length
      : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length
      : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : -1;
    if (target >= 0) { event.preventDefault(); const next = tabs[target]; activateTab(next.id); focusTab(next.id); }
    else if (event.key === 'Delete') { event.preventDefault(); closeAndFocus(id); }
  };
  const onTabDragOver = (event: React.DragEvent, tab: WorkspaceTab) => {
    if (!dragId || dragId === tab.id) return;
    event.preventDefault();
    const rect = event.currentTarget.getBoundingClientRect();
    const side = event.clientX - rect.left < rect.width / 2 ? 'before' : 'after';
    setDropTarget(previous => previous?.id === tab.id && previous.side === side ? previous : {id: tab.id, side});
  };
  const onTabDrop = (event: React.DragEvent, tab: WorkspaceTab) => {
    event.preventDefault();
    if (dragId && dropTarget) {
      const targetIndex = tabs.findIndex(t => t.id === dropTarget.id);
      reorderTab(dragId, dropTarget.side === 'before' ? targetIndex : targetIndex + 1);
    }
    setDragId(null); setDropTarget(null);
  };
  return (
    <>
      <div className="workspace-head"><div className="workspace-tabs-shell"><div className="workspace-tabs" role="tablist" aria-label="Open resources" ref={strip}>
        {tabs.map((tab) => (
          <TabContextMenu key={tab.id} tab={tab} isLast={tab.id === tabs[tabs.length - 1]?.id} onClose={closeAndFocus}>
            <div
              draggable
              onDragStart={() => setDragId(tab.id)}
              onDragOver={e => onTabDragOver(e, tab)}
              onDragLeave={() => setDropTarget(previous => previous?.id === tab.id ? null : previous)}
              onDrop={e => onTabDrop(e, tab)}
              onDragEnd={() => { setDragId(null); setDropTarget(null); }}
              className={[
                'workspace-tab',
                tab.id === active.id && 'is-active',
                tab.preview && 'is-preview',
                tab.pinned && 'is-pinned',
                dragId === tab.id && 'is-dragging',
                dropTarget?.id === tab.id && `drop-${dropTarget.side}`,
              ].filter(Boolean).join(' ')}
            >
              <button
                type="button"
                role="tab"
                id={`resource-tab-${tab.id}`}
                aria-controls="active-resource-panel"
                tabIndex={tab.id === active.id ? 0 : -1}
                ref={el=>{ if (el) tabButtons.current.set(tab.id,el); else tabButtons.current.delete(tab.id); }}
                onKeyDown={e=>navigate(e,tab.id)}
                aria-selected={tab.id === active.id}
                className="workspace-tab-label"
                title={titleOf(tab)}
                onClick={() => activateTab(tab.id)}
                onDoubleClick={() => makeTabPermanent(tab.id)}
                onAuxClick={e=>{if(e.button===1){e.preventDefault();closeAndFocus(tab.id);}}}
              >
                {tab.kind === 'browser' && favicons[tab.id] ? <img className="workspace-tab-icon workspace-tab-favicon" src={favicons[tab.id]} alt="" aria-hidden="true" draggable={false}/> : <ResourceTabIcon tab={tab}/>}
                <span className="workspace-tab-title">{titleOf(tab)}</span>
                {state.dirtyTabs[tab.id] && <span className="workspace-tab-dirty-dot" aria-label="Unsaved changes" title="Unsaved changes"/>}
                {tab.pinned && <Pin size={11} className="workspace-tab-icon" aria-hidden="true"/>}
              </button>
              <button
                type="button"
                className="icon-button workspace-tab-close"
                aria-label={`Close ${titleOf(tab)}`}
                onClick={() => closeAndFocus(tab.id)}
              >
                <X size={12} />
              </button>
            </div>
          </TabContextMenu>
        ))}
      </div></div><ResourceAddMenu/>{headerAction}</div>
      <div className="workspace-body" ref={body} onScroll={event => saveScrollOffset(`body:${active.id}`, event.currentTarget.scrollTop)} role="tabpanel" id="active-resource-panel" aria-labelledby={`resource-tab-${active.id}`}>
        <AreaBoundary key={active.id} area={`the ${resourceTabTitle(active)} tab`} scope="pane"><TabBody tab={active} visible={!state.resourcesHidden && state.rightPaneMode==='resources' && state.screen==='work'} onToggleResourceMaximize={onToggleResourceMaximize} resourceMaximized={resourceMaximized}/></AreaBoundary>
      </div>
      <QuickOpenHost/>
    </>
  );
}

/** Right-click menu for a resource tab: Close, Close Others, Close to the Right, Pin, Copy path.
 * Uses a virtual anchor at the cursor rather than `Menu.Trigger`, so the tab's own click/drag handlers stay untouched. */
function TabContextMenu({tab, isLast, onClose, children}: {tab: WorkspaceTab; isLast: boolean; onClose: (id: string) => void; children: React.ReactElement}): React.ReactElement {
  const [anchor, setAnchor] = useState<{getBoundingClientRect(): DOMRect} | null>(null);
  const copyPath = () => void invoke('clipboard.write', {text: tab.path ?? tab.url ?? tab.title}).catch(() => {});
  const onContextMenu = (event: React.MouseEvent) => {
    event.preventDefault();
    const {clientX: x, clientY: y} = event;
    setAnchor({getBoundingClientRect: () => new DOMRect(x, y, 0, 0)});
  };
  return <Menu.Root open={anchor !== null} onOpenChange={next => { if (!next) setAnchor(null); }}>
    {React.cloneElement(children, {onContextMenu} as React.HTMLAttributes<HTMLElement>)}
    <Menu.Portal><Menu.Positioner anchor={anchor} side="bottom" align="start" sideOffset={2} className="file-action-positioner"><Menu.Popup className="ui-menu tab-context-menu">
      <Menu.Item onClick={() => onClose(tab.id)}><XCircle size={13}/>Close</Menu.Item>
      <Menu.Item onClick={() => closeOtherTabs(tab.id)}>Close Others</Menu.Item>
      <Menu.Item disabled={isLast} onClick={() => closeTabsToRight(tab.id)}>Close to the Right</Menu.Item>
      <div className="tab-context-menu-sep"/>
      <Menu.Item onClick={() => pinTab(tab.id, !tab.pinned)}>{tab.pinned ? <PinOff size={13}/> : <Pin size={13}/>}{tab.pinned ? 'Unpin tab' : 'Pin tab'}</Menu.Item>
      {(tab.path || tab.url) && <Menu.Item onClick={copyPath}><Copy size={13}/>Copy path</Menu.Item>}
      {sideChatBindingForTab(tab) && <Menu.Item onClick={() => {
        // WRK-13: a selection inside the open resource rides along as the side chat's excerpt.
        const binding = sideChatBindingForTab(tab, tab.id === getState().activeTabId ? selectedText(document.getElementById('active-resource-panel')) : '');
        if (binding) void openSideChat(binding);
      }}><MessagesSquare size={13}/>Ask in side chat</Menu.Item>}
    </Menu.Popup></Menu.Positioner></Menu.Portal>
  </Menu.Root>;
}
