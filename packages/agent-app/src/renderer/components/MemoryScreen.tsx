import { HindsightPanel } from './HindsightPanel';
import { MemoryAdvanced } from './MemoryAdvanced';
import { ArrowLeft, Layers, Plus, Search, Settings2, Sparkles, Trash2, X } from 'lucide-react';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import type { MemoryAutoRetain, MemoryConfigView, MemoryDeleteEngineState, MemoryOffer, MemoryPendingDelete, MemoryRecord, MemoryStatusView, MemoryTestResult } from '../../shared/domains/memory-protocol';
import { invoke } from '../bridge';
import { closeSettings, openMemoryScreen } from '../store';
import { restoreFocus } from '../focus';
import { compactAge, exactTime } from '../relativeTime';
import { useStore } from '../useStore';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './memory-screen.css';

const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
const DAY = 86_400_000;
const DATES = [['any', 'Any time', Infinity], ['day', 'Past day', DAY], ['week', 'Past week', 7 * DAY], ['month', 'Past month', 30 * DAY]] as const;
type DateFilter = typeof DATES[number][0];
const KIND_LABEL: Record<string, string> = { fact: 'Fact', decision: 'Decision', preference: 'Preference', lesson: 'Lesson', world: 'World', experience: 'Experience', observation: 'Observation' };
const kindLabel = (kind: string) => KIND_LABEL[kind] ?? kind.charAt(0).toUpperCase() + kind.slice(1);
const RETAIN_LABEL: Record<MemoryAutoRetain, string> = { never: 'Never', ask: 'Ask after runs', verified: 'Save after completed runs' };

export function statusLabel(status: MemoryStatusView | undefined): string {
  if (!status) return 'Checking…';
  return status.connection === 'connected' ? 'Connected' : status.connection === 'unchecked' ? 'Configured' : status.connection === 'local-only' ? 'Local only' : 'Not configured';
}

/** What a document deletion actually achieved, in words that never claim more than the engine confirmed (MEM-14). */
export function documentDeleteNotice(engine: MemoryDeleteEngineState, pending?: MemoryPendingDelete): string {
  if (engine === 'deleted') return 'Source document deleted in Muster and in the memory engine.';
  if (engine === 'skipped') return 'Source document deleted from local memory. The memory engine is not set up for this scope.';
  if (engine === 'unsupported') return 'Hidden from recall in Muster now. The memory engine cannot delete documents yet, so its copy stays there; Muster retries once deletion is supported.';
  return `Hidden from recall in Muster now. The memory engine has not confirmed the deletion yet${pending?.lastError ? ` (${pending.lastError})` : ''}; Muster retries automatically.`;
}

