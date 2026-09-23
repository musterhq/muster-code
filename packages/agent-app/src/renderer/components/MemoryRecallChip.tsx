import React, { useEffect, useRef, useState } from 'react';
import { Brain, RotateCcw, X } from 'lucide-react';
import type { MemoryRecallChipItem, MemoryRecallPreview } from '../../shared/domains/memory-protocol';
import { invoke } from '../bridge';
import { notifyError } from '../store';
import './memory-recall-chip.css';

const DEBOUNCE_MS = 450;

/** MEM-X2: composer-footer chip showing which notes the next turn would recall for the current draft. Click to inspect;
 *  removing a note leaves it out of this chat's recall until restored. Local notes only — engine results join at send time. */
export function MemoryRecallChip({ chatId, text }: { chatId: string; text: string }): React.ReactElement | null {
  const [preview, setPreview] = useState<MemoryRecallPreview | null>(null);
  const [open, setOpen] = useState(false);
  const [revision, setRevision] = useState(0);
  const wrap = useRef<HTMLSpanElement>(null);
  const asked = useRef('');
  useEffect(() => {
    let live = true;
    // Typing waits for a pause; a leave-out/restore (same text) refreshes at once.
    const wait = text.trim() && text !== asked.current ? DEBOUNCE_MS : 0;
    asked.current = text;
    const timer = setTimeout(() => {
      invoke('memory.recall.preview', { chatId, prompt: text.slice(0, 4000) })
        .then(result => { if (live) setPreview(result && typeof result === 'object' && Array.isArray(result.records) ? result : null); }, () => { if (live) setPreview(null); });
    }, wait);
    return () => { live = false; clearTimeout(timer); };
  }, [chatId, text, revision]);
  useEffect(() => { setOpen(false); }, [chatId]);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => { if (wrap.current && !wrap.current.contains(event.target as Node)) setOpen(false); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setOpen(false); } };
    document.addEventListener('mousedown', down); document.addEventListener('keydown', key, true);
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key, true); };
  }, [open]);
  if (!preview?.enabled || (!preview.records.length && !preview.excluded.length)) return null;
  const toggle = (item: MemoryRecallChipItem, excluded: boolean) => {
    invoke('memory.recall.exclude', { chatId, id: item.id, text: item.text, excluded }).then(() => setRevision(value => value + 1), notifyError);
  };
  const count = preview.records.length;
  const label = count ? `${count} ${count === 1 ? 'memory' : 'memories'}` : 'Memory';
  return <span ref={wrap} className="memory-recall-chip-wrap">
    <button type="button" data-testid="memory-recall-chip" className={`memory-recall-chip${count ? '' : ' is-empty'}`} aria-haspopup="dialog" aria-expanded={open}
      aria-label={`Memory for the next turn: ${label}${preview.excluded.length ? `, ${preview.excluded.length} removed` : ''}`} title="What the next turn will recall" onClick={() => setOpen(value => !value)}>
      <Brain size={13} aria-hidden="true" /><span>{label}</span>
    </button>
    {open && <div className="composer-popover memory-recall-popover" role="dialog" aria-label="Recalled for the next turn">
      <p className="memory-recall-heading">Recalled for the next turn</p>
      {count ? <ul>{preview.records.map(item => <li key={item.id}>
        <span className="memory-recall-text">{item.text}</span>{item.scope && <span className="memory-recall-scope">{item.scope}</span>}
        <button type="button" className="icon-button" aria-label={`Leave out: ${item.text.slice(0, 60)}`} title="Leave out of this chat’s recall" onClick={() => toggle(item, true)}><X size={12} /></button>
      </li>)}</ul> : <p className="memory-recall-note">No notes match this draft.</p>}
      {preview.excluded.length > 0 && <><p className="memory-recall-heading">Left out in this chat</p><ul className="is-excluded">{preview.excluded.map(item => <li key={item.id}>
        <span className="memory-recall-text">{item.text || 'Removed note'}</span>
        <button type="button" className="icon-button" aria-label={`Restore: ${(item.text || 'removed note').slice(0, 60)}`} title="Recall it again" onClick={() => toggle(item, false)}><RotateCcw size={12} /></button>
      </li>)}</ul></>}
      {preview.engine && <p className="memory-recall-note">The memory engine adds its own matches when you send.</p>}
    </div>}
  </span>;
}
