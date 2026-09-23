import { ChevronDown, Square, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { MemoryRecallExcluded, MemoryRecord, MemoryStatusView } from '../../shared/domains/memory-protocol';
import { invoke } from '../bridge';
import './hindsight-panel.css';

type Mode = 'recall' | 'reflect';
type Budget = 'low' | 'mid' | 'high';
type RecallType = 'world' | 'experience' | 'observation';
const TYPES: readonly RecallType[] = ['world', 'experience', 'observation'];
const safeLink = (url: string) => /^(https?:|mailto:)/i.test(url) ? url : '';
const errorText = (cause: unknown) => cause instanceof Error ? cause.message : String(cause);
let requestSequence = 0;

function Evidence({ records }: { records: readonly MemoryRecord[] }): React.ReactElement {
  return <ol className="recall-evidence">{records.map((record, index) => <li key={`${record.id}-${index}`}>
    <p>{record.text}</p>
    <small>{[record.kind, record.observedAt ? new Date(record.observedAt).toLocaleString() : 'undated', record.provenance[0], record.score === undefined ? '' : `score ${record.score.toFixed(2)}`].filter(Boolean).join(' · ')}</small>
    {record.why && <small className="recall-why">Matched: {record.why}</small>}
  </li>)}</ol>;
}

/** "3 recalled memories; 2 left out: 1 undated, 1 outside the time range". Filters apply to what the engine returned. */
export function recallNotice(count: number, excluded?: MemoryRecallExcluded): string {
  const head = count ? `${count} recalled ${count === 1 ? 'memory' : 'memories'}` : 'No memories matched this query and its filters.';
  if (!excluded) return count ? head : 'No memories matched this query.';
  const parts = [excluded.noEntity ? `${excluded.noEntity} not mentioning the entities` : '', excluded.outsideRange ? `${excluded.outsideRange} outside the time range` : '', excluded.untimed ? `${excluded.untimed} undated (a time filter needs a date)` : ''].filter(Boolean);
  return parts.length ? `${head} Left out: ${parts.join(', ')}.` : head;
}
const splitList = (value: string) => value.split(',').map(item => item.trim()).filter(Boolean);

/** Recall and Reflect against the selected scope's Hindsight bank. Requests are explicit; mounting sends none. */
export function HindsightPanel({ folderId, onClose, onConfigure }: { folderId?: string; onClose?: () => void; onConfigure?: () => void }): React.ReactElement {
  const [status, setStatus] = useState<MemoryStatusView>();
  const [mode, setMode] = useState<Mode>('recall');
  const [options, setOptions] = useState(false);
  const [budget, setBudget] = useState<Budget>('low');
  const [maxTokens, setMaxTokens] = useState(2048);
  const [types, setTypes] = useState<RecallType[]>([...TYPES]);
  const [tags, setTags] = useState('');
  const [entities, setEntities] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [validAt, setValidAt] = useState('');
  const [context, setContext] = useState('');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [records, setRecords] = useState<MemoryRecord[]>();
  const [reflection, setReflection] = useState<{ text: string; sources: MemoryRecord[] }>();
  const generation = useRef(0);
  const active = useRef<string | null>(null);
  const input = useRef<HTMLTextAreaElement>(null);

  const readStatus = async (ticket: number) => {
    try { const next = await invoke('memory.status', folderId ? { folderId } : {}); if (ticket === generation.current) setStatus(next); }
    catch (cause) { if (ticket === generation.current) setStatus({ connection: 'not-configured', error: errorText(cause) }); }
  };
  useEffect(() => {
    const ticket = ++generation.current;
    active.current = null;
    setStatus(undefined); setBusy(false); setQuery(''); setRecords(undefined); setReflection(undefined); setError(''); setNotice('');
    void readStatus(ticket);
    input.current?.focus();
    return () => {
      generation.current++;
      // Leaving the scope cancels its reflection instead of letting it finish unseen.
      if (active.current) void invoke('memory.reflect.cancel', { requestId: active.current }).catch(() => {});
    };
  }, [folderId]);

  const configured = status !== undefined && status.connection !== 'not-configured';
  const cancel = () => { if (active.current) void invoke('memory.reflect.cancel', { requestId: active.current }).catch(() => {}); };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const text = query.trim();
    if (busy || !configured || !text) return;
    const ticket = generation.current;
    setBusy(true); setError(''); setNotice(''); setRecords(undefined); setReflection(undefined);
    try {
      if (mode === 'recall') {
        const filters = options ? { ...(splitList(entities).length ? { entities: splitList(entities) } : {}), ...(from ? { from } : {}), ...(to ? { to: `${to}T23:59:59.999Z` } : {}), ...(validAt ? { validAt: `${validAt}T23:59:59.999Z` } : {}) } : {};
        const result = await invoke('memory.recall', { ...(folderId ? { folderId } : {}), query: text, ...(options ? { budget, maxTokens, types, tags: splitList(tags), ...filters } : {}) });
        if (ticket === generation.current) { setRecords(result.records); setNotice(recallNotice(result.records.length, result.excluded)); }
      } else {
        const requestId = `reflect-${Date.now().toString(36)}-${++requestSequence}`;
        active.current = requestId;
        const result = await invoke('memory.reflect', { ...(folderId ? { folderId } : {}), query: text, requestId, ...(options ? { budget, maxTokens, ...(context.trim() ? { context: context.trim() } : {}) } : {}) });
        if (ticket === generation.current) {
          if (result.cancelled) setNotice('Reflection cancelled.');
          else setReflection({ text: result.text, sources: result.sources });
        }
      }
    } catch (cause) {
      if (ticket === generation.current) setError(errorText(cause));
    } finally {
      if (ticket === generation.current) { active.current = null; setBusy(false); void readStatus(ticket); }
    }
  };

  const label = status === undefined ? 'Checking…' : status.connection === 'connected' ? 'Connected' : status.connection === 'local-only' ? 'Last request failed' : status.connection === 'unchecked' ? 'Configured' : 'Not configured';
  return <section className="hindsight-panel" aria-label="Recall and Reflect" onKeyDown={event => { if (event.key === 'Escape' && onClose && !event.defaultPrevented) { event.preventDefault(); event.stopPropagation(); if (busy) cancel(); else onClose(); } }}>
    <header className="hindsight-heading">
      <h2>Recall and Reflect</h2>
      <span className="memory-status-pill" data-connection={status?.connection ?? 'checking'}>{label}</span>
      {onClose && <button type="button" className="icon-button" aria-label="Close Recall and Reflect" onClick={onClose}><X size={14} /></button>}
    </header>
    {status?.connection === 'not-configured' ? <div className="hindsight-unconfigured">
      <p>Recall and Reflect search this scope's memory engine by meaning. {status.error}</p>
      {onConfigure && <button type="button" className="settings-button secondary" onClick={onConfigure}>Set up memory engine</button>}
    </div> : <>
      {status?.connection === 'local-only' && status.error && <p className="hindsight-warning" role="status">{status.error}</p>}
      <div className="hindsight-modes" role="tablist" aria-label="Memory operation">
        {(['recall', 'reflect'] as const).map(value => <button type="button" role="tab" key={value} disabled={busy} aria-selected={mode === value} onClick={() => { setMode(value); setError(''); setNotice(''); setRecords(undefined); setReflection(undefined); }}>{value === 'recall' ? 'Recall' : 'Reflect'}</button>)}
      </div>
      <form onSubmit={event => void submit(event)}>
        <textarea ref={input} aria-label={mode === 'recall' ? 'What to recall' : 'Question to reflect on'} value={query} onChange={event => setQuery(event.target.value)} maxLength={8192} rows={3} disabled={busy}
          placeholder={mode === 'recall' ? 'What do we know about…' : 'What have we learned about…'}
          onKeyDown={event => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) { event.preventDefault(); event.currentTarget.form?.requestSubmit(); } }} />
        <button type="button" className="hindsight-options-toggle" aria-expanded={options} onClick={() => setOptions(open => !open)}><ChevronDown size={13} aria-hidden="true" />Options</button>
        {options && <div className="hindsight-advanced">
          <label>Budget<select value={budget} disabled={busy} onChange={event => setBudget(event.target.value as Budget)}><option value="low">Low</option><option value="mid">Medium</option><option value="high">High</option></select></label>
          <label>Max tokens<select value={maxTokens} disabled={busy} onChange={event => setMaxTokens(Number(event.target.value))}><option value={1024}>1,024</option><option value={2048}>2,048</option><option value={4096}>4,096</option></select></label>
          {mode === 'recall' ? <>
            <fieldset><legend>Types</legend>{TYPES.map(type => <label key={type}><input type="checkbox" checked={types.includes(type)} disabled={busy} onChange={event => setTypes(current => event.target.checked ? [...current, type] : current.filter(value => value !== type))} />{type}</label>)}</fieldset>
            <label className="wide">Tags<input value={tags} maxLength={2048} disabled={busy} onChange={event => setTags(event.target.value)} placeholder="folder:…, chat:… (comma separated)" /></label>
            <label className="wide">Entities<input type="text" value={entities} maxLength={2048} disabled={busy} onChange={event => setEntities(event.target.value)} placeholder="People, services or files the memory must mention (comma separated)" /></label>
            <label>From<input type="date" value={from} max={to || undefined} disabled={busy || Boolean(validAt)} onChange={event => setFrom(event.target.value)} /></label>
            <label>To<input type="date" value={to} min={from || undefined} disabled={busy || Boolean(validAt)} onChange={event => setTo(event.target.value)} /></label>
            <label title="What was true then: memories observed after this day are left out, and the newest one before it comes first">Valid at<input type="date" value={validAt} disabled={busy} onChange={event => { setValidAt(event.target.value); if (event.target.value) { setFrom(''); setTo(''); } }} /></label>
          </> : <label className="wide">Context<input value={context} maxLength={8192} disabled={busy} onChange={event => setContext(event.target.value)} placeholder="Optional background for this question" /></label>}
        </div>}
        <div className="hindsight-submit">
          {busy && mode === 'reflect'
            ? <button type="button" className="settings-button secondary" onClick={cancel}><Square size={12} />Cancel</button>
            : <button type="submit" className="settings-button" disabled={!configured || busy || !query.trim()}>{busy ? 'Recalling…' : mode === 'recall' ? 'Recall' : 'Reflect'}</button>}
        </div>
      </form>
    </>}
    {busy && <p className="hindsight-busy" role="status">{mode === 'recall' ? 'Recalling…' : 'Reflecting…'}</p>}
    {error && <p className="memory-error" role="alert">{error}</p>}
    {notice && <p className="hindsight-notice" role="status">{notice}</p>}
    {records && records.length > 0 && <div className="hindsight-results" aria-label="Recalled memories"><Evidence records={records} /></div>}
    {reflection && <div className="hindsight-results" aria-label="Memory reflection">
      <div className="md-body hindsight-answer"><ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml urlTransform={safeLink}>{reflection.text}</ReactMarkdown></div>
      {reflection.sources.length > 0 && <><h3>Based on {reflection.sources.length} {reflection.sources.length === 1 ? 'memory' : 'memories'}</h3><Evidence records={reflection.sources} /></>}
    </div>}
  </section>;
}
