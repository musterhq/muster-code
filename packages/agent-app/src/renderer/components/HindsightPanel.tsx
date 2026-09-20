import { Brain, RefreshCw } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { Commands, HindsightStatus } from '../../shared/protocol';
import { invoke } from '../bridge';
import './hindsight-panel.css';

type Mode = 'recall' | 'reflect' | 'retain';
type Recall = Commands['hindsight.recall']['output'];
/** Explicit memory operations. No automatic upload of chats or workspace files. */
export function HindsightPanel({ folderId }: { folderId?: string }): React.ReactElement {
  const [status, setStatus] = useState<HindsightStatus>();
  const [statusBusy, setStatusBusy] = useState(false);
  const [mode, setMode] = useState<Mode>('recall');
  const [query, setQuery] = useState('');
  const [content, setContent] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [recall, setRecall] = useState<Recall>();
  const [reflection, setReflection] = useState('');
  const generation = useRef(0);
  const pending = useRef<number | null>(null);

  const refresh = async () => {
    const ticket = ++generation.current;
    setRecall(undefined); setReflection(''); setNotice(''); setError('');
    setStatusBusy(true);
    try { const next = await invoke('hindsight.status', { folderId }); if (ticket === generation.current) setStatus(next); }
    catch (cause) { if (ticket === generation.current) setStatus({ configured: false, error: String(cause instanceof Error ? cause.message : cause) }); }
    finally { if (ticket === generation.current) setStatusBusy(false); }
  };
  useEffect(() => {
    pending.current = null;
    setStatus(undefined); setBusy(false); setQuery(''); setContent(''); setSource('');
    void refresh();
    return () => { generation.current++; };
  }, [folderId]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (pending.current !== null || statusBusy || !status?.configured || status.error) return;
    const ticket = generation.current;
    pending.current = ticket; setBusy(true); setError(''); setNotice(''); setRecall(undefined); setReflection('');
    try {
      if (mode === 'retain') {
        const result = await invoke('hindsight.retain', { folderId, content: content.trim(), source: source.trim() });
        if (ticket !== generation.current) return;
        if (!result.success) throw new Error('Hindsight did not confirm that this memory was retained. Your text is preserved.');
        setNotice(result.isAsync ? `Retention queued${result.operationId ? ` · ${result.operationId}` : ''}.` : 'Hindsight confirmed this memory was retained.');
        if (!result.isAsync) { setContent(''); setSource(''); }
      } else if (mode === 'recall') {
        const result = await invoke('hindsight.recall', { folderId, query: query.trim() });
        if (ticket === generation.current) setRecall(result);
      } else {
        const result = await invoke('hindsight.reflect', { folderId, query: query.trim() });
        if (ticket === generation.current) setReflection(result.text);
      }
    } catch (cause) {
      if (ticket === generation.current) setError(`${cause instanceof Error ? cause.message : String(cause)}${mode === 'retain' ? ' The request was not retried; its outcome may need checking before submitting again.' : ''}`);
    } finally {
      // Read evidence from the real operation; status never sends a test query.
      if (ticket === generation.current) {
        try {
          const next = await invoke('hindsight.status', { folderId });
          if (ticket === generation.current) {
            setStatus(next);
            if (next.revision !== status.revision) { setRecall(undefined); setReflection(''); setNotice(''); }
          }
        } catch { /* Preserve operation results when status is unavailable. */ }
      }
      if (pending.current === ticket) pending.current = null;
      if (ticket === generation.current) setBusy(false);
    }
  };
  const enabled = status?.configured && !status.error;
  return <section className="hindsight-panel" aria-label="Hindsight memory">
    <header className="hindsight-heading"><div><Brain size={18} aria-hidden="true"/><h2>Hindsight</h2></div><button type="button" className="icon-button" disabled={busy || statusBusy} onClick={() => void refresh()} title="Reread Muster's environment configuration; no connection test is sent" aria-label="Refresh Hindsight configuration"><RefreshCw size={14}/></button></header>
    <p className="hindsight-description">Retain information, recall relevant memories, or reflect on what this scope knows.</p>
    {statusBusy && <p role="status">Reading configuration…</p>}
    {status && <div className="hindsight-connection">
      <span className="hindsight-status" data-connection={enabled ? status.connection ?? 'unchecked' : 'unavailable'}>{!enabled ? 'Not available' : status.connection === 'verified' ? 'Connection verified by last request' : status.connection === 'failed' ? 'Configured · last request failed' : 'Configured · connection not verified'}</span>
      {status.checkedAt && <small>Last request: {new Date(status.checkedAt).toLocaleString()}</small>}
      {status.connectionError && <p role="status">{status.connectionError}</p>}
      {status.endpoint && <span title={status.endpoint}>{status.endpoint}</span>}
      {status.bankId && <code title={status.bankId}>{status.bankId}</code>}
      {status.error && <p>{status.error}</p>}
      {!status.configured && <p>Start or connect a Hindsight service and set <code>HINDSIGHT_API_URL</code> for Muster. Local memory remains available.</p>}
      <p>Refresh rereads the environment available to Muster. Restart Muster after changing variables in your shell. A recall, retain or reflect request verifies access to this memory bank.</p>
    </div>}
    <div className="hindsight-modes" role="group" aria-label="Memory operation">
      {(['recall', 'reflect', 'retain'] as const).map(value => <button type="button" key={value} disabled={busy} aria-pressed={mode === value} onClick={() => { setMode(value); setError(''); setNotice(''); setRecall(undefined); setReflection(''); }}>{value[0].toUpperCase() + value.slice(1)}</button>)}
    </div>
    <form onSubmit={event => void submit(event)}>
      {mode === 'retain' ? <><label>Information to remember<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={32768} rows={4} required disabled={busy} placeholder="A fact, decision or observation…"/></label><label>Source<input value={source} onChange={event => setSource(event.target.value)} maxLength={512} required disabled={busy} placeholder="Where this information came from"/></label></>
        : <label>{mode === 'recall' ? 'Search this memory bank' : 'Question for this memory bank'}<textarea value={query} onChange={event => setQuery(event.target.value)} maxLength={8192} required rows={2} disabled={busy} placeholder={mode === 'recall' ? 'What should Muster recall?' : 'What can we learn from these memories?'}/></label>}
      <div className="hindsight-submit"><span>{mode === 'retain' ? 'Only the text and source above are sent.' : 'Uses a bounded retrieval budget.'}</span><button type="submit" className="settings-button" disabled={!enabled || busy || statusBusy || (mode === 'retain' ? !content.trim() || !source.trim() : !query.trim())}>{busy ? 'Working…' : mode === 'retain' ? 'Retain memory' : mode === 'recall' ? 'Recall' : 'Reflect'}</button></div>
    </form>
    {busy && <p role="status">Waiting for Hindsight…</p>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {recall && <div className="hindsight-results" aria-label="Recalled memories"><p role="status">{recall.results.length ? `${recall.results.length} recalled memories` : 'No memories matched this query.'}</p>{recall.results.map((entry, index) => <article key={`${entry.id ?? index}-${index}`}><p>{entry.text}</p><small>{[entry.type, entry.id].filter(Boolean).join(' · ')}</small></article>)}</div>}
    {reflection && <div className="hindsight-results" aria-label="Memory reflection"><p>{reflection}</p></div>}
  </section>;
}
