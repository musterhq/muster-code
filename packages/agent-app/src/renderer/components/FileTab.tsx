import React, {useEffect, useLayoutEffect, useRef, useState, useMemo, useCallback} from 'react';
import {Menu} from '@base-ui/react/menu';
import {Check, ChevronDown, ChevronUp, Copy, ChevronRight, History as BlameIcon, MessageSquarePlus, Pencil, Search, TriangleAlert, WrapText, X as XIcon} from 'lucide-react';
import {BlameView} from './BlameView';
import {openFile, refreshFileBody, setTabDirty, type WorkspaceTab} from '../store';
import {invoke} from '../bridge';
import {buildCumulativeFileDiff, buildInlineFileDiff} from '../inlineFileDiffModel';
import type {ReviewFileDiff, ReviewWriteResult} from '../../shared/domains/review-protocol';
import {addReviewContext, keepHunks, keptFor, latestBaseline, refreshRunMarks, useChatBaselines, useRunMarks} from '../reviewState';
import './inline-file-diff.css';
import {useStoreSelector} from '../useStore';
import {saveScrollOffset, scrollOffset} from '../resourceViewState';
import {MessageBody} from './MessageBody';
import {ImageFile} from './ImageFile';
import {StructuredFile} from './StructuredFile';
import {breadcrumbSegments, filePresentation, isBinaryReadError, isLibreOfficeMissing} from './filePresentation';
import {revealInFiles} from './fileReveal';
import './file-preview.css';
import './markdown-document.css';
import {OpenInMenu} from './OpenInMenu';
import {NativeDocument} from './NativeDocument';
import {PdfFile} from './PdfFile';
import {WorkbookFile} from './WorkbookFile';
import {FileAnnotations} from './FileAnnotations';
import {HighlightedSourceTable} from './HighlightedCode';
import {codeLanguageFromPath} from './codeLanguage';
import {InlineFileSource, type InlineFileReview} from './InlineFileSource';
import {friendlyFileError, parseDelimited, delimitedCellType} from './filePresentation';
import {ResourceState} from './ResourceState';
import {FileExitActions, FileFallback, HtmlPreview, MediaFile, QuickLookFile} from './FilePreviews';

// Keep Markdown parsing bounded independently of the host's file-read limit.
const MARKDOWN_LIMIT = 64 * 1024;
const SCROLLERS = '.code-scroll, .file-markdown, .html-preview';

/** A short-lived confirmation for copy actions. */
function useCopied(): [string, (text: string, label: string) => void] {
  const [copied, setCopied] = useState('');
  useEffect(() => { if (!copied) return; const timer = setTimeout(() => setCopied(''), 1600); return () => clearTimeout(timer); }, [copied]);
  return [copied, (text, label) => void invoke('clipboard.write', {text}).then(() => setCopied(label), error => setCopied(friendlyFileError(error)))];
}

/** Root › first › … › parent › file: the filename never scrolls away; the fold opens on hover, focus or click. Every folder opens in the navigator. */
function FileBreadcrumbs({folderName, folderPath, path, onBrowse}: {folderName: string; folderPath?: string; path: string; onBrowse: (path: string) => void}): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const parts = path.split('/').filter(Boolean);
  const {head, middle, tail} = breadcrumbSegments(path);
  const crumb = (part: string, index: number, className = 'crumb') => <React.Fragment key={index}>
    <ChevronRight size={12} aria-hidden="true" className={className.includes('crumb-middle') ? 'crumb-middle' : undefined}/>
    {index === parts.length - 1 ? <span className="crumb-current" aria-current="page" title={path}>{part}</span> :
      <button type="button" className={className} title={parts.slice(0,index+1).join('/')} onClick={() => onBrowse(parts.slice(0,index+1).join('/'))}>{part}</button>}
  </React.Fragment>;
  return <div className="file-breadcrumbs-row">
    <nav className="file-breadcrumbs" aria-label="File location" data-collapsed={middle.length > 0 && !expanded}>
      <button type="button" className="crumb crumb-root" title={folderPath} onClick={() => onBrowse('')}>{folderName}</button>
      {head.map((part, index) => crumb(part, index))}
      {middle.length > 0 && <><ChevronRight size={12} aria-hidden="true" className="crumb-fold"/><button type="button" className="crumb crumb-fold" aria-label={`Show ${middle.length} hidden folders`} title={middle.join('/')} onClick={event => { const nav = event.currentTarget.parentElement; setExpanded(true); requestAnimationFrame(() => nav?.querySelector<HTMLElement>('button.crumb-middle')?.focus()); }}>…</button></>}
      {middle.map((part, index) => crumb(part, head.length + index, 'crumb crumb-middle'))}
      {tail.map((part, index) => crumb(part, head.length + middle.length + index))}
    </nav>
  </div>;
}

