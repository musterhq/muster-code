import React, { useEffect, useId, useRef } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE = 'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),select:not(:disabled),[href],[tabindex]:not([tabindex="-1"])';

/** A small modal for composer tools: portal, backdrop, Esc/outside click to close, Tab kept inside, focus restored. */
export function ModalSheet({ open, title, description, className, testId, onClose, initialFocus, children }: { open: boolean; title: string; description?: string; className: string; testId?: string; onClose(): void; initialFocus?: React.RefObject<HTMLElement | null>; children: React.ReactNode }): React.ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId(), descriptionId = useId();
  const close = useRef(onClose); close.current = onClose;
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => (initialFocus?.current ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE) ?? panel.current)?.focus());
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close.current(); return; }
      if (event.key !== 'Tab' || !panel.current) return;
      const items = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey, true);
    return () => { cancelAnimationFrame(frame); document.removeEventListener('keydown', onKey, true); previous?.focus?.(); };
  }, [open]);
  if (!open) return null;
  return createPortal(<>
    <div className="composer-access-backdrop" aria-hidden="true" onMouseDown={() => close.current()} />
    <div ref={panel} className={className} data-testid={testId} role="dialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={description ? descriptionId : undefined} tabIndex={-1}>
      <h2 id={titleId}>{title}</h2>
      {description && <p id={descriptionId}>{description}</p>}
      {children}
    </div>
  </>, document.body);
}
