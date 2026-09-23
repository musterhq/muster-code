import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import { dropSlot, edgeScrollStep, reorderedIds } from '../chatNavigation';

export type ReorderKind = 'pin' | 'folder';
/** The drag in flight. Module-level because dataTransfer contents are opaque until drop, and the sidebar-wide
 *  autoscroll/rejection handler needs to know a reorder drag is running. */
let current: { kind: ReorderKind; id: string } | null = null;
type MarkedEvent = DragEvent & { musterReorder?: ReorderKind };

const REJECTED: Record<ReorderKind, string> = {
  pin: 'Pinned chats reorder only within Pinned. Drop between pinned chats.',
  folder: 'Folders reorder only among folders. Drop between folder names.',
};

export interface ItemDragProps { draggable: true; 'data-drop'?: 'before' | 'after'; 'data-dragging'?: 'true'; 'aria-roledescription': string }

/** UX-12/UX-23/NAV-05: HTML drag reorder for one list (pins or folders). A custom "Move <name>" badge is the drag preview;
 *  a 2px insertion marker sits on the row edge; Escape (native cancel) or a drop anywhere else changes nothing; a drop that
 *  would not change the order sends nothing. `commit` receives the full new order. */
export function useDragReorder({ kind, ids, attr, label, commit }: { kind: ReorderKind; ids: readonly string[]; attr: string; label(id: string): string; commit(next: string[]): void }) {
  const [drag, setDrag] = useState<{ id: string; slot: number | null } | null>(null);
  const latest = useRef(drag); latest.current = drag;
  const list = useRef(ids); list.current = ids;
  useEffect(() => () => { if (current?.kind === kind) current = null; }, [kind]);
  const itemFrom = (target: EventTarget | null): HTMLElement | null => (target instanceof Element ? target.closest<HTMLElement>(`[${attr}]`) : null);
  const end = () => { if (current?.kind === kind) current = null; setDrag(null); };
  const containerProps = {
    onDragStart(event: React.DragEvent<HTMLElement>) {
      const element = itemFrom(event.target), id = element?.getAttribute(attr);
      if (!element || !id || !list.current.includes(id) || list.current.length < 2) return;
      event.stopPropagation();
      current = { kind, id };
      event.dataTransfer.effectAllowed = 'move';
      event.dataTransfer.setData('text/plain', label(id));
      const badge = document.createElement('div');
      badge.className = 'nav-drag-badge';
      const verb = document.createElement('b'); verb.textContent = 'Move';
      badge.append(verb, document.createTextNode(label(id)));
      document.body.append(badge);
      event.dataTransfer.setDragImage?.(badge, 14, 14);
      setTimeout(() => badge.remove(), 0);
      setDrag({ id, slot: null });
    },
    onDragOver(event: React.DragEvent<HTMLElement>) {
      if (current?.kind !== kind) return;
      const element = itemFrom(event.target), id = element?.getAttribute(attr), index = id ? list.current.indexOf(id) : -1;
      if (!element || index < 0) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      (event.nativeEvent as MarkedEvent).musterReorder = kind;
      const slot = dropSlot(index, event.clientY, element.getBoundingClientRect());
      if (latest.current && latest.current.slot !== slot) setDrag({ ...latest.current, slot });
    },
    onDrop(event: React.DragEvent<HTMLElement>) {
      if (current?.kind !== kind) return;
      event.preventDefault(); event.stopPropagation();
      const state = latest.current;
      const next = state && state.slot !== null ? reorderedIds(list.current, state.id, state.slot) : null;
      end();
      if (next) commit(next);
    },
    onDragEnd() { end(); },
  };
  /** Marker placement: before the row at the slot, or after the last row; hidden when the drop would be a no-op. */
  const itemProps = (id: string): ItemDragProps => {
    const props: ItemDragProps = { draggable: true, 'aria-roledescription': kind === 'pin' ? 'Draggable pinned chat' : 'Draggable folder' };
    if (!drag) return props;
    if (drag.id === id) props['data-dragging'] = 'true';
    if (drag.slot === null || !reorderedIds(list.current, drag.id, drag.slot)) return props;
    const index = list.current.indexOf(id);
    if (index === drag.slot) props['data-drop'] = 'before';
    else if (drag.slot === list.current.length && index === list.current.length - 1) props['data-drop'] = 'after';
    return props;
  };
  return { containerProps, itemProps, dragging: drag?.id ?? null };
}

/** Sidebar-wide drag feedback: bounded edge autoscroll while a reorder drag is over the list, and the reason a target
 *  is rejected (dropping there does nothing; the drag image shows "not allowed"). */
export function useReorderAutoscroll(scroller: React.RefObject<HTMLElement | null>) {
  const [rejected, setRejected] = useState('');
  const step = useRef(0), frame = useRef(0);
  const stop = () => { step.current = 0; cancelAnimationFrame(frame.current); frame.current = 0; };
  const tick = () => {
    const element = scroller.current;
    if (!current || !element || !step.current) { frame.current = 0; return; }
    element.scrollTop += step.current;
    frame.current = requestAnimationFrame(tick);
  };
  useEffect(() => {
    const clear = () => { stop(); setRejected(''); };
    document.addEventListener('dragend', clear, true);
    document.addEventListener('drop', clear, true);
    return () => { document.removeEventListener('dragend', clear, true); document.removeEventListener('drop', clear, true); stop(); };
  }, []);
  return {
    rejected,
    onDragOver(event: React.DragEvent<HTMLElement>) {
      if (!current || !scroller.current) return;
      step.current = edgeScrollStep(event.clientY, scroller.current.getBoundingClientRect());
      if (step.current && !frame.current) frame.current = requestAnimationFrame(tick);
      const accepted = (event.nativeEvent as MarkedEvent).musterReorder === current.kind;
      const reason = accepted ? '' : REJECTED[current.kind];
      setRejected(previous => previous === reason ? previous : reason);
    },
    onDragLeave(event: React.DragEvent<HTMLElement>) {
      if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
      step.current = 0;
    },
  };
}
