import React, {useEffect, useId, useMemo, useRef, useState} from 'react';
import {Dialog} from '@base-ui/react/dialog';
import {Search} from 'lucide-react';
import {invoke} from '../bridge';
import {openFile} from '../store';
import {useStore} from '../useStore';
import {FileTypeIcon} from './FileTypeIcon';
import {ResourceState} from './ResourceState';
import './resource-tabs.css';

/** Cmd+P: fzf-like file search over the active chat's folder, backed by `files.quickOpen`. */
export function QuickOpen({folderId, folderName, open, onClose}: {folderId: string | undefined; folderName: string; open: boolean; onClose: () => void}): React.ReactElement | null {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Array<{path: string; score: number}> | null>(null);
  const [error, setError] = useState('');
  const [active, setActive] = useState(0);
  const listId = useId();
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (open) { setQuery(''); setResults(null); setError(''); setActive(0); } }, [open]);
  useEffect(() => {
    if (!open || !folderId) return;
    let live = true;
    setError('');
    const timer = setTimeout(() => {
      void invoke('files.quickOpen', {folderId, query}).then(
        value => { if (live) { setResults(value.results); setActive(0); } },
        cause => { if (live) setError(cause instanceof Error ? cause.message : String(cause)); },
      );
    }, query ? 80 : 0);
    return () => { live = false; clearTimeout(timer); };
  }, [open, folderId, query]);
  const rows = useMemo(() => results ?? [], [results]);
  const choose = (path: string) => { if (!folderId) return; onClose(); void openFile(folderId, path); };
  if (!open) return null;
  return <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}>
    <Dialog.Portal>
      <Dialog.Backdrop className="file-dialog-backdrop"/>
      <Dialog.Popup className="resource-add-popup quick-open-popup" initialFocus={input} aria-label={`Quick open in ${folderName}`}>
        <label className="resource-add-search">
          <Search size={14}/>
          <input
            ref={input}
            value={query}
            onChange={event => setQuery(event.target.value)}
            placeholder={`Go to file in ${folderName}…`}
            maxLength={256}
            autoComplete="off"
            spellCheck={false}
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-activedescendant={rows[active] ? `quick-open-${active}` : undefined}
            onKeyDown={event => {
              if (event.key === 'ArrowDown') { event.preventDefault(); setActive(value => Math.min(rows.length - 1, value + 1)); }
              else if (event.key === 'ArrowUp') { event.preventDefault(); setActive(value => Math.max(0, value - 1)); }
              else if (event.key === 'Enter') { event.preventDefault(); const row = rows[active]; if (row) choose(row.path); }
              else if (event.key === 'Escape') { event.preventDefault(); onClose(); }
            }}
          />
        </label>
        <div className="resource-add-list" id={listId} role="listbox">
          {!folderId ? <p className="resource-add-note">Open a folder to search its files.</p>
            : error ? <ResourceState kind="error" message={error} compact/>
            : !results ? <ResourceState kind="loading" label="Finding files" rows={4} compact/>
            : rows.length === 0 ? <p className="resource-add-note">No matching files.</p>
            : rows.map((row, index) => (
              <button
                type="button"
                key={row.path}
                id={`quick-open-${index}`}
                role="option"
                aria-selected={index === active}
                className="resource-add-option"
                data-active={index === active}
                onMouseEnter={() => setActive(index)}
                onClick={() => choose(row.path)}
              >
                <FileTypeIcon path={row.path}/>
                <span className="resource-add-label">{row.path.split('/').pop()}</span>
                <span className="resource-add-detail">{row.path}</span>
              </button>
            ))}
        </div>
      </Dialog.Popup>
    </Dialog.Portal>
  </Dialog.Root>;
}

/** Wires Cmd+P to open Quick Open for the active chat's folder; renders the dialog. */
export function QuickOpenHost(): React.ReactElement | null {
  const state = useStore();
  const [open, setOpen] = useState(false);
  const chat = state.snapshot?.chats.find(c => c.id === state.activeChatId);
  const folder = state.snapshot?.folders.find(f => f.id === chat?.folderId);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const isChord = (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey && event.key.toLowerCase() === 'p';
      if (!isChord) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest?.('[contenteditable="true"]') || target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
        // Quick Open still wins over an editable field so Cmd+P is never captured by the composer or an editor.
      }
      event.preventDefault();
      setOpen(true);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
  if (!open) return null;
  return <QuickOpen folderId={folder?.id} folderName={folder?.name ?? 'workspace'} open={open} onClose={() => setOpen(false)}/>;
}