/** Copy menu beside the view toggle: the path either way, or the file's text when it is loaded in full. */
function FileCopyMenu({folderPath, path, contents}: {folderPath?: string; path: string; contents?: string}): React.ReactElement {
  const [copied, copy] = useCopied();
  const absolute = folderPath ? `${folderPath.replace(/[\\/]+$/, '')}/${path}` : '';
  return <>
    {copied && <span className="file-copy-status" role="status">{copied}</span>}
    <Menu.Root>
      <Menu.Trigger className="icon-button file-copy-path" aria-label="Copy path or contents" title="Copy"><Copy size={14}/></Menu.Trigger>
      <Menu.Portal><Menu.Positioner side="bottom" align="end" sideOffset={4} className="file-action-positioner"><Menu.Popup className="file-action-menu">
        <Menu.Item onClick={() => copy(path, 'Relative path copied')}>Copy relative path</Menu.Item>
        <Menu.Item disabled={!absolute} onClick={() => copy(absolute, 'Absolute path copied')}>Copy absolute path</Menu.Item>
        {contents !== undefined && <Menu.Item disabled={!contents} onClick={() => copy(contents, 'Contents copied')}>Copy contents</Menu.Item>}
      </Menu.Popup></Menu.Positioner></Menu.Portal>
    </Menu.Root>
  </>;
}

/** Codex's floating copy control on a rendered document: copies the Markdown source. */
function DocumentCopyButton({text}: {text: string}): React.ReactElement {
  const [copied, copy] = useCopied();
  return <button type="button" className="icon-button file-markdown-copy" aria-label={copied ? copied : 'Copy document'} title="Copy document" onClick={() => copy(text, 'Copied')}>
    {copied ? <Check size={14}/> : <Copy size={14}/>}
  </button>;
}

/**
 * The file's diff against the chat's latest turn baseline (DIF-X4): refetched
 * whenever the shown text changes (the store rereads the body on
 * workspaceChanged) and after every Keep/Undo. The model is always computed
 * from the baseline to the text on screen, so decorations never lag the buffer.
 */
function useTurnReview({folderId, path, text, enabled}: {folderId?: string; path?: string; text?: string; enabled: boolean}) {
  const chatId = useStoreSelector(state => state.activeChatId ?? undefined);
  const chatStatus = useStoreSelector(state => state.snapshot?.chats.find(chat => chat.id === state.activeChatId)?.status);
  const turns = useChatBaselines(enabled ? chatId : undefined, chatStatus);
  const turn = enabled ? latestBaseline(turns, folderId) : undefined;
  const marks = useRunMarks(turn?.runId);
  const [diff, setDiff] = useState<ReviewFileDiff>();
  const [reload, setReload] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{message: string; hunkId?: string; relocatable?: boolean}>();
  useEffect(() => { setDiff(undefined); setProblem(undefined); }, [folderId, path, turn?.runId]);
  useEffect(() => {
    if (!turn || !folderId || !path || text === undefined) return;
    let live = true;
    invoke('review.fileDiff', {folderId, path, baseline: {runId: turn.runId}}).then(value => { if (live && value) setDiff(value); }, () => { if (live) setDiff(undefined); });
    return () => { live = false; };
  }, [turn?.runId, folderId, path, text, reload]);
  const kept = useMemo(() => keptFor(marks, path ?? ''), [marks, path]);
  const model = useMemo(() => diff && !diff.binary && !diff.truncated && text !== undefined ? buildCumulativeFileDiff(diff.before, text, kept) : undefined, [diff, text, kept]);
  if (!turn || !folderId || !path || !model || !diff) return undefined;
  const runId = turn.runId, baseline = {runId};
  const settle = (result: ReviewWriteResult, hunkId?: string) => {
    if (result.stale) setProblem({message: 'This file changed after the review was computed, so nothing was undone.', hunkId, relocatable: result.relocatable});
    else { setProblem(undefined); void refreshRunMarks(runId); }
    setReload(value => value + 1);
  };
  const guarded = async (action: () => Promise<void>) => {
    setBusy(true);
    try { await action(); } catch (cause) { setProblem({message: friendlyFileError(cause)}); } finally { setBusy(false); }
  };
  const undo = (hunkId: string, relocate = false) => void guarded(async () => settle(await invoke('review.undoHunk', {folderId, path, baseline, hunkId, expectedAfterHash: diff.afterHash, relocate}), hunkId));
  const synced = diff.after === text;
  const review: InlineFileReview = {
    model, label: turns.filter(entry => entry.treeSha).length > 1 ? 'the last agent turn' : 'the agent turn',
    running: chatStatus === 'running' || chatStatus === 'stopping', busy: busy || !synced,
    onUndo: hunkId => undo(hunkId),
    onUndoAll: () => void guarded(async () => settle(await invoke('review.undoFile', {folderId, path, baseline, expectedAfterHash: diff.afterHash}))),
    onKeep: hunkIds => void guarded(async () => { await keepHunks(runId, path, hunkIds); setProblem(undefined); }),
    notice: problem && <div className="inline-file-review-notice" role="alert">
      <TriangleAlert size={13} aria-hidden="true"/><span>{problem.message}</span>
      {problem.hunkId && problem.relocatable && <button type="button" disabled={busy} onClick={() => undo(problem.hunkId!, true)}>Undo at matching lines</button>}
      <button type="button" onClick={() => { setProblem(undefined); setReload(value => value + 1); }}>Refresh</button>
    </div>,
  };
  return review;
}