function MemoryRow({ record, open, onToggle, onDelete, onCorrect, onDeleteDocument }: { record: MemoryRecord; open: boolean; onToggle: () => void; onDelete: (record: MemoryRecord) => Promise<void>; onCorrect: (record: MemoryRecord, text: string) => Promise<void>; onDeleteDocument?: (record: MemoryRecord) => Promise<void> }): React.ReactElement {
  const [confirmingDocument, setConfirmingDocument] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(record.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (!open) { setConfirming(false); setEditing(false); setError(''); } }, [open]);
  useEffect(() => { setText(record.text); }, [record.text]);
  const remove = async () => {
    if (!confirming) { setConfirming(true); return; }
    setBusy(true); setError('');
    try { await onDelete(record); } catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  const removeDocument = async () => {
    if (!onDeleteDocument) return;
    if (!confirmingDocument) { setConfirmingDocument(true); return; }
    setBusy(true); setError('');
    try { await onDeleteDocument(record); } catch (cause) { setError(errorText(cause)); setBusy(false); }
  };
  const correct = async () => {
    if (!text.trim() || text.trim() === record.text) { setEditing(false); return; }
    setBusy(true); setError('');
    try { await onCorrect(record, text.trim()); setEditing(false); } catch (cause) { setError(errorText(cause)); } finally { setBusy(false); }
  };
  return (
    <li className="memory-item" data-open={open || undefined}>
      <button type="button" className="memory-item-main" aria-expanded={open} onClick={onToggle}>
        <span className="memory-source" data-source={record.source}>{record.source === 'local' ? 'Local' : 'Engine'}</span>
        <span className="memory-item-summary">{record.text}</span>
        <span className="memory-item-meta">
          <span>{kindLabel(record.kind)}</span>
          {record.observedAt && <time dateTime={record.observedAt} title={exactTime(record.observedAt)}>{compactAge(record.observedAt)}</time>}
        </span>
      </button>
      {open && <div className="memory-detail">
        <dl>
          <dt>Scope</dt><dd>{record.scope.label}</dd>
          <dt>Saved</dt><dd>{record.observedAt ? exactTime(record.observedAt) : 'Not reported by the memory engine'}</dd>
          <dt>Provenance</dt><dd>{record.provenance.length ? record.provenance.join(' · ') : 'None recorded'}</dd>
          {record.tags && <><dt>Tags</dt><dd>{record.tags.join(', ')}</dd></>}
          {record.score !== undefined && <><dt>Match</dt><dd>{record.score.toFixed(2)}</dd></>}
          {record.why && <><dt>Why</dt><dd>{record.why}</dd></>}
          {record.documentId && <><dt>Document</dt><dd><code>{record.documentId}</code></dd></>}
          <dt>ID</dt><dd><code>{record.id}</code></dd>
        </dl>
        {editing && <textarea aria-label="Corrected text" className="memory-correct-input" rows={3} value={text} maxLength={8192} disabled={busy} onChange={event => setText(event.target.value)} />}
        <div className="memory-detail-actions">
          {confirming && <span>Agents stop recalling this note.</span>}
          {confirming && <button type="button" className="settings-button ghost" disabled={busy} onClick={() => setConfirming(false)}>Keep</button>}
          {!confirming && editing && <button type="button" className="settings-button ghost" disabled={busy} onClick={() => { setEditing(false); setText(record.text); }}>Cancel</button>}
          {!confirming && editing && <button type="button" className="settings-button" disabled={busy || !text.trim()} onClick={() => void correct()}>{busy ? 'Saving…' : 'Save correction'}</button>}
          {!confirming && !editing && <button type="button" className="settings-button ghost" disabled={busy} onClick={() => setEditing(true)}>Correct</button>}
          {!editing && record.deletable && <button type="button" className="settings-button danger" disabled={busy} onClick={() => void remove()}><Trash2 size={13} />{busy ? 'Deleting…' : confirming ? 'Delete memory' : 'Delete'}</button>}
          {!editing && !record.deletable && record.documentId && onDeleteDocument && <>
            {confirmingDocument && <span>Every memory from this document stops being recalled.</span>}
            {confirmingDocument && <button type="button" className="settings-button ghost" disabled={busy} onClick={() => setConfirmingDocument(false)}>Keep</button>}
            <button type="button" className="settings-button danger" disabled={busy} onClick={() => void removeDocument()}><Trash2 size={13} />{busy ? 'Deleting…' : confirmingDocument ? 'Delete document' : 'Delete source document'}</button>
          </>}
        </div>
        {!record.deletable && !editing && <p className="memory-detail-note">{record.documentId ? 'A single engine memory cannot be deleted on its own; deleting its source document hides it in Muster at once and removes it from the memory engine when the engine supports that.' : 'Engine memories are managed by the memory engine; Muster can recall them but not delete them.'} Correcting one records a new local note that supersedes it.</p>}
        {error && <p className="memory-error" role="alert">{error}</p>}
      </div>}
    </li>
  );
}

