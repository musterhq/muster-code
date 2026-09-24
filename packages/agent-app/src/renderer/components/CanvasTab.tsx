/**
 * WRK-12 Canvas: a co-edited artifact (Markdown, code or an HTML page) in the right pane. The user edits here, the
 * chat's agent edits through the muster_canvas tools; every saved change is a version that can be diffed and
 * restored. Saves carry the version they started from, so an agent update is never silently overwritten.
 */
import React, {useCallback, useEffect, useRef, useState} from 'react';
import {Code2, Eye, History, MessagesSquare, PenLine, RotateCcw, Trash2, X} from 'lucide-react';
import {invoke} from '../bridge';
import {closeTab, notifyError, openTab, setTabDirty, type WorkspaceTab} from '../store';
import {onCanvasEvent, openSideChat, selectedText} from '../artifacts';
import {canvasDiffRows} from '../canvasDiff';
import {CANVAS_KINDS, type Canvas, type CanvasKind, type CanvasVersion} from '../../shared/domains/artifacts-protocol';
import {MessageBody} from './MessageBody';
import {ResourceState} from './ResourceState';
import './canvas-tab.css';
import {Tip} from './Tooltip';

const SAVE_DELAY_MS = 700;
type View = 'edit' | 'split' | 'preview';
const KIND_LABEL: Record<CanvasKind, string> = {markdown: 'Markdown', code: 'Code', html: 'HTML page'};
const relative = (iso: string) => { const at = Date.parse(iso); return Number.isNaN(at) ? '' : new Date(at).toLocaleString(undefined, {month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'}); };

export function CanvasTab({tab}: {tab: WorkspaceTab}): React.ReactElement {
  const id = tab.canvasId!;
  const [canvas, setCanvas] = useState<Canvas | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  /** Someone else (the agent) saved a newer version while this view had unsaved edits. */
  const [remote, setRemote] = useState<Canvas | null>(null);
  const [view, setView] = useState<View>('split');
  const [history, setHistory] = useState(false);
  const base = useRef(0), draftRef = useRef(''), timer = useRef<ReturnType<typeof setTimeout>>(undefined), body = useRef<HTMLDivElement>(null);
  const canvasContentRef = useRef('');
  canvasContentRef.current = canvas?.content ?? '';
  const tabRef = useRef(tab);
  tabRef.current = tab;
  /** Keeps the tab's title in step with the canvas (the tab is the active one while this view is mounted). */
  const syncTitle = (title: string) => { if (title !== tabRef.current.title) openTab({...tabRef.current, title}); };

  const adopt = useCallback((next: Canvas) => {
    setCanvas(next); setDraft(next.content); draftRef.current = next.content; canvasContentRef.current = next.content; base.current = next.version; setDirty(false); setRemote(null);
    setTabDirty(tabRef.current.id, false);
    syncTitle(next.title);
  }, []);
  const load = useCallback(() => {
    setError(null);
    void invoke('artifacts.canvas.get', {id}).then(adopt, cause => setError(cause instanceof Error ? cause.message : String(cause)));
  }, [id, adopt]);
  useEffect(load, [load]);

  const save = useCallback(async (patch: {content?: string; title?: string; kind?: CanvasKind; language?: string | null} = {}) => {
    clearTimeout(timer.current);
    const content = patch.content ?? draftRef.current;
    setSaving(true);
    try {
      const result = await invoke('artifacts.canvas.update', {id, ...patch, content, baseVersion: base.current});
      if (result.conflict) { setRemote(result.canvas); return; }
      setCanvas(result.canvas); canvasContentRef.current = result.canvas.content; base.current = result.canvas.version;
      if (draftRef.current === content) { setDirty(false); setTabDirty(tabRef.current.id, false); }
      syncTitle(result.canvas.title);
    } catch (cause) { notifyError(cause, () => void save(patch)); }
    finally { setSaving(false); }
  }, [id]);

  // Agent (or another view) saved: adopt it when nothing local is pending, otherwise offer a choice.
  useEffect(() => onCanvasEvent(event => {
    if (event.type === 'deleted' ? event.id !== id : event.canvas.id !== id) return;
    if (event.type === 'deleted') { setError('This canvas was deleted.'); return; }
    if (event.canvas.version <= base.current) return;
    void invoke('artifacts.canvas.get', {id}).then(next => {
      if (next.version <= base.current) return;
      if (draftRef.current === canvasContentRef.current) adopt(next); else setRemote(next);
    }, () => {});
  }), [id, adopt]);

  const edit = (value: string) => {
    setDraft(value); draftRef.current = value;
    const changed = value !== canvasContentRef.current;
    setDirty(changed); setTabDirty(tabRef.current.id, changed);
    clearTimeout(timer.current);
    if (changed && !remote) timer.current = setTimeout(() => void save(), SAVE_DELAY_MS);
  };
  useEffect(() => () => { clearTimeout(timer.current); if (draftRef.current !== canvasContentRef.current && base.current) void invoke('artifacts.canvas.update', {id, content: draftRef.current, baseVersion: base.current}).catch(() => {}); }, [id]);

  if (error) return <ResourceState kind="error" message="Canvas unavailable" detail={error} onRetry={load}/>;
  if (!canvas) return <ResourceState kind="loading" label="Opening canvas…"/>;
  const kind = canvas.kind;
  const previewable = kind !== 'code';
  const shown: View = previewable ? view : 'edit';
  const askSelection = () => void openSideChat({kind: 'canvas', canvasId: id, title: canvas.title, ...(selectedText(body.current) ? {excerpt: selectedText(body.current)} : {})});
  const status = saving ? 'Saving…' : remote ? 'Changed elsewhere' : dirty ? 'Unsaved' : `Saved · v${canvas.version}${canvas.updatedBy === 'agent' ? ' by agent' : ''}`;
  return <div className="canvas-tab" ref={body}>
    <div className="canvas-toolbar">
      <input className="canvas-title" aria-label="Canvas title" defaultValue={canvas.title} key={`${canvas.id}:${canvas.title}`} maxLength={160}
        onBlur={event => { const title = event.currentTarget.value.trim(); if (title && title !== canvas.title) void save({title}); }}
        onKeyDown={event => { if (event.key === 'Enter') event.currentTarget.blur(); }}/>
      <select className="canvas-kind" aria-label="Canvas type" value={kind} onChange={event => void save({kind: event.currentTarget.value as CanvasKind, ...(event.currentTarget.value === 'code' ? {language: canvas.language ?? 'typescript'} : {})})}>
        {CANVAS_KINDS.map(option => <option key={option} value={option}>{KIND_LABEL[option]}</option>)}
      </select>
      {kind === 'code' && <input className="canvas-language" aria-label="Language" defaultValue={canvas.language ?? ''} key={`lang:${canvas.language ?? ''}`} placeholder="language" maxLength={32}
        onBlur={event => { const language = event.currentTarget.value.trim(); if (language !== (canvas.language ?? '')) void save({language: language || null}); }}/>}
      {previewable && <div className="canvas-views" role="radiogroup" aria-label="Layout">
        {(['edit', 'split', 'preview'] as const).map(option => <button key={option} type="button" role="radio" aria-checked={view === option} className={view === option ? 'is-active' : ''} onClick={() => setView(option)} title={option === 'edit' ? 'Editor only' : option === 'split' ? 'Editor and preview' : 'Preview only'}>
          {option === 'edit' ? <PenLine size={13}/> : option === 'preview' ? <Eye size={13}/> : <Code2 size={13}/>}<span>{option === 'edit' ? 'Edit' : option === 'split' ? 'Split' : 'Preview'}</span>
        </button>)}
      </div>}
      <span className="canvas-status" role="status" data-state={remote ? 'conflict' : dirty ? 'dirty' : 'saved'}>{status}</span>
      <Tip label="Ask in side chat (uses your selection)"><button type="button" className="icon-button" aria-label="Ask about this canvas in a side chat" onClick={askSelection}><MessagesSquare size={14}/></button></Tip>
      <Tip label="Version history"><button type="button" className={`icon-button${history ? ' is-active' : ''}`} aria-pressed={history} aria-label="Version history" onClick={() => setHistory(value => !value)}><History size={14}/></button></Tip>
      <Tip label="Delete canvas"><button type="button" className="icon-button" aria-label="Delete canvas" onClick={() => {
        if (!window.confirm(`Delete “${canvas.title}” and its ${canvas.version} version${canvas.version === 1 ? '' : 's'}?`)) return;
        void invoke('artifacts.canvas.delete', {id}).then(() => closeTab(tab.id), notifyError);
      }}><Trash2 size={14}/></button></Tip>
    </div>
    {remote && <div className="canvas-conflict" role="alert">
      <span>{remote.updatedBy === 'agent' ? 'The agent' : 'Someone'} saved version {remote.version} while you were editing.</span>
      <button type="button" onClick={() => adopt(remote)}>Use theirs</button>
      <button type="button" onClick={() => { base.current = remote.version; setCanvas(remote); canvasContentRef.current = remote.content; setRemote(null); void save(); }}>Keep mine</button>
    </div>}
    <div className="canvas-body" data-view={shown}>
      {shown !== 'preview' && <textarea className="canvas-editor" aria-label={`${canvas.title} content`} spellCheck={kind === 'markdown'} value={draft}
        onChange={event => edit(event.currentTarget.value)}
        onKeyDown={event => { if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') { event.preventDefault(); void save(); } }}/>}
      {shown !== 'edit' && <div className="canvas-preview" aria-label="Preview">
        {kind === 'markdown' ? <div className="canvas-markdown"><MessageBody text={draft}/></div>
          // No sandbox tokens: scripts, forms, popups and same-origin access are all off; the page is shown, never run.
          : <iframe className="canvas-html" title={`${canvas.title} preview`} sandbox="" referrerPolicy="no-referrer" srcDoc={draft}/>}
      </div>}
      {history && <CanvasHistory canvas={canvas} current={draft} onClose={() => setHistory(false)} onRestored={adopt}/>}
    </div>
  </div>;
}

function CanvasHistory({canvas, current, onClose, onRestored}: {canvas: Canvas; current: string; onClose(): void; onRestored(canvas: Canvas): void}): React.ReactElement {
  const [versions, setVersions] = useState<CanvasVersion[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{version: number; content: string} | null>(null);
  useEffect(() => {
    let live = true;
    void invoke('artifacts.canvas.versions', {id: canvas.id}).then(result => { if (live) setVersions(result.versions); }, cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { live = false; };
  }, [canvas.id, canvas.version]);
  const pick = (version: number) => void invoke('artifacts.canvas.version', {id: canvas.id, version}).then(result => setSelected({version, content: result.content}), notifyError);
  const diff = selected ? canvasDiffRows(selected.content, current) : null;
  return <aside className="canvas-history" aria-label="Version history">
    <header><strong>History</strong><button type="button" className="icon-button" aria-label="Close history" onClick={onClose}><X size={13}/></button></header>
    {error && <p className="canvas-history-note" role="alert">{error}</p>}
    {!versions && !error && <p className="canvas-history-note">Loading versions…</p>}
    <ol className="canvas-versions">
      {versions?.map(version => <li key={version.version}>
        <button type="button" className={selected?.version === version.version ? 'is-active' : ''} aria-current={selected?.version === version.version || undefined} onClick={() => pick(version.version)}>
          <span className="canvas-version-number">v{version.version}{version.version === canvas.version ? ' · current' : ''}</span>
          <span className="canvas-version-meta">{version.author === 'agent' ? 'Agent' : 'You'} · {relative(version.createdAt)}</span>
          {version.note && <span className="canvas-version-note">{version.note}</span>}
        </button>
      </li>)}
    </ol>
    {selected && diff && <div className="canvas-diff" aria-label={`Changes from version ${selected.version} to the current text`}>
      <div className="canvas-diff-head">
        <span>v{selected.version} → current · <span className="is-add">+{diff.added}</span> <span className="is-del">−{diff.removed}</span></span>
        {selected.version !== canvas.version && <button type="button" onClick={() => {
          if (!window.confirm(`Restore version ${selected.version}? The current text stays in history.`)) return;
          void invoke('artifacts.canvas.restore', {id: canvas.id, version: selected.version}).then(restored => { setSelected(null); onRestored(restored); }, notifyError);
        }}><RotateCcw size={12}/>Restore</button>}
      </div>
      {diff.rows.length === 0 ? <p className="canvas-history-note">No differences.</p> : <pre>{diff.rows.map((row, index) => <div key={index} className={`canvas-diff-row is-${row.kind}`}><span className="canvas-diff-sign">{row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : row.kind === 'gap' ? '⋯' : ' '}</span>{row.text || ' '}</div>)}</pre>}
      {diff.truncated && <p className="canvas-history-note">Diff truncated.</p>}
    </div>}
  </aside>;
}
