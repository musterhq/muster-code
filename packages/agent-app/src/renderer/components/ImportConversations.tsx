/**
 * CHAT-01 "Import conversations…": a dialog listing Codex CLI/desktop sessions, Claude Code
 * transcripts, OpenCode sessions and ChatGPT data exports (read-only discovery in the runtime), with checkboxes,
 * search, paging, an Import button with progress, and a results summary. Opened from Settings ›
 * General, ⌘K, or `openImportConversations()`.
 */
import React, { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Download, Eye, FileArchive, Folder, FolderPlus, RefreshCw, Search, X } from 'lucide-react';
import { IMPORT_SOURCES, IMPORT_SOURCE_LABELS, type ImportListPage, type ImportPreview, type ImportRunResult, type ImportSessionSummary, type ImportSource, type ImportSourceState } from '../../shared/domains/import-protocol';
import { invoke, subscribe } from '../bridge';
import { notifyError, selectChat } from '../store';
import { useStore } from '../useStore';
import { relativeLabel } from '../relativeTime';
import { ModalSheet } from './ModalSheet';
import { cleanIpcError } from './resourceErrors';
import './import-conversations.css';
import { plural } from '../../shared/wording.ts';

// One sheet, mounted once in App; every entry point flips this flag.
let open = false, requestedSource: ImportSource | undefined;
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
export function openImportConversations(source?: ImportSource): void { requestedSource = source; if (!open) { open = true; notify(); } }
export function closeImportConversations(): void { if (open) { open = false; notify(); } }
export function useImportConversationsOpen(): boolean { return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => open, () => open); }

export function ImportConversationsHost(): React.ReactElement | null {
  const isOpen = useImportConversationsOpen();
  return isOpen ? <ImportDialog/> : null;
}

const PAGE = 50;
const homeTilde = (path: string) => path.replace(/^\/Users\/[^/]+(?=\/|$)/, '~');
/** Codex-style folder label: the sidebar folder's name, or the last path segment of the session's cwd. */
const cwdLabel = (cwd: string) => cwd.split('/').filter(Boolean).at(-1) ?? cwd;

type Progress = { done: number; total: number; current?: string };