/** A run lesson the runtime suggested: edit it, then remember or dismiss it. */
function OfferCard({ offer, onDone }: { offer: MemoryOffer; onDone: (notice: string) => void }): React.ReactElement {
  const [text, setText] = useState(offer.summary);
  const [busy, setBusy] = useState<'save' | 'dismiss' | null>(null);
  const [error, setError] = useState('');
  const act = async (kind: 'save' | 'dismiss') => {
    if (busy || (kind === 'save' && !text.trim())) return;
    setBusy(kind); setError('');
    try {
      if (kind === 'dismiss') { await invoke('memory.offer.dismiss', { chatId: offer.chatId, runId: offer.runId }); onDone('Suggestion dismissed.'); return; }
      const result = await invoke('memory.retainFromRun', { chatId: offer.chatId, runId: offer.runId, summary: text.trim() });
      onDone(result.hindsight === 'failed' ? `Saved locally. ${result.error ?? ''}`.trim() : result.hindsight === 'skipped' ? 'Saved to local memory.' : 'Saved to local memory and the memory engine.');
    } catch (cause) { setError(errorText(cause)); setBusy(null); }
  };
  return (
    <li className="memory-offer">
      <div className="memory-offer-head"><span>From “{offer.chatTitle}”</span><time dateTime={offer.createdAt} title={exactTime(offer.createdAt)}>{compactAge(offer.createdAt)}</time></div>
      <textarea aria-label={`Suggested memory from ${offer.chatTitle}`} rows={3} value={text} maxLength={8192} disabled={busy !== null} onChange={event => setText(event.target.value)}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void act('save'); } }} />
      {error && <p className="memory-error" role="alert">{error}</p>}
      <div className="new-memory-actions">
        <button type="button" className="settings-button ghost" disabled={busy !== null} onClick={() => void act('dismiss')}>{busy === 'dismiss' ? 'Dismissing…' : 'Dismiss'}</button>
        <button type="button" className="settings-button" disabled={busy !== null || !text.trim()} onClick={() => void act('save')}>{busy === 'save' ? 'Saving…' : 'Remember'}</button>
      </div>
    </li>
  );
}

function NewMemoryForm({ folderId, scopeName, onClose, onSaved }: { folderId: string | undefined; scopeName: string; onClose: () => void; onSaved: (notice: string) => void }): React.ReactElement {
  const [text, setText] = useState('');
  const [kind, setKind] = useState('fact');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { input.current?.focus(); }, []);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const result = await invoke('memory.rememberText', { ...(folderId ? { folderId } : {}), text: text.trim(), kind, ...(source.trim() ? { source: source.trim() } : {}) });
      onSaved(result.hindsight === 'failed' ? `Saved locally. ${result.error ?? ''}`.trim() : result.hindsight === 'skipped' ? 'Saved to local memory.' : 'Saved to local memory and the memory engine.');
    } catch (cause) { setError(errorText(cause)); setBusy(false); }
  }
  return (
    <form className="new-memory" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
      <header><h2>Remember something</h2><button type="button" className="icon-button" aria-label="Cancel" onClick={onClose} disabled={busy}><X size={14} /></button></header>
      <textarea ref={input} aria-label="What to remember" rows={3} value={text} onChange={event => setText(event.target.value)} placeholder="A fact, decision or preference agents should know" required maxLength={8192} disabled={busy}
        onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
      <div className="new-memory-fields">
        <label>Kind<select value={kind} onChange={event => setKind(event.target.value)} disabled={busy}><option value="fact">Fact</option><option value="decision">Decision</option><option value="preference">Preference</option></select></label>
        <label>Source<input type="text" value={source} onChange={event => setSource(event.target.value)} placeholder="Optional, e.g. design review" maxLength={256} disabled={busy} /></label>
      </div>
      {error && <p className="memory-error" role="alert">{error}</p>}
      <div className="new-memory-actions">
        <span>Saved to {scopeName}</span>
        <button type="button" className="settings-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="settings-button" disabled={busy || !text.trim()}>{busy ? 'Saving…' : 'Save memory'}</button>
      </div>
    </form>
  );
}