/** Selected source lines → an "Add to chat" chip (DIF-10). */
function selectedLines(container: HTMLElement | null): {start: number; end: number; text: string; rect: DOMRect} | undefined {
  const selection = window.getSelection();
  if (!container || !selection || selection.isCollapsed || !selection.rangeCount) return undefined;
  const text = selection.toString();
  if (!text.trim()) return undefined;
  const lineOf = (node: Node | null) => { const element = node instanceof Element ? node : node?.parentElement; const row = element?.closest?.('tr[data-line]'); return row && container.contains(row) ? Number(row.getAttribute('data-line')) : undefined; };
  const a = lineOf(selection.anchorNode), b = lineOf(selection.focusNode);
  if (a === undefined || b === undefined) return undefined;
  return {start: Math.min(a, b), end: Math.max(a, b), text: text.slice(0, 8000), rect: selection.getRangeAt(0).getBoundingClientRect()};
}

// ---------------------------------------------------------------------------
// Editing (WRK-08): a textarea editor with line numbers, Cmd+S to save, and a
// conflict prompt when the file changed on disk since it was loaded.

function FileEditor({folderId, path, tabId, onSaved}: {folderId: string; path: string; tabId: string; onSaved: () => void}): React.ReactElement {
  const [state, setState] = useState<{phase: 'loading'} | {phase: 'ready'; original: string; draft: string; revision: string} | {phase: 'error'; message: string}>({phase: 'loading'});
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [saveError, setSaveError] = useState('');
  const gutter = useRef<HTMLDivElement>(null);
  const area = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    let live = true;
    setState({phase: 'loading'});
    void invoke('files.readFull', {folderId, path}).then(
      value => { if (live) setState({phase: 'ready', original: value.text, draft: value.text, revision: value.revision}); },
      cause => { if (live) setState({phase: 'error', message: friendlyFileError(cause)}); },
    );
    return () => { live = false; };
  }, [folderId, path]);
  const dirty = state.phase === 'ready' && state.draft !== state.original;
  useEffect(() => { setTabDirty(tabId, dirty); }, [tabId, dirty]);
  useEffect(() => () => setTabDirty(tabId, false), [tabId]); // leaving edit mode clears the dot; a real unsaved draft is re-marked by the effect above while mounted.
  const save = useCallback(async (force = false) => {
    if (state.phase !== 'ready' || saving) return;
    setSaving(true); setSaveError('');
    try {
      const result = await invoke('files.write', {folderId, path, text: state.draft, ...(force ? {} : {expectedRevision: state.revision})});
      if (result.conflict) { setConflict(true); return; }
      setState({phase: 'ready', original: state.draft, draft: state.draft, revision: result.revision});
      setConflict(false);
      void refreshFileBody(folderId, path);
      onSaved();
    } catch (cause) { setSaveError(friendlyFileError(cause)); }
    finally { setSaving(false); }
  }, [state, saving, folderId, path, onSaved]);
  const discardAndReload = () => { setConflict(false); void invoke('files.readFull', {folderId, path}).then(value => setState({phase: 'ready', original: value.text, draft: value.text, revision: value.revision})); };
  if (state.phase === 'loading') return <ResourceState kind="loading" label={`Loading ${path}`} rows={6}/>;
  if (state.phase === 'error') return <ResourceState kind="error" message={state.message}/>;
  const lineCount = state.draft.split('\n').length;
  const syncScroll = () => { if (gutter.current && area.current) gutter.current.scrollTop = area.current.scrollTop; };
  return <div className="file-editor">
    {conflict && <div className="pane-error file-editor-conflict" role="alert">
      <span>This file changed on disk since it was opened.</span>
      <button type="button" onClick={discardAndReload}>Discard your edit and reload</button>
      <button type="button" onClick={() => void save(true)}>Save anyway (overwrite)</button>
    </div>}
    {saveError && <p className="file-action-error" role="alert">{saveError}</p>}
    <div className="file-editor-body">
      <div className="file-editor-gutter" ref={gutter} aria-hidden="true">{Array.from({length: lineCount}, (_, i) => <div key={i}>{i + 1}</div>)}</div>
      <textarea
        ref={area}
        className="file-editor-textarea"
        value={state.draft}
        spellCheck={false}
        wrap="off"
        onScroll={syncScroll}
        onChange={event => setState(prior => prior.phase === 'ready' ? {...prior, draft: event.target.value} : prior)}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }}
        aria-label={`Edit ${path}`}
      />
    </div>
    <div className="file-editor-status">
      {saving ? 'Saving…' : dirty ? 'Unsaved changes' : 'Saved'}
      <button type="button" className="file-action-primary" disabled={!dirty || saving} onClick={() => void save()}>Save (⌘S)</button>
    </div>
  </div>;
}

