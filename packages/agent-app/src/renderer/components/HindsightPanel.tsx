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
  const [detail, setDetail] = useState<'basic' | 'advanced'>('basic');
  const [budget, setBudget] = useState<'low' | 'mid' | 'high'>('low');
  const [maxTokens, setMaxTokens] = useState(2048);
  const [types, setTypes] = useState<Array<'world' | 'experience' | 'observation'>>(['world', 'experience', 'observation']);
  const [tags, setTags] = useState('');
  const [context, setContext] = useState('');
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
        setNotice(result.isAsync
          ? `Retention queued · ${result.itemsCount} item(s) · bank ${result.bankId}${result.operationId ? ` · operation ${result.operationId}` : ''}.`
          : `Hindsight confirmed retention of ${result.itemsCount} item(s) · bank ${result.bankId}.`);
        if (!result.isAsync) { setContent(''); setSource(''); }
      } else if (mode === 'recall') {
        const result = await invoke('hindsight.recall', { folderId, query: query.trim(), ...(detail === 'advanced' ? {budget, maxTokens, types, tags: tags.split(',').map(tag=>tag.trim()).filter(Boolean)} : {}) });
        if (ticket === generation.current) { setRecall(result); setNotice(`Recall completed · bank ${result.bankId} · ${result.results.length} result(s).`); }
      } else {
        const result = await invoke('hindsight.reflect', { folderId, query: query.trim(), ...(detail === 'advanced' ? {budget, maxTokens, context: context.trim() || undefined} : {}) });
        if (ticket === generation.current) { setReflection(result.text); setNotice(`Reflection completed · bank ${result.bankId}.`); }
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
    <p className="hindsight-description">Retain information, recall relevant memories, or reflect on what this scope knows. Requests are explicit and scoped to the selected folder or personal bank.</p>
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
    <div className="hindsight-detail" role="group" aria-label="Request detail"><button type="button" aria-pressed={detail==='basic'} disabled={busy} onClick={()=>setDetail('basic')}>Basic</button><button type="button" aria-pressed={detail==='advanced'} disabled={busy} onClick={()=>setDetail('advanced')}>Advanced</button></div>
    <form onSubmit={event => void submit(event)}>
      {mode === 'retain' ? <><label>Information to remember<textarea value={content} onChange={event => setContent(event.target.value)} maxLength={32768} rows={4} required disabled={busy} placeholder="A fact, decision or observation…"/></label><label>Source<input value={source} onChange={event => setSource(event.target.value)} maxLength={512} required disabled={busy} placeholder="Where this information came from"/></label></>
        : <label>{mode === 'recall' ? 'Search this memory bank' : 'Question for this memory bank'}<textarea value={query} onChange={event => setQuery(event.target.value)} maxLength={8192} required rows={2} disabled={busy} placeholder={mode === 'recall' ? 'What should Muster recall?' : 'What can we learn from these memories?'}/></label>}
      {detail === 'advanced' && mode !== 'retain' && <div className="hindsight-advanced">
        <label>Retrieval budget<select value={budget} disabled={busy} onChange={event=>setBudget(event.target.value as typeof budget)}><option value="low">Low</option><option value="mid">Medium</option><option value="high">High</option></select></label>
        <label>Maximum response tokens<select value={maxTokens} disabled={busy} onChange={event=>setMaxTokens(Number(event.target.value))}><option value={1024}>1,024</option><option value={2048}>2,048</option><option value={4096}>4,096</option></select></label>
        {mode === 'recall' ? <><fieldset><legend>Memory types</legend>{(['world','experience','observation'] as const).map(type=><label key={type}><input type="checkbox" checked={types.includes(type)} disabled={busy} onChange={event=>setTypes(current=>event.target.checked?[...current,type]:current.filter(value=>value!==type))}/>{type}</label>)}</fieldset><label>Tags, comma separated<input value={tags} maxLength={2048} disabled={busy} onChange={event=>setTags(event.target.value)} placeholder="optional filters"/></label></> : <label>Context<input value={context} maxLength={8192} disabled={busy} onChange={event=>setContext(event.target.value)} placeholder="Optional context for this reflection"/></label>}
      </div>}
      <div className="hindsight-submit"><span>{mode === 'retain' ? 'Only the text and source above are sent.' : 'Uses a bounded retrieval budget.'}</span><button type="submit" className="settings-button" disabled={!enabled || busy || statusBusy || (mode === 'retain' ? !content.trim() || !source.trim() : !query.trim())}>{busy ? 'Working…' : mode === 'retain' ? 'Retain memory' : mode === 'recall' ? 'Recall' : 'Reflect'}</button></div>
    </form>
    {busy && <p role="status">Waiting for Hindsight…</p>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {recall && <div className="hindsight-results" aria-label="Recalled memories"><p role="status">{recall.results.length ? `${recall.results.length} recalled memories` : 'No memories matched this query.'}</p>{recall.results.map((entry, index) => <article key={`${entry.id ?? index}-${index}`}><p>{entry.text}</p><small>{[entry.type, entry.id, entry.score === undefined ? '' : `score ${entry.score}`].filter(Boolean).join(' · ')}</small></article>)}</div>}
    {reflection && <div className="hindsight-results" aria-label="Memory reflection"><p>{reflection}</p></div>}
  </section>;
}