export function MemorySettings({ config, folderId, onSaved, onClose }: { config: MemoryConfigView; folderId?: string; onSaved: (config: MemoryConfigView) => void; onClose: () => void }): React.ReactElement {
  const [endpoint, setEndpoint] = useState(config.endpoint);
  const [apiKey, setApiKey] = useState('');
  const [removeKey, setRemoveKey] = useState(false);
  const [autoRecall, setAutoRecall] = useState(config.autoRecall);
  const [autoRetain, setAutoRetain] = useState<MemoryAutoRetain>(config.autoRetain);
  const [busy, setBusy] = useState<'save' | 'test' | null>(null);
  const [error, setError] = useState('');
  const [test, setTest] = useState<MemoryTestResult>();
  const first = useRef<HTMLInputElement>(null);
  useEffect(() => { first.current?.focus(); }, []);
  const dirty = endpoint.trim() !== config.endpoint || apiKey.trim() !== '' || removeKey || autoRecall !== config.autoRecall || autoRetain !== config.autoRetain;
  const persist = async () => {
    const next = await invoke('memory.config.set', { endpoint: endpoint.trim(), autoRecall, autoRetain, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : removeKey ? { apiKey: '' } : {}) });
    setApiKey(''); setRemoveKey(false); onSaved(next);
    return next;
  };
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (busy) return;
    setBusy('save'); setError('');
    try { await persist(); } catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  // Testing saves first, so the result always describes what agents will use.
  const runTest = async () => {
    if (busy) return;
    setBusy('test'); setError(''); setTest(undefined);
    try { if (dirty) await persist(); setTest(await invoke('memory.config.test', folderId ? { folderId } : {})); }
    catch (cause) { setError(errorText(cause)); } finally { setBusy(null); }
  };
  const keyNote = removeKey ? 'The saved key will be removed.' : config.keyStorage === 'encrypted' ? 'A key is saved, encrypted by the system keychain.' : config.keyStorage === 'session' ? 'A key is set for this session only; this system cannot encrypt it for storage.' : config.keyStorage === 'environment' ? 'Using HINDSIGHT_API_KEY from the environment.' : 'No key saved.';
  return (
    <form className="memory-settings" aria-label="Memory settings" onSubmit={save} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
      <header><h2>Memory settings</h2><button type="button" className="icon-button" aria-label="Close memory settings" onClick={onClose}><X size={14} /></button></header>
      <label>Memory engine endpoint
        <input ref={first} type="url" value={endpoint} onChange={event => setEndpoint(event.target.value)} placeholder={config.source === 'environment' && !config.endpoint ? 'Using HINDSIGHT_API_URL from the environment' : 'http://localhost:8888'} maxLength={2048} spellCheck={false} autoComplete="off" disabled={busy !== null} />
      </label>
      <label>API key
        <span className="memory-key-row">
          <input type="password" value={apiKey} onChange={event => { setApiKey(event.target.value); setRemoveKey(false); }} placeholder={config.hasApiKey ? '••••••••  (saved; type to replace)' : 'Optional'} maxLength={4096} autoComplete="off" spellCheck={false} disabled={busy !== null} />
          {config.keyStorage !== 'none' && config.keyStorage !== 'environment' && <button type="button" className="settings-button ghost" disabled={busy !== null || removeKey} onClick={() => { setRemoveKey(true); setApiKey(''); }}>Remove</button>}
        </span>
        <small>{keyNote}</small>
      </label>
      <label className="memory-toggle"><input type="checkbox" checked={autoRecall} onChange={event => setAutoRecall(event.target.checked)} disabled={busy !== null} />
        <span><strong>Use memory in agent runs</strong><small>Before each run, relevant notes from this chat's scope are added as context. The run shows which ones.</small></span>
      </label>
      <label>After a run completes
        <select value={autoRetain} onChange={event => setAutoRetain(event.target.value as MemoryAutoRetain)} disabled={busy !== null}>
          {(Object.keys(RETAIN_LABEL) as MemoryAutoRetain[]).map(value => <option key={value} value={value}>{RETAIN_LABEL[value]}</option>)}
        </select>
      </label>
      {test && <p className="memory-test" data-ok={test.ok} role="status">{test.message}</p>}
      {error && <p className="memory-error" role="alert">{error}</p>}
      <div className="new-memory-actions">
        <button type="button" className="settings-button ghost" disabled={busy !== null || (!endpoint.trim() && config.source !== 'environment')} onClick={() => void runTest()}>{busy === 'test' ? 'Testing…' : 'Test connection'}</button>
        <button type="submit" className="settings-button" disabled={busy !== null || !dirty}>{busy === 'save' ? 'Saving…' : 'Save'}</button>
      </div>
    </form>
  );
}