/** Cmd+F: highlights matches over the plain text and steps through them with wrap on/off. */
function useFileFind() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [wrap, setWrap] = useState(true);
  const [index, setIndex] = useState(0);
  return {open, setOpen, query, setQuery, wrap, setWrap, index, setIndex};
}
type FileFind = ReturnType<typeof useFileFind>;

function findMatches(text: string, query: string): number[] {
  if (!query) return [];
  const positions: number[] = [];
  const needle = query.toLowerCase(), hay = text.toLowerCase();
  let at = 0;
  while (positions.length < 5000) {
    const found = hay.indexOf(needle, at);
    if (found === -1) break;
    positions.push(found);
    at = found + needle.length;
  }
  return positions;
}

/** Plain-text render with matches marked; used only while Find is active so the highlighter never has to know about it. */
function FindHighlightedText({text, query, matches, current}: {text: string; query: string; matches: number[]; current: number}): React.ReactElement {
  if (!matches.length) return <pre className="file-find-plain">{text}</pre>;
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((position, index) => {
    if (position > cursor) parts.push(text.slice(cursor, position));
    parts.push(<mark key={index} data-current={index === current} ref={index === current ? (el => el?.scrollIntoView({block: 'center'})) : undefined}>{text.slice(position, position + query.length)}</mark>);
    cursor = position + query.length;
  });
  if (cursor < text.length) parts.push(text.slice(cursor));
  return <pre className="file-find-plain">{parts}</pre>;
}

function FindBar({find, matchCount}: {find: FileFind; matchCount: number}): React.ReactElement {
  const go = (delta: 1 | -1) => find.setIndex(i => {
    if (!matchCount) return 0;
    const next = i + delta;
    if (next < 0) return find.wrap ? matchCount - 1 : 0;
    if (next >= matchCount) return find.wrap ? 0 : matchCount - 1;
    return next;
  });
  return <div className="file-find-bar" role="search">
    <Search size={13} aria-hidden="true"/>
    <input
      autoFocus
      value={find.query}
      onChange={event => { find.setQuery(event.target.value); find.setIndex(0); }}
      onKeyDown={event => {
        if (event.key === 'Enter') { event.preventDefault(); go(event.shiftKey ? -1 : 1); }
        else if (event.key === 'Escape') { event.preventDefault(); find.setOpen(false); }
      }}
      placeholder="Find in file"
      aria-label="Find in file"
      maxLength={512}
    />
    <span className="file-find-count">{matchCount ? `${Math.min(find.index + 1, matchCount)}/${matchCount}` : find.query ? '0/0' : ''}</span>
    <button type="button" className="icon-button" aria-label="Previous match" disabled={!matchCount} onClick={() => go(-1)}><ChevronUp size={13}/></button>
    <button type="button" className="icon-button" aria-label="Next match" disabled={!matchCount} onClick={() => go(1)}><ChevronDown size={13}/></button>
    <button type="button" className={`icon-button${find.wrap ? ' is-active' : ''}`} aria-label="Wrap around" aria-pressed={find.wrap} title="Wrap around" onClick={() => find.setWrap(v => !v)}><WrapText size={13}/></button>
    <button type="button" className="icon-button" aria-label="Close find" onClick={() => find.setOpen(false)}><XIcon size={13}/></button>
  </div>;
}

