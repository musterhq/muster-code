import { HindsightPanel } from './HindsightPanel';
import { ArrowLeft, Plus, Search, X } from 'lucide-react';
import React, { useEffect, useRef, useState } from 'react';
import type { MemoryEntry } from '../../shared/protocol';
import { closeSettings, openMemoryScreen, loadMemory, runMemorySearch, saveMemory, setMemorySearch } from '../store';
import { restoreFocus } from '../focus';
import { useStore } from '../useStore';
// @ts-ignore -- side-effect CSS import; esbuild bundles it into dist/renderer/main.css
import './memory-screen.css';

function scopeLabel(entry: MemoryEntry, folders: ReadonlyMap<string, string>): string {
  return entry.scopes.map(s => s.kind === 'user' ? 'Personal' : folders.get(s.id) ?? s.kind).join(', ') || 'Unscoped';
}

function MemoryRow({ entry, folders }: { entry: MemoryEntry; folders: ReadonlyMap<string, string> }): React.ReactElement {
  return (
    <li className="memory-item">
      <div className="memory-item-summary">{entry.summary}</div>
      <div className="memory-item-meta">
        <span className="memory-item-scope">{scopeLabel(entry, folders)}</span>
        <span className="memory-item-time">{new Date(entry.observedAt).toLocaleString()}</span>
        {entry.provenance.length > 0 && <span className="memory-item-provenance">via {entry.provenance.join(', ')}</span>}
      </div>
    </li>
  );
}

function NewMemoryForm({ folderId, onClose, onSaved }: { folderId: string | undefined; onClose: () => void; onSaved: () => void }): React.ReactElement {
  const [summary, setSummary] = useState('');
  const [source, setSource] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const input = useRef<HTMLTextAreaElement>(null);
  const saving = useRef(false);
  useEffect(() => { input.current?.focus(); }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const trimmed = summary.trim();
    if (!trimmed || saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      // Scope is explicit: folder-scoped when a folder is selected, otherwise the
      // personal/user scope. Never derived from a raw renderer path.
      const scopes = folderId
        ? [{ kind: 'workspace', id: folderId }]
        : [{ kind: 'user', id: 'local' }];
      await saveMemory({ folderId, summary: trimmed, provenance: source.trim() ? [source.trim()] : ['manual entry'], scopes });
      setSummary('');
      setSource('');
      onSaved();
    } catch (cause) {
      // Draft is preserved on failure (summary/source state untouched) so a
      // policy rejection never loses what the user typed.
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  return (
    <form className="new-memory" onSubmit={submit} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!saving.current) onClose(); } }}>
      <header>
        <h2>Remember something</h2>
        <button type="button" className="icon-button" aria-label="Cancel" onClick={onClose} disabled={busy}><X size={14} /></button>
      </header>
      <label>
        Fact or decision
        <textarea ref={input} rows={3} value={summary} onChange={e => setSummary(e.target.value)} placeholder="What should Muster remember?" required maxLength={8192} disabled={busy} />
      </label>
      <label>
        Source <span className="optional">(optional)</span>
        <input type="text" value={source} onChange={e => setSource(e.target.value)} placeholder="e.g. this conversation" maxLength={256} disabled={busy} />
      </label>
      <p className="memory-scope-note">Scope: {folderId ? `this folder` : 'personal (no folder selected)'}</p>
      {error && <p className="memory-error" role="alert">{error}</p>}
      <div className="new-memory-actions">
        <button type="button" className="settings-button ghost" onClick={onClose} disabled={busy}>Cancel</button>
        <button type="submit" className="settings-button" disabled={busy || !summary.trim()}>{busy ? 'Saving…' : 'Save memory'}</button>
      </div>
    </form>
  );
}

/** Bounded Memory browser: list, search, add. Scope is server-resolved via memoryFolderId. */
export function MemoryScreen(): React.ReactElement {
  const state = useStore();
  const [adding, setAdding] = useState(false);
  const back = useRef<HTMLButtonElement>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const launcher = useRef<Element | null>(null);
  useEffect(() => {
    launcher.current = document.activeElement;
    back.current?.focus();
    if (state.memory.phase === 'idle') void loadMemory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const leave = () => { closeSettings(); restoreFocus(launcher.current); };
  const folder = state.snapshot?.folders.find(f => f.id === state.memoryFolderId);
  const items = state.memory.value ?? [];
  const folders = new Map(state.snapshot?.folders.map(item => [item.id, item.name]));
  const closeForm = () => { setAdding(false); requestAnimationFrame(() => addButton.current?.focus()); };

  return (
    <section className="settings-screen" aria-label="Memory" onKeyDown={e => { if (e.key === 'Escape' && !e.defaultPrevented && !adding) { e.preventDefault(); leave(); } }}>
      <header className="settings-topbar">
        <button ref={back} className="settings-back" onClick={leave}><ArrowLeft size={15} />Back to work</button>
        <span>Memory</span>
      </header>
      <div className="settings-scroll"><div className="settings-content">
        <div className="settings-title">
          <div>
            <h1>Memory</h1>
            <p>{folder ? `Retained facts and decisions for ${folder.name}.` : 'Personal memory. Select a folder chat to browse its scoped memory.'}</p>
          </div>
          {!adding && <button ref={addButton} className="settings-button" onClick={() => setAdding(true)}><Plus size={14} />Remember something</button>}
        </div>
        <label className="memory-scope-picker">Memory scope <select aria-label="Memory scope" disabled={adding} value={state.memoryFolderId ?? ''} onChange={event => openMemoryScreen(event.target.value || undefined)}><option value="">Personal</option>{state.snapshot?.folders.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <h2 className="local-memory-heading">Local memory</h2>
        {adding && <NewMemoryForm folderId={state.memoryFolderId} onClose={closeForm} onSaved={closeForm} />}
        <form className="memory-search" onSubmit={e => { e.preventDefault(); void runMemorySearch(); }}>
          <Search size={14} />
          <input
            type="text"
            value={state.memorySearch}
            onChange={e => setMemorySearch(e.target.value)}
            placeholder="Search memory…"
            aria-label="Search memory"
          />
          {state.memorySearch && <button type="button" className="icon-button" aria-label="Clear search" onClick={() => { setMemorySearch(''); void loadMemory(); }}><X size={13} /></button>}
        </form>
        {state.memory.phase === 'loading' && <p className="memory-empty" role="status">Loading memory…</p>}
        {state.memory.phase === 'error' && <p className="memory-error" role="alert">Memory unavailable: {state.memory.error}</p>}
        {state.memory.phase === 'ready' && items.length === 0 && (
          <p className="memory-empty" role="status">{state.memorySearch ? 'No matching memories.' : 'Nothing remembered yet.'}</p>
        )}
        {state.memory.phase === 'ready' && items.length > 0 && (
          <ul className="memory-list">{items.map(entry => <MemoryRow key={entry.id} entry={entry} folders={folders} />)}</ul>
        )}
        <HindsightPanel key={state.memoryFolderId ?? "personal"} folderId={state.memoryFolderId}/>
      </div></div>
    </section>
  );
}