/** One memory page: local notes and Hindsight results in a single list, with settings and a Recall and Reflect drawer. */
export function MemoryScreen(): React.ReactElement {
  const state = useStore();
  const folderId = state.memoryFolderId;
  const folder = state.snapshot?.folders.find(item => item.id === folderId);
  const project = !folder && folderId?.startsWith('project:') ? state.snapshot?.projects.find(item => `project:${item.id}` === folderId) : undefined;
  const scopeName = folder ? folder.name : project ? project.name : 'Personal';
  const [panel, setPanel] = useState<'add' | 'settings' | 'advanced' | null>(null);
  const [drawer, setDrawer] = useState(false);
  // Esc closes the drawer even when focus isn't inside the memory section.
  useEffect(() => {
    if (!drawer) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !event.defaultPrevented) { event.preventDefault(); setDrawer(false); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [drawer]);
  const [config, setConfig] = useState<MemoryConfigView>();
  const [status, setStatus] = useState<MemoryStatusView>();
  const [records, setRecords] = useState<MemoryRecord[]>();
  const [loadError, setLoadError] = useState('');
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [searched, setSearched] = useState('');
  const [kind, setKind] = useState('all');
  const [date, setDate] = useState<DateFilter>('any');
  const [source, setSource] = useState<'all' | 'local' | 'hindsight'>('all');
  const [open, setOpen] = useState<string>();
  const [notice, setNotice] = useState('');
  const [offers, setOffers] = useState<MemoryOffer[]>([]);
  const ticket = useRef(0);
  const back = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);

  const load = async (search = searched) => {
    const current = ++ticket.current;
    setLoading(true); setLoadError('');
    try {
      const result = await invoke('memory.browse', { ...(folderId ? { folderId } : {}), ...(search ? { query: search } : {}) });
      if (current === ticket.current) { setRecords(result.records); setStatus(result.status); setSearched(search); }
    } catch (cause) { if (current === ticket.current) setLoadError(errorText(cause)); }
    finally { if (current === ticket.current) setLoading(false); }
  };
  useEffect(() => {
    launcher.current = document.activeElement;
    back.current?.focus();
    void load('');
    void invoke('memory.config.get', {}).then(setConfig, () => {});
    let live = true;
    void invoke('memory.offers', folderId ? { folderId } : {}).then(result => { if (live) setOffers(result.offers); }, () => {});
    return () => { live = false; ticket.current++; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };

  const kinds = useMemo(() => [...new Set((records ?? []).map(record => record.kind))].sort(), [records]);
  const visible = useMemo(() => {
    const now = Date.now(), span = DATES.find(entry => entry[0] === date)![2], typed = query.trim().toLowerCase();
    return (records ?? []).filter(record =>
      (source === 'all' || record.source === source) && (kind === 'all' || record.kind === kind) &&
      (span === Infinity || (record.observedAt !== undefined && now - Date.parse(record.observedAt) <= span)) &&
      // Typing narrows local rows instantly; Enter also asks Hindsight.
      (!typed || typed === searched.toLowerCase() || record.source === 'hindsight' || record.text.toLowerCase().includes(typed)));
  }, [records, source, kind, date, query, searched]);
  const filtered = kind !== 'all' || date !== 'any' || source !== 'all';
  const remove = async (record: MemoryRecord) => {
    await invoke('memory.delete', { ...(folderId ? { folderId } : {}), id: record.id });
    setRecords(current => current?.filter(item => item.id !== record.id)); setOpen(undefined); setNotice('Memory deleted.');
  };
  const [pendingDeletes, setPendingDeletes] = useState<MemoryPendingDelete[]>([]);
  const loadDeletes = () => { void invoke('memory.deletes.list', folderId ? { folderId } : {}).then(result => setPendingDeletes(result.deletes), () => {}); };
  useEffect(loadDeletes, [folderId]); // eslint-disable-line react-hooks/exhaustive-deps
  const removeDocument = async (record: MemoryRecord) => {
    if (!record.documentId) return;
    const result = await invoke('memory.document.delete', { ...(folderId ? { folderId } : {}), documentId: record.documentId });
    setRecords(current => current?.filter(item => item.documentId !== record.documentId)); setOpen(undefined);
    setNotice(documentDeleteNotice(result.engine, result.pending)); loadDeletes();
  };
  const [retrying, setRetrying] = useState(false);
  const retryDeletes = async () => {
    setRetrying(true);
    try { const result = await invoke('memory.deletes.retry', folderId ? { folderId } : {}); setPendingDeletes(result.deletes); setNotice(result.deleted ? `The memory engine confirmed ${result.deleted} deletion${result.deleted === 1 ? '' : 's'}.` : 'The memory engine has not confirmed the pending deletions yet.'); }
    catch (cause) { setNotice(errorText(cause)); } finally { setRetrying(false); }
  };
  // A correction supersedes the old fact with a new local one (the old Hindsight-origin text cannot be edited in place), so the list is reloaded rather than patched in place.
  const correct = async (record: MemoryRecord, text: string) => {
    await invoke('memory.correct', { ...(folderId ? { folderId } : {}), id: record.id, source: record.source, text, kind: record.kind });
    setOpen(undefined); setNotice('Correction saved.'); await load(searched);
  };
  const connection = status?.connection;

  return (
    <section className="settings-screen memory-screen" aria-label="Memory" onKeyDown={event => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      if (drawer) setDrawer(false); else if (panel) setPanel(null); else leave();
    }}>
      <header className="settings-topbar">
        <button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15} />Back to app</button>
        <span>Memory</span>
      </header>
      <div className="settings-scroll"><div className="settings-content">
        <div className="settings-title">
          <div>
            <h1>Memory</h1>
            <p>What agents remember for {folder ? folder.name : project ? project.name : 'you across every chat'}. Relevant notes join each run as context.</p>
          </div>
          {panel !== 'add' && <button className="settings-button" onClick={() => { setPanel('add'); setNotice(''); }}><Plus size={14} />Remember something</button>}
        </div>
        <div className="memory-toolbar">
          <label className="memory-scope-picker"><span>Scope</span><select aria-label="Memory scope" value={folderId ?? ''} onChange={event => openMemoryScreen(event.target.value || undefined)}>
            <option value="">Personal</option>
            {state.snapshot?.folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
            {state.snapshot?.projects.filter(item => !item.archived).map(item => <option key={`project:${item.id}`} value={`project:${item.id}`}>{item.name}</option>)}
          </select></label>
          <span className="memory-status-pill" data-connection={connection ?? 'checking'} title={status?.error ?? status?.endpoint ?? ''}>{connection === 'not-configured' ? 'Memory engine (Hindsight) · not set up' : connection === 'local-only' ? 'Memory engine (Hindsight) · unreachable, local only' : `Memory engine (Hindsight) · ${statusLabel(status).toLowerCase()}`}</span>
          <span className="memory-toolbar-spacer" />
          <button type="button" className="settings-button secondary" aria-pressed={panel === 'advanced'} onClick={() => setPanel(value => value === 'advanced' ? null : 'advanced')}><Layers size={14} />Advanced</button>
          <button type="button" className="settings-button secondary" aria-pressed={panel === 'settings'} onClick={() => setPanel(value => value === 'settings' ? null : 'settings')}><Settings2 size={14} />{connection === 'not-configured' ? 'Configure' : 'Settings'}</button>
          <button type="button" className="settings-button secondary" aria-pressed={drawer} title={status?.connection === 'connected' || status?.connection === 'unchecked' ? undefined : 'Set up the memory engine to recall and reflect'} onClick={() => { if (status && status.connection !== 'connected' && status.connection !== 'unchecked') { setDrawer(false); setPanel('settings'); return; } setDrawer(value => !value); }}><Sparkles size={14} />Recall and Reflect</button>
        </div>
        {panel === 'settings' && config && <MemorySettings config={config} folderId={folderId} onClose={() => setPanel(null)} onSaved={next => { setConfig(next); setNotice('Memory settings saved.'); void load(); }} />}
        {panel === 'advanced' && <MemoryAdvanced folderId={folderId} scopeName={scopeName} />}
        {panel === 'add' && <NewMemoryForm folderId={folderId} scopeName={scopeName} onClose={() => setPanel(null)} onSaved={message => { setPanel(null); setNotice(message); void load(); }} />}
        {notice && <p className="memory-notice" role="status">{notice}</p>}
        {pendingDeletes.length > 0 && <p className="memory-delete-status" role="status">
          {pendingDeletes.length} document deletion{pendingDeletes.length === 1 ? '' : 's'} hidden in Muster, not yet confirmed by the memory engine{pendingDeletes[0]?.lastError ? ` · ${pendingDeletes[0].lastError}` : ''}.{' '}
          <button type="button" className="memory-filter-reset" disabled={retrying} onClick={() => void retryDeletes()}>{retrying ? 'Retrying…' : 'Retry now'}</button>
        </p>}
        {offers.length > 0 && <section className="memory-offers" aria-label="Suggested from runs">
          <h2>Suggested from runs <span>{offers.length}</span></h2>
          <ul>{offers.map(offer => <OfferCard key={offer.itemId} offer={offer} onDone={message => { setOffers(current => current.filter(item => item.itemId !== offer.itemId)); setNotice(message); void load(); }} />)}</ul>
        </section>}
        <form className="memory-search" onSubmit={event => { event.preventDefault(); void load(query.trim()); }}>
          <Search size={14} aria-hidden="true" />
          <input type="text" value={query} onChange={event => setQuery(event.target.value)} placeholder={connection === 'not-configured' ? 'Search memory' : 'Search memory · Enter also asks the memory engine'} aria-label="Search memory" maxLength={2048} />
          {query && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setQuery(''); if (searched) void load(''); }}><X size={13} /></button>}
        </form>
        <div className="memory-filters" role="group" aria-label="Filters">
          <select aria-label="Kind" value={kind} onChange={event => setKind(event.target.value)}><option value="all">All kinds</option>{kinds.map(value => <option key={value} value={value}>{kindLabel(value)}</option>)}</select>
          <select aria-label="Date" value={date} onChange={event => setDate(event.target.value as DateFilter)}>{DATES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select aria-label="Source" value={source} onChange={event => setSource(event.target.value as typeof source)}><option value="all">All sources</option><option value="local">Local</option><option value="hindsight">Memory engine</option></select>
          {filtered && <button type="button" className="memory-filter-reset" onClick={() => { setKind('all'); setDate('any'); setSource('all'); }}>Reset</button>}
          <span className="memory-count">{records ? `${visible.length} of ${records.length}` : ''}</span>
        </div>
        {loading && !records && <p className="memory-empty" role="status">Loading memory…</p>}
        {loadError && <p className="memory-error" role="alert">Memory unavailable: {loadError}</p>}
        {records && visible.length === 0 && !loading && <p className="memory-empty" role="status">{records.length === 0 ? (searched ? 'Nothing matched this search.' : 'Nothing remembered yet. Save a note, or keep “Ask after runs” on to be offered one when a run finishes.') : 'No memories match these filters.'}</p>}
        {visible.length > 0 && <ul className="memory-list" aria-busy={loading || undefined}>{visible.map((record, index) => {
          const key = `${record.source}:${record.id}:${index}`;
          return <MemoryRow key={key} record={record} open={open === key} onToggle={() => setOpen(value => value === key ? undefined : key)} onDelete={remove} onCorrect={correct} onDeleteDocument={removeDocument} />;
        })}</ul>}
      </div></div>
      {drawer && <div className="memory-drawer-scrim" aria-hidden="true" onClick={() => setDrawer(false)} />}
      {drawer && <aside className="memory-drawer"><HindsightPanel key={folderId ?? 'personal'} folderId={folderId} onClose={() => setDrawer(false)} onConfigure={() => { setDrawer(false); setPanel('settings'); }} /></aside>}
    </section>
  );
}