export function FileTab({tab, onToggleResourceMaximize, resourceMaximized=false}: {tab: WorkspaceTab; onToggleResourceMaximize?:()=>void; resourceMaximized?:boolean}): React.ReactElement {
  const body = useStoreSelector(state => state.fileBodies[tab.id]);
  const folder = useStoreSelector(state => state.snapshot?.folders.find(item => item.id === tab.folderId));
  const timeline = useStoreSelector(state => state.activeChatId ? state.timelines[state.activeChatId]?.value : undefined);
  const kind = filePresentation(tab.path ?? '');
  const latestEdit = useMemo(()=>{
    if(!tab.path||!timeline)return undefined;
    const normalize=(value:string)=>value.replaceAll('\\','/').replace(/\/$/,'');
    const wanted=normalize(tab.path),root=normalize(folder?.path??'');
    for(let index=timeline.length-1;index>=0;index--){
      const item=timeline[index];
      if(item.kind!=='tool'||item.data?.type!=='fileChange'||!Array.isArray(item.data.changes))continue;
      for(const raw of item.data.changes){
        if(!raw||typeof raw!=='object')continue;
        const change=raw as Record<string,unknown>,path=typeof change.path==='string'?normalize(change.path):'';
        const relative=path.startsWith(root+'/')?path.slice(root.length+1):path;
        if(relative!==wanted)continue;
        const status=item.status??'unknown';
        if(!['running','completed'].includes(status))return {status,unavailableReason:`This agent edit is ${status}; no unconfirmed changes are highlighted in the file.`};
        const unavailable=change.unavailable===true||change.truncated===true;
        return {patch:typeof change.diff==='string'&&!unavailable?change.diff:undefined,status,unavailableReason:unavailable?'The provider marked this edit diff as partial or unavailable. Open Changes to review the current file diff.':undefined};
      }
    }
  },[timeline,tab.path,folder?.path]);
  // Documents open rendered (Markdown, HTML, CSV/TSV); code and config (JSON included) open as highlighted source,
  // as in Codex. JSON's tree is an opt-in second view, never the default.
  const richText = ['markdown','json','csv','tsv','html'].includes(kind);
  const opensRendered = richText && kind !== 'json';
  const isDelimited = kind === 'csv' || kind === 'tsv';
  const [mode, setMode] = useState<'source' | 'preview'>(opensRendered && !tab.line ? 'preview' : 'source');
  const code = useRef<HTMLDivElement>(null);
  const [location,setLocation]=useState('Document'),[quote,setQuote]=useState(''),[textRevision,setTextRevision]=useState('');
  const locateCell = useCallback((value: string, selected?: string) => {setLocation(value);setQuote(selected ?? '');}, []);
  useEffect(() => {
    let active = true;
    setTextRevision(''); setLocation('Document'); setQuote('');
    const value = body?.value?.text;
    if (value !== undefined && isDelimited) void crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
      .then(bytes => {if (active) setTextRevision(Array.from(new Uint8Array(bytes)).map(b => b.toString(16).padStart(2,'0')).join(''));})
      .catch(() => { /* Preview still works; version-bound annotations stay unavailable. */ });
    return () => {active = false;};
  }, [body?.value, isDelimited, tab.id]);
  const delimited = useMemo(() => {
    if (!isDelimited || body?.phase !== 'ready') return {workbook: null, error: ''};
    try {
      const parsed = parseDelimited(body.value?.text ?? '', kind === 'csv' ? ',' : '\t');
      return {workbook: {revision:textRevision, sheets:[{name:tab.title,rows:parsed.rows,types:parsed.rows.map(row=>row.map(delimitedCellType)),formulas:{},limited:parsed.limited}],limited:parsed.limited}, error:''};
    } catch (error) {return {workbook:null,error:error instanceof Error ? error.message : String(error)};}
  }, [body?.value?.text, body?.phase, kind, isDelimited, textRevision, tab.title]);
  const shownKB = useMemo(() => body?.value?.truncated ? Math.floor(new TextEncoder().encode(body.value.text).length / 1024) : 0, [body?.value]);
  useEffect(() => { if (tab.line) setMode('source'); }, [tab.id, tab.line]);
  useEffect(() => {
    if (tab.line && body?.phase === 'ready' && mode === 'source') {
      code.current?.querySelector(`[data-line="${tab.line}"]`)?.scrollIntoView({block: 'center'});
    }
  }, [tab.line, body?.phase, mode]);
  // Restore the reading position when this tab remounts after a tab switch (WRK-05). A target line wins.
  useLayoutEffect(() => {
    const saved = scrollOffset(tab.id);
    if (tab.line || !saved || body?.phase !== 'ready') return;
    const apply = () => { const scroller = code.current?.querySelector<HTMLElement>(SCROLLERS); if (scroller) scroller.scrollTop = saved; };
    apply();
    // Highlighted source can grow after its first paint; settle once more on the next frame.
    const frame = requestAnimationFrame(apply);
    return () => cancelAnimationFrame(frame);
  }, [tab.id, tab.line, body?.phase, mode]);
  const onScrollCapture = (event: React.UIEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.matches?.(SCROLLERS)) saveScrollOffset(tab.id, target.scrollTop);
  };
  const browse = (path: string) => { if (tab.folderId) revealInFiles(tab.folderId, folder?.name ?? 'Files', path); };
  const [picked, setPicked] = useState<ReturnType<typeof selectedLines>>();
  const [selectionStatus, setSelectionStatus] = useState('');
  useEffect(() => { if (!selectionStatus) return; const timer = setTimeout(() => setSelectionStatus(''), 2200); return () => clearTimeout(timer); }, [selectionStatus]);
  useEffect(() => setPicked(undefined), [tab.id, mode]);
  const reload = () => void openFile(tab.folderId!, tab.path!, tab.line);
  const [editing, setEditing] = useState(false);
  // GIT-11 blame gutter: per file tab, off by default; resets when the tab changes.
  const [blaming, setBlaming] = useState(false);
  useEffect(() => setBlaming(false), [tab.id]);
  useEffect(() => setEditing(false), [tab.id]);
  const find = useFileFind();
  const {setOpen: openFind, setQuery: setFindQuery} = find;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (editing || (event.metaKey || event.ctrlKey) === false || event.key.toLowerCase() !== 'f') return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('.file-content-search, .resource-add-search, [contenteditable="true"]')) return;
      event.preventDefault();
      openFind(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [editing, openFind]);
  useEffect(() => { openFind(false); setFindQuery(''); }, [tab.id, openFind, setFindQuery]);
  const [loadedFull, setLoadedFull] = useState<{path: string; text: string} | null>(null);
  useEffect(() => setLoadedFull(null), [tab.id]);

  const bypassesBody = kind === 'quicklook' || kind === 'media' || kind === 'binary';
  const ready = body?.phase === 'ready' ? body.value! : undefined;
  const fullOverride = loadedFull && loadedFull.path === tab.path ? loadedFull : null;
  const text = fullOverride ? fullOverride.text : ready?.text ?? '', truncated = fullOverride ? false : ready?.truncated ?? false;
  // Computed once per render rather than once for the count and again for the highlighted view:
  // on a large file, re-scanning it on every keystroke while Find is open is visible lag.
  const fileFindMatches = useMemo(() => find.open ? findMatches(text, find.query) : [], [find.open, text, find.query]);
  const [loadingFull, setLoadingFull] = useState(false);
  const [loadFullError, notifyLoadFullFailed] = useState('');
  useEffect(() => { if (loadFullError) { const timer = setTimeout(() => notifyLoadFullFailed(''), 4000); return () => clearTimeout(timer); } }, [loadFullError]);
  const loadFullFile = () => {
    if (!tab.folderId || !tab.path || loadingFull) return;
    setLoadingFull(true);
    void invoke('files.readFull', {folderId: tab.folderId, path: tab.path}).then(
      value => setLoadedFull({path: tab.path!, text: value.text}),
      cause => notifyLoadFullFailed(friendlyFileError(cause)),
    ).finally(() => setLoadingFull(false));
  };
  const canEdit = Boolean(ready) && !bypassesBody && !ready?.native && !ready?.document && !ready?.workbook && !ready?.asset;
  const revision = ready ? ready.document?.revision ?? ready.workbook?.revision ?? (delimited.workbook && !truncated ? textRevision : '') : '';
  const previewLimit = kind === 'html' ? Infinity : MARKDOWN_LIMIT;
  const previewAllowed = Boolean(ready) && richText && (isDelimited || text.length <= previewLimit) && !truncated;
  const preview = previewAllowed && mode === 'preview';
  // The stale case is decided here so the notice can offer a refresh; the source view below hides its own copy.
  const turnReview = useTurnReview({folderId: tab.folderId, path: tab.path, text: ready && !truncated && !bypassesBody ? text : undefined, enabled: !bypassesBody});
  const staleEdit = ready && !preview && !turnReview && latestEdit?.patch ? buildInlineFileDiff(text, latestEdit.patch) : null;
  const staleReason = staleEdit?.state === 'stale' ? staleEdit.reason : undefined;

  let content: React.ReactNode;
  if (kind === 'quicklook') content = <QuickLookFile folderId={tab.folderId!} path={tab.path!}/>;
  else if (kind === 'media') content = <MediaFile folderId={tab.folderId!} path={tab.path!}/>;
  else if (kind === 'binary') content = <FileFallback folderId={tab.folderId!} path={tab.path!} reason="This is a binary file, so Muster has no text preview for it."/>;
  else if (!body || body.phase === 'loading' || body.phase === 'idle') content = <ResourceState kind="loading" label={`Loading ${tab.path}`} rows={6}/>;
  else if (body.phase === 'error') {
    content = isBinaryReadError(body.error) ? <FileFallback folderId={tab.folderId!} path={tab.path!} reason="This is a binary file, so Muster has no text preview for it."/>
      : isLibreOfficeMissing(body.error) ? <FileFallback folderId={tab.folderId!} path={tab.path!} reason="The in-app reader needs LibreOffice for this format, and macOS preview is not available in this build. Install LibreOffice or open the file in its own app."/>
      : <ResourceState kind="error" message={friendlyFileError(body.error)} detail="The saved tab is still open; retry after the workspace is available." onRetry={reload}><FileExitActions folderId={tab.folderId!} path={tab.path!}/></ResourceState>;
  } else {
    const {asset, document, workbook} = ready!;
    content = <>
      {ready!.native ? <NativeDocument key={tab.id} folderId={tab.folderId!} path={tab.path!} revision={ready!} onToggleResourceMaximize={onToggleResourceMaximize} resourceMaximized={resourceMaximized}/> : document ? <PdfFile document={document} onLocation={setLocation}/> : workbook || (delimited.workbook && preview) ? <WorkbookFile key={`workbook:${tab.id}`} delimited={isDelimited} workbook={workbook ?? delimited.workbook!} onLocation={locateCell} onToggleFullPage={onToggleResourceMaximize} fullPage={resourceMaximized}/> : asset ? <ImageFile asset={asset} name={tab.title}/> : preview && delimited.error ? <div className="pane-error" role="alert"><p>Cannot preview this table: {delimited.error}</p><button onClick={() => setMode('source')}>View source</button></div> : preview && kind === 'html' ? <HtmlPreview html={text} name={tab.title}/> : preview ? <div className="file-markdown" data-kind={kind} role="region" aria-label={`Preview of ${tab.path}`} tabIndex={0}>
        {kind === 'markdown' && text && <DocumentCopyButton text={text}/>}
        {kind === 'markdown' ? <MessageBody text={text} resourceContext={{folderId: tab.folderId!, path: tab.path!}}/> : <StructuredFile text={text} kind={kind as 'json'|'csv'|'tsv'}/>}
        {!text && <p className="file-empty">This document is empty.</p>}
      </div> : <div className="code-scroll" role="region" aria-label={`Source of ${tab.path}`} tabIndex={0}>
        {staleReason && <div className="inline-file-diff-stale" role="status">
          <TriangleAlert size={13} aria-hidden="true"/>
          <span>{staleReason}</span>
          <button type="button" onClick={reload}>Refresh</button>
        </div>}
        {blaming && tab.folderId && tab.path ? <BlameView folderId={tab.folderId} path={tab.path} source={text} targetLine={tab.line}/> : turnReview && turnReview.model.state !== 'clean' ? <InlineFileSource source={text} path={tab.path??''} review={turnReview}/> : latestEdit && !turnReview ? <InlineFileSource source={text} path={tab.path??''} patch={latestEdit.patch} status={latestEdit.status} unavailableReason={latestEdit.unavailableReason}/> : <HighlightedSourceTable source={text} language={codeLanguageFromPath(tab.path ?? '')} targetLine={tab.line}/ >}
        {!text && <p className="file-empty">This file is empty.</p>}
      </div>}
      {richText && kind !== 'html' && !previewAllowed && !truncated && <div className="pane-truncated">Showing source: Document preview is limited to 65,536 characters.</div>}
      {truncated && <div className="pane-truncated file-truncated-notice">
        <span>Showing first {shownKB.toLocaleString()} KB. The full file is larger than the in-app preview.</span>
        <button type="button" onClick={loadFullFile} disabled={loadingFull}>{loadingFull ? 'Loading…' : 'Load full file'}</button>
        <FileExitActions folderId={tab.folderId!} path={tab.path!}/>
      </div>}
      {loadFullError && <p className="file-action-error" role="alert">{loadFullError}</p>}
      {ready?.encodingWarning && !fullOverride && <div className="pane-truncated file-encoding-warning" role="status"><TriangleAlert size={13} aria-hidden="true"/>This file has bytes that are not valid UTF-8; some characters may show as replacement marks.</div>}
      {revision && <FileAnnotations key={tab.id} folderId={tab.folderId!} path={tab.path!} revision={revision} location={location} quote={quote}/>}
    </>;
  }

  return <div className="file-view" ref={code}>
    <div className="file-head">
      <FileBreadcrumbs folderName={folder?.name ?? 'Files'} folderPath={folder?.path} path={tab.path ?? ''} onBrowse={browse}/>
      {/* One toggle, as in Codex: it names the other view in full ("View source" / "View preview" / "View tree"). */}
      {richText && !bypassesBody && <div className="file-view-switch" role="group" aria-label="Document view">
        {preview
          ? <button type="button" className="file-view-toggle" aria-label="View source" title="Show the raw file with syntax highlighting" onClick={() => setMode('source')}>View source</button>
          : <button type="button" className="file-view-toggle" aria-label={kind === 'html' ? 'View rendered' : kind === 'json' ? 'View tree' : 'View preview'} disabled={!previewAllowed} title={previewAllowed ? (kind === 'html' ? 'Render without scripts' : kind === 'json' ? 'Browse the JSON as a collapsible tree' : 'Show the formatted document') : 'Large or truncated documents open as source'} onClick={() => setMode('preview')}>{kind === 'html' ? 'View rendered' : kind === 'json' ? 'View tree' : 'View preview'}</button>}
      </div>}
      {selectionStatus && <span className="file-copy-status" role="status">{selectionStatus}</span>}
      <FileCopyMenu folderPath={folder?.path} path={tab.path ?? ''} contents={ready && !truncated && !ready.document && !ready.workbook && !ready.asset && !ready.native ? text : undefined}/>
      {tab.folderId && tab.path && <OpenInMenu folderId={tab.folderId} path={tab.path}/>}
      {canEdit && !preview && !editing && <button type="button" className={`icon-button file-blame-toggle${blaming ? ' is-active' : ''}`} aria-pressed={blaming} aria-label={blaming ? 'Hide blame' : 'Show blame'} title={blaming ? 'Hide blame' : 'Blame: who last changed each line'} onClick={() => setBlaming(value => !value)}>
        <BlameIcon size={14}/>
      </button>}
      {canEdit && <button type="button" className={`icon-button file-edit-toggle${editing ? ' is-active' : ''}`} aria-pressed={editing} aria-label={editing ? 'Stop editing' : 'Edit file'} title={editing ? 'Stop editing' : 'Edit file'} onClick={() => setEditing(value => !value)}>
        <Pencil size={14}/>
      </button>}
    </div>
    {find.open && !editing && <FindBar find={find} matchCount={fileFindMatches.length}/>}
    <div className="file-content-layout">
    <div className="file-document" onScrollCapture={event=>{onScrollCapture(event);if(picked)setPicked(undefined);}} onMouseDown={event=>{if(!(event.target as Element).closest?.('.file-selection-context'))setPicked(undefined);}} onMouseUp={()=>{const selection=window.getSelection();if(selection && code.current?.contains(selection.anchorNode))setQuote(selection.toString().slice(0,2000));if(!preview)setPicked(selectedLines(code.current?.querySelector('.code-scroll') ?? null));}}>
      {editing && tab.folderId && tab.path ? <FileEditor folderId={tab.folderId} path={tab.path} tabId={tab.id} onSaved={() => {}}/>
        : find.open ? <FindHighlightedText text={text} query={find.query} matches={fileFindMatches} current={find.index}/>
        : content}
      {picked && <button type="button" className="file-selection-context" style={{position:'fixed',top:Math.min(picked.rect.bottom+6,window.innerHeight-32),left:Math.max(8,Math.min(picked.rect.left,window.innerWidth-140))}} onClick={()=>{const range=picked.start===picked.end?`L${picked.start}`:`L${picked.start}-${picked.end}`;void addReviewContext({label:`${tab.path}:${range}`,text:picked.text,source:{kind:'file',folderId:tab.folderId,path:tab.path,startLine:picked.start,endLine:picked.end}}).then(result=>setSelectionStatus(result==='added'?'Added to chat':result==='copied'?'Copied selection — paste it into the chat':'Could not add the selection'));setPicked(undefined);window.getSelection()?.removeAllRanges();}}><MessageSquarePlus size={12} aria-hidden="true"/>Add to chat</button>}
    </div>
    </div>
  </div>;
}
