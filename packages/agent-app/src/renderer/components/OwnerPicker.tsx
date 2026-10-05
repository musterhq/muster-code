/**
 * The owner / assignee picker of a server task (#117), used by New task "Owner", the properties "Assignee" and the composer "Assign to": type to filter,
 * grouped No owner → Me → People → Agents, names shown once. Choosing a person assigns them (the agent is cleared); an agent assigns it (the person is cleared).
 */
import { ChevronDown } from 'lucide-react';
import { createPortal } from 'react-dom';
import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { filterOwners, OWNER_GROUP_LABEL, type OwnerGroup, type OwnerOption } from '../ownerOptions';
import './owner-picker.css';

export function OwnerPicker({ options, value, label, disabled, bare, onChange }: { options: readonly OwnerOption[]; value: string; label: string; disabled?: boolean; bare?: boolean; onChange: (value: string) => void }): React.ReactElement {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), pop = useRef<HTMLDivElement>(null);
  const listId = useId();
  // The list is fixed to the viewport, placed under the button and kept inside the window, so a narrow or scrolling side panel never clips it.
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  useLayoutEffect(() => {
    if (!open || !root.current) { setPos(null); return; }
    const r = root.current.getBoundingClientRect(), width = 280, vw = globalThis.innerWidth || 1200, vh = globalThis.innerHeight || 800;
    setPos({ top: Math.min(r.bottom + 4, Math.max(8, vh - 340)), left: Math.max(8, Math.min(r.left, vw - width - 8)) });
  }, [open]);
  const shown = useMemo(() => filterOwners(options, query), [options, query]);
  const current = options.find(o => o.value === value);
  useEffect(() => { if (open) { setQuery(''); setActive(0); requestAnimationFrame(() => input.current?.focus()); } }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => { const t = e.target as Node; if (!root.current?.contains(t) && !pop.current?.contains(t)) setOpen(false); };
    // Escape closes from anywhere (focus may have left the filter after a Tab, since the list is portalled) and hands focus back to the button.
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLElement>('.owner-trigger')?.focus(); } };
    document.addEventListener('mousedown', away); document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc); };
  }, [open]);
  const choose = (o: OwnerOption | undefined) => { if (!o) return; setOpen(false); if (o.value !== value) onChange(o.value); };
  let lastGroup: OwnerGroup | null = null;
  return <div ref={root} className={`owner-picker${bare ? ' is-bare' : ''}`}>
    <button type="button" className={bare ? 'ws-select is-bare owner-trigger' : 'ws-select is-field owner-trigger'} role="combobox" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId} aria-label={label} disabled={disabled} onClick={() => setOpen(v => !v)}>
      <span className="owner-current">{current?.label ?? 'Unassigned'}</span><ChevronDown size={12} aria-hidden="true"/>
    </button>
    {open && createPortal(<div ref={pop} className="owner-pop ui-menu" style={pos ? { position: 'fixed', top: pos.top, left: pos.left } : undefined}>
      <input ref={input} className="owner-filter" type="text" role="searchbox" aria-label={`Filter ${label}`} placeholder="Type to filter…" value={query} onChange={e => { setQuery(e.target.value); setActive(0); }}
        onKeyDown={e => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setActive(i => Math.min(shown.length - 1, i + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(0, i - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); choose(shown[active]); }
          else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); }
        }}/>
      <ul id={listId} role="listbox" aria-label={label} className="owner-list">
        {shown.length === 0 && <li className="owner-empty">No match</li>}
        {shown.map((o, i) => { const head = o.group !== lastGroup && o.group !== 'none' && o.group !== 'me' ? OWNER_GROUP_LABEL[o.group] : null; lastGroup = o.group;
          return <React.Fragment key={o.value || 'none'}>{head && <li role="presentation" className="owner-group">{head}</li>}
            <li role="option" aria-selected={o.value === value} data-active={i === active || undefined} className="owner-option" onMouseEnter={() => setActive(i)} onMouseDown={e => { e.preventDefault(); choose(o); }}>
              <span>{o.label}</span>{o.hint && <small>{o.hint}</small>}</li></React.Fragment>; })}
      </ul>
    </div>, document.body)}
  </div>;
}