function ImportDialog(): React.ReactElement {
  const state = useStore();
  const folders = state.snapshot?.folders ?? [];
  const [source, setSource] = useState<ImportSource>(requestedSource ?? 'codex');
  const [sources, setSources] = useState<ImportSourceState[]>([]);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [page, setPage] = useState<ImportListPage | null>(null);
  const [items, setItems] = useState<ImportSessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [exportPath, setExportPath] = useState<string | null>(null);
  const [addFolders, setAddFolders] = useState(true);
  const [continueInMuster, setContinueInMuster] = useState(true);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [result, setResult] = useState<ImportRunResult | null>(null);
  const [preview, setPreview] = useState<{ id: string; data?: ImportPreview; error?: string } | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const previewToken = useRef(0);
  const generation = useRef(0);
  const busy = progress !== null;

  useEffect(() => { void invoke('import.sources', undefined).then(value => setSources(value.sources)).catch(() => undefined); }, []);
  useEffect(() => { const timer = window.setTimeout(() => setDebounced(query.trim()), 180); return () => window.clearTimeout(timer); }, [query]);

  const load = useCallback(async (offset: number, refresh = false) => {
    if (source === 'chatgpt' && !exportPath) { setItems([]); setPage(null); setError(null); return; }
    const token = ++generation.current;
    setLoading(true); setError(null);
    try {
      const next = await invoke('import.list', { source, query: debounced, offset, limit: PAGE, refresh, ...(source === 'chatgpt' && exportPath ? { path: exportPath } : {}) });
      if (token !== generation.current) return;
      setPage(next);
      setItems(current => offset === 0 ? next.items : [...current, ...next.items]);
    } catch (cause) {
      if (token !== generation.current) return;
      setError(cleanIpcError(cause) ?? (cause instanceof Error ? cause.message : String(cause)));
      if (offset === 0) { setItems([]); setPage(null); }
    } finally { if (token === generation.current) setLoading(false); }
  }, [source, debounced, exportPath]);
  useEffect(() => { setSelected(new Set()); setResult(null); setPreview(null); void load(0); }, [load]);
  // W6-E.b1: the first few messages of one session, read (and redacted) before importing it.
  const showPreview = async (id: string) => {
    if (preview?.id === id) { previewToken.current++; setPreview(null); return; }
    const token = ++previewToken.current;
    setPreview({ id });
    try {
      const data = await invoke('import.preview', { id, ...(source === 'chatgpt' && exportPath ? { path: exportPath } : {}) });
      if (token === previewToken.current) setPreview({ id, data });
    } catch (cause) {
      if (token === previewToken.current) setPreview({ id, error: cleanIpcError(cause) ?? (cause instanceof Error ? cause.message : String(cause)) });
    }
  };

  useEffect(() => subscribe(event => { if (event.type === 'importProgress') setProgress({ done: event.done, total: event.total, ...(event.current ? { current: event.current } : {}) }); }), []);

  const chooseExport = async () => {
    try { const picked = await invoke('import.pickExport', undefined); if (picked.path) setExportPath(picked.path); }
    catch (cause) { notifyError(cause); }
  };
  const toggle = (id: string) => setSelected(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  // A session Muster itself is running (its own chat's provider thread) is already here: never selectable.
  const selectable = items.filter(item => !item.musterChatId);
  const allLoadedSelected = selectable.length > 0 && selectable.every(item => selected.has(item.id));
  const toggleAll = () => setSelected(allLoadedSelected ? new Set() : new Set(selectable.map(item => item.id)));

  const run = async () => {
    if (!selected.size || busy) return;
    setResult(null); setProgress({ done: 0, total: selected.size });
    try {
      const outcome = await invoke('import.run', { ids: [...selected], addFolders, continueInMuster, ...(source === 'chatgpt' && exportPath ? { path: exportPath } : {}) });
      setResult(outcome); setSelected(new Set());
      void load(0, true);
    } catch (cause) { notifyError(cause); }
    finally { setProgress(null); }
  };
  const openChat = async (chatId: string) => { closeImportConversations(); await selectChat(chatId); };

  const sourceState = sources.find(entry => entry.id === source);
  const folderName = (item: ImportSessionSummary) => item.folderId ? folders.find(folder => folder.id === item.folderId)?.name : undefined;
  const description = useMemo(() => 'Bring conversations from other tools into Muster. Sources are read, never changed; keys and tokens are redacted on the way in.', []);
  const remaining = page ? Math.max(0, page.total - items.length) : 0;

  return <ModalSheet open title="Import conversations" description={description} className="composer-confirm import-sheet" testId="import-sheet" initialFocus={searchInput} onClose={() => { if (!busy) closeImportConversations(); }}>
    <div className="import-tabs" role="tablist" aria-label="Import source">
      {IMPORT_SOURCES.map(id => {
        const entry = sources.find(candidate => candidate.id === id);
        return <button key={id} type="button" role="tab" aria-selected={source === id} className="import-tab" disabled={busy} onClick={() => setSource(id)} title={entry?.detail}>
          {IMPORT_SOURCE_LABELS[id]}{entry && !entry.available && <span className="import-tab-off" aria-label="Not found">·</span>}
        </button>;
      })}
    </div>
    <div className="import-toolbar">
      <label className="import-search"><Search size={13} aria-hidden="true"/><input ref={searchInput} type="search" value={query} placeholder="Search by title, folder or id" spellCheck={false} disabled={busy} onChange={event => setQuery(event.target.value)} aria-label="Search conversations"/></label>
      {source === 'chatgpt'
        ? <button type="button" className="import-choose" disabled={busy} onClick={() => void chooseExport()}><FileArchive size={13} aria-hidden="true"/>{exportPath ? homeTilde(exportPath).split('/').at(-1) : 'Choose export…'}</button>
        : <button type="button" className="import-choose" disabled={busy || loading} onClick={() => void load(0, true)} title="Look again"><RefreshCw size={13} aria-hidden="true"/>Refresh</button>}
    </div>
    <p className="import-source-detail">{sourceState ? sourceState.detail : ' '}</p>

    <div className="import-list" role="group" aria-label="Conversations" aria-busy={loading}>
      {error && <p className="import-error" role="alert">{error}</p>}
      {!error && !loading && items.length === 0 && <p className="import-empty">{source === 'chatgpt' && !exportPath ? 'Choose a ChatGPT data export to list its conversations.' : sourceState && !sourceState.available ? sourceState.detail : debounced ? 'No conversations match.' : 'No conversations found.'}</p>}
      {items.length > 0 && <div className="import-list-head">
        <label className="import-check"><input type="checkbox" checked={allLoadedSelected} disabled={busy || !selectable.length} onChange={toggleAll} aria-label="Select all loaded"/><span>{selected.size ? `${selected.size} selected` : `${page?.total ?? items.length} conversation${(page?.total ?? items.length) === 1 ? '' : 's'}`}</span></label>
      </div>}
      <ul className="import-rows">
        {items.map(item => {
          const folder = folderName(item);
          return <li key={item.id} className="import-row" data-selected={selected.has(item.id) || undefined}>
            <label className="import-check">
              <input type="checkbox" checked={!item.musterChatId && selected.has(item.id)} disabled={busy || !!item.musterChatId} onChange={() => toggle(item.id)} aria-label={item.musterChatId ? `${item.title} is already a Muster chat` : `Select ${item.title}`}/>
              <span className="import-row-body">
                <span className="import-row-title"><span className="import-row-name">{item.title}</span>{item.musterChatId ? <span className="import-badge is-imported">Already in Muster</span> : item.importedChatId ? <span className="import-badge is-imported">Imported</span> : item.startedInMuster ? <span className="import-badge" title="This session was started by Muster">From Muster</span> : null}{item.archived && <span className="import-badge">Archived</span>}</span>
                <span className="import-row-meta">
                  {item.cwd ? <span className="import-row-folder" title={item.cwd}>{folder ? <Folder size={11} aria-hidden="true"/> : <FolderPlus size={11} aria-hidden="true"/>}{folder ?? cwdLabel(item.cwd)}{!folder && <span className="import-row-hint"> · not in sidebar</span>}</span> : <span className="import-row-folder is-none">No folder</span>}
                  <span title={new Date(item.updatedAt).toLocaleString()}>{relativeLabel(item.updatedAt)}</span>
                  <span>{item.messageCount === null ? 'Messages counted on import' : `${plural(item.messageCount, 'message')}`}</span>
                  {item.model && <span className="import-row-model">{item.model}</span>}
                </span>
              </span>
            </label>
            <button type="button" className="import-open import-preview-toggle" disabled={busy} aria-expanded={preview?.id === item.id} aria-controls="import-preview" aria-label={`Preview ${item.title}`} title="Preview the first messages" onClick={() => void showPreview(item.id)}><Eye size={12} aria-hidden="true"/></button>
            {(item.musterChatId ?? item.importedChatId) && <button type="button" className="import-open" disabled={busy} onClick={() => void openChat((item.musterChatId ?? item.importedChatId)!)}>Open</button>}
          </li>;
        })}
      </ul>
      {loading && <p className="import-empty" role="status">Looking for conversations…</p>}
      {!loading && remaining > 0 && <button type="button" className="import-more" disabled={busy} onClick={() => void load(items.length)}>Show {Math.min(PAGE, remaining)} more · {remaining} left</button>}
    </div>

    {preview && <ImportPreviewPanel preview={preview} selected={selected.has(preview.id)} selectable={!!items.find(item => item.id === preview.id && !item.musterChatId)} busy={busy} onToggle={() => toggle(preview.id)} onClose={() => { previewToken.current++; setPreview(null); }}/>}

    <div className="import-options">
      <label className="import-check"><input type="checkbox" checked={addFolders} disabled={busy} onChange={event => setAddFolders(event.target.checked)}/><span>Add missing folders to the sidebar</span></label>
      <label className="import-check"><input type="checkbox" checked={continueInMuster} disabled={busy} onChange={event => setContinueInMuster(event.target.checked)}/><span>Continue in Muster: resume the original thread when the provider allows, otherwise start a new one seeded with a summary</span></label>
    </div>

    {progress && <div className="import-progress" role="status" aria-live="polite">
      <div className="import-bar" role="progressbar" aria-valuemin={0} aria-valuemax={progress.total} aria-valuenow={progress.done}><div className="import-bar-fill" style={{ width: `${progress.total ? Math.round((progress.done / progress.total) * 100) : 0}%` }}/></div>
      <span>{progress.done < progress.total ? `Importing ${progress.done + 1} of ${progress.total}${progress.current ? ` · ${progress.current}` : ''}` : 'Finishing…'}</span>
    </div>}
    {result && <ImportSummary result={result} onOpen={chatId => void openChat(chatId)}/>}

    <div className="composer-confirm-actions">
      <button type="button" onClick={closeImportConversations} disabled={busy}>{result ? 'Done' : 'Cancel'}</button>
      <button type="button" className="is-primary" disabled={busy || !selected.size} onClick={() => void run()}><Download size={13} aria-hidden="true"/>{busy ? 'Importing…' : selected.size ? `Import ${selected.size}` : 'Import'}</button>
    </div>
  </ModalSheet>;
}

/** The preview drawer: role-labelled, clipped and redacted messages from the top of one session. */
export function ImportPreviewPanel({ preview, selected, selectable, busy, onToggle, onClose }: { preview: { id: string; data?: ImportPreview; error?: string }; selected: boolean; selectable: boolean; busy: boolean; onToggle(): void; onClose(): void }): React.ReactElement {
  const data = preview.data;
  return <section id="import-preview" className="import-preview" aria-label="Conversation preview" data-testid="import-preview" aria-busy={!data && !preview.error}>
    <header className="import-preview-head">
      <strong className="import-preview-title">{data?.title ?? 'Preview'}</strong>
      {selectable && <button type="button" className="import-open" disabled={busy || !data} onClick={onToggle}>{selected ? 'Deselect' : 'Select'}</button>}
      <button type="button" className="import-open" onClick={onClose} aria-label="Close preview"><X size={12} aria-hidden="true"/></button>
    </header>
    {preview.error ? <p className="import-error" role="alert">{preview.error}</p>
      : !data ? <p className="import-empty" role="status">Reading the first messages…</p>
      : !data.messages.length ? <p className="import-empty">No messages to show.</p>
      : <ol className="import-preview-messages">
        {data.messages.map((message, index) => <li key={index} className="import-preview-message" data-role={message.role}><span className="import-preview-role">{message.role === 'user' ? 'You' : 'Assistant'}</span><p>{message.text}</p></li>)}
      </ol>}
    {data && (data.more || data.redacted > 0) && <p className="import-preview-foot">{[data.more ? 'More messages follow; the whole session is imported' : '', data.redacted ? `${plural(data.redacted, 'secret')} redacted` : ''].filter(Boolean).join(' · ')}</p>}
  </section>;
}

/** Chat-header badge for an imported chat (from the leading `imported` notice's data). Styled like the fork origin note. */
export function ImportOrigin({ data }: { data: Record<string, unknown> }): React.ReactElement {
  const source = data.source as ImportSource | undefined;
  const label = source ? IMPORT_SOURCE_LABELS[source] ?? String(source) : 'another app';
  const cwd = typeof data.cwd === 'string' ? homeTilde(data.cwd) : undefined;
  const at = typeof data.importedAt === 'string' ? relativeLabel(data.importedAt) : undefined;
  return <div className="fork-origin import-origin" role="note" data-testid="import-origin"><Download size={12} aria-hidden="true"/>
    Imported from {label.replace(/ export$/, '')}{cwd ? <> · originally in <span title={typeof data.cwd === 'string' ? data.cwd : undefined}>{cwd}</span></> : null}{at ? <> · {at}</> : null}
  </div>;
}

function ImportSummary({ result, onOpen }: { result: ImportRunResult; onOpen(chatId: string): void }): React.ReactElement {
  const parts = [result.created ? `${result.created} imported` : '', result.updated ? `${result.updated} updated` : '', result.failed.length ? `${result.failed.length} failed` : ''].filter(Boolean);
  const continued = result.chats.filter(chat => chat.continued === 'native').length;
  const first = result.chats[0];
  return <div className="import-summary" role="status" data-testid="import-summary">
    <p className="import-summary-line">{result.failed.length && !result.created && !result.updated ? <X size={13} aria-hidden="true"/> : <Check size={13} aria-hidden="true"/>}{parts.join(' · ') || 'Nothing imported'}{result.redacted ? ` · ${plural(result.redacted, 'secret')} redacted` : ''}{result.foldersAdded.length ? ` · ${plural(result.foldersAdded.length, 'folder')} added` : ''}{continued ? ` · ${continued} resume${continued === 1 ? 's' : ''} the original thread` : ''}</p>
    {result.failed.length > 0 && <ul className="import-failed">{result.failed.slice(0, 5).map(failure => <li key={failure.id}><strong>{failure.title}</strong> — {failure.error}</li>)}</ul>}
    {first && <button type="button" className="import-open-first" onClick={() => onOpen(first.chatId)}>Open “{first.title}”</button>}
  </div>;
}
